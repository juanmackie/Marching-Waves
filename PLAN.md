# Plan: put back GPU acceleration and improve output quality (Marching Waves)

## Context

Marching Waves is a browser-based contour-art generator. It uses Marching Squares over luminance fields or Eikonal distance fields. Two problems exist:

1. **The GPU is not used.** The previous commit (`e4321fc~1`) had a full `WebGPUManager`. It had grayscale conversion, a JFA Eikonal solver, and GPU Marching Squares. The "Refactor structure" commit deleted it. The current tree has no GPU code. Every stage runs on CPU (main thread + Web Workers). The old implementation also had defects:
   - The WGSL `switch` cases used fallthrough in `runMarchingSquares`. This is a compile error.
   - The JFA solver ignored the speed function (luminance). It produced a pure Euclidean distance-to-seed field. The contours lost image-driven detail compared with the CPU FMM.
2. **Several quality controls do nothing.** Output is worse than the UI promises:
   - `edgeGuidance` / `edgeSensitivity` / `featureImportance` go to the worker. The code never uses them (`handleExtractContoursAdaptive` destructures only `{showProgress, detailLevel}`).
   - `generateAdaptiveLevels` ignores the computed gradient (`gradMag`). `avgGrad` is just `detailLevel`. The "adaptive" levels are nearly linear.
   - Luminance levels use linear spacing across min..max. They ignore the luminance histogram. Tonal ranges with few pixels get too many contours. Tonal ranges with many pixels get too few.
   - The worker path ignores `contourSmoothness`. The main-thread fallback applies it.
   - The header readout hard-codes "CPU".

Goal: (a) use the GPU (WebGPU) for the heavy image-processing stages, with a clean CPU fallback. (b) Improve the artwork quality. Fix the dead controls. Add GPU-powered preprocessing (blur / contrast) for cleaner contour output.

## Method (summary)

### A. GPU layer — new `js/gpu.js` (`WebGPUManager`)

Main-thread compute (no canvas needed). Read the results back as `Float32Array`s. Transfer them to the existing workers for extraction. Extraction and joining stay on CPU. They are already fast.

Stages (each stage has a `try/catch` → CPU fallback):

1. `init()` — `navigator.gpu.requestAdapter()/requestDevice()`. Expose the status and adapter info.
2. `preprocess(imageData, {blurRadius, invert, contrast})` — single-pass grayscale (+ optional separable Gaussian blur ping-pong, inversion, contrast stretch) → `Float32Array`.
3. `sobelGradient(gray)` → `{gradX, gradY, gradMag}` (Float32Array). It feeds edge guidance, adaptive levels, streamlines, and variable line width.
4. `solveEikonal(gray, threshold, iterations)` — **true Eikonal solver on GPU**. It uses red-black Jacobi sweeps (Godunov upwind update, speed = luminance). It is fully parallel with ping-pong storage buffers. It converges to the same viscosity solution as the CPU FMM. This replaces the old JFA approach (which ignored luminance). The quality is much better.
5. `edgeDistance(edgeMask)` — signed/unsigned distance to edges (same sweep solver on a binary mask) for the edge-guidance characteristic.
6. Readback helper (`mapAsync` + `Float32Array`), buffer lifecycle, error handling.

Fallback chain: WebGPU → existing CPU FMM (`solveEikonalCPU` / `Engine.solveEikonalFMM`) and CPU grayscale. Add a `useGPU` checkbox (default ON) and a status badge in the header/sidebar.

### B. Output-quality fixes (engine.js / worker.js / index.html)

1. **Edge guidance works**: the worker receives `gradMag` + `edgeDistance`. Before Marching Squares, it warps the sample positions toward nearby edges (`x' = x − s·∇d·g(d)`, gaussian falloff with `edgeSensitivity`). The contours hug the characteristics. Implementation: the GPU computes the unsigned edge-distance field `d_e` (sweep solver, speed=1, seeds = Sobel edge mask) + `gradMag`. The worker CPU loop warps the sample positions `x' = x − s·exp(−d_e²/(2σ²))·∇d_e` with `s ∝ edgeSensitivity` (2–6 px). Then it bilinear-samples the field for Marching Squares. O(N) per pixel. It runs in the worker.
2. **Adaptive levels from a real gradient histogram** (shared in `js/engine.js`): bin the gradient magnitudes. Allocate denser levels where the detail is high. Apply `detailLevel` + `featureImportance`. This replaces the current stub (`avgGrad = detailLevel`).
3. **Percentile-based luminance levels** (`generateLuminanceLevels` in engine.js): histogram-aware level placement. The contour lines distribute evenly across the tonal range (mode: luminance).
4. **`contourSmoothness` works in the worker path**: angle-aware smoothing. Keep the corners. Round the gentle bends. Do not use blind Catmull-Rom. Tune the spline segments/tension from the slider.
5. **Preprocess controls**: blur (denoise) + contrast sliders. They run on the GPU, so they are free. They give a big quality win on photos/noisy inputs.
6. **Variable line width by gradient magnitude**: improve the existing `getPathWidth`. Wire `gradMag` through it.
7. **UI/status**: a GPU badge in the readout (`GPU · WebGPU` vs `CPU`), a worker-side fallback notice, and a perf table that shows the GPU stage timings.

### Scope decisions (user)

- WebGPU + CPU fallback only (no WebGL2 path).
- All four quality upgrades are in scope: edge guidance fix, smart contour levels, blur + contrast sliders, smoothing + variable line width.
- Extraction stays on CPU workers — no GPU Marching Squares.

### Out of scope (note)

- GPU Marching Squares, WebGL2 fallback.

## Files to modify

- `js/gpu.js` — NEW: WebGPUManager (preprocess, blur, gradient, Eikonal sweep solver, edge distance).
- `index.html` — include gpu.js. Use the GPU preprocess/solve paths. Add sliders (blur, contrast). Add the GPU status UI and perf metrics. Wire the quality options to the worker. Add the readout badge.
- `js/engine.js` — shared helpers: histogram/percentile levels, gradient-histogram adaptive levels, edge-warp, angle-aware smoothing.
- `worker.js` — use the `edgeGuidance`/`edgeSensitivity`/`contourSmoothness`/`featureImportance` and `gradMag`/`edgeDistance` params. Call the new engine helpers.
- `README.md` — put back the GPU acceleration section (WebGPU). Document the new controls.
- `css/style.css` — status badge styles (minor).

## Reuse

- `js/engine.js`: `marchSquaresField`, `joinSegments`, `simplifyPath`, `splineSmooth`, `toGrayscale`, `solveEikonalFMM` (CPU fallback), `generateLuminanceLevels` (replace impl).
- `worker.js`: `handleSolveEikonalCPU`, `computeDistanceFieldGradient` (CPU fallback), `generateAdaptiveLevels` (replace impl).
- `index.html`: `solveEikonalAsync` fallback structure, `executeOnWorker` transfer flow, `getPathWidth` (extend), presets (extend).
- Old WebGPU code in git history (`git show e4321fc~1:index.html`) as a reference for buffer/pipeline patterns. Rewrite the shaders correctly (no switch fallthrough; true Eikonal, not JFA).

## Implementation details

### GPU Eikonal solver (replaces old JFA — true Eikonal, not Euclidean)

- Ping-pong `Float32Array` storage buffers (2× `pixelCount*4`).
- Init pass: `u=0` where `gray<threshold` (seeds), `u=∞` elsewhere.
- Sweep: red-black ordering, two sub-passes per sweep (Gauss-Seidel style, ~2× convergence of plain Jacobi). Update rule per pixel (Godunov upwind, speed `f=gray`):
  `uN=min(u[i-1],u[i+1])`, `uW=min(u[j-1],u[j+1])`;
  if `|uN−uW| ≥ f` → `min(uN,uW)+f`; else `(uN+uW+√(2f²−(uN−uW)²))/2`.
- Fixed sweeps (~60) with an optional early exit through a max-change reduction buffer.
- Read back once. Transfer to the worker (extraction unchanged).
- Used for: `contours` mode field, `edgeDistance` field (speed=1 on Sobel mask).

### Data flow

- Main thread: GPU preprocess → `grayData` (Float32Array) → GPU Eikonal → `this.solution`. Cache `this.gradMag` / `this.edgeDistance` on the instance. Region rerun needs them too.
- Workers receive `solution` + `gradMag` + `edgeDistance` + quality options through the existing `executeOnWorker` plumbing (typed arrays already structured-clone cleanly).
- CPU path (fallback): existing FMM + `computeDistanceFieldGradient`. The downstream behavior is identical. The design guarantees fallback parity.
- Live preview: no wavefront streaming from the GPU solver. Render the final field. Replay a short animated reveal from the final `Float32Array` (a cheap cosmetic stand-in).

## Steps

- [x] 1. `js/gpu.js`: WebGPUManager — init/status + adapter info; `preprocess(imageData, {blurRadius, invert, contrast})` (grayscale → optional separable Gaussian blur → contrast stretch, ping-pong); `sobelGradient`; `solveEikonal` (red-black Jacobi); `edgeDistance`; readback; buffer cleanup; graceful failure → `available=false`.
- [x] 2. index.html: include `js/gpu.js`; `useGPU` checkbox (default ON) + GPU status UI (header readout `GPU · WebGPU` / `CPU`, sidebar panel); blur + contrast sliders (Preprocess section); `toGrayscale` → GPU preprocess; `solveEikonalAsync` → GPU solver with FMM fallback; field-preview reveal replay; perf-table rows for GPU stages.
- [x] 3. `js/engine.js`: `generateAdaptiveLevelsGrad` (gradient-histogram), percentile `generateLuminanceLevels`, `applyEdgeWarp(solution, edgeDistance, gradMag, sensitivity)`, angle-aware `splineSmooth` extension.
- [x] 4. `worker.js`: `handleExtractContoursAdaptive` consumes `gradMag`/`edgeDistance`/`edgeGuidance`/`edgeSensitivity`/`featureImportance`/`contourSmoothness`; edge warp; real adaptive levels; smoothing. Keep the FMM/streamline/etc. handlers as-is.
- [x] 5. `processImage` (index.html): pass new params/options for all modes; extend `getPathWidth` to use gradMag; cache GPU outputs for region rerun; perf metrics.
- [x] 6. Presets (add blur/contrast where sensible), README (put back WebGPU section + new controls), status text.
- [x] 7. Check (below); fix regressions.

## Test results (headless Chrome 150, WebGPU with a software adapter)

- **GPU invoked**: the header shows `GPU · WebGPU`. The perf table shows `Backend: GPU · WebGPU`. GPU stage timings show (Preprocess / GPU Eikonal / GPU Gradient / GPU Edge Dist).
- **All 6 modes produce artwork**: luminance 15 paths / contours 5 / streamlines 94 / stipple 392 / hatch 69 / TSP 1 continuous line. Each mode has GPU-accelerated preprocess + Eikonal solve.
- **GPU field solver validated**: the single-seed sweep solver reproduces ground-truth Euclidean distance (max≈79 at 40 sweeps, 140 sweeps fully converges). wgsl_reflect parses the WGSL. The `uncapturederror` listener makes silent shader failures visible.
- **Edge guidance works**: on a photo-like image, contours ON=34 paths vs OFF=4 paths.
- **CPU fallback parity**: with GPU disabled, luminance still yields 15 paths; contours 131 paths; edge-distance set (chamfer); status shows CPU.
- **Region rerun fixed** (the refactor broke it — `joinContoursImproved` undefined). SVG export is intact (rings export as quadratic-curve paths).
- **Bugs found and fixed during the test**: sweepShader arg arity (silent WGSL failure), closed-ring RDP collapse (`perpDist` degenerate chord), threshold units in streamlines/stipple/hatch workers (raw 50 vs 0.5), streamline occupancy grid killing traces at step 1, flat-field streamline fallback to luminance gradient, CPU gradMag object-vs-array bug.

## Check the result

- `python -m http.server 8000` → open http://localhost:8000 (WebGPU needs a secure context — localhost or GitHub Pages; also check `chrome://gpu` / `about:gpu` if the adapter is missing).
- The status shows `GPU · WebGPU` (or a CPU fallback notice when `navigator.gpu` is absent).
- Sample pattern + a real photo, all 6 modes: contours field solve time GPU vs CPU FMM (perf table) — expect a large speedup; output visually cleaner.
- Edge guidance ON vs OFF visibly changes contour adherence near edges (cyberpunk/blueprint presets).
- The blur slider removes noise. The contrast slider spreads levels. Histogram levels distribute lines evenly (luminance mode).
- SVG export still works. Pause/cancel/region-rerun still work. Workers report ACTIVE.
- Fallback test: disable WebGPU in browser flags or switch `useGPU` off → identical pipeline works, status shows CPU.
