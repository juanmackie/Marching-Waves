# Marching Waves agent contract

## Purpose

Marching Waves is a browser-only computational art generator. It turns local
images into contour, streamline, stipple, TSP, cross-hatch, and Subject Wire
art using vanilla HTML, CSS, and JavaScript.

## Ownership

- `index.html` owns the application shell, controls, rendering, SVG export, and
  the main-thread fallback path.
- `js/engine.js` owns shared image and path algorithms.
- `worker.js` and `worker-pool.js` own bounded background processing and
  cancellation.
- `js/gpu.js` owns optional WebGPU preprocessing and field solving.
- `css/` owns presentation; `about.html` and `js/about.js` own the about page.
- `README.md` owns user-facing setup, controls, and capability disclosures.

## Local Contracts

- The app must work from a local HTTP server with no build step and no external
  runtime dependencies. WebGPU is optional; the CPU path remains the fallback.
- Image input is untrusted. Keep worker messages, canvas processing, and SVG
  export bounded and avoid injecting source-derived HTML or script.
- Keep processing deterministic for identical inputs and settings. Do not add
  wall-clock dependence to artwork algorithms.
- Web Workers must remain cancellable and must not block the main thread for
  normal processing. Exported SVG must remain valid and portable.
- Prefer deletion and the smallest clear change. Do not add frameworks,
  dependencies, speculative modes, or compatibility paths without a current
  consumer.
- Never commit secrets, local environment files, agent/session state, plans, or
  generated build output. Do not commit, push, deploy, or perform destructive
  operations without explicit authorization.

## Verification

- Serve the repository with `python -m http.server 8000` and inspect the app in
  a browser for sample input, a local image, worker activity, pause/resume,
  cancellation, and SVG export.
- Verify both WebGPU-enabled and CPU-fallback paths when the browser supports
  the relevant controls; report unavailable browser capabilities explicitly.
- Run any relevant benchmark in `benchmarks/` and compare deterministic output
  fields when algorithm or performance code changes.
- Run `git diff --check` and inspect repository status before closeout. The
  root `PLAN.md` is local and ignored; it is not part of the repository index.

## Child DOX Index

- No child `AGENTS.md` files. Root-owned source files and static assets are
  covered by this contract.
