'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const db = require('./Database');
const bus = require('./EventBus');

/**
 * ProjectRegistry — auto-detects and manages your coding projects.
 *
 * Detection strategy:
 *   1. Watch the active window title for known editor/IDE patterns
 *   2. Scan configured root directories for project markers
 *   3. Let user manually register projects
 *
 * Project markers: .git, package.json, Cargo.toml, pyproject.toml,
 *   *.sln, *.csproj, pom.xml, build.gradle, go.mod, Makefile
 */

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'Makefile',
  'CMakeLists.txt',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
  '*.sln',
  '*.csproj',
];

const CODING_APPS = new Set([
  'code',           // VS Code
  'code - insiders',
  'cursor',         // Cursor AI
  'windsurf',
  'idea64',         // IntelliJ
  'webstorm64',
  'pycharm64',
  'clion64',
  'rider64',
  'devenv',         // Visual Studio
  'sublime_text',
  'atom',
  'notepad++',
  'vim',
  'nvim',
  'emacs',
  'windowsterminal',
  'cmd',
  'powershell',
  'pwsh',
  'wt',             // Windows Terminal
  'wsl',
  'ubuntu',
  'bash',
  'gitbash',
  'git-bash',
  'gitextensions',
  'sourcetree',
  'gitkraken',
  'fork',           // Fork git client
]);

const LANGUAGE_MAP = {
  '.js': 'JavaScript', '.ts': 'TypeScript', '.jsx': 'JavaScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java',
  '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.rb': 'Ruby', '.php': 'PHP',
  '.swift': 'Swift', '.kt': 'Kotlin', '.dart': 'Dart', '.r': 'R',
  '.lua': 'Lua', '.sh': 'Shell', '.ps1': 'PowerShell', '.html': 'HTML',
  '.css': 'CSS', '.scss': 'SCSS', '.vue': 'Vue', '.svelte': 'Svelte',
};

class ProjectRegistry {
  constructor() {
    this._activeProjectId = null;
    this._scanInterval = null;
  }

  // ─── Initialization ───────────────────────────────────────────────────────

  init() {
    // Scan roots on startup
    const roots = db.getSetting('scanRoots') || [];
    if (roots.length > 0 && db.getSetting('autoDetectProjects')) {
      this.scanRoots(roots);
    }

    // Periodic re-scan every 10 minutes
    this._scanInterval = setInterval(() => {
      const currentRoots = db.getSetting('scanRoots') || [];
      if (currentRoots.length > 0) this.scanRoots(currentRoots);
    }, 10 * 60 * 1000);
  }

  destroy() {
    if (this._scanInterval) clearInterval(this._scanInterval);
  }

  // ─── Active project ───────────────────────────────────────────────────────

  get activeProjectId() { return this._activeProjectId; }

  getActiveProject() {
    return this._activeProjectId ? db.getProject(this._activeProjectId) : null;
  }

  /**
   * Called by ActivityMonitor when the foreground window changes.
   * Tries to extract the current project from the window title.
   */
  onWindowChanged(processName, windowTitle) {
    const lowerProc = (processName || '').toLowerCase();
    const isCodingApp = CODING_APPS.has(lowerProc);

    if (!isCodingApp) {
      // Not a coding app — don't change active project
      return;
    }

    // Try to identify project from window title
    const detected = this._identifyProjectFromTitle(windowTitle);
    if (detected) {
      this._setActiveProject(detected.id);
    }
  }

  _identifyProjectFromTitle(title) {
    if (!title) return null;

    const projects = db.getProjects();

    // Try to match project name or path in window title
    for (const project of Object.values(projects)) {
      const nameInTitle = title.toLowerCase().includes(project.name.toLowerCase());
      const pathInTitle = project.rootPath &&
        title.toLowerCase().includes(path.basename(project.rootPath).toLowerCase());

      if (nameInTitle || pathInTitle) {
        return project;
      }
    }
    return null;
  }

  _setActiveProject(id) {
    if (this._activeProjectId === id) return;

    const prev = this._activeProjectId;
    this._activeProjectId = id;

    const project = db.getProject(id);
    if (project) {
      // Update lastActiveAt
      project.lastActiveAt = Date.now();
      db.saveProject(project);

      bus.emit(bus.EVENTS.PROJECT_SWITCHED, { project, prevId: prev });
    }
  }

  // ─── Scanning ─────────────────────────────────────────────────────────────

  async scanRoots(roots) {
    for (const root of roots) {
      try {
        await this._scanDirectory(root, 0, 2);
      } catch (e) {
        console.warn(`[ProjectRegistry] Failed to scan "${root}":`, e.message);
      }
    }
  }

  async _scanDirectory(dir, depth, maxDepth) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check if this directory is a project root
    const hasMarker = entries.some(e => {
      if (PROJECT_MARKERS.includes(e.name)) return true;
      // Check glob patterns like *.sln
      return PROJECT_MARKERS
        .filter(m => m.includes('*'))
        .some(m => {
          const ext = m.replace('*', '');
          return e.name.endsWith(ext);
        });
    });

    if (hasMarker) {
      await this._registerOrUpdateProject(dir, entries);
      return; // Don't recurse into project subdirectories
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (this._shouldSkipDir(entry.name)) continue;
      await this._scanDirectory(path.join(dir, entry.name), depth + 1, maxDepth);
    }
  }

  _shouldSkipDir(name) {
    const skip = new Set([
      'node_modules', 'target', 'dist', 'build', '.git', '.svn',
      '__pycache__', '.venv', 'venv', '.cargo', '.gradle', 'vendor',
      'obj', 'bin', '.vs', '.idea', '.vscode',
    ]);
    return skip.has(name) || name.startsWith('.');
  }

  async _registerOrUpdateProject(dir, entries) {
    const existing = this._findProjectByPath(dir);
    const name = path.basename(dir);
    const language = this._detectLanguage(entries, dir);
    const gitRemote = await this._getGitRemote(dir);
    const isGit = entries.some(e => e.name === '.git');

    if (existing) {
      // Update metadata
      Object.assign(existing, { language, gitRemote, updatedAt: Date.now() });
      db.saveProject(existing);
    } else {
      const project = {
        id: null,
        name,
        rootPath: dir,
        language,
        gitRemote,
        isGit,
        status: 'active',
        totalTimeMs: 0,
        lastActiveAt: null,
        createdAt: Date.now(),
        notes: '',
        tags: [],
      };
      const saved = db.saveProject(project);
      bus.emit(bus.EVENTS.PROJECT_DETECTED, { project: saved });
      console.log(`[ProjectRegistry] Discovered: ${name} (${language}) at ${dir}`);
    }
  }

  _findProjectByPath(dir) {
    const projects = db.getProjects();
    return Object.values(projects).find(p => p.rootPath === dir) || null;
  }

  _detectLanguage(entries, dir) {
    const counts = {};
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (LANGUAGE_MAP[ext]) {
          counts[LANGUAGE_MAP[ext]] = (counts[LANGUAGE_MAP[ext]] || 0) + 1;
        }
      }
    } catch {}

    // Also check package.json / Cargo.toml etc. for definitive signals
    if (entries.some(e => e.name === 'Cargo.toml')) return 'Rust';
    if (entries.some(e => e.name === 'go.mod')) return 'Go';
    if (entries.some(e => e.name === 'pyproject.toml' || e.name === 'setup.py')) return 'Python';
    if (entries.some(e => e.name.endsWith('.sln') || e.name.endsWith('.csproj'))) return 'C#';
    if (entries.some(e => e.name === 'pom.xml' || e.name === 'build.gradle')) return 'Java';

    // Fall back to file count
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0] ? sorted[0][0] : 'Unknown';
  }

  async _getGitRemote(dir) {
    return new Promise((resolve) => {
      exec('git remote get-url origin', { cwd: dir, timeout: 3000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim());
      });
    });
  }

  // ─── Manual management ────────────────────────────────────────────────────

  addProject(data) {
    const project = {
      id: null,
      name: data.name,
      rootPath: data.rootPath || null,
      language: data.language || 'Unknown',
      gitRemote: null,
      isGit: false,
      status: 'active',
      totalTimeMs: 0,
      lastActiveAt: null,
      createdAt: Date.now(),
      notes: data.notes || '',
      tags: data.tags || [],
    };
    const saved = db.saveProject(project);
    bus.emit(bus.EVENTS.PROJECT_ADDED, { project: saved });
    return saved;
  }

  parkProject(id) {
    const project = db.getProject(id);
    if (project) {
      project.status = 'parked';
      db.saveProject(project);
      bus.emit(bus.EVENTS.PROJECT_PARKED, { project });
    }
  }

  addTimeToProject(id, ms) {
    const project = db.getProject(id);
    if (project) {
      project.totalTimeMs = (project.totalTimeMs || 0) + ms;
      project.lastActiveAt = Date.now();
      db.saveProject(project);
    }
  }

  // ─── Statistics ───────────────────────────────────────────────────────────

  getProjectStats(id) {
    const project = db.getProject(id);
    if (!project) return null;

    const sessions = db.getSessionsForProject(id);
    const goals = db.getGoals(id);
    const completedGoals = goals.filter(g => g.completed).length;
    const lastSession = sessions[0] || null;

    return {
      project,
      sessionCount: sessions.length,
      totalTimeMs: project.totalTimeMs || 0,
      goals: goals.length,
      completedGoals,
      lastSession,
      daysSinceActive: project.lastActiveAt
        ? Math.floor((Date.now() - project.lastActiveAt) / 86400000)
        : null,
    };
  }

  getAllProjectStats() {
    const projects = db.getProjects();
    return Object.keys(projects).map(id => this.getProjectStats(id));
  }
}

module.exports = new ProjectRegistry();
