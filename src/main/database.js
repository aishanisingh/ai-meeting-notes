const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');

class MeetingDatabase {
  constructor() {
    this.store = new Store({
      name: 'meetings-data',
      defaults: {
        meetings: []
      }
    });
  }

  createMeeting(data) {
    const id = uuidv4();
    const meetings = this.store.get('meetings');
    const maxOrder = meetings.length > 0 ? Math.max(...meetings.map(m => m.order || 0)) : 0;

    const meeting = {
      id,
      title: data.title || 'Untitled Meeting',
      emoji: data.emoji || null,
      date: data.date || new Date().toISOString(),
      duration: data.duration || null,
      transcript: null,
      summary: null,
      notes: null,
      audioPath: null,
      status: data.status || 'pending',
      source: data.source || 'manual',
      order: maxOrder + 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    meetings.unshift(meeting);
    this.store.set('meetings', meetings);

    return meeting;
  }

  getMeeting(id) {
    const meetings = this.store.get('meetings');
    const meeting = meetings.find(m => m.id === id);

    if (meeting && meeting.summary && typeof meeting.summary === 'string') {
      try {
        meeting.summary = JSON.parse(meeting.summary);
      } catch (e) {
        // Keep as string if parsing fails
      }
    }

    return meeting || null;
  }

  getAllMeetings() {
    const meetings = this.store.get('meetings');
    // Sort by order (descending) then by date
    return meetings
      .sort((a, b) => (b.order || 0) - (a.order || 0))
      .map(m => ({
        id: m.id,
        title: m.title,
        emoji: m.emoji,
        date: m.date,
        duration: m.duration,
        status: m.status,
        source: m.source,
        order: m.order,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        hasSummary: !!m.summary
      }));
  }

  updateMeeting(id, data) {
    const meetings = this.store.get('meetings');
    const index = meetings.findIndex(m => m.id === id);

    if (index === -1) return null;

    const meeting = meetings[index];

    if (data.title !== undefined) meeting.title = data.title;
    if (data.emoji !== undefined) meeting.emoji = data.emoji;
    if (data.transcript !== undefined) meeting.transcript = data.transcript;
    if (data.summary !== undefined) {
      meeting.summary = typeof data.summary === 'string' ? data.summary : JSON.stringify(data.summary);
    }
    if (data.notes !== undefined) meeting.notes = data.notes;
    if (data.audioPath !== undefined) meeting.audioPath = data.audioPath;
    if (data.status !== undefined) meeting.status = data.status;
    if (data.duration !== undefined) meeting.duration = data.duration;
    if (data.order !== undefined) meeting.order = data.order;

    meeting.updatedAt = new Date().toISOString();

    meetings[index] = meeting;
    this.store.set('meetings', meetings);

    return this.getMeeting(id);
  }

  deleteMeeting(id) {
    const meetings = this.store.get('meetings');
    const meeting = meetings.find(m => m.id === id);
    const filtered = meetings.filter(m => m.id !== id);
    this.store.set('meetings', filtered);
    return meeting;
  }

  reorderMeetings(orderedIds) {
    const meetings = this.store.get('meetings');

    // Update order based on position in array
    orderedIds.forEach((id, index) => {
      const meeting = meetings.find(m => m.id === id);
      if (meeting) {
        meeting.order = orderedIds.length - index;
      }
    });

    this.store.set('meetings', meetings);
    return this.getAllMeetings();
  }

  appendTranscript(meetingId, text, isFinal = false) {
    if (isFinal) {
      const meeting = this.getMeeting(meetingId);
      if (meeting) {
        const currentTranscript = meeting.transcript || '';
        const newTranscript = currentTranscript ? `${currentTranscript}\n${text}` : text;
        this.updateMeeting(meetingId, { transcript: newTranscript });
      }
    }
  }

  searchMeetings(query) {
    const meetings = this.store.get('meetings');
    const searchTerm = query.toLowerCase();
    return meetings.filter(m =>
      m.title.toLowerCase().includes(searchTerm) ||
      (m.transcript && m.transcript.toLowerCase().includes(searchTerm))
    );
  }
}

module.exports = { Database: MeetingDatabase };
