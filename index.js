const fs = require('fs');
const readline = require('readline');
const sharp = require('sharp'); // Replace canvas with sharp
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const cliProgress = require('cli-progress');

// Constants
const CANVAS_SIZE = 1000;
const OUTPUT_VIDEO = 'timelapse.mkv'; // Output video file name

// Function to parse CSV and sort by ID
async function parseAndSortCSV(filePath) {
    const lines = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream });

    // Count total lines and process them in a single pass
    let totalLines = 0;
    for await (const _ of rl) {
        totalLines++;
    }
    rl.close(); // Close the readline interface

    // Reinitialize the stream and readline for processing
    const fileStreamForProcessing = fs.createReadStream(filePath);
    const rlForProcessing = readline.createInterface({ input: fileStreamForProcessing });

    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(totalLines, 0);

    for await (const line of rlForProcessing) {
        const parts = line.split(',');
        let id = parseInt(parts[0], 10);
        const x = parseInt(parts[2], 10);
        const y = parseInt(parts[3], 10);
        let color = parts[6]?.trim();

        // Clamp negative id to 1
        if (isNaN(id) || id < 1) {
            //console.warn(`Invalid or negative ID "${id}". Clamping to 1.`);
            id = 1;
        }

        // Validate x, y, and color
        if (isNaN(x) || isNaN(y) || x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE || !color) {
            //console.warn(`Skipping invalid row: ${line}`);
            continue;
        }

        // Convert color from \x21221d to #RRGGBB format
        try {
            // Remove invalid escape sequences and ensure valid hex format
            const sanitizedColor = color.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => hex).replace(/[^0-9a-fA-F]/g, '');
            if (sanitizedColor.length !== 6) {
                throw new Error(`Invalid color length: ${sanitizedColor}`);
            }
            // Convert color to RGBA format for sharp
            const r = parseInt(sanitizedColor.slice(0, 2), 16);
            const g = parseInt(sanitizedColor.slice(2, 4), 16);
            const b = parseInt(sanitizedColor.slice(4, 6), 16);
            const rgbaColor = { r, g, b, alpha: 1 };

            lines.push({ id, x, y, rgbaColor }); // Store rgbaColor in the array
        } catch (err) {
            //console.warn(`Skipping row with invalid color format "${color}" at ID ${id}.`);
            continue;
        }

        progressBar.increment();
    }

    progressBar.stop();
    const sortedLines = lines.sort((a, b) => a.id - b.id);

    return sortedLines;
}

// Function to generate timelapse
async function generateTimelapse(pixels, pixelsPerFrame) {
    const canvasBuffer = Buffer.alloc(CANVAS_SIZE * CANVAS_SIZE * 4, 255); // Persistent buffer for the canvas (white background)

    const framesPerSecond = 60;

    // Progress bar for frame generation
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(pixels.length, 0);

    const ffmpegProcess = spawn(ffmpegPath, [
        '-y',
        '-f', 'image2pipe',
        '-framerate', framesPerSecond.toString(),
        '-i', 'pipe:0',
        '-pix_fmt', 'yuv420p',
        '-r', framesPerSecond.toString(),
		'-c:v', 'libx264',
		'-preset', 'ultrafast',
        OUTPUT_VIDEO
    ]);

    ffmpegProcess.stdin.on('error', (err) => {
        console.error('Error writing to ffmpeg stdin:', err);
    });

    try {
        for (let i = 0; i < pixels.length; i += pixelsPerFrame) {
            const chunk = pixels.slice(i, i + pixelsPerFrame);

            // Update the canvas buffer with the current chunk
            chunk.forEach(({ x, y, rgbaColor }) => {
                const index = (y * CANVAS_SIZE + x) * 4;
                canvasBuffer[index] = rgbaColor.r;
                canvasBuffer[index + 1] = rgbaColor.g;
                canvasBuffer[index + 2] = rgbaColor.b;
                canvasBuffer[index + 3] = Math.round(rgbaColor.alpha * 255);
            });

            // Generate the current frame from the canvas buffer
            const frame = await sharp(canvasBuffer, {
                raw: { width: CANVAS_SIZE, height: CANVAS_SIZE, channels: 4 }
            }).png().toBuffer();

            ffmpegProcess.stdin.write(frame);

            progressBar.increment(chunk.length);
        }

        ffmpegProcess.stdin.end();
        progressBar.stop();

        await new Promise((resolve, reject) => {
            ffmpegProcess.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`ffmpeg process exited with code ${code}`));
                }
            });

            ffmpegProcess.on('error', (err) => {
                reject(err);
            });
        });
    } catch (err) {
        progressBar.stop();
        ffmpegProcess.stdin.end();
        throw err;
    }
}

// Main function
async function main() {
    const filePath = './data/pixels.csv';
    const framesPerSecond = 60;
    const pixelsPerFrame = parseInt(process.argv[2], 10) || 2; // Accept pixelsPerFrame as argument

    console.log('Parsing and sorting CSV...');
    const pixels = await parseAndSortCSV(filePath);

    console.log('Generating timelapse...');
    await generateTimelapse(pixels, pixelsPerFrame);

    console.log(`Timelapse saved to ${OUTPUT_VIDEO}`);
}

main().catch(err => console.error(err));
