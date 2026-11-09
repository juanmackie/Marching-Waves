// Subject Wire — local saliency/flow heuristic producing flat Geometry.
// Output matches Engine's ABI: { offsets, xy, radius, widths, count }.
var SubjectWire = (function () {
    'use strict';

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function hashNoise(seed, index) {
        var x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
        return (x - Math.floor(x)) * 2 - 1;
    }

    function GrowF(cap) {
        this.a = new Float32Array(cap || 1024);
        this.n = 0;
    }
    GrowF.prototype.reserve = function (k) {
        if (this.n + k <= this.a.length) return;
        var cap = this.a.length;
        while (cap < this.n + k) cap *= 2;
        var b = new Float32Array(cap);
        b.set(this.a.subarray(0, this.n));
        this.a = b;
    };
    GrowF.prototype.push = function (v) {
        this.reserve(1);
        this.a[this.n++] = v;
    };
    GrowF.prototype.count = function () { return this.n / 2; };

    function GrowI(cap) {
        this.a = new Int32Array(cap || 256);
        this.n = 0;
    }
    GrowI.prototype.reserve = function (k) {
        if (this.n + k <= this.a.length) return;
        var cap = this.a.length;
        while (cap < this.n + k) cap *= 2;
        var b = new Int32Array(cap);
        b.set(this.a.subarray(0, this.n));
        this.a = b;
    };
    GrowI.prototype.push = function (v) {
        this.reserve(1);
        this.a[this.n++] = v;
    };

    function percentile(values, q) {
        if (!values.length) return 0;
        var sorted = Array.prototype.slice.call(values).sort(function (a, b) { return a - b; });
        return sorted[clamp(Math.round((sorted.length - 1) * q), 0, sorted.length - 1)];
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
        var x, y, t, sum;
        for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
                sum = 0;
                for (t = -radius; t <= radius; t++) sum += src[y * width + clamp(x + t, 0, width - 1)];
                tmp[y * width + x] = sum / (radius * 2 + 1);
            }
        }
        for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
                sum = 0;
                for (t = -radius; t <= radius; t++) sum += tmp[clamp(y + t, 0, height - 1) * width + x];
                out[y * width + x] = sum / (radius * 2 + 1);
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
            var ym = Math.max(0, y - 1) * width;
            var yr = y * width;
            var yp = Math.min(height - 1, y + 1) * width;
            for (var x = 0; x < width; x++) {
                var xm = Math.max(0, x - 1), xp = Math.min(width - 1, x + 1);
                var i = yr + x;
                gx[i] = gray[yr + xp] - gray[yr + xm];
                gy[i] = gray[yp + x] - gray[ym + x];
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
                        found = dilate ? Math.max(found, value) : Math.min(found, value);
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
        for (var y = 0; y < height; y++) {
            for (var x = 0; x < width; x++) {
                var start = y * width + x;
                if (!mask[start] || seen[start]) continue;
                seen[start] = 1;
                queue.length = 0;
                queue.push(start);
                var area = 0, sum = 0, sxTotal = 0, syTotal = 0;
                var minX = x, maxX = x, minY = y, maxY = y;
                for (var qi = 0; qi < queue.length; qi++) {
                    var index = queue[qi];
                    var px = index % width, py = (index / width) | 0;
                    area++; sum += saliency[index]; sxTotal += px; syTotal += py;
                    if (px < minX) minX = px; if (px > maxX) maxX = px;
                    if (py < minY) minY = py; if (py > maxY) maxY = py;
                    for (var oy = -1; oy <= 1; oy++) {
                        for (var ox = -1; ox <= 1; ox++) {
                            if (ox === 0 && oy === 0) continue;
                            var nx = px + ox, ny = py + oy;
                            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                            var ni = ny * width + nx;
                            if (mask[ni] && !seen[ni]) { seen[ni] = 1; queue.push(ni); }
                        }
                    }
                }
                if (area >= Math.max(4, Math.round(width * height * 0.0015))) {
                    components.push({
                        area: area, mean: sum / area,
                        x: sxTotal / area, y: syTotal / area,
                        minX: minX, maxX: maxX, minY: minY, maxY: maxY
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

    function sample(field, width, height, x, y) {
        x = clamp(x, 0, width - 1);
        y = clamp(y, 0, height - 1);
        return field[Math.floor(y) * width + Math.floor(x)] || 0;
    }

    function extendToFrame(points, width, height, pathSeed) {
        var n = points.count();
        if (!n) return;
        var lastX = points.a[points.n - 2], lastY = points.a[points.n - 1];
        if (lastX <= 2 || lastY <= 2 || lastX >= width - 3 || lastY >= height - 3) return;
        var distances = [
            { x: 1, y: clamp(lastY, 1, height - 2), d: lastX - 1 },
            { x: width - 2, y: clamp(lastY, 1, height - 2), d: width - 2 - lastX },
            { x: clamp(lastX, 1, width - 2), y: 1, d: lastY - 1 },
            { x: clamp(lastX, 1, width - 2), y: height - 2, d: height - 2 - lastY }
        ];
        distances.sort(function (a, b) { return a.d - b.d; });
        var target = distances[0];
        var dx = target.x - lastX, dy = target.y - lastY;
        var length = Math.sqrt(dx * dx + dy * dy) || 1;
        var nx = -dy / length, ny = dx / length;
        var steps = Math.max(5, Math.min(14, Math.round(length / 8)));
        for (var i = 1; i <= steps; i++) {
            var t = i / steps;
            var bend = Math.sin(t * Math.PI) * hashNoise(pathSeed + 19, i) * 0.9;
            points.push(lastX + dx * t + nx * bend);
            points.push(lastY + dy * t + ny * bend);
        }
    }

    function trace(anchorX, anchorY, initX, initY, fd, landmarks, center, opts, pathSeed) {
        var width = fd.width, height = fd.height;
        var maxSteps = Math.max(width, height) * 2.4;
        var step = Math.max(0.8, Math.min(1.8, Math.min(width, height) / 160));
        var out = new GrowF(512);
        out.push(anchorX); out.push(anchorY);
        var x = anchorX, y = anchorY;
        var headingX = initX, headingY = initY;
        var lm0 = landmarks[0];

        for (var s = 0; s < maxSteps; s++) {
            if (x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2) break;
            var gx = sample(fd.gx, width, height, x, y);
            var gy = sample(fd.gy, width, height, x, y);
            var gm = Math.sqrt(gx * gx + gy * gy) || 1;
            var tx = -gy / gm, ty = gx / gm;
            if (tx * headingX + ty * headingY < 0) { tx = -tx; ty = -ty; }

            var bestX = lm0.x, bestY = lm0.y, bestD = Infinity;
            for (var li = 0; li < landmarks.length; li++) {
                var lx = landmarks[li].x - x, ly = landmarks[li].y - y;
                var ld = lx * lx + ly * ly;
                if (ld < bestD) { bestD = ld; bestX = landmarks[li].x; bestY = landmarks[li].y; }
            }
            var nearDist = Math.sqrt(bestD);
            var dx = bestX - x, dy = bestY - y;
            var dm = Math.sqrt(dx * dx + dy * dy) || 1;
            var attraction = clamp(nearDist / (Math.min(width, height) * 0.32), 0, 1);
            var ax = dx / dm * attraction, ay = dy / dm * attraction;
            var rx = x - center.x, ry = y - center.y;
            var rm = Math.sqrt(rx * rx + ry * ry) || 1;
            var curl = (0.12 + opts.wireTension * 0.34) * (1 - clamp(rm / (Math.min(width, height) * 0.8), 0, 1));
            var cx = -ry / rm * curl, cy = rx / rm * curl;
            var axisSign = (headingX * fd.axis.x + headingY * fd.axis.y) < 0 ? -1 : 1;
            var axisWeight = 0.18 + opts.abstraction * 0.42;
            var inside = sample(fd.mask, width, height, x, y) > 0.5;

            var vx = tx * (inside ? 0.72 : 0.34) + ax * (0.65 + opts.wireTension * 1.25) + fd.axis.x * axisSign * axisWeight + cx;
            var vy = ty * (inside ? 0.72 : 0.34) + ay * (0.65 + opts.wireTension * 1.25) + fd.axis.y * axisSign * axisWeight + cy;
            vx = vx * 0.78 + headingX * 0.22;
            vy = vy * 0.78 + headingY * 0.22;
            var vm = Math.sqrt(vx * vx + vy * vy) || 1;
            vx /= vm; vy /= vm;

            var wobble = (0.015 + opts.handDrawn * 0.035) * hashNoise(pathSeed, s);
            var wx = vx * Math.cos(wobble) - vy * Math.sin(wobble);
            var wy = vx * Math.sin(wobble) + vy * Math.cos(wobble);
            x += wx * step;
            y += wy * step;
            headingX = wx;
            headingY = wy;
            out.push(x); out.push(y);
        }
        if (out.count() >= 12) extendToFrame(out, width, height, pathSeed);
        if (out.count() < 12) out.n = 0;
        return out;
    }

    function makePath(anchorX, anchorY, pathIndex, fd, landmarks, center, opts) {
        var dx = anchorX - center.x, dy = anchorY - center.y;
        var dm = Math.sqrt(dx * dx + dy * dy) || 1;
        var towardX = dx / dm, towardY = dy / dm;
        if (Math.abs(towardX) + Math.abs(towardY) < 0.1) {
            towardX = pathIndex % 2 ? 1 : -1;
            towardY = pathIndex % 3 ? 0.35 : -0.35;
        }
        var left = trace(anchorX, anchorY, towardX, towardY, fd, landmarks, center, opts, pathIndex * 17 + 3);
        var right = trace(anchorX, anchorY, -towardX, -towardY, fd, landmarks, center, opts, pathIndex * 31 + 7);
        if (left.n === 0 && right.n === 0) return null;

        var combined = new GrowF(left.n + right.n + 2);
        for (var ri = right.n - 2; ri >= 0; ri -= 2) {
            combined.push(right.a[ri]); combined.push(right.a[ri + 1]);
        }
        for (var li = 2; li < left.n; li += 2) {
            combined.push(left.a[li]); combined.push(left.a[li + 1]);
        }

        var out = new GrowF(combined.n + 2);
        var prevX = 0, prevY = 1;
        var cn = combined.count();
        for (var i = 0; i < cn; i++) {
            var px = combined.a[i * 2], py = combined.a[i * 2 + 1];
            var nz = hashNoise(pathIndex * 101 + 11, i);
            var tx = i > 0 ? px - combined.a[(i - 1) * 2] : 0;
            var ty = i > 0 ? py - combined.a[(i - 1) * 2 + 1] : 1;
            var tm = Math.sqrt(tx * tx + ty * ty) || 1;
            var wobble = opts.handDrawn * 0.55 * nz;
            out.push(px - ty / tm * wobble);
            out.push(py + tx / tm * wobble);
        }
        return out;
    }

    function dedupe(paths, width, height) {
        var kept = [];
        var cell = Math.max(3, Math.round(Math.min(width, height) * 0.018));
        var occupied = Object.create(null);
        for (var i = 0; i < paths.length; i++) {
            var path = paths[i];
            if (!path || path.count() < 12) continue;
            var sampleCount = Math.min(8, path.count());
            var signature = [];
            for (var j = 0; j < sampleCount; j++) {
                var idx = Math.floor(j * (path.count() - 1) / Math.max(1, sampleCount - 1));
                signature.push(Math.floor(path.a[idx * 2] / cell) + ':' + Math.floor(path.a[idx * 2 + 1] / cell));
            }
            var key = signature.join('|');
            if (occupied[key]) continue;
            occupied[key] = 1;
            kept.push(path);
        }
        return kept;
    }

    async function generate(input) {
        input = input || {};
        var grayData = input.gray || input.grayData;
        var width = input.width, height = input.height;
        var metaEmpty = { confidence: 0, regions: 0, analysisWidth: 0, analysisHeight: 0, heuristic: true, fallback: true };
        if (!grayData || !width || !height) {
            return { geometry: emptyGeometry(), meta: metaEmpty };
        }
        var opts = input.options || {};
        var hooks = input.hooks || {};
        var shouldStop = hooks.checkpoint || null;
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
        var smoothField = boxBlur(gray, aw, ah, Math.max(2, Math.round(Math.min(aw, ah) * 0.018)));
        var grads = gradient(gray, aw, ah);
        var rawGrad = gradInput || new Float32Array(aw * ah);
        if (!gradInput) {
            for (var gi = 0; gi < rawGrad.length; gi++) {
                rawGrad[gi] = Math.sqrt(grads.gx[gi] * grads.gx[gi] + grads.gy[gi] * grads.gy[gi]);
            }
        }
        var gradNorm = normalize(rawGrad);
        var contrast = new Float32Array(gray.length);
        var saliency = new Float32Array(gray.length);
        var cx0 = (aw - 1) / 2, cy0 = (ah - 1) / 2;
        var maxRadius = Math.sqrt(cx0 * cx0 + cy0 * cy0) || 1;
        var i;
        for (i = 0; i < gray.length; i++) {
            if (shouldStop && (i & 4095) === 0) await shouldStop();
            contrast[i] = Math.abs(gray[i] - smoothField[i]);
        }
        var contrastHi = percentile(contrast, 0.9) || 1;
        for (i = 0; i < gray.length; i++) {
            var x = i % aw, y = (i / aw) | 0;
            var radial = Math.sqrt((x - cx0) * (x - cx0) + (y - cy0) * (y - cy0)) / maxRadius;
            saliency[i] = 0.46 * gradNorm[i] + 0.34 * clamp(contrast[i] / contrastHi, 0, 1) + 0.20 * (1 - clamp(radial, 0, 1));
        }
        if (shouldStop) await shouldStop();

        var threshold = percentile(saliency, 0.78 + opts.subjectFocus * 0.13);
        var mask = new Uint8Array(saliency.length);
        for (i = 0; i < mask.length; i++) mask[i] = saliency[i] >= threshold ? 1 : 0;
        mask = morph(morph(mask, aw, ah, true), aw, ah, false);
        var components = connectedComponents(mask, saliency, aw, ah);
        components.sort(function (a, b) {
            var ac = 1 - Math.min(1, Math.sqrt((a.x - cx0) * (a.x - cx0) + (a.y - cy0) * (a.y - cy0)) / maxRadius);
            var bc = 1 - Math.min(1, Math.sqrt((b.x - cx0) * (b.x - cx0) + (b.y - cy0) * (b.y - cy0)) / maxRadius);
            return (b.area * b.mean * (0.55 + bc)) - (a.area * a.mean * (0.55 + ac));
        });
        if (!components.length) {
            threshold = percentile(saliency, 0.68);
            for (i = 0; i < mask.length; i++) mask[i] = saliency[i] >= threshold ? 1 : 0;
            components = connectedComponents(mask, saliency, aw, ah);
        }

        var chosen = components.slice(0, Math.max(1, 1 + Math.round(opts.relationshipStrength * 3)));
        var points = [], totalWeight = 0, center = { x: cx0, y: cy0 };
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
        if (!points.length) points.push({ x: cx0, y: cy0, weight: 1 });
        var axis = principalAxis(points, center);
        var landmarks = points.slice(0, Math.min(points.length, 16));
        landmarks.push({ x: center.x, y: center.y, weight: 1 });

        var fieldData = { width: aw, height: ah, gx: grads.gx, gy: grads.gy, mask: mask, axis: axis };
        var anchors = [];
        for (ci = 0; ci < landmarks.length; ci++) {
            if (ci === landmarks.length - 1 || ci < 2 + Math.round(opts.relationshipStrength * 3)) {
                anchors.push({ x: landmarks[ci].x, y: landmarks[ci].y });
            }
        }
        var pathCount = 5 + Math.round(opts.wireDensity * 17);
        var rawPaths = [];
        for (var pi = 0; pi < pathCount; pi++) {
            if (shouldStop) await shouldStop();
            var base = anchors[pi % anchors.length];
            var offset = (pi - pathCount / 2) * 0.7;
            var anchorX = clamp(base.x + axis.y * offset, 2, aw - 3);
            var anchorY = clamp(base.y - axis.x * offset, 2, ah - 3);
            var made = makePath(anchorX, anchorY, pi, fieldData, landmarks, center, opts);
            if (made && made.n) rawPaths.push(made);
        }
        var paths = dedupe(rawPaths, aw, ah);

        var offsets = new GrowI(paths.length + 1);
        offsets.push(0);
        var xy = new GrowF(4096);
        for (pi = 0; pi < paths.length; pi++) {
            var path = paths[pi];
            for (var k = 0; k < path.n; k += 2) {
                xy.push(path.a[k] / scale);
                xy.push(path.a[k + 1] / scale);
            }
            offsets.push(xy.n / 2);
        }
        var geom = {
            offsets: offsets.a.slice(0, offsets.n),
            xy: xy.a.slice(0, xy.n),
            radius: new Float32Array(xy.n / 2),
            widths: new Float32Array(paths.length),
            count: paths.length
        };
        var epsilon = 0.55 + opts.abstraction * 0.8;
        geom = Engine.dropShortPaths(Engine.simplify(geom, epsilon), 2);
        if (geom.count) {
            geom = Engine.smooth(geom, 2 + Math.round(opts.abstraction * 2), 0.28 + opts.abstraction * 0.25, 38);
        }

        var confidence = chosen.length ? clamp((chosen[0].mean || 0) * 1.7 + Math.min(0.3, chosen[0].area / (aw * ah)), 0, 1) : 0;
        return {
            geometry: geom,
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

    function emptyGeometry() {
        return {
            offsets: new Int32Array(1),
            xy: new Float32Array(0),
            radius: new Float32Array(0),
            widths: new Float32Array(0),
            count: 0
        };
    }

    return { generate: generate };
})();
