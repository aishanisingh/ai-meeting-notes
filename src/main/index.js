const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { ZoomDetector } = require('./zoom-detector');
const { AudioRecorder } = require('./audio-recorder');
const { TranscriptionService } = require('./transcription');
const { SummarizationService } = require('./summarization');
const { Database } = require('./database');

// Set app name
app.setName('Quill');

// CRITICAL: Prevent app from quitting
let isQuitting = false;

// Handle all errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

const store = new Store();
let mainWindow = null;
let recordingOverlay = null;
let tray = null;
let zoomDetector = null;
let audioRecorder = null;
let transcriptionService = null;
let summarizationService = null;
let database = null;
let currentMeetingId = null;
let isRecording = false;
let isPaused = false;
let recordingStartTime = null;
let recordingTimer = null;

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const iconPath = path.join(__dirname, '../../assets/icon.icns');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    backgroundColor: '#ffffff',
    icon: iconPath,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // CRITICAL: Never close, only hide
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    if (!isQuitting) {
      mainWindow = null;
    }
  });
}

function createRecordingOverlay() {
  if (recordingOverlay && !recordingOverlay.isDestroyed()) {
    recordingOverlay.show();
    return;
  }

  recordingOverlay = new BrowserWindow({
    width: 320,
    height: 50,
    x: 20,
    y: 80,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    }
  });

  recordingOverlay.loadFile(path.join(__dirname, '../renderer/recording-overlay.html'));
  recordingOverlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  recordingOverlay.setAlwaysOnTop(true, 'floating');

  recordingOverlay.on('closed', () => {
    recordingOverlay = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  let icon;

  try {
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    } else {
      icon = nativeImage.createEmpty();
    }
  } catch (e) {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  updateTrayMenu();

  tray.on('click', () => {
    createMainWindow();
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open AI Meeting Notes', click: () => createMainWindow() },
    { type: 'separator' },
    { label: isRecording ? 'Stop Recording' : 'Start Recording', click: () => isRecording ? stopRecording() : startRecording() },
    { type: 'separator' },
    { label: 'Settings', click: showSettings },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      isQuitting = true;
      if (tray) tray.destroy();
      app.quit();
    }}
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(isRecording ? 'Recording in progress...' : 'AI Meeting Notes');
}

async function checkMicrophonePermission() {
  try {
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      console.log('Microphone permission status:', status);
      if (status !== 'granted') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        return granted;
      }
      return true;
    }
    return true;
  } catch (error) {
    console.error('Error checking microphone permission:', error);
    return false;
  }
}

async function startRecording(options = {}) {
  if (isRecording) {
    console.log('Already recording');
    return;
  }

  const meetingTitle = options.title || `Meeting ${new Date().toLocaleString()}`;
  const meetingEmoji = options.emoji || null;

  console.log('=== STARTING RECORDING ===');
  console.log('Title:', meetingTitle, 'Emoji:', meetingEmoji);

  try {
    const hasPermission = await checkMicrophonePermission();
    if (!hasPermission) {
      dialog.showErrorBox('Microphone Access Required', 'Please grant microphone access in System Preferences > Security & Privacy > Privacy > Microphone');
      return;
    }

    isRecording = true;
    isPaused = false;
    recordingStartTime = Date.now();

    // Create meeting in database
    const meeting = database.createMeeting({
      title: meetingTitle,
      emoji: meetingEmoji,
      date: new Date().toISOString(),
      status: 'recording'
    });
    currentMeetingId = meeting.id;
    console.log('Created meeting:', meeting.id);

    // Start audio recording
    audioRecorder.start(meeting.id);
    console.log('Audio recorder started');

    // Start real-time transcription
    const apiKey = store.get('openaiApiKey');
    console.log('API Key configured:', !!apiKey);

    if (apiKey) {
      transcriptionService.startRealtime(meeting.id, apiKey, audioRecorder, (text, isFinal) => {
        console.log('>>> TRANSCRIPT CALLBACK:', text?.substring(0, 50));
        try {
          if (isFinal && text) {
            database.appendTranscript(meeting.id, text, isFinal);
          }

          // Always send updates to main window and overlay
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('transcript-update', { meetingId: meeting.id, text, isFinal });
          }
          // Send to overlay for audio wave animation
          if (recordingOverlay && !recordingOverlay.isDestroyed()) {
            recordingOverlay.webContents.send('transcript-update', { meetingId: meeting.id, text, isFinal });
          }
        } catch (err) {
          console.error('Error in transcript callback:', err);
        }
      });
      console.log('Real-time transcription started');
    } else {
      console.log('WARNING: No API key configured, live transcription disabled');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript-update', {
          meetingId: meeting.id,
          text: 'No API key configured. Go to Settings to add your Groq API key for live transcription.',
          isFinal: false
        });
      }
    }

    // Show recording overlay
    createRecordingOverlay();
    setTimeout(() => {
      if (recordingOverlay && !recordingOverlay.isDestroyed()) {
        recordingOverlay.webContents.send('recording-started', { meetingId: meeting.id });
      }
    }, 500);

    // Start timer
    recordingTimer = setInterval(() => {
      try {
        if (recordingOverlay && !recordingOverlay.isDestroyed()) {
          const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
          recordingOverlay.webContents.send('timer-update', elapsed);
        }
      } catch (err) {}
    }, 1000);

    // Update main window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-started', { meetingId: meeting.id, title: meeting.title, emoji: meeting.emoji });
    }

    updateTrayMenu();
    console.log('=== RECORDING STARTED SUCCESSFULLY ===');

  } catch (error) {
    console.error('Failed to start recording:', error);
    isRecording = false;
    currentMeetingId = null;
  }
}

async function stopRecording() {
  if (!isRecording) {
    console.log('Not recording');
    return null;
  }

  console.log('=== STOPPING RECORDING ===');
  const meetingId = currentMeetingId;

  // Immediately update state to prevent re-entry
  isRecording = false;
  isPaused = false;
  currentMeetingId = null;
  recordingStartTime = null;

  // Clear timer
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }

  // Stop real-time transcription
  try {
    transcriptionService.stopRealtime();
  } catch (err) {
    console.error('Error stopping realtime transcription:', err);
  }

  // Stop audio recording
  let audioPath = null;
  try {
    audioPath = await audioRecorder.stop();
    console.log('Audio saved to:', audioPath);
  } catch (err) {
    console.error('Error stopping audio recorder:', err);
  }

  // Hide overlay
  try {
    if (recordingOverlay && !recordingOverlay.isDestroyed()) {
      recordingOverlay.hide();
    }
  } catch (err) {}

  // Update database
  try {
    database.updateMeeting(meetingId, { status: 'processing', audioPath });
  } catch (err) {
    console.error('Error updating meeting status:', err);
  }

  // Update UI
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-stopped', { meetingId });
      mainWindow.webContents.send('processing-started', { meetingId });
    }
  } catch (err) {}

  updateTrayMenu();
  console.log('=== RECORDING STOPPED, STARTING PROCESSING ===');

  // Process in background - wait for browser audio to be ready
  setTimeout(() => {
    processRecording(meetingId, audioPath).catch(err => {
      console.error('Processing error:', err);
    });
  }, 3000); // Give browser audio time to finish

  return meetingId;
}

async function processRecording(meetingId, audioPath) {
  console.log('=== PROCESS RECORDING ===');
  console.log('Meeting ID:', meetingId);
  console.log('Audio path received:', audioPath);

  const apiKey = store.get('openaiApiKey');

  if (!apiKey) {
    console.log('No API key, cannot process');
    database.updateMeeting(meetingId, { status: 'failed' });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('processing-error', {
        meetingId,
        error: 'Groq API key not configured. Go to Settings to add your key.'
      });
    }
    return;
  }

  // Check multiple possible audio locations
  const possiblePaths = [
    audioPath,
    path.join(app.getPath('userData'), 'recordings', `${meetingId}.wav`),  // FFmpeg or converted browser audio
    path.join(app.getPath('userData'), 'recordings', `${meetingId}.webm`), // Raw browser audio
  ].filter(Boolean);

  console.log('Checking possible audio paths:', possiblePaths);

  audioPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const stats = fs.statSync(p);
      console.log(`Found: ${p} (${stats.size} bytes)`);
      if (stats.size > 1000) {
        audioPath = p;
        break;
      }
    }
  }

  if (!audioPath) {
    console.log('No audio path provided, waiting for browser audio...');
    // Wait a bit more for browser audio conversion
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Try again
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        const stats = fs.statSync(p);
        if (stats.size > 1000) {
          audioPath = p;
          console.log('Found audio after wait:', audioPath);
          break;
        }
      }
    }
  }

  if (!audioPath || !fs.existsSync(audioPath)) {
    console.log('No audio file found at:', audioPath);
    database.updateMeeting(meetingId, { status: 'failed' });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('processing-error', { meetingId, error: 'No audio recorded' });
    }
    return;
  }

  const stats = fs.statSync(audioPath);
  console.log('Audio file size:', stats.size, 'bytes');

  try {
    console.log('Transcribing...');
    const fullTranscript = await transcriptionService.transcribeFile(audioPath, apiKey);
    console.log('Transcript length:', fullTranscript?.length);

    if (!fullTranscript || fullTranscript.length < 10) {
      throw new Error('Transcript too short or empty');
    }

    database.updateMeeting(meetingId, { transcript: fullTranscript });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcript-complete', { meetingId, transcript: fullTranscript });
    }

    // Generate summary
    console.log('Generating summary...');
    try {
      const summary = await summarizationService.generateSummary(fullTranscript, apiKey);
      console.log('Summary title:', summary?.title);

      database.updateMeeting(meetingId, {
        summary: JSON.stringify(summary),
        title: summary.title || 'Meeting',
        status: 'completed'
      });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('meeting-completed', { meetingId, summary });
      }
    } catch (summaryError) {
      console.error('Summary error:', summaryError);
      database.updateMeeting(meetingId, { status: 'completed' });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('meeting-completed', { meetingId });
      }
    }

  } catch (error) {
    console.error('Processing error:', error);
    database.updateMeeting(meetingId, { status: 'failed' });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('processing-error', { meetingId, error: error.message });
    }
  }
}

function showSettings() {
  createMainWindow();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('show-settings');
    }
  }, 500);
}

function handleZoomMeetingDetected(meetingInfo) {
  if (isRecording) return;

  dialog.showMessageBox({
    type: 'question',
    buttons: ['Record Meeting', 'Not Now'],
    defaultId: 0,
    title: 'Zoom Meeting Detected',
    message: 'A Zoom meeting is in progress',
    detail: 'Would you like to start recording?'
  }).then(result => {
    if (result.response === 0) {
      startRecording({ title: meetingInfo.title || 'Zoom Meeting' });
    }
  }).catch(() => {});
}

function handleZoomMeetingEnded() {
  if (isRecording) {
    stopRecording();
  }
}

// IPC Handlers
ipcMain.handle('get-meetings', async () => {
  try {
    return database.getAllMeetings();
  } catch (error) {
    console.error('Error getting meetings:', error);
    return [];
  }
});

ipcMain.handle('get-meeting', async (event, id) => {
  try {
    return database.getMeeting(id);
  } catch (error) {
    return null;
  }
});

ipcMain.handle('delete-meeting', async (event, id) => {
  try {
    return database.deleteMeeting(id);
  } catch (error) {
    return null;
  }
});

ipcMain.handle('update-meeting', async (event, data) => {
  try {
    const { id, ...updates } = data;
    return database.updateMeeting(id, updates);
  } catch (error) {
    return null;
  }
});

ipcMain.handle('reorder-meetings', async (event, orderedIds) => {
  try {
    return database.reorderMeetings(orderedIds);
  } catch (error) {
    return [];
  }
});

ipcMain.handle('get-settings', async () => {
  return {
    openaiApiKey: store.get('openaiApiKey') ? '••••••••' : null,
    hasApiKey: !!store.get('openaiApiKey')
  };
});

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    if (settings.openaiApiKey && settings.openaiApiKey !== '••••••••') {
      store.set('openaiApiKey', settings.openaiApiKey);
      console.log('API key saved');
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-recording', async (event, options) => {
  await startRecording(options);
  return { success: true };
});

ipcMain.handle('stop-recording', async () => {
  await stopRecording();
  return { success: true };
});

ipcMain.handle('pause-recording', async () => {
  isPaused = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording-paused', { meetingId: currentMeetingId });
  }
  return { success: true };
});

ipcMain.handle('resume-recording', async () => {
  isPaused = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording-resumed', { meetingId: currentMeetingId });
  }
  return { success: true };
});

ipcMain.handle('get-recording-status', async () => {
  return {
    isRecording,
    isPaused,
    currentMeetingId,
    elapsed: recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0
  };
});

ipcMain.handle('update-meeting-notes', async (event, { id, notes }) => {
  try {
    database.updateMeeting(id, { notes });
    return { success: true };
  } catch (error) {
    return { success: false };
  }
});

// Browser-based audio recording handlers
const audioStreams = new Map(); // meetingId -> WriteStream

ipcMain.handle('audio-chunk', async (event, { meetingId, arrayBuffer }) => {
  try {
    if (!audioStreams.has(meetingId)) {
      const audioPath = path.join(app.getPath('userData'), 'recordings', `${meetingId}.webm`);
      const dir = path.dirname(audioPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const stream = fs.createWriteStream(audioPath);
      audioStreams.set(meetingId, { stream, path: audioPath });
      console.log('Started browser audio recording to:', audioPath);
    }

    const { stream } = audioStreams.get(meetingId);
    const buffer = Buffer.from(arrayBuffer);
    stream.write(buffer);
    return { success: true };
  } catch (error) {
    console.error('Error writing audio chunk:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('finish-audio-recording', async (event, { meetingId }) => {
  try {
    if (audioStreams.has(meetingId)) {
      const { stream, path: webmPath } = audioStreams.get(meetingId);

      return new Promise((resolve) => {
        stream.end(() => {
          console.log('Browser audio recording finished:', webmPath);
          audioStreams.delete(meetingId);

          // Convert webm to wav for transcription
          const wavPath = webmPath.replace('.webm', '.wav');
          const ffmpeg = require('child_process').spawn('ffmpeg', [
            '-i', webmPath,
            '-ar', '16000',
            '-ac', '1',
            '-y',
            wavPath
          ]);

          ffmpeg.on('close', (code) => {
            if (code === 0 && fs.existsSync(wavPath)) {
              console.log('Converted to WAV:', wavPath);
              // Clean up webm
              try { fs.unlinkSync(webmPath); } catch (e) {}
              resolve({ success: true, audioPath: wavPath });
            } else {
              console.error('FFmpeg conversion failed');
              resolve({ success: false, audioPath: webmPath });
            }
          });

          ffmpeg.on('error', (err) => {
            console.error('FFmpeg error:', err);
            resolve({ success: false, audioPath: webmPath });
          });
        });
      });
    }
    return { success: false, error: 'No audio stream found' };
  } catch (error) {
    console.error('Error finishing audio recording:', error);
    return { success: false, error: error.message };
  }
});

// App lifecycle
app.whenReady().then(async () => {
  console.log('=== APP STARTING ===');

  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    const pngIconPath = path.join(__dirname, '../../assets/icon.png');
    if (fs.existsSync(pngIconPath)) {
      const dockIcon = nativeImage.createFromPath(pngIconPath);
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon);
        console.log('Dock icon set successfully');
      } else {
        console.log('Failed to load dock icon - image is empty');
      }
    } else {
      console.log('Dock icon file not found at:', pngIconPath);
    }
  }

  // Initialize services
  database = new Database();
  audioRecorder = new AudioRecorder();
  transcriptionService = new TranscriptionService(store);
  summarizationService = new SummarizationService();
  zoomDetector = new ZoomDetector();

  // Set up Zoom detection
  zoomDetector.on('meeting-started', handleZoomMeetingDetected);
  zoomDetector.on('meeting-ended', handleZoomMeetingEnded);
  zoomDetector.start();

  createTray();
  createMainWindow();

  console.log('=== APP READY ===');
});

app.on('activate', () => {
  createMainWindow();
});

// CRITICAL: Prevent quitting
app.on('window-all-closed', (e) => {
  if (process.platform === 'darwin') {
    e?.preventDefault?.();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  console.log('App quitting...');

  if (isRecording) {
    isRecording = false;
    if (recordingTimer) clearInterval(recordingTimer);
    transcriptionService?.stopRealtime();
  }
  zoomDetector?.stop();
});

// Keep the app running
setInterval(() => {
  // Heartbeat to keep process alive
}, 60000);
