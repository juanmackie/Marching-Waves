# Marching Waves

DEMO LINK: https://juanmackie.github.io/Marching-Waves/

**Generate contour-based artwork using the Eikonal Equation**

Marching Waves is an advanced computational art generator that creates beautiful, mathematically-derived contour artwork from images. It uses sophisticated algorithms including the Eikonal equation, Fast Marching Method, and Marching Squares to generate artistic representations of images as contour lines, streamlines, stipple patterns, and more.

## Features

### Core Algorithms
- **Eikonal Equation Solver**: Uses both GPU-accelerated Jump Flooding Algorithm (JFA) and CPU-based Fast Marching Method (FMM) to solve the Eikonal equation for distance field computation
- **Marching Squares**: Extracts contour lines from the computed distance field
- **Adaptive Contours**: Dynamic contour density based on image features and gradients
- **Streamline Tracing**: Flow-based line art following image gradients
- **Stipple Generation**: Weighted stipple patterns using Poisson disk sampling
- **TSP Art**: Traveling Salesman Problem-based continuous line art
- **Cross-Hatching**: Multi-layered hatching patterns for tonal representation

### Performance & Technology
- **WebGPU Acceleration**: Leverages modern WebGPU for GPU-accelerated computation (with CPU fallback)
- **Real-time Preview**: Live preview during processing with throttled updates
- **Multi-threaded Processing**: Efficient algorithms for handling large images
- **Memory Optimized**: Efficient data structures and algorithms to handle large datasets

### Artistic Controls
- **Multiple Modes**: Contours, Streamlines, Stipple, TSP Art, and Cross-Hatch
- **Preset Library**: Pre-configured styles including Topographic Map, Blueprint, Flowing Silk, Marble Flow, Ink Stipple, Tangled String, Fluid, Cyberpunk, Ink Blot, Ethereal, and Sketch
- **Fine-grained Controls**: Adjustable contour interval, line width, threshold, smoothness, and more
- **Color Customization**: Full control over line color and anti-aliasing
- **Edge Guidance**: Contours can snap to detected image edges for better feature representation

### Advanced Features
- **Debug Visualization**: View intermediate steps including grayscale conversion, solution heatmap, and raw contours
- **Performance Metrics**: Detailed timing information for each processing stage
- **Region Rerun**: Select and regenerate specific regions of the artwork
- **Pause/Resume/Cancel**: Full control over long-running processes
- **SVG Export**: High-quality vector output for printing and further editing

## How It Works

1. **Image Input**: Load an image (JPEG, PNG, etc.) or use the sample pattern generator
2. **Preprocessing**: Convert image to grayscale and apply inversion if needed
3. **Eikonal Solution**: Solve the Eikonal equation to create a distance field from seed points (determined by threshold)
4. **Contour Extraction**: Use Marching Squares or other algorithms to extract contour lines at specified intervals
5. **Adaptive Enhancement**: Apply edge guidance, smoothness, and detail controls
6. **Path Optimization**: Join and optimize contour segments for clean output
7. **Rendering**: Draw the final artwork to canvas and provide SVG export

## Quick Start

Get Marching Waves running in under 2 minutes:

### Prerequisites
- Python 3 installed (check with `python --version` or `python3 --version`)

### Steps
1. **Start the server:**
   - Windows: Open terminal and run `python -m http.server 8000`
   - Mac/Linux: Open terminal and run `python3 -m http.server 8000`

2. **Open in browser:**
   Navigate to http://localhost:8000

3. **Verify it works:**
   Look for "Background Processing: ACTIVE" in the status panel

### Troubleshooting
- **Python not found?** Install from python.org or use Node.js: `npx http-server`
- **Port 8000 in use?** Use a different port: `python -m http.server 3000`
- **Workers still inactive?** Check browser console (F12) for errors

## Usage

### Getting Started

### Important: Local Server Required

Marching Waves uses Web Workers for background processing, which requires running the application through a local web server. Opening `index.html` directly from the file system will result in restricted functionality and "Background Processing: INACTIVE" status.

### Setup Options

#### Option 1: Python HTTP Server (Recommended)

**Windows:**
```bash
python -m http.server 8000
```

**Mac/Linux:**
```bash
python3 -m http.server 8000
```

Then open: http://localhost:8000

#### Option 2: Node.js HTTP Server

```bash
npx http-server -p 8000
```

Then open: http://localhost:8000

#### Option 3: VS Code Live Server

1. Install the "Live Server" extension
2. Right-click `index.html` → "Open with Live Server"

### Create Startup Scripts (Optional)

**Windows (`start.bat`):**
```batch
@echo off
echo Starting Marching Waves on http://localhost:8000
echo Press Ctrl+C to stop the server
python -m http.server 8000
```

**Mac/Linux (`start.sh`):**
```bash
#!/bin/bash
echo "Starting Marching Waves on http://localhost:8000"
echo "Press Ctrl+C to stop the server"
python3 -m http.server 8000
```

### Using the Application

1. Open http://localhost:8000 in your browser
2. Load an image by dragging and dropping or clicking the drop zone
3. Adjust parameters using the control panel
4. Click "Generate Artwork" to create your contour art
5. Export as SVG when satisfied with the result

### Verification

When running correctly, you should see:
- "Background Processing: ACTIVE" in the status panel
- No "SecurityError" messages in the browser console
- Faster processing with multiple workers active

### Parameter Guide
- **Mode**: Choose the generation algorithm (Contours, Streamlines, Stipple, TSP, Hatch)
- **Preset**: Apply pre-configured settings for different artistic styles
- **Contour Interval**: Spacing between contour lines (lower = denser)
- **Line Width**: Thickness of drawn lines
- **Threshold**: Determines which pixels become origin points
- **Edge Guidance**: Enable/disable contour snapping to image edges
- **Edge Sensitivity**: Strength of edge guidance effect
- **Detail Level**: Adaptive contour density in complex areas
- **Contour Smoothness**: Post-processing smoothing of contour paths
- **Feature Importance**: Bias towards important image features

### Performance Options
- **Max Segments**: Limit for performance (higher = more detail, slower)
- **Skip Path Joining**: Faster processing with potentially disconnected segments
- **Live Preview**: Real-time updates during extraction (disable for speed)
- **GPU Acceleration**: Use WebGPU when available (recommended)

## Troubleshooting

### Background Processing Shows "INACTIVE"

**Problem:** You see "Background Processing: INACTIVE (Main Thread Only)" or "FAILED"

**Solutions:**
1. Make sure you're running from a local server, not opening `index.html` directly
2. Check browser console (F12 → Console tab) for specific errors
3. Common error: `SecurityError: Script cannot be accessed from origin 'null'`
4. Restart the server and refresh the page

### Python Not Found

**Problem:** `python` or `python3` command not recognized

**Solutions:**
1. Install Python from https://python.org/downloads/
2. Add Python to your system PATH
3. Alternative: Use Node.js server: `npx http-server`
4. Alternative: Use VS Code Live Server extension

### Port Already in Use

**Problem:** Server fails to start with "Address already in use" error

**Solutions:**
1. Use a different port: `python -m http.server 3000`
2. Find and stop the process using port 8000:
   - Windows: `netstat -ano | findstr :8000`
   - Mac/Linux: `lsof -i :8000`

### Browser Console Errors

**Common Issues:**
- `SecurityError`: Opening from file:// - use a server instead
- `Worker failed to load`: Check that `worker.js` is in the same directory as `index.html`
- `CORS error`: Ensure all files are served from the same origin

### Performance Issues

**Problem:** Processing is slow or browser becomes unresponsive

**Solutions:**
1. Verify workers are active (status shows "ACTIVE")
2. Try reducing image size before processing
3. Disable "Live Preview" in performance options
4. Reduce "Max Segments" parameter
5. Check that GPU acceleration is enabled

## Technical Architecture

The application is built as a single-page application using pure JavaScript with no external dependencies:

- **Core Engine**: `MarchingWaves` class handles all image processing
- **GPU Manager**: `WebGPUManager` class manages WebGPU operations
- **Live Preview**: `LivePreviewManager` handles real-time visualization
- **UI Components**: Built with vanilla HTML/CSS/JavaScript
- **Algorithms**: Implemented from scratch including FMM, JFA, Marching Squares, and Poisson sampling

## Browser Compatibility

- **Modern Chrome/Firefox/Edge**: Full WebGPU support, Web Worker support
- **Safari**: Limited WebGPU support (falls back to CPU), Web Worker support
- **Older browsers**: CPU-only mode, Web Worker support varies

**Important:** Web Workers require the application to run through a local web server (http://). Opening from file:// protocol will disable worker functionality.

## Development

### Running During Development

Start a local server before making changes:
```bash
python -m http.server 8000
```

The server supports hot-reloading - just refresh the browser (F5) after making changes to see updates.

For extensive debugging, check the browser console (F12 → Console) for:
- Worker initialization messages
- Processing progress updates
- Performance timing information
- Error details

### Test Files

The repository contains multiple test files for development and verification:
- `test.html`, `comprehensive_test.html`: Various test implementations
- `verify_fix.js`: Verification scripts for bug fixes
- `debug_test.js`: Debugging utilities

## Contributing

This project welcomes contributions! Areas for improvement include:
- Additional artistic modes
- More sophisticated optimization algorithms
- Enhanced UI/UX features
- Performance improvements
- Better mobile support

## License

MIT License - see LICENSE file for details.

## Credits

Developed by Juan Mackie as an experimental computational art project exploring the intersection of mathematics, computer graphics, and digital art.
