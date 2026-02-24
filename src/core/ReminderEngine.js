'use strict';

const db = require('./Database');
const bus = require('./EventBus');

/**
 * ReminderEngine — scheduling engine for BEACON reminders.
 *
 * Supports three reminder types:
 *   - one-shot:         fires once at a specific time (fireAt)
 *   - recurring:        fires on an interval (intervalMs) or daily at a time (recurringTime)
 *   - project-context:  fires when a specific project becomes active
 *
 * Reminder record schema:
 * {
 *   id, type, text, status ('active'|'completed'|'deleted'),
 *   createdAt, fireAt, intervalMs, recurringTime, lastFiredAt,
 *   projectId, projectName, firedForSession, firedCount
 * }
 */
class ReminderEngine {
  constructor() {
    this._checkInterval = null;
    this._projectUnsub = null;
    this._sessionId = Date.now().toString(36); // unique per app launch
  }

  init() {
    // Check time-based reminders every 15 seconds
    this._checkInterval = setInterval(() => this._checkTimeBased(), 15000);

    // Listen for project switches to handle context reminders
    this._projectUnsub = bus.on(bus.EVENTS.PROJECT_SWITCHED, (data) => {
      this._checkProjectContext(data);
    });
  }

  destroy() {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
    if (this._projectUnsub) {
      this._projectUnsub();
      this._projectUnsub = null;
    }
  }

  getReminders() {
    return db.getReminders().filter(r => r.status !== 'deleted');
  }

  getActiveReminders() {
    return db.getReminders().filter(r => r.status === 'active');
  }

  addReminder(data) {
    const reminder = {
      id: undefined, // Database will assign
      type: data.type || 'one-shot',
      text: data.text || 'Reminder',
      status: 'active',
      createdAt: Date.now(),
      fireAt: data.fireAt || null,
      intervalMs: data.intervalMs || null,
      recurringTime: data.recurringTime || null,
      lastFiredAt: null,
      projectId: data.projectId || null,
      projectName: data.projectName || null,
      firedForSession: null,
      firedCount: 0,
    };

    const saved = db.addReminder(reminder);
    bus.emit(bus.EVENTS.REMINDER_CREATED, saved);
    return saved;
  }

  deleteReminder(id) {
    const r = db.deleteReminder(id);
    if (r) bus.emit(bus.EVENTS.REMINDER_DELETED, r);
    return r;
  }

  /**
   * Returns active reminders formatted for the daily briefing.
   */
  getPendingForBriefing() {
    const active = this.getActiveReminders();
    return active.map(r => {
      let schedule = '';
      if (r.type === 'one-shot' && r.fireAt) {
        schedule = `At ${new Date(r.fireAt).toLocaleString()}`;
      } else if (r.type === 'recurring' && r.intervalMs) {
        const hrs = r.intervalMs / 3600000;
        schedule = hrs >= 1 ? `Every ${hrs}h` : `Every ${Math.round(r.intervalMs / 60000)}m`;
      } else if (r.type === 'recurring' && r.recurringTime) {
        schedule = `Daily at ${r.recurringTime}`;
      } else if (r.type === 'project-context') {
        schedule = `When "${r.projectName || r.projectId}" opens`;
      }
      return { id: r.id, type: r.type, text: r.text, schedule };
    });
  }

  // ─── Internal checks ──────────────────────────────────────────────────────

  _checkTimeBased() {
    const now = Date.now();
    const reminders = this.getActiveReminders();

    for (const r of reminders) {
      if (r.type === 'one-shot' && r.fireAt && now >= r.fireAt) {
        this._fire(r);
        db.updateReminder(r.id, { status: 'completed' });
        bus.emit(bus.EVENTS.REMINDER_COMPLETED, r);
      }

      if (r.type === 'recurring' && r.intervalMs) {
        const lastFired = r.lastFiredAt || r.createdAt;
        if (now - lastFired >= r.intervalMs) {
          this._fire(r);
          db.updateReminder(r.id, {
            lastFiredAt: now,
            firedCount: (r.firedCount || 0) + 1,
          });
        }
      }

      if (r.type === 'recurring' && r.recurringTime) {
        // recurringTime is "HH:MM" — check if we're past that time today and haven't fired
        const [hh, mm] = r.recurringTime.split(':').map(Number);
        const todayTarget = new Date();
        todayTarget.setHours(hh, mm, 0, 0);
        const targetMs = todayTarget.getTime();

        const today = new Date().toDateString();
        const lastFiredDate = r.lastFiredAt ? new Date(r.lastFiredAt).toDateString() : null;

        if (now >= targetMs && lastFiredDate !== today) {
          this._fire(r);
          db.updateReminder(r.id, {
            lastFiredAt: now,
            firedCount: (r.firedCount || 0) + 1,
          });
        }
      }
    }
  }

  _checkProjectContext(data) {
    if (!data || !data.projectId) return;

    const reminders = this.getActiveReminders().filter(
      r => r.type === 'project-context' && r.projectId === data.projectId
    );

    for (const r of reminders) {
      // Only fire once per app session
      if (r.firedForSession === this._sessionId) continue;

      this._fire(r);
      db.updateReminder(r.id, {
        lastFiredAt: Date.now(),
        firedForSession: this._sessionId,
        firedCount: (r.firedCount || 0) + 1,
      });
    }
  }

  _fire(reminder) {
    bus.emit(bus.EVENTS.REMINDER_FIRED, {
      id: reminder.id,
      type: reminder.type,
      text: reminder.text,
      projectName: reminder.projectName,
    });
  }
}

module.exports = new ReminderEngine();
