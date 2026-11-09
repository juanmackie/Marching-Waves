// Marching Waves application — image ingest, GPU/CPU preparation, worker orchestration, rendering.
var MarchingWavesApp = (function () {
    'use strict';

    function cancelledError() {
        var e = new Error('Cancelled');
        e.name = 'CancelledError';
        return e;
    }

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    // ─── Live preview (heatmap from streamed wavefronts) ───

    function LivePreview(canvas, ctx) {
        this.canvas = canvas;
        this.ctx = ctx;
        this.throttleMs = 200;
        this.lastUpdate = 0;
        this.imageData = null;
    }
    LivePreview.prototype.renderField = function (field, width, height, minVal, maxVal) {
        var now = performance.now();
        if (now - this.lastUpdate < this.throttleMs) return;
        this.lastUpdate = now;
        if (!this.imageData || this.imageData.width !== width || this.imageData.height !== height) {
            this.imageData = this.ctx.createImageData(width, height);
        }
        var data = this.imageData.data;
        if (!isFinite(minVal) || !isFinite(maxVal) || maxVal <= minVal) { minVal = 0; maxVal = 1; }
        var range = maxVal - minVal || 1;
        for (var i = 0; i < field.length; i++) {
            var val = field[i];
            var o = i * 4;
            if (!isFinite(val) || val >= 1e9) {
                data[o] = 32; data[o + 1] = 32; data[o + 2] = 32;
            } else {
                var t = clamp((val - minVal) / range, 0, 1);
                if (t < 0.25) {
                    var s1 = t / 0.25;
                    data[o] = 0; data[o + 1] = Math.floor(s1 * 255); data[o + 2] = 255;
                } else if (t < 0.5) {
                    var s2 = (t - 0.25) / 0.25;
                    data[o] = 0; data[o + 1] = 255; data[o + 2] = Math.floor((1 - s2) * 255);
                } else if (t < 0.75) {
                    var s3 = (t - 0.5) / 0.25;
                    data[o] = Math.floor(s3 * 255); data[o + 1] = 255; data[o + 2] = 0;
                } else {
                    var s4 = (t - 0.75) / 0.25;
                    data[o] = 255; data[o + 1] = Math.floor((1 - s4) * 255); data[o + 2] = 0;
                }
            }
            data[o + 3] = 255;
        }
        this.ctx.putImageData(this.imageData, 0, 0);
    };

    // ─── Geometry merge helpers for region rerun ───

    function removeInRect(geometry, rect) {
        var keep = [];
        var points = 0;
        for (var p = 0; p < geometry.count; p++) {
            var a = geometry.offsets[p], b = geometry.offsets[p + 1];
            var inside = false;
            for (var i = a; i < b; i++) {
                var x = geometry.xy[i * 2], y = geometry.xy[i * 2 + 1];
                if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
                    inside = true;
                    break;
                }
            }
            if (!inside) {
                keep.push(p);
                points += b - a;
            }
        }
        var offsets = new Int32Array(keep.length + 1);
        var xy = new Float32Array(points * 2);
        var radius = new Float32Array(points);
        var widths = new Float32Array(keep.length);
        var oi = 0, w = 0;
        for (var k = 0; k < keep.length; k++) {
            var path = keep[k];
            var start = geometry.offsets[path], end = geometry.offsets[path + 1];
            for (var j = start; j < end; j++) {
                xy[oi * 2] = geometry.xy[j * 2];
                xy[oi * 2 + 1] = geometry.xy[j * 2 + 1];
                radius[oi] = geometry.radius[j];
                oi++;
            }
            widths[w++] = geometry.widths[path];
            offsets[k + 1] = oi;
        }
        return { offsets: offsets, xy: xy, radius: radius, widths: widths, count: keep.length };
    }

    function mergeGeometry(a, b) {
        var paths = a.count + b.count;
        var points = (a.count ? a.offsets[a.count] : 0) + (b.count ? b.offsets[b.count] : 0);
        var offsets = new Int32Array(paths + 1);
        var xy = new Float32Array(points * 2);
        var radius = new Float32Array(points);
        var widths = new Float32Array(paths);
        var pi = 0, pointBase = 0, i;
        for (i = 0; i < a.count; i++) {
            offsets[pi + 1] = offsets[pi] + (a.offsets[i + 1] - a.offsets[i]);
            widths[pi] = a.widths[i];
            pi++;
        }
        for (i = 0; i < b.count; i++) {
            offsets[pi + 1] = offsets[pi] + (b.offsets[i + 1] - b.offsets[i]);
            widths[pi] = b.widths[i];
            pi++;
        }
        xy.set(a.xy, 0);
        xy.set(b.xy, a.xy.length);
        radius.set(a.radius, 0);
        radius.set(b.radius, a.radius.length);
        return { offsets: offsets, xy: xy, radius: radius, widths: widths, count: paths, pointBase: pointBase };
    }

    // ─── App ───

    function App() {
        this.canvas = document.getElementById('outputCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.worker = new WorkerClient();
        this.workerReady = false;
        this.gpu = (typeof gpuManager !== 'undefined') ? gpuManager : null;
        this.gpuAvailable = false;
        this.image = null;
        this.imageW = 0;
        this.imageH = 0;
        this.artwork = null;
        this.svg = '';
        this.running = false;
        this.cancelled = false;
        this.usingWorker = false;
        this.frameId = 0;
        this.lastFrameId = 0;
        this.mainFrame = null;
        this.waveField = null;
        this.waveMax = 0;
        this.perf = {};
        this.live = new LivePreview(this.canvas, this.ctx);
    }

    App.prototype.hasImage = function () { return !!this.image; };
    App.prototype.isRunning = function () { return this.running; };

    App.prototype.initServices = async function () {
        var gpuText = document.getElementById('gpuStatusText');
        var gpuSide = document.getElementById('gpuStatusText2');
        var gpuEl = document.getElementById('gpuStatus');
        var gpuIcon = document.getElementById('gpuStatusIcon');
        if (this.gpu) {
            try {
                var ok = await this.gpu.init();
                this.gpuAvailable = ok;
                if (gpuText) gpuText.textContent = ok ? 'GPU · WebGPU' : 'CPU';
                if (gpuSide) gpuSide.textContent = ok ? this.gpu.getStatusDetail() : 'Unavailable — CPU fallback';
                if (gpuEl) gpuEl.className = 'status ' + (ok ? 'success' : 'warning');
                if (gpuIcon) gpuIcon.textContent = ok ? '⚡' : '⚠️';
            } catch (error) {
                this.gpuAvailable = false;
            }
        } else {
            if (gpuText) gpuText.textContent = 'CPU';
            if (gpuSide) gpuSide.textContent = 'Unavailable — CPU fallback';
            if (gpuEl) gpuEl.className = 'status warning';
        }

        var workerText = document.getElementById('workerStatusText');
        var workerSide = document.getElementById('workerStatusText2');
        var workerEl = document.getElementById('workerStatus');
        var workerIcon = document.getElementById('workerStatusIcon');
        if (typeof Worker === 'undefined') {
            if (workerText) workerText.textContent = 'NOT SUPPORTED';
            if (workerSide) workerSide.textContent = 'NOT SUPPORTED';
            if (workerEl) workerEl.className = 'status warning';
        } else {
            this.workerReady = await this.worker.init();
            if (workerText) workerText.textContent = this.workerReady ? 'Worker: ACTIVE' : 'Main thread';
            if (workerSide) workerSide.textContent = this.workerReady ? 'ACTIVE (1 Worker)' : 'INACTIVE (Main Thread Only)';
            if (workerEl) workerEl.className = 'status ' + (this.workerReady ? 'success' : 'warning');
            if (workerIcon) workerIcon.textContent = this.workerReady ? '⚡' : '⚠️';
        }
    };

    App.prototype.boundSource = function (source, width, height) {
        var maxSide = 4096, maxPixels = 16000000;
        if (width <= maxSide && height <= maxSide && width * height <= maxPixels) {
            return { source: source, width: width, height: height, scaled: false };
        }
        var scale = Math.min(maxSide / width, maxSide / height, Math.sqrt(maxPixels / (width * height)));
        var cw = Math.max(1, Math.round(width * scale));
        var ch = Math.max(1, Math.round(height * scale));
        var c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        c.getContext('2d').drawImage(source, 0, 0, cw, ch);
        return { source: c, width: cw, height: ch, scaled: true };
    };

    App.prototype.setImage = function (source, width, height, url) {
        var bounded = this.boundSource(source, width, height);
        this.image = bounded.source;
        this.imageW = bounded.width;
        this.imageH = bounded.height;
        this.artwork = null;
        this.svg = '';
        this.mainFrame = null;
        this.frameId = 0;
        this.lastFrameId = 0;
        if (this.worker) this.worker.release();
        this.canvas.width = this.imageW;
        this.canvas.height = this.imageH;
        UI.imageLoaded(url);
        if (bounded.scaled) {
            UI.showStatus('Image scaled to ' + this.imageW + ' × ' + this.imageH + ' for processing', 'info');
        } else {
            UI.showStatus('Image loaded successfully', 'success');
        }
    };

    App.prototype.loadFile = function (file) {
        var self = this;
        var reader = new FileReader();
        reader.onload = function (e) {
            var img = new Image();
            img.onload = function () {
                self.setImage(img, img.naturalWidth, img.naturalHeight, e.target.result);
            };
            img.onerror = function () { UI.showStatus('Could not read that image', 'error'); };
            img.src = e.target.result;
        };
        reader.onerror = function () { UI.showStatus('Could not read that file', 'error'); };
        reader.readAsDataURL(file);
    };

    App.prototype.loadSample = function () {
        var size = 200;
        var c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        var ctx = c.getContext('2d');
        var imgData = ctx.createImageData(size, size);
        var center = size / 2;
        var maxRadius = size / 2 - 10;
        for (var y = 0; y < size; y++) {
            for (var x = 0; x < size; x++) {
                var dx = x - center, dy = y - center;
                var distance = Math.sqrt(dx * dx + dy * dy);
                var value = distance > maxRadius ? 1 : 0.5 * (distance / maxRadius);
                var brightness = Math.floor((1 - value) * 255);
                var o = (y * size + x) * 4;
                imgData.data[o] = brightness;
                imgData.data[o + 1] = brightness;
                imgData.data[o + 2] = brightness;
                imgData.data[o + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);
        this.setImage(c, size, size, c.toDataURL());
        UI.showStatus('Sample pattern loaded', 'info');
    };

    App.prototype.buildParams = function (options) {
        return {
            interval: options.interval,
            lineWidth: options.lineWidth,
            threshold: options.threshold,
            edgeGuidance: options.edgeGuidance,
            edgeSensitivity: options.edgeSensitivity,
            detailLevel: options.detailLevel,
            contourSmoothness: options.contourSmoothness,
            featureImportance: options.featureImportance,
            subjectFocus: options.subjectFocus,
            wireDensity: options.wireDensity,
            wireTension: options.wireTension,
            relationshipStrength: options.relationshipStrength,
            abstraction: options.abstraction,
            handDrawn: options.handDrawn,
            variableWidth: options.variableWidth,
            glitchEffect: options.glitchEffect,
            fractalEffect: options.fractalEffect,
            lineWidthVar: options.variableWidth
        };
    };

    App.prototype.buildDebugRequest = function (options) {
        if (!options.debugMode) return null;
        var debug = {};
        if (options.vizMode === 'grayscale') debug.gray = true;
        if (options.vizMode === 'heatmap') debug.solution = true;
        if (options.vizMode === 'raw') debug.raw = true;
        if (options.showOrigins) debug.origins = true;
        return debug;
    };

    App.prototype.generate = async function () {
        if (!this.image || this.running) return;
        var options = UI.readOptions();
        var self = this;
        this.running = true;
        this.cancelled = false;
        this.usingWorker = options.useWorkers && this.workerReady && this.worker.ready;
        UI.setRunning(true);
        UI.setExportEnabled(false);
        if (options.livePreview) UI.showCanvas();
        this.live.lastUpdate = 0;
        var t0 = performance.now();
        var progressLast = 0;

        function progress(show, percent, text) {
            if (!show) return;
            var now = performance.now();
            if (now - progressLast > 100 || percent >= 100) {
                progressLast = now;
                UI.updateProgress(true, percent, text);
            }
        }

        try {
            var w = this.imageW, h = this.imageH;
            this.canvas.width = w;
            this.canvas.height = h;
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(0, 0, w, h);
            this.ctx.drawImage(this.image, 0, 0, w, h);
            var imageData = this.ctx.getImageData(0, 0, w, h);
            var tImage = performance.now();

            progress(options.showProgress, 5, 'Preparing image...');
            if (this.cancelled) throw cancelledError();

            this.gpuAvailable = false;
            if (options.useGPU && this.gpu) {
                try { this.gpuAvailable = await this.gpu.init(); } catch (error) { this.gpuAvailable = false; }
            }
            var blurRadius = clamp(Math.round(options.blurRadius || 0), 0, 8);
            var contrast = options.contrast != null ? options.contrast : 1;
            var gray = null, gradMag = null, edgeDistance = null, solution = null;

            if (this.gpuAvailable) {
                try {
                    gray = await this.gpu.preprocess(imageData, { blurRadius: blurRadius, contrast: contrast, invert: !!options.invert });
                } catch (error) {
                    this.gpuAvailable = false;
                }
            }
            if (!gray) {
                gray = Engine.preprocess(imageData, { blurRadius: blurRadius, contrast: contrast, invert: !!options.invert });
            }
            var tPreprocess = performance.now();
            progress(options.showProgress, 15, 'Computing gradients...');

            if (this.gpuAvailable) {
                try {
                    var gradData = await this.gpu.sobelGradient(gray, w, h);
                    gradMag = gradData.gradMag;
                } catch (error) {
                    this.gpuAvailable = false;
                }
            }
            if (!gradMag) gradMag = Engine.sobel(gray, w, h, false).gradMag;

            var needField = options.mode === 'contours' || options.mode === 'streamlines';
            // The field is solved with the exact CPU FMM in the worker. The GPU
            // red-black solver converges too slowly at normal image sizes to feed
            // contour extraction, but its edge-distance field is local and useful.
            if (needField && this.gpuAvailable && options.mode === 'contours' && options.edgeGuidance) {
                try {
                    var iterations = (typeof WebGPUManager !== 'undefined')
                        ? WebGPUManager.suggestedIterations(w, h) : 48;
                    edgeDistance = await this.gpu.edgeDistance(gray, w, h, 0.12, iterations, { gradMag: gradMag });
                } catch (error) {
                    this.gpuAvailable = false;
                    edgeDistance = null;
                }
            }

            if (this.cancelled) throw cancelledError();
            progress(options.showProgress, 30, 'Extracting artwork...');
            var params = this.buildParams(options);
            var debug = this.buildDebugRequest(options);
            var stream = options.livePreview && needField && !solution;
            var artwork;

            if (this.usingWorker) {
                this.frameId = this.worker.uploadFrame({
                    width: w, height: h, gray: gray, gradMag: gradMag,
                    edgeDistance: edgeDistance, solution: solution
                });
                this.lastFrameId = this.frameId;
                gray = null; gradMag = null; edgeDistance = null; solution = null;
                if (stream) {
                    this.waveField = new Float32Array(w * h);
                    this.waveField.fill(Infinity);
                    this.waveMax = 0;
                }
                artwork = await this.worker.run({
                    frameId: this.frameId,
                    mode: options.mode,
                    params: params,
                    debug: debug,
                    streamWavefront: stream,
                    showProgress: options.showProgress,
                    onProgress: function (percent, text) {
                        progress(options.showProgress, percent, text);
                    },
                    onWavefront: function (indices, values) {
                        if (!self.waveField) return;
                        for (var i = 0; i < indices.length; i++) {
                            self.waveField[indices[i]] = values[i];
                            if (values[i] > self.waveMax) self.waveMax = values[i];
                        }
                        self.live.renderField(self.waveField, w, h, 0, self.waveMax || 1);
                    }
                });
                this.mainFrame = null;
            } else {
                this.usingWorker = false;
                if (stream) {
                    this.waveField = new Float32Array(w * h);
                    this.waveField.fill(Infinity);
                    this.waveMax = 0;
                }
                artwork = await Engine.generate({
                    gray: gray, gradMag: gradMag, edgeDistance: edgeDistance, solution: solution,
                    width: w, height: h, mode: options.mode, params: params,
                    bounds: null, debug: debug,
                    hooks: {
                        progress: function (fraction, text) {
                            progress(options.showProgress, fraction * 100, text);
                        },
                        checkpoint: async function () {
                            if (self.cancelled) throw cancelledError();
                        },
                        onWave: function (index, value) {
                            if (!self.waveField) return;
                            self.waveField[index] = value;
                            if (value > self.waveMax) self.waveMax = value;
                            self.live.renderField(self.waveField, w, h, 0, self.waveMax || 1);
                        }
                    }
                });
                this.mainFrame = {
                    gray: gray, gradMag: gradMag,
                    edgeDistance: edgeDistance, solution: artwork.solution || solution || null
                };
            }

            if (this.cancelled) throw cancelledError();
            var tExtract = performance.now();
            this.artwork = artwork;
            this.perf = this.buildPerf(artwork, options, tImage - t0, tPreprocess - tImage, tExtract - tPreprocess);
            var style = {
                lineColor: options.lineColor,
                lineWidth: options.lineWidth,
                whiteBackground: options.whiteBackground,
                inkBleed: options.inkBleed
            };

            UI.updateProgress(options.showProgress, 96, 'Rendering...');
            if (options.debugMode && options.vizMode !== 'final') {
                this.renderDebug(artwork, options);
                this.svg = '';
                UI.setExportEnabled(false);
            } else {
                Render.drawArtwork(this.ctx, artwork, style);
                this.svg = Render.buildSVG(artwork, style);
                UI.setExportEnabled(true);
            }
            UI.setPerformance(this.perf, options.debugMode && options.showPerf);
            UI.updateProgress(options.showProgress, 100, 'Complete!');
            UI.showStatus('Artwork generated (' + (options.debugMode ? options.vizMode : 'final') + ' view)', 'success');
        } catch (error) {
            if (error && error.name === 'CancelledError') {
                UI.showStatus('Operation cancelled', 'warning');
            } else {
                console.error(error);
                UI.showStatus('Error: ' + (error && error.message ? error.message : String(error)), 'error');
            }
        } finally {
            this.running = false;
            this.waveField = null;
            UI.setRunning(false);
            UI.resetTitle();
        }
    };

    App.prototype.buildPerf = function (artwork, options, preprocessMs, prepMs, extractMs) {
        var perf = {};
        var totalExtract = artwork.perf && artwork.perf.totalMs != null ? artwork.perf.totalMs : extractMs;
        perf['Total'] = (preprocessMs + prepMs + totalExtract).toFixed(0) + 'ms';
        perf['Backend'] = this.gpuAvailable ? 'GPU · WebGPU' : 'CPU';
        perf['Preprocess'] = preprocessMs.toFixed(0) + 'ms';
        perf['Extraction'] = totalExtract.toFixed(0) + 'ms';
        perf['Paths'] = artwork.geometry.count;
        perf['Points'] = artwork.geometry.offsets[artwork.geometry.count] || 0;
        perf['Size'] = artwork.width + '×' + artwork.height;
        perf['Mode'] = options.mode;
        if (options.mode === 'subject-wire' && artwork.meta) {
            perf['Regions'] = artwork.meta.regions || 0;
            perf['Confidence'] = Math.round((artwork.meta.confidence || 0) * 100) + '%';
        }
        if (this.gpuAvailable && this.gpu) {
            var usage = this.gpu.getUsage();
            if (usage.eikonal > 0) perf['GPU Eikonal'] = usage.eikonal.toFixed(1) + 'ms';
            if (usage.sobel > 0) perf['GPU Gradient'] = usage.sobel.toFixed(1) + 'ms';
            if (usage.edgeDistance > 0) perf['GPU Edge Dist'] = usage.edgeDistance.toFixed(1) + 'ms';
        }
        return perf;
    };

    App.prototype.renderDebug = function (artwork, options) {
        var ctx = this.ctx;
        var w = artwork.width, h = artwork.height;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);

        if (options.vizMode === 'grayscale') {
            if (!artwork.gray) {
                ctx.fillStyle = '#888';
                ctx.font = '16px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Grayscale unavailable', w / 2, h / 2);
            } else {
                var img = ctx.createImageData(w, h);
                for (var i = 0; i < artwork.gray.length; i++) {
                    var v = Math.floor(clamp(artwork.gray[i], 0, 1) * 255);
                    img.data[i * 4] = v;
                    img.data[i * 4 + 1] = v;
                    img.data[i * 4 + 2] = v;
                    img.data[i * 4 + 3] = 255;
                }
                ctx.putImageData(img, 0, 0);
            }
        } else if (options.vizMode === 'heatmap') {
            if (!artwork.solution) {
                ctx.fillStyle = '#888';
                ctx.font = '16px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Heatmap N/A (luminance mode)', w / 2, h / 2);
            } else {
                var min = Infinity, max = -Infinity;
                for (var si = 0; si < artwork.solution.length; si++) {
                    var sv = artwork.solution[si];
                    if (!isFinite(sv) || sv >= 1e8) continue;
                    if (sv < min) min = sv;
                    if (sv > max) max = sv;
                }
                this.live.lastUpdate = 0;
                this.live.renderField(artwork.solution, w, h, min === Infinity ? 0 : min, max === -Infinity ? 1 : max);
            }
        } else if (options.vizMode === 'raw') {
            if (!artwork.raw) {
                ctx.fillStyle = '#888';
                ctx.font = '16px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Raw contours N/A for this mode', w / 2, h / 2);
            } else {
                ctx.strokeStyle = options.lineColor;
                ctx.lineWidth = Math.max(0.5, options.lineWidth * 0.5);
                ctx.beginPath();
                var raw = artwork.raw;
                for (var s = 0; s < raw.count; s++) {
                    ctx.moveTo(raw.xy[s * 4], raw.xy[s * 4 + 1]);
                    ctx.lineTo(raw.xy[s * 4 + 2], raw.xy[s * 4 + 3]);
                }
                ctx.stroke();
            }
        }

        if (options.showOrigins && artwork.origins) {
            ctx.fillStyle = 'red';
            for (var oi = 0; oi < artwork.origins.length; oi += 2) {
                ctx.beginPath();
                ctx.arc(artwork.origins[oi], artwork.origins[oi + 1], 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        if (options.showGrid) {
            ctx.strokeStyle = 'rgba(0,0,255,0.2)';
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            for (var gx = 0; gx <= w; gx += 50) {
                ctx.moveTo(gx, 0);
                ctx.lineTo(gx, h);
            }
            for (var gy = 0; gy <= h; gy += 50) {
                ctx.moveTo(0, gy);
                ctx.lineTo(w, gy);
            }
            ctx.stroke();
        }
    };

    App.prototype.rerunRegion = async function (rect) {
        if (!this.artwork || this.running) return;
        var options = UI.readOptions();
        var self = this;
        if (options.mode === 'subject-wire') {
            UI.showStatus('Region rerun is not available for Subject Wire', 'warning');
            return;
        }
        this.running = true;
        this.cancelled = false;
        UI.setRunning(true);
        UI.setExportEnabled(false);
        var progressLast = 0;
        function progress(percent, text) {
            var now = performance.now();
            if (now - progressLast > 100 || percent >= 100) {
                progressLast = now;
                UI.updateProgress(options.showProgress, percent, text);
            }
        }
        try {
            var params = this.buildParams(options);
            var geometry = null;
            var useWorker = options.useWorkers && this.workerReady && this.worker.ready && this.lastFrameId;
            if (useWorker) {
                var result = await this.worker.run({
                    frameId: this.lastFrameId,
                    mode: options.mode,
                    params: params,
                    bounds: rect,
                    debug: null,
                    streamWavefront: false,
                    showProgress: options.showProgress,
                    onProgress: function (percent, text) { progress(percent, text); }
                });
                geometry = result.geometry;
            } else if (this.mainFrame) {
                var mainResult = await Engine.generate({
                    gray: this.mainFrame.gray,
                    gradMag: this.mainFrame.gradMag,
                    edgeDistance: this.mainFrame.edgeDistance,
                    solution: this.mainFrame.solution,
                    width: this.imageW,
                    height: this.imageH,
                    mode: options.mode,
                    params: params,
                    bounds: rect,
                    debug: null,
                    hooks: {
                        progress: function (fraction, text) { progress(fraction * 100, text); },
                        checkpoint: async function () { if (self.cancelled) throw cancelledError(); }
                    }
                });
                geometry = mainResult.geometry;
            } else {
                throw new Error('No cached frame for region rerun');
            }
            if (this.cancelled) throw cancelledError();

            var kept = removeInRect(this.artwork.geometry, rect);
            this.artwork.geometry = mergeGeometry(kept, geometry);
            var style = {
                lineColor: options.lineColor,
                lineWidth: options.lineWidth,
                whiteBackground: options.whiteBackground,
                inkBleed: options.inkBleed
            };
            Render.drawArtwork(this.ctx, this.artwork, style);
            this.svg = Render.buildSVG(this.artwork, style);
            UI.setExportEnabled(true);
            UI.updateProgress(options.showProgress, 100, 'Region updated!');
            UI.showStatus('Region updated!', 'success');
        } catch (error) {
            if (error && error.name === 'CancelledError') {
                UI.showStatus('Operation cancelled', 'warning');
            } else {
                console.error(error);
                UI.showStatus('Error: ' + (error && error.message ? error.message : String(error)), 'error');
            }
        } finally {
            this.running = false;
            UI.setRunning(false);
            UI.resetTitle();
        }
    };

    App.prototype.pause = function () {
        if (!this.running) return;
        if (this.usingWorker) this.worker.pause();
        else UI.showStatus('Pause requires background processing', 'warning');
    };

    App.prototype.resume = function () {
        if (!this.running) return;
        if (this.usingWorker) this.worker.resume();
    };

    App.prototype.cancel = function () {
        this.cancelled = true;
        if (this.usingWorker && this.worker) this.worker.cancel();
    };

    App.prototype.exportSVG = function () {
        if (!this.svg) return;
        var blob = new Blob([this.svg], { type: 'image/svg+xml' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'marching-waves.svg';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        UI.showStatus('SVG exported successfully!', 'success');
    };

    App.prototype.clear = function () {
        this.cancelled = true;
        if (this.worker) {
            this.worker.cancel();
            this.worker.release();
        }
        this.image = null;
        this.artwork = null;
        this.svg = '';
        this.mainFrame = null;
        this.frameId = 0;
        this.lastFrameId = 0;
        this.waveField = null;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.canvas.width = 1;
        this.canvas.height = 1;
        UI.setExportEnabled(false);
        UI.setGenerateEnabled(false);
    };

    App.prototype.dispose = function () {
        if (this.worker) this.worker.dispose();
    };

    var app = new App();
    UI.init(app);
    app.initServices();

    return app;
})();
