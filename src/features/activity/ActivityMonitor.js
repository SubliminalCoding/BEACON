'use strict';

const { exec } = require('child_process');
const { ipcMain } = require('electron');
const db   = require('../../core/Database');
const bus  = require('../../core/EventBus');

/**
 * ActivityMonitor — watches what you're doing on Windows.
 *
 * Uses PowerShell to poll the foreground window every 2 seconds.
 * No native addons required — pure Node + PowerShell.
 *
 * Detects:
 *   • Which app is in the foreground (VS Code, terminal, etc.)
 *   • Idle vs active state
 *   • Momentum level (1–5) based on activity density
 *   • Stuck patterns (idle + same window for too long)
 *   • Session start/end
 */

// PowerShell snippet to get foreground window info
const PS_GET_WINDOW = `
$sig = @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int c);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
'@
Add-Type -MemberDefinition $sig -Name WinAPI -Namespace Win32 -ErrorAction SilentlyContinue
$hw = [Win32.WinAPI]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[Win32.WinAPI]::GetWindowText($hw, $sb, 512) | Out-Null
$pid = 0
[Win32.WinAPI]::GetWindowThreadProcessId($hw, [ref]$pid) | Out-Null
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
[PSCustomObject]@{ Title = $sb.ToString(); Process = if($proc){$proc.ProcessName}else{'unknown'}; Path = if($proc){$proc.Path}else{''} } | ConvertTo-Json -Compress
`.trim();

const CODING_PROCESSES = new Set([
  'code', 'code - insiders', 'cursor', 'windsurf', 'idea64', 'webstorm64',
  'pycharm64', 'clion64', 'rider64', 'devenv', 'sublime_text', 'notepad++',
  'vim', 'nvim', 'emacs', 'windowsterminal', 'powershell', 'pwsh', 'cmd',
  'bash', 'wsl', 'gitbash', 'git-bash', 'gitextensions', 'sourcetree',
  'gitkraken', 'fork', 'atom', 'lapce', 'helix', 'zed',
]);

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;      // 5 min idle = inactive
const STUCK_THRESHOLD_MS = 15 * 60 * 1000;    // 15 min same window = stuck
const SESSION_GAP_MS = 10 * 60 * 1000;        // 10 min gap = new session
const MOMENTUM_WINDOW_MS = 5 * 60 * 1000;     // 5 min rolling window for momentum

class ActivityMonitor {
  constructor() {
    this._pollInterval   = null;
    this._pollMs         = 2000;

    // Current state
    this._lastWindow     = null;
    this._lastActiveAt   = null;
    this._sessionStart   = null;
    this._sessionData    = null;

    // Momentum tracking
    this._pulses         = [];   // timestamps of coding pulses
    this._momentum       = 0;   // 0-5

    // Stuck detection
    this._sameWindowSince = null;

    // Wellness timers
    this._lastHydration   = Date.now();
    this._lastEyestrain   = Date.now();
    this._lastPosture     = Date.now();
  }

  start() {
    console.log('[ActivityMonitor] Starting...');
    this._pollInterval = setInterval(() => this._poll(), this._pollMs);
    this._startSession();
  }

  stop() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    this._endSession();
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  async _poll() {
    let info;
    try {
      info = await this._getActiveWindow();
    } catch {
      return;
    }

    const now = Date.now();
    const processName = (info.Process || '').toLowerCase();
    const title = info.Title || '';
    const isCoding = CODING_PROCESSES.has(processName);

    // Emit window change event
    const windowKey = `${processName}::${title}`;
    if (windowKey !== this._lastWindow) {
      bus.emit(bus.EVENTS.WINDOW_CHANGED, { processName, title, isCoding });
      this._lastWindow = windowKey;
      this._sameWindowSince = now;

      // Tell ProjectRegistry about the window change
      try {
        const reg = require('../../core/ProjectRegistry');
        reg.onWindowChanged(processName, title);
      } catch {}
    }

    if (isCoding) {
      this._onCodingActivity(now, processName, title);
    } else {
      this._checkIdle(now);
    }

    this._checkWellness(now, isCoding);
    this._checkStuck(now, isCoding);
    this._broadcastState(processName, title, isCoding);
  }

  _onCodingActivity(now, processName, title) {
    const wasIdle = !this._lastActiveAt || (now - this._lastActiveAt > SESSION_GAP_MS);

    this._lastActiveAt = now;
    this._pulses.push(now);

    // Trim old pulses outside the rolling window
    const cutoff = now - MOMENTUM_WINDOW_MS;
    this._pulses = this._pulses.filter(t => t > cutoff);

    // Momentum: 0 pulses = 0, 20+ = 5
    const newMomentum = Math.min(5, Math.floor(this._pulses.length / 4));
    if (newMomentum !== this._momentum) {
      this._momentum = newMomentum;
      bus.emit(bus.EVENTS.MOMENTUM_CHANGED, { level: this._momentum });
    }

    bus.emit(bus.EVENTS.ACTIVITY_PULSE, { processName, title, momentum: this._momentum });

    if (wasIdle) {
      bus.emit(bus.EVENTS.ACTIVITY_RESUMED, { processName, title });
      if (!this._sessionStart || (now - this._sessionStart > SESSION_GAP_MS * 2)) {
        this._startSession();
      }
    }

    bus.emit(bus.EVENTS.CODING_DETECTED, { processName, title, momentum: this._momentum });
  }

  _checkIdle(now) {
    if (!this._lastActiveAt) return;
    const idleMs = now - this._lastActiveAt;

    if (idleMs > IDLE_THRESHOLD_MS) {
      bus.emit(bus.EVENTS.ACTIVITY_IDLE, { idleMs });

      // Decay momentum
      if (this._momentum > 0) {
        this._momentum = Math.max(0, this._momentum - 1);
        bus.emit(bus.EVENTS.MOMENTUM_CHANGED, { level: this._momentum });
      }

      // End session if idle long enough
      if (idleMs > SESSION_GAP_MS && this._sessionStart) {
        this._endSession();
      }
    }
  }

  _checkStuck(now, isCoding) {
    if (!isCoding) return;
    if (!this._sameWindowSince) return;

    const sameWindowMs = now - this._sameWindowSince;
    if (sameWindowMs > STUCK_THRESHOLD_MS && this._momentum <= 1) {
      bus.emit(bus.EVENTS.STUCK_DETECTED, { durationMs: sameWindowMs });
    }
  }

  _checkWellness(now, isCoding) {
    if (!isCoding) return;
    const settings = db.getSettings();

    if (settings.hydrationEnabled) {
      const hydrMs = settings.hydrationIntervalMinutes * 60 * 1000;
      if (now - this._lastHydration > hydrMs) {
        this._lastHydration = now;
        bus.emit(bus.EVENTS.HYDRATION_REMINDER, {});
        this._sendToCharacter('hydration');
      }
    }

    if (settings.eyestrainEnabled) {
      const eyeMs = settings.eyestrainIntervalMinutes * 60 * 1000;
      if (now - this._lastEyestrain > eyeMs) {
        this._lastEyestrain = now;
        bus.emit(bus.EVENTS.EYESTRAIN_BREAK, {});
        this._sendToCharacter('eyestrain');
      }
    }

    if (settings.postureEnabled) {
      const postureMs = settings.postureIntervalMinutes * 60 * 1000;
      if (now - this._lastPosture > postureMs) {
        this._lastPosture = now;
        bus.emit(bus.EVENTS.POSTURE_CHECK, {});
        this._sendToCharacter('posture');
      }
    }
  }

  // ─── Session management ───────────────────────────────────────────────────

  _startSession() {
    this._sessionStart = Date.now();
    this._sessionData = {
      id: null,
      projectId: null,
      startedAt: this._sessionStart,
      filesEdited: 0,
      peakMomentum: 0,
      stuckCount: 0,
    };
    db.updateStreak();
    bus.emit(bus.EVENTS.SESSION_START, { startedAt: this._sessionStart });
  }

  _endSession() {
    if (!this._sessionStart || !this._sessionData) return;

    const now = Date.now();
    const durationMs = now - this._sessionStart;

    // Only save sessions longer than 1 minute
    if (durationMs > 60000) {
      try {
        const reg = require('../../core/ProjectRegistry');
        const activeProjectId = reg.activeProjectId;

        const session = {
          ...this._sessionData,
          projectId: activeProjectId,
          endedAt: now,
          durationMs,
          peakMomentum: this._momentum,
        };

        db.addSession(session);

        if (activeProjectId) {
          reg.addTimeToProject(activeProjectId, durationMs);
        }

        bus.emit(bus.EVENTS.SESSION_END, { session });

        // Trigger Claude session summary if enabled
        try {
          const coach = require('../../core/ClaudeCoach');
          if (coach.isEnabled() && db.getSetting('claudeSessionSummaries') && durationMs > 10 * 60 * 1000) {
            coach.summarizeSession(session).then(summary => {
              if (summary) {
                bus.emit(bus.EVENTS.CLAUDE_RESPONSE, { text: summary, type: 'session_summary' });
              }
            });
          }
        } catch {}
      } catch (e) {
        console.error('[ActivityMonitor] Error ending session:', e);
      }
    }

    this._sessionStart = null;
    this._sessionData = null;
    this._momentum = 0;
    this._pulses = [];
  }

  // ─── State broadcast ──────────────────────────────────────────────────────

  _broadcastState(processName, title, isCoding) {
    const state = this._deriveCharacterState(isCoding);
    ipcMain.emit('update-character-state', null, {
      state,
      momentum: this._momentum,
      processName,
      title,
      isCoding,
      sessionMs: this._sessionStart ? Date.now() - this._sessionStart : 0,
    });
  }

  _deriveCharacterState(isCoding) {
    if (!isCoding) return 'idle';
    if (this._momentum >= 5) return 'fire';
    if (this._momentum >= 4) return 'excited';
    if (this._momentum >= 3) return 'coding';
    if (this._momentum >= 2) return 'focused';
    if (this._momentum >= 1) return 'thinking';
    return 'idle';
  }

  _sendToCharacter(type) {
    ipcMain.emit('update-character-state', null, { state: type, momentum: this._momentum });
  }

  // ─── Windows API via PowerShell ───────────────────────────────────────────

  _getActiveWindow() {
    return new Promise((resolve, reject) => {
      exec(
        `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "${PS_GET_WINDOW.replace(/\n/g, ' ')}"`,
        { timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) { reject(err); return; }
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            resolve({ Title: '', Process: 'unknown', Path: '' });
          }
        }
      );
    });
  }
}

module.exports = new ActivityMonitor();
