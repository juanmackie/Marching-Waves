// Web Worker for Marching Waves - CPU-intensive computations
importScripts('js/engine.js', 'js/subject-wire.js');

function postProgress(taskId, percent, message) {
    self.postMessage({ type: 'progress', taskId, percent, message, timestamp: Date.now() });
}

function postResult(taskId, data, perf = {}, transferList = []) {
    self.postMessage({ type: 'result', taskId, data, performance: perf, timestamp: Date.now() }, transferList);
}

function postError(taskId, message, stack) {
    self.postMessage({ type: 'error', taskId, error: { message, stack } });
}

// Check for cancellation or pause signals
let isCancelled = false;
let isPaused = false;
let pauseResolve = null;

const yieldChannel = new MessageChannel();
let yieldResolve = null;
yieldChannel.port1.onmessage = () => {
    if (yieldResolve) { const r = yieldResolve; yieldResolve = null; r(); }
};
function yieldToBrowser() {
    return new Promise(resolve => { yieldResolve = resolve; yieldChannel.port2.postMessage(null); });
}

let isVisible = true;

self.onmessage = function(e) {
    const { type, taskId, method, params, options } = e.data;

    if (type === 'cancel') { isCancelled = true; return; }
    if (type === 'pause') { isPaused = true; return; }
    if (type === 'resume') { isPaused = false; if (pauseResolve) { pauseResolve(); pauseResolve = null; } return; }
    if (type === 'cleanup') { cleanupWorkerMemory(); return; }
    if (type === 'visibility') { isVisible = e.data.isVisible; return; }

    // Regular task execution
    isCancelled = false;
    isPaused = false;
    pauseResolve = null;
    try {
        executeTask(taskId, method, params, options);
    } catch (error) {
        postError(taskId, error.message, error.stack);
    }
};

async function executeTask(taskId, method, params, options) {
    try {
        switch (method) {
            case 'solveEikonalCPU': await handleSolveEikonalCPU(taskId, params, options); break;
            case 'extractContoursAdaptive': await handleExtractContoursAdaptive(taskId, params, options); break;
            case 'extractSubjectWire': await handleExtractSubjectWire(taskId, params, options); break;
            case 'extractStreamlines': await handleExtractStreamlines(taskId, params, options); break;
            case 'extractStipple': await handleExtractStipple(taskId, params, options); break;
            case 'extractTSP': await handleExtractTSP(taskId, params, options); break;
            case 'extractHatch': await handleExtractHatch(taskId, params, options); break;
            default: postError(taskId, 'Unknown method: ' + method);
        }
    } catch (error) {
        postError(taskId, error.message, error.stack);
    }
}

function checkCancelled() { if (isCancelled) throw new Error('Cancelled by user'); }

async function checkPause() {
    if (isPaused) await new Promise(resolve => { pauseResolve = resolve; });
}

// ============================================
// CPU-BASED FAST MARCHING METHOD SOLVER
// ============================================
async function handleSolveEikonalCPU(taskId, params, options) {
    const { grayData, width, height, threshold } = params;
    const { showProgress, streamWavefront } = options;
    
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
    
    const batchSize = 4000;
    
    // Wavefront streaming buffers
    let waveIndices = [];
    let waveValues = [];
    function flushWavefront() {
        if (waveIndices.length > 0) {
            const indices = new Uint32Array(waveIndices);
            const values = new Float32Array(waveValues);
            self.postMessage(
                { type: 'wavefront', taskId, indices, values },
                [indices.buffer, values.buffer]
            );
            waveIndices = [];
            waveValues = [];
        }
    }
    
    // Emit seeds as initial wavefront frame
    if (streamWavefront) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = idx(x, y);
                if (grayData[i] < threshold) {
                    waveIndices.push(i);
                    waveValues.push(0);
                    if (waveIndices.length >= batchSize) flushWavefront();
                }
            }
        }
        if (waveIndices.length > 0) flushWavefront();
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
    
    while (heap.length > 0) {
        const current = heapPop();
        if (!current) break;
        const { x, y } = current;
        const currentIdx = idx(x, y);
        
        // Stale-pop guard: skip heap entries overtaken by better values
        if (current.value > solution[currentIdx]) continue;
        visited[currentIdx] = 1;
        
        // Collect wavefront delta (first time each pixel is finalized)
        if (streamWavefront) {
            waveIndices.push(currentIdx);
            waveValues.push(solution[currentIdx]);
            if (waveIndices.length >= batchSize) flushWavefront();
        }
        
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
                // Push the f32-rounded value actually stored in solution so
                // the stale-pop guard compares apples to apples (a raw float64
                // newValue can round DOWN on f32 storage and then look "stale"
                // on its own first pop).
                heapPush({ x: neighbor.x, y: neighbor.y, value: solution[nIdx] });
            }
        }
        
        // Periodic updates
        processed++;
        if (processed % batchSize === 0) {
            // Flush any pending wavefront deltas before yielding
            if (streamWavefront && waveIndices.length > 0) flushWavefront();
            
            checkCancelled();
            await checkPause();
            
            if (showProgress) {
                const progress = processed / (width * height) * 100;
                postProgress(taskId, progress, `Solving Eikonal equation...`);
            }
            
            await yieldToBrowser();
        }
    }
    
    // Flush remaining wavefront deltas
    if (streamWavefront && waveIndices.length > 0) flushWavefront();
    
    const t1 = performance.now();
    const perf = {
        totalMs: t1 - t0,
        method: 'CPU FMM',
        cellsProcessed: processed
    };
    
    // Transfer solution as transferable object for better performance
    postResult(taskId, { solution }, perf, [solution.buffer]);
}

// ============================================
// ADAPTIVE CONTOUR EXTRACTION
// ============================================
async function handleExtractContoursAdaptive(taskId, params, options) {
    const {
        solution, imageData, width, height, interval, maxSegments,
        gradMag, edgeDistance,
        edgeGuidance = true, edgeSensitivity = 0.6,
        detailLevel = 0.7, contourSmoothness = 0.5, featureImportance = 0.6
    } = params;
    const { showProgress } = options;

    const t0 = performance.now();

    // Edge guidance: warp the scalar field toward nearby image edges so contour
    // lines snap to detected features (edgeDistance supplied by GPU/CPU pre-pass).
    let field = solution;
    if (edgeGuidance && edgeDistance) {
        field = Engine.applyEdgeWarp(solution, edgeDistance, width, height, edgeSensitivity);
    }

    // Find min/max values of the (possibly warped) field
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < field.length; i++) {
        const v = field[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }

    // Adaptive levels driven by the *image* gradient histogram (from GPU Sobel or
    // CPU fallback) so detailed regions receive more contour lines.
    const gradForLevels = gradMag || computeDistanceFieldGradient(field, width, height).gradMag;
    const levels = Engine.generateAdaptiveLevelsGrad(
        field, width, height, interval, min, max, gradForLevels, detailLevel, featureImportance
    );

    // Use correct marching squares from engine
    const rawContours = Engine.marchSquaresField(field, width, height, levels);

    const t1 = performance.now();
    const totalLines = rawContours.reduce(function(s, c) { return s + c.lines.length; }, 0);

    // Join segments into continuous paths
    let joined = Engine.joinSegments(rawContours);
    joined = joined.map(p => Engine.simplifyPath(p, 0.8)).filter(p => p.length > 1);
    if (contourSmoothness > 0.1) {
        const segments = 1 + Math.round(4 * contourSmoothness);
        const tension = 0.3 + 0.4 * contourSmoothness;
        joined = joined.map(p => Engine.smoothPathCornerAware(p, segments, tension, 30));
    }

    const t2 = performance.now();
    const perf = {
        totalMs: t2 - t0,
        levelsProcessed: levels.length,
        linesExtracted: totalLines,
        joinedPaths: joined.length,
        edgeGuided: !!(edgeGuidance && edgeDistance)
    };

    postResult(taskId, { contours: joined, raw: rawContours, skippedJoining: false }, perf);
}

// ============================================
// SUBJECT WIRE EXTRACTION
// ============================================
async function handleExtractSubjectWire(taskId, params, options) {
    const { grayData, gradMag, width, height } = params;
    const t0 = performance.now();
    const wireOptions = {
        subjectFocus: params.subjectFocus,
        wireDensity: params.wireDensity,
        wireTension: params.wireTension,
        relationshipStrength: params.relationshipStrength,
        abstraction: params.abstraction,
        handDrawn: params.handDrawn,
        shouldCancel: checkCancelled
    };

    if (options.showProgress) postProgress(taskId, 64, 'Finding the focal subject...');
    await yieldToBrowser();
    checkCancelled();
    if (options.showProgress) postProgress(taskId, 76, 'Tracing structural wire paths...');
    const result = SubjectWire.generate({ grayData, gradMag, width, height, options: wireOptions });
    checkCancelled();
    if (options.showProgress) postProgress(taskId, 92, 'Refining the conceptual line drawing...');
    await yieldToBrowser();

    postResult(taskId, result, {
        totalMs: performance.now() - t0,
        method: 'Local subject-wire heuristic',
        regions: result.meta && result.meta.regions || 0,
        paths: result.contours.length
    });
}

// ============================================
// STREAMLINE EXTRACTION
// ============================================
async function handleExtractStreamlines(taskId, params, options) {
    const { solution, grayData, width, height } = params;
    const { interval = 8, maxSegments = 50000, edgeSensitivity = 0.5, showProgress } = options;
    // Threshold arrives normalized (0..1) in params; options.threshold is the raw UI value
    const threshold = params.threshold != null ? params.threshold : 0.5;
    
    const t0 = performance.now();
    
    const { gradX, gradY } = computeDistanceFieldGradient(solution, width, height);

    // When the distance field is degenerate (flat — e.g. seeds cover most of the
    // image), fall back to tracing the image's own gradient so streamlines still
    // follow the visual flow of the picture.
    let gradMean = 0, gradCount = 0, usable = 0;
    for (let i = 0; i < solution.length; i++) {
        if (grayData[i] >= threshold) continue; // only judge the seed region
        const m = Math.sqrt(gradX[i] * gradX[i] + gradY[i] * gradY[i]);
        gradMean += m;
        if (m > 0.001) usable++;
        gradCount++;
    }
    gradMean = gradCount > 0 ? gradMean / gradCount : 0;
    // Fall back when most seed pixels sit on a flat part of the field
    if ((gradCount === 0 || usable / Math.max(1, gradCount) < 0.5) && typeof Engine !== 'undefined' && Engine.sobelGradientCPU) {
        const imgGrad = Engine.sobelGradientCPU(grayData, width, height);
        for (let i = 0; i < solution.length; i++) {
            gradX[i] = imgGrad.gradX[i];
            gradY[i] = imgGrad.gradY[i];
        }
    }
    
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
    const checkYieldInterval = isVisible ? 500 : 2000;
    for (let i = 0; i < seeds.length; i++) {
        if (i % checkYieldInterval === 0) {
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
            
            const curlStrength = 1.2;
            const curlFreq = 0.04;
            for (let step = 0; step < maxPathPoints; step++) {
                const ix = Math.floor(cx);
                const iy = Math.floor(cy);
                if (ix < 1 || ix >= width - 1 || iy < 1 || iy >= height - 1) break;
                
                const idx = iy * width + ix;
                const g1x = gradX[idx];
                const g1y = gradY[idx];
                
                const mag1 = Math.sqrt(g1x * g1x + g1y * g1y);
                if (mag1 < 0.001) break;
                
                const noise1 = smoothNoise(cx * curlFreq, cy * curlFreq);
                const curl1 = noise1 * curlStrength;
                
                const k1x = (g1x / mag1) * stepSize * direction + (-g1y / mag1) * curl1;
                const k1y = (g1y / mag1) * stepSize * direction + (g1x / mag1) * curl1;

                const nx = cx + k1x;
                const ny = cy + k1y;

                // Only entering a *different*, already-claimed cell blocks the trace:
                // consecutive steps (2px) often stay inside the same occupancy cell
                // (6.4px), which must not kill the line.
                const cgx = Math.floor(cx / occGridSize);
                const cgy = Math.floor(cy / occGridSize);
                const tgx = Math.floor(nx / occGridSize);
                const tgy = Math.floor(ny / occGridSize);
                if ((tgx !== cgx || tgy !== cgy) && isOccupied(nx, ny)) break;
                
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
    const perf = {
        totalMs: t1 - t0,
        pathsGenerated: paths.length
    };
    
    postResult(taskId, { contours: paths, raw: [], skippedJoining: true }, perf);
}

// ============================================
// STIPPLE EXTRACTION (POISSON DISK)
// ============================================
async function handleExtractStipple(taskId, params, options) {
    const { grayData, width, height } = params;
    const { interval = 8, showProgress } = options;
    const threshold = params.threshold != null ? params.threshold : 0.5;
    
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
        const gx = (x < width - 1) ? Math.abs(grayData[idx] - grayData[idx + 1]) : 0;
        const gy = (y < height - 1) ? Math.abs(grayData[idx] - grayData[idx + width]) : 0;
        const grad = Math.min(1, gx + gy);
        const brightFactor = 1 - val;
        const gradBoost = 1 - grad * 0.7;
        const radius = minRadius + (maxRadius - minRadius) * Math.pow(brightFactor, 0.6) * gradBoost;
        return Math.max(minRadius, Math.min(maxRadius, radius));
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

        const stippleCheckInterval = isVisible ? 2000 : 8000;
        if (points.length % stippleCheckInterval === 0 && showProgress) {
            postProgress(taskId, 60 + (points.length / 40000) * 30, `Stippling (${points.length} dots)...`);
            await yieldToBrowser();
        }
        
        if (points.length > 150000) break;
    }
    
    const t1 = performance.now();
    const dotPaths = points.map(p => [{ x: p.x, y: p.y }]);
    
    const perf = {
        totalMs: t1 - t0,
        dotsGenerated: points.length
    };
    
    postResult(taskId, { contours: dotPaths, raw: [], skippedJoining: true, stipplePoints: points }, perf);
}

// ============================================
// TSP EXTRACTION (NEAREST NEIGHBOR)
// ============================================
async function handleExtractTSP(taskId, params, options) {
    let stippleData = null;
    const realPost = postResult;
    postResult = (id, data, perf, transfer) => {
        if (id === taskId) { stippleData = data; }
        else { realPost(id, data, perf, transfer); }
    };
    try { await handleExtractStipple(taskId, params, { ...options, showProgress: false }); }
    finally { postResult = realPost; }

    if (!stippleData) { postResult(taskId, { contours: [], raw: [], skippedJoining: false }, { totalMs: 0 }); return; }
    let points = stippleData.contours.map(p => p[0]);
    if (points.length < 2) { postResult(taskId, { contours: [], raw: [], skippedJoining: false }, { totalMs: 0 }); return; }

    const MAX_TSP_POINTS = 4000;
    if (points.length > MAX_TSP_POINTS) {
        const sampled = [];
        const step = points.length / MAX_TSP_POINTS;
        for (let i = 0; i < MAX_TSP_POINTS; i++) { sampled.push(points[Math.floor(i * step)]); }
        points = sampled;
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

    let bestIdx = 0, bestDist = -1;
    const cx = params.width / 2, cy = params.height / 2;
    for (let i = 0; i < Math.min(points.length, 100); i++) {
        const d = Math.abs(points[i].x - cx) + Math.abs(points[i].y - cy);
        if (d > bestDist) { bestDist = d; bestIdx = i; }
    }

    let currentIdx = bestIdx;
    const orderedPoints = [points[currentIdx]];
    used[currentIdx] = 1;
    let remaining = points.length - 1;
    const tspCheckInterval = isVisible ? 500 : 2000;

    while (remaining > 0) {
        if (remaining % tspCheckInterval === 0) {
            checkCancelled(); await checkPause();
            if (showProgress) { postProgress(taskId, 90 + (1 - remaining / points.length) * 10, `TSP: ${remaining} left...`); }
            await yieldToBrowser();
        }

        const cp = points[currentIdx];
        let nearestIdx = -1;
        let minDistSq = Infinity;
        const gx = Math.floor(cp.x / cellSize);
        const gy = Math.floor(cp.y / cellSize);

        for (let sr = 0; sr < Math.max(gridWidth, gridHeight); sr++) {
            let hit = false;
            for (let dy = -sr; dy <= sr; dy++) {
                for (let dx = -sr; dx <= sr; dx++) {
                    if (Math.abs(dx) !== sr && Math.abs(dy) !== sr && sr > 0) continue;
                    const ngx = gx + dx, ngy = gy + dy;
                    if (ngx < 0 || ngx >= gridWidth || ngy < 0 || ngy >= gridHeight) continue;
                    for (const pIdx of grid[ngy * gridWidth + ngx]) {
                        if (used[pIdx]) continue;
                        const dSq = (cp.x - points[pIdx].x) ** 2 + (cp.y - points[pIdx].y) ** 2;
                        if (dSq < minDistSq) { minDistSq = dSq; nearestIdx = pIdx; }
                        hit = true;
                    }
                }
            }
            if (hit) break;
        }

        if (nearestIdx !== -1) {
            orderedPoints.push(points[nearestIdx]);
            used[nearestIdx] = 1;
            currentIdx = nearestIdx;
            remaining--;
        } else break;
    }

    const improved = orderedPoints.length < 20000 ? optimizeTSP2Opt(orderedPoints) : orderedPoints;

    const t1 = performance.now();
    const perf = { totalMs: t1 - t0, pointsConnected: improved.length };
    postResult(taskId, { contours: [improved], raw: [], skippedJoining: false }, perf);
}

function optimizeTSP2Opt(points) {
    if (points.length < 4) return points;
    const pts = [...points];
    const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    const n = pts.length;
    let improved = true;
    let maxPasses = Math.max(5, Math.min(20, Math.floor(100000 / n)));
    while (improved && maxPasses-- > 0) {
        improved = false;
        for (let i = 0; i < n - 2; i++) {
            for (let j = i + 2; j < n - 1; j++) {
                const d1 = d2(pts[i], pts[i + 1]) + d2(pts[j], pts[j + 1]);
                const d2_swapped = d2(pts[i], pts[j]) + d2(pts[i + 1], pts[j + 1]);
                if (d2_swapped < d1) {
                    let left = i + 1, right = j;
                    while (left < right) {
                        [pts[left], pts[right]] = [pts[right], pts[left]];
                        left++; right--;
                    }
                    improved = true;
                }
            }
        }
    }
    return pts;
}

// ============================================
// CROSS-HATCH EXTRACTION
// ============================================
function computeDominantAngle(grayData, width, height) {
    let sumSin = 0, sumCos = 0, count = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            const gx = (grayData[idx + 1] - grayData[idx - 1]);
            const gy = (grayData[idx + width] - grayData[idx - width]);
            const mag = gx * gx + gy * gy;
            if (mag > 0.01) {
                const angle = Math.atan2(gy, gx);
                sumSin += Math.sin(angle * 2) * mag;
                sumCos += Math.cos(angle * 2) * mag;
                count++;
            }
        }
    }
    if (count === 0) return -Math.PI / 4;
    return Math.atan2(sumSin, sumCos) / 2;
}

async function handleExtractHatch(taskId, params, options) {
    const { grayData, width, height } = params;
    const { interval = 10, showProgress } = options;
    const threshold = params.threshold != null ? params.threshold : 0.5;
    
    const t0 = performance.now();
    
    const lines = [];
    const spacing = interval;
    const dominantAngle = computeDominantAngle(grayData, width, height);

    const layers = [
        { angle: dominantAngle + Math.PI / 4, t: threshold + 0.15 },
        { angle: dominantAngle - Math.PI / 4, t: threshold },
        { angle: dominantAngle, t: threshold - 0.2 },
        { angle: dominantAngle + Math.PI / 2, t: threshold - 0.25 }
    ];
    
    const maxLength = Math.sqrt(width * width + height * height);
    
    const hatchCheckYield = 20;
    let hatchProgressCheck = 0;
    for (let l = 0; l < layers.length; l++) {
        const layer = layers[l];
        const angle = layer.angle;
        const layerThreshold = Math.max(0.1, layer.t);
        
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
            
            hatchProgressCheck++;
            if (hatchProgressCheck % hatchCheckYield === 0) {
                checkCancelled();
                await checkPause();
                await yieldToBrowser();
            }
        }
        
        if (showProgress) {
            postProgress(taskId, 60 + (l / layers.length) * 30, `Hatching (Layer ${l+1})...`);
        }
    }
    
    const t1 = performance.now();
    const perf = {
        totalMs: t1 - t0,
        linesGenerated: lines.length
    };
    
    postResult(taskId, { contours: lines, raw: [], skippedJoining: true }, perf);
}

// ============================================
// HELPER FUNCTIONS
// ============================================
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

const PHI = 1.618033988749895;

function hashNoise(x, y) {
    let h = (Math.floor(x) * 374761393 + Math.floor(y) * 668265263) | 0;
    h = ((h ^ (h >>> 13)) * 1274126177) | 0;
    return ((h ^ (h >>> 16)) / 2147483647);
}

function smoothNoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const v00 = hashNoise(ix, iy);
    const v10 = hashNoise(ix + 1, iy);
    const v01 = hashNoise(ix, iy + 1);
    const v11 = hashNoise(ix + 1, iy + 1);
    return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v11 - v01 - v10 + v00) * sx * sy;
}

function generateAdaptiveLevels(solution, width, height, interval, min, max, gradMag, detailLevel) {
    const levels = [];
    
    if (min === Infinity || max === -Infinity) return levels;
    
    const range = max - min;
    if (range < 0.001) return [min + range / 2];
    
    const avgGrad = detailLevel ?? 0.5;
    let current = min + interval;
    
    while (current < max) {
        levels.push(current);
        const mod = 1 + 0.3 * Math.sin(current * PHI);
        const gradMod = 0.8 + 0.4 * (1 - Math.min(1, avgGrad));
        current += interval * mod * gradMod;
    }
    
    return levels;
}

// Cleanup function to free memory after task completion
function cleanupWorkerMemory() {
    // Clear cancellation state
    isCancelled = false;
    isPaused = false;

    // Clear pause promise
    if (pauseResolve) {
        pauseResolve = null;
    }

    // Clear yield promise
    if (yieldResolve) {
        yieldResolve = null;
    }
}
