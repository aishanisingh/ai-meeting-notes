const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

class AudioRecorder {
  constructor() {
    this.recording = false;
    this.process = null;
    this.outputPath = null;
    this.dataDir = path.join(app.getPath('userData'), 'recordings');
    this.chunkDir = path.join(app.getPath('userData'), 'chunks');
    this.chunkInterval = null;
    this.chunkIndex = 0;
    this.currentMeetingId = null;
    this.onChunkCallback = null;

    // Ensure directories exist
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.chunkDir)) {
      fs.mkdirSync(this.chunkDir, { recursive: true });
    }
  }

  start(meetingId, onChunk = null) {
    if (this.recording) return;

    this.recording = true;
    this.currentMeetingId = meetingId;
    this.outputPath = path.join(this.dataDir, `${meetingId}.wav`);
    this.chunkIndex = 0;
    this.onChunkCallback = onChunk;

    console.log('Starting audio recording to:', this.outputPath);

    // Clean up old chunks
    this.cleanupChunks();

    // Start continuous recording with ffmpeg
    this.startFFmpegRecording();
  }

  startFFmpegRecording() {
    try {
      // Use ffmpeg to record continuously with flush for real-time access
      // Using ':0' for audio-only input from default microphone
      this.process = spawn('ffmpeg', [
        '-f', 'avfoundation',
        '-i', ':0',  // Default audio input (no video, audio device 0)
        '-ar', '44100',  // Higher sample rate for better quality
        '-ac', '1',
        '-acodec', 'pcm_s16le',
        '-flush_packets', '1',  // Flush output immediately for real-time reading
        '-fflags', '+genpts',   // Generate timestamps
        '-y',
        this.outputPath
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process.on('error', (err) => {
        console.error('FFmpeg spawn error:', err.message);
        // Try sox as fallback
        this.startSoxRecording();
      });

      let stderrOutput = '';
      this.process.stderr.on('data', (data) => {
        const str = data.toString();
        stderrOutput += str;
        // Log important messages
        if (str.includes('error') || str.includes('Error') || str.includes('Permission')) {
          console.error('FFmpeg stderr:', str);
        }
        // Check for successful stream detection
        if (str.includes('Input #0')) {
          console.log('FFmpeg detected audio input successfully');
        }
      });

      this.process.on('close', (code) => {
        console.log('FFmpeg process closed with code:', code);
        if (code !== 0 && code !== null) {
          console.error('FFmpeg exited with error. Last stderr:', stderrOutput.slice(-500));
        }
      });

      console.log('FFmpeg recording started with command: ffmpeg -f avfoundation -i :0 -ar 16000 -ac 1 -acodec pcm_s16le -y', this.outputPath);

    } catch (err) {
      console.error('Failed to start FFmpeg:', err);
      this.startSoxRecording();
    }
  }

  startSoxRecording() {
    try {
      console.log('Trying sox recorder...');
      this.process = spawn('rec', [
        '-c', '1',
        '-r', '44100',
        '-b', '16',
        '-e', 'signed-integer',
        this.outputPath
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process.on('error', (err) => {
        console.error('Sox error:', err.message);
        this.recording = false;
      });

      this.process.on('close', (code) => {
        console.log('Sox process closed with code:', code);
      });

      console.log('Sox recording started');

    } catch (err) {
      console.error('Failed to start sox:', err);
      this.recording = false;
    }
  }

  // Get a copy of current recording for processing
  async getCurrentAudioSnapshot() {
    if (!this.recording || !this.outputPath) {
      return null;
    }

    try {
      // Check if the file exists and has content
      if (!fs.existsSync(this.outputPath)) {
        return null;
      }

      const stats = fs.statSync(this.outputPath);
      if (stats.size < 10000) {
        return null; // Too small
      }

      // Create a snapshot copy for processing
      const snapshotPath = path.join(this.chunkDir, `snapshot_${this.currentMeetingId}_${Date.now()}.wav`);

      // Use ffmpeg to copy current state of the file
      return new Promise((resolve) => {
        const copyProcess = spawn('ffmpeg', [
          '-i', this.outputPath,
          '-acodec', 'copy',
          '-y',
          snapshotPath
        ]);

        copyProcess.on('close', (code) => {
          if (code === 0 && fs.existsSync(snapshotPath)) {
            resolve(snapshotPath);
          } else {
            resolve(null);
          }
        });

        copyProcess.on('error', () => {
          resolve(null);
        });

        // Timeout after 5 seconds
        setTimeout(() => {
          resolve(null);
        }, 5000);
      });

    } catch (err) {
      console.error('Error getting audio snapshot:', err);
      return null;
    }
  }

  stop() {
    return new Promise((resolve) => {
      console.log('Stopping audio recording...');

      if (!this.recording) {
        console.log('Not recording, nothing to stop');
        resolve(null);
        return;
      }

      this.recording = false;
      let resolved = false;

      const finishWithPath = (path) => {
        if (resolved) return;
        resolved = true;
        this.cleanupChunks();
        resolve(path);
      };

      // Clear any intervals
      if (this.chunkInterval) {
        clearInterval(this.chunkInterval);
        this.chunkInterval = null;
      }

      const outputPath = this.outputPath;
      console.log('Output path:', outputPath);

      if (this.process) {
        const proc = this.process;
        this.process = null;

        // Try graceful shutdown first
        try {
          proc.stdin.write('q');
        } catch (e) {
          // Ignore stdin errors
        }

        // Send SIGINT after a short delay
        setTimeout(() => {
          try {
            proc.kill('SIGINT');
          } catch (e) {
            // Process might already be dead
          }
        }, 500);

        // Wait for process to close
        proc.on('close', () => {
          console.log('Recording process closed');

          // Wait for file to be fully written
          setTimeout(() => {
            if (fs.existsSync(outputPath)) {
              const stats = fs.statSync(outputPath);
              console.log('Recording saved:', outputPath, 'Size:', stats.size);
              if (stats.size > 1000) {
                finishWithPath(outputPath);
              } else {
                console.log('Recording file too small');
                finishWithPath(null);
              }
            } else {
              console.log('Recording file not found after close');
              finishWithPath(null);
            }
          }, 1000);
        });

        // Timeout fallback - longer wait for larger files
        setTimeout(() => {
          if (!resolved) {
            console.log('Stop timeout reached, checking file...');
            if (fs.existsSync(outputPath)) {
              const stats = fs.statSync(outputPath);
              console.log('Recording found via timeout:', outputPath, 'Size:', stats.size);
              finishWithPath(outputPath);
            } else {
              console.log('Recording file not found via timeout');
              finishWithPath(null);
            }
          }
        }, 5000);

      } else {
        if (fs.existsSync(outputPath)) {
          finishWithPath(outputPath);
        } else {
          finishWithPath(null);
        }
      }
    });
  }

  cleanupChunks() {
    try {
      const files = fs.readdirSync(this.chunkDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.chunkDir, file));
        } catch (e) {
          // Ignore deletion errors
        }
      }
    } catch (e) {
      // Ignore errors
    }
  }

  isRecording() {
    return this.recording;
  }
}

module.exports = { AudioRecorder };
