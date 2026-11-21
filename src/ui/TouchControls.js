/**
 * Ergonomic Dual-Thumb Mobile Virtual Controls for "海中喜马拉雅" (Ocean Himalayas 3D).
 * - Left analog joystick (360° smooth movement + auto-sprint outer ring)
 * - Open-viewport multi-touch camera look + two-finger pinch zoom
 * - Right Genshin/BotW action arc: Jump/Paraglider, Sprint, Climb, Ultrahand Grab, Activate
 * - Contextual Ultrahand sub-bar (Weld, Rotate, Throw, Unweld, Near/Far) shown while holding props
 * - Collapsible 7-part Quick-Spawn drawer so mobile screens stay clean and unobstructed
 */

import { PROP_CATALOG } from '../config/worldConfig.js';

export function isTouchDevice() {
  return (
    typeof window !== 'undefined' &&
    ('ontouchstart' in window ||
      (navigator && navigator.maxTouchPoints > 0) ||
      window.matchMedia?.('(pointer: coarse)')?.matches)
  );
}

const PROP_SHORT_ICONS = {
  plank: '🪵',
  log: '🌲',
  wheel: '⚙️',
  fan: '🌀',
  rocket: '🚀',
  boulder: '🪨',
  barrel: '🧨',
};

export class TouchControls {
  /**
   * @param {HTMLElement} container
   * @param {HTMLCanvasElement} canvas
   * @param {object} keys - shared live keys map read by PlayerController
   * @param {object} callbacks
   */
  constructor(container, canvas, keys, callbacks = {}) {
    this.container = container;
    this.canvas = canvas;
    this.keys = keys;
    this.cb = callbacks;

    this.enabled = isTouchDevice();
    this._spawnOpen = false;

    // Joystick state
    this._joyPointerId = null;
    this._joyCenterX = 0;
    this._joyCenterY = 0;
    this._joyMaxR = 46;

    // Multi-touch canvas camera look & pinch state
    this._canvasTouches = new Map(); // touchId -> { x, y }
    this._pinchDist = 0;

    // One-shot pulse timers for jump / climb taps
    this._spacePulseTimer = null;
    this._climbPulseTimer = null;

    this._buildDOM();
    this._bindJoystick();
    this._bindActionButtons();
    this._bindCanvasTouchLook();
    this.setEnabled(this.enabled);
  }

  _buildDOM() {
    this.root = document.createElement('div');
    this.root.className = 'oh-touch-root';

    const propButtons = Object.values(PROP_CATALOG)
      .map(
        (p) => `
        <button class="oh-t-spawn-item" data-spawn="${p.id}" type="button">
          <span class="oh-t-spawn-ico">${PROP_SHORT_ICONS[p.id] || '📦'}</span>
          <span class="oh-t-spawn-lbl">${p.name.replace(/^雪松|^高山|^古代|^喜马拉雅|^星陨/, '')}</span>
        </button>
      `
      )
      .join('');

    this.root.innerHTML = `
      <!-- Left Analog Joystick -->
      <div class="oh-t-joy-zone" data-ref="joyZone">
        <div class="oh-t-joy-base" data-ref="joyBase">
          <div class="oh-t-joy-ring"></div>
          <div class="oh-t-joy-knob" data-ref="joyKnob"></div>
        </div>
      </div>

      <!-- Collapsible Quick-Spawn Drawer (Left-Top above joystick) -->
      <div class="oh-t-spawn-wrap" data-ref="spawnWrap">
        <button class="oh-t-mini-btn oh-t-spawn-toggle" data-ref="spawnToggle" type="button">
          <span>📦 召唤</span>
        </button>
        <div class="oh-t-spawn-panel" data-ref="spawnPanel">
          ${propButtons}
        </div>
      </div>

      <!-- Contextual Ultrahand Sub-Controls (Visible only while holding a prop) -->
      <div class="oh-t-ultra-bar" data-ref="ultraBar">
        <button class="oh-t-ultra-btn is-weld" data-ref="btnWeld" type="button">✨ 粘合</button>
        <button class="oh-t-ultra-btn" data-ref="btnRotateY" type="button">↻ 旋转</button>
        <button class="oh-t-ultra-btn" data-ref="btnThrow" type="button">💨 投掷</button>
        <button class="oh-t-ultra-btn" data-ref="btnUnweld" type="button">✂️ 拆开</button>
        <button class="oh-t-ultra-btn is-sm" data-ref="btnCloser" type="button">－</button>
        <button class="oh-t-ultra-btn is-sm" data-ref="btnFarther" type="button">＋</button>
      </div>

      <!-- Right Action Arc (Genshin / BotW Mobile Layout) -->
      <div class="oh-t-actions">
        <!-- Upper arc: Climb, Grab, Activate -->
        <button class="oh-t-btn oh-t-btn-climb" data-ref="btnClimb" type="button">
          <span class="oh-t-ico">🧗</span>
          <span class="oh-t-lbl">攀爬</span>
        </button>
        <button class="oh-t-btn oh-t-btn-grab" data-ref="btnGrab" type="button">
          <span class="oh-t-ico">✋</span>
          <span class="oh-t-lbl" data-ref="grabLbl">抓取</span>
        </button>
        <button class="oh-t-btn oh-t-btn-act" data-ref="btnActivate" type="button">
          <span class="oh-t-ico">⚡</span>
          <span class="oh-t-lbl">启停</span>
        </button>

        <!-- Lower arc: Sprint + Primary Jump/Paraglider -->
        <button class="oh-t-btn oh-t-btn-sprint" data-ref="btnSprint" type="button">
          <span class="oh-t-ico">🏃</span>
          <span class="oh-t-lbl">疾跑</span>
        </button>
        <button class="oh-t-btn oh-t-btn-jump" data-ref="btnJump" type="button">
          <span class="oh-t-ico" data-ref="jumpIco">⬆️</span>
          <span class="oh-t-lbl" data-ref="jumpLbl">跳跃</span>
        </button>
      </div>
    `;

    this.container.appendChild(this.root);

    this.el = {};
    this.root.querySelectorAll('[data-ref]').forEach((node) => {
      this.el[node.getAttribute('data-ref')] = node;
    });
  }

  setEnabled(flag) {
    this.enabled = Boolean(flag);
    this.root.classList.toggle('is-visible', this.enabled);
    document.body.classList.toggle('oh-touch-mode', this.enabled);
    if (!this.enabled) {
      this._resetJoystick();
      this.keys._touchSprint = false;
      this.keys._touchSpace = false;
      this.keys._touchClimb = false;
    }
  }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  _resetJoystick() {
    this._joyPointerId = null;
    this.keys._analogFwd = 0;
    this.keys._analogRight = 0;
    this.el.joyKnob.style.transform = 'translate3d(0px, 0px, 0px)';
    this.el.joyBase.classList.remove('is-active');
  }

  _updateJoystickFromClient(clientX, clientY) {
    const dx = clientX - this._joyCenterX;
    const dy = clientY - this._joyCenterY;
    const dist = Math.hypot(dx, dy);
    const maxR = this._joyMaxR;
    const clampedDist = Math.min(dist, maxR);
    const angle = Math.atan2(dy, dx);

    const kx = Math.cos(angle) * clampedDist;
    const ky = Math.sin(angle) * clampedDist;
    this.el.joyKnob.style.transform = `translate3d(${kx.toFixed(1)}px, ${ky.toFixed(1)}px, 0px)`;

    const normX = kx / maxR;
    const normY = ky / maxR;

    // Deadzone 0.10
    const mag = Math.hypot(normX, normY);
    if (mag < 0.1) {
      this.keys._analogRight = 0;
      this.keys._analogFwd = 0;
    } else {
      this.keys._analogRight = normX;
      this.keys._analogFwd = -normY; // screen up (-Y) is forward (+1)
    }
  }

  _bindJoystick() {
    const zone = this.el.joyZone;

    zone.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        e.stopPropagation();
        this.cb.onInteract?.();

        if (this._joyPointerId !== null) return;
        this._joyPointerId = e.pointerId;
        try {
          zone.setPointerCapture(e.pointerId);
        } catch {}

        const rect = this.el.joyBase.getBoundingClientRect();
        this._joyCenterX = rect.left + rect.width * 0.5;
        this._joyCenterY = rect.top + rect.height * 0.5;
        this._joyMaxR = Math.max(36, rect.width * 0.42);

        this.el.joyBase.classList.add('is-active');
        this._updateJoystickFromClient(e.clientX, e.clientY);
      },
      { passive: false }
    );

    zone.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== this._joyPointerId) return;
        e.preventDefault();
        e.stopPropagation();
        this._updateJoystickFromClient(e.clientX, e.clientY);
      },
      { passive: false }
    );

    const releaseJoy = (e) => {
      if (e.pointerId !== this._joyPointerId) return;
      e.preventDefault();
      this._resetJoystick();
    };
    zone.addEventListener('pointerup', releaseJoy, { passive: false });
    zone.addEventListener('pointercancel', releaseJoy, { passive: false });
  }

  _bindTap(el, onDown, onUp = null) {
    if (!el) return;
    el.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.cb.onInteract?.();
        el.classList.add('is-pressed');
        try {
          el.setPointerCapture(e.pointerId);
        } catch {}
        onDown(e);
      },
      { passive: false }
    );
    const finish = (e) => {
      e.preventDefault();
      el.classList.remove('is-pressed');
      if (onUp) onUp(e);
    };
    el.addEventListener('pointerup', finish, { passive: false });
    el.addEventListener('pointercancel', finish, { passive: false });
  }

  _bindActionButtons() {
    // Jump / Paraglider toggle (pulse Space down/up cleanly)
    this._bindTap(
      this.el.btnJump,
      () => {
        this.keys._touchSpace = true;
        if (this._spacePulseTimer) clearTimeout(this._spacePulseTimer);
      },
      () => {
        this.keys._touchSpace = false;
      }
    );

    // Sprint (hold)
    this._bindTap(
      this.el.btnSprint,
      () => {
        this.keys._touchSprint = true;
      },
      () => {
        this.keys._touchSprint = false;
      }
    );

    // Climb toggle (pulse KeyC)
    this._bindTap(
      this.el.btnClimb,
      () => {
        this.keys._touchClimb = true;
        if (this._climbPulseTimer) clearTimeout(this._climbPulseTimer);
        this._climbPulseTimer = setTimeout(() => {
          this.keys._touchClimb = false;
        }, 120);
      },
      () => {
        this.keys._touchClimb = false;
      }
    );

    // Ultrahand Grab / Release
    this._bindTap(this.el.btnGrab, () => {
      this.cb.onGrabOrRelease?.();
    });

    // Activate nearby contraption (raft fan, buggy, rocket, barrel)
    this._bindTap(this.el.btnActivate, () => {
      this.cb.onToggleActivate?.();
    });

    // Contextual Ultrahand sub-buttons
    this._bindTap(this.el.btnWeld, () => this.cb.onWeld?.());
    this._bindTap(this.el.btnRotateY, () => this.cb.onRotate?.('y', 1));
    this._bindTap(this.el.btnThrow, () => this.cb.onThrow?.());
    this._bindTap(this.el.btnUnweld, () => this.cb.onUnweld?.());
    this._bindTap(this.el.btnCloser, () => this.cb.onAdjustDistance?.(-1.2));
    this._bindTap(this.el.btnFarther, () => this.cb.onAdjustDistance?.(1.2));

    // Collapsible Spawn Drawer
    this._bindTap(this.el.spawnToggle, () => {
      this._spawnOpen = !this._spawnOpen;
      this.el.spawnWrap.classList.toggle('is-open', this._spawnOpen);
    });

    this.root.querySelectorAll('.oh-t-spawn-item').forEach((btn) => {
      this._bindTap(btn, () => {
        const propId = btn.getAttribute('data-spawn');
        this.cb.onSpawnProp?.(propId);
      });
    });
  }

  _bindCanvasTouchLook() {
    const canvas = this.canvas;
    if (!canvas) return;

    canvas.addEventListener(
      'touchstart',
      (e) => {
        // Auto-reveal touch controls if user touches screen on a touch device
        if (!this.enabled) {
          this.setEnabled(true);
          this.cb.onAutoEnable?.();
        }
        e.preventDefault();
        this.cb.onInteract?.();

        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          this._canvasTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
        }

        if (this._canvasTouches.size === 2) {
          const pts = Array.from(this._canvasTouches.values());
          this._pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        }
      },
      { passive: false }
    );

    canvas.addEventListener(
      'touchmove',
      (e) => {
        if (this._canvasTouches.size === 0) return;
        e.preventDefault();

        if (this._canvasTouches.size === 1) {
          const t = e.changedTouches[0];
          const prev = this._canvasTouches.get(t.identifier);
          if (prev) {
            const dx = t.clientX - prev.x;
            const dy = t.clientY - prev.y;
            prev.x = t.clientX;
            prev.y = t.clientY;
            this.cb.onLookDelta?.(dx, dy);
          }
        } else if (this._canvasTouches.size >= 2) {
          for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const prev = this._canvasTouches.get(t.identifier);
            if (prev) {
              prev.x = t.clientX;
              prev.y = t.clientY;
            }
          }
          const pts = Array.from(this._canvasTouches.values());
          const newDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          if (this._pinchDist > 0) {
            const delta = (this._pinchDist - newDist) * 0.035;
            this.cb.onPinchZoom?.(delta);
          }
          this._pinchDist = newDist;
        }
      },
      { passive: false }
    );

    const endTouch = (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        this._canvasTouches.delete(e.changedTouches[i].identifier);
      }
      if (this._canvasTouches.size < 2) {
        this._pinchDist = 0;
      }
    };
    canvas.addEventListener('touchend', endTouch, { passive: true });
    canvas.addEventListener('touchcancel', endTouch, { passive: true });
  }

  /**
   * Keeps button icons & contextual Ultrahand bar synced with live gameplay state.
   */
  update(playerState, ultrahandState) {
    if (!this.enabled) return;

    const mode = playerState?.mode || 'idle';
    const isAirborne = mode === 'jump' || mode === 'fall';
    const isGliding = mode === 'glide';
    const isClimbing = mode === 'climb';

    // Update Jump / Paraglider primary button label dynamically
    if (isGliding) {
      this.el.jumpIco.textContent = '🪂';
      this.el.jumpLbl.textContent = '收伞';
      this.el.btnJump.classList.add('is-gliding');
    } else if (isAirborne) {
      this.el.jumpIco.textContent = '🪂';
      this.el.jumpLbl.textContent = '滑翔伞';
      this.el.btnJump.classList.add('is-gliding');
    } else {
      this.el.jumpIco.textContent = '⬆️';
      this.el.jumpLbl.textContent = '跳跃';
      this.el.btnJump.classList.remove('is-gliding');
    }

    this.el.btnClimb.classList.toggle('is-active', isClimbing);

    const isHolding = Boolean(ultrahandState?.heldName);
    const hasAim = Boolean(ultrahandState?.aimedName);
    const canWeld = Boolean(ultrahandState?.canWeld);

    this.el.grabLbl.textContent = isHolding ? '放下' : '抓取';
    this.el.btnGrab.classList.toggle('is-holding', isHolding);
    this.el.btnGrab.classList.toggle('is-aimed', !isHolding && hasAim);

    this.el.ultraBar.classList.toggle('is-visible', isHolding);
    this.el.btnWeld.classList.toggle('is-ready', canWeld);
    this.el.btnWeld.disabled = !canWeld;
  }
}
