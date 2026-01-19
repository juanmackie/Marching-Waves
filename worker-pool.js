// Worker Pool Management for Marching Waves
// Manages multiple workers for parallel processing

class WorkerPool {
    constructor(maxWorkers = navigator.hardwareConcurrency || 4) {
        this.maxWorkers = Math.min(maxWorkers, navigator.hardwareConcurrency || 4);
        this.workers = [];
        this.taskQueue = [];
        this.activeTasks = new Map();
        this.taskIdCounter = 0;
        this.initialized = false;
        this.idleWorkerCleanupInterval = 60000; // 60 seconds
        this.minIdleWorkers = 1; // Keep at least 1 worker for quick startup
        this.cleanupTimer = null;
    }

    async init() {
        if (this.initialized) return;
        
        try {
            // Create initial pool of workers
            for (let i = 0; i < this.maxWorkers; i++) {
                await this.createWorker();
            }
            
            this.initialized = true;
            console.log(`Worker pool initialized with ${this.workers.length} workers`);
            return true;
        } catch (error) {
            console.error('Worker pool initialization failed:', error);
            this.initialized = false;
            throw error;
        }
    }

    async createWorker() {
        return new Promise((resolve, reject) => {
            try {
                const worker = new Worker('worker.js');
                
                worker.onmessage = (e) => {
                    const { type, taskId, percent, message, data, error, performance } = e.data;
                    const task = this.activeTasks.get(taskId);

                    if (!task) return;

                    // Update worker activity timestamp
                    worker.lastActive = Date.now();

                    switch (type) {
                        case 'progress':
                            if (task.onProgress) {
                                task.onProgress(percent, message);
                            }
                            break;

                        case 'result':
                            // Mark task as complete
                            task.worker.taskCount--;
                            console.log(`Task ${taskId} completed, worker task count: ${task.worker.taskCount}`);
                            task.resolve({ data, performance });
                            this.activeTasks.delete(taskId);

                            // Send cleanup message to worker to release memory
                            worker.postMessage({ type: 'cleanup' });

                            // Schedule idle worker cleanup
                            this.scheduleCleanup();

                            // Process next task in queue
                            this.processQueue();
                            break;

                        case 'error':
                            task.worker.taskCount--;
                            console.error(`Task ${taskId} failed:`, error);
                            task.reject(new Error(error.message));
                            this.activeTasks.delete(taskId);

                            // Send cleanup message to worker
                            worker.postMessage({ type: 'cleanup' });

                            // Schedule idle worker cleanup
                            this.scheduleCleanup();

                            // Process next task in queue
                            this.processQueue();
                            break;
                    }
                };
                
                worker.onerror = (error) => {
                    console.error('Worker error:', error);
                    reject(error);
                };

                worker.onload = () => {
                    console.log('Worker loaded successfully');
                };

                worker.taskCount = 0;
                worker.lastActive = Date.now();
                this.workers.push(worker);
                resolve(worker);
            } catch (error) {
                console.error('Failed to create worker:', error);
                reject(error);
            }
        });
    }

    async execute(method, params, options = {}) {
        if (!this.initialized) {
            await this.init();
        }
        
        // Generate unique task ID
        const taskId = `task_${++this.taskIdCounter}`;
        
        // Find or create an available worker
        const worker = await this.getAvailableWorker();
        if (!worker) {
            throw new Error('No available workers');
        }
        
        // Create task promise
        const task = {
            taskId,
            method,
            params,
            options,
            worker,
            onProgress: options.onProgress || null,
            resolve: null,
            reject: null
        };
        
        const promise = new Promise((resolve, reject) => {
            task.resolve = resolve;
            task.reject = reject;
        });
        
        this.activeTasks.set(taskId, task);
        worker.taskCount++;
        
        // Attach taskId to the promise for cancellation
        promise.taskId = taskId;
        promise.worker = worker;
        
        // Extract onProgress callback and create clean options for worker
        const { onProgress, ...optionsWithoutCallback } = options;
        
        // Send task to worker
        worker.postMessage({
            type: 'execute',
            taskId,
            method,
            params,
            options: optionsWithoutCallback
        });
        
        return promise;
    }

    async getAvailableWorker() {
        // Find worker with least tasks
        let availableWorker = null;
        let minTasks = Infinity;
        
        for (const worker of this.workers) {
            if (worker.taskCount < minTasks) {
                minTasks = worker.taskCount;
                availableWorker = worker;
            }
        }
        
        // If all workers are busy and we have capacity, create new worker
        if (minTasks > 1 && this.workers.length < this.maxWorkers) {
            await this.createWorker();
            return this.workers[this.workers.length - 1];
        }
        
        return availableWorker;
    }

    async executeParallel(tasks, options = {}) {
        const promises = tasks.map(task => 
            this.execute(task.method, task.params, {
                ...options,
                onProgress: task.onProgress
            })
        );
        
        return Promise.all(promises);
    }

    processQueue() {
        // Tasks are processed immediately when workers are available
        // This method can be enhanced for better queuing strategy
    }

    async cancelTask(taskId) {
        const task = this.activeTasks.get(taskId);
        if (!task) return;
        
        // Send cancel signal to worker
        task.worker.postMessage({
            type: 'cancel',
            taskId
        });
        
        // Remove from active tasks
        this.activeTasks.delete(taskId);
        task.worker.taskCount--;
    }

    async pauseTask(taskId) {
        const task = this.activeTasks.get(taskId);
        if (!task) return;
        
        // Send pause signal to worker
        task.worker.postMessage({
            type: 'pause',
            taskId
        });
    }

    async resumeTask(taskId) {
        const task = this.activeTasks.get(taskId);
        if (!task) return;
        
        // Send resume signal to worker
        task.worker.postMessage({
            type: 'resume',
            taskId
        });
    }

    async terminateAll() {
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        this.activeTasks.clear();
        this.initialized = false;
    }

    getStats() {
        return {
            totalWorkers: this.workers.length,
            activeWorkers: this.workers.filter(w => w.taskCount > 0).length,
            queuedTasks: this.taskQueue.length,
            activeTasks: this.activeTasks.size
        };
    }

    broadcastVisibility(isVisible) {
        for (const worker of this.workers) {
            worker.postMessage({
                type: 'visibility',
                isVisible: isVisible
            });
            worker.lastActive = Date.now();
        }
    }

    scheduleCleanup() {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
        }
        this.cleanupTimer = setTimeout(() => {
            this.cleanupIdleWorkers();
        }, this.idleWorkerCleanupInterval);
    }

    cleanupIdleWorkers() {
        const now = Date.now();
        const activeWorkers = this.workers.filter(w => w.taskCount > 0).length;

        // Keep at least minIdleWorkers + activeWorkers
        const minWorkers = this.minIdleWorkers + activeWorkers;

        if (this.workers.length <= minWorkers) {
            console.log('Worker pool: No idle workers to terminate');
            return;
        }

        // Find idle workers (no active tasks and idle longer than timeout)
        const idleWorkers = this.workers.filter(w =>
            w.taskCount === 0 && (now - w.lastActive) > this.idleWorkerCleanupInterval
        );

        const toTerminate = idleWorkers.slice(0, this.workers.length - minWorkers);

        if (toTerminate.length > 0) {
            console.log(`Terminating ${toTerminate.length} idle workers (active: ${activeWorkers}, total: ${this.workers.length})`);
            for (const worker of toTerminate) {
                try {
                    worker.terminate();
                    const index = this.workers.indexOf(worker);
                    if (index > -1) {
                        this.workers.splice(index, 1);
                    }
                } catch (error) {
                    console.error('Error terminating worker:', error);
                }
            }
        }
    }

    terminateIdleWorkers() {
        // Force cleanup of all idle workers (called on page hide or manual trigger)
        const now = Date.now();
        const activeWorkers = this.workers.filter(w => w.taskCount > 0);

        const idleWorkers = this.workers.filter(w => w.taskCount === 0);
        const toTerminate = idleWorkers.slice(0, idleWorkers.length - this.minIdleWorkers);

        if (toTerminate.length > 0) {
            console.log(`Force terminating ${toTerminate.length} idle workers`);
            for (const worker of toTerminate) {
                try {
                    worker.terminate();
                } catch (error) {
                    console.error('Error terminating worker:', error);
                }
            }
            this.workers = [...activeWorkers, ...idleWorkers.slice(toTerminate.length)];
        }
    }

    // Add memory pressure detection
    checkMemoryPressure() {
        if (typeof performance !== 'undefined' && performance.memory) {
            const memory = performance.memory;
            const usageRatio = memory.usedJSHeapSize / memory.jsHeapSizeLimit;

            if (usageRatio > 0.8) {
                console.warn('Memory pressure detected, cleaning up workers');
                this.terminateIdleWorkers();

                // Also suggest GC
                if (typeof gc === 'function') {
                    gc();
                }
            }
        }
    }
}

// Global worker pool instance
let globalWorkerPool = null;

function getWorkerPool() {
    if (!globalWorkerPool) {
        globalWorkerPool = new WorkerPool();
    }
    return globalWorkerPool;
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (globalWorkerPool) {
        globalWorkerPool.terminateAll();
    }
});
