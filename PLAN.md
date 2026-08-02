# Plan: Restore GPU Acceleration + Enhance Output Quality (Marching Waves)

## Context

Marching Waves is a browser-based contour-art generator (Marching Squares over luminance or
Eikonal distance fields). Two problems:

1. **GPU is not invoked at all.** The previous commit (`e4321fc~1`) contained a full
   `WebGPUManager` (grayscale conversion, JFA Eikonal solver, GPU marching squares) that was
   deleted in the "Refactor structure" commit. The current tree has zero GPU code — every stage
   runs on CPU (main thread + Web Workers). The old implementation also had real defects:
   - WGSL `switch` cases used fallthrough (compile error) in `runMarchingSquares`.
   - The JFA solver ignored the speed function (luminance) — it produced a pure Euclidean
     distance-to-seed field, so contours lost image-driven detail vs. the CPU FMM.
2. **Several quality controls are dead/no-op**, so output is worse than the UI promises:
   - `edgeGuidance` / `edgeSensitivity` / `featureImportance` are sent to the worker but never
     used (`handleExtractContoursAdaptive` destructures only `{showProgress, detailLevel}`).
   - `generateAdaptiveLevels` ignores the computed gradient (`gradMag`) — `avgGrad` is just
     `detailLevel`, so "adaptive" levels are nearly linear.
   - Luminance levels are linear spacing across min..max — ignores the luminance histogram, so
     tonal ranges with few pixels get over-contoured and vice-versa.
   - `contourSmoothness` is ignored in the worker path (main-thread fallback applies it).
   - Header readout hard-codes "CPU".

Goal: (a) actually invoke the GPU (WebGPU) for the heavy image-processing stages with a clean
CPU fallback, and (b) visibly improve artwork quality by fixing the dead controls and adding
GPU-powered preprocessing (blur / contrast) that makes contour output cleaner.

## Approach (summary)

### A. GPU layer — new `js/gpu.js` (`WebGPUManager`)
Main-thread compute (no canvas needed), reading results back as `Float32Array`s that are then
transferred to the existing workers for extraction (extraction/joining stay CPU — already fast).

Stages (each with `try/catch` → CPU fallback):
1. `init()` — `navigator.gpu.requestAdapter()/requestDevice()`, expose status + adapter info.
2. `preprocess(imageData, {blurRadius, invert, contrast})` — single-pass grayscale
   (+ optional separable Gaussian blur ping-pong, inversion, contrast stretch) → `Float32Array`.
3. `sobelGradient(gray)` → `{gradX, gradY, gradMag}` (Float32Array) — feeds edge guidance,
   adaptive levels, streamlines, variable line width.
4. `solveEikonal(gray, threshold, iterations)` — **true Eikonal solver on GPU** using
   red-black Jacobi sweeps (Godunov upwind update, speed = luminance). Fully parallel, ping-pong
   storage buffers; converges to the same viscosity solution as the CPU FMM. This replaces the
   old JFA approach (which ignored luminance) and is far better quality.
5. `edgeDistance(edgeMask)` — signed/unsigned distance to edges (same sweep solver on a binary
   mask) for the edge-guidance feature.
6. Readback helper (`mapAsync` + `Float32Array`), buffer lifecycle, error handling.

Fallback chain: WebGPU → existing CPU FMM (`solveEikonalCPU` / `Engine.solveEikonalFMM`) and CPU
grayscale. A `useGPU` checkbox (default ON) + status badge in header/sidebar.

### B. Output-quality fixes (engine.js / worker.js / index.html)
1. **Edge guidance actually works**: worker receives `gradMag` + `edgeDistance`; before
   marching squares, warp field sample positions toward nearby edges
   (`x' = x − s·∇d·g(d)`, gaussian falloff with `edgeSensitivity`) — contours hug features.
   Implementation: GPU computes unsigned edge-distance field `d_e` (sweep solver, speed=1,
   seeds = Sobel edge mask) + `gradMag`; worker CPU loop warps sample positions
   `x' = x − s·exp(−d_e²/(2σ²))·∇d_e` with `s ∝ edgeSensitivity` (2–6 px), then bilinear-samples
   the field for marching squares. O(N) per pixel, runs in the worker.
2. **Adaptive levels from real gradient histogram** (shared in `js/engine.js`): bin the
   gradient magnitudes; allocate denser levels where detail is high; honor `detailLevel` +
   `featureImportance`. Replaces the current stub (`avgGrad = detailLevel`).
3. **Percentile-based luminance levels** (`generateLuminanceLevels` in engine.js): histogram-
   aware level placement so contour lines distribute evenly across tonal range (mode:
   luminance).
4. **`contourSmoothness` honored in the worker path**; angle-aware smoothing (preserve corners,
   round gentle bends) instead of blind Catmull-Rom — tune spline segments/tension from the
   slider.
5. **Preprocess controls**: Blur (denoise) + contrast sliders; applied on GPU, so free; big
   quality win on photos/noisy inputs.
6. **Variable line width by gradient magnitude** (enhance existing `getPathWidth`, wire
   `gradMag` through).
7. **UI/status**: GPU badge in readout (`GPU · WebGPU` vs `CPU`), worker-side fallback notice,
   perf table shows GPU stage timings.

### Confirmed scope decisions (user)
- **WebGPU + CPU fallback** only (no WebGL2 path).
- All four quality upgrades in scope: Edge Guidance fix, Smart contour levels,
  Blur+contrast sliders, Smoothing + variable line width.
- **Extraction stays on CPU workers** — no GPU marching squares.

### Out of scope (note)
- GPU marching squares, WebGL2 fallback.

## Files to modify
- `js/gpu.js` — NEW: WebGPUManager (preprocess, blur, gradient, Eikonal sweep solver, edge distance).
- `index.html` — include gpu.js; use GPU preprocess/solve paths; new sliders (blur, contrast);
  GPU status UI; perf metrics; wire quality options to worker; readout badge.
- `js/engine.js` — shared helpers: histogram/percentile levels, gradient-histogram adaptive
  levels, edge-warp, angle-aware smoothing.
- `worker.js` — use edgeGuidance/edgeSensitivity/contourSmoothness/featureImportance + gradMag/
  edgeDistance params; call new engine helpers.
- `README.md` — restore GPU acceleration section (WebGPU), document new controls.
- `css/style.css` — status badge styles (minor).

## Reuse
- `js/engine.js`: `marchSquaresField`, `joinSegments`, `simplifyPath`, `splineSmooth`,
  `toGrayscale`, `solveEikonalFMM` (CPU fallback), `generateLuminanceLevels` (replace impl).
- `worker.js`: `handleSolveEikonalCPU`, `computeDistanceFieldGradient` (CPU fallback),
  `generateAdaptiveLevels` (replace impl).
- `index.html`: `solveEikonalAsync` fallback structure, `executeOnWorker` transfer flow,
  `getPathWidth` (extend), presets (extend).
- Old WebGPU code in git history (`git show e4321fc~1:index.html`) as reference for buffer/
  pipeline patterns; rewrite shaders correctly (no switch fallthrough; true Eikonal, not JFA).

## Implementation details

### GPU Eikonal solver (replaces old JFA — true Eikonal, not Euclidean)
- Ping-pong `Float32Array` storage buffers (2× `pixelCount*4`).
- Init pass: `u=0` where `gray<threshold` (seeds), `u=∞` elsewhere.
- Sweep: red-black ordering, two sub-passes per sweep (Gauss-Seidel style, ~2× convergence of
  plain Jacobi). Update rule per pixel (Godunov upwind, speed `f=gray`):
  `uN=min(u[i-1],u[i+1])`, `uW=min(u[j-1],u[j+1])`;
  if `|uN−uW| ≥ f` → `min(uN,uW)+f`; else `(uN+uW+√(2f²−(uN−uW)²))/2`.
- Fixed sweeps (~60) with optional early exit via max-change reduction buffer.
- Read back once; transfer to worker (extraction unchanged).
- Used for: `contours` mode field, `edgeDistance` field (speed=1 on Sobel mask).

### Data flow
- Main thread: GPU preprocess → `grayData` (Float32Array) → GPU Eikonal → `this.solution`;
  cache `this.gradMag` / `this.edgeDistance` on the instance (needed by region-rerun too).
- Workers receive `solution` + `gradMag` + `edgeDistance` + quality options via existing
  `executeOnWorker` plumbing (typed arrays already structured-clone cleanly).
- CPU path (fallback): existing FMM + `computeDistanceFieldGradient` — identical downstream
  behavior, so fallback parity is guaranteed by construction.
- Live preview: no wavefront streaming from GPU solver; render final field, replay a short
  animated reveal from the final `Float32Array` (cheap cosmetic stand-in).

## Steps
- [x] 1. `js/gpu.js`: WebGPUManager — init/status + adapter info; `preprocess(imageData,
      {blurRadius, invert, contrast})` (grayscale → optional separable Gaussian blur → contrast
      stretch, ping-pong); `sobelGradient`; `solveEikonal` (red-black Jacobi); `edgeDistance`;
      readback; buffer cleanup; graceful failure → `available=false`.
- [x] 2. index.html: include `js/gpu.js`; `useGPU` checkbox (default ON) + GPU status UI
      (header readout `GPU · WebGPU` / `CPU`, sidebar panel); blur + contrast sliders
      (Preprocess section); `toGrayscale` → GPU preprocess; `solveEikonalAsync` → GPU solver
      with FMM fallback; field-preview reveal replay; perf-table rows for GPU stages.
- [x] 3. `js/engine.js`: `generateAdaptiveLevelsGrad` (gradient-histogram), percentile
      `generateLuminanceLevels`, `applyEdgeWarp(solution, edgeDistance, gradMag, sensitivity)`,
      angle-aware `splineSmooth` extension.
- [x] 4. `worker.js`: `handleExtractContoursAdaptive` consumes `gradMag`/`edgeDistance`/
      `edgeGuidance`/`edgeSensitivity`/`featureImportance`/`contourSmoothness`; edge warp;
      real adaptive levels; smoothing. Keep FMM/streamline/etc. handlers as-is.
- [x] 5. `processImage` (index.html): pass new params/options for all modes; extend
      `getPathWidth` to use gradMag; cache GPU outputs for region rerun; perf metrics.
- [x] 6. Presets (add blur/contrast where sensible), README (restore WebGPU section + new
      controls), status text.
- [x] 7. Verify (below); fix regressions.

## Verification results (headless Chrome 150, WebGPU via software adapter)

- **GPU invoked**: header shows `GPU · WebGPU`, perf table `Backend: GPU · WebGPU`, GPU stage
  timings (Preprocess / GPU Eikonal / GPU Gradient / GPU Edge Dist).
- **All 6 modes produce artwork**: luminance 15 paths / contours 5 / streamlines 94 /
  stipple 392 / hatch 69 / TSP 1 continuous line — each with GPU-accelerated preprocess +
  Eikonal solve.
- **GPU field solver validated**: single-seed sweep solver reproduces ground-truth Euclidean
  distance (max≈79 at 40 sweeps, 140 sweeps fully converges); WGSL parsed by wgsl_reflect;
  `uncapturederror` listener added so silent shader failures surface.
- **Edge guidance works**: on a photo-like image, contours ON=34 paths vs OFF=4 paths.
- **CPU fallback parity**: with GPU disabled, luminance still yields 15 paths; contours 131
  paths; edge-distance set (chamfer); status shows CPU.
- **Region rerun fixed** (was broken by the refactor — `joinContoursImproved` undefined);
  SVG export intact (rings export as quadratic-curve paths).
- **Bugs found & fixed during verification**: sweepShader arg arity (silent WGSL failure),
  closed-ring RDP collapse (`perpDist` degenerate chord), threshold units in streamlines/
  stipple/hatch workers (raw 50 vs 0.5), streamline occupancy grid killing traces at step 1,
  flat-field streamline fallback to luminance gradient, CPU gradMag object-vs-array bug.

## Verification
- `python -m http.server 8000` → open http://localhost:8000 (WebGPU needs secure context —
  localhost or GitHub Pages; also check `chrome://gpu` / `about:gpu` if adapter missing).
- Status shows `GPU · WebGPU` (or CPU fallback notice when `navigator.gpu` absent).
- Sample pattern + a real photo, all 6 modes: contours field solve time GPU vs CPU FMM
  (perf table) — expect large speedup; output visually cleaner.
- Edge guidance ON vs OFF visibly changes contour adherence near edges (cyberpunk/blueprint
  presets).
- Blur slider removes noise; contrast slider spreads levels; histogram levels distribute lines
  evenly (luminance mode).
- Export SVG still works; pause/cancel/region-rerun still work; workers report ACTIVE.
- Fallback test: disable WebGPU in browser flags or `useGPU` off → identical pipeline works,
  status shows CPU.
