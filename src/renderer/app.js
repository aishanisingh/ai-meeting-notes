// State
let currentMeetingId = null;
let isRecording = false;
let isPaused = false;
let recordingStartTime = null;
let recordingTimer = null;
let liveTranscriptText = '';
let selectedEmoji = '🎙️';
let currentEmojiTarget = null;
let draggedItem = null;

// Audio visualization and recording
let audioContext = null;
let analyser = null;
let microphone = null;
let audioAnimationId = null;
let mediaRecorder = null;
let audioStream = null;

// DOM Elements
const meetingsList = document.getElementById('meetingsList');
const emptyState = document.getElementById('emptyState');
const meetingView = document.getElementById('meetingView');
const recordingView = document.getElementById('recordingView');
const processingView = document.getElementById('processingView');
const settingsModal = document.getElementById('settingsModal');
const recordingModal = document.getElementById('recordingModal');
const emojiModal = document.getElementById('emojiModal');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadMeetings();
  await checkRecordingStatus();
  setupEventListeners();
  setupIPCListeners();
});

// Load meetings list
async function loadMeetings() {
  try {
    const meetings = await window.api.getMeetings();

    if (!meetings || meetings.length === 0) {
      meetingsList.innerHTML = `
        <div class="meetings-empty">
          <p style="color: var(--text-muted); font-size: 13px; padding: 20px;">No meetings yet</p>
        </div>
      `;
      return;
    }

    meetingsList.innerHTML = meetings.map(meeting => {
      const date = new Date(meeting.date);
      const dateStr = formatMeetingDate(date);
      const statusClass = meeting.status || 'pending';
      const emoji = meeting.emoji || '📋';

      return `
        <div class="meeting-item ${meeting.id === currentMeetingId ? 'active' : ''}"
             data-id="${meeting.id}"
             draggable="true">
          <span class="meeting-item-emoji">${emoji}</span>
          <div class="meeting-item-content">
            <div class="meeting-item-title">${escapeHtml(meeting.title)}</div>
            <div class="meeting-item-date">${dateStr}</div>
          </div>
          ${statusClass !== 'completed' ? `
            <span class="meeting-item-status ${statusClass}">
              ${statusClass === 'recording' ? 'Recording' :
                statusClass === 'processing' ? 'Processing' :
                statusClass === 'failed' ? 'Failed' : 'Pending'}
            </span>
          ` : ''}
        </div>
      `;
    }).join('');

    // Add click handlers
    document.querySelectorAll('.meeting-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        selectMeeting(id);
      });

      // Drag and drop
      item.addEventListener('dragstart', handleDragStart);
      item.addEventListener('dragend', handleDragEnd);
      item.addEventListener('dragover', handleDragOver);
      item.addEventListener('drop', handleDrop);
      item.addEventListener('dragleave', handleDragLeave);
    });
  } catch (error) {
    console.error('Error loading meetings:', error);
  }
}

// Drag and drop handlers
function handleDragStart(e) {
  draggedItem = e.target;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  document.querySelectorAll('.meeting-item').forEach(item => {
    item.classList.remove('drag-over');
  });
  draggedItem = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (e.target.closest('.meeting-item') !== draggedItem) {
    e.target.closest('.meeting-item')?.classList.add('drag-over');
  }
}

function handleDragLeave(e) {
  e.target.closest('.meeting-item')?.classList.remove('drag-over');
}

async function handleDrop(e) {
  e.preventDefault();
  const target = e.target.closest('.meeting-item');
  if (!target || target === draggedItem) return;

  target.classList.remove('drag-over');

  // Get all meeting items and their order
  const items = Array.from(meetingsList.querySelectorAll('.meeting-item'));
  const orderedIds = [];

  // Reorder in DOM
  const draggedIndex = items.indexOf(draggedItem);
  const targetIndex = items.indexOf(target);

  if (draggedIndex < targetIndex) {
    target.after(draggedItem);
  } else {
    target.before(draggedItem);
  }

  // Get new order
  document.querySelectorAll('.meeting-item').forEach(item => {
    orderedIds.push(item.dataset.id);
  });

  // Save to database
  await window.api.reorderMeetings(orderedIds);
}

// Select a meeting
async function selectMeeting(id) {
  currentMeetingId = id;

  // Update sidebar selection
  document.querySelectorAll('.meeting-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === id);
  });

  try {
    const meeting = await window.api.getMeeting(id);

    if (!meeting) {
      showEmptyState();
      return;
    }

    if (meeting.status === 'recording') {
      showRecordingView(meeting);
    } else if (meeting.status === 'processing') {
      showProcessingView();
    } else {
      showMeetingView(meeting);
    }
  } catch (error) {
    console.error('Error selecting meeting:', error);
    showEmptyState();
  }
}

// Show meeting details
function showMeetingView(meeting) {
  emptyState.style.display = 'none';
  recordingView.style.display = 'none';
  processingView.style.display = 'none';
  meetingView.style.display = 'flex';

  const date = new Date(meeting.date);
  const isToday = isSameDay(date, new Date());

  document.getElementById('meetingDate').textContent = `@${isToday ? 'Today' : formatDate(date)} ${formatTime(date)}`;
  document.getElementById('meetingTitle').textContent = meeting.title;
  document.getElementById('meetingEmoji').textContent = meeting.emoji || '📋';

  // Update summary content
  updateSummaryContent(meeting);

  // Update notes
  document.getElementById('notesEditor').value = meeting.notes || '';

  // Update transcript
  updateTranscriptContent(meeting.transcript);

  // Set first tab active (summary is the default)
  setActiveTab('summary');
}

function updateSummaryContent(meeting) {
  const summaryContent = document.getElementById('summaryContent');

  if (!meeting.summary) {
    summaryContent.innerHTML = `<p class="placeholder-text">AI will summarize the notes and transcript</p>`;
    return;
  }

  let summary;
  try {
    summary = typeof meeting.summary === 'string' ? JSON.parse(meeting.summary) : meeting.summary;
  } catch (e) {
    summaryContent.innerHTML = `<p class="placeholder-text">Error loading summary.</p>`;
    return;
  }

  let html = '';

  // Render sections
  if (summary.sections && summary.sections.length > 0) {
    summary.sections.forEach(section => {
      html += `
        <div class="summary-section">
          <h3 class="summary-section-title">${escapeHtml(section.heading)}</h3>
          <ul class="summary-points">
            ${section.points.map(point => {
              const text = typeof point === 'string' ? point : (point.text || '');
              return `<li class="summary-point">${escapeHtml(text)}</li>`;
            }).join('')}
          </ul>
        </div>
      `;
    });
  }

  // Render action items
  if (summary.actionItems && summary.actionItems.length > 0) {
    html += `
      <div class="action-items">
        <h3 class="summary-section-title">Action Items</h3>
        ${summary.actionItems.map(item => `
          <div class="action-item">
            <div class="action-checkbox"></div>
            <div class="action-content">
              <div class="action-task">${escapeHtml(item.task)}</div>
              <div class="action-meta">
                ${item.assignee ? `Assigned to: ${escapeHtml(item.assignee)}` : ''}
                ${item.dueDate ? ` • Due: ${item.dueDate}` : ''}
                ${item.priority ? ` • Priority: ${item.priority}` : ''}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  summaryContent.innerHTML = html || '<p class="placeholder-text">No summary available.</p>';
}

function updateTranscriptContent(transcript) {
  const transcriptContent = document.getElementById('transcriptContent');

  if (!transcript) {
    transcriptContent.innerHTML = '<p class="placeholder-text">Transcript will appear here after processing</p>';
    return;
  }

  // Split transcript into paragraphs (by sentences or natural breaks)
  const lines = transcript.split('\n').filter(line => line.trim());

  // Group lines into paragraphs - combine short consecutive lines
  const paragraphs = [];
  let currentParagraph = '';

  lines.forEach(line => {
    // Remove timestamp if present
    const cleanLine = line.replace(/^\[[\d:]+\]\s*/, '').trim();
    if (!cleanLine) return;

    // If line ends with sentence-ending punctuation or is long enough, make it a paragraph
    if (cleanLine.match(/[.!?]$/) && currentParagraph.length > 100) {
      currentParagraph += (currentParagraph ? ' ' : '') + cleanLine;
      paragraphs.push(currentParagraph);
      currentParagraph = '';
    } else {
      currentParagraph += (currentParagraph ? ' ' : '') + cleanLine;
    }
  });

  // Add remaining text as final paragraph
  if (currentParagraph.trim()) {
    paragraphs.push(currentParagraph);
  }

  // If no paragraphs were created, just use the original lines
  const finalParagraphs = paragraphs.length > 0 ? paragraphs : lines.map(l => l.replace(/^\[[\d:]+\]\s*/, ''));

  transcriptContent.innerHTML = finalParagraphs.map(para =>
    `<div class="transcript-paragraph">${escapeHtml(para)}</div>`
  ).join('');
}

// Show recording view
function showRecordingView(meeting) {
  emptyState.style.display = 'none';
  meetingView.style.display = 'none';
  processingView.style.display = 'none';
  recordingView.style.display = 'flex';

  const title = meeting?.title || 'Recording...';
  document.getElementById('recordingTitle').textContent = title;
  document.getElementById('recordingEmoji').textContent = meeting?.emoji || '🎙️';

  const now = new Date();
  document.getElementById('recordingDate').textContent = `@Today ${formatTime(now)}`;

  // Update card header to match
  document.getElementById('cardTitle').textContent = title;
  document.getElementById('cardDate').textContent = '@Today';

  // Reset live transcript
  liveTranscriptText = '';
  document.getElementById('liveTranscript').innerHTML = '<p class="placeholder-text">Listening... Transcript will appear as you speak.</p>';

  if (!recordingTimer) {
    recordingStartTime = Date.now();
    updateRecordingTime();
    recordingTimer = setInterval(updateRecordingTime, 1000);
  }

  // Start audio visualization
  startAudioVisualization();
}

function updateRecordingTime() {
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const secs = (elapsed % 60).toString().padStart(2, '0');
  const timeDisplay = document.getElementById('recordingTime');
  if (timeDisplay) {
    timeDisplay.textContent = `${mins}:${secs}`;
  }
}

// Audio visualization and recording functions
async function startAudioVisualization() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    microphone = audioContext.createMediaStreamSource(audioStream);

    analyser.fftSize = 32;
    analyser.smoothingTimeConstant = 0.5;
    microphone.connect(analyser);

    visualizeAudio();
    console.log('Audio visualization started');

    // Start MediaRecorder for browser-based audio capture
    startMediaRecorder();
  } catch (err) {
    console.log('Audio visualization not available:', err);
  }
}

function startMediaRecorder() {
  if (!audioStream || !currentMeetingId) {
    console.log('Cannot start MediaRecorder: no stream or meetingId');
    return;
  }

  try {
    // Use webm format with opus codec for good quality and compression
    const options = { mimeType: 'audio/webm;codecs=opus' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      // Fallback
      options.mimeType = 'audio/webm';
    }

    mediaRecorder = new MediaRecorder(audioStream, options);
    console.log('MediaRecorder created with mimeType:', options.mimeType);

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && currentMeetingId) {
        try {
          const arrayBuffer = await event.data.arrayBuffer();
          await window.api.sendAudioChunk(currentMeetingId, arrayBuffer);
        } catch (err) {
          console.error('Error sending audio chunk:', err);
        }
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
    };

    // Record in 1-second chunks
    mediaRecorder.start(1000);
    console.log('MediaRecorder started');
  } catch (err) {
    console.error('Error starting MediaRecorder:', err);
  }
}

function visualizeAudio() {
  const waveBars = document.querySelectorAll('.wave-bar-dots');
  if (!waveBars.length || !analyser) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    audioAnimationId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    const barCount = waveBars.length;
    for (let i = 0; i < barCount; i++) {
      const index = Math.floor((i / barCount) * bufferLength);
      const value = dataArray[index] || 0;
      // Scale to height (2px min, 16px max)
      const height = Math.max(2, (value / 255) * 16);
      waveBars[i].style.height = `${height}px`;
    }
  }

  draw();
}

async function stopAudioVisualization() {
  // Stop MediaRecorder first
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    return new Promise((resolve) => {
      mediaRecorder.onstop = async () => {
        console.log('MediaRecorder stopped');
        if (currentMeetingId) {
          try {
            const result = await window.api.finishAudioRecording(currentMeetingId);
            console.log('Audio recording finished:', result);
          } catch (err) {
            console.error('Error finishing audio recording:', err);
          }
        }
        cleanupAudio();
        resolve();
      };
      mediaRecorder.stop();
    });
  } else {
    cleanupAudio();
  }
}

function cleanupAudio() {
  if (audioAnimationId) {
    cancelAnimationFrame(audioAnimationId);
    audioAnimationId = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }
  analyser = null;
  microphone = null;
  mediaRecorder = null;

  // Reset wave bars
  const waveBars = document.querySelectorAll('.wave-bar-dots');
  waveBars.forEach(bar => bar.style.height = '2px');
}

// Update live transcript display
function updateLiveTranscript(text) {
  const liveTranscript = document.getElementById('liveTranscript');
  if (!liveTranscript) return;

  console.log('>>> updateLiveTranscript called with:', text?.substring(0, 60));

  if (text && text.trim()) {
    // Check if this is just an initial "Listening..." type message
    if (text.toLowerCase().startsWith('listening')) {
      liveTranscript.innerHTML = `<p class="placeholder-text">${escapeHtml(text)}</p>`;
    } else if (text.toLowerCase().startsWith('no api key')) {
      liveTranscript.innerHTML = `<p class="placeholder-text" style="color: #c97b7f;">${escapeHtml(text)}</p>`;
    } else {
      // Real transcript text
      liveTranscriptText = text;
      liveTranscript.innerHTML = `<p>${escapeHtml(text)}</p>`;
      liveTranscript.scrollTop = liveTranscript.scrollHeight;
    }
  }
}

// Show processing view
function showProcessingView() {
  emptyState.style.display = 'none';
  meetingView.style.display = 'none';
  recordingView.style.display = 'none';
  processingView.style.display = 'flex';

  // Clear recording timer
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
}

// Show empty state
function showEmptyState() {
  meetingView.style.display = 'none';
  recordingView.style.display = 'none';
  processingView.style.display = 'none';
  emptyState.style.display = 'flex';
}

// Tab handling
function setActiveTab(tabName) {
  // Update meeting view tabs
  document.querySelectorAll('.tabs .tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `${tabName}Panel`);
  });
}

// Check recording status on load
async function checkRecordingStatus() {
  try {
    const status = await window.api.getRecordingStatus();
    isRecording = status.isRecording;
    isPaused = status.isPaused;

    if (isRecording && status.currentMeetingId) {
      currentMeetingId = status.currentMeetingId;
      recordingStartTime = Date.now() - (status.elapsed * 1000);
      const meeting = await window.api.getMeeting(currentMeetingId);
      showRecordingView(meeting);
    }
  } catch (error) {
    console.error('Error checking recording status:', error);
  }
}

// Event listeners
function setupEventListeners() {
  // New recording button
  document.getElementById('newRecordingBtn').addEventListener('click', () => {
    selectedEmoji = '🎙️';
    document.getElementById('newRecordingEmoji').textContent = selectedEmoji;
    recordingModal.classList.add('active');
    document.getElementById('recordingTitleInput').value = '';
    document.getElementById('recordingTitleInput').focus();
  });

  // Settings button
  document.getElementById('settingsBtn').addEventListener('click', async () => {
    try {
      const settings = await window.api.getSettings();
      document.getElementById('apiKeyInput').value = settings.openaiApiKey || '';
      settingsModal.classList.add('active');
    } catch (error) {
      console.error('Error loading settings:', error);
    }
  });

  // Close settings
  document.getElementById('closeSettingsBtn').addEventListener('click', () => {
    settingsModal.classList.remove('active');
  });
  document.getElementById('cancelSettingsBtn').addEventListener('click', () => {
    settingsModal.classList.remove('active');
  });

  // Save settings
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    try {
      const apiKey = document.getElementById('apiKeyInput').value;
      await window.api.saveSettings({ openaiApiKey: apiKey });
      settingsModal.classList.remove('active');
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Failed to save settings');
    }
  });

  // Close recording modal
  document.getElementById('closeRecordingModalBtn').addEventListener('click', () => {
    recordingModal.classList.remove('active');
  });
  document.getElementById('cancelRecordingBtn').addEventListener('click', () => {
    recordingModal.classList.remove('active');
  });

  // Emoji picker for new recording
  document.getElementById('newRecordingEmojiBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    currentEmojiTarget = 'newRecording';
    document.getElementById('emojiInput').value = '';
    emojiModal.classList.add('active');
    setTimeout(() => document.getElementById('emojiInput').focus(), 100);
  });

  // Emoji picker for meeting view
  document.getElementById('emojiBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    currentEmojiTarget = 'meeting';
    document.getElementById('emojiInput').value = '';
    emojiModal.classList.add('active');
    setTimeout(() => document.getElementById('emojiInput').focus(), 100);
  });

  // Emoji input field - for custom emojis via system picker
  const emojiInput = document.getElementById('emojiInput');
  emojiInput?.addEventListener('input', async (e) => {
    const emoji = e.target.value.trim();
    if (emoji && emoji.length > 0) {
      await applyEmoji(emoji);
    }
  });

  // Helper function to apply emoji
  async function applyEmoji(emoji) {
    if (currentEmojiTarget === 'newRecording') {
      selectedEmoji = emoji;
      document.getElementById('newRecordingEmoji').textContent = emoji;
    } else if (currentEmojiTarget === 'meeting' && currentMeetingId) {
      document.getElementById('meetingEmoji').textContent = emoji;
      await window.api.updateMeeting(currentMeetingId, { emoji });
      loadMeetings();
    }
    emojiModal.classList.remove('active');
  }

  // Emoji selection from grid
  document.querySelectorAll('.emoji-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const emoji = btn.dataset.emoji;
      await applyEmoji(emoji);
    });
  });

  // Start recording
  document.getElementById('startRecordingBtn').addEventListener('click', async () => {
    const title = document.getElementById('recordingTitleInput').value || `Meeting ${new Date().toLocaleString()}`;
    recordingModal.classList.remove('active');
    try {
      await window.api.startRecording(title, selectedEmoji);
    } catch (error) {
      console.error('Error starting recording:', error);
      alert('Failed to start recording');
    }
  });

  // Stop recording
  document.getElementById('stopRecordingBtn').addEventListener('click', async () => {
    try {
      await window.api.stopRecording();
    } catch (error) {
      console.error('Error stopping recording:', error);
    }
  });

  // Pause button
  document.getElementById('pauseBtn')?.addEventListener('click', async () => {
    if (isPaused) {
      await window.api.resumeRecording();
      document.getElementById('pauseBtn').textContent = 'Pause';
    } else {
      await window.api.pauseRecording();
      document.getElementById('pauseBtn').textContent = 'Resume';
    }
    isPaused = !isPaused;
  });

  // Delete meeting
  document.getElementById('deleteMeetingBtn')?.addEventListener('click', async () => {
    if (!currentMeetingId) return;

    if (confirm('Are you sure you want to delete this meeting?')) {
      await window.api.deleteMeeting(currentMeetingId);
      currentMeetingId = null;
      showEmptyState();
      loadMeetings();
    }
  });

  // Meeting title editing
  document.getElementById('meetingTitle')?.addEventListener('blur', async (e) => {
    if (currentMeetingId) {
      const newTitle = e.target.textContent.trim();
      if (newTitle) {
        await window.api.updateMeeting(currentMeetingId, { title: newTitle });
        loadMeetings();
      }
    }
  });

  document.getElementById('meetingTitle')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  });

  // Tabs - meeting view tabs
  document.querySelectorAll('.tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      setActiveTab(tab.dataset.tab);
    });
  });

  // Tabs - recording view tabs
  document.querySelectorAll('.card-tab[data-recording-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.recordingTab;
      // Update tab active state
      document.querySelectorAll('.card-tab[data-recording-tab]').forEach(t => {
        t.classList.toggle('active', t.dataset.recordingTab === tabName);
      });
      // Update panel visibility
      document.querySelectorAll('.recording-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `recording${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Panel`);
      });
    });
  });

  // Notes auto-save
  let notesTimeout;
  document.getElementById('notesEditor').addEventListener('input', (e) => {
    clearTimeout(notesTimeout);
    notesTimeout = setTimeout(async () => {
      if (currentMeetingId) {
        try {
          await window.api.updateMeetingNotes(currentMeetingId, e.target.value);
        } catch (error) {
          console.error('Error saving notes:', error);
        }
      }
    }, 1000);
  });

  // Modal backdrop clicks
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', () => {
      backdrop.closest('.modal').classList.remove('active');
    });
  });

  // Enter key in recording title input
  document.getElementById('recordingTitleInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('startRecordingBtn').click();
    }
  });
}

// IPC listeners
function setupIPCListeners() {
  window.api.onRecordingStarted(async (data) => {
    console.log('Recording started:', data);
    isRecording = true;
    isPaused = false;
    currentMeetingId = data.meetingId;
    recordingStartTime = Date.now();
    liveTranscriptText = '';

    clearInterval(recordingTimer);
    recordingTimer = setInterval(updateRecordingTime, 1000);

    try {
      const meeting = await window.api.getMeeting(data.meetingId);
      showRecordingView(meeting);
      loadMeetings();
    } catch (error) {
      console.error('Error loading meeting after recording started:', error);
    }
  });

  window.api.onRecordingStopped(async (data) => {
    console.log('Recording stopped:', data);
    isRecording = false;
    isPaused = false;
    clearInterval(recordingTimer);
    recordingTimer = null;

    // Stop browser audio recording and wait for it to finish
    await stopAudioVisualization();

    showProcessingView();
    loadMeetings();
  });

  window.api.onTranscriptUpdate((data) => {
    console.log('>>> Transcript update received:', {
      meetingId: data.meetingId,
      currentMeetingId,
      isRecording,
      textPreview: data.text?.substring(0, 60)
    });
    if (data.meetingId === currentMeetingId && isRecording) {
      updateLiveTranscript(data.text);
    } else {
      console.log('>>> Transcript update ignored - meetingId or recording state mismatch');
    }
  });

  window.api.onRecordingPaused?.((data) => {
    isPaused = true;
    document.getElementById('pauseBtn').textContent = 'Resume';
  });

  window.api.onRecordingResumed?.((data) => {
    isPaused = false;
    document.getElementById('pauseBtn').textContent = 'Pause';
  });

  window.api.onProcessingStarted((data) => {
    console.log('Processing started:', data);
    if (data.meetingId === currentMeetingId) {
      showProcessingView();
    }
    loadMeetings();
  });

  window.api.onMeetingCompleted(async (data) => {
    console.log('Meeting completed:', data);
    if (data.meetingId === currentMeetingId) {
      try {
        const meeting = await window.api.getMeeting(data.meetingId);
        showMeetingView(meeting);
      } catch (error) {
        console.error('Error loading completed meeting:', error);
      }
    }
    loadMeetings();
  });

  window.api.onProcessingError((data) => {
    console.error('Processing error:', data);
    alert(`Processing failed: ${data.error}`);
    loadMeetings();
    if (data.meetingId === currentMeetingId) {
      selectMeeting(data.meetingId);
    }
  });

  window.api.onShowSettings(async () => {
    try {
      const settings = await window.api.getSettings();
      document.getElementById('apiKeyInput').value = settings.openaiApiKey || '';
      settingsModal.classList.add('active');
    } catch (error) {
      console.error('Error loading settings:', error);
    }
  });

  window.api.onZoomDetected((data) => {
    console.log('Zoom meeting detected:', data);
  });
}

// Utility functions
function formatMeetingDate(date) {
  const now = new Date();
  if (isSameDay(date, now)) {
    return `Today, ${formatTime(date)}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) {
    return `Yesterday, ${formatTime(date)}`;
  }

  return `${formatDate(date)}, ${formatTime(date)}`;
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
