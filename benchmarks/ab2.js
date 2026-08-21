// A/B benchmark v2: full pipeline (preprocess -> eikonal -> levels -> edgeWarp
// -> march -> join/simplify/smooth), interleaved rounds to cancel contention.
// Usage: node benchmarks/ab2.js [baselinePath] [candidatePath] [rounds]
'use strict';
const fs = require('fs');
const path = require('path');

function loadEngine(file) {
    const src = fs.readFileSync(file, 'utf8');
    const g = {};
    return new Function('window', 'globalThis', src + '\n;return Engine;')({}, g);
}

function generateSyntheticField(width, height) {
    const gray = new Float32Array(width * height);
    const cx = width * 0.62, cy = height * 0.4;
    const cx2 = width * 0.25, cy2 = height * 0.72;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let v = (x / width) * 0.55 + (y / height) * 0.35;
            const d1 = Math.hypot(x - cx, y - cy) / (width * 0.18);
            v -= 0.45 * Math.exp(-d1 * d1);
            const d2 = Math.hypot(x - cx2, y - cy2) / (width * 0.10);
            v -= 0.30 * Math.exp(-d2 * d2);
            const dr = Math.abs(Math.hypot(x - cx, y - cy) - width * 0.28);
            v -= 0.25 * Math.exp(-(dr * dr) / 120);
            v += 0.04 * Math.sin(x * 0.11) * Math.cos(y * 0.13)
               + 0.02 * Math.sin((x * 7 + y * 3) * 0.031);
            gray[y * width + x] = Math.max(0, Math.min(1, v));
        }
    }
    return gray;
}

const ROOT = path.join(__dirname, '..');
const baseFile = process.argv[2] || '/tmp/engine_baseline.js';
const candFile = process.argv[3] || path.join(ROOT, 'js', 'engine.js');
const ROUNDS = parseInt(process.argv[4] || '11', 10);

const E0 = loadEngine(baseFile);
const E1 = loadEngine(candFile);
const W = 800, H = 600;
const gray0 = generateSyntheticField(W, H);
const P = {
    threshold: 0.5, interval: 3, detailLevel: 0.8,
    featureImportance: 0.6, epsilon: 0.8, smoothness: 0.5,
    blurRadius: 2, contrast: 1.15, edgeGuidance: true,
    edgeSensitivity: 0.6, edgeMaskThreshold: 0.35
};

// Precompute RGBA once (identical for both variants)
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
    const g = Math.round(gray0[i] * 255);
    rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
}

function pipeline(E) {
    const t = {};
    let t0 = performance.now();
    const gray = E.preprocessCPU({ data: rgba, width: W, height: H }, { blurRadius: P.blurRadius, contrast: P.contrast });
    t.prep = performance.now() - t0;

    t0 = performance.now();
    const sol = E.solveEikonalFMM(gray, W, H, P.threshold);
    t.eik = performance.now() - t0;

    t0 = performance.now();
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < sol.length; i++) { const v = sol[i]; if (v < min) min = v; if (v > max) max = v; }
    const grad = E.sobelGradientCPU(gray, W, H);
    const levels = E.generateAdaptiveLevelsGrad(sol, W, H, P.interval, min, max, grad.gradMag, P.detailLevel, P.featureImportance);
    t.lvl = performance.now() - t0;

    t0 = performance.now();
    let field = sol;
    if (P.edgeGuidance) {
        const mask = new Uint8Array(W * H);
        for (let i = 0; i < mask.length; i++) mask[i] = grad.gradMag[i] > P.edgeMaskThreshold ? 1 : 0;
        const ed = E.distanceTransformChamfer(mask, W, H);
        field = E.applyEdgeWarp(sol, ed, W, H, P.edgeSensitivity);
    }
    t.warp = performance.now() - t0;

    t0 = performance.now();
    const raw = E.marchSquaresField(field, W, H, levels);
    t.march = performance.now() - t0;

    t0 = performance.now();
    let joined = E.joinSegments(raw);
    joined = joined.map(p => E.simplifyPath(p, P.epsilon)).filter(p => p.length > 1);
    const segments = 1 + Math.round(4 * P.smoothness);
    const tension = 0.3 + 0.4 * P.smoothness;
    joined = joined.map(p => E.smoothPathCornerAware(p, segments, tension, 30));
    t.join = performance.now() - t0;
    return { paths: joined, t };
}

// warmup
for (let i = 0; i < 2; i++) { pipeline(E0); pipeline(E1); }

const acc = () => ({ prep: [], eik: [], lvl: [], warp: [], march: [], join: [], total: [] });
const A0 = acc(), A1 = acc();
let last0 = null, last1 = null;
for (let r = 0; r < ROUNDS; r++) {
    last0 = pipeline(E0);
    for (const k in last0.t) A0[k].push(last0.t[k]);
    A0.total.push(Object.values(last0.t).reduce((a, b) => a + b, 0));
    last1 = pipeline(E1);
    for (const k in last1.t) A1[k].push(last1.t[k]);
    A1.total.push(Object.values(last1.t).reduce((a, b) => a + b, 0));
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const identical = JSON.stringify(last0.paths) === JSON.stringify(last1.paths);
const sum = ps => { let s = 0; for (const p of ps) for (const pt of p) s += pt.x + pt.y; return s; };
const dSum = Math.abs(sum(last1.paths) - sum(last0.paths));
const nPaths = [last0.paths.length, last1.paths.length];

console.log(`stage          baseline   candidate  speedup`);
for (const k of ['prep', 'eik', 'lvl', 'warp', 'march', 'join', 'total']) {
    const m0 = med(A0[k]), m1 = med(A1[k]);
    console.log(`${k.padEnd(14)} ${m0.toFixed(2).padStart(8)}ms ${m1.toFixed(2).padStart(8)}ms ${(m0 / m1).toFixed(2)}x`);
}
console.log(`output: identical=${identical} coordSumDelta=${dSum.toPrecision(6)} paths=${nPaths[0]}->${nPaths[1]}`);
