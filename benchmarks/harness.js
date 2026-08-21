// Benchmark harness for Marching-Waves CPU pipeline (headless Node).
// Usage: node benchmarks/harness.js [--snapshot] [--json]
//
// Loads js/engine.js (browser IIFE) into a VM sandbox, generates a synthetic
// test image, runs the full CPU contour pipeline end-to-end plus per-stage
// timings, checks determinism + quality, and compares against a reference
// snapshot (benchmarks/snapshot.json). Pass --snapshot to (re)create baseline.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── Load Engine ─────────────────────────────────────────────────────────────
// Eval in the main realm: a vm sandbox context deoptimizes typed-array access
// across realms (~30x slower). engine.js is a self-contained IIFE assigning
// global Engine, so direct eval is safe and fast.
function loadEngine() {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'engine.js'), 'utf8');
    (0, eval)(src);
    return global.Engine;
}
const Engine = loadEngine();

// ── Synthetic test image: gradient + shapes ────────────────────────────────
function generateSyntheticField(width, height) {
    const gray = new Float32Array(width * height);
    const cx = width * 0.62, cy = height * 0.4;
    const cx2 = width * 0.25, cy2 = height * 0.72;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // diagonal gradient base
            let v = (x / width) * 0.55 + (y / height) * 0.35;
            // radial blob (dark seed region for Eikonal)
            const d1 = Math.hypot(x - cx, y - cy) / (width * 0.18);
            v -= 0.45 * Math.exp(-d1 * d1);
            // second smaller blob
            const d2 = Math.hypot(x - cx2, y - cy2) / (width * 0.10);
            v -= 0.30 * Math.exp(-d2 * d2);
            // ring shape
            const dr = Math.abs(Math.hypot(x - cx, y - cy) - width * 0.28);
            v -= 0.25 * Math.exp(-(dr * dr) / 120);
            // deterministic noise texture
            v += 0.04 * Math.sin(x * 0.11) * Math.cos(y * 0.13)
               + 0.02 * Math.sin((x * 7 + y * 3) * 0.031);
            gray[y * width + x] = Math.max(0, Math.min(1, v));
        }
    }
    return gray;
}

// ── Quality metrics ─────────────────────────────────────────────────────────
function checksum(paths) {
    // coordinate checksum: quantized sum of all point coords (stable float mix)
    let s = 0;
    for (const p of paths) {
        for (const pt of p) {
            s = (s * 31 + Math.round(pt.x * 100) * 73856093 + Math.round(pt.y * 100) * 19349663) >>> 0;
        }
    }
    return s >>> 0;
}
function coordSum(paths) {
    let s = 0;
    for (const p of paths) for (const pt of p) s += pt.x + pt.y;
    return s;
}
function hasBadCoords(paths) {
    for (const p of paths) for (const pt of p) {
        if (!isFinite(pt.x) || !isFinite(pt.y)) return true;
    }
    return false;
}
function countClosedLoops(paths) {
    let n = 0;
    for (const p of paths) {
        if (p.length > 3) {
            const a = p[0], b = p[p.length - 1];
            if (Math.hypot(a.x - b.x, a.y - b.y) < 1.5) n++;
        }
    }
    return n;
}
function totalLength(paths) {
    let len = 0;
    for (const p of paths) len += Engine.getPathLength(p);
    return len;
}

// ── Pipeline stages ─────────────────────────────────────────────────────────
function runPipeline(gray0, width, height, params) {
    const t = {};
    let t0 = performance.now();

    // Stage 0: field generation — synthetic RGBA -> luminance + blur (as in app)
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const g = Math.round(gray0[i] * 255);
        rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
    }
    const gray = Engine.preprocessCPU(
        { data: rgba, width, height },
        { blurRadius: params.blurRadius, contrast: params.contrast });
    t.preprocess = performance.now() - t0;

    t0 = performance.now();
    // Stage 1: Eikonal distance field (CPU FMM)
    const solution = Engine.solveEikonalFMM(gray, width, height, params.threshold);
    t.eikonal = performance.now() - t0;

    t0 = performance.now();
    // Stage 2: adaptive level selection from field histogram
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < solution.length; i++) {
        const v = solution[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const grad = Engine.sobelGradientCPU(gray, width, height);
    const levels = Engine.generateAdaptiveLevelsGrad(
        solution, width, height, params.interval, min, max, grad.gradMag,
        params.detailLevel, params.featureImportance);
    t.levels = performance.now() - t0;

    t0 = performance.now();
    // Stage 2b: edge guidance pre-pass (default-on in worker):
    // chamfer distance to strong-gradient pixels, then warp field toward edges.
    let field = solution;
    if (params.edgeGuidance) {
        const mask = new Uint8Array(width * height);
        for (let i = 0; i < mask.length; i++) mask[i] = grad.gradMag[i] > params.edgeMaskThreshold ? 1 : 0;
        const edgeDistance = Engine.distanceTransformChamfer(mask, width, height);
        field = Engine.applyEdgeWarp(solution, edgeDistance, width, height, params.edgeSensitivity);
    }
    t.edgeWarp = performance.now() - t0;

    t0 = performance.now();
    // Stage 3: marching squares contour extraction
    const rawContours = Engine.marchSquaresField(field, width, height, levels);
    t.march = performance.now() - t0;

    t0 = performance.now();
    // Stage 4: join segments into paths + simplify + smooth
    let joined = Engine.joinSegments(rawContours);
    joined = joined.map(p => Engine.simplifyPath(p, params.epsilon)).filter(p => p.length > 1);
    const segments = 1 + Math.round(4 * params.smoothness);
    const tension = 0.3 + 0.4 * params.smoothness;
    joined = joined.map(p => Engine.smoothPathCornerAware(p, segments, tension, 30));
    t.joinSimplifySmooth = performance.now() - t0;

    return { paths: joined, timings: t, levels: levels.length };
}

// ── Main ────────────────────────────────────────────────────────────────────
const PARAMS = {
    threshold: 0.5, interval: 3, detailLevel: 0.8,
    featureImportance: 0.6, epsilon: 0.8, smoothness: 0.5,
    blurRadius: 2, contrast: 1.15, edgeGuidance: true,
    edgeSensitivity: 0.6, edgeMaskThreshold: 0.35
};
const WIDTH = 800, HEIGHT = 600;
const RUNS = 5; // timed runs; report best (machine may be under contention)

function median(a) { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; }

function main() {
    const makeSnapshot = process.argv.includes('--snapshot');
    const asJson = process.argv.includes('--json');
    const snapPath = path.join(__dirname, 'snapshot.json');

    const gray = generateSyntheticField(WIDTH, HEIGHT);

    // Warmup
    runPipeline(gray, WIDTH, HEIGHT, PARAMS);

    // Timed runs
    const runs = [];
    for (let r = 0; r < RUNS; r++) {
        const res = runPipeline(gray, WIDTH, HEIGHT, PARAMS);
        const total = Object.values(res.timings).reduce((a, b) => a + b, 0);
        runs.push({ ...res, totalMs: total });
    }
    const best = runs.reduce((a, b) => (b.totalMs < a.totalMs ? b : a));

    // Determinism: run twice more, compare checksums
    const det = [];
    for (let d = 0; d < 2; d++) {
        const res = runPipeline(gray, WIDTH, HEIGHT, PARAMS);
        det.push(checksum(res.paths));
    }
    const checksumDelta = det[0] === det[1] ? 0 : 1;

    // Quality metrics
    const paths = best.paths;
    const quality = {
        pathCount: paths.length,
        points: paths.reduce((s, p) => s + p.length, 0),
        closedLoops: countClosedLoops(paths),
        totalLength: Number(totalLength(paths).toFixed(2)),
        badCoords: hasBadCoords(paths),
        coordSum: Number(coordSum(paths).toFixed(3))
    };

    // Snapshot comparison
    let snapshotStatus = 'none';
    let snapDelta = null;
    if (fs.existsSync(snapPath)) {
        const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
        const dl = Math.abs(quality.totalLength - snap.quality.totalLength) / snap.quality.totalLength;
        const dp = Math.abs(quality.pathCount - snap.quality.pathCount) / Math.max(1, snap.quality.pathCount);
        const dc = Math.abs(quality.coordSum - snap.quality.coordSum) / Math.max(1e-9, Math.abs(snap.quality.coordSum));
        snapDelta = { lengthRel: dl, pathCountRel: dp, coordSumRel: dc };
        const TOL = 0.05; // 5% tolerance
        snapshotStatus = (dl < TOL && dp < TOL && dc < TOL && !quality.badCoords) ? 'within-tolerance' : 'DIVERGED';
    }

    const result = {
        runtime_ms: {
            total: Number(best.totalMs.toFixed(2)),
            preprocess: Number(best.timings.preprocess.toFixed(2)),
            eikonal: Number(best.timings.eikonal.toFixed(2)),
            levels: Number(best.timings.levels.toFixed(2)),
            edgeWarp: Number(best.timings.edgeWarp.toFixed(2)),
            march: Number(best.timings.march.toFixed(2)),
            joinSimplifySmooth: Number(best.timings.joinSimplifySmooth.toFixed(2))
        },
        quality,
        determinism: { checksumDelta },
        snapshot: snapDelta ? { status: snapshotStatus, delta: snapDelta } : { status: snapshotStatus },
        params: PARAMS, width: WIDTH, height: HEIGHT
    };

    if (makeSnapshot || !fs.existsSync(snapPath)) {
        fs.writeFileSync(snapPath, JSON.stringify({
            created: new Date().toISOString(),
            quality: quality, params: PARAMS, width: WIDTH, height: HEIGHT
        }, null, 2));
        result.snapshot = { status: 'created' };
    }

    if (asJson) {
        console.log(JSON.stringify(result));
    } else {
        console.log('=== Marching-Waves CPU benchmark ===');
        console.log(`image: ${WIDTH}x${HEIGHT} synthetic, ${RUNS} timed runs (best shown)`);
        console.log(`runtime : ${result.runtime_ms.total} ms total`);
        console.log(`  prep=${result.runtime_ms.preprocess} eikonal=${result.runtime_ms.eikonal} levels=${result.runtime_ms.levels} edgeWarp=${result.runtime_ms.edgeWarp} march=${result.runtime_ms.march} join/smooth=${result.runtime_ms.joinSimplifySmooth}`);
        console.log(`quality : paths=${quality.pathCount} pts=${quality.points} loops=${quality.closedLoops} len=${quality.totalLength} badCoords=${quality.badCoords}`);
        console.log(`determinism: checksumDelta=${checksumDelta}`);
        console.log(`snapshot: ${snapshotStatus}${snapDelta ? ' ' + JSON.stringify(snapDelta) : ''}`);
    }
    process.exit(result.snapshot.status === 'DIVERGED' ? 2 : 0);
}

main();
