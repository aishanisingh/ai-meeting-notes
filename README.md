# AI Meeting Notes

A native macOS application that automatically detects Zoom meetings, records audio, transcribes using OpenAI Whisper, and generates AI-powered summaries with action items.

## Features

- **Automatic Zoom Detection**: Detects when you join a Zoom meeting and prompts you to record
- **Recording Overlay**: Floating recording indicator on screen during meetings
- **Real-time Transcription**: See transcript updates as the meeting progresses
- **AI Summaries**: GPT-4 powered summaries with key points and action items
- **Clean UI**: Minimalist interface with Summary, Notes, and Transcript tabs
- **System Tray**: Runs in background with quick access from menu bar

## Prerequisites

- macOS 10.15 or later
- FFmpeg installed (`brew install ffmpeg`)
- OpenAI API key

## Installation

1. Clone the repository:
   ```bash
   cd ai-meeting-notes
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the app:
   ```bash
   npm start
   ```

## Configuration

1. Launch the app
2. Click the **Settings** button (gear icon)
3. Enter your OpenAI API key
4. Click **Save**

## Usage

### Manual Recording
1. Click **New Recording** button
2. Enter a meeting title (optional)
3. Click **Start Recording**
4. When done, click **Stop Recording**
5. Wait for transcription and summary to generate

### Automatic Zoom Detection
1. Join a Zoom meeting
2. The app will prompt you to start recording
3. Click **Record Meeting** to begin
4. Recording automatically stops when the meeting ends

### Viewing Meetings
- Click any meeting in the sidebar to view details
- Switch between **Summary**, **Notes**, and **Transcript** tabs
- Add your own notes in the Notes tab

## Building for Distribution

```bash
npm run build
```

The built application will be in the `dist` folder.

## Tech Stack

- **Electron** - Desktop application framework
- **OpenAI Whisper** - Audio transcription
- **GPT-4** - Summary and action item generation
- **electron-store** - Local data persistence

## Audio Recording

The app records using FFmpeg from your default audio input (microphone). For system audio capture (to record both sides of a call):

1. Install BlackHole audio driver: `brew install blackhole-2ch`
2. Create a Multi-Output Device in Audio MIDI Setup
3. Set it as your output device during meetings

## Project Structure

```
ai-meeting-notes/
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.js    # Main entry point
│   │   ├── preload.js  # Preload script
│   │   ├── zoom-detector.js
│   │   ├── audio-recorder.js
│   │   ├── transcription.js
│   │   ├── summarization.js
│   │   └── database.js
│   └── renderer/       # Electron renderer process
│       ├── index.html
│       ├── styles.css
│       ├── app.js
│       └── recording-overlay.html
├── assets/
│   └── tray-icon.png
└── package.json
```

## License

MIT
