'use strict';

/**
 * renderer.js — main character window renderer process.
 * Runs in the browser context (no Node.js access — only window.beacon API).
 */

const GameLoop = (() => {
  // Inline GameLoop (can't require() in renderer without nodeIntegration)
  class GL {
    constructor() {
      this._running = false;
      this._listeners = new Set();
      this._lastTime = 0;
    }
    start() {
      this._running = true;
      this._lastTime = performance.now();
      requestAnimationFrame(t => this._tick(t));
    }
    onTick(fn) { this._listeners.add(fn); }
    _tick(now) {
      if (!this._running) return;
      requestAnimationFrame(t => this._tick(t));
      const dt = Math.min((now - this._lastTime) / 1000, 0.05);
      this._lastTime = now;
      for (const fn of this._listeners) { try { fn(dt, now); } catch(e) {} }
    }
  }
  return new GL();
})();

// ─── Load Animator via script tag approach ────────────────────────────────────
// We inline a simplified version since we can't use require() here.
// The full Animator class is loaded from a script tag added below.

const canvas = document.getElementById('canvas');
let animator = null;

// Dynamically load the Animator module
const script = document.createElement('script');
script.src = '../features/character/Animator.js';

// Wrap in a browser-compatible version
// Since contextIsolation=true, we use a different approach: load via fetch
async function loadAnimator() {
  try {
    const response = await fetch('./src/features/character/Animator.js');
    const code = await response.text();
    // Use new Function() so the class is in function scope and we can return it
    const factoryCode = code
      .replace(/"use strict";\n?/, '')
      .replace(/module\.exports\s*=\s*Animator;?[\s]*$/, 'return Animator;');
    const AnimatorClass = (new Function(factoryCode))(); // eslint-disable-line no-new-func
    animator = new AnimatorClass(canvas);
  } catch (e) {
    console.error('Failed to load Animator:', e);
    animator = createFallbackAnimator(canvas);
  }
}

function createFallbackAnimator(canvas) {
  const ctx = canvas.getContext('2d');
  return {
    time: 0,
    state: 'idle',
    momentum: 0,
    setState(s, m) { this.state = s; this.momentum = m; },
    speak(text) {
      this._speech = text;
      setTimeout(() => { this._speech = null; }, 3000);
    },
    render(dt) {
      this.time += dt;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Simple fallback drawing — pulsing beacon circle
      const pulse = 0.8 + Math.sin(this.time * 2) * 0.2;
      const colors = {
        idle: '#6040c0', coding: '#42c8f5', excited: '#ff9f42',
        fire: '#ff4242', sleeping: '#a0a0ff', celebrating: '#42f590',
        warning: '#ff4242', focused: '#42c8f5',
      };
      const color = colors[this.state] || '#6040c0';

      // Glow
      const grd = ctx.createRadialGradient(80, 130, 5, 80, 130, 50 * pulse);
      grd.addColorStop(0, color + 'aa');
      grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, 160, 220);

      // Body
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(80, 120, 28 * pulse, 0, Math.PI * 2);
      ctx.fill();

      // "B" text
      ctx.fillStyle = 'white';
      ctx.font = 'bold 24px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('B', 80, 128);

      // Speech
      if (this._speech) {
        ctx.fillStyle = 'rgba(20,15,50,0.9)';
        ctx.beginPath();
        ctx.roundRect(10, 20, 140, 40, 8);
        ctx.fill();
        ctx.fillStyle = '#e0d0ff';
        ctx.font = '10px Segoe UI, sans-serif';
        ctx.fillText(this._speech.slice(0, 22), 80, 42);
      }
    },
  };
}

// ─── State ────────────────────────────────────────────────────────────────────

let currentState = 'idle';
let currentMomentum = 0;
let isHovered = false;

// Momentum pip elements
const pips = [0, 1, 2, 3, 4].map(i => document.getElementById(`pip${i}`));

function updateMomentumPips(level) {
  pips.forEach((pip, i) => {
    pip.classList.toggle('lit', i < level);
    pip.classList.toggle('high', i < level && level >= 4);
  });
}

// ─── Context menu ─────────────────────────────────────────────────────────────

const ctxMenu = document.getElementById('ctx-menu');

function showContextMenu(x, y) {
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - 170)}px`;
  ctxMenu.style.top  = `${Math.min(y, window.innerHeight - 160)}px`;
  ctxMenu.classList.add('visible');
  window.beacon.enableInput();
}

function hideContextMenu() {
  ctxMenu.classList.remove('visible');
}

document.getElementById('menu-briefing').addEventListener('click', () => {
  hideContextMenu();
  // Open briefing via IPC — use a custom approach since we don't have ipcRenderer
  window.beacon.getBriefing(); // triggers main to show briefing window
  window.beacon.notify('BEACON', 'Opening your daily briefing...');
});

document.getElementById('menu-projects').addEventListener('click', () => {
  hideContextMenu();
  window.beacon.notify('BEACON', 'Opening project dashboard...');
});

document.getElementById('menu-ask').addEventListener('click', async () => {
  hideContextMenu();
  const question = prompt('Ask BEACON anything about your projects:');
  if (question) {
    if (animator) animator.speak('Thinking...');
    const response = await window.beacon.claudeAsk(question);
    if (response && animator) animator.speak(response.slice(0, 60));
  }
});

document.getElementById('menu-reminder').addEventListener('click', () => {
  hideContextMenu();
  window.beacon.showReminderWindow();
});

document.getElementById('menu-settings').addEventListener('click', () => {
  hideContextMenu();
  window.beacon.notify('BEACON', 'Opening settings...');
});

document.getElementById('menu-hide').addEventListener('click', () => {
  hideContextMenu();
  window.beacon.disableInput();
});

// ─── Mouse interaction ────────────────────────────────────────────────────────

canvas.addEventListener('mouseenter', () => {
  isHovered = true;
  window.beacon.enableInput();
});

canvas.addEventListener('mouseleave', () => {
  isHovered = false;
  if (!ctxMenu.classList.contains('visible')) {
    window.beacon.disableInput();
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY);
});

canvas.addEventListener('click', (e) => {
  if (ctxMenu.classList.contains('visible')) {
    hideContextMenu();
    return;
  }
  // Single click: show current project info
  window.beacon.getAllProjectStats().then(stats => {
    const active = stats.find(s => s.project.lastActiveAt);
    if (active && animator) {
      const h = Math.floor((active.project.totalTimeMs || 0) / 3600000);
      animator.speak(`${active.project.name} — ${h}h total`);
    }
  });
});

document.addEventListener('click', (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
});

// ─── IPC from main process ────────────────────────────────────────────────────

window.beacon.on('character-state', (data) => {
  if (!animator) return;
  const { state, momentum } = data;
  currentState = state;
  currentMomentum = momentum;
  animator.setState(state, momentum);
  updateMomentumPips(momentum);
});

window.beacon.on('reminder-speak', (data) => {
  if (animator && data.text) animator.speak(data.text, 5000);
});

// ─── Game loop ────────────────────────────────────────────────────────────────

GameLoop.onTick((dt) => {
  if (animator) animator.render(dt);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadAnimator().then(() => {
  GameLoop.start();
  // Initial greeting
  setTimeout(() => {
    if (animator) animator.speak('BEACON is watching.');
  }, 1500);
});
