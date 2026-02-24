'use strict';

/**
 * Animator — draws BEACON's pixel-art character on an HTML5 Canvas.
 *
 * Character concept: "The Keeper" — a hooded archivist holding a glowing lantern.
 * Drawn entirely in code, no sprite sheets needed.
 *
 * States: idle, thinking, coding, focused, excited, fire,
 *         hydration, eyestrain, posture, celebrating, warning, sleeping
 *
 * Physics: squash/stretch, organic breathing, lantern flicker,
 *          particle effects for celebrations and momentum.
 */
class Animator {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Character physics
    this.x = canvas.width / 2;
    this.y = canvas.height - 30;
    this.scaleX = 1;
    this.scaleY = 1;
    this.bobY = 0;
    this.bobVel = 0;
    this.breathPhase = Math.random() * Math.PI * 2;
    this.blinkTimer = 0;
    this.isBlinking = false;
    this.eyeOpenness = 1;

    // Lantern
    this.lanternBrightness = 0.7;
    this.lanternColor = '#f5c842';
    this.lanternFlicker = 0;

    // Particles
    this.particles = [];

    // State
    this.state = 'idle';
    this.momentum = 0;
    this.targetScaleX = 1;
    this.targetScaleY = 1;

    // Animation time
    this.time = 0;

    // Speech bubble
    this.speechText = null;
    this.speechTimer = 0;
    this.speechAlpha = 0;
  }

  setState(state, momentum = 0) {
    const prev = this.state;
    this.state = state;
    this.momentum = momentum;

    if (state !== prev) {
      this._onStateEnter(state);
    }
  }

  speak(text, durationMs = 3000) {
    this.speechText = text;
    this.speechTimer = durationMs;
    this.speechAlpha = 0;
  }

  // ─── Main render ──────────────────────────────────────────────────────────

  render(dt) {
    this.time += dt;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this._updatePhysics(dt);
    this._updateParticles(dt);
    this._updateSpeech(dt);

    this.ctx.save();
    this.ctx.translate(this.x, this.y - this.bobY);
    this.ctx.scale(this.scaleX, this.scaleY);

    this._drawShadow();
    this._drawCharacter();

    this.ctx.restore();

    this._drawParticles();
    this._drawSpeechBubble();
  }

  // ─── Physics ──────────────────────────────────────────────────────────────

  _updatePhysics(dt) {
    this.breathPhase += dt * 0.8;

    // Smooth scale towards target (squash/stretch)
    this.scaleX += (this.targetScaleX - this.scaleX) * 8 * dt;
    this.scaleY += (this.targetScaleY - this.scaleY) * 8 * dt;

    // Blink timing
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.isBlinking = !this.isBlinking;
      this.blinkTimer = this.isBlinking ? 0.1 : (2 + Math.random() * 3);
    }
    const targetEye = this.isBlinking ? 0 : 1;
    this.eyeOpenness += (targetEye - this.eyeOpenness) * 20 * dt;

    // Lantern flicker
    this.lanternFlicker = Math.sin(this.time * 7.3) * 0.05 + Math.sin(this.time * 13.1) * 0.03;

    // State-specific physics
    switch (this.state) {
      case 'idle':
        this.bobVel += (-Math.sin(this.breathPhase * 0.5) * 1.5 - this.bobY) * 3 * dt;
        this.lanternBrightness = 0.5 + this.lanternFlicker;
        this.lanternColor = '#f5c842';
        break;

      case 'thinking':
        this.bobVel += (-Math.sin(this.breathPhase * 0.3) * 1 - this.bobY) * 2 * dt;
        this.lanternBrightness = 0.6 + Math.sin(this.time * 2) * 0.1;
        this.lanternColor = '#d4a0ff';
        break;

      case 'coding':
      case 'focused':
        this.bobVel += (-2 - this.bobY) * 4 * dt; // lean forward
        this.lanternBrightness = 0.85 + this.lanternFlicker;
        this.lanternColor = '#42c8f5';
        break;

      case 'excited':
        this.bobVel += (Math.sin(this.time * 8) * 3 - this.bobY) * 10 * dt;
        this.targetScaleX = 1 + Math.sin(this.time * 6) * 0.05;
        this.targetScaleY = 1 + Math.cos(this.time * 6) * 0.05;
        this.lanternBrightness = 1.0;
        this.lanternColor = '#ff9f42';
        if (Math.random() < 0.1) this._spawnParticle('sparkle');
        break;

      case 'fire':
        this.bobVel += (Math.sin(this.time * 12) * 4 - this.bobY) * 12 * dt;
        this.targetScaleX = 1 + Math.sin(this.time * 8) * 0.08;
        this.targetScaleY = 1 + Math.cos(this.time * 8) * 0.08;
        this.lanternBrightness = 1.2;
        this.lanternColor = '#ff4242';
        if (Math.random() < 0.2) this._spawnParticle('fire');
        break;

      case 'celebrating':
        this.bobVel += (Math.sin(this.time * 10) * 5 - this.bobY) * 15 * dt;
        this.targetScaleX = 1.1;
        this.targetScaleY = 0.95;
        this.lanternBrightness = 1.3;
        this.lanternColor = '#42f590';
        if (Math.random() < 0.3) this._spawnParticle('confetti');
        break;

      case 'hydration':
        this.lanternBrightness = 0.6;
        this.lanternColor = '#42a8f5';
        break;

      case 'eyestrain':
        this.eyeOpenness = 0.2;
        this.lanternBrightness = 0.4;
        this.lanternColor = '#f5a242';
        break;

      case 'posture':
        this.bobVel += (2 - this.bobY) * 4 * dt; // stand straight
        this.lanternBrightness = 0.7;
        this.lanternColor = '#42f5a4';
        break;

      case 'warning':
        this.targetScaleX = 1 + Math.sin(this.time * 4) * 0.05;
        this.lanternBrightness = 0.8 + Math.sin(this.time * 4) * 0.4;
        this.lanternColor = '#ff4242';
        break;

      case 'sleeping':
        this.bobVel += (-4 - this.bobY) * 2 * dt; // drooped
        this.eyeOpenness = 0;
        this.lanternBrightness = 0.1;
        this.lanternColor = '#a0a0ff';
        if (Math.random() < 0.02) this._spawnParticle('zzz');
        break;
    }

    // Bob damping
    this.bobVel *= 0.85;
    this.bobY += this.bobVel;
  }

  // ─── Drawing ──────────────────────────────────────────────────────────────

  _drawShadow() {
    this.ctx.save();
    this.ctx.scale(1, 0.3);
    const grd = this.ctx.createRadialGradient(0, 0, 2, 0, 0, 22);
    grd.addColorStop(0, 'rgba(0,0,0,0.25)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    this.ctx.fillStyle = grd;
    this.ctx.beginPath();
    this.ctx.ellipse(0, 8, 22, 8, 0, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  _drawCharacter() {
    const ctx = this.ctx;
    const breath = Math.sin(this.breathPhase * 0.5) * 0.5;

    // ── Robe (body) ──
    ctx.save();
    ctx.translate(0, -20);

    // Robe base
    const robeGrd = ctx.createLinearGradient(-18, -30, 18, 10);
    robeGrd.addColorStop(0, '#2a2060');
    robeGrd.addColorStop(1, '#1a1040');
    ctx.fillStyle = robeGrd;
    ctx.beginPath();
    ctx.moveTo(-14, -28 + breath);
    ctx.bezierCurveTo(-18, -10, -20, 5, -16, 28);
    ctx.lineTo(16, 28);
    ctx.bezierCurveTo(20, 5, 18, -10, 14, -28 + breath);
    ctx.closePath();
    ctx.fill();

    // Robe trim (stars/runes)
    ctx.strokeStyle = 'rgba(120,100,200,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Small star decorations on robe
    const starPositions = [[-8, 5], [8, -2], [-5, 15], [9, 18], [-10, -12]];
    ctx.fillStyle = 'rgba(200,180,255,0.4)';
    for (const [sx, sy] of starPositions) {
      this._drawStar(ctx, sx, sy, 1.5, 4);
    }

    // ── Hood ──
    ctx.fillStyle = '#1a1040';
    ctx.beginPath();
    ctx.arc(0, -28 + breath, 16, Math.PI * 0.9, Math.PI * 2.1);
    ctx.lineTo(0, -14 + breath);
    ctx.closePath();
    ctx.fill();

    // Hood outline
    ctx.strokeStyle = '#3a2880';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // ── Face (in hood shadow) ──
    ctx.fillStyle = '#c4956a';
    ctx.beginPath();
    ctx.ellipse(0, -25 + breath, 9, 10, 0, 0.1, Math.PI - 0.1);
    ctx.closePath();
    ctx.fill();

    // Eyes
    const eyeH = 3 * this.eyeOpenness;
    ctx.fillStyle = this.state === 'fire' ? '#ff4242' : '#ffffff';
    // Left eye
    ctx.beginPath();
    ctx.ellipse(-4, -26 + breath, 2.5, eyeH, 0, 0, Math.PI * 2);
    ctx.fill();
    // Right eye
    ctx.beginPath();
    ctx.ellipse(4, -26 + breath, 2.5, eyeH, 0, 0, Math.PI * 2);
    ctx.fill();

    // Pupils
    if (this.eyeOpenness > 0.3) {
      ctx.fillStyle = '#1a0050';
      ctx.beginPath();
      ctx.ellipse(-4, -26 + breath, 1.2, eyeH * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(4, -26 + breath, 1.2, eyeH * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Arms ──
    ctx.strokeStyle = '#2a2060';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';

    let armAngleL = 0.4;
    let armAngleR = -0.4;

    if (this.state === 'coding' || this.state === 'focused') {
      armAngleL = 0.6;
      armAngleR = -0.6;
    } else if (this.state === 'celebrating') {
      armAngleL = -0.5 + Math.sin(this.time * 6) * 0.3;
      armAngleR = 0.5 - Math.sin(this.time * 6) * 0.3;
    } else if (this.state === 'warning') {
      armAngleL = -0.8 + Math.sin(this.time * 3) * 0.2;
      armAngleR = 0.8 - Math.sin(this.time * 3) * 0.2;
    }

    // Left arm
    ctx.beginPath();
    ctx.moveTo(-12, -10 + breath);
    ctx.lineTo(-22 + Math.cos(armAngleL) * 5, 5 + Math.sin(armAngleL) * 10);
    ctx.stroke();

    // Right arm (holding lantern)
    ctx.beginPath();
    ctx.moveTo(12, -10 + breath);
    ctx.lineTo(22 + Math.cos(armAngleR) * 5, 5 + Math.sin(armAngleR) * 10);
    ctx.stroke();

    // ── Lantern ──
    const lanternX = 22 + Math.cos(armAngleR) * 5 + 5;
    const lanternY = 5 + Math.sin(armAngleR) * 10 + 2;
    this._drawLantern(ctx, lanternX, lanternY, breath);

    ctx.restore();
  }

  _drawLantern(ctx, x, y, breath) {
    const brightness = Math.min(1, this.lanternBrightness + this.lanternFlicker);
    const color = this.lanternColor;

    // Glow halo
    const grd = ctx.createRadialGradient(x, y, 2, x, y, 22 * brightness);
    grd.addColorStop(0, this._hexToRgba(color, 0.5 * brightness));
    grd.addColorStop(1, this._hexToRgba(color, 0));
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, 22 * brightness, 0, Math.PI * 2);
    ctx.fill();

    // Lantern body
    ctx.fillStyle = '#c0a060';
    ctx.beginPath();
    ctx.roundRect(x - 5, y - 7, 10, 12, 2);
    ctx.fill();

    // Lantern glass (lit)
    ctx.fillStyle = this._hexToRgba(color, 0.8 * brightness);
    ctx.beginPath();
    ctx.roundRect(x - 3.5, y - 5.5, 7, 9, 1);
    ctx.fill();

    // Lantern top hook
    ctx.strokeStyle = '#c0a060';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x, y - 10);
    ctx.stroke();
  }

  _drawStar(ctx, x, y, r, points) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const angle = (i * Math.PI) / points - Math.PI / 2;
      const radius = i % 2 === 0 ? r : r * 0.4;
      if (i === 0) ctx.moveTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
      else ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    }
    ctx.closePath();
    ctx.fill();
  }

  // ─── Particles ────────────────────────────────────────────────────────────

  _spawnParticle(type) {
    const p = {
      x: this.x + (Math.random() - 0.5) * 30,
      y: this.y - 20 + (Math.random() - 0.5) * 20,
      vx: (Math.random() - 0.5) * 60,
      vy: -40 - Math.random() * 60,
      life: 1,
      decay: 0.4 + Math.random() * 0.6,
      type,
      color: this.lanternColor,
      size: 2 + Math.random() * 3,
      char: type === 'zzz' ? ['z','z','Z'][Math.floor(Math.random() * 3)] :
            type === 'confetti' ? ['★','✦','·'][Math.floor(Math.random() * 3)] : null,
    };
    this.particles.push(p);
  }

  _updateParticles(dt) {
    for (const p of this.particles) {
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      p.vy += 60 * dt; // gravity
      p.vx *= 0.98;
      p.life -= p.decay * dt;
    }
    this.particles = this.particles.filter(p => p.life > 0);
  }

  _drawParticles() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      ctx.globalAlpha = p.life;
      if (p.char) {
        ctx.fillStyle = p.color;
        ctx.font = `${p.size * 4}px monospace`;
        ctx.fillText(p.char, p.x, p.y);
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ─── Speech bubble ────────────────────────────────────────────────────────

  _updateSpeech(dt) {
    if (!this.speechText) return;
    this.speechTimer -= dt * 1000;
    if (this.speechTimer <= 0) {
      this.speechText = null;
      this.speechAlpha = 0;
      return;
    }
    // Fade in/out
    const fadeMs = 400;
    if (this.speechTimer > fadeMs) {
      this.speechAlpha = Math.min(1, this.speechAlpha + dt * 4);
    } else {
      this.speechAlpha = this.speechTimer / fadeMs;
    }
  }

  _drawSpeechBubble() {
    if (!this.speechText || this.speechAlpha <= 0) return;
    const ctx = this.ctx;
    const bx = this.x - 90;
    const by = this.y - 110;
    const bw = 180;
    const bh = 50;
    const maxChars = 28;
    const text = this.speechText.length > maxChars
      ? this.speechText.slice(0, maxChars - 1) + '…'
      : this.speechText;

    ctx.globalAlpha = this.speechAlpha;
    ctx.fillStyle = 'rgba(20, 15, 50, 0.9)';
    ctx.strokeStyle = '#6040c0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 8);
    ctx.fill();
    ctx.stroke();

    // Tail
    ctx.beginPath();
    ctx.moveTo(this.x - 8, by + bh);
    ctx.lineTo(this.x, by + bh + 10);
    ctx.lineTo(this.x + 8, by + bh);
    ctx.fillStyle = 'rgba(20, 15, 50, 0.9)';
    ctx.fill();

    ctx.fillStyle = '#e0d0ff';
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, bx + bw / 2, by + bh / 2 + 4);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }

  // ─── State transitions ────────────────────────────────────────────────────

  _onStateEnter(state) {
    // Squash/stretch on state change
    this.targetScaleX = 0.9;
    this.targetScaleY = 1.1;
    setTimeout(() => {
      this.targetScaleX = 1;
      this.targetScaleY = 1;
    }, 200);

    // Spawn particles on exciting transitions
    if (state === 'fire' || state === 'celebrating') {
      for (let i = 0; i < 8; i++) this._spawnParticle('sparkle');
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  _hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}

module.exports = Animator;
