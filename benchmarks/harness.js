// Benchmark harness for the Marching Waves CPU pipeline (headless Node).
// Usage: node benchmarks/harness.js [--snapshot] [--json]
//
// Loads the same classic scripts the page loads (engine, subject-wire, render),
// generates a synthetic image, times the contour pipeline per stage, checks
// determinism and quality, exercises every mode, and compares against
// benchmarks/snapshot.json. Pass --snapshot to deliberately re-baseline.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadScript(file) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    (0, eval)(src);
}
loadScript('js/engine.js');
loadScript('js/subject-wire.js');
loadScript('js/render.js');
const Engine = global.Engine;
const Render = global.Render;

// ── Synthetic test image: gradient + shapes ────────────────────────────────
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

// ── Flat geometry metrics ──────────────────────────────────────────────────
function checksum(g) {
    let s = 0;
    for (let i = 0; i < g.xy.length; i++) {
        s = (s * 31 + Math.round(g.xy[i] * 100) * 73856093) >>> 0;
    }
    return s >>> 0;
}
function coordSum(g) {
    let s = 0;
    for (let i = 0; i < g.xy.length; i++) s += g.xy[i];
    return s;
}
function hasBadCoords(g) {
    for (let i = 0; i < g.xy.length; i++) if (!isFinite(g.xy[i])) return true;
    return false;
}
function countClosedLoops(g) {
    let n = 0;
    for (let p = 0; p < g.count; p++) {
        const a = g.offsets[p], b = g.offsets[p + 1];
        if (b - a > 3) {
            const dx = g.xy[a * 2] - g.xy[(b - 1) * 2];
            const dy = g.xy[a * 2 + 1] - g.xy[(b - 1) * 2 + 1];
            if (Math.hypot(dx, dy) < 1.5) n++;
        }
    }
    return n;
}
function qualityOf(g) {
    return {
        pathCount: g.count,
        points: Engine.pointCount(g),
        closedLoops: countClosedLoops(g),
        totalLength: Number(Engine.geometryLength(g).toFixed(2)),
        badCoords: hasBadCoords(g),
        coordSum: Number(coordSum(g).toFixed(3))
    };
}

// ── Pipeline stages ─────────────────────────────────────────────────────────
async function runPipeline(gray0, width, height, params) {
    const t = {};
    let t0 = performance.now();

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const g = Math.round(gray0[i] * 255);
        rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
    }
    const gray = Engine.preprocess(
        { data: rgba, width, height },
        { blurRadius: params.blurRadius, contrast: params.contrast });
    t.preprocess = performance.now() - t0;

    t0 = performance.now();
    const solution = await Engine.fmm(gray, width, height, params.threshold);
    t.eikonal = performance.now() - t0;

    t0 = performance.now();
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < solution.length; i++) {
        const v = solution[i];
        if (!isFinite(v) || v >= 1e8) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const grad = Engine.sobel(gray, width, height, false);
    const levels = Engine.levelsAdaptive(
        solution, width, height, params.interval, min, max, grad.gradMag,
        params.detailLevel, params.featureImportance);
    t.levels = performance.now() - t0;

    t0 = performance.now();
    let field = solution;
    if (params.edgeGuidance) {
        const mask = new Uint8Array(width * height);
        for (let i = 0; i < mask.length; i++) mask[i] = grad.gradMag[i] > params.edgeMaskThreshold ? 1 : 0;
        const edgeDistance = Engine.chamfer(mask, width, height);
        field = Engine.edgeWarp(solution, edgeDistance, width, height, params.edgeSensitivity);
    }
    t.edgeWarp = performance.now() - t0;

    t0 = performance.now();
    const raw = Engine.marchSquares(field, width, height, levels);
    t.march = performance.now() - t0;

    t0 = performance.now();
    let geometry = Engine.joinSegments(raw);
    geometry = Engine.dropShortPaths(Engine.simplify(geometry, params.epsilon), 2);
    const segments = 1 + Math.round(4 * params.smoothness);
    const tension = 0.3 + 0.4 * params.smoothness;
    geometry = Engine.smooth(geometry, segments, tension, 30);
    t.joinSimplifySmooth = performance.now() - t0;

    return { geometry, timings: t, levels: levels.length, rawSegments: raw.count };
}

// ── All-mode check ──────────────────────────────────────────────────────────
async function checkModes(gray, width, height, params) {
    const modes = ['luminance', 'contours', 'streamlines', 'stipple', 'tsp', 'hatch', 'subject-wire'];
    const results = [];
    for (const mode of modes) {
        const options = {
            interval: 12, lineWidth: 1, threshold: 50,
            edgeGuidance: false, edgeSensitivity: 0.6,
            detailLevel: 0.8, contourSmoothness: 0.5, featureImportance: 0.6,
            subjectFocus: 0.72, wireDensity: 0.38, wireTension: 0.74,
            relationshipStrength: 0.58, abstraction: 0.82, handDrawn: 0.28,
            variableWidth: false, glitchEffect: false, fractalEffect: false
        };
        const a = await Engine.generate({ gray, width, height, mode, params: options, seed: 12345 });
        const b = await Engine.generate({ gray, width, height, mode, params: options, seed: 12345 });
        const art = { mode, width, height, geometry: a.geometry };
        const svg = Render.buildSVG(art, { lineColor: '#000000', lineWidth: 1, whiteBackground: false, inkBleed: 0 });
        results.push({
            mode,
            paths: a.geometry.count,
            points: Engine.pointCount(a.geometry),
            finite: !hasBadCoords(a.geometry),
            deterministic: checksum(a.geometry) === checksum(b.geometry),
            svgBytes: svg.length,
            svgHasScript: svg.indexOf('<script') >= 0
        });
    }
    return results;
}

const PARAMS = {
    threshold: 0.5, interval: 3, detailLevel: 0.8,
    featureImportance: 0.6, epsilon: 0.8, smoothness: 0.5,
    blurRadius: 2, contrast: 1.15, edgeGuidance: true,
    edgeSensitivity: 0.6, edgeMaskThreshold: 0.35
};
const WIDTH = 800, HEIGHT = 600;
const RUNS = 5;

async function main() {
    const makeSnapshot = process.argv.includes('--snapshot');
    const asJson = process.argv.includes('--json');
    const snapPath = path.join(__dirname, 'snapshot.json');

    const gray = generateSyntheticField(WIDTH, HEIGHT);

    await runPipeline(gray, WIDTH, HEIGHT, PARAMS);

    const runs = [];
    for (let r = 0; r < RUNS; r++) {
        const res = await runPipeline(gray, WIDTH, HEIGHT, PARAMS);
        const total = Object.values(res.timings).reduce((a, b) => a + b, 0);
        runs.push({ ...res, totalMs: total });
    }
    const best = runs.reduce((a, b) => (b.totalMs < a.totalMs ? b : a));

    const det = [];
    let detSvg = null;
    for (let d = 0; d < 2; d++) {
        const res = await runPipeline(gray, WIDTH, HEIGHT, PARAMS);
        det.push(checksum(res.geometry));
        const svg = Render.buildSVG({ mode: 'contours', width: WIDTH, height: HEIGHT, geometry: res.geometry },
            { lineColor: '#000000', lineWidth: 1, whiteBackground: false, inkBleed: 0 });
        if (d === 0) detSvg = svg;
        else if (svg !== detSvg) det.push(-1);
    }
    const checksumDelta = det[0] === det[1] ? 0 : 1;

    const quality = qualityOf(best.geometry);

    let snapshotStatus = 'none';
    let snapDelta = null;
    if (fs.existsSync(snapPath)) {
        const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
        const dl = Math.abs(quality.totalLength - snap.quality.totalLength) / snap.quality.totalLength;
        const dp = Math.abs(quality.pathCount - snap.quality.pathCount) / Math.max(1, snap.quality.pathCount);
        const dc = Math.abs(quality.coordSum - snap.quality.coordSum) / Math.max(1e-9, Math.abs(snap.quality.coordSum));
        snapDelta = { lengthRel: dl, pathCountRel: dp, coordSumRel: dc };
        const TOL = 0.05;
        snapshotStatus = (dl < TOL && dp < TOL && dc < TOL && !quality.badCoords) ? 'within-tolerance' : 'DIVERGED';
    }

    const modes = await checkModes(gray, WIDTH, HEIGHT, PARAMS);

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
        determinism: { checksumDelta, svgStable: det.length === 2 },
        modes,
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
        console.log(`determinism: checksumDelta=${checksumDelta} svgStable=${result.determinism.svgStable}`);
        console.log('modes   : ' + modes.map(m => `${m.mode}(${m.paths}p/${m.points}pt${m.deterministic ? '' : ' NONDET'}${m.finite ? '' : ' BAD'})`).join(' '));
        console.log(`snapshot: ${snapshotStatus}${snapDelta ? ' ' + JSON.stringify(snapDelta) : ''}`);
    }
    const modesOk = modes.every(m => m.finite && m.deterministic && !m.svgHasScript);
    process.exit(result.snapshot.status === 'DIVERGED' || !modesOk ? 2 : 0);
}

main();
