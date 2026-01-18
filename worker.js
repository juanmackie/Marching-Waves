// Web Worker for Marching Waves - CPU-intensive computations
// This worker handles all processing that should continue in background tabs

self.onmessage = function(e) {
    const { type, taskId, method, params, options } = e.data;
    
    try {
        switch (method) {
            case 'solveEikonalCPU':
                handleSolveEikonalCPU(taskId, params, options);
                break;
            case 'extractContoursAdaptive':
                handleExtractContoursAdaptive(taskId, params, options);
                break;
            case 'extractStreamlines':
                handleExtractStreamlines(taskId, params, options);
                break;
            case 'extractStipple':
                handleExtractStipple(taskId, params, options);
                break;
            case 'extractTSP':
                handleExtractTSP(taskId, params, options);
                break;
            case 'extractHatch':
                handleExtractHatch(taskId, params, options);
                break;
            default:
                postError(taskId, `Unknown method: ${method}`);
        }
    } catch (error) {
        postError(taskId, error.message, error.stack);
    }
};

// Helper functions for posting messages
function postProgress(taskId, percent, message) {
    self.postMessage({
        type: 'progress',
        taskId,
        percent,
        message,
        timestamp: Date.now()
    });
}

function postResult(taskId, data, performance = {}, transferList = []) {
    self.postMessage({
        type: 'result',
        taskId,
        data,
        performance,
        timestamp: Date.now()
    }, transferList);
}

function postError(taskId, message, stack) {
    self.postMessage({
        type: 'error',
        taskId,
        error: { message, stack }
    });
}

// Check for cancellation or pause signals
let isCancelled = false;
let isPaused = false;
let pauseResolve = null;

self.onmessage = function(e) {
    const { type, taskId, method, params, options } = e.data;
    
    if (type === 'cancel') {
        isCancelled = true;
    } else if (type === 'pause') {
        isPaused = true;
    } else if (type === 'resume') {
        isPaused = false;
        if (pauseResolve) {
            pauseResolve();
            pauseResolve = null;
        }
    } else {
        // Regular task execution
        try {
            executeTask(taskId, method, params, options);
        } catch (error) {
            postError(taskId, error.message, error.stack);
        }
    }
};

async function executeTask(taskId, method, params, options) {
    // Reset state
    isCancelled = false;
    isPaused = false;
    pauseResolve = null;
    
    try {
        switch (method) {
            case 'solveEikonalCPU':
                await handleSolveEikonalCPU(taskId, params, options);
                break;
            case 'extractContoursAdaptive':
                await handleExtractContoursAdaptive(taskId, params, options);
                break;
            case 'extractStreamlines':
                await handleExtractStreamlines(taskId, params, options);
                break;
            case 'extractStipple':
                await handleExtractStipple(taskId, params, options);
                break;
            case 'extractTSP':
                await handleExtractTSP(taskId, params, options);
                break;
            case 'extractHatch':
                await handleExtractHatch(taskId, params, options);
                break;
            default:
                postError(taskId, `Unknown method: ${method}`);
        }
    } catch (error) {
        postError(taskId, error.message, error.stack);
    }
}

function checkCancelled() {
    if (isCancelled) {
        throw new Error('Cancelled by user');
    }
}

async function checkPause() {
    if (isPaused) {
        await new Promise(resolve => {
            pauseResolve = resolve;
        });
    }
}

function yieldToBrowser() {
    return new Promise(resolve => {
        setTimeout(resolve, 0);
    });
}

// ============================================
// CPU-BASED FAST MARCHING METHOD SOLVER
// ============================================
async function handleSolveEikonalCPU(taskId, params, options) {
    const { grayData, width, height, threshold } = params;
    const { showProgress } = options;
    
    const t0 = performance.now();
    
    const size = width * height;
    const solution = new Float32Array(size);
    solution.fill(Infinity);
    
    const visited = new Uint8Array(size);
    const heap = [];
    
    const idx = (x, y) => y * width + x;
    
    const safeGet = (x, y) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return Infinity;
        const val = solution[idx(x, y)];
        return (val === undefined || isNaN(val) || !isFinite(val)) ? Infinity : val;
    };
    
    // Initialize heap with seed points
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = idx(x, y);
            if (grayData[i] < threshold) {
                solution[i] = 0;
                visited[i] = 1;
                heap.push({ x, y, value: 0 });
            }
        }
    }
    
    // Heap operations
    const heapPush = (item) => {
        heap.push(item);
        let i = heap.length - 1;
        while (i > 0) {
            const parent = Math.floor((i - 1) / 2);
            if (heap[parent].value <= heap[i].value) break;
            [heap[parent], heap[i]] = [heap[i], heap[parent]];
            i = parent;
        }
    };
    
    const heapPop = () => {
        if (heap.length === 0) return null;
        const result = heap[0];
        const last = heap.pop();
        if (heap.length > 0) {
            heap[0] = last;
            let i = 0;
            while (true) {
                const left = 2 * i + 1;
                const right = 2 * i + 2;
                let smallest = i;
                if (left < heap.length && heap[left].value < heap[smallest].value) {
                    smallest = left;
                }
                if (right < heap.length && heap[right].value < heap[smallest].value) {
                    smallest = right;
                }
                if (smallest === i) break;
                [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
                i = smallest;
            }
        }
        return result;
    };
    
    // Fast Marching Method
    const f = grayData;
    let processed = 0;
    const batchSize = 1000;
    
    while (heap.length > 0) {
        const current = heapPop();
        if (!current) break;
        const { x, y } = current;
        const currentIdx = idx(x, y);
        visited[currentIdx] = 1;
        
        const neighbors = [
            { x: x - 1, y },
            { x: x + 1, y },
            { x, y: y - 1 },
            { x, y: y + 1 }
        ];
        
        for (const neighbor of neighbors) {
            if (neighbor.x < 0 || neighbor.x >= width || neighbor.y < 0 || neighbor.y >= height) continue;
            
            const nIdx = idx(neighbor.x, neighbor.y);
            if (visited[nIdx]) continue;
            
            const ux = safeGet(x - 1, y);
            const uy = safeGet(x, y - 1);
            const ux_next = safeGet(x + 1, y);
            const uy_next = safeGet(x, y + 1);
            
            const neighborsX = [];
            const neighborsY = [];
            
            if (ux < Infinity) neighborsX.push(ux);
            if (ux_next < Infinity) neighborsX.push(ux_next);
            if (uy < Infinity) neighborsY.push(uy);
            if (uy_next < Infinity) neighborsY.push(uy_next);
            
            let minX = neighborsX.length > 0 ? Math.min(...neighborsX) : Infinity;
            let minY = neighborsY.length > 0 ? Math.min(...neighborsY) : Infinity;
            
            let newValue;
            const fVal = f[nIdx];
            
            if (minX === Infinity && minY === Infinity) {
                continue;
            } else if (minX === Infinity) {
                newValue = minY + fVal;
            } else if (minY === Infinity) {
                newValue = minX + fVal;
            } else {
                const min = Math.min(minX, minY);
                const other = Math.max(minX, minY);
                if (other - min >= fVal) {
                    newValue = min + fVal;
                } else {
                    const discriminant = 2 * fVal * fVal - (other - min) * (other - min);
                    if (discriminant < 0) {
                        newValue = min + fVal;
                    } else {
                        newValue = (min + other + Math.sqrt(discriminant)) / 2;
                    }
                }
            }
            
            if (newValue < solution[nIdx]) {
                solution[nIdx] = newValue;
                heapPush({ x: neighbor.x, y: neighbor.y, value: newValue });
            }
        }
        
        // Periodic updates
        processed++;
        if (processed % batchSize === 0) {
            checkCancelled();
            await checkPause();
            
            if (showProgress) {
                const progress = processed / (width * height) * 100;
                postProgress(taskId, progress, `Solving Eikonal equation...`);
            }
            
            await yieldToBrowser();
        }
    }
    
    const t1 = performance.now();
    const performance = {
        totalMs: t1 - t0,
        method: 'CPU FMM',
        cellsProcessed: processed
    };
    
    // Transfer solution as transferable object for better performance
    postResult(taskId, { solution }, performance, [solution.buffer]);
}

// ============================================
// ADAPTIVE CONTOUR EXTRACTION
// ============================================
async function handleExtractContoursAdaptive(taskId, params, options) {
    const { solution, imageData, width, height, interval, maxSegments } = params;
    const { skipJoining, showProgress, edgeGuidance, edgeSensitivity, detailLevel, contourSmoothness } = options;
    
    const t0 = performance.now();
    
    // Compute edge map and gradient
    const edgeMap = edgeGuidance ? computeEdgeMap(imageData, width, height) : null;
    const { gradMag } = computeDistanceFieldGradient(solution, width, height);
    
    // Find min/max values
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < solution.length; i++) {
        const v = solution[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    
    // Generate adaptive levels
    const levels = generateAdaptiveLevels(solution, width, height, interval, min, max, gradMag, detailLevel);
    
    const safeGet = (x, y) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return Infinity;
        return solution[y * width + x];
    };
    
    const interp = (v1, v2, level) => {
        if (v1 === Infinity || v2 === Infinity) return 0.5;
        const diff = v2 - v1;
        if (Math.abs(diff) < 0.00001) return 0.5;
        return Math.max(0, Math.min(1, (level - v1) / diff));
    };
    
    const rawContours = [];
    let totalLines = 0;
    let processed = 0;
    
    for (const level of levels) {
        const levelLines = [];
        
        for (let y = 0; y < height - 1; y++) {
            for (let x = 0; x < width - 1; x++) {
                const v00 = safeGet(x, y);
                const v10 = safeGet(x + 1, y);
                const v01 = safeGet(x, y + 1);
                const v11 = safeGet(x + 1, y + 1);
                
                let code = 0;
                if (v00 >= level) code |= 1;
                if (v10 >= level) code |= 2;
                if (v01 >= level) code |= 4;
                if (v11 >= level) code |= 8;
                
                const lines = [];
                
                const addLine = (x1, y1, x2, y2) => {
                    if (edgeGuidance && edgeSensitivity > 0.1) {
                        const p1 = snapToEdge(x + x1, y + y1, level, edgeMap, solution, width, height, edgeSensitivity, interval);
                        const p2 = snapToEdge(x + x2, y + y2, level, edgeMap, solution, width, height, edgeSensitivity, interval);
                        lines.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
                    } else {
                        lines.push({ x1: x + x1, y1: y + y2, x2: x + x2, y2: y + y2 });
                    }
                };
                
                switch (code) {
                    case 1:
                    case 14:
                        addLine(0, interp(v00, v10, level), 0.5, 0); break;
                    case 2:
                    case 13:
                        addLine(0.5, 0, 1, interp(v10, v11, level)); break;
                    case 3:
                    case 12:
                        addLine(0, interp(v00, v10, level), 1, interp(v01, v11, level)); break;
                    case 4:
                    case 11:
                        addLine(0.5, 1, interp(v01, v11, level), 1); break;
                    case 5:
                        addLine(0, interp(v00, v10, level), 0.5, 1);
                        addLine(0.5, 0, interp(v01, v11, level), 1); break;
                    case 6:
                    case 9:
                        addLine(0.5, 0, 0.5, 1); break;
                    case 7:
                    case 8:
                        addLine(0, interp(v00, v10, level), 0.5, 1);
                        addLine(0.5, 0, 1, interp(v10, v11, level)); break;
                    case 10:
                        addLine(0, interp(v00, v10, level), 1, interp(v01, v11, level));
                        addLine(0.5, 0, 0.5, 1); break;
                }
                
                levelLines.push(...lines);
                
                // Periodic updates
                processed++;
                if (processed % 5000 === 0) {
                    checkCancelled();
                    await checkPause();
                    
                    if (showProgress) {
                        const progress = 60 + (processed / (width * height)) * 20;
                        postProgress(taskId, progress, `Extracting contours...`);
                    }
                    
                    await yieldToBrowser();
                }
            }
        }
        
        totalLines += levelLines.length;
        if (levelLines.length > 0) {
            rawContours.push({ level, lines: levelLines });
        }
    }
    
    const t1 = performance.now();
    const performance = {
        totalMs: t1 - t0,
        levelsProcessed: levels.length,
        linesExtracted: totalLines
    };
    
    postResult(taskId, { contours: [], raw: rawContours, skippedJoining: true }, performance);
}

// ============================================
// STREAMLINE EXTRACTION
// ============================================
async function handleExtractStreamlines(taskId, params, options) {
    const { solution, grayData, width, height } = params;
    const { interval = 8, maxSegments = 50000, threshold = 0.5, edgeSensitivity = 0.5, showProgress } = options;
    
    const t0 = performance.now();
    
    const { gradX, gradY } = computeDistanceFieldGradient(solution, width, height);
    
    // Generate seeds
    const seeds = [];
    const seedSpacing = interval;
    for (let y = seedSpacing; y < height - seedSpacing; y += seedSpacing) {
        for (let x = seedSpacing; x < width - seedSpacing; x += seedSpacing) {
            const idx = Math.floor(y) * width + Math.floor(x);
            if (grayData[idx] < threshold) {
                seeds.push({
                    x: x + (Math.random() - 0.5) * seedSpacing * 0.5,
                    y: y + (Math.random() - 0.5) * seedSpacing * 0.5
                });
            }
        }
    }
    
    // Shuffle seeds
    for (let i = seeds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [seeds[i], seeds[j]] = [seeds[j], seeds[i]];
    }
    
    const paths = [];
    const stepSize = 2.0;
    const maxPathPoints = 500;
    const minPathLength = 10;
    const separation = interval * 0.8;
    
    const occGridSize = Math.max(4, Math.floor(separation));
    const occWidth = Math.ceil(width / occGridSize);
    const occHeight = Math.ceil(height / occGridSize);
    const occGrid = new Uint8Array(occWidth * occHeight);
    
    const isOccupied = (x, y) => {
        const gx = Math.floor(x / occGridSize);
        const gy = Math.floor(y / occGridSize);
        if (gx < 0 || gx >= occWidth || gy < 0 || gy >= occHeight) return true;
        return occGrid[gy * occWidth + gx] === 1;
    };
    
    const markOccupied = (x, y) => {
        const gx = Math.floor(x / occGridSize);
        const gy = Math.floor(y / occGridSize);
        if (gx >= 0 && gx < occWidth && gy >= 0 && gy < occHeight) {
            occGrid[gy * occWidth + gx] = 1;
        }
    };
    
    // Trace streamlines
    for (let i = 0; i < seeds.length; i++) {
        if (i % 500 === 0) {
            checkCancelled();
            await checkPause();
            
            if (showProgress) {
                postProgress(taskId, 60 + (i / seeds.length) * 30, `Tracing streamlines (${i}/${seeds.length})...`);
            }
            
            await yieldToBrowser();
        }
        
        const seed = seeds[i];
        if (isOccupied(seed.x, seed.y)) continue;
        
        const path = [seed];
        markOccupied(seed.x, seed.y);
        
        for (const direction of [1, -1]) {
            let cx = seed.x;
            let cy = seed.y;
            
            for (let step = 0; step < maxPathPoints; step++) {
                const ix = Math.floor(cx);
                const iy = Math.floor(cy);
                if (ix < 1 || ix >= width - 1 || iy < 1 || iy >= height - 1) break;
                
                const idx = iy * width + ix;
                const g1x = gradX[idx];
                const g1y = gradY[idx];
                
                const mag1 = Math.sqrt(g1x * g1x + g1y * g1y);
                if (mag1 < 0.001) break;
                
                const k1x = (g1x / mag1) * stepSize * direction;
                const k1y = (g1y / mag1) * stepSize * direction;
                
                const nx = cx + k1x;
                const ny = cy + k1y;
                
                if (isOccupied(nx, ny)) break;
                
                if (direction === 1) {
                    path.push({ x: nx, y: ny });
                } else {
                    path.unshift({ x: nx, y: ny });
                }
                
                markOccupied(nx, ny);
                cx = nx;
                cy = ny;
            }
        }
        
        if (path.length * stepSize >= minPathLength) {
            paths.push(path);
        }
    }
    
    const t1 = performance.now();
    const performance = {
        totalMs: t1 - t0,
        pathsGenerated: paths.length
    };
    
    postResult(taskId, { contours: paths, raw: [], skippedJoining: true }, performance);
}

// ============================================
// STIPPLE EXTRACTION (POISSON DISK)
// ============================================
async function handleExtractStipple(taskId, params, options) {
    const { grayData, width, height } = params;
    const { interval = 8, threshold = 0.5, showProgress } = options;
    
    const t0 = performance.now();
    
    const points = [];
    const minRadius = 1.5;
    const maxRadius = interval;
    
    const mask = new Uint8Array(width * height);
    let activePixels = 0;
    for (let i = 0; i < grayData.length; i++) {
        if (grayData[i] < threshold) {
            mask[i] = 1;
            activePixels++;
        }
    }
    
    if (activePixels === 0) {
        postResult(taskId, { contours: [], raw: [], skippedJoining: true }, { totalMs: 0 });
        return;
    }
    
    const k = 20;
    const active = [];
    const cellSize = maxRadius / Math.sqrt(2);
    const gridWidth = Math.ceil(width / cellSize);
    const gridHeight = Math.ceil(height / cellSize);
    const grid = new Int32Array(gridWidth * gridHeight).fill(-1);
    
    const getRadius = (x, y) => {
        const idx = Math.floor(y) * width + Math.floor(x);
        const val = grayData[idx];
        return minRadius + (val * (maxRadius - minRadius));
    };
    
    const insertPoint = (p) => {
        const idx = points.length;
        points.push(p);
        const gx = Math.floor(p.x / cellSize);
        const gy = Math.floor(p.y / cellSize);
        grid[gy * gridWidth + gx] = idx;
        active.push(idx);
    };
    
    const numSeeds = Math.min(10, Math.ceil(activePixels / 10000));
    for (let s = 0; s < numSeeds; s++) {
        for (let i = 0; i < 50; i++) {
            const rx = Math.random() * width;
            const ry = Math.random() * height;
            if (mask[Math.floor(ry) * width + Math.floor(rx)]) {
                insertPoint({ x: rx, y: ry });
                break;
            }
        }
    }
    
    if (points.length === 0) insertPoint({ x: width / 2, y: height / 2 });
    
    while (active.length > 0) {
        checkCancelled();
        await checkPause();
        
        const activeIdx = Math.floor(Math.random() * active.length);
        const pIdx = active[activeIdx];
        const p = points[pIdx];
        const r = getRadius(p.x, p.y);
        
        let found = false;
        for (let i = 0; i < k; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = r + Math.random() * r;
            const nx = p.x + Math.cos(angle) * dist;
            const ny = p.y + Math.sin(angle) * dist;
            
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                if (!mask[Math.floor(ny) * width + Math.floor(nx)]) continue;
                
                const nr = getRadius(nx, ny);
                const gx = Math.floor(nx / cellSize);
                const gy = Math.floor(ny / cellSize);
                let tooClose = false;
                
                const checkRange = Math.ceil(maxRadius / cellSize);
                for (let dy = -checkRange; dy <= checkRange; dy++) {
                    for (let dx = -checkRange; dx <= checkRange; dx++) {
                        const ngx = gx + dx;
                        const ngy = gy + dy;
                        if (ngx >= 0 && ngx < gridWidth && ngy >= 0 && ngy < gridHeight) {
                            const neighborIdx = grid[ngy * gridWidth + ngx];
                            if (neighborIdx !== -1) {
                                const neighbor = points[neighborIdx];
                                const dSq = (nx - neighbor.x)**2 + (ny - neighbor.y)**2;
                                const minDist = (nr + getRadius(neighbor.x, neighbor.y)) / 2;
                                if (dSq < minDist * minDist) {
                                    tooClose = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (tooClose) break;
                }
                
                if (!tooClose) {
                    insertPoint({ x: nx, y: ny });
                    found = true;
                    break;
                }
            }
        }
        
        if (!found) {
            active.splice(activeIdx, 1);
        }
        
        if (points.length % 2000 === 0 && showProgress) {
            postProgress(taskId, 60 + (points.length / 40000) * 30, `Stippling (${points.length} dots)...`);
            await yieldToBrowser();
        }
        
        if (points.length > 150000) break;
    }
    
    const t1 = performance.now();
    const dotPaths = points.map(p => [{ x: p.x, y: p.y }, { x: p.x + 0.1, y: p.y + 0.1 }]);
    
    const performance = {
        totalMs: t1 - t0,
        dotsGenerated: points.length
    };
    
    postResult(taskId, { contours: dotPaths, raw: [], skippedJoining: true }, performance);
}

// ============================================
// TSP EXTRACTION (NEAREST NEIGHBOR)
// ============================================
async function handleExtractTSP(taskId, params, options) {
    const stippleResult = await new Promise(resolve => {
        handleExtractStipple(taskId, params, { ...options, showProgress: false })
            .then(result => resolve(result.data));
    });
    
    const points = stippleResult.contours.map(p => p[0]);
    if (points.length < 2) {
        postResult(taskId, { contours: [], raw: [], skippedJoining: false }, { totalMs: 0 });
        return;
    }
    
    const t0 = performance.now();
    const { showProgress } = options;
    
    const used = new Uint8Array(points.length);
    const cellSize = 30;
    const gridWidth = Math.ceil(params.width / cellSize);
    const gridHeight = Math.ceil(params.height / cellSize);
    const grid = Array(gridWidth * gridHeight).fill().map(() => []);
    
    for (let i = 0; i < points.length; i++) {
        const gx = Math.floor(points[i].x / cellSize);
        const gy = Math.floor(points[i].y / cellSize);
        grid[gy * gridWidth + gx].push(i);
    }
    
    let currentIdx = 0;
    const orderedPoints = [points[currentIdx]];
    used[currentIdx] = 1;
    let remaining = points.length - 1;
    
    while (remaining > 0) {
        if (remaining % 1000 === 0) {
            checkCancelled();
            await checkPause();
            
            if (showProgress) {
                postProgress(taskId, 90 + (1 - remaining / points.length) * 10, `TSP: ${remaining} left...`);
            }
            
            await yieldToBrowser();
        }
        
        const cp = points[currentIdx];
        let nearestIdx = -1;
        let minDistSq = Infinity;
        
        const gx = Math.floor(cp.x / cellSize);
        const gy = Math.floor(cp.y / cellSize);
        
        let searchRadius = 0;
        let found = false;
        
        while (!found && searchRadius < Math.max(gridWidth, gridHeight)) {
            for (let dy = -searchRadius; dy <= searchRadius; dy++) {
                for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                    if (Math.abs(dx) !== searchRadius && Math.abs(dy) !== searchRadius && searchRadius > 0) continue;
                    
                    const ngx = gx + dx;
                    const ngy = gy + dy;
                    if (ngx >= 0 && ngx < gridWidth && ngy >= 0 && ngy < gridHeight) {
                        const cell = grid[ngy * gridWidth + ngx];
                        for (const pIdx of cell) {
                            if (!used[pIdx]) {
                                const dSq = (cp.x - points[pIdx].x)**2 + (cp.y - points[pIdx].y)**2;
                                if (dSq < minDistSq) {
                                    minDistSq = dSq;
                                    nearestIdx = pIdx;
                                    found = true;
                                }
                            }
                        }
                    }
                }
            }
            searchRadius++;
        }
        
        if (nearestIdx !== -1) {
            orderedPoints.push(points[nearestIdx]);
            used[nearestIdx] = 1;
            currentIdx = nearestIdx;
            remaining--;
        } else break;
    }
    
    const t1 = performance.now();
    const performance = {
        totalMs: t1 - t0,
        pointsConnected: orderedPoints.length
    };
    
    postResult(taskId, { contours: [orderedPoints], raw: [], skippedJoining: false }, performance);
}

// ============================================
// CROSS-HATCH EXTRACTION
// ============================================
async function handleExtractHatch(taskId, params, options) {
    const { grayData, width, height } = params;
    const { interval = 10, threshold = 0.5, showProgress } = options;
    
    const t0 = performance.now();
    
    const lines = [];
    const layers = [
        { angle: -Math.PI / 4, t: threshold + 0.2 },
        { angle: Math.PI / 4, t: threshold },
        { angle: 0, t: threshold - 0.2 },
        { angle: Math.PI / 2, t: threshold - 0.3 }
    ];
    
    const maxLength = Math.sqrt(width * width + height * height);
    
    for (let l = 0; l < layers.length; l++) {
        const layer = layers[l];
        const angle = layer.angle;
        const layerThreshold = Math.max(0.1, layer.t);
        const spacing = interval;
        
        const cx = width / 2;
        const cy = height / 2;
        
        for (let d = -maxLength; d < maxLength; d += spacing) {
            const px = cx + d * Math.cos(angle + Math.PI/2);
            const py = cy + d * Math.sin(angle + Math.PI/2);
            
            let currentSegment = null;
            
            for (let t = -maxLength; t < maxLength; t += 2) {
                const x = Math.floor(px + t * Math.cos(angle));
                const y = Math.floor(py + t * Math.sin(angle));
                
                if (x >= 0 && x < width && y >= 0 && y < height) {
                    const idx = y * width + x;
                    const val = grayData[idx];
                    
                    if (val < layerThreshold) {
                        if (!currentSegment) {
                            currentSegment = [{x, y}];
                        } else {
                            currentSegment.push({x, y});
                        }
                    } else {
                        if (currentSegment) {
                            if (currentSegment.length > 5) lines.push([currentSegment[0], currentSegment[currentSegment.length-1]]);
                            currentSegment = null;
                        }
                    }
                } else {
                    if (currentSegment) {
                        if (currentSegment.length > 5) lines.push([currentSegment[0], currentSegment[currentSegment.length-1]]);
                        currentSegment = null;
                    }
                }
            }
            
            checkCancelled();
            await checkPause();
            await yieldToBrowser();
        }
        
        if (showProgress) {
            postProgress(taskId, 60 + (l / layers.length) * 30, `Hatching (Layer ${l+1})...`);
        }
    }
    
    const t1 = performance.now();
    const performance = {
        totalMs: t1 - t0,
        linesGenerated: lines.length
    };
    
    postResult(taskId, { contours: lines, raw: [], skippedJoining: true }, performance);
}

// ============================================
// HELPER FUNCTIONS
// ============================================
function computeEdgeMap(imageData, width, height) {
    const edgeMap = new Float32Array(width * height);
    const data = imageData.data;
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const idxRight = idx + 1;
            const idxDown = idx + width;
            
            if (x < width - 1 && y < height - 1) {
                const gx = data[idxRight * 4] - data[idx * 4];
                const gy = data[idxDown * 4] - data[idx * 4];
                edgeMap[idx] = Math.sqrt(gx * gx + gy * gy);
            }
        }
    }
    
    return edgeMap;
}

function computeDistanceFieldGradient(solution, width, height) {
    const gradX = new Float32Array(width * height);
    const gradY = new Float32Array(width * height);
    const gradMag = new Float32Array(width * height);
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            
            const gx = (x < width - 1) ? solution[idx + 1] - solution[idx] : 0;
            const gy = (y < height - 1) ? solution[idx + width] - solution[idx] : 0;
            
            gradX[idx] = gx;
            gradY[idx] = gy;
            gradMag[idx] = Math.sqrt(gx * gx + gy * gy);
        }
    }
    
    return { gradX, gradY, gradMag };
}

function generateAdaptiveLevels(solution, width, height, interval, min, max, gradMag, detailLevel) {
    const levels = [];
    
    if (min === Infinity || max === -Infinity) return levels;
    
    const range = max - min;
    if (range < 0.001) return [min + range / 2];
    
    const targetLevels = Math.max(1, Math.floor(range / interval));
    
    for (let l = min + interval; l < max; l += interval) {
        levels.push(l);
    }
    
    return levels;
}

function snapToEdge(x, y, level, edgeMap, solution, width, height, sensitivity, interval) {
    let bestX = x;
    let bestY = y;
    let bestEdgeVal = 0;
    
    const searchRadius = 3;
    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        for (let dx = -searchRadius; dx <= searchRadius; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            
            const idx = Math.floor(ny) * width + Math.floor(nx);
            const edgeVal = edgeMap ? edgeMap[idx] : 0;
            
            if (edgeVal > bestEdgeVal) {
                bestEdgeVal = edgeVal;
                bestX = nx;
                bestY = ny;
            }
        }
    }
    
    return {
        x: x + (bestX - x) * sensitivity,
        y: y + (bestY - y) * sensitivity
    };
}
