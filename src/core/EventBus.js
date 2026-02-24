'use strict';

/**
 * EventBus — central pub/sub system for BEACON
 * Every feature communicates through here, never directly.
 * Mirrors the 80+ event architecture from the original DrVibe design.
 */
class EventBus {
  constructor() {
    this._listeners = new Map();
    this._history = [];
    this._maxHistory = 200;
  }

  on(event, listener) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(listener);
    return () => this.off(event, listener); // returns unsubscribe fn
  }

  once(event, listener) {
    const wrapper = (data) => {
      listener(data);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  off(event, listener) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).delete(listener);
    }
  }

  emit(event, data = {}) {
    const entry = { event, data, ts: Date.now() };
    this._history.push(entry);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    if (this._listeners.has(event)) {
      for (const listener of this._listeners.get(event)) {
        try {
          listener(data);
        } catch (err) {
          console.error(`[EventBus] Error in listener for "${event}":`, err);
        }
      }
    }
  }

  history(event = null) {
    if (event) {
      return this._history.filter(e => e.event === event);
    }
    return this._history;
  }
}

// Singleton
const bus = new EventBus();

// Named events — the contract for the whole app
bus.EVENTS = {
  // Activity
  ACTIVITY_PULSE:       'activity:pulse',
  ACTIVITY_IDLE:        'activity:idle',
  ACTIVITY_RESUMED:     'activity:resumed',
  WINDOW_CHANGED:       'activity:window-changed',
  CODING_DETECTED:      'activity:coding-detected',
  MOMENTUM_CHANGED:     'activity:momentum-changed',
  STUCK_DETECTED:       'activity:stuck-detected',
  ACTIVITY_FATIGUE:     'activity:fatigue',

  // Projects
  PROJECT_DETECTED:     'project:detected',
  PROJECT_SWITCHED:     'project:switched',
  PROJECT_ADDED:        'project:added',
  PROJECT_UPDATED:      'project:updated',
  PROJECT_PARKED:       'project:parked',

  // Sessions
  SESSION_START:        'session:start',
  SESSION_END:          'session:end',
  SESSION_MILESTONE:    'session:milestone',

  // Goals
  GOAL_ADDED:           'goal:added',
  GOAL_COMPLETED:       'goal:completed',
  GOAL_OVERDUE:         'goal:overdue',
  GOAL_REMINDER:        'goal:reminder',

  // Character
  CHARACTER_STATE:      'character:state',
  CHARACTER_SPEAK:      'character:speak',
  CHARACTER_CELEBRATE:  'character:celebrate',

  // Timer
  TIMER_TICK:           'timer:tick',
  POMODORO_START:       'timer:pomodoro-start',
  POMODORO_BREAK:       'timer:pomodoro-break',
  POMODORO_DONE:        'timer:pomodoro-done',

  // Wellness
  HYDRATION_REMINDER:   'wellness:hydration',
  EYESTRAIN_BREAK:      'wellness:eyestrain',
  POSTURE_CHECK:        'wellness:posture',
  OVERWORK_WARNING:     'wellness:overwork',

  // Briefing
  BRIEFING_READY:       'briefing:ready',
  BRIEFING_DISMISSED:   'briefing:dismissed',

  // Claude
  CLAUDE_RESPONSE:      'claude:response',
  CLAUDE_ERROR:         'claude:error',

  // Reminders
  REMINDER_CREATED:     'reminder:created',
  REMINDER_FIRED:       'reminder:fired',
  REMINDER_COMPLETED:   'reminder:completed',
  REMINDER_DELETED:     'reminder:deleted',

  // App
  APP_READY:            'app:ready',
  APP_QUITTING:         'app:quitting',
  SETTINGS_CHANGED:     'settings:changed',
};

module.exports = bus;
