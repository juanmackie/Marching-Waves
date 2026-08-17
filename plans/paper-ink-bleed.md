# Plan: Ink Bleed Effect for Marching Waves

_(Revised after user clarification: NOT a "paper" aesthetic. No paper-coloured background, no fibrous paper texture. Just a soft outward bloom halo around the ink strokes — the "ink bleeding" effect. One slider. Output embedded in a normal exported SVG via an `<filter>`. Procedural noise may be used only as a subtle organic dither in the bloom, not as a paper face. White background is preserved.)_

## Context

Marching Waves renders crisp contour-line ink onto a 2D `<canvas>` (white background — `drawContours()`, index.html ~2201) and exports clean SVG (`getSVG()`, index.html ~2351). The user wants an **ink bleed effect**: each ink stroke gains a soft, semi-transparent outward halo (ink soaking slightly into the surface), with the crisp line preserved on top. The effect must appear in the on-screen result **and** be carried by the exported SVG as a normal vector file. The contour *geometry / SVG path data* is never altered — only a rendering composite/filter is layered on top.

Verified current state:
- No existing bleed / `globalCompositeOperation` / SVG `<filter>` usage anywhere in `index.html`, `js/`, `css/`, `about.html` (grep-verified).
- Zero image assets in the repo — pure JS, no dependencies. Any texture must be procedural.
- Controls follow a consistent pattern: `options` object gathered in the generate handler (~line 3786) → consumed in `processImage()` (~line 848); presets in a `presets{}` map (~line 3395) applied by `applyPreset` (~line 3545).

## Approach

A single-strength ink-bloom post-effect, applied identically in spirit to canvas and SVG.

### Canvas (final render — `drawContours`)
- Add `js/paper-bleed.js` exporting `InkBleedRenderer.applyBleed(ctx, canvas, { strength })` (synchronous).
- After the crisp ink is drawn to the canvas (current behaviour, white bg preserved):
  1. Copy the canvas into an offscreen buffer (`ctx2.drawImage(canvas, 0, 0)`).
  2. Draw that buffer back onto the main canvas with a slight `ctx.filter = 'blur(Npx)'`, `globalCompositeOperation = 'darken'`, `globalAlpha = alpha(strength)`. This creates the soft outward dark halo (bleed) around every stroke, while the already-drawn crisp ink stays on top.
  3. (Optional) Sub-pixel procedural value-noise dither drawn at very low alpha over the halo region only — fine organic grain to break the synthetic blur, **not** a paper texture. Same slider drives intensity.
- `strength = 0` → no-op, output byte-identical to today.
- `strength` ranges 0–1 → `Npx` and `alpha` scale linearly from ~0 to ~3px / ~0.35.

### SVG export (`getSVG`)
- When `inkBleed > 0`, inject into `<defs>` a single reusable filter:
  ```xml
  <filter id="ink-bleed" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="STD" result="halo"/>
    <feMerge>
      <feMergeNode in="halo"/>           <!-- soft colored bloom behind -->
      <feMergeNode in="SourceGraphic"/>  <!-- crisp ink on top -->
    </feMerge>
  </filter>
  ```
  `STD = 0.5 + strength * 5`. `SourceGraphic` carries the stroke colour(s), so the bloom matches the ink. The `feMerge` order puts the crisp lines on top — exactly the ink-bleed look. One filter reused by the single contour `<g>`.
- Add `filter="url(#ink-bleed)"` on `<g id="contours">` only when enabled. SVG stays a normal, portable file.
- When disabled (strength 0): no `<defs>`, no filter attr → identical to today's output.

### UI
One slider in the **Style** section, matching the existing `.field` pattern:
- `Ink Bleed` slider: `min=0 max=1 step=0.05 value=0`, with a live `#inkBleedValue` readout (`0.00`…`1.00`).
- A short `ⓘ` tooltip: "Soft outward bloom around lines, simulating ink bleeding into the surface. 0 = crisp lines; higher = wider bloom. Preserved in SVG export."
- Default **0 (off)** — non-breaking; existing output unchanged until the user opts in.

## Files to modify
- **`js/paper-bleed.js`** — NEW: `InkBleedRenderer` — `applyBleed(ctx, canvas, {strength})` (canvas composite: copy → blur/darken bloom → optional sub-pixel noise dither) and a small `generateNoise(w,h,amp)` helper. Zero dependencies.
- **`index.html`**:
  - `<script src="js/paper-bleed.js">` (with the other `js/` includes, ~line 297).
  - Style-section markup: new `Ink Bleed` slider + readout + tooltip.
  - generate-handler options (~line 3786): add `inkBleed: parseFloat(document.getElementById('inkBleed').value)`.
  - `processImage()` (~line 848): read `inkBleed` into `this.inkBleed`.
  - `drawContours()` (~line 2201): after the stroke loop, if `this.inkBleed > 0`, call `InkBleedRenderer.applyBleed(this.ctx, this.canvas, { strength: this.inkBleed })`.
  - `getSVG()` (~line 2351): if `this.inkBleed > 0`, add the `<defs><filter>` and `filter=` attr on the contour group.
  - `applyPreset` (~line 3545): copy an optional `inkBleed` preset field + set the slider/value when present.
- **presets** (~line 3395): add `inkBleed` to 2–3 fitting styles (e.g. `ink-blot`, `natural-contours`, `ethereal`). Optional but adds polish.
- **`README.md`**: add "Ink Bleed" to Artistic Controls + Parameter Guide; note SVG filter export.

## Reuse
- `MarchingWaves.ctx` / `this.canvas` / `drawContours()` / `getSVG()` / `processImage()` options plumbing.
- Preset application logic (`applyPreset`, copies a subset of fields).
- No changes to contour generation (`worker.js`, `engine.js`) — geometry pipeline untouched.

## Steps
- [ ] 1. `js/paper-bleed.js`: `InkBleedRenderer` with `applyBleed()` (blur/darken bloom behind crisp ink + optional sub-pixel noise) and `generateNoise()`.
- [ ] 2. index.html: include `js/paper-bleed.js`; add the `Ink Bleed` slider+readout+tooltip in the Style section; read `inkBleed` into options.
- [ ] 3. index.html `processImage`: set `this.inkBleed`; `drawContours`: apply `applyBleed` at the end of the final render when `> 0`.
- [ ] 4. index.html `getSVG`: emit `<defs><filter id="ink-bleed">…</filter></defs>` (feGaussianBlur halo + feMerge behind crisp) and `filter="url(#ink-bleed)"` on `<g id="contours">` when `inkBleed > 0`; omit when `0`.
- [ ] 5. Presets: add `inkBleed` to 2–3 fitting presets; wire `applyPreset` to set slider/value.
- [ ] 6. README.md: document Ink Bleed control + SVG export behaviour.
- [ ] 7. Smoke test: generate in every mode with bleed 0 (unchanged), then 0.5 and 1.0 — crisp ink stays on top with a soft halo; SVG opens in browser showing the bloom; toggling back to 0 reproduces today's exact output.

## Verification
- `python -m http.server 8000` → http://localhost:8000.
- Sample pattern + real photo, all 6 modes: at `0.00` output is identical to current (no regression / no filter emitted); at `0.5` and `1.0` a soft coloured halo appears around strokes under the still-crisp ink.
- Exported `.svg`: open in browser/Inkscape — the `<g>` carries `filter="url(#ink-bleed)"`, halo renders behind crisp paths; at `0.00` neither the filter nor `filter=` attr is present.
- Perf: final canvas cost of one offscreen copy + one blurred composite is < ~15ms for typical canvases; SVG filter is render-time only (no JS cost).
