// A/B benchmark: loads baseline engine (git HEAD copy) and candidate engine,
// alternates timed runs in one process to cancel machine-contention bias.
// Usage: node benchmarks/ab.js [baselinePath] [candidatePath] [rounds]
'use strict';
const fs = require('fs');
const path = require('path');

function loadEngine(file) {
    const src = fs.readFileSync(file, 'utf8');
    const sandbox = {};
    const fn = new Function('globalThis', src + '\nreturn globalThis.Engine;');
    // isolate per-variant Engine via fresh Function scope on a temp global
    const g = {};
    const Engine = new Function('window', 'globalThis', src + '\n;return Engine;')({}, g);
    return Engine;
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
const ROUNDS = parseInt(process.argv[4] || '9', 10);

const E0 = loadEngine(baseFile);
const E1 = loadEngine(candFile);
const W = 480, H = 360;
const gray = generateSyntheticField(W, H);
const PARAMS = { threshold: 0.5, interval: 6, detailLevel: 0.7, featureImportance: 0.6, epsilon: 0.8, smoothness: 0.5 };

function eikonalOnly(E) {
    const t0 = performance.now();
    E.solveEikonalFMM(gray, W, H, PARAMS.threshold);
    return performance.now() - t0;
}

// warmup both
for (let i = 0; i < 2; i++) { eikonalOnly(E0); eikonalOnly(E1); }

const t0s = [], t1s = [];
let checksumEqual = null;
for (let r = 0; r < ROUNDS; r++) {
    t0s.push(eikonalOnly(E0));
    t1s.push(eikonalOnly(E1));
}
// full-pipeline equivalence check
function fullPipeline(E) {
    const sol = E.solveEikonalFMM(gray, W, H, PARAMS.threshold);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < sol.length; i++) { if (sol[i] < min) min = sol[i]; if (sol[i] > max) max = sol[i]; }
    const grad = E.sobelGradientCPU(gray, W, H);
    const levels = E.generateAdaptiveLevelsGrad(sol, W, H, PARAMS.interval, min, max, grad.gradMag, PARAMS.detailLevel, PARAMS.featureImportance);
    const raw = E.marchSquaresField(sol, W, H, levels);
    let joined = E.joinSegments(raw);
    joined = joined.map(p => E.simplifyPath(p, PARAMS.epsilon)).filter(p => p.length > 1);
    const segments = 1 + Math.round(4 * PARAMS.smoothness);
    const tension = 0.3 + 0.4 * PARAMS.smoothness;
    return joined.map(p => E.smoothPathCornerAware(p, segments, tension, 30));
}
const p0 = fullPipeline(E0), p1 = fullPipeline(E1);
const sum = ps => { let s = 0; for (const p of ps) for (const pt of p) s += pt.x + pt.y; return s; };
const identical = JSON.stringify(p0) === JSON.stringify(p1);
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`eikonal A/B (${ROUNDS} rounds, median): baseline=${med(t0s).toFixed(2)}ms candidate=${med(t1s).toFixed(2)}ms  speedup=${(med(t0s) / med(t1s)).toFixed(2)}x  outputIdentical=${identical}  coordSumDelta=${Math.abs(sum(p1) - sum(p0)).toFixed(6)}`);
