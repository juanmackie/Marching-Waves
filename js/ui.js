// Marching Waves UI — controls and presets are data; DOM handlers stay thin.
var UI = (function () {
    'use strict';

    var CONTROLS = [
        { id: 'modeSelect', key: 'mode', kind: 'enum' },
        { id: 'interval', key: 'interval', kind: 'number', format: 0 },
        { id: 'lineWidth', key: 'lineWidth', kind: 'number', format: 1 },
        { id: 'threshold', key: 'threshold', kind: 'number', format: 0 },
        { id: 'edgeGuidance', key: 'edgeGuidance', kind: 'bool' },
        { id: 'edgeSensitivity', key: 'edgeSensitivity', kind: 'number', format: 2 },
        { id: 'detailLevel', key: 'detailLevel', kind: 'number', format: 2 },
        { id: 'contourSmoothness', key: 'contourSmoothness', kind: 'number', format: 2 },
        { id: 'featureImportance', key: 'featureImportance', kind: 'number', format: 2 },
        { id: 'subjectFocus', key: 'subjectFocus', kind: 'number', format: 2 },
        { id: 'wireDensity', key: 'wireDensity', kind: 'number', format: 2 },
        { id: 'wireTension', key: 'wireTension', kind: 'number', format: 2 },
        { id: 'relationshipStrength', key: 'relationshipStrength', kind: 'number', format: 2 },
        { id: 'abstraction', key: 'abstraction', kind: 'number', format: 2 },
        { id: 'handDrawn', key: 'handDrawn', kind: 'number', format: 2 },
        { id: 'blurRadius', key: 'blurRadius', kind: 'number', format: 0 },
        { id: 'contrast', key: 'contrast', kind: 'number', format: 2 },
        { id: 'lineColor', key: 'lineColor', kind: 'color' },
        { id: 'invert', key: 'invert', kind: 'bool' },
        { id: 'varWidth', key: 'variableWidth', kind: 'bool' },
        { id: 'glitchEffect', key: 'glitchEffect', kind: 'bool' },
        { id: 'fractalEffect', key: 'fractalEffect', kind: 'bool' },
        { id: 'inkBleed', key: 'inkBleed', kind: 'number', format: 2 },
        { id: 'showProgress', key: 'showProgress', kind: 'bool' },
        { id: 'livePreview', key: 'livePreview', kind: 'bool' },
        { id: 'useGPU', key: 'useGPU', kind: 'bool' },
        { id: 'useWorkers', key: 'useWorkers', kind: 'bool' },
        { id: 'debugMode', key: 'debugMode', kind: 'bool' },
        { id: 'vizMode', key: 'vizMode', kind: 'enum' },
        { id: 'showOrigins', key: 'showOrigins', kind: 'bool' },
        { id: 'showGrid', key: 'showGrid', kind: 'bool' },
        { id: 'showPerf', key: 'showPerf', kind: 'bool' }
    ];

    var BY_KEY = {};
    for (var ci = 0; ci < CONTROLS.length; ci++) BY_KEY[CONTROLS[ci].key] = CONTROLS[ci];

    var PRESETS = {
        'subject-wire': {
            mode: 'subject-wire', interval: 8, lineWidth: 0.7, threshold: 50, lineColor: '#050505',
            invert: false, blurRadius: 1, contrast: 1.1, contourSmoothness: 0.75,
            subjectFocus: 0.72, wireDensity: 0.38, wireTension: 0.74,
            relationshipStrength: 0.58, abstraction: 0.82, handDrawn: 0.28, inkBleed: 0
        },
        'fashion-sketch': {
            mode: 'subject-wire', interval: 8, lineWidth: 0.8, threshold: 50, lineColor: '#000000',
            invert: false, variableWidth: false, glitchEffect: false, fractalEffect: false,
            whiteBackground: true, blurRadius: 1, contrast: 1.15, contourSmoothness: 0.75,
            subjectFocus: 0.8, wireDensity: 0.3, wireTension: 0.65,
            relationshipStrength: 0.2, abstraction: 0.75, handDrawn: 0.7, inkBleed: 0
        },
        'natural-contours': {
            mode: 'luminance', interval: 12, lineWidth: 0.8, threshold: 80, lineColor: '#1a1a1a',
            invert: true, blurRadius: 1, contrast: 1.05, inkBleed: 0.4
        },
        'fluid': {
            mode: 'streamlines', interval: 5, lineWidth: 0.8, threshold: 50, lineColor: '#1a1a2e',
            invert: true, contourSmoothness: 1.0, blurRadius: 1
        },
        'cyberpunk': {
            mode: 'contours', interval: 15, lineWidth: 1.2, threshold: 60, lineColor: '#00ff99',
            invert: true, edgeGuidance: true, edgeSensitivity: 0.9, contourSmoothness: 0.2, contrast: 1.35
        },
        'ink-blot': {
            mode: 'stipple', interval: 4, lineWidth: 1.0, threshold: 30, lineColor: '#000000',
            invert: true, contrast: 1.15, inkBleed: 0.6
        },
        'ethereal': {
            mode: 'contours', interval: 4, lineWidth: 0.5, threshold: 20, lineColor: '#88ccff',
            invert: false, contourSmoothness: 0.9, detailLevel: 1.0, blurRadius: 2, inkBleed: 0.3
        },
        'sketch': {
            mode: 'hatch', interval: 8, lineWidth: 0.5, threshold: 50, lineColor: '#000000',
            invert: true, blurRadius: 1
        },
        'topo-map': {
            mode: 'contours', interval: 12, lineWidth: 1.0, threshold: 50, lineColor: '#1a1a1a',
            invert: true, edgeGuidance: false, contourSmoothness: 0.85, blurRadius: 1
        },
        'blueprint': {
            mode: 'contours', interval: 8, lineWidth: 0.8, threshold: 45, lineColor: '#0055ff',
            invert: true, edgeGuidance: true, edgeSensitivity: 0.8, contrast: 1.15
        },
        'flowing-silk': {
            mode: 'streamlines', interval: 6, lineWidth: 0.8, threshold: 45, lineColor: '#1a1a2e',
            invert: true, contourSmoothness: 0.95, blurRadius: 2
        },
        'marble-flow': {
            mode: 'streamlines', interval: 10, lineWidth: 1.5, threshold: 50, lineColor: '#2c3e50',
            invert: true, contourSmoothness: 0.8, blurRadius: 1
        },
        'ink-stipple': {
            mode: 'stipple', interval: 10, lineWidth: 1.0, threshold: 40, lineColor: '#000000', invert: true
        },
        'tangled-string': {
            mode: 'tsp', interval: 8, lineWidth: 0.5, threshold: 55, lineColor: '#000000', invert: true
        }
    };

    var BASE_TITLE = document.title;
    var isPageVisible = true;
    var selection = null;
    var appRef = null;
    var extras = { whiteBackground: false };

    function $(id) { return document.getElementById(id); }

    function formatValue(control, value) {
        if (control.kind !== 'number') return String(value);
        return Number(value).toFixed(control.format != null ? control.format : 2);
    }

    function setControl(control, value) {
        var el = $(control.id);
        if (!el) return;
        if (control.kind === 'bool') el.checked = !!value;
        else el.value = value;
        var readout = $(control.id + 'Value');
        if (readout) readout.textContent = formatValue(control, value);
    }

    function readOptions() {
        var options = {};
        for (var i = 0; i < CONTROLS.length; i++) {
            var c = CONTROLS[i];
            var el = $(c.id);
            if (!el) continue;
            if (c.kind === 'bool') options[c.key] = el.checked;
            else if (c.kind === 'number') options[c.key] = parseFloat(el.value);
            else options[c.key] = el.value;
        }
        options.preset = $('presetSelect').value;
        options.whiteBackground = extras.whiteBackground === true;
        return options;
    }

    function updateLabels() {
        for (var i = 0; i < CONTROLS.length; i++) {
            var c = CONTROLS[i];
            if (c.kind !== 'number') continue;
            var el = $(c.id);
            if (el) setControl(c, el.value);
        }
    }

    function syncModeUI() {
        var mode = $('modeSelect').value;
        var hasWire = mode === 'subject-wire';
        $('secAdaptive').style.display = mode === 'contours' ? 'block' : 'none';
        $('secSubjectWire').style.display = hasWire ? 'block' : 'none';
        $('selectionBtn').style.display = hasWire ? 'none' : 'block';
        if (hasWire) hideSelection();
        var label = document.querySelector('#secParams .field-top:first-of-type label');
        if (label) {
            label.textContent = mode === 'streamlines' ? 'Streamline Spacing'
                : mode === 'hatch' ? 'Hatch Spacing'
                : (mode === 'stipple' || mode === 'tsp') ? 'Point Density' : 'Level Step';
        }
        $('edgeSensitivity').disabled = !$('edgeGuidance').checked;
    }

    function applyPreset(name) {
        var preset = PRESETS[name];
        if (!preset) return;
        extras.whiteBackground = preset.whiteBackground === true;
        if (preset.mode) $('modeSelect').value = preset.mode;
        for (var key in preset) {
            if (key === 'mode' || key === 'whiteBackground') continue;
            var control = BY_KEY[key];
            if (control) setControl(control, preset[key]);
        }
        syncModeUI();
        updateLabels();
        var select = $('presetSelect');
        var label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].text : name;
        showStatus('Applied preset: ' + label, 'info');
    }

    function showStatus(message, type) {
        var status = $('status');
        status.textContent = message;
        status.className = 'status ' + type;
        status.style.display = 'block';
        var captured = message;
        setTimeout(function () {
            if (status.textContent === captured) status.style.display = 'none';
        }, 5000);
    }

    function updateProgress(show, percent, text) {
        var container = $('progressContainer');
        var fill = $('progressFill');
        var label = $('progressText');
        if (!show) { container.style.display = 'none'; return; }
        container.style.display = 'block';
        if (percent != null) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
        if (text) label.textContent = text;
        if (!isPageVisible && percent != null) {
            document.title = (percent >= 100 ? '✓ Complete' : '[' + percent.toFixed(0) + '%] Processing...') + ' | ' + BASE_TITLE;
            if (percent >= 100 && 'Notification' in window && Notification.permission === 'granted') {
                setTimeout(function () {
                    new Notification('Processing Complete!', { body: 'Your Marching Waves artwork is ready.' });
                }, 600);
            }
        }
    }

    function resetTitle() { document.title = BASE_TITLE; }

    function setPerformance(perf, visible) {
        var stats = $('perfStats');
        var text = '';
        for (var key in perf) {
            text += key + ': ' + perf[key] + '\n';
        }
        stats.textContent = text;
        stats.classList.toggle('visible', !!visible);
    }

    function setGenerateEnabled(enabled) { $('generateBtn').disabled = !enabled; }
    function setExportEnabled(enabled) { $('exportBtn').disabled = !enabled; }

    function setRunning(running) {
        $('generateBtn').disabled = running || !appRef || !appRef.hasImage();
        $('cancelBtnContainer').classList.toggle('visible', running);
        $('pauseBtn').style.display = running ? 'block' : 'none';
        $('resumeBtn').style.display = 'none';
        if (!running) $('progressContainer').style.display = 'none';
    }

    function setPaused(paused) {
        $('pauseBtn').style.display = paused ? 'none' : 'block';
        $('resumeBtn').style.display = paused ? 'block' : 'none';
    }

    function imageLoaded(url) {
        var preview = $('dropPreview');
        preview.src = url;
        preview.style.display = 'block';
        $('placeholder').style.display = 'none';
        $('previewContainer').classList.add('has-image');
        $('canvasContainer').style.display = 'none';
        setGenerateEnabled(true);
        setExportEnabled(false);
        updateProgress(false);
    }

    function showCanvas() {
        $('dropPreview').style.display = 'none';
        $('canvasContainer').style.display = 'flex';
    }

    function resetOutput() {
        $('dropPreview').src = '';
        $('dropPreview').style.display = 'none';
        $('placeholder').style.display = 'block';
        $('previewContainer').classList.remove('has-image');
        $('canvasContainer').style.display = 'none';
        $('generateBtn').disabled = true;
        $('exportBtn').disabled = true;
        $('selectionBtn').style.display = 'block';
        $('rerunBtn').style.display = 'none';
        $('fileInput').value = '';
        $('progressContainer').style.display = 'none';
        $('status').style.display = 'none';
        $('perfStats').textContent = '';
        hideSelection();
    }

    function hideSelection() {
        $('selectionOverlay').classList.remove('active');
        $('selectionOverlay').style.display = 'none';
        $('selectionBox').style.display = 'none';
        $('rerunBtn').style.display = 'none';
        selection = null;
    }

    function initSelection() {
        var overlay = $('selectionOverlay');
        var box = $('selectionBox');
        var canvas = $('outputCanvas');
        var enabled = false;
        var selecting = false;
        var startX = 0, startY = 0;

        overlay.addEventListener('mousedown', function (e) {
            if (!enabled) return;
            var canvasRect = canvas.getBoundingClientRect();
            if (e.clientX < canvasRect.left || e.clientX > canvasRect.right ||
                e.clientY < canvasRect.top || e.clientY > canvasRect.bottom) return;
            selecting = true;
            var overlayRect = overlay.getBoundingClientRect();
            startX = e.clientX - overlayRect.left;
            startY = e.clientY - overlayRect.top;
            box.style.left = startX + 'px';
            box.style.top = startY + 'px';
            box.style.width = '0px';
            box.style.height = '0px';
            box.style.display = 'block';
        });

        overlay.addEventListener('mousemove', function (e) {
            if (!selecting) return;
            var overlayRect = overlay.getBoundingClientRect();
            var curX = e.clientX - overlayRect.left;
            var curY = e.clientY - overlayRect.top;
            box.style.left = Math.min(startX, curX) + 'px';
            box.style.top = Math.min(startY, curY) + 'px';
            box.style.width = Math.abs(curX - startX) + 'px';
            box.style.height = Math.abs(curY - startY) + 'px';
        });

        overlay.addEventListener('mouseup', function () {
            if (!selecting) return;
            selecting = false;
            var w = parseFloat(box.style.width);
            var h = parseFloat(box.style.height);
            if (w < 5 || h < 5) { hideSelection(); return; }
            var overlayRect = overlay.getBoundingClientRect();
            var canvasRect = canvas.getBoundingClientRect();
            var relX = parseFloat(box.style.left) - (canvasRect.left - overlayRect.left);
            var relY = parseFloat(box.style.top) - (canvasRect.top - overlayRect.top);
            var scaleX = canvas.width / canvasRect.width;
            var scaleY = canvas.height / canvasRect.height;
            selection = {
                x: Math.max(0, relX * scaleX),
                y: Math.max(0, relY * scaleY),
                w: w * scaleX,
                h: h * scaleY
            };
            if (selection.x + selection.w > canvas.width) selection.w = canvas.width - selection.x;
            if (selection.y + selection.h > canvas.height) selection.h = canvas.height - selection.y;
            $('rerunBtn').style.display = 'block';
        });

        return {
            enable: function () {
                enabled = true;
                overlay.classList.add('active');
                overlay.style.display = 'block';
            },
            disable: function () { enabled = false; hideSelection(); },
            getSelection: function () { return selection ? { x: selection.x, y: selection.y, w: selection.w, h: selection.h } : null; }
        };
    }

    function initInfoIcons() {
        var isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        var icons = document.querySelectorAll('.info-icon');
        if (isTouch) {
            var current = null;
            icons.forEach(function (icon) {
                icon.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (current && current !== this) current.classList.remove('active');
                    this.classList.toggle('active');
                    current = this.classList.contains('active') ? this : null;
                });
            });
            document.addEventListener('click', function (e) {
                if (current && !e.target.classList.contains('info-icon')) {
                    current.classList.remove('active');
                    current = null;
                }
            });
        }
        icons.forEach(function (icon) {
            icon.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (isTouch) this.click();
                }
                if (e.key === 'Escape') { this.classList.remove('active'); this.blur(); }
            });
        });
    }

    function init(app) {
        appRef = app;
        var selectionManager = initSelection();
        updateLabels();
        syncModeUI();

        $('presetSelect').addEventListener('change', function (e) {
            if (e.target.value !== 'custom') applyPreset(e.target.value);
            else extras.whiteBackground = false;
        });
        $('modeSelect').addEventListener('change', syncModeUI);

        for (var i = 0; i < CONTROLS.length; i++) {
            (function (control) {
                var el = $(control.id);
                if (!el || control.kind === 'enum' || control.kind === 'color') return;
                el.addEventListener('input', function () {
                    if (control.kind === 'number') {
                        var readout = $(control.id + 'Value');
                        if (readout) readout.textContent = formatValue(control, el.value);
                    }
                    if (control.id === 'edgeGuidance') {
                        $('edgeSensitivity').disabled = !el.checked;
                    }
                });
            })(CONTROLS[i]);
        }

        $('debugMode').addEventListener('change', function (e) {
            var on = e.target.checked;
            $('vizModeGroup').style.display = on ? 'block' : 'none';
            $('originGroup').style.display = on ? 'flex' : 'none';
            $('gridGroup').style.display = on ? 'flex' : 'none';
            $('perfGroup').style.display = on ? 'flex' : 'none';
            $('perfStats').classList.toggle('visible', on && $('showPerf').checked);
        });
        $('showPerf').addEventListener('change', function (e) {
            $('perfStats').classList.toggle('visible', e.target.checked);
        });

        $('generateBtn').addEventListener('click', function () { app.generate(); });
        $('cancelBtn').addEventListener('click', function () {
            showStatus('Cancelling...', 'warning');
            app.cancel();
        });
        $('pauseBtn').addEventListener('click', function () { app.pause(); setPaused(true); });
        $('resumeBtn').addEventListener('click', function () { app.resume(); setPaused(false); });

        $('selectionBtn').addEventListener('click', function () {
            var btn = $('selectionBtn');
            if ($('selectionOverlay').classList.contains('active')) {
                selectionManager.disable();
                btn.textContent = 'Select Area to Rerun';
                btn.classList.remove('btn-primary');
                btn.classList.add('btn-secondary');
            } else {
                selectionManager.enable();
                btn.textContent = 'Cancel Selection';
                btn.classList.remove('btn-secondary');
                btn.classList.add('btn-primary');
                showStatus('Click and drag on the canvas to select an area', 'info');
            }
        });
        $('rerunBtn').addEventListener('click', function () {
            var rect = selectionManager.getSelection();
            if (rect) app.rerunRegion(rect);
        });

        $('exportBtn').addEventListener('click', function () { app.exportSVG(); });
        $('clearBtn').addEventListener('click', function () {
            app.clear();
            resetOutput();
        });
        $('sampleBtn').addEventListener('click', function () { app.loadSample(); });

        $('dropZone').addEventListener('click', function () { $('fileInput').click(); });
        $('dropZone').addEventListener('dragover', function (e) {
            e.preventDefault();
            $('dropZone').classList.add('dragover');
        });
        $('dropZone').addEventListener('dragleave', function () { $('dropZone').classList.remove('dragover'); });
        $('dropZone').addEventListener('drop', function (e) {
            e.preventDefault();
            $('dropZone').classList.remove('dragover');
            var file = e.dataTransfer.files[0];
            if (file && file.type.indexOf('image/') === 0) app.loadFile(file);
        });
        $('fileInput').addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (file) app.loadFile(file);
        });

        document.addEventListener('click', function () {
            if ('Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }
        }, { once: true });

        document.addEventListener('visibilitychange', function () {
            isPageVisible = !document.hidden;
            if (isPageVisible && !app.isRunning()) resetTitle();
        });

        initInfoIcons();

        window.addEventListener('beforeunload', function () { app.dispose(); });

        return { selectionManager: selectionManager };
    }

    return {
        CONTROLS: CONTROLS,
        PRESETS: PRESETS,
        init: init,
        readOptions: readOptions,
        applyPreset: applyPreset,
        showStatus: showStatus,
        updateProgress: updateProgress,
        resetTitle: resetTitle,
        setPerformance: setPerformance,
        setGenerateEnabled: setGenerateEnabled,
        setExportEnabled: setExportEnabled,
        setRunning: setRunning,
        setPaused: setPaused,
        imageLoaded: imageLoaded,
        showCanvas: showCanvas,
        resetOutput: resetOutput,
        updateLabels: updateLabels,
        syncModeUI: syncModeUI
    };
})();
