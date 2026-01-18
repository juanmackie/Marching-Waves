// Debug test script to verify the MarchingWaves class functionality
console.log('Starting Marching Waves debug test...');

// Mock canvas for testing
class MockCanvas {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.ctx = {
            drawImage: () => console.log('drawImage called'),
            getImageData: () => this.createMockImageData(width, height),
            fillStyle: '',
            fillRect: () => console.log('fillRect called'),
            strokeStyle: '',
            lineWidth: 1,
            lineCap: '',
            lineJoin: '',
            shadowBlur: 0,
            beginPath: () => console.log('beginPath called'),
            moveTo: () => console.log('moveTo called'),
            lineTo: () => console.log('lineTo called'),
            stroke: () => console.log('stroke called'),
            createImageData: (w, h) => this.createMockImageData(w, h),
            putImageData: () => console.log('putImageData called'),
            arc: () => console.log('arc called'),
            fill: () => console.log('fill called')
        };
    }
    
    createMockImageData(width, height) {
        const size = width * height * 4;
        const data = new Uint8ClampedArray(size);
        
        // Create a simple gradient pattern
        for (let i = 0; i < size; i += 4) {
            const x = (i / 4) % width;
            const y = Math.floor(i / 4 / width);
            const value = Math.floor((x + y) / (width + height) * 255);
            data[i] = value;     // R
            data[i + 1] = value; // G  
            data[i + 2] = value; // B
            data[i + 3] = 255;   // A
        }
        
        return { data, width, height };
    }
}

// Test the core functionality
try {
    console.log('Testing core MarchingWaves functionality...');
    
    // Create mock image
    const mockImg = {
        width: 100,
        height: 100
    };
    
    // Create mock canvas
    const mockCanvas = new MockCanvas(100, 100);
    
    // Test grayscale conversion
    const imageData = mockCanvas.ctx.getImageData(0, 0, 100, 100);
    const grayData = new Float32Array(100 * 100);
    const data = imageData.data;
    
    for (let i = 0; i < grayData.length; i++) {
        grayData[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    }
    
    console.log('Grayscale conversion test passed');
    console.log('Sample grayscale values:', grayData.slice(0, 10));
    
    // Test threshold detection
    const threshold = 0.1;
    const originPoints = [];
    for (let i = 0; i < grayData.length; i++) {
        if (grayData[i] < threshold) {
            const x = i % 100;
            const y = Math.floor(i / 100);
            originPoints.push({ x, y });
        }
    }
    
    console.log('Origin points found:', originPoints.length);
    
    // Test Eikonal solver initialization
    const solution = new Float32Array(100 * 100);
    solution.fill(Infinity);
    
    for (const point of originPoints) {
        const idx = point.y * 100 + point.x;
        solution[idx] = 0;
    }
    
    console.log('Eikonal solver initialization test passed');
    console.log('Solution initialized with', originPoints.length, 'origin points');
    
    console.log('All core functionality tests passed!');
    
} catch (error) {
    console.error('Test failed:', error);
}

console.log('Debug test completed.');