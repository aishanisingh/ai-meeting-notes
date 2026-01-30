const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

class TranscriptionService {
  constructor(store) {
    this.store = store;
    this.realtimeActive = false;
    this.realtimeInterval = null;
    this.transcriptBuffer = '';
    this.lastProcessedDuration = 0;
    this.currentMeetingId = null;
    this.tempDir = path.join(app.getPath('userData'), 'temp');
    this.audioRecorder = null;

    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    } catch (err) {
      console.error('Error creating temp directory:', err);
    }
  }

  getGroqClient(apiKey) {
    if (!apiKey) {
      throw new Error('Groq API key not configured. Please add your API key in Settings.');
    }
    return new Groq({ apiKey });
  }

  async transcribeFile(audioPath, apiKey) {
    console.log('transcribeFile called with:', audioPath);

    if (!apiKey) {
      throw new Error('Groq API key not configured. Please add your API key in Settings.');
    }

    if (!audioPath || !fs.existsSync(audioPath)) {
      throw new Error('Audio file not found');
    }

    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`Audio file size: ${fileSizeMB.toFixed(2)}MB`);

    if (stats.size < 1000) {
      throw new Error('Audio file is too small - no audio was recorded.');
    }

    // Groq has 25MB limit like OpenAI
    if (fileSizeMB > 25) {
      return this.transcribeLargeFile(audioPath, apiKey);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Transcription attempt ${attempt}/3 using Groq Whisper...`);
        const groq = this.getGroqClient(apiKey);

        const response = await groq.audio.transcriptions.create({
          file: fs.createReadStream(audioPath),
          model: 'whisper-large-v3',
          response_format: 'verbose_json',
          language: 'en'
        });

        // Format transcript with timestamps
        const segments = response.segments || [];
        let formattedTranscript = '';

        if (segments.length > 0) {
          for (const segment of segments) {
            const timestamp = this.formatTime(segment.start);
            formattedTranscript += `[${timestamp}] ${segment.text.trim()}\n`;
          }
        } else {
          formattedTranscript = response.text || '';
        }

        console.log('Transcription successful');
        return formattedTranscript;

      } catch (error) {
        lastError = error;
        console.error(`Transcription attempt ${attempt} failed:`, error.message);

        if (error.message?.includes('Invalid API') || error.status === 401) {
          throw new Error('Invalid Groq API key. Please check your API key in Settings.');
        }

        if (error.message?.includes('rate limit') || error.status === 429) {
          console.log('Rate limited, waiting...');
          await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
        }

        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    throw new Error(`Transcription failed: ${lastError?.message || 'Unknown error'}`);
  }

  async transcribeLargeFile(audioPath, apiKey) {
    const chunkDuration = 600; // 10 minutes
    const baseName = path.basename(audioPath, path.extname(audioPath));

    const duration = await this.getAudioDuration(audioPath);
    const numChunks = Math.ceil(duration / chunkDuration);

    console.log(`Large file: ${duration}s, splitting into ${numChunks} chunks`);

    let fullTranscript = '';
    let timeOffset = 0;

    for (let i = 0; i < numChunks; i++) {
      const chunkPath = path.join(this.tempDir, `${baseName}_chunk_${i}.wav`);
      const startTime = i * chunkDuration;

      console.log(`Processing chunk ${i + 1}/${numChunks}...`);

      try {
        await this.extractAudioChunk(audioPath, chunkPath, startTime, chunkDuration);

        const groq = this.getGroqClient(apiKey);
        const response = await groq.audio.transcriptions.create({
          file: fs.createReadStream(chunkPath),
          model: 'whisper-large-v3',
          response_format: 'verbose_json',
          language: 'en'
        });

        const segments = response.segments || [];
        for (const segment of segments) {
          const adjustedStart = segment.start + timeOffset;
          const timestamp = this.formatTime(adjustedStart);
          fullTranscript += `[${timestamp}] ${segment.text.trim()}\n`;
        }
      } catch (error) {
        console.error(`Error transcribing chunk ${i}:`, error.message);
      }

      timeOffset += chunkDuration;

      try {
        if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
      } catch (e) {}
    }

    return fullTranscript;
  }

  async getAudioDuration(audioPath) {
    return new Promise((resolve) => {
      try {
        const ffprobe = spawn('ffprobe', [
          '-v', 'quiet',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          audioPath
        ]);

        let output = '';
        ffprobe.stdout.on('data', (data) => {
          output += data.toString();
        });

        ffprobe.on('close', (code) => {
          if (code === 0 && output.trim()) {
            resolve(parseFloat(output.trim()));
          } else {
            resolve(60);
          }
        });

        ffprobe.on('error', () => resolve(60));
        setTimeout(() => resolve(60), 5000);
      } catch (err) {
        resolve(60);
      }
    });
  }

  async extractAudioChunk(inputPath, outputPath, startTime, duration) {
    return new Promise((resolve, reject) => {
      try {
        const ffmpeg = spawn('ffmpeg', [
          '-i', inputPath,
          '-ss', startTime.toString(),
          '-t', duration.toString(),
          '-ar', '16000',
          '-ac', '1',
          '-y',
          outputPath
        ]);

        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited with code ${code}`));
        });

        ffmpeg.on('error', reject);
        setTimeout(() => {
          try { ffmpeg.kill(); } catch (e) {}
          reject(new Error('ffmpeg timeout'));
        }, 30000);
      } catch (err) {
        reject(err);
      }
    });
  }

  startRealtime(meetingId, apiKey, audioRecorder, callback) {
    this.realtimeActive = true;
    this.currentMeetingId = meetingId;
    this.transcriptBuffer = '';
    this.lastProcessedDuration = 0;
    this.audioRecorder = audioRecorder;

    console.log('=== Starting real-time transcription for meeting:', meetingId);
    callback('Listening... speak to see your words appear here.', false);

    // Process audio every 12 seconds for better context and accuracy
    const processInterval = 12000;

    this.realtimeInterval = setInterval(async () => {
      if (!this.realtimeActive) return;

      try {
        await this.processRealtimeChunk(apiKey, callback);
      } catch (error) {
        console.error('Real-time transcription error:', error.message);
      }
    }, processInterval);

    // First check after 5 seconds to give faster initial feedback
    setTimeout(async () => {
      if (this.realtimeActive) {
        console.log('>>> First transcription check...');
        try {
          await this.processRealtimeChunk(apiKey, callback);
        } catch (error) {
          console.error('Initial transcription error:', error.message);
        }
      }
    }, 5000);

    // Second check at 10 seconds in case first one didn't have enough audio
    setTimeout(async () => {
      if (this.realtimeActive && this.transcriptBuffer === '') {
        console.log('>>> Second transcription check...');
        try {
          await this.processRealtimeChunk(apiKey, callback);
        } catch (error) {
          console.error('Second transcription error:', error.message);
        }
      }
    }, 10000);
  }

  async processRealtimeChunk(apiKey, callback) {
    if (!this.currentMeetingId) return;

    const recordingPath = path.join(
      app.getPath('userData'),
      'recordings',
      `${this.currentMeetingId}.wav`
    );

    if (!fs.existsSync(recordingPath)) {
      console.log('Recording file not found yet at:', recordingPath);
      return;
    }

    let stats;
    try {
      stats = fs.statSync(recordingPath);
    } catch (err) {
      console.log('Cannot stat recording file:', err.message);
      return;
    }

    console.log(`Recording file size: ${stats.size} bytes`);

    if (stats.size < 32000) {
      console.log('Recording file too small, waiting...');
      return;
    }

    // First, copy the current recording to a temp file to avoid lock issues
    const tempCopyPath = path.join(this.tempDir, `copy_${Date.now()}.wav`);

    try {
      await this.copyAudioFile(recordingPath, tempCopyPath);
    } catch (err) {
      console.log('Failed to copy recording file:', err.message);
      return;
    }

    if (!fs.existsSync(tempCopyPath)) {
      console.log('Temp copy not created');
      return;
    }

    const duration = await this.getAudioDuration(tempCopyPath);
    console.log(`Duration: ${duration}s, Last processed: ${this.lastProcessedDuration}s`);

    if (duration - this.lastProcessedDuration < 5) {
      try { fs.unlinkSync(tempCopyPath); } catch (e) {}
      return;
    }

    const chunkPath = path.join(this.tempDir, `realtime_${Date.now()}.wav`);
    const chunkStart = this.lastProcessedDuration;
    const chunkDuration = duration - chunkStart;

    try {
      console.log(`Extracting chunk: ${chunkStart}s to ${duration}s (${chunkDuration}s)`);
      await this.extractAudioChunk(tempCopyPath, chunkPath, chunkStart, chunkDuration);

      // Clean up temp copy
      try { fs.unlinkSync(tempCopyPath); } catch (e) {}

      if (!fs.existsSync(chunkPath)) {
        console.log('Chunk file not created');
        return;
      }

      const chunkStats = fs.statSync(chunkPath);
      console.log(`Chunk file size: ${chunkStats.size} bytes`);

      if (chunkStats.size < 8000) {
        console.log('Chunk too small, skipping');
        fs.unlinkSync(chunkPath);
        return;
      }

      console.log('Sending to Groq Whisper...');
      const groq = this.getGroqClient(apiKey);
      const response = await groq.audio.transcriptions.create({
        file: fs.createReadStream(chunkPath),
        model: 'whisper-large-v3',
        response_format: 'text',
        language: 'en',
        temperature: 0
      });

      try { fs.unlinkSync(chunkPath); } catch (e) {}

      const text = response?.trim();
      if (text && text.length > 0) {
        this.transcriptBuffer = this.transcriptBuffer
          ? this.transcriptBuffer + ' ' + text
          : text;

        console.log('>>> Live transcript update:', text.substring(0, 80));
        callback(this.transcriptBuffer, false);
      } else {
        console.log('No text in transcription response');
      }

      this.lastProcessedDuration = duration;

    } catch (error) {
      console.error('Chunk processing error:', error.message);
      try { if (fs.existsSync(tempCopyPath)) fs.unlinkSync(tempCopyPath); } catch (e) {}
      try { if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath); } catch (e) {}
    }
  }

  async copyAudioFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      try {
        const ffmpeg = spawn('ffmpeg', [
          '-i', inputPath,
          '-acodec', 'copy',
          '-y',
          outputPath
        ]);

        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`ffmpeg copy failed: ${stderr.slice(-200)}`));
          }
        });

        ffmpeg.on('error', (err) => {
          reject(err);
        });

        setTimeout(() => {
          try { ffmpeg.kill(); } catch (e) {}
          reject(new Error('ffmpeg copy timeout'));
        }, 10000);
      } catch (err) {
        reject(err);
      }
    });
  }

  stopRealtime() {
    console.log('Stopping real-time transcription');
    this.realtimeActive = false;

    if (this.realtimeInterval) {
      clearInterval(this.realtimeInterval);
      this.realtimeInterval = null;
    }

    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        if (file.startsWith('realtime_')) {
          try { fs.unlinkSync(path.join(this.tempDir, file)); } catch (e) {}
        }
      }
    } catch (e) {}

    this.currentMeetingId = null;
    this.lastProcessedDuration = 0;
    this.transcriptBuffer = '';
    this.audioRecorder = null;
  }

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}

module.exports = { TranscriptionService };
