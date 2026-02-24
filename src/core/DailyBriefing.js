'use strict';

const db = require('./Database');
const registry = require('./ProjectRegistry');
const bus = require('./EventBus');

/**
 * DailyBriefing — generates your morning project summary.
 *
 * On startup (or on demand), Beacon builds a briefing that covers:
 *   • What you were working on last session
 *   • Which projects have been neglected (no activity in N days)
 *   • Goals that are overdue or due soon
 *   • Your streak status
 *   • A personalized coaching message from Beacon
 *
 * The briefing is shown once per calendar day unless force-shown.
 */
class DailyBriefing {
  constructor() {
    this._shown = false;
  }

  /**
   * Returns whether the briefing should be shown today.
   * Will not show again until tomorrow unless force=true.
   */
  shouldShow(force = false) {
    if (force) return true;
    if (!db.getSetting('briefingOnStartup')) return false;

    const { lastShown } = db.getBriefing();
    if (!lastShown) return true;

    const lastDate = new Date(lastShown).toDateString();
    const today = new Date().toDateString();
    return lastDate !== today;
  }

  /**
   * Builds and returns the full briefing object.
   */
  generate() {
    const recentSessions = db.getRecentSessions(10);
    const lastSession = recentSessions[0] || null;
    const projects = db.getProjects();
    const streak = db.get('streak');
    const overdueGoals = db.getOverdueGoals();
    const recentProjects = db.getRecentProjects(5);

    // Find neglected projects (active but not touched in 3+ days)
    const threeDaysAgo = Date.now() - 3 * 86400000;
    const neglected = Object.values(projects).filter(p =>
      p.status === 'active' &&
      p.lastActiveAt &&
      p.lastActiveAt < threeDaysAgo
    ).sort((a, b) => a.lastActiveAt - b.lastActiveAt).slice(0, 3);

    // Find upcoming goals (due in next 3 days, not completed)
    const threeDaysFromNow = Date.now() + 3 * 86400000;
    const upcomingGoals = [];
    for (const [projectId, goals] of Object.entries(db.get('goals'))) {
      for (const goal of goals) {
        if (!goal.completed && goal.dueDate && goal.dueDate <= threeDaysFromNow) {
          const project = db.getProject(projectId);
          upcomingGoals.push({ ...goal, projectName: project?.name || 'Unknown' });
        }
      }
    }
    upcomingGoals.sort((a, b) => a.dueDate - b.dueDate);

    // Get pending reminders (safe — ReminderEngine may not be loaded yet)
    let pendingReminders = [];
    try {
      const reminderEngine = require('./ReminderEngine');
      pendingReminders = reminderEngine.getPendingForBriefing();
    } catch (e) { /* not yet initialized */ }

    // Build the briefing object
    const briefing = {
      generatedAt: Date.now(),
      pendingReminders,
      streak,
      lastSession: lastSession ? {
        projectName: this._projectName(lastSession.projectId),
        durationMs: lastSession.durationMs,
        endedAt: lastSession.endedAt,
        filesEdited: lastSession.filesEdited || 0,
        summary: lastSession.summary || null,
      } : null,
      recentProjects: recentProjects.map(p => ({
        id: p.id,
        name: p.name,
        language: p.language,
        daysSinceActive: p.lastActiveAt
          ? Math.floor((Date.now() - p.lastActiveAt) / 86400000)
          : null,
        totalTimeMs: p.totalTimeMs || 0,
        goalsCount: (db.getGoals(p.id) || []).filter(g => !g.completed).length,
      })),
      neglectedProjects: neglected.map(p => ({
        id: p.id,
        name: p.name,
        daysSinceActive: Math.floor((Date.now() - p.lastActiveAt) / 86400000),
      })),
      overdueGoals: overdueGoals.slice(0, 5).map(g => ({
        ...g,
        projectName: this._projectName(g.projectId),
        daysOverdue: Math.floor((Date.now() - g.dueDate) / 86400000),
      })),
      upcomingGoals: upcomingGoals.slice(0, 5),
      suggestion: this._buildSuggestion({ lastSession, neglected, overdueGoals, streak, recentProjects }),
      coachingMessage: this._buildCoachingMessage({ lastSession, neglected, overdueGoals, streak }),
    };

    db.saveBriefing(briefing);
    bus.emit(bus.EVENTS.BRIEFING_READY, { briefing });
    return briefing;
  }

  _projectName(id) {
    if (!id) return null;
    return db.getProject(id)?.name || 'Unknown Project';
  }

  _buildSuggestion({ lastSession, neglected, overdueGoals, streak, recentProjects }) {
    if (overdueGoals.length > 0) {
      return `You have ${overdueGoals.length} overdue goal${overdueGoals.length > 1 ? 's' : ''}. Consider tackling "${overdueGoals[0].title}" in ${this._projectName(overdueGoals[0].projectId)} first.`;
    }
    if (lastSession) {
      const name = this._projectName(lastSession.projectId);
      const hoursAgo = Math.floor((Date.now() - lastSession.endedAt) / 3600000);
      if (hoursAgo < 24) {
        return `You were just working on ${name}. Jump back in to keep the momentum going.`;
      }
      return `Continue where you left off in ${name}.`;
    }
    if (neglected.length > 0) {
      return `"${neglected[0].name}" hasn't been touched in ${Math.floor((Date.now() - neglected[0].lastActiveAt) / 86400000)} days. Consider revisiting it.`;
    }
    return `Start a new session and make some progress today.`;
  }

  _buildCoachingMessage({ lastSession, neglected, overdueGoals, streak }) {
    const messages = [];

    // Streak message
    if (streak && streak.current > 0) {
      if (streak.current === 1) {
        messages.push(`You're starting fresh today. Build on yesterday's momentum.`);
      } else if (streak.current >= 7) {
        messages.push(`${streak.current}-day streak! You're on a roll. Don't break the chain.`);
      } else {
        messages.push(`${streak.current} days in a row. Consistency is your superpower.`);
      }
    }

    // Warning messages
    if (overdueGoals.length > 0) {
      messages.push(`⚠️ ${overdueGoals.length} goal${overdueGoals.length > 1 ? 's are' : ' is'} overdue. Address these before new work.`);
    }
    if (neglected.length > 1) {
      messages.push(`${neglected.length} projects haven't had attention in days. Consider parking what you're not actively pursuing.`);
    }

    // Positive reinforcement
    if (lastSession && lastSession.durationMs > 2 * 3600000) {
      messages.push(`Great session yesterday — ${Math.floor(lastSession.durationMs / 3600000)}h of focused work.`);
    }

    return messages.length > 0
      ? messages.join(' ')
      : `Good morning. Open a project and let's get to work.`;
  }

  /**
   * Check if any neglected projects or overdue goals should trigger
   * a reminder notification (called periodically by main process).
   */
  checkReminders() {
    const reminders = [];
    const overdueGoals = db.getOverdueGoals();

    if (overdueGoals.length > 0 && db.getSetting('goalRemindersEnabled')) {
      reminders.push({
        type: 'overdue_goals',
        title: 'BEACON: Overdue Goals',
        body: `You have ${overdueGoals.length} overdue goal${overdueGoals.length > 1 ? 's' : ''}. Check your project goals.`,
      });
    }

    return reminders;
  }
}

module.exports = new DailyBriefing();
