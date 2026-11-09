// Single persistent background worker client.
var WorkerClient = (function () {
    'use strict';

    function cancelledError() {
        var e = new Error('Cancelled');
        e.name = 'CancelledError';
        return e;
    }

    function WorkerClient() {
        this.worker = null;
        this.ready = false;
        this.initPromise = null;
        this.taskSeq = 0;
        this.active = null;
        this.frameId = 0;
        this._onMessage = this._onMessage.bind(this);
        this._onError = this._onError.bind(this);
    }

    WorkerClient.prototype.init = function () {
        if (this.initPromise) return this.initPromise;
        var self = this;
        this.initPromise = new Promise(function (resolve) {
            if (typeof Worker === 'undefined') { resolve(false); return; }
            var settled = false;
            var timer = null;
            function finish(ok) {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                self.ready = ok;
                resolve(ok);
            }
            try {
                self.worker = new Worker('worker.js');
            } catch (error) {
                self.initError = error;
                finish(false);
                return;
            }
            self.worker.onmessage = function (e) {
                if (e.data && e.data.t === 'ready') finish(true);
                self._onMessage(e);
            };
            self.worker.onerror = function (error) {
                self.initError = error;
                finish(false);
                self._onError(error);
            };
            self.worker.onmessageerror = function (error) {
                self._onError(error);
            };
            timer = setTimeout(function () {
                self.initError = new Error('Worker startup timed out');
                finish(false);
            }, 8000);
        });
        return this.initPromise;
    };

    WorkerClient.prototype.uploadFrame = function (data) {
        if (!this.worker || !this.ready) throw new Error('Worker not ready');
        this.frameId++;
        var transfers = [];
        if (data.gray) transfers.push(data.gray.buffer);
        if (data.gradMag) transfers.push(data.gradMag.buffer);
        if (data.edgeDistance) transfers.push(data.edgeDistance.buffer);
        if (data.solution) transfers.push(data.solution.buffer);
        this.worker.postMessage({
            t: 'frame',
            frameId: this.frameId,
            width: data.width,
            height: data.height,
            gray: data.gray,
            gradMag: data.gradMag || null,
            edgeDistance: data.edgeDistance || null,
            solution: data.solution || null
        }, transfers);
        return this.frameId;
    };

    WorkerClient.prototype.run = function (opts) {
        var self = this;
        if (!this.worker || !this.ready) return Promise.reject(new Error('Worker not ready'));
        if (this.active) this.cancel();
        var id = ++this.taskSeq;
        return new Promise(function (resolve, reject) {
            self.active = {
                id: id,
                resolve: resolve,
                reject: reject,
                onProgress: opts.onProgress || null,
                onWavefront: opts.onWavefront || null
            };
            self.worker.postMessage({
                t: 'run',
                taskId: id,
                frameId: opts.frameId != null ? opts.frameId : self.frameId,
                mode: opts.mode,
                params: opts.params || {},
                bounds: opts.bounds || null,
                debug: opts.debug || null,
                streamWavefront: !!opts.streamWavefront,
                showProgress: opts.showProgress !== false
            });
        });
    };

    WorkerClient.prototype.cancel = function () {
        var task = this.active;
        if (!task) return;
        this.active = null;
        if (this.worker) this.worker.postMessage({ t: 'cancel', taskId: task.id });
        task.reject(cancelledError());
    };

    WorkerClient.prototype.pause = function () {
        if (this.active && this.worker) this.worker.postMessage({ t: 'pause', taskId: this.active.id });
    };

    WorkerClient.prototype.resume = function () {
        if (this.active && this.worker) this.worker.postMessage({ t: 'resume', taskId: this.active.id });
    };

    WorkerClient.prototype.release = function () {
        if (this.worker) this.worker.postMessage({ t: 'release' });
        this.frameId = 0;
    };

    WorkerClient.prototype.dispose = function () {
        this.active = null;
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.ready = false;
        this.initPromise = null;
    };

    WorkerClient.prototype._onMessage = function (e) {
        var msg = e.data;
        if (!msg || !msg.t) return;
        if (msg.t === 'ready') return;
        var task = this.active;
        if (!task || msg.taskId !== task.id) return;
        switch (msg.t) {
            case 'progress':
                if (task.onProgress) task.onProgress(msg.percent, msg.label);
                break;
            case 'wavefront':
                if (task.onWavefront) task.onWavefront(msg.indices, msg.values);
                break;
            case 'result':
                this.active = null;
                task.resolve(msg.artwork);
                break;
            case 'cancelled':
                this.active = null;
                task.reject(cancelledError());
                break;
            case 'error':
                this.active = null;
                task.reject(new Error(msg.message || 'Worker error'));
                break;
        }
    };

    WorkerClient.prototype._onError = function (error) {
        var task = this.active;
        this.active = null;
        this.ready = false;
        if (task) task.reject(error instanceof Error ? error : new Error('Worker failed'));
    };

    return WorkerClient;
})();
