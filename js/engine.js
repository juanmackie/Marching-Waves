// Marching Waves Engine — shared by main thread and worker
var Engine = (function () {
    'use strict';

    // ─── Marching Squares (correct 16-case table) ───
    function marchSquaresField(solution, width, height, levels) {
        var raw = [];
        var interp = function (v1, v2, level) {
            if (!isFinite(v1) || !isFinite(v2)) return 0.5;
            var diff = v2 - v1;
            if (Math.abs(diff) < 1e-8) return 0.5;
            return Math.max(0, Math.min(1, (level - v1) / diff));
        };
        for (var li = 0; li < levels.length; li++) {
            var level = levels[li], lines = [], w = width, h = height, sol = solution;
            for (var y = 0; y < h - 1; y++) {
                var row = y * w;
                for (var x = 0; x < w - 1; x++) {
                    var idx = row + x;
                    var v00 = sol[idx], v10 = sol[idx + 1], v01 = sol[idx + w], v11 = sol[idx + w + 1];
                    var code = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v01 >= level ? 4 : 0) | (v11 >= level ? 8 : 0);
                    if (code === 0 || code === 15) continue;

                    var tT = interp(v00, v10, level);
                    var tB = interp(v01, v11, level);
                    var tL = interp(v00, v01, level);
                    var tR = interp(v10, v11, level);

                    // Edge coordinates inlined (no edges array / push closure):
                    // 0 top:    (x + tT, y)        1 right: (x + 1, y + tR)
                    // 2 bottom: (x + tB, y + 1)    3 left:  (x, y + tL)

                    var avg = (v00 + v10 + v01 + v11) / 4;
                    switch (code) {
                        case 1:  lines.push({ x1: x + tT, y1: y, x2: x, y2: y + tL }); break;
                        case 2:  lines.push({ x1: x + tT, y1: y, x2: x + 1, y2: y + tR }); break;
                        case 3:  lines.push({ x1: x + 1, y1: y + tR, x2: x, y2: y + tL }); break;
                        case 4:  lines.push({ x1: x + tB, y1: y + 1, x2: x, y2: y + tL }); break;
                        case 5:  lines.push({ x1: x + tT, y1: y, x2: x + tB, y2: y + 1 }); break;
                        case 6:  avg >= level ? (lines.push({ x1: x + tT, y1: y, x2: x, y2: y + tL }), lines.push({ x1: x + tB, y1: y + 1, x2: x + 1, y2: y + tR }))
                                              : (lines.push({ x1: x + tT, y1: y, x2: x + 1, y2: y + tR }), lines.push({ x1: x + tB, y1: y + 1, x2: x, y2: y + tL })); break;
                        case 7:  lines.push({ x1: x + 1, y1: y + tR, x2: x + tB, y2: y + 1 }); break;
                        case 8:  lines.push({ x1: x + tB, y1: y + 1, x2: x + 1, y2: y + tR }); break;
                        case 9:  avg >= level ? (lines.push({ x1: x + tT, y1: y, x2: x + 1, y2: y + tR }), lines.push({ x1: x + tB, y1: y + 1, x2: x, y2: y + tL }))
                                              : (lines.push({ x1: x + tT, y1: y, x2: x, y2: y + tL }), lines.push({ x1: x + tB, y1: y + 1, x2: x + 1, y2: y + tR })); break;
                        case 10: lines.push({ x1: x + tT, y1: y, x2: x + tB, y2: y + 1 }); break;
                        case 11: lines.push({ x1: x + tB, y1: y + 1, x2: x, y2: y + tL }); break;
                        case 12: lines.push({ x1: x + 1, y1: y + tR, x2: x, y2: y + tL }); break;
                        case 13: lines.push({ x1: x + tT, y1: y, x2: x + 1, y2: y + tR }); break;
                        case 14: lines.push({ x1: x + tT, y1: y, x2: x, y2: y + tL }); break;
                    }
                }
            }
            if (lines.length > 0) raw.push({ level: level, lines: lines });
        }
        return raw;
    }

    // ─── Segment joining via quantized hash chaining (O(n)) ───
    function joinSegments(rawContours) {
        var all = [];
        // flatten all segments (by reference — segments are read-only here)
        for (var ci = 0; ci < rawContours.length; ci++) {
            var lines = rawContours[ci].lines;
            for (var si = 0; si < lines.length; si++) {
                all.push(lines[si]);
            }
        }
        if (all.length === 0) return [];

        var hash = function (x, y) {
            return (Math.round(x * 1000) * 73856093 + Math.round(y * 1000) * 19349663) >>> 0;
        };

        // end-point adjacency map: keyed by hash → { segIdx, endpoint: 's'|'e' }
        var map = Object.create(null);
        for (var i = 0; i < all.length; i++) {
            var seg = all[i];
            var h1 = hash(seg.x1, seg.y1), h2 = hash(seg.x2, seg.y2);
            (map[h1] = map[h1] || []).push({ idx: i, end: 0 });
            (map[h2] = map[h2] || []).push({ idx: i, end: 1 });
        }

        var used = new Uint8Array(all.length);
        var paths = [];
        var tolerance = 2.1; // tolerance for endpoint distance matching

        var distSq = function (x1, y1, x2, y2) {
            var dx = x1 - x2, dy = y1 - y2;
            return dx * dx + dy * dy;
        };

        // find the best matching segment endpoint at (x, y) not yet used
        var findMatch = function (x, y) {
            var h = hash(x, y);
            var candidates = map[h];
            if (!candidates) return null;
            var best = null, bestD = Infinity;
            for (var c = 0; c < candidates.length; c++) {
                var cand = candidates[c];
                if (used[cand.idx]) continue;
                var s = all[cand.idx];
                var px = cand.end === 0 ? s.x1 : s.x2;
                var py = cand.end === 0 ? s.y1 : s.y2;
                var d = distSq(px, py, x, y);
                if (d < bestD) { bestD = d; best = cand; }
            }
            if (bestD <= tolerance * tolerance) return best;
            return null;
        };

        for (var i = 0; i < all.length; i++) {
            if (used[i]) continue;

            var seg = all[i];
            var path = [{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }];
            used[i] = 1;

            // chain forward from end
            var cx = seg.x2, cy = seg.y2;
            while (true) {
                var match = findMatch(cx, cy);
                if (!match) break;
                var ms = all[match.idx];
                if (match.end === 0) { path.push({ x: ms.x2, y: ms.y2 }); cx = ms.x2; cy = ms.y2; }
                else { path.push({ x: ms.x1, y: ms.y1 }); cx = ms.x1; cy = ms.y1; }
                used[match.idx] = 1;
            }

            // chain backward from start (collect with push, reverse once —
            // same order as repeated unshift without the O(n^2))
            cx = seg.x1; cy = seg.y1;
            var pre = [];
            while (true) {
                var matchB = findMatch(cx, cy);
                if (!matchB) break;
                var msB = all[matchB.idx];
                if (matchB.end === 0) { pre.push({ x: msB.x2, y: msB.y2 }); cx = msB.x2; cy = msB.y2; }
                else { pre.push({ x: msB.x1, y: msB.y1 }); cx = msB.x1; cy = msB.y1; }
                used[matchB.idx] = 1;
            }
            if (pre.length > 0) {
                pre.reverse();
                path = pre.concat(path);
            }

            if (path.length > 1) paths.push(path);
        }
        return paths;
    }

    // ─── RDP simplification ───
    function simplifyPath(points, epsilon) {
        if (!points || points.length <= 2) return points || [];
        var valid = points.filter(function (p) { return p && p.x !== undefined && p.y !== undefined; });
        if (valid.length <= 2) return valid;
        var dmax = 0, index = 0, end = valid.length - 1;
        for (var i = 1; i < end; i++) {
            var d = perpDist(valid[i], valid[0], valid[end]);
            if (d > dmax) { index = i; dmax = d; }
        }
        if (dmax > epsilon) {
            var r1 = simplifyPath(valid.slice(0, index + 1), epsilon);
            var r2 = simplifyPath(valid.slice(index, end + 1), epsilon);
            return r1.slice(0, r1.length - 1).concat(r2);
        }
        return [valid[0], valid[end]];
    }

    function perpDist(point, lineStart, lineEnd) {
        var dx = lineEnd.x - lineStart.x, dy = lineEnd.y - lineStart.y;
        var mag = Math.sqrt(dx * dx + dy * dy);
        if (mag === 0) {
            // Degenerate chord (closed loop where start == end): measure from start
            var dvx = point.x - lineStart.x, dvy = point.y - lineStart.y;
            return Math.sqrt(dvx * dvx + dvy * dvy);
        }
        dx /= mag; dy /= mag;
        var pvx = point.x - lineStart.x, pvy = point.y - lineStart.y;
        var pvdot = pvx * dx + pvy * dy;
        var ax = pvx - pvdot * dx, ay = pvy - pvdot * dy;
        return Math.sqrt(ax * ax + ay * ay);
    }

    // ─── Catmull‑Rom spline ───
    function splineSmooth(points, segments, tension) {
        if (!points || points.length < 2) return points || [];
        var valid = points.filter(function (p) { return p && p.x !== undefined && p.y !== undefined; });
        if (valid.length < 2) return valid;
        segments = segments || 4; tension = tension || 0.5;
        var out = [];
        var p = [valid[0]].concat(valid, [valid[valid.length - 1]]);
        var cr = function (p0, p1, p2, p3, t) {
            var t2 = t * t, t3 = t2 * t;
            var v0 = (p2.x - p0.x) * tension, v1 = (p3.x - p1.x) * tension;
            var x = (2 * p1.x - 2 * p2.x + v0 + v1) * t3 + (-3 * p1.x + 3 * p2.x - 2 * v0 - v1) * t2 + v0 * t + p1.x;
            var u0 = (p2.y - p0.y) * tension, u1 = (p3.y - p1.y) * tension;
            var y = (2 * p1.y - 2 * p2.y + u0 + u1) * t3 + (-3 * p1.y + 3 * p2.y - 2 * u0 - u1) * t2 + u0 * t + p1.y;
            return { x: x, y: y };
        };
        for (var i = 0; i < p.length - 3; i++) {
            for (var t = 0; t < segments; t++) {
                var s = t / segments;
                if (i === p.length - 4 && t === segments - 1) { out.push(cr(p[i], p[i + 1], p[i + 2], p[i + 3], 1)); }
                else { out.push(cr(p[i], p[i + 1], p[i + 2], p[i + 3], s)); }
            }
        }
        if (out.length > 0) {
            var last = out[out.length - 1], lp = valid[valid.length - 1];
            if (last.x !== lp.x || last.y !== lp.y) out.push(lp);
        } else out = valid;
        return out;
    }

    // ─── Helpers ───
    function pointDistance(p1, p2) {
        if (!p1 || !p2) return Infinity;
        var dx = p1.x - p2.x, dy = p1.y - p2.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function getPathLength(path) {
        if (!path || path.length < 2) return 0;
        var len = 0;
        for (var i = 0; i < path.length - 1; i++) len += pointDistance(path[i], path[i + 1]);
        return len;
    }

    function toGrayscale(imageData) {
        var data = imageData.data;
        var gray = new Float32Array(imageData.width * imageData.height);
        for (var i = 0; i < gray.length; i++) {
            var off = i * 4;
            gray[i] = (0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2]) / 255;
        }
        return gray;
    }

    // ─── Eikonal FMM solver ───
    function solveEikonalFMM(grayData, width, height, threshold) {
        var size = width * height;
        var solution = new Float32Array(size);
        solution.fill(Infinity);
        var visited = new Uint8Array(size);

        // Flat binary min-heap: parallel value/index arrays instead of {x,y,value}
        // objects (no per-entry allocation, cache-friendly sift). Pre-sized to the
        // worst case (every pixel queued once) so no growth copies occur.
        var cap = size + 1, hn = 0;
        var hv = new Float64Array(cap);
        var hi = new Int32Array(cap);
        function hpush(v, ix) {
            if (hn === cap) {
                var ncap = cap << 1;
                var nv = new Float64Array(ncap); nv.set(hv); hv = nv;
                var ni = new Int32Array(ncap); ni.set(hi); hi = ni;
                cap = ncap;
            }
            var j = hn++;
            hv[j] = v; hi[j] = ix;
            while (j > 0) {
                var pp = (j - 1) >> 1;
                if (hv[pp] <= hv[j]) break;
                var tv = hv[pp]; hv[pp] = hv[j]; hv[j] = tv;
                var ti = hi[pp]; hi[pp] = hi[j]; hi[j] = ti;
                j = pp;
            }
        }
        function hpop() {
            var top = hi[0];
            hn--;
            if (hn > 0) {
                hv[0] = hv[hn]; hi[0] = hi[hn];
                var j = 0, l, r, s;
                while (true) {
                    l = (j << 1) + 1; r = l + 1; s = j;
                    if (l < hn && hv[l] < hv[s]) s = l;
                    if (r < hn && hv[r] < hv[s]) s = r;
                    if (s === j) break;
                    var tv2 = hv[j]; hv[j] = hv[s]; hv[s] = tv2;
                    var ti2 = hi[j]; hi[j] = hi[s]; hi[s] = ti2;
                    j = s;
                }
            }
            return top;
        }

        var w = width, h = height;
        // init — all sources have value 0, so the heap invariant (parent <= child)
        // holds without any sifting; fill slots directly.
        for (var y0 = 0; y0 < h; y0++) {
            var row0 = y0 * w;
            for (var x0 = 0; x0 < w; x0++) {
                var i0 = row0 + x0;
                if (grayData[i0] < threshold) {
                    solution[i0] = 0; visited[i0] = 1;
                    hv[hn] = 0; hi[hn] = i0; hn++;
                }
            }
        }

        while (hn > 0) {
            var cIdx = hpop();
            var cx = cIdx % w, cy = (cIdx - cx) / w;
            visited[cIdx] = 1;

            // Upwind stencil around the popped cell — recomputed per neighbor
            // (same as original) since an earlier neighbor update in this same
            // pop can change what later stencil reads see.
            for (var d = 0; d < 4; d++) {
                var nx = cx + (d === 0 ? -1 : d === 1 ? 1 : 0);
                var ny = cy + (d === 2 ? -1 : d === 3 ? 1 : 0);
                if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                var nIdx = ny * w + nx;
                if (visited[nIdx]) continue;

                var ux  = (cx > 0)     ? solution[cIdx - 1] : Infinity;
                var ux2 = (cx < w - 1) ? solution[cIdx + 1] : Infinity;
                var uy  = (cy > 0)     ? solution[cIdx - w] : Infinity;
                var uy2 = (cy < h - 1) ? solution[cIdx + w] : Infinity;
                var minX = ux < ux2 ? ux : ux2;
                var minY = uy < uy2 ? uy : uy2;

                var fVal = grayData[nIdx];
                var newValue;

                if (minX === Infinity && minY === Infinity) continue;
                if (minX === Infinity) newValue = minY + fVal;
                else if (minY === Infinity) newValue = minX + fVal;
                else {
                    var m = minX < minY ? minX : minY, o = minX < minY ? minY : minX;
                    if (o - m >= fVal) newValue = m + fVal;
                    else { var disc = 2 * fVal * fVal - (o - m) * (o - m); newValue = disc < 0 ? m + fVal : (m + o + Math.sqrt(disc)) / 2; }
                }
                if (newValue < solution[nIdx]) {
                    solution[nIdx] = newValue;
                    hpush(newValue, nIdx);
                }
            }
        }
        return solution;
    }

    // ─── Direct Luminance Contours (no Eikonal) ───
    function marchSquaresDirect(grayData, width, height, levels) {
        return marchSquaresField(grayData, width, height, levels);
    }

    function generateLuminanceLevels(grayData, width, height, interval, threshold, gradMag) {
        // Levels are placed so contour lines are roughly evenly spaced in SPACE:
        // per value-bin weight = 1 / mean(|gradient|) of that bin. This keeps lines
        // from bunching where the tonal range compresses (e.g. radial gradients) and
        // prevents empty bands. Without a gradient, falls back to linear spacing over
        // a robust (2nd–98th percentile) range.
        var BINS = 256;
        var hist = new Float64Array(BINS);
        var gradSum = new Float64Array(BINS);
        var gradCount = new Uint32Array(BINS);
        var i, v, bin;
        for (i = 0; i < grayData.length; i++) {
            v = grayData[i];
            if (v >= threshold) continue;
            bin = Math.max(0, Math.min(BINS - 1, Math.round(v * 255)));
            hist[bin]++;
            if (gradMag) {
                gradSum[bin] += gradMag[i];
                gradCount[bin]++;
            }
        }
        var minBin = -1, maxBin = -1;
        for (bin = 0; bin < BINS; bin++) {
            if (hist[bin] > 0) {
                if (minBin < 0) minBin = bin;
                maxBin = bin;
            }
        }
        if (minBin < 0) return [threshold / 2];

        var weight = new Float64Array(BINS);
        var useGrad = !!gradMag;
        var MIN_PIXELS = 3; // bins with fewer pixels have no meaningful level set
        for (bin = minBin; bin <= maxBin; bin++) {
            if (hist[bin] < MIN_PIXELS) continue;
            if (useGrad && gradCount[bin] > 0) {
                var meanGrad = gradSum[bin] / gradCount[bin];
                // level density ∝ 1/mean-gradient → even spatial line spacing; capped
                // so near-flat bins can't saturate the cumulative distribution
                weight[bin] = Math.min(50, 1 / Math.max(meanGrad, 0.02));
            } else {
                weight[bin] = 1;
            }
        }

        // Light smoothing of the weight curve (meanGrad per bin is noisy)
        var smoothed = new Float64Array(BINS);
        var totalW = 0;
        for (bin = minBin; bin <= maxBin; bin++) {
            var w0 = bin > minBin ? weight[bin - 1] : 0;
            var w1 = weight[bin];
            var w2 = bin < maxBin ? weight[bin + 1] : 0;
            smoothed[bin] = (w0 + 2 * w1 + w2) / 4;
            totalW += smoothed[bin];
        }
        if (totalW <= 0) return [threshold / 2];

        var rangeBins = Math.max(1, maxBin - minBin);
        var targetCount = Math.max(4, Math.min(200, Math.round(rangeBins / Math.max(1, interval))));
        var levels = [];
        var cum = 0, bIdx = minBin;
        for (var k = 1; k < targetCount; k++) {
            var q = totalW * (k / targetCount);
            while (bIdx <= maxBin && cum < q) {
                cum += smoothed[bIdx];
                bIdx++;
            }
            var lvl = (Math.min(bIdx, maxBin) - 0.5) / 255;
            if (lvl > 0 && lvl < threshold) levels.push(lvl);
        }
        if (levels.length === 0) levels.push((minBin + maxBin) / 2 / 255);
        return levels;
    }

    // ─── Gradient-histogram adaptive levels (Eikonal mode) ───
    // Levels are placed at quantiles of a *gradient-weighted* field-value histogram:
    // regions with lots of image detail receive more contour lines.
    function generateAdaptiveLevelsGrad(solution, width, height, interval, min, max, gradMag, detailLevel, featureImportance) {
        var levels = [];
        if (min === Infinity || max === -Infinity) return levels;
        var range = max - min;
        if (!isFinite(range) || range < 0.001) return [min + range / 2];

        var BINS = 256;
        var hist = new Float64Array(BINS);
        var detail = (detailLevel == null) ? 0.7 : detailLevel;
        var feat = (featureImportance == null) ? 0.5 : featureImportance;
        var density = 0.35 + 0.85 * detail;

        var i, v, bin, g, gNorm, w;
        for (i = 0; i < solution.length; i++) {
            v = solution[i];
            if (!isFinite(v)) continue;
            bin = Math.floor(((v - min) / range) * (BINS - 1));
            if (bin < 0) bin = 0; else if (bin > BINS - 1) bin = BINS - 1;
            w = density;
            if (gradMag) {
                g = gradMag[i];
                gNorm = Math.min(1, g / 0.5);
                w *= (1 + feat * gNorm);
            }
            hist[bin] += w;
        }

        var total = 0;
        for (i = 0; i < BINS; i++) total += hist[i];
        if (total <= 0) {
            // Fallback: linear levels
            for (var lv = min + interval; lv < max; lv += interval) levels.push(lv);
            return levels;
        }

        var targetCount = Math.max(4, Math.min(300, Math.round(range / Math.max(0.5, interval * 0.85))));
        var minGap = (range / targetCount) * 0.22;
        var prev = -Infinity;
        // One cumulative pass over bins; each quantile then walks forward from
        // the previous quantile's bin (monotonic) instead of rescanning all bins.
        var b = 0, accC = 0;
        for (var k = 1; k < targetCount; k++) {
            var q = k / targetCount;
            var targetAcc = total * q;
            while (b < BINS && accC < targetAcc) {
                accC += hist[b];
                b++;
            }
            var t = b < BINS ? b - 1 : BINS - 1;
            var level = min + (t / (BINS - 1)) * range;
            if (level - prev >= minGap && level > min && level < max) {
                levels.push(level);
                prev = level;
            }
        }
        if (levels.length === 0) levels.push(min + range * 0.5);
        return levels;
    }

    // ─── Edge-guidance warp ───
    // Samples the scalar field at positions shifted toward nearby image edges:
    // x' = x − s·∇d·exp(−d²/2σ²)  (d = unsigned distance to edges)
    function bilinearSample(field, width, height, x, y) {
        if (x < 0) x = 0; else if (x > width - 1) x = width - 1;
        if (y < 0) y = 0; else if (y > height - 1) y = height - 1;
        var x0 = Math.floor(x), y0 = Math.floor(y);
        var x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
        var fx = x - x0, fy = y - y0;
        var v00 = field[y0 * width + x0], v10 = field[y0 * width + x1];
        var v01 = field[y1 * width + x0], v11 = field[y1 * width + x1];
        return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    }

    function applyEdgeWarp(solution, edgeDistance, width, height, edgeSensitivity) {
        if (!edgeDistance || !solution) return solution;
        var s = 1 + 4 * edgeSensitivity;
        var sigma = 2 + 3 * edgeSensitivity;
        var inv2sigma2 = 1 / (2 * sigma * sigma);
        var out = new Float32Array(solution.length);
        var i, x, y, d, gx, gy, mag, fall, wx, wy;
        for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
                i = y * width + x;
                d = edgeDistance[i];
                gx = (x < width - 1 ? edgeDistance[i + 1] : d) - (x > 0 ? edgeDistance[i - 1] : d);
                gy = (y < height - 1 ? edgeDistance[i + width] : d) - (y > 0 ? edgeDistance[i - width] : d);
                mag = Math.sqrt(gx * gx + gy * gy) || 1;
                fall = Math.exp(-d * d * inv2sigma2);
                wx = x - s * (gx / mag) * fall;
                wy = y - s * (gy / mag) * fall;
                out[i] = bilinearSample(solution, width, height, wx, wy);
            }
        }
        return out;
    }

    // ─── Corner-aware smoothing ───
    // Splits the path at sharp corners (angle > cornerAngle) and applies Catmull-Rom
    // only to the gentle stretches, preserving crisp features for plotting.
    function smoothPathCornerAware(points, segments, tension, cornerAngle) {
        if (!points || points.length < 3) return points || [];
        // Fast path: skip the filter allocation when all points are valid (common)
        var valid = points, allValid = true;
        for (var vi = 0; vi < points.length; vi++) {
            var pv = points[vi];
            if (!pv || pv.x === undefined || pv.y === undefined) { allValid = false; break; }
        }
        if (!allValid) {
            valid = points.filter(function (p) { return p && p.x !== undefined && p.y !== undefined; });
        }
        if (valid.length < 3) return valid;
        segments = segments || 4;
        tension = (tension == null) ? 0.5 : tension;
        cornerAngle = (cornerAngle == null) ? 30 : cornerAngle;
        var cornerRad = cornerAngle * Math.PI / 180;

        var splits = [0];
        for (var i = 1; i < valid.length - 1; i++) {
            var a = valid[i - 1], b = valid[i], c = valid[i + 1];
            var v1x = b.x - a.x, v1y = b.y - a.y;
            var v2x = c.x - b.x, v2y = c.y - b.y;
            var m1 = Math.sqrt(v1x * v1x + v1y * v1y);
            var m2 = Math.sqrt(v2x * v2x + v2y * v2y);
            if (m1 < 1e-6 || m2 < 1e-6) continue;
            var dot = (v1x * v2x + v1y * v2y) / (m1 * m2);
            var ang = Math.acos(Math.max(-1, Math.min(1, dot)));
            if (ang > cornerRad) splits.push(i);
        }
        splits.push(valid.length - 1);

        var out = [];
        for (var sIdx = 0; sIdx < splits.length - 1; sIdx++) {
            var start = splits[sIdx], end = splits[sIdx + 1];
            if (end - start < 2) {
                for (var pp = start; pp <= end; pp++) out.push(valid[pp]);
                continue;
            }
            var smoothed = splineSmooth(valid.slice(start, end + 1), segments, tension);
            if (sIdx > 0 && smoothed.length > 0) smoothed.shift();
            for (var sp = 0; sp < smoothed.length; sp++) out.push(smoothed[sp]);
        }
        return out;
    }

    // ─── CPU fallbacks for preprocessing / gradients / distance ───
    function boxBlurAxis(src, dst, width, height, radius, axis) {
        var n = width * height;
        for (var i = 0; i < n; i++) {
            var x = i % width, y = (i / width) | 0;
            var sum = 0, cnt = 0;
            for (var t = -radius; t <= radius; t++) {
                var sx = x, sy = y;
                if (axis === 0) sx = Math.max(0, Math.min(width - 1, x + t));
                else sy = Math.max(0, Math.min(height - 1, y + t));
                sum += src[sy * width + sx];
                cnt++;
            }
            dst[i] = sum / cnt;
        }
    }

    // imageData → Float32Array luminance [0..1] with optional blur/contrast/invert
    function preprocessCPU(imageData, opts) {
        opts = opts || {};
        var blurRadius = Math.max(0, Math.min(8, Math.round(opts.blurRadius || 0)));
        var contrast = (opts.contrast != null) ? opts.contrast : 1;
        var invert = !!opts.invert;
        var width = imageData.width, height = imageData.height;
        var data = imageData.data;
        var gray = new Float32Array(width * height);
        var i, off, lum;
        for (i = 0; i < gray.length; i++) {
            off = i * 4;
            lum = (0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2]) / 255;
            lum = Math.max(0, Math.min(1, (lum - 0.5) * contrast + 0.5));
            if (invert) lum = 1 - lum;
            gray[i] = lum;
        }
        if (blurRadius > 0) {
            var tmp = new Float32Array(width * height);
            var passes = blurRadius >= 3 ? 2 : 1;
            for (var p = 0; p < passes; p++) {
                boxBlurAxis(gray, tmp, width, height, blurRadius, 0);
                boxBlurAxis(tmp, gray, width, height, blurRadius, 1);
            }
        }
        return gray;
    }

    // Sobel gradient (CPU) → { gradX, gradY, gradMag }
    // Row-cached: hoists clamped row bases and interior-column fast path out of
    // the hot loop (identical math, border handled by the same clamp logic).
    function sobelGradientCPU(gray, width, height) {
        var n = width * height;
        var gradX = new Float32Array(n);
        var gradY = new Float32Array(n);
        var gradMag = new Float32Array(n);
        for (var y = 0; y < height; y++) {
            var ym = (y > 0 ? y - 1 : 0) * width;
            var yr = y * width;
            var yp = (y < height - 1 ? y + 1 : height - 1) * width;
            for (var x = 0; x < width; x++) {
                var i = yr + x;
                var xm = x > 0 ? x - 1 : 0, xp = x < width - 1 ? x + 1 : width - 1;
                var tl = gray[ym + xm], tc = gray[ym + x], tr = gray[ym + xp];
                var ml = gray[yr + xm], mr = gray[yr + xp];
                var bl = gray[yp + xm], bc = gray[yp + x], br = gray[yp + xp];
                var gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
                var gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
                gradX[i] = gx;
                gradY[i] = gy;
                gradMag[i] = Math.sqrt(gx * gx + gy * gy);
            }
        }
        return { gradX: gradX, gradY: gradY, gradMag: gradMag };
    }

    // Chamfer 3-4 distance transform (CPU) — unsigned distance to mask=1 pixels
    function distanceTransformChamfer(mask, width, height) {
        var INF = 1e9;
        var dist = new Float32Array(width * height);
        var i;
        for (i = 0; i < dist.length; i++) dist[i] = mask[i] ? 0 : INF;
        var x, y, best;
        for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
                i = y * width + x;
                if (dist[i] === 0) continue;
                best = dist[i];
                if (x > 0) best = Math.min(best, dist[i - 1] + 1);
                if (x > 0 && y > 0) best = Math.min(best, dist[i - width - 1] + 4);
                if (y > 0) best = Math.min(best, dist[i - width] + 1);
                if (x < width - 1 && y > 0) best = Math.min(best, dist[i - width + 1] + 4);
                dist[i] = best;
            }
        }
        for (y = height - 1; y >= 0; y--) {
            for (x = width - 1; x >= 0; x--) {
                i = y * width + x;
                best = dist[i];
                if (x < width - 1) best = Math.min(best, dist[i + 1] + 1);
                if (x < width - 1 && y < height - 1) best = Math.min(best, dist[i + width + 1] + 4);
                if (y < height - 1) best = Math.min(best, dist[i + width] + 1);
                if (x > 0 && y < height - 1) best = Math.min(best, dist[i + width - 1] + 4);
                dist[i] = best;
            }
        }
        return dist;
    }


    // ─── Public API ───
    return {
        marchSquaresField: marchSquaresField,
        marchSquaresDirect: marchSquaresDirect,
        generateLuminanceLevels: generateLuminanceLevels,
        generateAdaptiveLevelsGrad: generateAdaptiveLevelsGrad,
        applyEdgeWarp: applyEdgeWarp,
        smoothPathCornerAware: smoothPathCornerAware,
        preprocessCPU: preprocessCPU,
        sobelGradientCPU: sobelGradientCPU,
        distanceTransformChamfer: distanceTransformChamfer,
        joinSegments: joinSegments,
        simplifyPath: simplifyPath,
        splineSmooth: splineSmooth,
        toGrayscale: toGrayscale,
        solveEikonalFMM: solveEikonalFMM,
        pointDistance: pointDistance,
        getPathLength: getPathLength
    };
})();
