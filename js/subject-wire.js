// Subject Wire — local visual heuristic for restrained conceptual line art.
// It intentionally uses saliency and image flow as guides, not as literal edge geometry.
var SubjectWire = (function () {
    'use strict';

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function hashNoise(seed, index) {
        var x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
        return (x - Math.floor(x)) * 2 - 1;
    }

    function percentile(values, q) {
        if (!values.length) return 0;
        var sorted = Array.prototype.slice.call(values).sort(function (a, b) { return a - b; });
        var index = clamp(Math.round((sorted.length - 1) * q), 0, sorted.length - 1);
        return sorted[index];
    }

    function normalize(values, hi) {
        var out = new Float32Array(values.length);
        hi = hi || percentile(values, 0.92) || 1;
        for (var i = 0; i < values.length; i++) out[i] = clamp(values[i] / hi, 0, 1);
        return out;
    }

    function boxBlur(src, width, height, radius) {
        if (radius <= 0) return new Float32Array(src);
        var tmp = new Float32Array(src.length);
        var out = new Float32Array(src.length);
        var x, y, i, t, sum, count, sx, sy;

        for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
                sum = 0; count = 0;
                for (t = -radius; t <= radius; t++) {
                    sx = clamp(x + t, 0, width - 1);
                    sum += src[y * width + sx];
                    count++;
                }
                tmp[y * width + x] = sum / count;
            }
        }
        for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
                sum = 0; count = 0;
                for (t = -radius; t <= radius; t++) {
                    sy = clamp(y + t, 0, height - 1);
                    sum += tmp[sy * width + x];
                    count++;
                }
                out[y * width + x] = sum / count;
            }
        }
        return out;
    }

    function resizeField(source, width, height, outWidth, outHeight) {
        var out = new Float32Array(outWidth * outHeight);
        for (var y = 0; y < outHeight; y++) {
            var sy = Math.min(height - 1, Math.floor((y + 0.5) * height / outHeight));
            for (var x = 0; x < outWidth; x++) {
                var sx = Math.min(width - 1, Math.floor((x + 0.5) * width / outWidth));
                out[y * outWidth + x] = source[sy * width + sx] || 0;
            }
        }
        return out;
    }

    function gradient(gray, width, height) {
        var gx = new Float32Array(gray.length);
        var gy = new Float32Array(gray.length);
        for (var y = 0; y < height; y++) {
            for (var x = 0; x < width; x++) {
                var i = y * width + x;
                var xm = Math.max(0, x - 1), xp = Math.min(width - 1, x + 1);
                var ym = Math.max(0, y - 1), yp = Math.min(height - 1, y + 1);
                gx[i] = gray[y * width + xp] - gray[y * width + xm];
                gy[i] = gray[yp * width + x] - gray[ym * width + x];
            }
        }
        return { gx: gx, gy: gy };
    }

    function morph(mask, width, height, dilate) {
        var out = new Uint8Array(mask.length);
        for (var y = 0; y < height; y++) {
            for (var x = 0; x < width; x++) {
                var found = dilate ? 0 : 1;
                for (var oy = -1; oy <= 1; oy++) {
                    for (var ox = -1; ox <= 1; ox++) {
                        var sx = x + ox, sy = y + oy;
                        var inside = sx >= 0 && sx < width && sy >= 0 && sy < height;
                        var value = inside ? mask[sy * width + sx] : 0;
                        if (dilate) found = Math.max(found, value);
                        else found = Math.min(found, value);
                    }
                }
                out[y * width + x] = found;
            }
        }
        return out;
    }

    function connectedComponents(mask, saliency, width, height) {
        var seen = new Uint8Array(mask.length);
        var components = [];
        var queue = [];
        var dirs = [-1, 0, 1];
        for (var y = 0; y < height; y++) {
            for (var x = 0; x < width; x++) {
                var start = y * width + x;
                if (!mask[start] || seen[start]) continue;
                seen[start] = 1;
                queue.length = 0;
                queue.push(start);
                var area = 0, sum = 0, sx = 0, sy = 0;
                var minX = x, maxX = x, minY = y, maxY = y;
                for (var qi = 0; qi < queue.length; qi++) {
                    var index = queue[qi];
                    var px = index % width, py = Math.floor(index / width);
                    area++; sum += saliency[index]; sx += px; sy += py;
                    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
                    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
                    for (var di = 0; di < dirs.length; di++) {
                        for (var dj = 0; dj < dirs.length; dj++) {
                            if (di === 1 && dj === 1) continue;
                            var nx = px + dirs[di], ny = py + dirs[dj];
                            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                            var ni = ny * width + nx;
                            if (mask[ni] && !seen[ni]) {
                                seen[ni] = 1;
                                queue.push(ni);
                            }
                        }
                    }
                }
                if (area >= Math.max(4, Math.round(width * height * 0.0015))) {
                    components.push({
                        area: area,
                        mean: sum / area,
                        x: sx / area,
                        y: sy / area,
                        minX: minX,
                        maxX: maxX,
                        minY: minY,
                        maxY: maxY
                    });
                }
            }
        }
        return components;
    }

    function principalAxis(points, center) {
        var xx = 0, xy = 0, yy = 0;
        for (var i = 0; i < points.length; i++) {
            var dx = points[i].x - center.x, dy = points[i].y - center.y;
            var weight = points[i].weight || 1;
            xx += dx * dx * weight;
            xy += dx * dy * weight;
            yy += dy * dy * weight;
        }
        var angle = 0.5 * Math.atan2(2 * xy, xx - yy || 1e-6);
        var axis = { x: Math.cos(angle), y: Math.sin(angle) };
        if (axis.y > 0) { axis.x *= -1; axis.y *= -1; }
        return axis;
    }

    function nearestLandmark(point, landmarks) {
        var best = landmarks[0], bestD = Infinity;
        for (var i = 0; i < landmarks.length; i++) {
            var dx = landmarks[i].x - point.x, dy = landmarks[i].y - point.y;
            var d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = landmarks[i]; }
        }
        return { landmark: best, distance: Math.sqrt(bestD) };
    }

    function sample(field, width, height, x, y) {
        x = clamp(x, 0, width - 1); y = clamp(y, 0, height - 1);
        return field[Math.floor(y) * width + Math.floor(x)] || 0;
    }

    function extendToFrame(points, width, height, pathSeed) {
        if (!points.length) return points;
        var last = points[points.length - 1];
        if (last.x <= 2 || last.y <= 2 || last.x >= width - 3 || last.y >= height - 3) return points;
        var distances = [
            { x: 1, y: clamp(last.y, 1, height - 2), d: last.x - 1 },
            { x: width - 2, y: clamp(last.y, 1, height - 2), d: width - 2 - last.x },
            { x: clamp(last.x, 1, width - 2), y: 1, d: last.y - 1 },
            { x: clamp(last.x, 1, width - 2), y: height - 2, d: height - 2 - last.y }
        ];
        distances.sort(function (a, b) { return a.d - b.d; });
        var target = distances[0];
        var dx = target.x - last.x, dy = target.y - last.y;
        var length = Math.sqrt(dx * dx + dy * dy) || 1;
        var nx = -dy / length, ny = dx / length;
        var steps = Math.max(5, Math.min(14, Math.round(length / 8)));
        for (var i = 1; i <= steps; i++) {
            var t = i / steps;
            var bend = Math.sin(t * Math.PI) * hashNoise(pathSeed + 19, i) * 0.9;
            points.push({
                x: last.x + dx * t + nx * bend,
                y: last.y + dy * t + ny * bend
            });
        }
        return points;
    }

    function trace(anchor, initial, fieldData, landmarks, center, opts, pathSeed) {
        var width = fieldData.width, height = fieldData.height;
        var maxSteps = Math.max(width, height) * 2.4;
        var step = Math.max(0.8, Math.min(1.8, Math.min(width, height) / 160));
        var points = [{ x: anchor.x, y: anchor.y }];
        var x = anchor.x, y = anchor.y;
        var heading = { x: initial.x, y: initial.y };

        for (var s = 0; s < maxSteps; s++) {
            if (x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2) break;
            var i = Math.floor(y) * width + Math.floor(x);
            var gx = sample(fieldData.gx, width, height, x, y);
            var gy = sample(fieldData.gy, width, height, x, y);
            var gm = Math.sqrt(gx * gx + gy * gy) || 1;
            var tx = -gy / gm, ty = gx / gm;
            if (tx * heading.x + ty * heading.y < 0) { tx = -tx; ty = -ty; }

            var near = nearestLandmark({ x: x, y: y }, landmarks);
            var dx = near.landmark.x - x, dy = near.landmark.y - y;
            var dm = Math.sqrt(dx * dx + dy * dy) || 1;
            var attraction = clamp(near.distance / (Math.min(width, height) * 0.32), 0, 1);
            var ax = dx / dm * attraction, ay = dy / dm * attraction;
            var rx = x - center.x, ry = y - center.y;
            var rm = Math.sqrt(rx * rx + ry * ry) || 1;
            var curl = (0.12 + opts.wireTension * 0.34) * (1 - clamp(rm / (Math.min(width, height) * 0.8), 0, 1));
            var cx = -ry / rm * curl, cy = rx / rm * curl;
            var axisSign = (heading.x * fieldData.axis.x + heading.y * fieldData.axis.y) < 0 ? -1 : 1;
            var axisWeight = 0.18 + opts.abstraction * 0.42;
            var inside = sample(fieldData.mask, width, height, x, y) > 0.5;

            var vx = tx * (inside ? 0.72 : 0.34) + ax * (0.65 + opts.wireTension * 1.25) + fieldData.axis.x * axisSign * axisWeight + cx;
            var vy = ty * (inside ? 0.72 : 0.34) + ay * (0.65 + opts.wireTension * 1.25) + fieldData.axis.y * axisSign * axisWeight + cy;
            vx = vx * 0.78 + heading.x * 0.22;
            vy = vy * 0.78 + heading.y * 0.22;
            var vm = Math.sqrt(vx * vx + vy * vy) || 1;
            vx /= vm; vy /= vm;

            var wobble = (0.015 + opts.handDrawn * 0.035) * hashNoise(pathSeed, s);
            var wx = vx * Math.cos(wobble) - vy * Math.sin(wobble);
            var wy = vx * Math.sin(wobble) + vy * Math.cos(wobble);
            x += wx * step; y += wy * step;
            heading.x = wx; heading.y = wy;
            points.push({ x: x, y: y });

        }
        if (points.length >= 12) extendToFrame(points, width, height, pathSeed);
        return points.length >= 12 ? points : [];
    }

    function makePath(anchor, pathIndex, fieldData, landmarks, center, opts) {
        var dx = anchor.x - center.x, dy = anchor.y - center.y;
        var dm = Math.sqrt(dx * dx + dy * dy) || 1;
        var towardEdge = { x: dx / dm, y: dy / dm };
        if (Math.abs(towardEdge.x) + Math.abs(towardEdge.y) < 0.1) {
            towardEdge = { x: pathIndex % 2 ? 1 : -1, y: pathIndex % 3 ? 0.35 : -0.35 };
        }
        var left = trace(anchor, towardEdge, fieldData, landmarks, center, opts, pathIndex * 17 + 3);
        var right = trace(anchor, { x: -towardEdge.x, y: -towardEdge.y }, fieldData, landmarks, center, opts, pathIndex * 31 + 7);
        if (!left.length && !right.length) return [];
        var combined = right.reverse().concat(left.slice(1));
        var out = [];
        for (var i = 0; i < combined.length; i++) {
            var p = combined[i];
            var n = hashNoise(pathIndex * 101 + 11, i);
            var tangent = i > 0 ? { x: p.x - combined[i - 1].x, y: p.y - combined[i - 1].y } : { x: 0, y: 1 };
            var tm = Math.sqrt(tangent.x * tangent.x + tangent.y * tangent.y) || 1;
            var wobble = opts.handDrawn * 0.55 * n;
            out.push({ x: p.x - tangent.y / tm * wobble, y: p.y + tangent.x / tm * wobble });
        }
        return out;
    }

    function dedupe(paths, width, height) {
        var kept = [];
        var cell = Math.max(3, Math.round(Math.min(width, height) * 0.018));
        var occupied = Object.create(null);
        for (var i = 0; i < paths.length; i++) {
            var path = paths[i];
            if (!path || path.length < 12) continue;
            var sampleCount = Math.min(8, path.length);
            var signature = [];
            for (var j = 0; j < sampleCount; j++) {
                var p = path[Math.floor(j * (path.length - 1) / Math.max(1, sampleCount - 1))];
                signature.push(Math.floor(p.x / cell) + ':' + Math.floor(p.y / cell));
            }
            var key = signature.join('|');
            if (occupied[key]) continue;
            occupied[key] = 1;
            kept.push(path);
        }
        return kept;
    }

    function generate(input) {
        input = input || {};
        var grayData = input.grayData;
        var width = input.width, height = input.height;
        if (!grayData || !width || !height) return { contours: [], raw: [], meta: { confidence: 0, fallback: true } };

        var opts = input.options || input;
        var shouldCancel = opts.shouldCancel || input.shouldCancel;
        opts = {
            subjectFocus: clamp(opts.subjectFocus == null ? 0.72 : opts.subjectFocus, 0, 1),
            wireDensity: clamp(opts.wireDensity == null ? 0.38 : opts.wireDensity, 0, 1),
            wireTension: clamp(opts.wireTension == null ? 0.74 : opts.wireTension, 0, 1),
            relationshipStrength: clamp(opts.relationshipStrength == null ? 0.58 : opts.relationshipStrength, 0, 1),
            abstraction: clamp(opts.abstraction == null ? 0.82 : opts.abstraction, 0, 1),
            handDrawn: clamp(opts.handDrawn == null ? 0.28 : opts.handDrawn, 0, 1)
        };
        var maxDim = 360;
        var scale = Math.min(1, maxDim / Math.max(width, height));
        var aw = Math.max(32, Math.round(width * scale));
        var ah = Math.max(32, Math.round(height * scale));
        var gray = resizeField(grayData, width, height, aw, ah);
        var gradInput = input.gradMag ? resizeField(input.gradMag, width, height, aw, ah) : null;
        var smooth = boxBlur(gray, aw, ah, Math.max(2, Math.round(Math.min(aw, ah) * 0.018)));
        var grads = gradient(gray, aw, ah);
        var rawGrad = gradInput || new Float32Array(aw * ah);
        if (!gradInput) {
            for (var gi = 0; gi < rawGrad.length; gi++) rawGrad[gi] = Math.sqrt(grads.gx[gi] * grads.gx[gi] + grads.gy[gi] * grads.gy[gi]);
        }
        var gradNorm = normalize(rawGrad);
        var contrast = new Float32Array(gray.length);
        var saliency = new Float32Array(gray.length);
        var contrastHi = percentile(contrast, 0.9) || 1;
        var centerX = (aw - 1) / 2, centerY = (ah - 1) / 2;
        var maxRadius = Math.sqrt(centerX * centerX + centerY * centerY) || 1;
        for (var i = 0; i < gray.length; i++) {
            if (shouldCancel && i % 4096 === 0) shouldCancel();
            contrast[i] = Math.abs(gray[i] - smooth[i]);
            var x = i % aw, y = Math.floor(i / aw);
            var radial = Math.sqrt((x - centerX) * (x - centerX) + (y - centerY) * (y - centerY)) / maxRadius;
            var centerPrior = 1 - clamp(radial, 0, 1);
            saliency[i] = 0.46 * gradNorm[i] + 0.34 * clamp(contrast[i] / contrastHi, 0, 1) + 0.20 * centerPrior;
        }

        var threshold = percentile(saliency, 0.78 + opts.subjectFocus * 0.13);
        var mask = new Uint8Array(saliency.length);
        for (i = 0; i < mask.length; i++) mask[i] = saliency[i] >= threshold ? 1 : 0;
        mask = morph(morph(mask, aw, ah, true), aw, ah, false);
        var components = connectedComponents(mask, saliency, aw, ah);
        components.sort(function (a, b) {
            var ac = 1 - Math.min(1, Math.sqrt((a.x - centerX) * (a.x - centerX) + (a.y - centerY) * (a.y - centerY)) / maxRadius);
            var bc = 1 - Math.min(1, Math.sqrt((b.x - centerX) * (b.x - centerX) + (b.y - centerY) * (b.y - centerY)) / maxRadius);
            return (b.area * b.mean * (0.55 + bc)) - (a.area * a.mean * (0.55 + ac));
        });
        if (!components.length) {
            threshold = percentile(saliency, 0.68);
            for (i = 0; i < mask.length; i++) mask[i] = saliency[i] >= threshold ? 1 : 0;
            components = connectedComponents(mask, saliency, aw, ah);
        }

        var chosen = components.slice(0, Math.max(1, 1 + Math.round(opts.relationshipStrength * 3)));
        var points = [], totalWeight = 0, center = { x: centerX, y: centerY };
        for (var ci = 0; ci < chosen.length; ci++) {
            var comp = chosen[ci];
            var weight = comp.area * comp.mean;
            center.x += (comp.x - center.x) * weight / Math.max(1, totalWeight + weight);
            center.y += (comp.y - center.y) * weight / Math.max(1, totalWeight + weight);
            totalWeight += weight;
            points.push({ x: comp.x, y: comp.y, weight: weight });
            points.push({ x: comp.minX, y: comp.y, weight: weight * 0.45 });
            points.push({ x: comp.maxX, y: comp.y, weight: weight * 0.45 });
            points.push({ x: comp.x, y: comp.minY, weight: weight * 0.45 });
            points.push({ x: comp.x, y: comp.maxY, weight: weight * 0.45 });
        }
        if (!points.length) points.push({ x: centerX, y: centerY, weight: 1 });
        var axis = principalAxis(points, center);
        var landmarks = points.slice(0, Math.min(points.length, 16));
        landmarks.push({ x: center.x, y: center.y, weight: 1 });

        var fieldData = {
            width: aw,
            height: ah,
            gx: grads.gx,
            gy: grads.gy,
            mask: mask,
            axis: axis
        };
        var anchors = [];
        for (ci = 0; ci < landmarks.length; ci++) {
            if (ci === landmarks.length - 1 || ci < 2 + Math.round(opts.relationshipStrength * 3)) {
                anchors.push({ x: landmarks[ci].x, y: landmarks[ci].y });
            }
        }
        var pathCount = 5 + Math.round(opts.wireDensity * 17);
        var paths = [];
        for (var pi = 0; pi < pathCount; pi++) {
            if (shouldCancel) shouldCancel();
            var base = anchors[pi % anchors.length];
            var offset = (pi - pathCount / 2) * 0.7;
            var anchor = {
                x: clamp(base.x + axis.y * offset, 2, aw - 3),
                y: clamp(base.y - axis.x * offset, 2, ah - 3)
            };
            var path = makePath(anchor, pi, fieldData, landmarks, center, opts);
            if (path.length) paths.push(path);
        }
        paths = dedupe(paths, aw, ah);

        var output = [];
        for (pi = 0; pi < paths.length; pi++) {
            var scaled = paths[pi].map(function (p) { return { x: p.x / scale, y: p.y / scale }; });
            if (typeof Engine !== 'undefined' && Engine.simplifyPath) {
                scaled = Engine.simplifyPath(scaled, 0.55 + opts.abstraction * 0.8);
                if (scaled.length > 2 && Engine.smoothPathCornerAware) {
                    scaled = Engine.smoothPathCornerAware(scaled, 2 + Math.round(opts.abstraction * 2), 0.28 + opts.abstraction * 0.25, 38);
                }
            }
            if (scaled.length > 1) output.push(scaled);
        }

        var confidence = chosen.length ? clamp((chosen[0].mean || 0) * 1.7 + Math.min(0.3, chosen[0].area / (aw * ah)), 0, 1) : 0;
        return {
            contours: output,
            raw: [],
            meta: {
                confidence: confidence,
                regions: chosen.length,
                analysisWidth: aw,
                analysisHeight: ah,
                heuristic: true,
                fallback: !components.length
            }
        };
    }

    return { generate: generate };
})();
