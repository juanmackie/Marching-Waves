// Marching Waves Engine — shared by main thread and worker
var Engine = (function () {
    'use strict';

    // ─── Marching Squares (correct 16-case table) ───
    function marchSquaresField(solution, width, height, levels) {
        var raw = [];
        if (levels.length === 0 || width < 2 || height < 2) return raw;
        var interp = function (v1, v2, level) {
            if (!isFinite(v1) || !isFinite(v2)) return 0.5;
            var diff = v2 - v1;
            if (Math.abs(diff) < 1e-8) return 0.5;
            return Math.max(0, Math.min(1, (level - v1) / diff));
        };
        // Per-cell corner min/max: one O(cells) pass lets every level skip
        // cells whose 4 corners are all above or all below it with two
        // comparisons (byte-identical output — same cells emit same segments).
        var cw = width - 1, ch = height - 1;
        var cMin = new Float32Array(cw * ch);
        var cMax = new Float32Array(cw * ch);
        var ci = 0;
        for (var cy = 0; cy < ch; cy++) {
            var crow = cy * width;
            for (var cx = 0; cx < cw; cx++, ci++) {
                var b = crow + cx;
                var a0 = solution[b], a1 = solution[b + 1], a2 = solution[b + width], a3 = solution[b + width + 1];
                var mn = a0 < a1 ? a0 : a1; if (a2 < mn) mn = a2; if (a3 < mn) mn = a3;
                var mx = a0 > a1 ? a0 : a1; if (a2 > mx) mx = a2; if (a3 > mx) mx = a3;
                cMin[ci] = mn; cMax[ci] = mx;
            }
        }
        ci = 0;
        for (var li = 0; li < levels.length; li++) {
            var level = levels[li], lines = [], w = width, h = height, sol = solution;
            ci = 0;
            for (var y = 0; y < h - 1; y++) {
                var row = y * w;
                for (var x = 0; x < w - 1; x++, ci++) {
                    if (level < cMin[ci] || level > cMax[ci]) continue;
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

        // end-point adjacency map: keyed by hash → packed int candidates.
        // Each candidate packs (segmentIndex * 2 + endpointBit) into one int,
        // avoiding a {idx,end} object per segment endpoint.
        var map = Object.create(null);
        for (var i = 0; i < all.length; i++) {
            var seg = all[i];
            var h1 = hash(seg.x1, seg.y1), h2 = hash(seg.x2, seg.y2);
            var b1 = map[h1]; if (b1 === undefined) b1 = map[h1] = [];
            b1.push(i << 1);
            var b2 = map[h2]; if (b2 === undefined) b2 = map[h2] = [];
            b2.push((i << 1) | 1);
        }

        var used = new Uint8Array(all.length);
        var paths = [];
        var tolerance = 2.1; // tolerance for endpoint distance matching

        // find the best matching segment endpoint at (x, y) not yet used;
        // returns packed candidate or -1
        var findMatch = function (x, y) {
            var candidates = map[hash(x, y)];
            if (candidates === undefined) return -1;
            var best = -1, bestD = Infinity;
            for (var c = 0; c < candidates.length; c++) {
                var packed = candidates[c];
                var sIdx = packed >>> 1;
                if (used[sIdx]) continue;
                var s = all[sIdx];
                var px, py;
                if ((packed & 1) === 0) { px = s.x1; py = s.y1; }
                else { px = s.x2; py = s.y2; }
                var dx = px - x, dy = py - y;
                var d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = packed; }
            }
            if (bestD <= tolerance * tolerance) return best;
            return -1;
        };

        for (var i = 0; i < all.length; i++) {
            if (used[i]) continue;

            var seg = all[i];
            var path = [{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }];
            used[i] = 1;

            // chain forward from end
            var cx = seg.x2, cy = seg.y2;
            while (true) {
                var packedF = findMatch(cx, cy);
                if (packedF < 0) break;
                var ms = all[packedF >>> 1];
                if ((packedF & 1) === 0) { path.push({ x: ms.x2, y: ms.y2 }); cx = ms.x2; cy = ms.y2; }
                else { path.push({ x: ms.x1, y: ms.y1 }); cx = ms.x1; cy = ms.y1; }
                used[packedF >>> 1] = 1;
            }

            // chain backward from start (collect with push, reverse once —
            // same order as repeated unshift without the O(n^2))
            cx = seg.x1; cy = seg.y1;
            var pre = [];
            while (true) {
                var packedB = findMatch(cx, cy);
                if (packedB < 0) break;
                var msB = all[packedB >>> 1];
                if ((packedB & 1) === 0) { pre.push({ x: msB.x2, y: msB.y2 }); cx = msB.x2; cy = msB.y2; }
                else { pre.push({ x: msB.x1, y: msB.y1 }); cx = msB.x1; cy = msB.y1; }
                used[packedB >>> 1] = 1;
            }
            if (pre.length > 0) {
                pre.reverse();
                path = pre.concat(path);
            }

            if (path.length > 1) paths.push(path);
        }
        return paths;
    }

    // ─── RDP simplification (iterative, keep-mask) ───
    // Same result as the recursive form — each range's decision depends only on
    // its endpoints and epsilon, so processing order never changes the kept set;
    // emitting kept points in index order reproduces the exact output order.
    function simplifyPath(points, epsilon) {
        if (!points || points.length <= 2) return points || [];
        var valid = points, allValid = true;
        for (var vi = 0; vi < points.length; vi++) {
            var pv = points[vi];
            if (!pv || pv.x === undefined || pv.y === undefined) { allValid = false; break; }
        }
        if (!allValid) {
            valid = points.filter(function (p) { return p && p.x !== undefined && p.y !== undefined; });
        }
        var n = valid.length;
        if (n <= 2) return valid.slice ? valid.slice() : valid;

        var keep = new Uint8Array(n);
        keep[0] = 1; keep[n - 1] = 1;

        // explicit stack of [lo, hi] ranges (replaces recursion + slice/concat)
        var stack = [[0, n - 1]];
        while (stack.length > 0) {
            var seg = stack.pop();
            var lo = seg[0], hi = seg[1];
            if (hi - lo < 2) continue;
            var p0 = valid[lo], pe = valid[hi];
            var dmax = -1, index = -1;
            for (var i = lo + 1; i < hi; i++) {
                var d = perpDist(valid[i], p0, pe);
                if (d > dmax) { dmax = d; index = i; }
            }
            if (dmax > epsilon) {
                keep[index] = 1;
                stack.push([index, hi]);
                stack.push([lo, index]);
            }
        }

        var out = [];
        for (var k = 0; k < n; k++) if (keep[k]) out.push(valid[k]);
        return out;
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
        // fast path: skip filter allocation when all points are valid (common)
        var valid = points, allValid = true;
        for (var vi = 0; vi < points.length; vi++) {
            var pv = points[vi];
            if (!pv || pv.x === undefined || pv.y === undefined) { allValid = false; break; }
        }
        if (!allValid) {
            valid = points.filter(function (p) { return p && p.x !== undefined && p.y !== undefined; });
        }
        var n = valid.length;
        if (n < 2) return valid.slice ? valid.slice() : valid;
        segments = segments || 4; tension = tension || 0.5;
        var out = [];
        // Faithful emulation of the original padded array
        // p = [v0].concat(valid, [vLast])  =>  p[j] = v0 if j==0,
        // v(j-1) for 1<=j<=n, vLast if j>=n+1.
        function P(j) {
            if (j <= 0) return valid[0];
            if (j >= n + 1) return valid[n - 1];
            return valid[j - 1];
        }
        var cr = function (p0, p1, p2, p3, t) {
            var t2 = t * t, t3 = t2 * t;
            var v0 = (p2.x - p0.x) * tension, v1 = (p3.x - p1.x) * tension;
            var x = (2 * p1.x - 2 * p2.x + v0 + v1) * t3 + (-3 * p1.x + 3 * p2.x - 2 * v0 - v1) * t2 + v0 * t + p1.x;
            var u0 = (p2.y - p0.y) * tension, u1 = (p3.y - p1.y) * tension;
            var y = (2 * p1.y - 2 * p2.y + u0 + u1) * t3 + (-3 * p1.y + 3 * p2.y - 2 * u0 - u1) * t2 + u0 * t + p1.y;
            return { x: x, y: y };
        };
        var lastSeg = n - 2;
        for (var i = 0; i < lastSeg + 1; i++) {
            for (var t = 0; t < segments; t++) {
                var s = t / segments;
                if (i === lastSeg && t === segments - 1) { out.push(cr(P(i), P(i + 1), P(i + 2), P(i + 3), 1)); }
                else { out.push(cr(P(i), P(i + 1), P(i + 2), P(i + 3), s)); }
            }
        }
        if (out.length > 0) {
            var last = out[out.length - 1], lp = valid[n - 1];
            if (last.x !== lp.x || last.y !== lp.y) out.push(lp);
        } else out = valid.slice ? valid.slice() : valid;
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
        // Values are always read back from the Float32Array solution before being
        // pushed, so storing them as Float32 is numerically exact.
        var hv = new Float32Array(cap);
        var hi = new Int32Array(cap);
        function hpush(v, ix) {
            if (hn === cap) {
                var ncap = cap << 1;
                var nv = new Float32Array(ncap); nv.set(hv); hv = nv;
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
            poppedV = hv[0];
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
        // Value of the most recent pop — used by the stale-pop guard below.
        var poppedV = 0;
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
            // Stale-pop guard: skip entries overtaken by an already-finalized
            // better value — that cell's neighbors were relaxed when it popped.
            if (poppedV > solution[cIdx]) continue;
            var cx = cIdx % w, cy = (cIdx - cx) / w;
            visited[cIdx] = 1;

            // Upwind stencil around the popped cell — recomputed per neighbor
            // (same as original) since an earlier neighbor update in this same
            // pop can change what later stencil reads see. Neighbor loop is
            // unrolled to explicit left/right/up/down blocks (same order as the
            // original d=0..3 loop, identical math, no loop bookkeeping).

            // d = 0: left neighbor
            if (cx > 0) {
                var nIdx = cIdx - 1;
                if (!visited[nIdx]) {
                    var ux  = (cx > 0)     ? solution[cIdx - 1] : Infinity;
                    var ux2 = (cx < w - 1) ? solution[cIdx + 1] : Infinity;
                    var uy  = (cy > 0)     ? solution[cIdx - w] : Infinity;
                    var uy2 = (cy < h - 1) ? solution[cIdx + w] : Infinity;
                    var minX = ux < ux2 ? ux : ux2;
                    var minY = uy < uy2 ? uy : uy2;
                    var fVal = grayData[nIdx];
                    var newValue;
                    if (!(minX === Infinity && minY === Infinity)) {
                        if (minX === Infinity) newValue = minY + fVal;
                        else if (minY === Infinity) newValue = minX + fVal;
                        else {
                            var m = minX < minY ? minX : minY, o = minX < minY ? minY : minX;
                            if (o - m >= fVal) newValue = m + fVal;
                            else { var disc = 2 * fVal * fVal - (o - m) * (o - m); newValue = disc < 0 ? m + fVal : (m + o + Math.sqrt(disc)) / 2; }
                        }
                        if (newValue < solution[nIdx]) {
                            solution[nIdx] = newValue;
                            hpush(solution[nIdx], nIdx);
                        }
                    }
                }
            }

            // d = 1: right neighbor
            if (cx < w - 1) {
                var nIdxR = cIdx + 1;
                if (!visited[nIdxR]) {
                    var uxR  = (cx > 0)     ? solution[cIdx - 1] : Infinity;
                    var ux2R = (cx < w - 1) ? solution[cIdx + 1] : Infinity;
                    var uyR  = (cy > 0)     ? solution[cIdx - w] : Infinity;
                    var uy2R = (cy < h - 1) ? solution[cIdx + w] : Infinity;
                    var minXr = uxR < ux2R ? uxR : ux2R;
                    var minYr = uyR < uy2R ? uyR : uy2R;
                    var fValR = grayData[nIdxR];
                    var newValuer;
                    if (!(minXr === Infinity && minYr === Infinity)) {
                        if (minXr === Infinity) newValuer = minYr + fValR;
                        else if (minYr === Infinity) newValuer = minXr + fValR;
                        else {
                            var mr = minXr < minYr ? minXr : minYr, or = minXr < minYr ? minYr : minXr;
                            if (or - mr >= fValR) newValuer = mr + fValR;
                            else { var discR = 2 * fValR * fValR - (or - mr) * (or - mr); newValuer = discR < 0 ? mr + fValR : (mr + or + Math.sqrt(discR)) / 2; }
                        }
                        if (newValuer < solution[nIdxR]) {
                            solution[nIdxR] = newValuer;
                            hpush(solution[nIdxR], nIdxR);
                        }
                    }
                }
            }

            // d = 2: up neighbor
            if (cy > 0) {
                var nIdxU = cIdx - w;
                if (!visited[nIdxU]) {
                    var uxU  = (cx > 0)     ? solution[cIdx - 1] : Infinity;
                    var ux2U = (cx < w - 1) ? solution[cIdx + 1] : Infinity;
                    var uyU  = (cy > 0)     ? solution[cIdx - w] : Infinity;
                    var uy2U = (cy < h - 1) ? solution[cIdx + w] : Infinity;
                    var minXu = uxU < ux2U ? uxU : ux2U;
                    var minYu = uyU < uy2U ? uyU : uy2U;
                    var fValU = grayData[nIdxU];
                    var newValueu;
                    if (!(minXu === Infinity && minYu === Infinity)) {
                        if (minXu === Infinity) newValueu = minYu + fValU;
                        else if (minYu === Infinity) newValueu = minXu + fValU;
                        else {
                            var mu = minXu < minYu ? minXu : minYu, ou = minXu < minYu ? minYu : minXu;
                            if (ou - mu >= fValU) newValueu = mu + fValU;
                            else { var discU = 2 * fValU * fValU - (ou - mu) * (ou - mu); newValueu = discU < 0 ? mu + fValU : (mu + ou + Math.sqrt(discU)) / 2; }
                        }
                        if (newValueu < solution[nIdxU]) {
                            solution[nIdxU] = newValueu;
                            hpush(solution[nIdxU], nIdxU);
                        }
                    }
                }
            }

            // d = 3: down neighbor
            if (cy < h - 1) {
                var nIdxD = cIdx + w;
                if (!visited[nIdxD]) {
                    var uxD  = (cx > 0)     ? solution[cIdx - 1] : Infinity;
                    var ux2D = (cx < w - 1) ? solution[cIdx + 1] : Infinity;
                    var uyD  = (cy > 0)     ? solution[cIdx - w] : Infinity;
                    var uy2D = (cy < h - 1) ? solution[cIdx + w] : Infinity;
                    var minXd = uxD < ux2D ? uxD : ux2D;
                    var minYd = uyD < uy2D ? uyD : uy2D;
                    var fValD = grayData[nIdxD];
                    var newValued;
                    if (!(minXd === Infinity && minYd === Infinity)) {
                        if (minXd === Infinity) newValued = minYd + fValD;
                        else if (minYd === Infinity) newValued = minXd + fValD;
                        else {
                            var md = minXd < minYd ? minXd : minYd, od = minXd < minYd ? minYd : minXd;
                            if (od - md >= fValD) newValued = md + fValD;
                            else { var discD = 2 * fValD * fValD - (od - md) * (od - md); newValued = discD < 0 ? md + fValD : (md + od + Math.sqrt(discD)) / 2; }
                        }
                        if (newValued < solution[nIdxD]) {
                            solution[nIdxD] = newValued;
                            hpush(solution[nIdxD], nIdxD);
                        }
                    }
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
        // hoisted: multiply-by-inverse + |0 floor replaces division + Math.floor
        var scale = (BINS - 1) / range;
        var featX2 = feat * 2; // gNorm = min(1, g/0.5) = min(1, g*2)
        var hasGrad = !!gradMag;
        for (i = 0; i < solution.length; i++) {
            v = solution[i];
            if (!isFinite(v)) continue;
            bin = ((v - min) * scale) | 0;
            if (bin < 0) bin = 0; else if (bin > BINS - 1) bin = BINS - 1;
            w = density;
            if (hasGrad) {
                g = gradMag[i];
                gNorm = g >= 0.5 ? 1 : g * 2;
                w *= (1 + featX2 * gNorm);
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
        var twoSig2 = 2 * sigma * sigma;
        var inv2sigma2 = 1 / twoSig2;
        // Far-field fast path: beyond sqrt(9)*sigma the gaussian falloff is
        // < e^-9 (~1.2e-4), so the warp shift is under a thousandth of a pixel
        // and the pixel can be copied through untouched (skips exp/sqrt/bilinear).
        var cutoffSq = 9 * twoSig2;
        var out = new Float32Array(solution.length);
        var i, x, y, d, gx, gy, mag, fall, wx, wy;
        for (y = 0; y < height; y++) {
            var row = y * width;
            var rowUp = y > 0 ? row - width : row;
            var rowDn = y < height - 1 ? row + width : row;
            for (x = 0; x < width; x++) {
                i = row + x;
                d = edgeDistance[i];
                var dd = d * d;
                if (dd > cutoffSq) { out[i] = solution[i]; continue; }
                gx = (x < width - 1 ? edgeDistance[i + 1] : d) - (x > 0 ? edgeDistance[i - 1] : d);
                gy = (y < height - 1 ? edgeDistance[rowDn + x] : d) - (y > 0 ? edgeDistance[rowUp + x] : d);
                mag = Math.sqrt(gx * gx + gy * gy);
                if (mag === 0) { out[i] = solution[i]; continue; }
                fall = Math.exp(-dd * inv2sigma2);
                wx = x - s * (gx / mag) * fall;
                wy = y - s * (gy / mag) * fall;
                // inline bilinear sample of solution at (wx, wy)
                if (wx < 0) wx = 0; else if (wx > width - 1) wx = width - 1;
                if (wy < 0) wy = 0; else if (wy > height - 1) wy = height - 1;
                var x0 = Math.floor(wx), y0 = Math.floor(wy);
                var x1 = x0 + 1; if (x1 > width - 1) x1 = width - 1;
                var y1 = y0 + 1; if (y1 > height - 1) y1 = height - 1;
                var fx = wx - x0, fy = wy - y0;
                var r0 = y0 * width, r1 = y1 * width;
                var v00 = solution[r0 + x0], v10 = solution[r0 + x1];
                var v01 = solution[r1 + x0], v11 = solution[r1 + x1];
                out[i] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
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
        // Prefix-sum window: each output pixel is (P[hi+1] - P[lo]) / count with
        // clamped bounds — O(1) per pixel instead of re-summing 2r+1 taps.
        var w2 = radius * 2 + 1;
        var x, y, i, lo, hi, sum;
        if (axis === 0) {
            var prow = new Float64Array(width + 1);
            for (y = 0; y < height; y++) {
                var row = y * width;
                prow[0] = 0;
                for (x = 0; x < width; x++) prow[x + 1] = prow[x] + src[row + x];
                for (x = 0; x < width; x++) {
                    lo = x - radius; if (lo < 0) lo = 0;
                    hi = x + radius; if (hi > width - 1) hi = width - 1;
                    dst[row + x] = (prow[hi + 1] - prow[lo]) / (hi - lo + 1);
                }
            }
        } else {
            var pcol = new Float64Array(height + 1);
            for (x = 0; x < width; x++) {
                pcol[0] = 0;
                for (y = 0; y < height; y++) pcol[y + 1] = pcol[y] + src[y * width + x];
                for (y = 0; y < height; y++) {
                    lo = y - radius; if (lo < 0) lo = 0;
                    hi = y + radius; if (hi > height - 1) hi = height - 1;
                    dst[y * width + x] = (pcol[hi + 1] - pcol[lo]) / (hi - lo + 1);
                }
            }
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
