'use strict';

const https = require('https');
const db = require('./Database');
const bus = require('./EventBus');

/**
 * ClaudeCoach — integrates Claude AI for project coaching and session summaries.
 *
 * Requires: Claude API key set in settings (settings.claudeApiKey)
 *
 * Features:
 *   • End-of-session summaries ("You spent 2h on auth, 3 momentum dips...")
 *   • Project health reports ("ProjectX hasn't been touched in 2 weeks")
 *   • On-demand coaching questions via the UI
 *   • Weekly digest
 */
class ClaudeCoach {
  constructor() {
    this._apiUrl = 'api.anthropic.com';
    this._model = 'claude-sonnet-4-6';
    this._maxTokens = 1024;
    this._systemPrompt = `You are BEACON, a Windows desktop coding companion and project management assistant.
You run in the background, tracking the user's coding projects, sessions, and goals.
You have access to their project history, session data, goals, and coding patterns.

Your personality:
- Direct, encouraging, and honest
- Like a senior dev who's seen it all and wants you to succeed
- Brief by default (1-3 sentences) unless asked for detail
- You track everything so nothing slips through the cracks
- You gently remind users of neglected projects and overdue goals

Always respond in plain text (no markdown unless asked). Keep responses concise.`;
  }

  isEnabled() {
    return db.getSetting('claudeEnabled') && !!db.getSetting('claudeApiKey');
  }

  /**
   * Generate an end-of-session coaching message.
   */
  async summarizeSession(session) {
    if (!this.isEnabled()) return null;

    const project = session.projectId ? db.getProject(session.projectId) : null;
    const projectName = project?.name || 'an unnamed project';
    const durationH = (session.durationMs / 3600000).toFixed(1);
    const goals = project ? db.getGoals(project.id) : [];
    const openGoals = goals.filter(g => !g.completed);

    const prompt = `Session just ended:
- Project: ${projectName} (${project?.language || 'Unknown'})
- Duration: ${durationH}h
- Files edited: ${session.filesEdited || 0}
- Momentum level: ${session.peakMomentum || 'unknown'}/5
- Stuck events: ${session.stuckCount || 0}
- Open goals: ${openGoals.length}
${openGoals.length > 0 ? `- Next goal: "${openGoals[0].title}"` : ''}

Give me a brief session debrief (2-3 sentences max). Note what was accomplished, any concerns, and what to tackle next.`;

    return this._query(prompt);
  }

  /**
   * Weekly project health report.
   */
  async weeklyReport() {
    if (!this.isEnabled()) return null;

    const projects = db.getProjects();
    const recentSessions = db.getRecentSessions(20);
    const overdueGoals = db.getOverdueGoals();
    const streak = db.get('streak');

    const projectSummaries = Object.values(projects).map(p => {
      const sessions = db.getSessionsForProject(p.id, 10);
      const weekMs = sessions
        .filter(s => s.startedAt > Date.now() - 7 * 86400000)
        .reduce((sum, s) => sum + (s.durationMs || 0), 0);
      return `${p.name} (${p.language}): ${(weekMs / 3600000).toFixed(1)}h this week, status: ${p.status}`;
    }).join('\n');

    const prompt = `Weekly coding report:
Streak: ${streak?.current || 0} days (longest: ${streak?.longest || 0})
Overdue goals: ${overdueGoals.length}

Projects this week:
${projectSummaries || 'No projects tracked yet.'}

Give a concise weekly assessment (3-4 sentences). What's going well, what needs attention, what's the focus for next week?`;

    return this._query(prompt);
  }

  /**
   * Answer an arbitrary coaching question from the user.
   */
  async ask(question) {
    if (!this.isEnabled()) {
      return 'Claude coaching is not enabled. Add your API key in Settings → Claude.';
    }

    const history = db.getClaudeHistory(6);
    const context = this._buildContext();

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: `${context}\n\nUser question: ${question}` },
    ];

    const response = await this._queryWithMessages(messages);
    if (response) {
      db.addClaudeMessage('user', question);
      db.addClaudeMessage('assistant', response);
    }
    return response;
  }

  _buildContext() {
    const recentProjects = db.getRecentProjects(3);
    const streak = db.get('streak');
    const overdueGoals = db.getOverdueGoals();

    const lines = [
      `[Context — ${new Date().toLocaleDateString()}]`,
      `Active projects: ${recentProjects.map(p => `${p.name} (${p.language})`).join(', ') || 'none'}`,
      `Streak: ${streak?.current || 0} days`,
      `Overdue goals: ${overdueGoals.length}`,
    ];
    return lines.join('\n');
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  async _query(userMessage) {
    return this._queryWithMessages([{ role: 'user', content: userMessage }]);
  }

  _queryWithMessages(messages) {
    const apiKey = db.getSetting('claudeApiKey');
    if (!apiKey) return Promise.resolve(null);

    const body = JSON.stringify({
      model: db.getSetting('claudeModel') || this._model,
      max_tokens: this._maxTokens,
      system: this._systemPrompt,
      messages,
    });

    return new Promise((resolve) => {
      const options = {
        hostname: this._apiUrl,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.content && parsed.content[0]) {
              const text = parsed.content[0].text;
              bus.emit(bus.EVENTS.CLAUDE_RESPONSE, { text });
              resolve(text);
            } else {
              console.error('[ClaudeCoach] Unexpected response:', data);
              bus.emit(bus.EVENTS.CLAUDE_ERROR, { error: 'Unexpected response format' });
              resolve(null);
            }
          } catch (e) {
            console.error('[ClaudeCoach] Parse error:', e);
            bus.emit(bus.EVENTS.CLAUDE_ERROR, { error: e.message });
            resolve(null);
          }
        });
      });

      req.on('error', (e) => {
        console.error('[ClaudeCoach] Request error:', e);
        bus.emit(bus.EVENTS.CLAUDE_ERROR, { error: e.message });
        resolve(null);
      });

      req.setTimeout(15000, () => {
        req.destroy();
        resolve(null);
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = new ClaudeCoach();
