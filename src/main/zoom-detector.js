const { exec } = require('child_process');
const EventEmitter = require('events');

class ZoomDetector extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.checkInterval = null;
    this.wasInMeeting = false;
    this.currentMeetingInfo = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Check every 3 seconds for Zoom meeting status
    this.checkInterval = setInterval(() => {
      this.checkZoomStatus();
    }, 3000);

    // Initial check
    this.checkZoomStatus();
  }

  stop() {
    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  checkZoomStatus() {
    // Check if Zoom is running and in a meeting
    this.isZoomInMeeting().then(meetingInfo => {
      if (meetingInfo && !this.wasInMeeting) {
        // Meeting just started
        this.wasInMeeting = true;
        this.currentMeetingInfo = meetingInfo;
        this.emit('meeting-started', meetingInfo);
      } else if (!meetingInfo && this.wasInMeeting) {
        // Meeting just ended
        this.wasInMeeting = false;
        this.emit('meeting-ended', this.currentMeetingInfo);
        this.currentMeetingInfo = null;
      }
    }).catch(err => {
      console.error('Error checking Zoom status:', err);
    });
  }

  async isZoomInMeeting() {
    return new Promise((resolve) => {
      // Check if Zoom is running
      exec('pgrep -x "zoom.us"', (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }

        // Check for meeting window using AppleScript
        const appleScript = `
          tell application "System Events"
            if exists (process "zoom.us") then
              tell process "zoom.us"
                set windowNames to name of every window
                return windowNames as string
              end tell
            end if
          end tell
          return ""
        `;

        exec(`osascript -e '${appleScript}'`, (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }

          const windows = stdout.trim();

          // Zoom meeting windows typically have specific patterns
          // When in a meeting, there's usually a window with "Zoom Meeting" or participant count
          const isMeeting = windows.includes('Zoom Meeting') ||
                          windows.includes('zoom share') ||
                          /\d+ Participants?/.test(windows) ||
                          windows.includes('Meeting Controls');

          if (isMeeting) {
            // Try to extract meeting title
            let title = 'Zoom Meeting';
            const titleMatch = windows.match(/^([^,]+)/);
            if (titleMatch && !titleMatch[1].includes('Zoom Meeting')) {
              title = titleMatch[1].trim();
            }

            resolve({
              title,
              startTime: new Date().toISOString(),
              source: 'zoom'
            });
          } else {
            resolve(null);
          }
        });
      });
    });
  }

  // Alternative method using window title for more accurate detection
  async getZoomMeetingTitle() {
    return new Promise((resolve) => {
      const appleScript = `
        tell application "System Events"
          if exists (process "zoom.us") then
            tell process "zoom.us"
              try
                set frontWindow to front window
                return name of frontWindow
              end try
            end tell
          end if
        end tell
        return ""
      `;

      exec(`osascript -e '${appleScript}'`, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }
}

module.exports = { ZoomDetector };
