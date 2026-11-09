// Marching Waves engine — flat typed-array kernels shared by the page, worker, and benchmark.
// No DOM at file scope. Loaded by indirect eval in Node (benchmarks), so `var Engine` must stay global.
var Engine = (function () {
    'use strict';

    var JOIN_TOL_SQ = 2.1 * 2.1;
    var DEFAULT_SEED = 0x9E3779B9;

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function mulberry32(seed) {
        var a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function hash2(seed, a, b) {
        var h = Math.imul(seed ^ (a + 0x9E3779B9), 0x85EBCA6B);
        h = Math.imul(h ^ (b + 0xC2B2AE35), 0x27D4EB2F);
        h ^= h >>> 15;
        return (h >>> 0) / 4294967296;
    }

    function report(hooks, fraction, label) {
        if (hooks && hooks.progress) hooks.progress(fraction, label);
    }

    async function tick(hooks) {
        if (hooks && hooks.checkpoint) await hooks.checkpoint();
    }

    function GrowF(cap) {
        this.a = new Float32Array(cap || 4096);
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

    function GrowI(cap) {
        this.a = new Int32Array(cap || 1024);
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

    function emptyGeometry() {
        return {
            offsets: new Int32Array(1),
            xy: new Float32Array(0),
            radius: new Float32Array(0),
            widths: new Float32Array(0),
            count: 0
        };
    }

    function finiteRange(data) {
        var min = Infinity, max = -Infinity;
        for (var i = 0; i < data.length; i++) {
            var v = data[i];
            if (!isFinite(v) || v >= 1e8) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        return { min: min, max: max };
    }

    // ─── Preprocessing ───

    function boxBlurAxis(src, dst, width, height, radius, axis) {
        var x, y, lo, hi;
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

    function preprocess(imageData, opts) {
        opts = opts || {};
        var blurRadius = clamp(Math.round(opts.blurRadius || 0), 0, 8);
        var contrast = (opts.contrast != null) ? opts.contrast : 1;
        var invert = !!opts.invert;
        var width = imageData.width, height = imageData.height, data = imageData.data;
        var gray = new Float32Array(width * height);
        var i, off, lum;
        for (i = 0, off = 0; i < gray.length; i++, off += 4) {
            lum = (0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2]) / 255;
            lum = clamp((lum - 0.5) * contrast + 0.5, 0, 1);
            gray[i] = invert ? 1 - lum : lum;
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

    function sobel(gray, width, height, needXY) {
        var n = width * height;
        var gradMag = new Float32Array(n);
        var gradX = needXY ? new Float32Array(n) : null;
        var gradY = needXY ? new Float32Array(n) : null;
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
                if (gradX) { gradX[i] = gx; gradY[i] = gy; }
                gradMag[i] = Math.sqrt(gx * gx + gy * gy);
            }
        }
        return { gradX: gradX, gradY: gradY, gradMag: gradMag };
    }

    function chamfer(mask, width, height) {
        var INF = 1e9;
        var dist = new Float32Array(width * height);
        var i, x, y, best;
        for (i = 0; i < dist.length; i++) dist[i] = mask[i] ? 0 : INF;
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

    // ─── Fast Marching Method (flat SoA heap, duplicate pushes + stale guard) ───

    async function fmm(gray, width, height, threshold, hooks) {
        var size = width * height;
        var solution = new Float32Array(size);
        solution.fill(Infinity);
        var visited = new Uint8Array(size);

        // Lazy-deletion heap: entries can be pushed more than once and stale
        // pops are skipped. This avoids a random-access position map and is
        // measurably faster than decrease-key at these sizes.
        var cap = size + 1, hn = 0;
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
        var poppedV = 0;
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
        var y0, x0, row0, i0;
        var wave = hooks && hooks.onWave ? hooks.onWave : null;
        for (y0 = 0; y0 < h; y0++) {
            row0 = y0 * w;
            for (x0 = 0; x0 < w; x0++) {
                i0 = row0 + x0;
                if (gray[i0] < threshold) {
                    solution[i0] = 0;
                    visited[i0] = 1;
                    hv[hn] = 0; hi[hn] = i0; hn++;
                    if (wave) wave(i0, 0);
                }
            }
        }

        var processed = 0;
        while (hn > 0) {
            var cIdx = hpop();
            if (poppedV > solution[cIdx]) continue;
            if (!visited[cIdx] && wave) wave(cIdx, solution[cIdx]);
            visited[cIdx] = 1;

            var cx = cIdx % w, cy = (cIdx - cx) / w;

            // Neighbour blocks run left, right, up, down and re-read the stencil
            // every time. The order is load-bearing: a block can mutate a cell a
            // later block reads.

            if (cx > 0) {
                var nL = cIdx - 1;
                if (!visited[nL]) {
                    var ux = solution[cIdx - 1];
                    var ux2 = (cx < w - 1) ? solution[cIdx + 1] : Infinity;
                    var uy = (cy > 0) ? solution[cIdx - w] : Infinity;
                    var uy2 = (cy < h - 1) ? solution[cIdx + w] : Infinity;
                    var minX = ux < ux2 ? ux : ux2;
                    var minY = uy < uy2 ? uy : uy2;
                    var fL = gray[nL];
                    if (!(minX === Infinity && minY === Infinity)) {
                        var newL;
                        if (minX === Infinity) newL = minY + fL;
                        else if (minY === Infinity) newL = minX + fL;
                        else {
                            var mL = minX < minY ? minX : minY, oL = minX < minY ? minY : minX;
                            if (oL - mL >= fL) newL = mL + fL;
                            else {
                                var dL = 2 * fL * fL - (oL - mL) * (oL - mL);
                                newL = dL < 0 ? mL + fL : (mL + oL + Math.sqrt(dL)) / 2;
                            }
                        }
                        if (newL < solution[nL]) {
                            solution[nL] = newL;
                            hpush(solution[nL], nL);
                        }
                    }
                }
            }

            if (cx < w - 1) {
                var nR = cIdx + 1;
                if (!visited[nR]) {
                    var uxR = solution[cIdx - 1];
                    var ux2R = solution[cIdx + 1];
                    var uyR = (cy > 0) ? solution[cIdx - w] : Infinity;
                    var uy2R = (cy < h - 1) ? solution[cIdx + w] : Infinity;
                    var minXr = uxR < ux2R ? uxR : ux2R;
                    var minYr = uyR < uy2R ? uyR : uy2R;
                    var fR = gray[nR];
                    if (!(minXr === Infinity && minYr === Infinity)) {
                        var newR;
                        if (minXr === Infinity) newR = minYr + fR;
                        else if (minYr === Infinity) newR = minXr + fR;
                        else {
                            var mR = minXr < minYr ? minXr : minYr, oR = minXr < minYr ? minYr : minXr;
                            if (oR - mR >= fR) newR = mR + fR;
                            else {
                                var dR = 2 * fR * fR - (oR - mR) * (oR - mR);
                                newR = dR < 0 ? mR + fR : (mR + oR + Math.sqrt(dR)) / 2;
                            }
                        }
                        if (newR < solution[nR]) {
                            solution[nR] = newR;
                            hpush(solution[nR], nR);
                        }
                    }
                }
            }

            if (cy > 0) {
                var nU = cIdx - w;
                if (!visited[nU]) {
                    var uxU = (cx > 0) ? solution[cIdx - 1] : Infinity;
                    var ux2U = (cx < w - 1) ? solution[cIdx + 1] : Infinity;
                    var uyU = solution[cIdx - w];
                    var uy2U = (cy < h - 1) ? solution[cIdx + w] : Infinity;
                    var minXu = uxU < ux2U ? uxU : ux2U;
                    var minYu = uyU < uy2U ? uyU : uy2U;
                    var fU = gray[nU];
                    if (!(minXu === Infinity && minYu === Infinity)) {
                        var newU;
                        if (minXu === Infinity) newU = minYu + fU;
                        else if (minYu === Infinity) newU = minXu + fU;
                        else {
                            var mU = minXu < minYu ? minXu : minYu, oU = minXu < minYu ? minYu : minXu;
                            if (oU - mU >= fU) newU = mU + fU;
                            else {
                                var dU = 2 * fU * fU - (oU - mU) * (oU - mU);
                                newU = dU < 0 ? mU + fU : (mU + oU + Math.sqrt(dU)) / 2;
                            }
                        }
                        if (newU < solution[nU]) {
                            solution[nU] = newU;
                            hpush(solution[nU], nU);
                        }
                    }
                }
            }

            if (cy < h - 1) {
                var nD = cIdx + w;
                if (!visited[nD]) {
                    var uxD = (cx > 0) ? solution[cIdx - 1] : Infinity;
                    var ux2D = (cx < w - 1) ? solution[cIdx + 1] : Infinity;
                    var uyD = (cy > 0) ? solution[cIdx - w] : Infinity;
                    var uy2D = solution[cIdx + w];
                    var minXd = uxD < ux2D ? uxD : ux2D;
                    var minYd = uyD < uy2D ? uyD : uy2D;
                    var fD = gray[nD];
                    if (!(minXd === Infinity && minYd === Infinity)) {
                        var newD;
                        if (minXd === Infinity) newD = minYd + fD;
                        else if (minYd === Infinity) newD = minXd + fD;
                        else {
                            var mD = minXd < minYd ? minXd : minYd, oD = minXd < minYd ? minYd : minXd;
                            if (oD - mD >= fD) newD = mD + fD;
                            else {
                                var dD = 2 * fD * fD - (oD - mD) * (oD - mD);
                                newD = dD < 0 ? mD + fD : (mD + oD + Math.sqrt(dD)) / 2;
                            }
                        }
                        if (newD < solution[nD]) {
                            solution[nD] = newD;
                            hpush(solution[nD], nD);
                        }
                    }
                }
            }

            processed++;
            if ((processed & 4095) === 0) {
                report(hooks, 0.1 + 0.5 * (processed / size), 'Solving Eikonal equation');
                await tick(hooks);
            }
        }
        report(hooks, 0.6, 'Field solved');
        return solution;
    }

    // ─── Level generation ───

    function levelsLuminance(gray, width, height, interval, threshold, gradMag) {
        var BINS = 256;
        var hist = new Float64Array(BINS);
        var gradSum = new Float64Array(BINS);
        var gradCount = new Uint32Array(BINS);
        var i, v, bin;
        for (i = 0; i < gray.length; i++) {
            v = gray[i];
            if (v >= threshold) continue;
            bin = clamp(Math.round(v * 255), 0, BINS - 1);
            hist[bin]++;
            if (gradMag) { gradSum[bin] += gradMag[i]; gradCount[bin]++; }
        }
        var minBin = -1, maxBin = -1;
        for (bin = 0; bin < BINS; bin++) {
            if (hist[bin] > 0) {
                if (minBin < 0) minBin = bin;
                maxBin = bin;
            }
        }
        if (minBin < 0) return new Float32Array([threshold / 2]);

        var weight = new Float64Array(BINS);
        var useGrad = !!gradMag;
        for (bin = minBin; bin <= maxBin; bin++) {
            if (hist[bin] < 3) continue;
            if (useGrad && gradCount[bin] > 0) {
                var meanGrad = gradSum[bin] / gradCount[bin];
                weight[bin] = Math.min(50, 1 / Math.max(meanGrad, 0.02));
            } else weight[bin] = 1;
        }
        var smoothed = new Float64Array(BINS);
        var totalW = 0;
        for (bin = minBin; bin <= maxBin; bin++) {
            var w0 = bin > minBin ? weight[bin - 1] : 0;
            var w1 = weight[bin];
            var w2 = bin < maxBin ? weight[bin + 1] : 0;
            smoothed[bin] = (w0 + 2 * w1 + w2) / 4;
            totalW += smoothed[bin];
        }
        if (totalW <= 0) return new Float32Array([threshold / 2]);

        var rangeBins = Math.max(1, maxBin - minBin);
        var targetCount = Math.max(4, Math.min(200, Math.round(rangeBins / Math.max(1, interval))));
        var out = [];
        var cum = 0, bIdx = minBin;
        for (var k = 1; k < targetCount; k++) {
            var q = totalW * (k / targetCount);
            while (bIdx <= maxBin && cum < q) { cum += smoothed[bIdx]; bIdx++; }
            var lvl = (Math.min(bIdx, maxBin) - 0.5) / 255;
            if (lvl > 0 && lvl < threshold) out.push(lvl);
        }
        if (out.length === 0) out.push((minBin + maxBin) / 2 / 255);
        return new Float32Array(out);
    }

    function levelsAdaptive(field, width, height, interval, min, max, gradMag, detailLevel, featureImportance) {
        if (min === Infinity || max === -Infinity) return new Float32Array(0);
        var range = max - min;
        if (!isFinite(range) || range < 0.001) return new Float32Array([min + range / 2]);

        var BINS = 256;
        var hist = new Float64Array(BINS);
        var detail = (detailLevel == null) ? 0.7 : detailLevel;
        var feat = (featureImportance == null) ? 0.5 : featureImportance;
        var density = 0.35 + 0.85 * detail;
        var scale = (BINS - 1) / range;
        var featX2 = feat * 2;
        var hasGrad = !!gradMag;
        var i, v, bin, g;
        for (i = 0; i < field.length; i++) {
            v = field[i];
            if (!isFinite(v) || v >= 1e8) continue;
            bin = ((v - min) * scale) | 0;
            if (bin < 0) bin = 0; else if (bin > BINS - 1) bin = BINS - 1;
            var weight = density;
            if (hasGrad) {
                g = gradMag[i];
                weight *= (1 + featX2 * (g >= 0.5 ? 1 : g * 2));
            }
            hist[bin] += weight;
        }
        var total = 0;
        for (i = 0; i < BINS; i++) total += hist[i];
        if (total <= 0) {
            var linear = [];
            for (var lv = min + interval; lv < max; lv += interval) linear.push(lv);
            return new Float32Array(linear);
        }
        var targetCount = Math.max(4, Math.min(300, Math.round(range / Math.max(0.5, interval * 0.85))));
        var minGap = (range / targetCount) * 0.22;
        var prev = -Infinity;
        var out = [];
        var b = 0, accC = 0;
        for (var k = 1; k < targetCount; k++) {
            var targetAcc = total * (k / targetCount);
            while (b < BINS && accC < targetAcc) { accC += hist[b]; b++; }
            var t = b < BINS ? b - 1 : BINS - 1;
            var level = min + (t / (BINS - 1)) * range;
            if (level - prev >= minGap && level > min && level < max) {
                out.push(level);
                prev = level;
            }
        }
        if (out.length === 0) out.push(min + range * 0.5);
        return new Float32Array(out);
    }

    // ─── Edge warp ───

    function edgeWarp(solution, edgeDistance, width, height, edgeSensitivity) {
        if (!edgeDistance || !solution) return solution;
        var s = 1 + 4 * edgeSensitivity;
        var sigma = 2 + 3 * edgeSensitivity;
        var twoSig2 = 2 * sigma * sigma;
        var inv2sigma2 = 1 / twoSig2;
        var cutoffSq = 9 * twoSig2;
        var out = new Float32Array(solution.length);
        for (var y = 0; y < height; y++) {
            var row = y * width;
            var rowUp = y > 0 ? row - width : row;
            var rowDn = y < height - 1 ? row + width : row;
            for (var x = 0; x < width; x++) {
                var i = row + x;
                var d = edgeDistance[i];
                var dd = d * d;
                if (dd > cutoffSq) { out[i] = solution[i]; continue; }
                var gx = (x < width - 1 ? edgeDistance[i + 1] : d) - (x > 0 ? edgeDistance[i - 1] : d);
                var gy = (y < height - 1 ? edgeDistance[rowDn + x] : d) - (y > 0 ? edgeDistance[rowUp + x] : d);
                var mag = Math.sqrt(gx * gx + gy * gy);
                if (mag === 0) { out[i] = solution[i]; continue; }
                var fall = Math.exp(-dd * inv2sigma2);
                var wx = x - s * (gx / mag) * fall;
                var wy = y - s * (gy / mag) * fall;
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

    function fieldGradient(solution, width, height) {
        var gx = new Float32Array(width * height);
        var gy = new Float32Array(width * height);
        var gradMag = new Float32Array(width * height);
        for (var y = 0; y < height; y++) {
            var row = y * width;
            for (var x = 0; x < width; x++) {
                var i = row + x;
                var vx = (x < width - 1) ? solution[i + 1] - solution[i] : 0;
                var vy = (y < height - 1) ? solution[i + width] - solution[i] : 0;
                gx[i] = vx; gy[i] = vy;
                gradMag[i] = Math.sqrt(vx * vx + vy * vy);
            }
        }
        return { gx: gx, gy: gy, mag: gradMag };
    }

    // ─── Marching Squares ───

    var CODE_EDGES = [0, 9, 3, 10, 12, 5, 15, 6, 6, 15, 5, 12, 10, 3, 9, 0];

    function marchSquares(field, width, height, levels, bounds) {
        if (!levels.length || width < 2 || height < 2) {
            return { xy: new Float32Array(0), level: new Int32Array(0), count: 0 };
        }
        var cw = width - 1, ch = height - 1;
        var cMin = new Float32Array(cw * ch);
        var cMax = new Float32Array(cw * ch);
        var ci = 0, cy, cx;
        for (cy = 0; cy < ch; cy++) {
            var crow = cy * width;
            for (cx = 0; cx < cw; cx++, ci++) {
                var b = crow + cx;
                var a0 = field[b], a1 = field[b + 1], a2 = field[b + width], a3 = field[b + width + 1];
                var mn = a0 < a1 ? a0 : a1; if (a2 < mn) mn = a2; if (a3 < mn) mn = a3;
                var mx = a0 > a1 ? a0 : a1; if (a2 > mx) mx = a2; if (a3 > mx) mx = a3;
                cMin[ci] = mn; cMax[ci] = mx;
            }
        }

        var bx0 = 0, bx1 = cw, by0 = 0, by1 = ch;
        if (bounds) {
            bx0 = clamp(Math.floor(bounds.x), 0, cw);
            bx1 = clamp(Math.ceil(bounds.x + bounds.w), bx0, cw);
            by0 = clamp(Math.floor(bounds.y), 0, ch);
            by1 = clamp(Math.ceil(bounds.y + bounds.h), by0, ch);
        }

        var cap = 4096;
        var outXY = new Float32Array(cap * 4);
        var outLevel = new Int32Array(cap);
        var n = 0;
        function emit(x1, y1, x2, y2, levelId) {
            if (n === cap) {
                cap *= 2;
                var nXY = new Float32Array(cap * 4); nXY.set(outXY);
                var nL = new Int32Array(cap); nL.set(outLevel);
                outXY = nXY; outLevel = nL;
            }
            var o = n * 4;
            outXY[o] = x1; outXY[o + 1] = y1; outXY[o + 2] = x2; outXY[o + 3] = y2;
            outLevel[n] = levelId;
            n++;
        }
        function interp(v1, v2, level) {
            if (!isFinite(v1) || !isFinite(v2)) return 0.5;
            var diff = v2 - v1;
            if (Math.abs(diff) < 1e-8) return 0.5;
            return clamp((level - v1) / diff, 0, 1);
        }

        for (var li = 0; li < levels.length; li++) {
            var level = levels[li];
            for (var y = by0; y < by1; y++) {
                var row = y * width;
                ci = y * cw + bx0;
                for (var x = bx0; x < bx1; x++, ci++) {
                    if (level < cMin[ci] || level > cMax[ci]) continue;
                    var idx = row + x;
                    var v00 = field[idx], v10 = field[idx + 1], v01 = field[idx + width], v11 = field[idx + width + 1];
                    var code = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v01 >= level ? 4 : 0) | (v11 >= level ? 8 : 0);
                    if (code === 0 || code === 15) continue;

                    var bits = CODE_EDGES[code];
                    var tT = 0, tR = 0, tB = 0, tL = 0;
                    if (bits & 1) tT = interp(v00, v10, level);
                    if (bits & 2) tR = interp(v10, v11, level);
                    if (bits & 4) tB = interp(v01, v11, level);
                    if (bits & 8) tL = interp(v00, v01, level);

                    switch (code) {
                        case 1: emit(x + tT, y, x, y + tL, li); break;
                        case 2: emit(x + tT, y, x + 1, y + tR, li); break;
                        case 3: emit(x + 1, y + tR, x, y + tL, li); break;
                        case 4: emit(x + tB, y + 1, x, y + tL, li); break;
                        case 5: emit(x + tT, y, x + tB, y + 1, li); break;
                        case 6:
                            if ((v00 + v10 + v01 + v11) / 4 >= level) {
                                emit(x + tT, y, x, y + tL, li);
                                emit(x + tB, y + 1, x + 1, y + tR, li);
                            } else {
                                emit(x + tT, y, x + 1, y + tR, li);
                                emit(x + tB, y + 1, x, y + tL, li);
                            }
                            break;
                        case 7: emit(x + 1, y + tR, x + tB, y + 1, li); break;
                        case 8: emit(x + tB, y + 1, x + 1, y + tR, li); break;
                        case 9:
                            if ((v00 + v10 + v01 + v11) / 4 >= level) {
                                emit(x + tT, y, x + 1, y + tR, li);
                                emit(x + tB, y + 1, x, y + tL, li);
                            } else {
                                emit(x + tT, y, x, y + tL, li);
                                emit(x + tB, y + 1, x + 1, y + tR, li);
                            }
                            break;
                        case 10: emit(x + tT, y, x + tB, y + 1, li); break;
                        case 11: emit(x + tB, y + 1, x, y + tL, li); break;
                        case 12: emit(x + 1, y + tR, x, y + tL, li); break;
                        case 13: emit(x + tT, y, x + 1, y + tR, li); break;
                        case 14: emit(x + tT, y, x, y + tL, li); break;
                    }
                }
            }
        }
        return {
            xy: outXY.slice(0, n * 4),
            level: outLevel.slice(0, n),
            count: n
        };
    }

    // ─── Segment joining (exact-hash open addressing, insertion-ordered buckets) ───

    function joinSegments(segments) {
        var n = segments.count;
        if (!n) return emptyGeometry();
        var src = segments.xy;
        var hash = function (x, y) {
            return (Math.round(x * 1000) * 73856093 + Math.round(y * 1000) * 19349663) >>> 0;
        };

        var cap = 8;
        while (cap < n * 2) cap <<= 1;
        var mask = cap - 1;
        var head = new Int32Array(cap); head.fill(-1);
        var tail = new Int32Array(cap); tail.fill(-1);
        var keys = new Int32Array(cap);
        var next = new Int32Array(n * 2); next.fill(-1);

        function findBucket(h) {
            var i = h & mask;
            while (head[i] !== -1 && keys[i] !== (h | 0)) i = (i + 1) & mask;
            return i;
        }
        function insert(h, entry) {
            var b = findBucket(h);
            if (head[b] === -1) {
                keys[b] = h | 0;
                head[b] = entry;
                tail[b] = entry;
            } else {
                next[tail[b]] = entry;
                tail[b] = entry;
            }
        }
        var i, o;
        for (i = 0; i < n; i++) {
            o = i * 4;
            insert(hash(src[o], src[o + 1]), i << 1);
            insert(hash(src[o + 2], src[o + 3]), (i << 1) | 1);
        }

        var used = new Uint8Array(n);
        function findMatch(h, x, y) {
            var b = findBucket(h);
            if (head[b] === -1) return -1;
            var e = head[b], best = -1, bestD = Infinity;
            while (e !== -1) {
                var sIdx = e >>> 1;
                if (!used[sIdx]) {
                    var so = sIdx * 4;
                    var px = (e & 1) === 0 ? src[so] : src[so + 2];
                    var py = (e & 1) === 0 ? src[so + 1] : src[so + 3];
                    var dx = px - x, dy = py - y;
                    var d = dx * dx + dy * dy;
                    if (d < bestD) { bestD = d; best = e; }
                }
                e = next[e];
            }
            return bestD <= JOIN_TOL_SQ ? best : -1;
        }

        var out = new GrowF(4096);
        var offsets = new GrowI(256);
        offsets.push(0);
        var pre = new GrowF(256);
        var fwd = new GrowF(256);
        var pathCount = 0;

        for (i = 0; i < n; i++) {
            if (used[i]) continue;
            var so = i * 4;
            var sx = src[so], sy = src[so + 1], ex = src[so + 2], ey = src[so + 3];
            used[i] = 1;

            var cx = ex, cy = ey;
            fwd.n = 0;
            while (true) {
                var pf = findMatch(hash(cx, cy), cx, cy);
                if (pf < 0) break;
                var ms = (pf >>> 1) * 4;
                if ((pf & 1) === 0) { fwd.push(src[ms + 2]); fwd.push(src[ms + 3]); cx = src[ms + 2]; cy = src[ms + 3]; }
                else { fwd.push(src[ms]); fwd.push(src[ms + 1]); cx = src[ms]; cy = src[ms + 1]; }
                used[pf >>> 1] = 1;
            }

            pre.n = 0;
            cx = sx; cy = sy;
            while (true) {
                var pb = findMatch(hash(cx, cy), cx, cy);
                if (pb < 0) break;
                var mb = (pb >>> 1) * 4;
                if ((pb & 1) === 0) { pre.push(src[mb + 2]); pre.push(src[mb + 3]); cx = src[mb + 2]; cy = src[mb + 3]; }
                else { pre.push(src[mb]); pre.push(src[mb + 1]); cx = src[mb]; cy = src[mb + 1]; }
                used[pb >>> 1] = 1;
            }

            // pre is stored forward from the start; emit it in reverse, then the seed
            // segment, then the forward chain.
            for (var q = pre.n - 2; q >= 0; q -= 2) { out.push(pre.a[q]); out.push(pre.a[q + 1]); }
            out.push(sx); out.push(sy);
            out.push(ex); out.push(ey);
            for (q = 0; q < fwd.n; q++) out.push(fwd.a[q]);
            pathCount++;
            offsets.push(out.n / 2);
        }

        return {
            offsets: offsets.a.slice(0, offsets.n),
            xy: out.a.slice(0, out.n),
            radius: new Float32Array(out.n / 2),
            widths: new Float32Array(pathCount),
            count: pathCount
        };
    }

    // ─── Simplification (iterative RDP on flat points) ───

    function simplify(geometry, epsilon) {
        var g = geometry;
        if (!g.count) return emptyGeometry();
        var srcOff = g.offsets, srcXY = g.xy;
        var maxN = 0;
        for (var p = 0; p < g.count; p++) {
            var len = srcOff[p + 1] - srcOff[p];
            if (len > maxN) maxN = len;
        }
        var keep = new Uint8Array(maxN || 1);
        var loStack = new Int32Array((maxN || 1) * 2 + 2);
        var hiStack = new Int32Array((maxN || 1) * 2 + 2);

        var out = new GrowF(4096);
        var offsets = new GrowI(256);
        offsets.push(0);
        var pathCount = 0;
        var p, i, n, base;

        function perpDist(pi, a, b) {
            var pmx = srcXY[pi], pmy = srcXY[pi + 1];
            var ax = srcXY[a], ay = srcXY[a + 1];
            var bx = srcXY[b], by = srcXY[b + 1];
            var dx = bx - ax, dy = by - ay;
            var mag = Math.sqrt(dx * dx + dy * dy);
            if (mag === 0) {
                var qx = pmx - ax, qy = pmy - ay;
                return Math.sqrt(qx * qx + qy * qy);
            }
            dx /= mag; dy /= mag;
            var vx = pmx - ax, vy = pmy - ay;
            var dot = vx * dx + vy * dy;
            var nx = vx - dot * dx, ny = vy - dot * dy;
            return Math.sqrt(nx * nx + ny * ny);
        }

        for (p = 0; p < g.count; p++) {
            n = srcOff[p + 1] - srcOff[p];
            base = srcOff[p] * 2;
            if (n <= 2) {
                for (i = 0; i < n; i++) { out.push(srcXY[base + i * 2]); out.push(srcXY[base + i * 2 + 1]); }
                offsets.push(out.n / 2);
                pathCount++;
                continue;
            }
            keep.fill(0, 0, n);
            keep[0] = 1; keep[n - 1] = 1;
            var sp = 0;
            loStack[sp] = 0; hiStack[sp] = n - 1; sp++;
            while (sp > 0) {
                sp--;
                var lo = loStack[sp], hi = hiStack[sp];
                if (hi - lo < 2) continue;
                var dmax = -1, index = -1;
                for (i = lo + 1; i < hi; i++) {
                    var d = perpDist(base + i * 2, base + lo * 2, base + hi * 2);
                    if (d > dmax) { dmax = d; index = i; }
                }
                if (dmax > epsilon) {
                    keep[index] = 1;
                    loStack[sp] = index; hiStack[sp] = hi; sp++;
                    loStack[sp] = lo; hiStack[sp] = index; sp++;
                }
            }
            var emitted = 0;
            for (i = 0; i < n; i++) {
                if (!keep[i]) continue;
                out.push(srcXY[base + i * 2]);
                out.push(srcXY[base + i * 2 + 1]);
                emitted++;
            }
            offsets.push(out.n / 2);
            pathCount++;
        }

        return {
            offsets: offsets.a.slice(0, offsets.n),
            xy: out.a.slice(0, out.n),
            radius: new Float32Array(out.n / 2),
            widths: new Float32Array(pathCount),
            count: pathCount
        };
    }

    function dropShortPaths(geometry, minPoints) {
        var g = geometry;
        var out = new GrowF(4096);
        var offsets = new GrowI(256);
        offsets.push(0);
        var pathCount = 0;
        for (var p = 0; p < g.count; p++) {
            var a = g.offsets[p], b = g.offsets[p + 1];
            if (b - a < minPoints) continue;
            for (var i = a; i < b; i++) {
                out.push(g.xy[i * 2]); out.push(g.xy[i * 2 + 1]);
            }
            offsets.push(out.n / 2);
            pathCount++;
        }
        return {
            offsets: offsets.a.slice(0, offsets.n),
            xy: out.a.slice(0, out.n),
            radius: new Float32Array(out.n / 2),
            widths: new Float32Array(pathCount),
            count: pathCount
        };
    }

    // ─── Corner-aware Catmull-Rom smoothing ───

    function smooth(geometry, segments, tension, cornerAngle) {
        var g = geometry;
        if (!g.count) return emptyGeometry();
        segments = segments || 4;
        tension = (tension == null) ? 0.5 : tension;
        cornerAngle = (cornerAngle == null) ? 30 : cornerAngle;
        var cornerRad = cornerAngle * Math.PI / 180;
        var srcOff = g.offsets, srcXY = g.xy;
        var maxN = 0;
        for (var p0 = 0; p0 < g.count; p0++) {
            var l0 = srcOff[p0 + 1] - srcOff[p0];
            if (l0 > maxN) maxN = l0;
        }
        var splits = new Int32Array((maxN || 1) + 1);

        var out = new GrowF(8192);
        var offsets = new GrowI(256);
        offsets.push(0);
        var pathCount = 0;
        var p, i, n, base;

        function px(k) { return srcXY[base + k * 2]; }
        function py(k) { return srcXY[base + k * 2 + 1]; }

        function emitSpline(start, end, skipFirst) {
            var run = end - start + 1;
            if (run < 2) {
                for (var q = start; q <= end; q++) { out.push(px(q)); out.push(py(q)); }
                return;
            }
            var lastSeg = run - 2;
            var lastX = 0, lastY = 0, have = false;
            for (var si = 0; si < lastSeg + 1; si++) {
                var ax = si <= 0 ? px(start) : px(start + si - 1);
                var ay = si <= 0 ? py(start) : py(start + si - 1);
                var bx = px(start + si), by = py(start + si);
                var cx = px(start + si + 1), cy = py(start + si + 1);
                var dx = (si + 2 >= run) ? px(end) : px(start + si + 2);
                var dy = (si + 2 >= run) ? py(end) : py(start + si + 2);
                for (var t = 0; t < segments; t++) {
                    var s = (si === lastSeg && t === segments - 1) ? 1 : t / segments;
                    var t2 = s * s, t3 = t2 * s;
                    var v0 = (cx - ax) * tension, v1 = (dx - bx) * tension;
                    var ox = (2 * bx - 2 * cx + v0 + v1) * t3 + (-3 * bx + 3 * cx - 2 * v0 - v1) * t2 + v0 * s + bx;
                    var u0 = (cy - ay) * tension, u1 = (dy - by) * tension;
                    var oy = (2 * by - 2 * cy + u0 + u1) * t3 + (-3 * by + 3 * cy - 2 * u0 - u1) * t2 + u0 * s + by;
                    lastX = ox; lastY = oy; have = true;
                    if (!(skipFirst && si === 0 && t === 0)) { out.push(ox); out.push(oy); }
                }
            }
            if (have && (lastX !== px(end) || lastY !== py(end))) {
                out.push(px(end)); out.push(py(end));
            }
        }

        for (p = 0; p < g.count; p++) {
            n = srcOff[p + 1] - srcOff[p];
            base = srcOff[p] * 2;
            if (n < 3) {
                for (i = 0; i < n; i++) { out.push(srcXY[base + i * 2]); out.push(srcXY[base + i * 2 + 1]); }
                offsets.push(out.n / 2);
                pathCount++;
                continue;
            }
            var ns = 0;
            splits[ns++] = 0;
            for (i = 1; i < n - 1; i++) {
                var v1x = px(i) - px(i - 1), v1y = py(i) - py(i - 1);
                var v2x = px(i + 1) - px(i), v2y = py(i + 1) - py(i);
                var m1 = Math.sqrt(v1x * v1x + v1y * v1y);
                var m2 = Math.sqrt(v2x * v2x + v2y * v2y);
                if (m1 < 1e-6 || m2 < 1e-6) continue;
                var dot = (v1x * v2x + v1y * v2y) / (m1 * m2);
                var ang = Math.acos(Math.max(-1, Math.min(1, dot)));
                if (ang > cornerRad) splits[ns++] = i;
            }
            splits[ns++] = n - 1;
            for (var sIdx = 0; sIdx < ns - 1; sIdx++) {
                var start = splits[sIdx], end = splits[sIdx + 1];
                if (end - start < 2) {
                    for (var q = start; q <= end; q++) { out.push(px(q)); out.push(py(q)); }
                } else {
                    emitSpline(start, end, sIdx > 0);
                }
            }
            offsets.push(out.n / 2);
            pathCount++;
        }

        return {
            offsets: offsets.a.slice(0, offsets.n),
            xy: out.a.slice(0, out.n),
            radius: new Float32Array(out.n / 2),
            widths: new Float32Array(pathCount),
            count: pathCount
        };
    }

    // ─── Deterministic deformations ───

    function deform(geometry, opts) {
        var g = geometry;
        if (!g || !g.count) return g;
        var glitch = !!(opts && opts.glitch);
        var fractal = !!(opts && opts.fractal);
        if (!glitch && !fractal) return g;
        var seed = (opts.seed >>> 0) || DEFAULT_SEED;

        if (glitch) {
            var gXY = new Float32Array(g.xy.length);
            gXY.set(g.xy);
            for (var p = 0; p < g.count; p++) {
                var a = g.offsets[p], b = g.offsets[p + 1];
                var len = b - a;
                if (len < 5) continue;
                var rng = mulberry32((seed ^ Math.imul(p + 1, 0x9E3779B1)) >>> 0);
                var interval = 4 + Math.floor(rng() * 6);
                for (var i = 1; i < len; i++) {
                    if (i % interval === 0) {
                        var off = (rng() - 0.5) * 8;
                        gXY[(a + i) * 2] += off;
                    }
                }
            }
            g = {
                offsets: g.offsets, xy: gXY, radius: g.radius,
                widths: g.widths, count: g.count
            };
        }

        if (fractal) {
            var out = new GrowF(8192);
            var offsets = new GrowI(256);
            offsets.push(0);
            var pathCount = 0;
            for (var q = 0; q < g.count; q++) {
                var s = g.offsets[q], e = g.offsets[q + 1];
                if (e - s < 2) {
                    for (var k = s; k < e; k++) { out.push(g.xy[k * 2]); out.push(g.xy[k * 2 + 1]); }
                    offsets.push(out.n / 2);
                    pathCount++;
                    continue;
                }
                for (var j = s; j < e - 1; j++) {
                    var ax = g.xy[j * 2], ay = g.xy[j * 2 + 1];
                    var bx = g.xy[j * 2 + 2], by = g.xy[j * 2 + 3];
                    out.push(ax); out.push(ay);
                    var dx = bx - ax, dy = by - ay;
                    var dlen = Math.sqrt(dx * dx + dy * dy);
                    if (dlen > 8) {
                        out.push((ax + bx) / 2 - dy * 0.15);
                        out.push((ay + by) / 2 + dx * 0.15);
                    }
                }
                out.push(g.xy[(e - 1) * 2]); out.push(g.xy[(e - 1) * 2 + 1]);
                offsets.push(out.n / 2);
                pathCount++;
            }
            g = {
                offsets: offsets.a.slice(0, offsets.n),
                xy: out.a.slice(0, out.n),
                radius: new Float32Array(out.n / 2),
                widths: new Float32Array(pathCount),
                count: pathCount
            };
        }
        return g;
    }

    // ─── Per-path widths (single source for canvas and SVG) ───

    function widths(geometry, gray, gradMag, width, baseWidth, variable) {
        var g = geometry;
        var out = new Float32Array(g.count);
        if (!variable || !gray) {
            out.fill(baseWidth);
            return out;
        }
        var height = (gray.length / width) | 0;
        for (var p = 0; p < g.count; p++) {
            var a = g.offsets[p], b = g.offsets[p + 1];
            var sum = 0, gsum = 0, n = 0;
            for (var i = a; i < b; i++) {
                if (g.radius[i] > 0) continue;
                var x = Math.floor(g.xy[i * 2]), y = Math.floor(g.xy[i * 2 + 1]);
                if (x < 0 || x >= width || y < 0 || y >= height) continue;
                var idx = y * width + x;
                sum += gray[idx];
                if (gradMag) gsum += gradMag[idx];
                n++;
            }
            if (n === 0) { out[p] = baseWidth; continue; }
            var brightness = sum / n;
            var w = baseWidth * (0.5 + (1 - brightness));
            if (gradMag) {
                var gradT = Math.min(1, (gsum / n) / 0.35);
                w *= (1 - gradT * 0.35);
            }
            out[p] = Math.max(0.05, w);
        }
        return out;
    }

    function attachWidths(geometry, gray, gradMag, width, baseWidth, variable) {
        geometry.widths = widths(geometry, gray, gradMag, width, baseWidth, variable);
        return geometry;
    }

    function pointCount(geometry) {
        return geometry.count ? geometry.offsets[geometry.count] : 0;
    }

    function geometryLength(geometry) {
        var total = 0;
        for (var p = 0; p < geometry.count; p++) {
            var a = geometry.offsets[p], b = geometry.offsets[p + 1];
            for (var i = a + 1; i < b; i++) {
                var dx = geometry.xy[i * 2] - geometry.xy[(i - 1) * 2];
                var dy = geometry.xy[i * 2 + 1] - geometry.xy[(i - 1) * 2 + 1];
                total += Math.sqrt(dx * dx + dy * dy);
            }
        }
        return total;
    }

    // ─── Streamlines ───

    function hashNoise(x, y) {
        var h = (Math.floor(x) * 374761393 + Math.floor(y) * 668265263) | 0;
        h = ((h ^ (h >>> 13)) * 1274126177) | 0;
        return ((h ^ (h >>> 16)) / 2147483647);
    }
    function smoothNoise(x, y) {
        var ix = Math.floor(x), iy = Math.floor(y);
        var fx = x - ix, fy = y - iy;
        var sx = fx * fx * (3 - 2 * fx);
        var sy = fy * fy * (3 - 2 * fy);
        var v00 = hashNoise(ix, iy), v10 = hashNoise(ix + 1, iy);
        var v01 = hashNoise(ix, iy + 1), v11 = hashNoise(ix + 1, iy + 1);
        return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v11 - v01 - v10 + v00) * sx * sy;
    }

    async function streamlines(solution, gray, width, height, params, hooks, seed) {
        seed = (seed >>> 0) || DEFAULT_SEED;
        var rng = mulberry32(seed);
        var interval = params.interval || 8;
        var threshold = (params.threshold != null ? params.threshold : 50) / 100;
        var grad = fieldGradient(solution, width, height);
        var gradX = grad.gx, gradY = grad.gy;

        var usable = 0, gradCount = 0;
        for (var i = 0; i < solution.length; i++) {
            if (gray[i] >= threshold) continue;
            gradCount++;
            if (grad.mag[i] > 0.001) usable++;
        }
        if (gradCount === 0 || usable / Math.max(1, gradCount) < 0.5) {
            var img = sobel(gray, width, height, true);
            gradX = img.gradX; gradY = img.gradY;
        }

        var seedSpacing = interval;
        var seedsX = new GrowF(1024), seedsY = new GrowF(1024);
        for (var y = seedSpacing; y < height - seedSpacing; y += seedSpacing) {
            for (var x = seedSpacing; x < width - seedSpacing; x += seedSpacing) {
                var idx = Math.floor(y) * width + Math.floor(x);
                if (gray[idx] < threshold) {
                    seedsX.push(x + (rng() - 0.5) * seedSpacing * 0.5);
                    seedsY.push(y + (rng() - 0.5) * seedSpacing * 0.5);
                }
            }
        }
        var seedCount = seedsX.n;
        for (var si = seedCount - 1; si > 0; si--) {
            var sj = Math.floor(rng() * (si + 1));
            var tx = seedsX.a[si]; seedsX.a[si] = seedsX.a[sj]; seedsX.a[sj] = tx;
            var ty = seedsY.a[si]; seedsY.a[si] = seedsY.a[sj]; seedsY.a[sj] = ty;
        }

        var stepSize = 2.0, maxPathPoints = 500, minPathLength = 10;
        var separation = interval * 0.8;
        var occGridSize = Math.max(4, Math.floor(separation));
        var occWidth = Math.ceil(width / occGridSize);
        var occHeight = Math.ceil(height / occGridSize);
        var occGrid = new Uint8Array(occWidth * occHeight);

        function isOccupied(ox, oy) {
            var gx = Math.floor(ox / occGridSize), gy = Math.floor(oy / occGridSize);
            if (gx < 0 || gx >= occWidth || gy < 0 || gy >= occHeight) return true;
            return occGrid[gy * occWidth + gx] === 1;
        }
        function markOccupied(ox, oy) {
            var gx = Math.floor(ox / occGridSize), gy = Math.floor(oy / occGridSize);
            if (gx >= 0 && gx < occWidth && gy >= 0 && gy < occHeight) occGrid[gy * occWidth + gx] = 1;
        }

        var out = new GrowF(16384);
        var offsets = new GrowI(512);
        offsets.push(0);
        var pathCount = 0;
        var fwd = new GrowF(1024), bwd = new GrowF(1024);
        var curlStrength = 1.2, curlFreq = 0.04;

        for (var q = 0; q < seedCount; q++) {
            if (q % 500 === 0) {
                report(hooks, 0.62 + 0.28 * (q / Math.max(1, seedCount)), 'Tracing streamlines');
                await tick(hooks);
            }
            var sx = seedsX.a[q], sy = seedsY.a[q];
            if (isOccupied(sx, sy)) continue;
            markOccupied(sx, sy);
            fwd.n = 0; bwd.n = 0;

            for (var dir = 0; dir < 2; dir++) {
                var direction = dir === 0 ? 1 : -1;
                var cx = sx, cy = sy;
                var target = dir === 0 ? fwd : bwd;
                for (var step = 0; step < maxPathPoints; step++) {
                    var ix = Math.floor(cx), iy = Math.floor(cy);
                    if (ix < 1 || ix >= width - 1 || iy < 1 || iy >= height - 1) break;
                    var pidx = iy * width + ix;
                    var g1x = gradX[pidx], g1y = gradY[pidx];
                    var mag1 = Math.sqrt(g1x * g1x + g1y * g1y);
                    if (mag1 < 0.001) break;
                    var n1 = smoothNoise(cx * curlFreq, cy * curlFreq);
                    var k1x = (g1x / mag1) * stepSize * direction + (-g1y / mag1) * n1 * curlStrength;
                    var k1y = (g1y / mag1) * stepSize * direction + (g1x / mag1) * n1 * curlStrength;
                    var midX = cx + k1x * 0.5, midY = cy + k1y * 0.5;
                    var g2x = 0, g2y = 0;
                    var gx2 = Math.floor(midX), gy2 = Math.floor(midY);
                    if (gx2 < 1 || gx2 >= width - 1 || gy2 < 1 || gy2 >= height - 1) break;
                    var pidx2 = gy2 * width + gx2;
                    g2x = gradX[pidx2]; g2y = gradY[pidx2];
                    var mag2 = Math.sqrt(g2x * g2x + g2y * g2y);
                    if (mag2 < 0.001) break;
                    var n2 = smoothNoise(midX * curlFreq, midY * curlFreq);
                    var k2x = (g2x / mag2) * stepSize * direction + (-g2y / mag2) * n2 * curlStrength;
                    var k2y = (g2y / mag2) * stepSize * direction + (g2x / mag2) * n2 * curlStrength;
                    var nx = cx + k2x, ny = cy + k2y;
                    var cgx = Math.floor(cx / occGridSize), cgy = Math.floor(cy / occGridSize);
                    var tgx = Math.floor(nx / occGridSize), tgy = Math.floor(ny / occGridSize);
                    if ((tgx !== cgx || tgy !== cgy) && isOccupied(nx, ny)) break;
                    target.push(nx); target.push(ny);
                    markOccupied(nx, ny);
                    cx = nx; cy = ny;
                }
            }

            if ((fwd.n / 2 + bwd.n / 2 + 1) * stepSize >= minPathLength) {
                for (var bi = bwd.n - 2; bi >= 0; bi -= 2) { out.push(bwd.a[bi]); out.push(bwd.a[bi + 1]); }
                out.push(sx); out.push(sy);
                for (var fi = 0; fi < fwd.n; fi++) out.push(fwd.a[fi]);
                offsets.push(out.n / 2);
                pathCount++;
            }
        }

        var geom = {
            offsets: offsets.a.slice(0, offsets.n),
            xy: out.a.slice(0, out.n),
            radius: new Float32Array(out.n / 2),
            widths: new Float32Array(pathCount),
            count: pathCount
        };
        geom = dropShortPaths(simplify(geom, 0.8), 2);
        if ((params.contourSmoothness || 0) > 0.1) geom = smooth(geom, 4, 0.5, 180);
        return geom;
    }

    // ─── Stipple ───

    async function stipple(gray, width, height, params, hooks, seed) {
        seed = (seed >>> 0) || DEFAULT_SEED;
        var rng = mulberry32(seed);
        var interval = params.interval || 8;
        var threshold = (params.threshold != null ? params.threshold : 50) / 100;
        var minRadius = 1.5, maxRadius = interval;
        var mask = new Uint8Array(width * height);
        var activePixels = 0;
        for (var i = 0; i < gray.length; i++) {
            if (gray[i] < threshold) { mask[i] = 1; activePixels++; }
        }
        var empty = emptyGeometry();
        if (activePixels === 0) return empty;

        function getRadius(x, y) {
            var idx = Math.floor(y) * width + Math.floor(x);
            var val = gray[idx];
            var gx = (x < width - 1) ? Math.abs(gray[idx] - gray[idx + 1]) : 0;
            var gy = (y < height - 1) ? Math.abs(gray[idx] - gray[idx + width]) : 0;
            var grad = Math.min(1, gx + gy);
            var r = minRadius + (maxRadius - minRadius) * Math.pow(1 - val, 0.6) * (1 - grad * 0.7);
            return Math.max(minRadius, Math.min(maxRadius, r));
        }

        var k = 20;
        var cellSize = maxRadius / Math.SQRT2;
        var gridWidth = Math.ceil(width / cellSize);
        var gridHeight = Math.ceil(height / cellSize);
        var grid = new Int32Array(gridWidth * gridHeight); grid.fill(-1);
        var pts = new GrowF(8192);
        var radii = new GrowF(4096);
        var active = new GrowI(4096);

        function insertPoint(x, y) {
            var pi = radii.n;
            pts.push(x); pts.push(y);
            radii.push(getRadius(x, y));
            var gx = Math.floor(x / cellSize), gy = Math.floor(y / cellSize);
            grid[gy * gridWidth + gx] = pi;
            active.push(pi);
        }

        var numSeeds = Math.min(10, Math.ceil(activePixels / 10000));
        for (var s = 0; s < numSeeds; s++) {
            for (var a = 0; a < 50; a++) {
                var rx = rng() * width, ry = rng() * height;
                if (mask[Math.floor(ry) * width + Math.floor(rx)]) { insertPoint(rx, ry); break; }
            }
        }
        if (radii.n === 0) insertPoint(width / 2, height / 2);

        var checkRange = Math.ceil(maxRadius / cellSize);
        while (active.n > 0) {
            var ai = Math.floor(rng() * active.n);
            var pIdx = active.a[ai];
            var px = pts.a[pIdx * 2], py = pts.a[pIdx * 2 + 1];
            var r = radii.a[pIdx];
            var found = false;
            for (var c = 0; c < k; c++) {
                var angle = rng() * Math.PI * 2;
                var dist = r + rng() * r;
                var nx = px + Math.cos(angle) * dist;
                var ny = py + Math.sin(angle) * dist;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                if (!mask[Math.floor(ny) * width + Math.floor(nx)]) continue;
                var nr = getRadius(nx, ny);
                var gx = Math.floor(nx / cellSize), gy = Math.floor(ny / cellSize);
                var tooClose = false;
                for (var dy = -checkRange; dy <= checkRange && !tooClose; dy++) {
                    for (var dx = -checkRange; dx <= checkRange; dx++) {
                        var ngx = gx + dx, ngy = gy + dy;
                        if (ngx < 0 || ngx >= gridWidth || ngy < 0 || ngy >= gridHeight) continue;
                        var neighborIdx = grid[ngy * gridWidth + ngx];
                        if (neighborIdx !== -1) {
                            var ddx = nx - pts.a[neighborIdx * 2], ddy = ny - pts.a[neighborIdx * 2 + 1];
                            var dSq = ddx * ddx + ddy * ddy;
                            var minDist = (nr + radii.a[neighborIdx]) / 2;
                            if (dSq < minDist * minDist) { tooClose = true; break; }
                        }
                    }
                }
                if (!tooClose) { insertPoint(nx, ny); found = true; break; }
            }
            if (!found) {
                active.n--;
                active.a[ai] = active.a[active.n];
            }
            if ((radii.n & 2047) === 0) {
                report(hooks, 0.62 + 0.28 * Math.min(1, radii.n / 40000), 'Stippling');
                await tick(hooks);
            }
            if (radii.n > 150000) break;
        }

        var count = radii.n;
        var offsets = new Int32Array(count + 1);
        for (var oi = 0; oi <= count; oi++) offsets[oi] = oi;
        var dotRadius = Math.max(0.5, (params.lineWidth || 1) * 1.2);
        var radius = new Float32Array(count);
        radius.fill(dotRadius);
        return {
            offsets: offsets,
            xy: pts.a.slice(0, pts.n),
            radius: radius,
            widths: new Float32Array(count),
            count: count
        };
    }

    // ─── TSP (nearest neighbour + 2-opt) ───

    async function tsp(gray, width, height, params, hooks, seed) {
        var st = await stipple(gray, width, height, params, hooks, seed);
        if (st.count < 2) return st;
        var MAX_TSP_POINTS = 4000;
        var count = st.count;
        var src = st.xy;
        var sampled = new Float32Array(MAX_TSP_POINTS * 2);
        if (count > MAX_TSP_POINTS) {
            var step = count / MAX_TSP_POINTS;
            for (var i = 0; i < MAX_TSP_POINTS; i++) {
                var idx = Math.floor(i * step);
                sampled[i * 2] = src[idx * 2];
                sampled[i * 2 + 1] = src[idx * 2 + 1];
            }
            count = MAX_TSP_POINTS;
        } else {
            sampled.set(src.subarray(0, count * 2));
        }

        var cellSize = 30;
        var gridWidth = Math.ceil(width / cellSize);
        var gridHeight = Math.ceil(height / cellSize);
        var cellCount = gridWidth * gridHeight;
        var counts = new Int32Array(cellCount);
        var gx, gy, ci, p;
        for (p = 0; p < count; p++) {
            gx = Math.floor(sampled[p * 2] / cellSize);
            gy = Math.floor(sampled[p * 2 + 1] / cellSize);
            counts[gy * gridWidth + gx]++;
        }
        var cellOffsets = new Int32Array(cellCount + 1);
        for (ci = 0; ci < cellCount; ci++) cellOffsets[ci + 1] = cellOffsets[ci] + counts[ci];
        var fill = cellOffsets.slice(0, cellCount);
        var cellItems = new Int32Array(count);
        for (p = 0; p < count; p++) {
            gx = Math.floor(sampled[p * 2] / cellSize);
            gy = Math.floor(sampled[p * 2 + 1] / cellSize);
            cellItems[fill[gy * gridWidth + gx]++] = p;
        }

        var bestIdx = 0, bestDist = -1;
        var ccx = width / 2, ccy = height / 2;
        var scan = Math.min(count, 100);
        for (var s = 0; s < scan; s++) {
            var md = Math.abs(sampled[s * 2] - ccx) + Math.abs(sampled[s * 2 + 1] - ccy);
            if (md > bestDist) { bestDist = md; bestIdx = s; }
        }

        var used = new Uint8Array(count);
        var order = new Int32Array(count);
        order[0] = bestIdx;
        used[bestIdx] = 1;
        var current = bestIdx;
        var remaining = count - 1;

        while (remaining > 0) {
            if (remaining % 500 === 0) {
                report(hooks, 0.9 + 0.1 * (1 - remaining / count), 'Connecting TSP points');
                await tick(hooks);
            }
            var cpx = sampled[current * 2], cpy = sampled[current * 2 + 1];
            var nearest = -1, minD = Infinity;
            gx = Math.floor(cpx / cellSize); gy = Math.floor(cpy / cellSize);
            var maxR = Math.max(gridWidth, gridHeight);
            for (var sr = 0; sr < maxR; sr++) {
                var hit = false;
                for (var dy = -sr; dy <= sr; dy++) {
                    for (var dx = -sr; dx <= sr; dx++) {
                        if (sr > 0 && Math.abs(dx) !== sr && Math.abs(dy) !== sr) continue;
                        var ngx = gx + dx, ngy = gy + dy;
                        if (ngx < 0 || ngx >= gridWidth || ngy < 0 || ngy >= gridHeight) continue;
                        var cellIdx = ngy * gridWidth + ngx;
                        for (var q = cellOffsets[cellIdx]; q < cellOffsets[cellIdx + 1]; q++) {
                            var pIdx = cellItems[q];
                            if (used[pIdx]) continue;
                            var ddx = cpx - sampled[pIdx * 2], ddy = cpy - sampled[pIdx * 2 + 1];
                            var dSq = ddx * ddx + ddy * ddy;
                            if (dSq < minD) { minD = dSq; nearest = pIdx; }
                            hit = true;
                        }
                    }
                }
                if (hit) break;
            }
            if (nearest === -1) break;
            order[count - remaining] = nearest;
            used[nearest] = 1;
            current = nearest;
            remaining--;
        }

        var orderedCount = count - remaining;
        var oxy = new Float32Array(orderedCount * 2);
        for (var oi = 0; oi < orderedCount; oi++) {
            oxy[oi * 2] = sampled[order[oi] * 2];
            oxy[oi * 2 + 1] = sampled[order[oi] * 2 + 1];
        }

        if (orderedCount >= 4) {
            var maxPasses = Math.max(5, Math.min(20, Math.floor(100000 / orderedCount)));
            var improved = true;
            while (improved && maxPasses-- > 0) {
                improved = false;
                for (var ii = 0; ii < orderedCount - 2; ii++) {
                    var ax = oxy[ii * 2], ay = oxy[ii * 2 + 1];
                    var bx = oxy[(ii + 1) * 2], by = oxy[(ii + 1) * 2 + 1];
                    for (var jj = ii + 2; jj < orderedCount - 1; jj++) {
                        var cx2 = oxy[jj * 2], cy2 = oxy[jj * 2 + 1];
                        var dx2 = oxy[(jj + 1) * 2], dy2 = oxy[(jj + 1) * 2 + 1];
                        var d1 = (ax - bx) * (ax - bx) + (ay - by) * (ay - by) + (cx2 - dx2) * (cx2 - dx2) + (cy2 - dy2) * (cy2 - dy2);
                        var dSwap = (ax - cx2) * (ax - cx2) + (ay - cy2) * (ay - cy2) + (bx - dx2) * (bx - dx2) + (by - dy2) * (by - dy2);
                        if (dSwap < d1) {
                            var left = ii + 1, right = jj;
                            while (left < right) {
                                var tx = oxy[left * 2], ty = oxy[left * 2 + 1];
                                oxy[left * 2] = oxy[right * 2]; oxy[left * 2 + 1] = oxy[right * 2 + 1];
                                oxy[right * 2] = tx; oxy[right * 2 + 1] = ty;
                                left++; right--;
                            }
                            improved = true;
                            bx = oxy[(ii + 1) * 2]; by = oxy[(ii + 1) * 2 + 1];
                        }
                    }
                }
            }
        }

        var offsets = new Int32Array(2);
        offsets[1] = orderedCount;
        var geom = {
            offsets: offsets,
            xy: oxy,
            radius: new Float32Array(orderedCount),
            widths: new Float32Array(1),
            count: 1
        };
        geom = dropShortPaths(simplify(geom, 1.0), 2);
        geom = smooth(geom, 4, 0.5, 180);
        return geom;
    }

    // ─── Cross hatch ───

    function dominantAngle(gray, width, height) {
        var sumSin = 0, sumCos = 0, count = 0;
        for (var y = 1; y < height - 1; y++) {
            for (var x = 1; x < width - 1; x++) {
                var idx = y * width + x;
                var gx = gray[idx + 1] - gray[idx - 1];
                var gy = gray[idx + width] - gray[idx - width];
                var mag = gx * gx + gy * gy;
                if (mag > 0.01) {
                    var angle = Math.atan2(gy, gx);
                    sumSin += Math.sin(angle * 2) * mag;
                    sumCos += Math.cos(angle * 2) * mag;
                    count++;
                }
            }
        }
        if (count === 0) return -Math.PI / 4;
        return Math.atan2(sumSin, sumCos) / 2;
    }

    async function hatch(gray, width, height, params, hooks) {
        var interval = params.interval || 10;
        var threshold = (params.threshold != null ? params.threshold : 50) / 100;
        var dominant = dominantAngle(gray, width, height);
        var layers = [
            { angle: dominant + Math.PI / 4, t: threshold + 0.15 },
            { angle: dominant - Math.PI / 4, t: threshold },
            { angle: dominant, t: threshold - 0.2 },
            { angle: dominant + Math.PI / 2, t: threshold - 0.25 }
        ];
        var maxLength = Math.sqrt(width * width + height * height);
        var out = new GrowF(16384);
        var offsets = new GrowI(1024);
        offsets.push(0);
        var pathCount = 0;
        var cx = width / 2, cy = height / 2;

        for (var l = 0; l < layers.length; l++) {
            var angle = layers[l].angle;
            var layerThreshold = Math.max(0.1, layers[l].t);
            var hatchCheck = 0;
            for (var d = -maxLength; d < maxLength; d += interval) {
                var px = cx + d * Math.cos(angle + Math.PI / 2);
                var py = cy + d * Math.sin(angle + Math.PI / 2);
                var runCount = 0, startX = 0, startY = 0, endX = 0, endY = 0;
                var cosA = Math.cos(angle), sinA = Math.sin(angle);
                for (var t = -maxLength; t < maxLength; t += 2) {
                    var x = Math.floor(px + t * cosA);
                    var y = Math.floor(py + t * sinA);
                    var inside = x >= 0 && x < width && y >= 0 && y < height;
                    var dark = inside && gray[y * width + x] < layerThreshold;
                    if (dark) {
                        if (runCount === 0) { startX = x; startY = y; }
                        endX = x; endY = y;
                        runCount++;
                    } else if (runCount > 0) {
                        if (runCount > 5) {
                            out.push(startX); out.push(startY); out.push(endX); out.push(endY);
                            offsets.push(out.n / 2);
                            pathCount++;
                        }
                        runCount = 0;
                    }
                }
                if (runCount > 5) {
                    out.push(startX); out.push(startY); out.push(endX); out.push(endY);
                    offsets.push(out.n / 2);
                    pathCount++;
                }
                hatchCheck++;
                if (hatchCheck % 20 === 0) {
                    report(hooks, 0.62 + 0.28 * (l / layers.length), 'Hatching');
                    await tick(hooks);
                }
            }
        }

        return {
            offsets: offsets.a.slice(0, offsets.n),
            xy: out.a.slice(0, out.n),
            radius: new Float32Array(out.n / 2),
            widths: new Float32Array(pathCount),
            count: pathCount
        };
    }

    // ─── Shared pipeline ───

    async function generate(input) {
        input = input || {};
        var gray = input.gray;
        var width = input.width | 0, height = input.height | 0;
        if (!gray || gray.length !== width * height || width < 2 || height < 2) {
            throw new Error('generate: invalid image field');
        }
        var params = input.params || {};
        var hooks = input.hooks || {};
        var mode = input.mode || 'contours';
        var seed = (input.seed >>> 0) || DEFAULT_SEED;
        var threshold = (params.threshold != null ? params.threshold : 50) / 100;
        var gradMag = input.gradMag || null;
        var solution = input.solution || null;
        var edgeDistance = input.edgeDistance || null;
        var bounds = input.bounds || null;
        var debug = input.debug || null;

        report(hooks, 0.02, 'Extracting');
        if (!gradMag) {
            gradMag = sobel(gray, width, height, false).gradMag;
        }

        var geometry, raw = null, solutionOut = null, meta = null;

        if (mode === 'luminance') {
            var lumLevels = levelsLuminance(gray, width, height, params.interval || 8, threshold, gradMag);
            raw = marchSquares(gray, width, height, lumLevels, bounds);
            geometry = joinSegments(raw);
            geometry = dropShortPaths(simplify(geometry, 0.8), 2);
            if ((params.contourSmoothness || 0) > 0.1) {
                geometry = smooth(geometry, 1 + Math.round(4 * params.contourSmoothness), 0.3 + 0.4 * params.contourSmoothness, 30);
            }
        } else if (mode === 'contours' || mode === 'streamlines') {
            if (!solution) {
                report(hooks, 0.05, 'Solving Eikonal equation');
                solution = await fmm(gray, width, height, threshold, hooks);
                if (hooks && hooks.onSolution) hooks.onSolution(solution);
            }
            if (mode === 'streamlines') {
                geometry = await streamlines(solution, gray, width, height, params, hooks, seed);
            } else {
                var field = solution;
                if (params.edgeGuidance !== false && !edgeDistance) {
                    var mask = new Uint8Array(gray.length);
                    for (var mi = 0; mi < mask.length; mi++) mask[mi] = gradMag[mi] > 0.12 ? 1 : 0;
                    edgeDistance = chamfer(mask, width, height);
                    if (hooks && hooks.onEdgeDistance) hooks.onEdgeDistance(edgeDistance);
                }
                var useEdge = params.edgeGuidance !== false && edgeDistance;
                if (useEdge) {
                    field = edgeWarp(solution, edgeDistance, width, height, params.edgeSensitivity != null ? params.edgeSensitivity : 0.7);
                }
                var rngField = finiteRange(field);
                var levels = levelsAdaptive(field, width, height, params.interval || 8, rngField.min, rngField.max, gradMag, params.detailLevel, params.featureImportance);
                raw = marchSquares(field, width, height, levels, bounds);
                geometry = joinSegments(raw);
                geometry = dropShortPaths(simplify(geometry, 0.8), 2);
                if ((params.contourSmoothness || 0) > 0.1) {
                    geometry = smooth(geometry, 1 + Math.round(4 * params.contourSmoothness), 0.3 + 0.4 * params.contourSmoothness, 30);
                }
            }
        } else if (mode === 'stipple') {
            geometry = await stipple(gray, width, height, params, hooks, seed);
        } else if (mode === 'tsp') {
            geometry = await tsp(gray, width, height, params, hooks, seed);
        } else if (mode === 'hatch') {
            geometry = await hatch(gray, width, height, params, hooks);
        } else if (mode === 'subject-wire') {
            var wire = await SubjectWire.generate({
                gray: gray,
                gradMag: gradMag,
                width: width,
                height: height,
                options: params,
                hooks: hooks,
                seed: seed
            });
            geometry = wire.geometry;
            meta = wire.meta || null;
        } else {
            throw new Error('Unknown mode: ' + mode);
        }

        if (mode !== 'stipple') {
            geometry = deform(geometry, {
                glitch: params.glitchEffect,
                fractal: params.fractalEffect,
                seed: seed
            });
        }
        attachWidths(geometry, gray, gradMag, width, params.lineWidth != null ? params.lineWidth : 1, !!params.variableWidth);

        var result = {
            mode: mode,
            width: width,
            height: height,
            geometry: geometry,
            meta: meta
        };

        if (debug) {
            if (debug.origins) {
                var origins = new GrowF(1024);
                for (var oi = 0; oi < gray.length; oi++) {
                    if (gray[oi] < threshold) {
                        origins.push(oi % width);
                        origins.push((oi / width) | 0);
                    }
                }
                result.origins = origins.a.slice(0, origins.n);
            }
            if (debug.raw && raw) result.raw = raw;
            if (debug.gray) result.gray = gray;
            if (debug.solution) result.solution = solution || null;
        }

        report(hooks, 1, 'Complete');
        return result;
    }

    return {
        preprocess: preprocess,
        sobel: sobel,
        chamfer: chamfer,
        fmm: fmm,
        edgeWarp: edgeWarp,
        levelsLuminance: levelsLuminance,
        levelsAdaptive: levelsAdaptive,
        fieldGradient: fieldGradient,
        marchSquares: marchSquares,
        joinSegments: joinSegments,
        simplify: simplify,
        smooth: smooth,
        dropShortPaths: dropShortPaths,
        deform: deform,
        widths: widths,
        streamlines: streamlines,
        stipple: stipple,
        tsp: tsp,
        hatch: hatch,
        generate: generate,
        geometryLength: geometryLength,
        pointCount: pointCount
    };
})();
