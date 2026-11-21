/**
 * Ergonomic Dual-Thumb Mobile Virtual Controls for "海中喜马拉雅" (Ocean Himalayas 3D).
 * - Genshin-style Dynamic Floating Left Analog Joystick (42% × 48% lower-left touch zone)
 * - Outer-ring Auto-Sprint illumination (>92% push) + dedicated Sprint button
 * - Micro haptic feedback (navigator.vibrate) on crisp gameplay actions
 * - Multi-touch isolated open-viewport camera look + two-finger pinch zoom
 * - Right Genshin/BotW action arc: Jump/Paraglider, Sprint, Climb, Ultrahand Grab, Activate
 * - Contextual Ultrahand sub-bar (Weld, Level, Rotate, Throw, Unweld, Near/Far)
 * - Collapsible Quick-Spawn drawer with 3 One-Tap Vehicle Presets + 7 Physics Parts
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

function vibrate(ms = 12) {
  try {
    navigator?.vibrate?.(ms);
  } catch {
    // Ignore on browsers without Vibration API (e.g. iOS Safari)
  }
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

const VEHICLE_PRESETS = [
  { id: 'raft', icon: '🛶', label: '涡轮木筏' },
  { id: 'buggy', icon: '🏎️', label: '越野车' },
  { id: 'rocket_sled', icon: '🚀', label: '火箭板' },
];

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

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

    // Floating dynamic joystick state
    this._joyPointerId = null;
    this._joyCenterX = 0;
    this._joyCenterY = 0;
    this._joyMaxR = 48;
    this._joyAutoSprint = false;
    this._btnSprintHeld = false;

    // Multi-touch canvas camera look & pinch state
    this._canvasTouches = new Map(); // touchId -> { x, y }
    this._pinchDist = 0;

    // One-shot pulse timers for jump / climb taps
    this._spacePulseTimer = null;
    this._climbPulseTimer = null;

    this._buildDOM();
    this._bindJoystick();
    this._bindActionButtons();
    this._bindOutsideDismiss();
    this._bindCanvasTouchLook();
    this.setEnabled(this.enabled);
  }

  _buildDOM() {
    this.root = document.createElement('div');
    this.root.className = 'oh-touch-root';

    const presetButtons = VEHICLE_PRESETS.map(
      (preset) => `
        <button class="oh-t-preset-item" data-preset="${preset.id}" type="button">
          <span class="oh-t-preset-ico">${preset.icon}</span>
          <span class="oh-t-preset-lbl">${preset.label}</span>
        </button>
      `
    ).join('');

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
      <!-- Left Floating Dynamic Analog Joystick Quadrant -->
      <div class="oh-t-joy-zone" data-ref="joyZone">
        <div class="oh-t-joy-anchor" data-ref="joyAnchor" aria-hidden="true"></div>
        <div class="oh-t-joy-base" data-ref="joyBase">
          <div class="oh-t-joy-ring"></div>
          <div class="oh-t-joy-sprint-ring"></div>
          <div class="oh-t-joy-knob" data-ref="joyKnob"></div>
        </div>
      </div>

      <!-- Collapsible Quick-Spawn Drawer (Vehicle Presets + 7 Physics Parts) -->
      <div class="oh-t-spawn-wrap" data-ref="spawnWrap">
        <button class="oh-t-mini-btn oh-t-spawn-toggle" data-ref="spawnToggle" type="button">
          <span>📦 召唤</span>
        </button>
        <div class="oh-t-spawn-panel" data-ref="spawnPanel">
          <div class="oh-t-spawn-section-lbl">一键整车</div>
          <div class="oh-t-preset-row">
            ${presetButtons}
          </div>
          <div class="oh-t-spawn-section-lbl">自由拼装部件</div>
          <div class="oh-t-parts-grid">
            ${propButtons}
          </div>
        </div>
      </div>

      <!-- Contextual Ultrahand Sub-Controls (Visible only while holding a prop) -->
      <div class="oh-t-ultra-bar" data-ref="ultraBar">
        <button class="oh-t-ultra-btn is-weld" data-ref="btnWeld" type="button">✨ 粘合</button>
        <button class="oh-t-ultra-btn" data-ref="btnLevel" type="button">📐 摆平</button>
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
      this.closeSpawnDrawer();
      this._btnSprintHeld = false;
      this._joyAutoSprint = false;
      this.keys._touchSprint = false;
      this.keys._touchSpace = false;
      this.keys._touchClimb = false;
    }
  }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  closeSpawnDrawer() {
    if (!this._spawnOpen) return;
    this._spawnOpen = false;
    this.el.spawnWrap?.classList.remove('is-open');
  }

  _syncSprintState() {
    this.keys._touchSprint = Boolean(this._btnSprintHeld || this._joyAutoSprint);
    this.el.btnSprint?.classList.toggle('is-auto-sprint', this._joyAutoSprint);
  }

  _resetJoystick() {
    this._joyPointerId = null;
    this._joyAutoSprint = false;
    this.keys._analogFwd = 0;
    this.keys._analogRight = 0;
    this._syncSprintState();

    this.el.joyKnob.style.transform = 'translate3d(0px, 0px, 0px)';
    this.el.joyBase.classList.remove('is-active', 'is-dragging', 'is-sprint');
    this.el.joyBase.style.transform = 'translate3d(0px, 0px, 0px)';
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

    // Deadzone 0.09
    const mag = Math.hypot(normX, normY);
    if (mag < 0.09) {
      this.keys._analogRight = 0;
      this.keys._analogFwd = 0;
    } else {
      this.keys._analogRight = normX;
      this.keys._analogFwd = -normY; // screen up (-Y) is forward (+1)
    }

    // Outer-ring auto-sprint (>92% rim with smooth hysteresis)
    const rawRatio = dist / maxR;
    if (!this._joyAutoSprint && rawRatio > 0.92) {
      this._joyAutoSprint = true;
      this.el.joyBase.classList.add('is-sprint');
      this._syncSprintState();
      vibrate(8);
    } else if (this._joyAutoSprint && rawRatio < 0.84) {
      this._joyAutoSprint = false;
      this.el.joyBase.classList.remove('is-sprint');
      this._syncSprintState();
    }
  }

  _bindJoystick() {
    const zone = this.el.joyZone;

    // Prevent touch events inside joystick zone from reaching canvas
    zone.addEventListener(
      'touchstart',
      (e) => {
        if (!this.enabled) return;
        e.stopPropagation();
      },
      { passive: true }
    );

    zone.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        e.stopPropagation();
        this.cb.onInteract?.();
        this.closeSpawnDrawer();

        if (this._joyPointerId !== null) return;
        this._joyPointerId = e.pointerId;
        try {
          zone.setPointerCapture(e.pointerId);
        } catch {}

        // Position floating joystick smoothly under thumb, clamped within safe viewport bounds
        const anchorRect = this.el.joyAnchor.getBoundingClientRect();
        const zoneRect = zone.getBoundingClientRect();
        const baseR = Math.max(46, anchorRect.width * 0.5);
        const restCenterX = anchorRect.left + anchorRect.width * 0.5;
        const restCenterY = anchorRect.top + anchorRect.height * 0.5;

        const minX = Math.max(baseR + 12, zoneRect.left + baseR + 8);
        const maxX = Math.max(minX, zoneRect.right - baseR - 6);
        const minY = Math.max(baseR + 12, zoneRect.top + baseR + 8);
        const maxY = Math.max(minY, Math.min(window.innerHeight - baseR - 14, zoneRect.bottom - baseR - 8));

        const targetCenterX = clamp(e.clientX, minX, maxX);
        const targetCenterY = clamp(e.clientY, minY, maxY);

        this._joyCenterX = targetCenterX;
        this._joyCenterY = targetCenterY;
        this._joyMaxR = Math.max(38, baseR * 0.86);

        const offsetX = targetCenterX - restCenterX;
        const offsetY = targetCenterY - restCenterY;

        this.el.joyBase.classList.add('is-active', 'is-dragging');
        this.el.joyBase.style.transform = `translate3d(${offsetX.toFixed(1)}px, ${offsetY.toFixed(1)}px, 0px)`;
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
      'touchstart',
      (e) => {
        e.stopPropagation();
      },
      { passive: true }
    );
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
    // Jump / Paraglider toggle (pulse Space cleanly)
    this._bindTap(
      this.el.btnJump,
      () => {
        vibrate(14);
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
        vibrate(10);
        this._btnSprintHeld = true;
        this._syncSprintState();
      },
      () => {
        this._btnSprintHeld = false;
        this._syncSprintState();
      }
    );

    // Climb toggle (pulse KeyC)
    this._bindTap(
      this.el.btnClimb,
      () => {
        vibrate(12);
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
      vibrate(14);
      this.cb.onGrabOrRelease?.();
    });

    // Activate nearby contraption (raft fan, buggy, rocket, barrel)
    this._bindTap(this.el.btnActivate, () => {
      vibrate(15);
      this.cb.onToggleActivate?.();
    });

    // Contextual Ultrahand sub-buttons
    this._bindTap(this.el.btnWeld, () => {
      if (this.el.btnWeld.disabled) return;
      vibrate(18);
      this.cb.onWeld?.();
    });
    this._bindTap(this.el.btnLevel, () => {
      vibrate(12);
      this.cb.onLevelHeld?.();
    });
    this._bindTap(this.el.btnRotateY, () => {
      vibrate(10);
      this.cb.onRotate?.('y', 1);
    });
    this._bindTap(this.el.btnThrow, () => {
      vibrate(16);
      this.cb.onThrow?.();
    });
    this._bindTap(this.el.btnUnweld, () => {
      vibrate(12);
      this.cb.onUnweld?.();
    });
    this._bindTap(this.el.btnCloser, () => {
      vibrate(10);
      this.cb.onAdjustDistance?.(-1.2);
    });
    this._bindTap(this.el.btnFarther, () => {
      vibrate(10);
      this.cb.onAdjustDistance?.(1.2);
    });

    // Collapsible Spawn Drawer
    this._bindTap(this.el.spawnToggle, () => {
      vibrate(10);
      this._spawnOpen = !this._spawnOpen;
      this.el.spawnWrap.classList.toggle('is-open', this._spawnOpen);
    });

    // Prevent touching inside spawn panel from leaking to canvas
    this.el.spawnPanel?.addEventListener(
      'pointerdown',
      (e) => {
        e.stopPropagation();
      },
      { passive: true }
    );
    this.el.spawnPanel?.addEventListener(
      'touchstart',
      (e) => {
        e.stopPropagation();
      },
      { passive: true }
    );

    // One-tap Complete Vehicle Presets
    this.root.querySelectorAll('.oh-t-preset-item').forEach((btn) => {
      this._bindTap(btn, () => {
        vibrate(16);
        const presetId = btn.getAttribute('data-preset');
        this.cb.onSpawnPreset?.(presetId);
        this.closeSpawnDrawer();
      });
    });

    // 7 Individual Physics Parts
    this.root.querySelectorAll('.oh-t-spawn-item').forEach((btn) => {
      this._bindTap(btn, () => {
        vibrate(13);
        const propId = btn.getAttribute('data-spawn');
        this.cb.onSpawnProp?.(propId);
      });
    });
  }

  _bindOutsideDismiss() {
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!this._spawnOpen) return;
        if (this.el.spawnWrap && !this.el.spawnWrap.contains(e.target)) {
          this.closeSpawnDrawer();
        }
      },
      { passive: true }
    );
  }

  _bindCanvasTouchLook() {
    const canvas = this.canvas;
    if (!canvas) return;

    canvas.addEventListener(
      'touchstart',
      (e) => {
        if (e.target !== canvas) return;

        // Auto-reveal touch controls if user touches screen on a touch device
        if (!this.enabled) {
          this.setEnabled(true);
          this.cb.onAutoEnable?.();
        }

        // Auto-close spawn drawer & any open mobile HUD sheets when touching the 3D scene
        this.closeSpawnDrawer();
        this.cb.onCanvasTap?.();
        this.cb.onInteract?.();

        let addedAny = false;
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (t.target !== canvas) continue;
          this._canvasTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
          addedAny = true;
        }
        if (!addedAny) return;
        e.preventDefault();

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

        // Check if any changed touch belongs to our tracked canvas touches
        let handled = false;
        if (this._canvasTouches.size === 1) {
          for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const prev = this._canvasTouches.get(t.identifier);
            if (prev) {
              const dx = t.clientX - prev.x;
              const dy = t.clientY - prev.y;
              prev.x = t.clientX;
              prev.y = t.clientY;
              this.cb.onLookDelta?.(dx, dy);
              handled = true;
            }
          }
        } else if (this._canvasTouches.size >= 2) {
          for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const prev = this._canvasTouches.get(t.identifier);
            if (prev) {
              prev.x = t.clientX;
              prev.y = t.clientY;
              handled = true;
            }
          }
          if (handled) {
            const pts = Array.from(this._canvasTouches.values());
            const newDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            if (this._pinchDist > 0) {
              const delta = (this._pinchDist - newDist) * 0.035;
              this.cb.onPinchZoom?.(delta);
            }
            this._pinchDist = newDist;
          }
        }

        if (handled) {
          e.preventDefault();
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
