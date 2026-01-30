const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Meetings
  getMeetings: () => ipcRenderer.invoke('get-meetings'),
  getMeeting: (id) => ipcRenderer.invoke('get-meeting', id),
  deleteMeeting: (id) => ipcRenderer.invoke('delete-meeting', id),
  updateMeeting: (id, data) => ipcRenderer.invoke('update-meeting', { id, ...data }),
  updateMeetingNotes: (id, notes) => ipcRenderer.invoke('update-meeting-notes', { id, notes }),
  reorderMeetings: (orderedIds) => ipcRenderer.invoke('reorder-meetings', orderedIds),

  // Recording
  startRecording: (title, emoji) => ipcRenderer.invoke('start-recording', { title, emoji }),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  pauseRecording: () => ipcRenderer.invoke('pause-recording'),
  resumeRecording: () => ipcRenderer.invoke('resume-recording'),
  getRecordingStatus: () => ipcRenderer.invoke('get-recording-status'),

  // Audio data from renderer (for browser-based recording)
  sendAudioChunk: (meetingId, arrayBuffer) => ipcRenderer.invoke('audio-chunk', { meetingId, arrayBuffer }),
  finishAudioRecording: (meetingId) => ipcRenderer.invoke('finish-audio-recording', { meetingId }),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Events
  onTranscriptUpdate: (callback) => {
    ipcRenderer.on('transcript-update', (event, data) => callback(data));
  },
  onRecordingStarted: (callback) => {
    ipcRenderer.on('recording-started', (event, data) => callback(data));
  },
  onRecordingStopped: (callback) => {
    ipcRenderer.on('recording-stopped', (event, data) => callback(data));
  },
  onRecordingPaused: (callback) => {
    ipcRenderer.on('recording-paused', (event, data) => callback(data));
  },
  onRecordingResumed: (callback) => {
    ipcRenderer.on('recording-resumed', (event, data) => callback(data));
  },
  onProcessingStarted: (callback) => {
    ipcRenderer.on('processing-started', (event, data) => callback(data));
  },
  onMeetingCompleted: (callback) => {
    ipcRenderer.on('meeting-completed', (event, data) => callback(data));
  },
  onProcessingError: (callback) => {
    ipcRenderer.on('processing-error', (event, data) => callback(data));
  },
  onZoomDetected: (callback) => {
    ipcRenderer.on('zoom-detected', (event, data) => callback(data));
  },
  onShowSettings: (callback) => {
    ipcRenderer.on('show-settings', () => callback());
  },

  // Remove listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});
