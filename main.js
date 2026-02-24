'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell, nativeImage, screen } = require('electron');
const path = require('path');

// ─── Singleton guard ──────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ─── Deferred requires (after app ready) ─────────────────────────────────────
let db, registry, briefing, coach, activityMonitor, reminderEngine;

// ─── Window references ────────────────────────────────────────────────────────
let characterWindow = null;
let briefingWindow   = null;
let settingsWindow   = null;
let projectsWindow   = null;
let reminderWindow   = null;
let tray             = null;

// ─── Dev mode ─────────────────────────────────────────────────────────────────
const isDev = process.argv.includes('--dev');

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Load singletons after Electron is ready (electron-store needs this)
  db             = require('./src/core/Database');
  registry       = require('./src/core/ProjectRegistry');
  briefing       = require('./src/core/DailyBriefing');
  coach          = require('./src/core/ClaudeCoach');
  activityMonitor = require('./src/features/activity/ActivityMonitor');
  reminderEngine  = require('./src/core/ReminderEngine');

  // Create windows
  createCharacterWindow();
  createTray();

  // Start background systems
  registry.init();
  activityMonitor.start();
  reminderEngine.init();

  // When a reminder fires, show notification + character speech
  const bus = require('./src/core/EventBus');
  bus.on(bus.EVENTS.REMINDER_FIRED, (data) => {
    showNotification('BEACON Reminder', data.text);
    if (characterWindow && !characterWindow.isDestroyed()) {
      characterWindow.webContents.send('reminder-speak', { text: data.text });
    }
  });

  // Show daily briefing if appropriate
  if (briefing.shouldShow()) {
    setTimeout(() => showBriefingWindow(), 1500);
  }

  // Periodic reminder checks every 30 minutes
  setInterval(() => {
    const reminders = briefing.checkReminders();
    for (const r of reminders) {
      showNotification(r.title, r.body);
    }
  }, 30 * 60 * 1000);
});

app.on('second-instance', () => {
  // If user opens a second instance, just show the character window
  if (characterWindow) {
    if (characterWindow.isMinimized()) characterWindow.restore();
    characterWindow.show();
    characterWindow.focus();
  }
});

app.on('window-all-closed', (e) => {
  // On Windows: keep running in tray even when all windows are closed
  e.preventDefault();
});

app.on('before-quit', () => {
  if (db) db.flushSync();
  if (activityMonitor) activityMonitor.stop();
  if (registry) registry.destroy();
  if (reminderEngine) reminderEngine.destroy();
});

// ─── Character window ─────────────────────────────────────────────────────────

function createCharacterWindow() {
  const savedPos = db.getSetting('characterX') !== undefined
    ? { x: db.getSetting('characterX'), y: db.getSetting('characterY') }
    : getDefaultCharacterPosition();

  characterWindow = new BrowserWindow({
    width: 160,
    height: 220,
    x: savedPos.x,
    y: savedPos.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,   // click-through by default
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  characterWindow.setIgnoreMouseEvents(true, { forward: true });
  characterWindow.loadFile('index.html');

  if (isDev) {
    characterWindow.webContents.openDevTools({ mode: 'detach' });
  }

  characterWindow.on('moved', () => {
    const [x, y] = characterWindow.getPosition();
    db.setSetting('characterX', x);
    db.setSetting('characterY', y);
  });

  characterWindow.on('closed', () => { characterWindow = null; });
}

function getDefaultCharacterPosition() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  return { x: width - 200, y: height - 250 };
}

// ─── Briefing window ──────────────────────────────────────────────────────────

function showBriefingWindow(force = false) {
  if (briefingWindow && !briefingWindow.isDestroyed()) {
    briefingWindow.focus();
    return;
  }

  const data = briefing.generate();

  briefingWindow = new BrowserWindow({
    width: 520,
    height: 620,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  briefingWindow.loadFile('briefing.html');

  briefingWindow.webContents.once('did-finish-load', () => {
    briefingWindow.webContents.send('briefing-data', data);
    briefingWindow.show();
  });

  briefingWindow.on('closed', () => { briefingWindow = null; });
}

// ─── Settings window ──────────────────────────────────────────────────────────

function showSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 560,
    height: 700,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  settingsWindow.loadFile('settings.html');
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ─── Projects window ──────────────────────────────────────────────────────────

function showProjectsWindow() {
  if (projectsWindow && !projectsWindow.isDestroyed()) {
    projectsWindow.focus();
    return;
  }

  projectsWindow = new BrowserWindow({
    width: 700,
    height: 780,
    frame: false,
    resizable: true,
    center: true,
    show: false,
    minWidth: 560,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  projectsWindow.loadFile('projects.html');
  projectsWindow.once('ready-to-show', () => projectsWindow.show());
  projectsWindow.on('closed', () => { projectsWindow = null; });
}

// ─── Reminder window ─────────────────────────────────────────────────────────

function showReminderWindow() {
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.focus();
    return;
  }

  reminderWindow = new BrowserWindow({
    width: 420,
    height: 520,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  reminderWindow.loadFile('reminder.html');
  reminderWindow.once('ready-to-show', () => reminderWindow.show());
  reminderWindow.on('closed', () => { reminderWindow = null; });
}

// ─── System tray ──────────────────────────────────────────────────────────────

function createTray() {
  // Generate a simple tray icon programmatically via nativeImage
  // (Real app would use assets/icons/tray.ico)
  const iconPath = path.join(__dirname, 'assets', 'icons', 'tray.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('BEACON — Your Project Memory Companion');
  rebuildTrayMenu();

  tray.on('double-click', () => {
    if (characterWindow) {
      characterWindow.setIgnoreMouseEvents(false);
      characterWindow.focus();
    }
  });
}

function rebuildTrayMenu() {
  if (!tray) return;

  const active = registry ? registry.getActiveProject() : null;
  const recentProjects = db ? db.getRecentProjects(5) : [];

  const projectItems = recentProjects.length > 0
    ? recentProjects.map(p => ({
        label: `  ${p.name} (${p.language || '?'})`,
        click: () => showProjectsWindow(),
      }))
    : [{ label: '  No projects yet', enabled: false }];

  const menu = Menu.buildFromTemplate([
    { label: 'BEACON', enabled: false },
    {
      label: active ? `Working on: ${active.name}` : 'No active project',
      enabled: false,
    },
    { type: 'separator' },
    { label: '📋 Today\'s Briefing', click: () => showBriefingWindow(true) },
    { label: '📁 My Projects', click: () => showProjectsWindow() },
    { label: '⏰ Set Reminder', click: () => showReminderWindow() },
    { type: 'separator' },
    { label: 'Recent Projects:', enabled: false },
    ...projectItems,
    { type: 'separator' },
    { label: '⚙️ Settings', click: () => showSettingsWindow() },
    { type: 'separator' },
    {
      label: 'Toggle Character',
      click: () => {
        if (characterWindow) {
          if (characterWindow.isVisible()) {
            characterWindow.hide();
          } else {
            characterWindow.show();
          }
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit BEACON', click: () => { app.exit(0); } },
  ]);

  tray.setContextMenu(menu);
}

// ─── Notifications ────────────────────────────────────────────────────────────

function showNotification(title, body, options = {}) {
  if (!db || !db.getSetting('notificationsEnabled')) return;
  if (!Notification.isSupported()) return;

  const n = new Notification({
    title,
    body,
    silent: options.silent || false,
    urgency: options.urgency || 'normal',
  });
  n.show();
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

// Character window interaction (make draggable/clickable on demand)
ipcMain.on('character-enable-input', () => {
  if (characterWindow) characterWindow.setIgnoreMouseEvents(false);
});
ipcMain.on('character-disable-input', () => {
  if (characterWindow) characterWindow.setIgnoreMouseEvents(true, { forward: true });
});

// Window close/minimize
ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});
ipcMain.on('minimize-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

// Notification from renderer
ipcMain.on('show-notification', (_, { title, body }) => {
  showNotification(title, body);
});

// Data access
ipcMain.handle('get-settings', () => db.getSettings());
ipcMain.handle('save-settings', (_, partial) => {
  db.mergeSettings(partial);
  rebuildTrayMenu();
  return true;
});

ipcMain.handle('get-projects', () => {
  const projects = db.getProjects();
  return Object.values(projects);
});
ipcMain.handle('get-project', (_, id) => db.getProject(id));
ipcMain.handle('save-project', (_, data) => {
  const saved = db.saveProject(data);
  rebuildTrayMenu();
  return saved;
});
ipcMain.handle('delete-project', (_, id) => {
  db.deleteProject(id);
  rebuildTrayMenu();
  return true;
});
ipcMain.handle('add-project', (_, data) => registry.addProject(data));
ipcMain.handle('park-project', (_, id) => registry.parkProject(id));
ipcMain.handle('get-project-stats', (_, id) => registry.getProjectStats(id));
ipcMain.handle('get-all-project-stats', () => registry.getAllProjectStats());

ipcMain.handle('get-goals', (_, projectId) => db.getGoals(projectId));
ipcMain.handle('add-goal', (_, { projectId, goal }) => db.addGoal(projectId, goal));
ipcMain.handle('complete-goal', (_, { projectId, goalId }) => db.completeGoal(projectId, goalId));
ipcMain.handle('update-goal', (_, { projectId, goalId, partial }) => db.updateGoal(projectId, goalId, partial));

ipcMain.handle('get-sessions', (_, projectId) => {
  return projectId ? db.getSessionsForProject(projectId) : db.getRecentSessions(20);
});

ipcMain.handle('get-streak', () => db.get('streak'));
ipcMain.handle('get-skills', () => db.getSkills());

ipcMain.handle('get-briefing', () => briefing.generate());

ipcMain.handle('claude-ask', async (_, question) => {
  return coach.ask(question);
});
ipcMain.handle('claude-weekly-report', async () => {
  return coach.weeklyReport();
});
ipcMain.handle('get-claude-history', () => db.getClaudeHistory(20));

ipcMain.handle('scan-for-projects', async (_, roots) => {
  await registry.scanRoots(roots || db.getSetting('scanRoots') || []);
  return Object.values(db.getProjects());
});

ipcMain.handle('open-path', (_, filePath) => {
  shell.openPath(filePath);
});

// Reminders
ipcMain.on('show-reminder-window', () => showReminderWindow());
ipcMain.handle('get-reminders', () => reminderEngine.getReminders());
ipcMain.handle('add-reminder', (_, data) => reminderEngine.addReminder(data));
ipcMain.handle('delete-reminder', (_, id) => reminderEngine.deleteReminder(id));
ipcMain.handle('get-projects-for-reminder', () => {
  const projects = db.getProjects();
  return Object.values(projects)
    .filter(p => p.status === 'active' || !p.status)
    .map(p => ({ id: p.id, name: p.name }));
});

// Character state updates — broadcast from ActivityMonitor → character window
ipcMain.on('update-character-state', (_, state) => {
  if (characterWindow && !characterWindow.isDestroyed()) {
    characterWindow.webContents.send('character-state', state);
  }
});

// ─── Export helpers for ActivityMonitor ───────────────────────────────────────

module.exports = { showNotification, rebuildTrayMenu };
