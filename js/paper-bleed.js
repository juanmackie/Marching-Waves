// js/paper-bleed.js - Ink Bleed effect for Marching Waves
//
// A soft outward "bleed" halo around ink strokes (ink soaking slightly into the
// surface), with the crisp line preserved on top. The contour geometry is never
// touched - this is a pure rendering post-effect layered over the existing canvas
// draw, and is mirrored by an SVG <filter> in getSVG() so exported vectors carry
// the same look.
//
// Technique (canvas):
//   1. Copy the rendered canvas (crisp ink on white) into a reusable offscreen buffer.
//   2. Draw TWO filtered copies back onto the canvas: a broad, faint wash and a
//      tighter, darker edge. multiply/darken leave white untouched away from the
//      ink and keep the original crisp stroke visually dominant on top.
//   3. No full-canvas grain: random overlay made the ink look dusty rather than
//      wet. The organic variation already present in the contour geometry is
//      preserved, while the bleed itself stays smooth and controlled.
//
// Pure JS, zero dependencies. Global singleton `inkBleedRenderer` (mirrors gpu.js).
'use strict';

class InkBleedRenderer {
    constructor() {
        this._tmp = null;           // reusable offscreen canvas (size-cached) used as the blur source
        this._tmpCtx = null;
    }

    // Apply the ink-bleed bloom to an already-rendered canvas.
    // ctx         : the 2D context of the canvas to post-process
    // canvas      : the HTMLCanvasElement that ctx draws to
    // opts.strength : 0 (no-op) .. 1 (strong two-layer soak)
    applyBleed(ctx, canvas, opts) {
        const strength = Math.max(0, Math.min(1, (opts && opts.strength) || 0));
        if (strength <= 0 || !ctx || !canvas) return;

        const w = canvas.width, h = canvas.height;
        if (w === 0 || h === 0) return;

        // --- 1. copy the finished ink into a reusable blur source ---
        const tmp = this._ensureTmp(w, h);
        const bctx = this._tmpCtx;
        bctx.clearRect(0, 0, w, h);
        bctx.filter = 'none';
        bctx.drawImage(canvas, 0, 0);

        // --- 2. broad soak: subtle color a little distance from the original stroke ---
        // multiply leaves white untouched and darkens only where the blurred ink is
        // dark, so the background never gets tinted and the source line stays dominant.
        const outerRadius = (0.9 + strength * 4.6).toFixed(3);  // px  (0.900 .. 5.500)
        const outerAlpha = (0.15 + strength * 0.25).toFixed(3);  // (0.150 .. 0.400)
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = parseFloat(outerAlpha);
        ctx.filter = 'blur(' + outerRadius + 'px)';
        ctx.drawImage(tmp, 0, 0);
        ctx.restore();

        // --- 3. inner pooling: denser color right next to each stroke (wet-ink edge) ---
        // This darkens pixels adjacent to the stroke to reinforce the edge without
        // softening the crisp render that is already underneath it.
        const innerRadius = (0.3 + strength * 1.8).toFixed(3);  // px  (0.300 .. 2.100)
        const innerAlpha = (0.13 + strength * 0.23).toFixed(3);  // (0.130 .. 0.360)
        ctx.save();
        ctx.globalCompositeOperation = 'darken';
        ctx.globalAlpha = parseFloat(innerAlpha);
        ctx.filter = 'blur(' + innerRadius + 'px)';
        ctx.drawImage(tmp, 0, 0);
        ctx.restore();
    }

    _ensureTmp(w, h) {
        if (!this._tmp || this._tmp.width !== w || this._tmp.height !== h) {
            this._tmp = document.createElement('canvas');
            this._tmp.width = w;
            this._tmp.height = h;
            this._tmpCtx = this._tmp.getContext('2d');
        }
        return this._tmp;
    }

    // Release cached buffers (call on image change / memory cleanup).
    resetCache() {
        this._tmp = null;
        this._tmpCtx = null;
    }
}

// Global singleton (main thread only - worker.js does not load this file)
const inkBleedRenderer = (typeof window !== 'undefined') ? new InkBleedRenderer() : null;
