'use strict';

const Store = require('electron-store');
const { v4: uuidv4 } = require('crypto').randomUUID ? { v4: () => require('crypto').randomUUID() } : { v4: () => Math.random().toString(36).slice(2) };
const path = require('path');

/**
 * Database — unified persistent store for BEACON
 *
 * Sections:
 *   settings     — user preferences
 *   projects     — map of projectId → project metadata
 *   sessions     — array of completed sessions (per-project)
 *   goals        — map of projectId → array of goals
 *   achievements — unlocked milestones
 *   streak       — daily coding streak
 *   skills       — language time tracking
 *   briefing     — last briefing content + timestamp
 *   claude       — API key and coaching history
 *
 * Uses electron-store (JSON file, atomic writes).
 * Debounces saves to avoid hammering disk.
 */

const DEFAULTS = {
  settings: {
    // Timer
    workMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    pomodorosBeforeLong: 4,
    timerEnabled: true,

    // Wellness
    hydrationIntervalMinutes: 30,
    eyestrainIntervalMinutes: 20,
    postureIntervalMinutes: 45,
    hydrationEnabled: true,
    eyestrainEnabled: true,
    postureEnabled: true,

    // Character
    characterVisible: true,
    characterSize: 128,
    characterX: 100,
    characterY: 100,
    ghostMode: false,

    // Notifications
    notificationsEnabled: true,
    briefingOnStartup: true,
    goalRemindersEnabled: true,

    // Claude
    claudeEnabled: false,
    claudeApiKey: '',
    claudeModel: 'claude-sonnet-4-6',
    claudeSessionSummaries: true,

    // Scanning
    scanRoots: [],          // directories to scan for projects
    autoDetectProjects: true,

    // General
    startWithWindows: false,
    minimizeToTray: true,
  },

  projects: {},     // { [id]: ProjectRecord }
  sessions: [],     // SessionRecord[]
  goals: {},        // { [projectId]: GoalRecord[] }
  achievements: {}, // { [id]: AchievementRecord }
  streak: {
    current: 0,
    longest: 0,
    lastDate: null,
  },
  skills: {},       // { [language]: { totalMs: 0, sessions: 0 } }
  briefing: {
    lastShown: null,
    lastContent: null,
  },
  claude: {
    history: [],    // last 50 coaching messages
  },
  reminders: [],    // ReminderRecord[]
};

class Database {
  constructor() {
    this._store = new Store({
      name: 'beacon-data',
      defaults: DEFAULTS,
      schema: {
        // Light schema — mainly just ensures top-level keys are objects
        settings: { type: 'object' },
        projects: { type: 'object' },
        sessions: { type: 'array' },
        goals: { type: 'object' },
        achievements: { type: 'object' },
        streak: { type: 'object' },
        skills: { type: 'object' },
        briefing: { type: 'object' },
        claude: { type: 'object' },
        reminders: { type: 'array' },
      },
    });

    this._saveTimer = null;
    this._dirty = false;
    this._cache = this._store.store;
  }

  // ─── Section access ───────────────────────────────────────────────────────

  get(section, key = null) {
    const sectionData = this._cache[section];
    if (key === null) return sectionData;
    return sectionData ? sectionData[key] : undefined;
  }

  set(section, key, value) {
    if (!this._cache[section]) this._cache[section] = {};
    this._cache[section][key] = value;
    this._scheduleSave();
  }

  merge(section, partial) {
    this._cache[section] = Object.assign({}, this._cache[section] || {}, partial);
    this._scheduleSave();
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  getSetting(key) {
    return this._cache.settings[key];
  }

  setSetting(key, value) {
    this._cache.settings[key] = value;
    this._scheduleSave();
  }

  getSettings() {
    return { ...this._cache.settings };
  }

  mergeSettings(partial) {
    this._cache.settings = Object.assign({}, this._cache.settings, partial);
    this._scheduleSave();
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  getProjects() {
    return { ...this._cache.projects };
  }

  getProject(id) {
    return this._cache.projects[id] || null;
  }

  saveProject(project) {
    if (!project.id) project.id = this._uuid();
    project.updatedAt = Date.now();
    this._cache.projects[project.id] = project;
    this._scheduleSave();
    return project;
  }

  deleteProject(id) {
    delete this._cache.projects[id];
    this._scheduleSave();
  }

  getRecentProjects(limit = 5) {
    const projects = Object.values(this._cache.projects);
    return projects
      .filter(p => p.lastActiveAt)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, limit);
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  addSession(session) {
    if (!session.id) session.id = this._uuid();
    this._cache.sessions.push(session);
    // Keep last 500 sessions
    if (this._cache.sessions.length > 500) {
      this._cache.sessions = this._cache.sessions.slice(-500);
    }
    this._scheduleSave();
    return session;
  }

  getSessionsForProject(projectId, limit = 20) {
    return this._cache.sessions
      .filter(s => s.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  getRecentSessions(limit = 10) {
    return [...this._cache.sessions]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  getLastSession() {
    const sorted = [...this._cache.sessions].sort((a, b) => b.startedAt - a.startedAt);
    return sorted[0] || null;
  }

  // ─── Goals ────────────────────────────────────────────────────────────────

  getGoals(projectId) {
    return this._cache.goals[projectId] || [];
  }

  addGoal(projectId, goal) {
    if (!goal.id) goal.id = this._uuid();
    goal.createdAt = Date.now();
    goal.completed = false;
    if (!this._cache.goals[projectId]) this._cache.goals[projectId] = [];
    this._cache.goals[projectId].push(goal);
    this._scheduleSave();
    return goal;
  }

  completeGoal(projectId, goalId) {
    const goals = this._cache.goals[projectId] || [];
    const goal = goals.find(g => g.id === goalId);
    if (goal) {
      goal.completed = true;
      goal.completedAt = Date.now();
      this._scheduleSave();
    }
    return goal;
  }

  updateGoal(projectId, goalId, partial) {
    const goals = this._cache.goals[projectId] || [];
    const goal = goals.find(g => g.id === goalId);
    if (goal) {
      Object.assign(goal, partial);
      this._scheduleSave();
    }
    return goal;
  }

  getOverdueGoals() {
    const now = Date.now();
    const overdue = [];
    for (const [projectId, goals] of Object.entries(this._cache.goals)) {
      for (const goal of goals) {
        if (!goal.completed && goal.dueDate && goal.dueDate < now) {
          overdue.push({ ...goal, projectId });
        }
      }
    }
    return overdue;
  }

  // ─── Skills ───────────────────────────────────────────────────────────────

  addSkillTime(language, ms) {
    if (!this._cache.skills[language]) {
      this._cache.skills[language] = { totalMs: 0, sessions: 0 };
    }
    this._cache.skills[language].totalMs += ms;
    this._cache.skills[language].sessions++;
    this._scheduleSave();
  }

  getSkills() {
    return { ...this._cache.skills };
  }

  // ─── Streak ───────────────────────────────────────────────────────────────

  updateStreak() {
    const today = new Date().toDateString();
    const streak = this._cache.streak;
    if (streak.lastDate === today) return streak;

    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (streak.lastDate === yesterday) {
      streak.current++;
    } else {
      streak.current = 1;
    }
    if (streak.current > streak.longest) {
      streak.longest = streak.current;
    }
    streak.lastDate = today;
    this._scheduleSave();
    return streak;
  }

  // ─── Briefing ─────────────────────────────────────────────────────────────

  getBriefing() {
    return { ...this._cache.briefing };
  }

  saveBriefing(content) {
    this._cache.briefing = { lastShown: Date.now(), lastContent: content };
    this._scheduleSave();
  }

  // ─── Claude history ───────────────────────────────────────────────────────

  addClaudeMessage(role, content) {
    this._cache.claude.history.push({ role, content, ts: Date.now() });
    if (this._cache.claude.history.length > 50) {
      this._cache.claude.history = this._cache.claude.history.slice(-50);
    }
    this._scheduleSave();
  }

  getClaudeHistory(limit = 10) {
    return this._cache.claude.history.slice(-limit);
  }

  // ─── Reminders ──────────────────────────────────────────────────────────

  getReminders() {
    return [...(this._cache.reminders || [])];
  }

  addReminder(reminder) {
    if (!reminder.id) reminder.id = this._uuid();
    if (!this._cache.reminders) this._cache.reminders = [];
    this._cache.reminders.push(reminder);
    this._scheduleSave();
    return reminder;
  }

  updateReminder(id, partial) {
    const reminders = this._cache.reminders || [];
    const r = reminders.find(rem => rem.id === id);
    if (r) { Object.assign(r, partial); this._scheduleSave(); }
    return r;
  }

  deleteReminder(id) {
    const reminders = this._cache.reminders || [];
    const r = reminders.find(rem => rem.id === id);
    if (r) { r.status = 'deleted'; this._scheduleSave(); }
    return r;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flush(), 2000);
  }

  _flush() {
    if (!this._dirty) return;
    this._store.set(this._cache);
    this._dirty = false;
  }

  flushSync() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._flush();
  }

  _uuid() {
    return require('crypto').randomUUID();
  }

  get storePath() {
    return this._store.path;
  }
}

module.exports = new Database();
