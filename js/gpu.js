// js/gpu.js — WebGPU acceleration for Marching Waves
// Main-thread compute module. Every stage fails gracefully to CPU fallbacks
// defined in engine.js / index.html when WebGPU is unavailable.
'use strict';

class WebGPUManager {
    constructor() {
        this.device = null;
        this.adapter = null;
        this.available = false;
        this.initialized = false;
        this.initError = null;
        this.adapterInfo = null;
        this.lastUsed = null;
        this._pipelines = new Map();
        this._usage = {
            grayscale: 0, blur: 0, sobel: 0,
            eikonal: 0, edgeDistance: 0, totalMs: 0
        };
    }

    // ─── Status ───
    get statusLabel() {
        if (!this.initialized) return 'Initializing…';
        if (this.available) return 'GPU · WebGPU';
        return 'CPU';
    }

    getStatusDetail() {
        if (!this.available) {
            return this.initError ? `WebGPU unavailable: ${this.initError}` : 'WebGPU unavailable';
        }
        const info = this.adapterInfo || {};
        return `WebGPU · ${info.vendor || ''} ${info.architecture || ''} ${info.device || ''}`.trim();
    }

    resetUsage() {
        this._usage = { grayscale: 0, blur: 0, sobel: 0, eikonal: 0, edgeDistance: 0, totalMs: 0 };
    }

    getUsage() { return { ...this._usage }; }

    // ─── Initialization ───
    async init() {
        if (this.initialized) return this.available;
        this.initialized = true;

        if (typeof navigator === 'undefined' || !navigator.gpu) {
            this.initError = 'WebGPU not supported in this browser';
            this.available = false;
            return false;
        }

        try {
            this.adapter = await navigator.gpu.requestAdapter();
            if (!this.adapter) {
                this.initError = 'No GPU adapter found';
                this.available = false;
                return false;
            }

            this.device = await this.adapter.requestDevice({
                requiredFeatures: [],
                requiredLimits: {}
            });
            // Surface otherwise-silent GPU errors (bad shaders, validation) to the console
            this.device.addEventListener('uncapturederror', (e) => {
                console.error('WebGPU uncaptured error:', e.error && e.error.message);
            });
            this.device.lost.then((info) => {
                if (info.reason !== 'destroyed') {
                    console.warn('WebGPU device lost:', info.message || info.reason);
                }
            });

            // Adapter info (may be partially unavailable on some platforms)
            try {
                this.adapterInfo = this.adapter.info || null;
            } catch (e) { this.adapterInfo = null; }

            this.available = true;
            console.log('WebGPU initialized:', this.getStatusDetail());
            return true;
        } catch (error) {
            this.initError = error && error.message ? error.message : String(error);
            this.available = false;
            this.device = null;
            console.warn('WebGPU initialization failed:', this.initError);
            return false;
        }
    }

    // ─── Buffer helpers ───
    createBuffer(size, usage) {
        if (!this.device) throw new Error('WebGPU not initialized');
        return this.device.createBuffer({ size, usage, mappedAtCreation: false });
    }

    writeBuffer(buffer, data) {
        if (!this.device) throw new Error('WebGPU not initialized');
        this.device.queue.writeBuffer(buffer, 0, data);
    }

    async readFloat32(buffer, count) {
        if (!this.device) throw new Error('WebGPU not initialized');
        const size = count * 4;
        const readBuffer = this.device.createBuffer({
            size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, readBuffer, 0, size);
        this.device.queue.submit([encoder.finish()]);
        await readBuffer.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(readBuffer.getMappedRange().slice(0));
        readBuffer.unmap();
        readBuffer.destroy();
        return result;
    }

    getPipeline(name, code, entryPoint) {
        let p = this._pipelines.get(name);
        if (!p) {
            const module = this.device.createShaderModule({ code });
            p = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
            this._pipelines.set(name, p);
        }
        return p;
    }

    makeBindGroup(pipeline, entries) {
        return this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries
        });
    }

    // Dispatch a 1D (256-thread) compute pass over `pixelCount` elements.
    // Splits workgroups across x/y to stay under the 65535-per-dimension limit.
    dispatchFlat(pipeline, bindGroup, pixelCount) {
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        const totalGroups = Math.ceil(pixelCount / 256);
        const gy = Math.max(1, Math.ceil(totalGroups / 65535));
        const gx = Math.ceil(totalGroups / gy);
        pass.dispatchWorkgroups(gx, gy);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    runCompute(pipeline, bindGroup, workgroups) {
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(workgroups);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    // ─── Shaders ───

    // RGBA packed u32 → luminance f32 (contrast + invert in the same pass)
    grayscaleShader(pixelCount) {
        return `
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: vec4<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= ${pixelCount}u) { return; }
    let pixel = input[idx];
    let r = f32((pixel >> 0u) & 0xFFu) / 255.0;
    let g = f32((pixel >> 8u) & 0xFFu) / 255.0;
    let b = f32((pixel >> 16u) & 0xFFu) / 255.0;
    var lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let contrast = params.x;
    lum = clamp((lum - 0.5) * contrast + 0.5, 0.0, 1.0);
    if (params.y > 0.5) { lum = 1.0 - lum; }
    output[idx] = lum;
}
`;
    }

    // Separable Gaussian blur (axis via params.w)
    blurShader(pixelCount, width, height) {
        return `
@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: vec4<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= ${pixelCount}u) { return; }
    let w = i32(params.x);
    let h = i32(params.y);
    let radius = i32(params.z);
    let axis = i32(params.w);
    let x = i32(idx % ${width}u);
    let y = i32(idx / ${width}u);
    if (radius <= 0) { output[idx] = input[idx]; return; }

    let sigma = f32(radius) * 0.6;
    var sum = 0.0;
    var wsum = 0.0;
    for (var t = -radius; t <= radius; t = t + 1) {
        var sx = x;
        var sy = y;
        if (axis == 0) { sx = clamp(x + t, 0, w - 1); }
        else { sy = clamp(y + t, 0, h - 1); }
        let wgt = exp(-(f32(t) * f32(t)) / (2.0 * sigma * sigma));
        sum += input[u32(sy) * ${width}u + u32(sx)] * wgt;
        wsum += wgt;
    }
    output[idx] = sum / wsum;
}
`;
    }

    // Sobel gradient (3×3, clamped edges)
    sobelShader(pixelCount, width, height) {
        return `
@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> gradX: array<f32>;
@group(0) @binding(2) var<storage, read_write> gradY: array<f32>;
@group(0) @binding(3) var<storage, read_write> gradMag: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= ${pixelCount}u) { return; }
    let x = i32(idx % ${width}u);
    let y = i32(idx / ${width}u);

    let lx = max(x - 1, 0);
    let rx = min(x + 1, ${width - 1});
    let uy = max(y - 1, 0);
    let dy = min(y + 1, ${height - 1});
    let row_u = u32(uy) * ${width}u;
    let row_m = u32(y) * ${width}u;
    let row_d = u32(dy) * ${width}u;

    let tl = input[row_u + u32(lx)];
    let tc = input[row_u + u32(x)];
    let tr = input[row_u + u32(rx)];
    let ml = input[row_m + u32(lx)];
    let mr = input[row_m + u32(rx)];
    let bl = input[row_d + u32(lx)];
    let bc = input[row_d + u32(x)];
    let br = input[row_d + u32(rx)];

    let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
    gradX[idx] = gx;
    gradY[idx] = gy;
    gradMag[idx] = sqrt(gx * gx + gy * gy);
}
`;
    }

    // Init distance field: u = 0 at seeds, BIG elsewhere
    initFieldShader(pixelCount) {
        return `
@group(0) @binding(0) var<storage, read> seeds: array<f32>;
@group(0) @binding(1) var<storage, read_write> u: array<f32>;

const BIG: f32 = 1.0e9;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= ${pixelCount}u) { return; }
    if (seeds[idx] > 0.5) { u[idx] = 0.0; }
    else { u[idx] = BIG; }
}
`;
    }

    // Red-black sweep: Godunov upwind update of the Eikonal equation
    // (u_x)^2 + (u_y)^2 = f^2, speed f = speed[idx]; seeds stay 0.
    sweepShader(pixelCount, width, height) {
        return `
@group(0) @binding(0) var<storage, read> seeds: array<f32>;
@group(0) @binding(1) var<storage, read> speed: array<f32>;
@group(0) @binding(2) var<storage, read> uin: array<f32>;
@group(0) @binding(3) var<storage, read_write> uout: array<f32>;
@group(0) @binding(4) var<uniform> params: vec4<u32>;

const BIG: f32 = 1.0e9;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= params.w) { return; }
    let w = i32(params.x);
    let h = i32(params.y);
    let parity = params.z;
    let x = i32(idx % ${width}u);
    let y = i32(idx / ${width}u);

    // Red-black: only update pixels whose (x+y) parity matches this pass
    if (((x + y) & 1) != i32(parity)) { uout[idx] = uin[idx]; return; }

    // Seed pixels keep u = 0
    if (seeds[idx] > 0.5) { uout[idx] = 0.0; return; }

    // Clamped 4-neighborhood
    let lx = max(x - 1, 0);
    let rx = min(x + 1, w - 1);
    let uy = max(y - 1, 0);
    let dy = min(y + 1, h - 1);
    let row = u32(y) * ${width}u;
    let uL = uin[row + u32(lx)];
    let uR = uin[row + u32(rx)];
    let uU = uin[u32(uy) * ${width}u + u32(x)];
    let uD = uin[u32(dy) * ${width}u + u32(x)];

    let a = min(uL, uR);   // best along x
    let b = min(uU, uD);   // best along y
    let f = speed[idx];

    var val: f32 = BIG;
    if (a >= BIG - 1.0) {
        if (b >= BIG - 1.0) { val = BIG; }
        else { val = b + f; }
    } else if (b >= BIG - 1.0) {
        val = a + f;
    } else {
        let diff = abs(a - b);
        if (diff >= f) { val = min(a, b) + f; }
        else {
            val = (a + b + sqrt(2.0 * f * f - diff * diff)) / 2.0;
        }
    }
    // Monotone decrease prevents oscillation and keeps u bounded
    val = min(val, uin[idx]);
    uout[idx] = val;
}
`;
    }

    // ─── Public ops ───

    // imageData → Float32Array luminance [0..1], with optional blur/contrast/invert
    async preprocess(imageData, opts = {}) {
        const t0 = performance.now();
        this._assertReady();
        const width = imageData.width, height = imageData.height;
        const pixelCount = width * height;
        const blurRadius = Math.max(0, Math.min(8, Math.round(opts.blurRadius || 0)));
        const contrast = opts.contrast != null ? opts.contrast : 1.0;
        const invert = !!opts.invert;

        const inputBuffer = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        const a = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        const b = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        const paramsBuffer = this.createBuffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

        try {
            this.writeBuffer(inputBuffer, imageData.data);

            // Pass 1: grayscale (+contrast/invert)
            this.writeBuffer(paramsBuffer, new Float32Array([contrast, invert ? 1 : 0, 0, 0]));
            const grayPipeline = this.getPipeline('grayscale', this.grayscaleShader(pixelCount), 'main');
            this.dispatchFlat(grayPipeline, this.makeBindGroup(grayPipeline, [
                { binding: 0, resource: { buffer: inputBuffer } },
                { binding: 1, resource: { buffer: a } },
                { binding: 2, resource: { buffer: paramsBuffer } }
            ]), pixelCount);

            let src = a, dst = b;

            if (blurRadius > 0) {
                // Horizontal
                this.writeBuffer(paramsBuffer, new Float32Array([width, height, blurRadius, 0]));
                const blurPipeline = this.getPipeline('blur', this.blurShader(pixelCount, width, height), 'main');
                this.dispatchFlat(blurPipeline, this.makeBindGroup(blurPipeline, [
                    { binding: 0, resource: { buffer: src } },
                    { binding: 1, resource: { buffer: dst } },
                    { binding: 2, resource: { buffer: paramsBuffer } }
                ]), pixelCount);
                [src, dst] = [dst, src];

                // Vertical
                this.writeBuffer(paramsBuffer, new Float32Array([width, height, blurRadius, 1]));
                this.dispatchFlat(blurPipeline, this.makeBindGroup(blurPipeline, [
                    { binding: 0, resource: { buffer: src } },
                    { binding: 1, resource: { buffer: dst } },
                    { binding: 2, resource: { buffer: paramsBuffer } }
                ]), pixelCount);
                [src, dst] = [dst, src];
            }

            const result = await this.readFloat32(src, pixelCount);
            this._usage.grayscale = performance.now() - t0;
            this.lastUsed = 'preprocess';
            return result;
        } finally {
            inputBuffer.destroy(); a.destroy(); b.destroy(); paramsBuffer.destroy();
        }
    }

    // gray → { gradX, gradY, gradMag } Float32Arrays
    async sobelGradient(gray, width, height) {
        const t0 = performance.now();
        this._assertReady();
        const pixelCount = width * height;

        const inputBuffer = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        const gxBuffer = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const gyBuffer = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const gmBuffer = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);

        try {
            this.writeBuffer(inputBuffer, gray);
            const pipeline = this.getPipeline('sobel', this.sobelShader(pixelCount, width, height), 'main');
            this.dispatchFlat(pipeline, this.makeBindGroup(pipeline, [
                { binding: 0, resource: { buffer: inputBuffer } },
                { binding: 1, resource: { buffer: gxBuffer } },
                { binding: 2, resource: { buffer: gyBuffer } },
                { binding: 3, resource: { buffer: gmBuffer } }
            ]), pixelCount);

            const [gradX, gradY, gradMag] = await Promise.all([
                this.readFloat32(gxBuffer, pixelCount),
                this.readFloat32(gyBuffer, pixelCount),
                this.readFloat32(gmBuffer, pixelCount)
            ]);
            this._usage.sobel = performance.now() - t0;
            this.lastUsed = 'sobel';
            return { gradX, gradY, gradMag };
        } finally {
            inputBuffer.destroy(); gxBuffer.destroy(); gyBuffer.destroy(); gmBuffer.destroy();
        }
    }

    // Generic sweep solver.
    // seeds01: Float32Array of 0/1 (1 = seed), speed: Float32Array (0..1), both length w*h.
    async solveDistanceField(seeds01, speed, width, height, iterations, label = 'eikonal') {
        const t0 = performance.now();
        this._assertReady();
        const pixelCount = width * height;
        const iter = Math.max(8, Math.min(160, Math.round(iterations || 40)));

        const seedsBuffer = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        const speedBuffer = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        const ua = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        const ub = this.createBuffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        const paramsBuffer = this.createBuffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

        try {
            this.writeBuffer(seedsBuffer, seeds01);
            this.writeBuffer(speedBuffer, speed);

            // Init u
            const initPipeline = this.getPipeline('initField', this.initFieldShader(pixelCount), 'main');
            this.dispatchFlat(initPipeline, this.makeBindGroup(initPipeline, [
                { binding: 0, resource: { buffer: seedsBuffer } },
                { binding: 1, resource: { buffer: ua } }
            ]), pixelCount);
            // Copy ua → ub so both buffers are consistent before first sweep
            {
                const encoder = this.device.createCommandEncoder();
                encoder.copyBufferToBuffer(ua, 0, ub, 0, pixelCount * 4);
                this.device.queue.submit([encoder.finish()]);
            }

            const sweepPipeline = this.getPipeline('sweep', this.sweepShader(pixelCount, width, height), 'main');
            let src = ua, dst = ub;

            for (let s = 0; s < iter; s++) {
                for (let parity = 0; parity <= 1; parity++) {
                    this.writeBuffer(paramsBuffer, new Uint32Array([width, height, parity, pixelCount]));
                    this.dispatchFlat(sweepPipeline, this.makeBindGroup(sweepPipeline, [
                        { binding: 0, resource: { buffer: seedsBuffer } },
                        { binding: 1, resource: { buffer: speedBuffer } },
                        { binding: 2, resource: { buffer: src } },
                        { binding: 3, resource: { buffer: dst } },
                        { binding: 4, resource: { buffer: paramsBuffer } }
                    ]), pixelCount);
                    [src, dst] = [dst, src];
                }
            }

            const result = await this.readFloat32(src, pixelCount);
            const ms = performance.now() - t0;
            this._usage[label] = ms;
            this._usage.totalMs += ms;
            this.lastUsed = label;
            return result;
        } finally {
            seedsBuffer.destroy(); speedBuffer.destroy(); ua.destroy(); ub.destroy(); paramsBuffer.destroy();
        }
    }

    // True Eikonal distance field: seeds = pixels below threshold, speed = luminance.
    async solveEikonal(gray, width, height, threshold, iterations) {
        this._assertReady();
        const pixelCount = width * height;

        // Build seeds array (CPU loop — cheap, keeps GPU kernels generic)
        const seeds = new Float32Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
            seeds[i] = gray[i] < threshold ? 1 : 0;
        }
        return this.solveDistanceField(seeds, gray, width, height, iterations, 'eikonal');
    }

    // Unsigned distance to image edges (Sobel magnitude above edgeThreshold).
    // Pass a precomputed { gradMag } to skip the internal Sobel pass.
    async edgeDistance(gray, width, height, edgeThreshold, iterations, precomputed) {
        this._assertReady();
        const pixelCount = width * height;

        let gm;
        if (precomputed && precomputed.gradMag) {
            gm = precomputed.gradMag;
        } else {
            const grad = await this.sobelGradient(gray, width, height);
            gm = grad.gradMag;
        }

        // Edge mask + unit speed
        const seeds = new Float32Array(pixelCount);
        const speed = new Float32Array(pixelCount);
        const th = edgeThreshold != null ? edgeThreshold : 0.12;
        for (let i = 0; i < pixelCount; i++) {
            if (gm[i] > th) { seeds[i] = 1; }
            speed[i] = 1.0;
        }

        const result = await this.solveDistanceField(seeds, speed, width, height, iterations, 'edgeDistance');
        return result;
    }

    // Suggestion: sensible sweep count for a given image size
    static suggestedIterations(width, height) {
        const maxDim = Math.max(width, height);
        return Math.min(140, Math.max(64, Math.round(Math.sqrt(maxDim) * 0.5) + 36));
    }

    _assertReady() {
        if (!this.available || !this.device) {
            throw new Error('WebGPU not available');
        }
    }

    destroy() {
        this._pipelines.clear();
        if (this.device) {
            try { this.device.destroy(); } catch (e) { /* ignore */ }
            this.device = null;
        }
        this.available = false;
        this.initialized = false;
    }
}

// Global singleton (main thread only; worker.js does not load this file)
const gpuManager = (typeof window !== 'undefined') ? new WebGPUManager() : null;
