// Marching Waves renderer — flat Geometry to canvas or SVG.
// DOM-free at load time so the benchmark can build SVG in Node.
var Render = (function () {
    'use strict';

    var HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
    var bleedTmp = null;
    var bleedCtx = null;

    function safeColor(color) {
        return HEX_COLOR.test(color || '') ? color : '#000000';
    }

    function bleedParams(strength) {
        var s = Math.max(0, Math.min(1, strength || 0));
        return {
            strength: s,
            outerRadius: 0.9 + s * 4.6,
            outerAlpha: 0.15 + s * 0.25,
            innerRadius: 0.3 + s * 1.8,
            innerAlpha: 0.13 + s * 0.23
        };
    }

    function ensureBleedCanvas(width, height) {
        if (typeof document === 'undefined') return null;
        if (!bleedTmp || bleedTmp.width !== width || bleedTmp.height !== height) {
            bleedTmp = document.createElement('canvas');
            bleedTmp.width = width;
            bleedTmp.height = height;
            bleedCtx = bleedTmp.getContext('2d');
        }
        return bleedTmp;
    }

    function applyBleed(ctx, canvas, strength) {
        var p = bleedParams(strength);
        if (p.strength <= 0 || !ctx || !canvas) return;
        var w = canvas.width, h = canvas.height;
        if (!w || !h) return;
        var tmp = ensureBleedCanvas(w, h);
        if (!tmp || !bleedCtx) return;
        bleedCtx.clearRect(0, 0, w, h);
        bleedCtx.filter = 'none';
        bleedCtx.drawImage(canvas, 0, 0);
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = p.outerAlpha;
        ctx.filter = 'blur(' + p.outerRadius.toFixed(3) + 'px)';
        ctx.drawImage(tmp, 0, 0);
        ctx.restore();
        ctx.save();
        ctx.globalCompositeOperation = 'darken';
        ctx.globalAlpha = p.innerAlpha;
        ctx.filter = 'blur(' + p.innerRadius.toFixed(3) + 'px)';
        ctx.drawImage(tmp, 0, 0);
        ctx.restore();
    }

    function resetCache() {
        bleedTmp = null;
        bleedCtx = null;
    }

    // ─── Canvas ───

    function drawGeometry(ctx, geometry, style) {
        var color = safeColor(style.lineColor);
        var baseWidth = style.lineWidth != null ? style.lineWidth : 1;
        var g = geometry;
        if (!g || !g.count) return;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        var dots = [];
        for (var p = 0; p < g.count; p++) {
            var a = g.offsets[p], b = g.offsets[p + 1];
            if (b - a === 1 && g.radius[a] > 0) {
                dots.push(a);
                continue;
            }
            if (b - a < 2) continue;
            var lw = g.widths[p] > 0 ? g.widths[p] : baseWidth;
            ctx.beginPath();
            ctx.lineWidth = lw;
            ctx.strokeStyle = color;
            ctx.moveTo(g.xy[a * 2], g.xy[a * 2 + 1]);
            var i;
            for (i = a + 1; i < b - 2; i++) {
                var xc = (g.xy[i * 2] + g.xy[(i + 1) * 2]) / 2;
                var yc = (g.xy[i * 2 + 1] + g.xy[(i + 1) * 2 + 1]) / 2;
                ctx.quadraticCurveTo(g.xy[i * 2], g.xy[i * 2 + 1], xc, yc);
            }
            if (b - a > 2) {
                var last = b - 1;
                var prev = b - 2;
                ctx.quadraticCurveTo(g.xy[prev * 2], g.xy[prev * 2 + 1], g.xy[last * 2], g.xy[last * 2 + 1]);
            } else {
                ctx.lineTo(g.xy[(a + 1) * 2], g.xy[(a + 1) * 2 + 1]);
            }
            ctx.stroke();
        }

        if (dots.length) {
            ctx.fillStyle = color;
            ctx.beginPath();
            for (var d = 0; d < dots.length; d++) {
                var di = dots[d];
                var r = g.radius[di];
                ctx.moveTo(g.xy[di * 2] + r, g.xy[di * 2 + 1]);
                ctx.arc(g.xy[di * 2], g.xy[di * 2 + 1], r, 0, Math.PI * 2);
            }
            ctx.fill();
        }
    }

    function drawArtwork(ctx, artwork, style) {
        style = style || {};
        var width = artwork.width, height = artwork.height;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        drawGeometry(ctx, artwork.geometry, style);
        applyBleed(ctx, ctx.canvas, style.inkBleed || 0);
    }

    // ─── SVG ───

    function buildSVG(artwork, style) {
        style = style || {};
        var width = artwork.width, height = artwork.height;
        var geometry = artwork.geometry;
        var color = safeColor(style.lineColor);
        var baseWidth = style.lineWidth != null ? style.lineWidth : 1;
        var parts = [];
        var i, p;

        if (geometry && geometry.count) {
            var dotParts = [];
            var pathParts = [];
            for (p = 0; p < geometry.count; p++) {
                var a = geometry.offsets[p], b = geometry.offsets[p + 1];
                if (b - a === 1 && geometry.radius[a] > 0) {
                    dotParts.push('<circle cx="' + geometry.xy[a * 2].toFixed(2) +
                        '" cy="' + geometry.xy[a * 2 + 1].toFixed(2) +
                        '" r="' + geometry.radius[a].toFixed(2) +
                        '" fill="' + color + '"/>');
                    continue;
                }
                if (b - a < 2) continue;
                var lw = geometry.widths[p] > 0 ? geometry.widths[p] : baseWidth;
                var chunks = [];
                chunks.push('M' + geometry.xy[a * 2].toFixed(2) + ',' + geometry.xy[a * 2 + 1].toFixed(2));
                if (b - a === 2) {
                    chunks.push('L' + geometry.xy[(a + 1) * 2].toFixed(2) + ',' + geometry.xy[(a + 1) * 2 + 1].toFixed(2));
                } else {
                    for (i = a + 1; i < b - 2; i++) {
                        var xc = (geometry.xy[i * 2] + geometry.xy[(i + 1) * 2]) / 2;
                        var yc = (geometry.xy[i * 2 + 1] + geometry.xy[(i + 1) * 2 + 1]) / 2;
                        chunks.push('Q' + geometry.xy[i * 2].toFixed(2) + ',' + geometry.xy[i * 2 + 1].toFixed(2) +
                            ' ' + xc.toFixed(2) + ',' + yc.toFixed(2));
                    }
                    var last = b - 1, prev = b - 2;
                    chunks.push('Q' + geometry.xy[prev * 2].toFixed(2) + ',' + geometry.xy[prev * 2 + 1].toFixed(2) +
                        ' ' + geometry.xy[last * 2].toFixed(2) + ',' + geometry.xy[last * 2 + 1].toFixed(2));
                }
                pathParts.push('<path stroke="' + color + '" stroke-width="' + lw.toFixed(2) +
                    '" stroke-linecap="round" stroke-linejoin="round" fill="none" d="' + chunks.join(' ') + '"/>');
            }
            if (dotParts.length) {
                parts.push('<g id="stipple" data-mode="' + artwork.mode + '">');
                parts.push(dotParts.join('\n    '));
                parts.push('</g>');
            }
            if (pathParts.length) {
                parts.push('<g id="contours" data-mode="' + artwork.mode + '">');
                parts.push(pathParts.join('\n  '));
                parts.push('</g>');
            }
        }

        var svg = '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
            '" viewBox="0 0 ' + width + ' ' + height + '">\n';
        if (style.whiteBackground) {
            svg += '  <rect width="' + width + '" height="' + height + '" fill="#ffffff"/>\n';
        }
        var bleed = bleedParams(style.inkBleed || 0);
        var bleedEnabled = bleed.strength > 0;
        if (bleedEnabled) {
            svg += '<defs>\n  <filter id="ink-bleed" x="-50%" y="-50%" width="200%" height="200%">\n' +
                '    <feGaussianBlur in="SourceGraphic" stdDeviation="' + bleed.outerRadius.toFixed(3) + '" result="halo"/>\n' +
                '    <feComponentTransfer in="halo" result="halo">\n      <feFuncA type="linear" slope="' + bleed.outerAlpha.toFixed(3) + '"/>\n    </feComponentTransfer>\n' +
                '    <feGaussianBlur in="SourceGraphic" stdDeviation="' + bleed.innerRadius.toFixed(3) + '" result="edge"/>\n' +
                '    <feComponentTransfer in="edge" result="edge">\n      <feFuncA type="linear" slope="' + bleed.innerAlpha.toFixed(3) + '"/>\n    </feComponentTransfer>\n' +
                '    <feMerge>\n      <feMergeNode in="edge"/>\n      <feMergeNode in="halo"/>\n      <feMergeNode in="SourceGraphic"/>\n    </feMerge>\n  </filter>\n</defs>\n';
        }
        if (parts.length) {
            var grouped = parts.join('\n');
            if (bleedEnabled) {
                grouped = grouped.replace('<g id="', '<g filter="url(#ink-bleed)" id="');
            }
            svg += grouped + '\n';
        }
        svg += '</svg>';
        return svg;
    }

    return {
        bleedParams: bleedParams,
        applyBleed: applyBleed,
        drawArtwork: drawArtwork,
        buildSVG: buildSVG,
        resetCache: resetCache
    };
})();
