'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload — secure bridge between main process and renderer.
 * Exposes only specific APIs, nothing else.
 */
contextBridge.exposeInMainWorld('beacon', {
  // Window controls
  closeWindow:         ()       => ipcRenderer.send('close-window'),
  minimizeWindow:      ()       => ipcRenderer.send('minimize-window'),
  enableInput:         ()       => ipcRenderer.send('character-enable-input'),
  disableInput:        ()       => ipcRenderer.send('character-disable-input'),
  getWindowPosition:   ()       => ipcRenderer.invoke('get-window-position'),
  setWindowPosition:   (x, y)  => ipcRenderer.send('set-window-position', x, y),

  // Notifications
  notify:              (title, body) => ipcRenderer.send('show-notification', { title, body }),

  // Settings
  getSettings:         ()       => ipcRenderer.invoke('get-settings'),
  saveSettings:        (data)   => ipcRenderer.invoke('save-settings', data),

  // Projects
  getProjects:         ()       => ipcRenderer.invoke('get-projects'),
  getProject:          (id)     => ipcRenderer.invoke('get-project', id),
  saveProject:         (data)   => ipcRenderer.invoke('save-project', data),
  deleteProject:       (id)     => ipcRenderer.invoke('delete-project', id),
  addProject:          (data)   => ipcRenderer.invoke('add-project', data),
  parkProject:         (id)     => ipcRenderer.invoke('park-project', id),
  getProjectStats:     (id)     => ipcRenderer.invoke('get-project-stats', id),
  getAllProjectStats:   ()       => ipcRenderer.invoke('get-all-project-stats'),
  scanForProjects:     (roots)  => ipcRenderer.invoke('scan-for-projects', roots),

  // Goals
  getGoals:            (pid)    => ipcRenderer.invoke('get-goals', pid),
  addGoal:             (pid, g) => ipcRenderer.invoke('add-goal', { projectId: pid, goal: g }),
  completeGoal:        (pid, gid) => ipcRenderer.invoke('complete-goal', { projectId: pid, goalId: gid }),
  updateGoal:          (pid, gid, p) => ipcRenderer.invoke('update-goal', { projectId: pid, goalId: gid, partial: p }),

  // Sessions & skills
  getSessions:         (pid)    => ipcRenderer.invoke('get-sessions', pid),
  getStreak:           ()       => ipcRenderer.invoke('get-streak'),
  getSkills:           ()       => ipcRenderer.invoke('get-skills'),

  // Briefing
  getBriefing:         ()       => ipcRenderer.invoke('get-briefing'),

  // Claude
  claudeAsk:           (q)      => ipcRenderer.invoke('claude-ask', q),
  claudeWeeklyReport:  ()       => ipcRenderer.invoke('claude-weekly-report'),
  getClaudeHistory:    ()       => ipcRenderer.invoke('get-claude-history'),

  // Reminders
  getReminders:           ()     => ipcRenderer.invoke('get-reminders'),
  addReminder:            (data) => ipcRenderer.invoke('add-reminder', data),
  deleteReminder:         (id)   => ipcRenderer.invoke('delete-reminder', id),
  getProjectsForReminder: ()     => ipcRenderer.invoke('get-projects-for-reminder'),
  showReminderWindow:     ()     => ipcRenderer.send('show-reminder-window'),

  // Utility
  openPath:            (p)      => ipcRenderer.invoke('open-path', p),

  // Event listeners (main → renderer)
  on: (channel, fn) => {
    const allowed = ['character-state', 'briefing-data', 'activity-update', 'project-switched', 'reminder-speak'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => fn(data));
    }
  },
  off: (channel, fn) => {
    ipcRenderer.removeListener(channel, fn);
  },
});
