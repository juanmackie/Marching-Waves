# Marching-Waves agent contract

## Operating Standard

- Apply the global AGENTS.md (`~/.pi/agent/AGENTS.md`, loaded automatically) as the operating standard.
- This file holds repository-specific facts. They override global defaults (commands, runners, paths, constraints) but cannot weaken a global approval, security, or secrets rule.

## Scope and Ownership

Marching Waves is a browser-only computational art generator: it turns local images into contour, streamline, stipple, TSP, cross-hatch, and Subject Wire artwork using vanilla HTML, CSS, and JavaScript.

- `index.html` owns the application shell, controls, canvas/SVG rendering, SVG export, and the main-thread fallback path.
- `js/engine.js` owns shared image and path algorithms; `js/gpu.js` owns optional WebGPU preprocessing and Eikonal field solving; `js/subject-wire.js` and `js/paper-bleed.js` own their named features.
- `worker.js` and `worker-pool.js` own bounded background processing and cancellation.
- `css/` owns presentation; `about.html` and `js/about.js` own the about page.
- `benchmarks/` owns the headless Node benchmark harness and scripts (`harness.js`, `ab.js`, `ab2.js`, `snapshot.json`).
- `docs/verification/` owns recorded manual verification evidence; `README.md` owns user-facing setup, controls, and capability disclosures.
- `autoresearch/` and `plans/` are local working areas, not shipped product.

## Constraints

- The app must run from a local HTTP server with no build step and no external runtime dependencies. Never add frameworks, package dependencies, speculative modes, or compatibility paths without a current consumer.
- WebGPU is optional acceleration; the CPU path (Fast Marching Method fallback) must remain fully functional and is exercised wherever GPU coverage is unavailable.
- Image input is untrusted. Keep worker messages, canvas processing, and SVG export bounded; never inject source-derived HTML or script into the DOM or exported files.
- Processing must stay deterministic for identical inputs and settings: no wall-clock, random-without-seed, or environment-dependent behavior inside artwork algorithms.
- Web Workers must remain cancellable and must not block the main thread for normal processing. Exported SVG must stay valid and portable (plain vector markup; e.g. Ink Bleed ships as a standard `<filter>`).
- `PLAN.md` is local and git-ignored; never commit it. Never commit secrets, local environment files, agent/session state, or generated build output. Commit, push, deploy, or destructive git operations require explicit authorization.

## Verification

There is no package.json or test framework; the runnable checks are the benchmark harness and manual browser exercise.

- `node benchmarks/harness.js` — headless full CPU pipeline run with per-stage timings, determinism and quality checks, compared against `benchmarks/snapshot.json`. Add `--snapshot` only to deliberately re-baseline. Use when `js/engine.js` or algorithm/performance code changes.
- `node benchmarks/ab.js [baseline] [candidate] [rounds]` and `node benchmarks/ab2.js` — A/B timing comparisons when optimizing; alternate runs to reduce machine-contention bias.
- Serve with `python -m http.server 8000` (or `python3 -m http.server 3000` on a free port; `npx http.server`/`npx http-server` if Python is absent) and open http://localhost:8000 in a browser. Opening `index.html` from the filesystem is not valid — Web Workers require the server. Exercise: sample input plus a local image, worker activity ("Background Processing: ACTIVE"), pause/resume/cancel, and SVG export.
- Verify both the WebGPU-enabled and CPU-fallback paths when the browser supports the relevant controls; report unavailable browser capabilities explicitly.
- Run `git diff --check` and inspect repository status before closeout.

## Documentation index

- `README.md` — user-facing quick start, controls, presets, and capability disclosures; update when behavior, controls, or setup changes.
- `docs/verification/` — recorded manual verification runs; add a dated note when a release-worthy change is manually exercised.
- `benchmarks/snapshot.json` — deterministic reference baseline for the CPU pipeline; regenerate only with intent and note the reason.

## Known gaps

- No automated test suite or lint/type tooling exists; correctness of UI interaction, GPU paths, and SVG output relies on the manual browser checks above plus the headless engine benchmark.
- WebGPU behavior cannot be validated headlessly; it requires a capable browser and must be reported as unverified when unavailable.
