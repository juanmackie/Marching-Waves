// A/B benchmark: loads a baseline Engine file and a candidate Engine file,
// alternates timed runs in one process to cancel machine-contention bias.
// Usage: node benchmarks/ab.js [baselineEngine.js] [candidateEngine.js] [rounds] [mode]
'use strict';
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

function loadEngine(file) {
    if (!fs.existsSync(file)) throw new Error(`engine file not found: ${file}`);
    const src = fs.readFileSync(file, 'utf8');
    const g = {};
    const Engine = new Function('window', 'globalThis', 'self', src + '\n;return globalThis.Engine || Engine;')({}, g, g);
    if (!Engine || typeof Engine.generate !== 'function') throw new Error(`no Engine.generate in ${file}`);
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

function geomStats(geom) {
    let sum = 0;
    const o = geom.offsets || [];
    const p = geom.points || new Float32Array(0);
    const n = o.length ? o[o.length - 1] : Math.floor(p.length / 2);
    for (let i = 0; i < n * 2; i++) sum += p[i] || 0;
    return { paths: geom.pathCount || 0, points: n, sum };
}

const ROOT = path.join(__dirname, '..');
const baseFile = process.argv[2] || path.join(ROOT, 'benchmarks', 'engine_baseline.js');
const candFile = process.argv[3] || path.join(ROOT, 'js', 'engine.js');
const ROUNDS = parseInt(process.argv[4] || '9', 10);
const mode = process.argv[5] || 'contours';

const E0 = loadEngine(baseFile);
const E1 = loadEngine(candFile);
const W = 480, H = 360;
const gray = generateSyntheticField(W, H);
const PARAMS = {
    threshold: 0.5, interval: 6, detailLevel: 0.7, featureImportance: 0.6,
    epsilon: 0.8, smoothness: 0.5, edgeGuidance: true, edgeSensitivity: 0.6,
    edgeMaskThreshold: 0.35, flowSpacing: 10, stepSize: 1.5, maxSteps: 400,
    minPathLength: 8, flowLineWidth: 1.0, stippleDensity: 4, stippleRadius: 1.8,
    seed: 1, hatchSpacing: 6, hatchAngle: 45, hatchCross: true,
    edgeSubjectIsolation: false
};

function runOnce(E) {
    const t0 = performance.now();
    const geom = E.generate(mode, { data: gray }, W, H, PARAMS);
    return { ms: performance.now() - t0, geom };
}

// warmup
for (let i = 0; i < 2; i++) { runOnce(E0); runOnce(E1); }

const t0s = [], t1s = [];
let g0, g1;
for (let r = 0; r < ROUNDS; r++) {
    const a = runOnce(E0); t0s.push(a.ms); g0 = a.geom;
    const b = runOnce(E1); t1s.push(b.ms); g1 = b.geom;
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const s0 = geomStats(g0), s1 = geomStats(g1);
console.log(`${mode} A/B (${ROUNDS} rounds, median): baseline=${med(t0s).toFixed(2)}ms candidate=${med(t1s).toFixed(2)}ms speedup=${(med(t0s) / med(t1s)).toFixed(2)}x`);
console.log(`output: paths=${s0.paths}->${s1.paths} points=${s0.points}->${s1.points} coordSumDelta=${Math.abs(s1.sum - s0.sum).toFixed(6)}`);
