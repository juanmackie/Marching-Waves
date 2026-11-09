// Marching Waves worker — thin RPC over the shared flat kernels.
importScripts('js/engine.js', 'js/subject-wire.js');

var frame = null;
var activeTask = null;
var frameReady = false;

var yieldChannel = new MessageChannel();
var yieldResolve = null;
yieldChannel.port1.onmessage = function () {
    if (yieldResolve) {
        var r = yieldResolve;
        yieldResolve = null;
        r();
    }
};
function yieldTick() {
    return new Promise(function (resolve) {
        yieldResolve = resolve;
        yieldChannel.port2.postMessage(0);
    });
}

function cancelledError() {
    var e = new Error('Cancelled');
    e.name = 'CancelledError';
    return e;
}

self.postMessage({ t: 'ready' });

self.onmessage = function (e) {
    var msg = e.data;
    if (!msg) return;
    switch (msg.t) {
        case 'frame':
            frame = {
                width: msg.width,
                height: msg.height,
                gray: msg.gray,
                gradMag: msg.gradMag || null,
                edgeDistance: msg.edgeDistance || null,
                solution: msg.solution || null,
                id: msg.frameId
            };
            frameReady = true;
            break;
        case 'release':
            frame = null;
            frameReady = false;
            break;
        case 'run':
            if (activeTask) {
                self.postMessage({ t: 'error', taskId: msg.taskId, message: 'Worker busy' });
                return;
            }
            startTask(msg);
            break;
        case 'cancel':
            if (activeTask && activeTask.id === msg.taskId) {
                activeTask.cancelled = true;
                if (activeTask.pauseResolve) {
                    activeTask.pauseResolve();
                    activeTask.pauseResolve = null;
                }
            }
            break;
        case 'pause':
            if (activeTask && activeTask.id === msg.taskId) activeTask.paused = true;
            break;
        case 'resume':
            if (activeTask && activeTask.id === msg.taskId) {
                activeTask.paused = false;
                if (activeTask.pauseResolve) {
                    activeTask.pauseResolve();
                    activeTask.pauseResolve = null;
                }
            }
            break;
    }
};

async function startTask(msg) {
    var task = { id: msg.taskId, cancelled: false, paused: false, pauseResolve: null };
    activeTask = task;
    var t0 = performance.now();
    var waveIndices = null, waveValues = null, waveN = 0;

    function flushWave() {
        if (!waveN) return;
        var idx = waveIndices.slice(0, waveN);
        var vals = waveValues.slice(0, waveN);
        self.postMessage({ t: 'wavefront', taskId: msg.taskId, indices: idx, values: vals },
            [idx.buffer, vals.buffer]);
        waveN = 0;
    }

    try {
        if (!frame || !frame.gray) throw new Error('No image frame uploaded');
        if (msg.frameId != null && frame.id !== msg.frameId) throw new Error('Stale frame');

        var width = frame.width, height = frame.height, gray = frame.gray;
        var mode = msg.mode;
        var params = msg.params || {};
        var showProgress = msg.showProgress !== false;

        if (!frame.gradMag) {
            frame.gradMag = Engine.sobel(gray, width, height, false).gradMag;
        }
        if ((mode === 'contours' || mode === 'streamlines') && !frame.solution) {
            // solved inside Engine.generate; onSolution caches it on the frame
        }
        if (mode === 'contours' && params.edgeGuidance !== false && !frame.edgeDistance) {
            var mask = new Uint8Array(gray.length);
            for (var mi = 0; mi < mask.length; mi++) mask[mi] = frame.gradMag[mi] > 0.12 ? 1 : 0;
            frame.edgeDistance = Engine.chamfer(mask, width, height);
        }

        if (msg.streamWavefront) {
            waveIndices = new Uint32Array(4000);
            waveValues = new Float32Array(4000);
        }

        var hooks = {
            progress: function (fraction, label) {
                if (!showProgress) return;
                self.postMessage({
                    t: 'progress',
                    taskId: msg.taskId,
                    percent: Math.max(0, Math.min(100, fraction * 100)),
                    label: label || ''
                });
            },
            checkpoint: async function () {
                await yieldTick();
                if (task.cancelled) throw cancelledError();
                while (task.paused && !task.cancelled) {
                    await new Promise(function (resolve) { task.pauseResolve = resolve; });
                    task.pauseResolve = null;
                }
                if (task.cancelled) throw cancelledError();
            },
            onWave: function (index, value) {
                if (!waveIndices) return;
                waveIndices[waveN] = index;
                waveValues[waveN] = value;
                waveN++;
                if (waveN === 4000) flushWave();
            },
            onSolution: function (solution) {
                frame.solution = solution;
            },
            onEdgeDistance: function (edgeDistance) {
                frame.edgeDistance = edgeDistance;
            }
        };

        var artwork = await Engine.generate({
            gray: gray,
            gradMag: frame.gradMag,
            edgeDistance: frame.edgeDistance,
            solution: frame.solution,
            width: width,
            height: height,
            mode: mode,
            params: params,
            bounds: msg.bounds || null,
            debug: msg.debug || null,
            hooks: hooks
        });

        flushWave();
        var elapsed = performance.now() - t0;
        artwork.perf = {
            totalMs: elapsed,
            paths: artwork.geometry.count,
            points: Engine.pointCount(artwork.geometry)
        };

        var transfers = [];
        var g = artwork.geometry;
        transfers.push(g.offsets.buffer, g.xy.buffer, g.radius.buffer, g.widths.buffer);
        if (artwork.raw) transfers.push(artwork.raw.xy.buffer, artwork.raw.level.buffer);
        if (artwork.origins) transfers.push(artwork.origins.buffer);
        if (artwork.gray) artwork.gray = artwork.gray.slice();
        if (artwork.solution) artwork.solution = artwork.solution.slice();
        if (artwork.gray) transfers.push(artwork.gray.buffer);
        if (artwork.solution) transfers.push(artwork.solution.buffer);

        self.postMessage({ t: 'result', taskId: msg.taskId, artwork: artwork }, transfers);
    } catch (error) {
        if (error && error.name === 'CancelledError') {
            self.postMessage({ t: 'cancelled', taskId: msg.taskId });
        } else {
            self.postMessage({
                t: 'error',
                taskId: msg.taskId,
                message: (error && error.message) || String(error),
                stack: error && error.stack
            });
        }
    } finally {
        activeTask = null;
    }
}
