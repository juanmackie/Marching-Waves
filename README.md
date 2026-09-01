# Marching Waves

DEMO LINK: https://juanmackie.github.io/Marching-Waves/

**Create contour artwork from images**

Marching Waves is a computational art generator. It creates contour artwork from images. It uses Marching Squares over luminance fields or distance fields. It computes the distance fields with the Eikonal equation (the Fast Marching Method). It supports seven artistic modes: contours, streamlines, stipple, TSP continuous line, cross hatch, and Subject Wire.

## Characteristics

### Core algorithms

- **Luminance Contours** (default): the application extracts contours directly from image brightness. It is fast. It does not need preprocessing.
- **Eikonal Equation Solver**: a WebGPU red-black sweep solver computes the true Eikonal field (speed = luminance). The CPU Fast Marching Method is the fallback for the distance field computation.
- **Marching Squares**: extracts contour lines from any scalar field.
- **Adaptive Contours**: the contour density changes with the image gradients.
- **Streamlines**: line art that follows the image gradients.
- **Stipple**: weighted stipple patterns from Poisson disk sampling.
- **TSP Art**: continuous line art from the Traveling Salesman Problem.
- **Cross Hatch**: layered hatch patterns that represent tones.
- **Subject Wire**: a local saliency-and-flow heuristic that distills a focal subject into sparse, open, hand-drawn wire paths without copying the background.
- **Fashion Sketch**: a preset for monochrome editorial ink sketches with sparse, expressive strokes on a white background. It uses Subject Wire rather than semantic fashion or pose recognition.

### Performance and technology

- **WebGPU acceleration**: the GPU does the preprocessing (grayscale, blur, contrast), the Sobel gradients, and the true Eikonal sweep solver (red-black Jacobi). The CPU fallback (Fast Marching Method) starts automatically when WebGPU is not available.
- **Real-time preview**: you see the result during processing. The updates have a controlled rate.
- **Multi-threaded processing**: Web Workers do the computation in the background.
- **Memory optimized**: the data structures and algorithms handle large datasets efficiently.

### Ready for pen plotters

- **Clean vector output**: the application joins, simplifies, and smooths the paths. It keeps the corners. Pen lifts are minimal.
- **SVG export**: you can export the vector paths for pen plotters and other plotting software (AxiDraw, Inkscape, LightBurn, etc.).
- **Preprocess controls**: the Denoise (Blur) and Contrast sliders clean up photos before extraction. Line art is much better on noisy sources.
- **Variable line width**: the application varies the line width with the image gradient. This gives an engraving effect.

### Adaptive and quality

- **Real edge guidance**: contours snap toward detected image edges. This did not work before.
- **Gradient-histogram adaptive levels**: the contour density follows the actual image detail. It does not use linear spacing.
- **Percentile-based luminance levels**: the lines distribute evenly across the tonal range that is present.
- **Corner-aware smoothing**: the application smooths gentle bends. It keeps sharp corners.

### Artistic controls

- **Many modes**: Luminance Contours, Eikonal Contours, Streamlines, Stipple, TSP Art, Cross Hatch, and Subject Wire.
- **Subject Wire controls**: tune subject focus, wire density, pressure/tension, relationship lines, abstraction, and hand-drawn variation. This mode is heuristic rather than semantic object or pose recognition.
- **Preset library**: pre-configured styles. Examples: Natural Contours, Topographic Map, Blueprint, Flowing Silk, Marble Flow, Ink Stipple, Tangled String, Fluid, Cyberpunk, Ink Blot, Ethereal, Sketch, Subject Wire, and Fashion Sketch.
- **Fine-grained controls**: you can adjust the level step, line width, threshold, smoothness, and more.
- **Color customization**: you control the line color and rendering style.
- **Edge guidance**: contours can snap to detected image edges. This gives better line art.
- **Ink Bleed**: a soft, two-layer bloom around the ink lines — a broad faint wash plus a tighter darker edge — simulating ink bleeding into the surface. It renders in real time on the canvas and is preserved in the exported SVG as a normal vector `<filter>`, so the file stays portable.

### Advanced characteristics

- **Debug visualization**: you can view the intermediate steps. Examples: grayscale conversion, solution heatmap, and raw contours.
- **Performance metrics**: the application shows the timing for each processing stage.
- **Region rerun**: you can select a region of the artwork and create it again.
- **Pause/Resume/Cancel**: you can pause, resume, or cancel long processes.
- **SVG export**: high-quality vector output for printing and further editing.

## How it works

1. **Image input**: load an image (JPEG, PNG, etc.) or use the sample pattern generator.
2. **Preprocessing**: the application converts the image to grayscale. It applies inversion if necessary.
3. **Field computation**: it uses the image luminance directly (default). Or it solves the Eikonal equation to create a distance field.
4. **Extraction**: it uses Marching Squares for contour modes, or a local saliency/force-field pass for Subject Wire.
5. **Adaptive enhancement**: it applies edge guidance, smoothness, detail, and subject-wire abstraction controls.
6. **Path optimization**: it joins, simplifies, and smooths the paths for clean output.
7. **Rendering**: it draws the final artwork on the canvas and provides SVG export.

## Quick start

You can run Marching Waves in under 2 minutes.

### Requirements

- Python 3 installed (check with `python --version` or `python3 --version`)

### Steps

1. **Start the server:**
   - Windows: open a terminal and run `python -m http.server 8000`.
   - Mac/Linux: open a terminal and run `python3 -m http.server 8000`.

2. **Open the browser:**
   Go to http://localhost:8000.

3. **Check the operation:**
   Look for "Background Processing: ACTIVE" in the status panel.

### Common problems

- **Python not found?** Install it from python.org. Or use Node.js: `npx http-server`.
- **Port 8000 in use?** Use a different port: `python -m http.server 3000`.
- **Workers still inactive?** Check the browser console (F12) for errors.

## Use

### Important: local server required

Marching Waves uses Web Workers for background processing. Web Workers require a local web server. If you open `index.html` directly from the file system, some functions do not work. The status shows "Background Processing: INACTIVE".

### Setup alternatives

#### Alternative 1: Python HTTP server (use this one)

**Windows:**
```bash
python -m http.server 8000
```

**Mac/Linux:**
```bash
python3 -m http.server 8000
```

Then open: http://localhost:8000

#### Alternative 2: Node.js HTTP server

```bash
npx http-server -p 8000
```

Then open: http://localhost:8000

#### Alternative 3: VS Code Live Server

1. Install the "Live Server" extension.
2. Right-click `index.html`.
3. Select "Open with Live Server".

### Create start scripts (optional)

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

### Use the application

1. Open http://localhost:8000 in your browser.
2. Load an image. Drag and drop it, or click the drop zone.
3. Adjust the parameters in the control panel.
4. Click "Generate Artwork" to create your contour art.
5. Export the artwork as SVG when the result is good enough.

### Check the result

When the application runs correctly, you see:

- "Background Processing: ACTIVE" in the status panel.
- "GPU · WebGPU" in the header readout. The sidebar shows the adapter details. "CPU" means WebGPU is not available. The CPU fallback is active.
- No "SecurityError" messages in the browser console.
- Faster processing when many workers are active.

### GPU acceleration notes

Marching Waves uses WebGPU for:

1. **Preprocessing** — grayscale conversion, separable Gaussian blur (denoise), contrast stretch.
2. **Gradients** — Sobel magnitude for adaptive levels, edge guidance, and variable line width.
3. **Eikonal solver** — a red-black Jacobi sweep solver computes the true Eikonal distance field (speed = luminance). It converges to the same viscosity solution as the CPU Fast Marching Method.
4. **Edge distance field** — unsigned distance to image edges for edge guidance.

Requirements: a WebGPU-capable browser (Chrome/Edge 113+, Firefox 141+, Safari 26+) over HTTPS or localhost. If WebGPU is not available, every stage falls back to CPU automatically. The application produces the same artwork, but it is slower. To disable GPU acceleration manually, switch it off in the "Performance" options.

### Parameter guide

- **Mode**: choose the algorithm that creates the artwork (Contours, Streamlines, Stipple, TSP, Hatch, or Subject Wire).
- **Preset**: apply pre-configured settings for different artistic styles.
- **Contour Interval**: spacing between contour lines (lower = denser).
- **Line Width**: thickness of the drawn lines.
- **Threshold**: determines which pixels become origin points.
- **Denoise (Blur)**: blurs the image before extraction. It suppresses noise (GPU-accelerated).
- **Contrast**: applies an S-curve contrast stretch before extraction (GPU-accelerated).
- **Edge Guidance**: contours snap toward detected image edges. This gives better line art.
- **Edge Sensitivity**: the strength of the edge guidance effect.
- **Detail Level**: the adaptive contour density in complex areas.
- **Contour Smoothness**: smooths the contour paths after processing. It keeps the corners.
- **Feature Importance**: the bias toward important image characteristics.
- **Subject Focus**: how selectively Subject Wire isolates the dominant focal region.
- **Wire Density**: the number of long structural lines.
- **Pressure / Tension**: how strongly paths pull toward and tighten around salient structure.
- **Relationship Lines**: how many nearby salient regions are connected.
- **Abstraction**: how aggressively detail is compressed into symbolic movement.
- **Hand-drawn Variation**: deterministic small irregularities that keep the strokes organic.
- **Ink Bleed**: soft outward bloom around the lines, simulating ink bleeding into the surface. `0` = crisp lines (default). Higher values widen the halo. The bloom is drawn *behind* the sharp strokes, so hairlines stay clean. The effect is baked into the exported SVG via an SVG `<filter>`; setting it to `0` reproduces the original crisp output exactly.

### Performance settings

- **Live Preview**: real-time updates during extraction. Switch it off for speed.

## Common problems

### Background processing shows "INACTIVE"

**Problem:** you see "Background Processing: INACTIVE (Main Thread Only)" or "FAILED".

**Solutions:**
1. Run the app from a local server. Do not open `index.html` directly.
2. Check the browser console (F12 → Console tab) for errors.
3. Common error: `SecurityError: Script cannot be accessed from origin 'null'`.
4. Restart the server. Refresh the page.

### Python not found

**Problem:** the `python` or `python3` command is not recognized.

**Solutions:**
1. Install Python from https://python.org/downloads/.
2. Add Python to your system PATH.
3. Alternative: use the Node.js server: `npx http-server`.
4. Alternative: use the VS Code Live Server extension.

### Port already in use

**Problem:** the server fails to start with "Address already in use" error.

**Solutions:**
1. Use a different port: `python -m http.server 3000`.
2. Find the process that uses port 8000 and stop it:
   - Windows: `netstat -ano | findstr :8000`
   - Mac/Linux: `lsof -i :8000`

### Browser console errors

**Common issues:**
- `SecurityError`: you opened the app from `file://`. Use a server instead.
- `Worker failed to load`: check that `worker.js` is in the same directory as `index.html`.
- `CORS error`: make sure all files come from the same origin.

### Performance issues

**Problem:** processing is slow, or the browser does not respond.

**Solutions:**
1. Make sure the workers are active (the status shows "ACTIVE").
2. Reduce the image size before processing.
3. Switch off "Live Preview" in the performance settings.

## The main parts of the application

The application is a single-page application. It uses pure JavaScript with no external dependencies.

- **Core engine**: the `MarchingWaves` class does all image processing.
- **Live preview**: `LivePreviewManager` handles the real-time visualization.
- **UI components**: the UI components use vanilla HTML/CSS/JavaScript.
- **Algorithms**: the application implements the algorithms from scratch. Examples: FMM, Marching Squares, and Poisson sampling.

## Browser support

- **Modern Chrome/Firefox/Edge**: full Web Worker support.
- **Safari**: Web Worker support.
- **Older browsers**: Web Worker support varies.

**Important:** Web Workers require a local web server (http://). If you open the app with the file:// protocol, the workers do not work.

## For developers

### Run during development

Start a local server before you make changes:
```bash
python -m http.server 8000
```

After you make a change, refresh the browser (F5) to see the update.

For extensive debugging, check the browser console (F12 → Console) for:

- Worker initialization messages
- Processing progress updates
- Performance timing information
- Error details

## Help improve the project

You can help improve this project. These areas need work:

- More artistic modes
- Better optimization algorithms
- Better UI/UX
- Performance improvements
- Better mobile support

## License

MIT License — see the LICENSE file for details.

## Credits

Author: Juan Mackie. This is an experimental computational art project. It combines mathematics, computer graphics, and digital art.
