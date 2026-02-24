'use strict';

/**
 * GameLoop — drives the 60fps animation loop in the renderer process.
 * Mimics the requestAnimationFrame-based loop from the original DrVibe.
 */
class GameLoop {
  constructor() {
    this._running = false;
    this._listeners = new Set();
    this._lastTime = 0;
    this._frameId = null;
    this._fps = 60;
    this._frameInterval = 1000 / this._fps;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    this._tick(this._lastTime);
  }

  stop() {
    this._running = false;
    if (this._frameId) {
      cancelAnimationFrame(this._frameId);
      this._frameId = null;
    }
  }

  onTick(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _tick(now) {
    if (!this._running) return;
    this._frameId = requestAnimationFrame((t) => this._tick(t));

    const delta = now - this._lastTime;
    if (delta < this._frameInterval) return;

    this._lastTime = now - (delta % this._frameInterval);
    const dt = Math.min(delta / 1000, 0.05); // cap delta at 50ms

    for (const fn of this._listeners) {
      try { fn(dt, now); } catch (e) { console.error('[GameLoop]', e); }
    }
  }
}

module.exports = GameLoop;
