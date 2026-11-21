/**
 * BotW-inspired HUD & Interactive Controls for "海中喜马拉雅" (Ocean Himalayas 3D).
 * Manages Welcome Overlay, Compass & Altimeter, Biome Discovery Banner, Stamina Wheel,
 * Ultrahand Context Prompt, Quick-Spawn Dock, Control Strip, Help Panel, and Toasts.
 */

import { WORLD_CONFIG, CHARACTER_MODELS, PROP_CATALOG } from '../config/worldConfig.js';
import { LANDMARKS } from '../world/terrainMath.js';

const COMPASS_CARDINALS = [
  { label: 'N', deg: 0, isCardinal: true, isNorth: true },
  { label: 'NE', deg: 45, isCardinal: false },
  { label: 'E', deg: 90, isCardinal: true },
  { label: 'SE', deg: 135, isCardinal: false },
  { label: 'S', deg: 180, isCardinal: true },
  { label: 'SW', deg: 225, isCardinal: false },
  { label: 'W', deg: 270, isCardinal: true },
  { label: 'NW', deg: 315, isCardinal: false },
];

const COMPASS_LANDMARK_IDS = [
  { id: 'main_summit', label: '雪山主峰', isSky: false },
  { id: 'sky_sanctuary', label: '浮空神殿', isSky: true },
  { id: 'bay_camp', label: '海湾营地', isSky: false },
  { id: 'waterfall_cliff', label: '瀑布悬崖', isSky: false },
];

const TIME_BUTTONS = [
  { id: 'golden', label: '日照金山' },
  { id: 'morning', label: '晨光' },
  { id: 'noon', label: '正午' },
  { id: 'night', label: '星夜' },
];

const TELEPORT_ORDER = [
  'bay_camp',
  'beach_raft',
  'waterfall_cliff',
  'alpine_ruins',
  'main_summit',
  'sky_sanctuary',
];

const BIOME_SUBTITLES = {
  ocean: 'AZURE CORAL SEA',
  beach: 'CORAL BAY SHORELINE',
  coastal_cliff: 'WATERFALL SEA CLIFFS',
  alpine_forest: 'ALPINE MEADOWS & PINES',
  cloud_snowline: 'HIMALAYAN CLOUD SNOWLINE',
  glacier: 'GLACIAL PEAKS & ICE WALLS',
  sky_summit: 'SUMMIT ABOVE THE CLOUDS',
};

const PROP_ICONS = {
  plank: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="8" rx="1.5"/><line x1="7" y1="11" x2="17" y2="11" opacity="0.65"/><line x1="6" y1="13.5" x2="14" y2="13.5" opacity="0.5"/></svg>`,
  log: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="6.5" cy="12" rx="2.5" ry="4.5"/><path d="M6.5 7.5h11a2.5 4.5 0 0 1 0 9h-11"/><line x1="10.5" y1="10.5" x2="16.5" y2="10.5" opacity="0.6"/></svg>`,
  wheel: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6"/><line x1="12" y1="4" x2="12" y2="9.4"/><line x1="12" y1="14.6" x2="12" y2="20"/><line x1="4" y1="12" x2="9.4" y2="12"/><line x1="14.6" y1="12" x2="20" y2="12"/></svg>`,
  fan: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.2" opacity="0.5"/><circle cx="12" cy="12" r="2.2"/><path d="M12 9.8C12 6.5 14.8 5 16 7.4"/><path d="M14.2 12c3.3 0 4.8 2.8 2.4 4"/><path d="M12 14.2c0 3.3-2.8 4.8-4 2.4"/><path d="M9.8 12C6.5 12 5 9.2 7.4 8"/></svg>`,
  rocket: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c2.6 2.2 3.8 5.2 3.8 9.2l-1.8 2.8h-4l-1.8-2.8C8.2 8.2 9.4 5.2 12 3z"/><path d="M8.2 12.2 5.6 15l2.6 1"/><path d="M15.8 12.2 18.4 15l-2.6 1"/><path d="M10.5 18c.5 1.4 1.5 2.5 1.5 2.5s1-1.1 1.5-2.5"/></svg>`,
  boulder: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><polygon points="6,17 4,11 8,6 15,5 20,10 18,17 12,19"/><polyline points="8,6 11,11 18,17" opacity="0.5"/></svg>`,
  barrel: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><ellipse cx="12" cy="6" rx="5.5" ry="2.2"/><path d="M6.5 6v12c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V6"/><path d="M6.5 12c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" opacity="0.65"/><path d="M12 9.5l1 2-2 1 1 2" stroke="#ffb347"/></svg>`,
};

const PROP_SHORT_NAMES = {
  plank: '雪松木板',
  log: '高山圆木',
  wheel: '动力轮',
  fan: '涡轮风扇',
  rocket: '星陨火箭',
  boulder: '巨石',
  barrel: '火药桶',
};

const STAMINA_RADIUS = 20;
const STAMINA_CIRCUMFERENCE = 2 * Math.PI * STAMINA_RADIUS;

function wrapAngleDeg(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  return d;
}

function hexToCss(hexNum) {
  return `#${Number(hexNum).toString(16).padStart(6, '0')}`;
}

export class HUD {
  constructor(container, callbacks = {}) {
    this.container = container || document.body;
    this.callbacks = callbacks;

    this._ready = false;
    this._welcomeVisible = true;
    this._helpOpen = false;
    this._teleportOpen = false;
    this._muted = false;
    this._activeTimeId = 'golden';
    this._activeCharIndex = 0;

    // Cached render state to minimize DOM writes
    this._lastAltText = '';
    this._lastBiomeName = '';
    this._lastBiomeId = null;
    this._biomeCooldown = 0;
    this._biomeBannerTimer = null;
    this._lastPromptKey = '';
    this._lastModeKey = '';
    this._prevStamina = 100;
    this._statsAccum = 0;

    this._compassMarks = [];
    this._compassPins = [];
    this._spawnSlots = new Map();
    this._timeButtons = new Map();

    this._buildDOM();
    this._bindGlobalDismiss();
  }

  _buildDOM() {
    this.root = document.createElement('div');
    this.root.className = 'oh-hud';

    const propList = Object.values(PROP_CATALOG);

    this.root.innerHTML = `
      <!-- 1. Loading / Welcome Overlay -->
      <div class="oh-welcome" data-ref="welcome">
        <div class="oh-welcome-card">
          <div class="oh-welcome-emblem">OCEAN HIMALAYAS 3D</div>
          <h1 class="oh-welcome-title">海中喜马拉雅</h1>
          <p class="oh-welcome-subtitle">
            从蔚蓝珊瑚海湾起航，攀登直插云海的雪域主峰，<br />
            滑翔于瀑布悬崖与浮空神殿之间，用究极手自由拼装海陆空载具。
          </p>
          <div class="oh-progress-wrap">
            <div class="oh-progress-bar" data-ref="progressBar"></div>
          </div>
          <div class="oh-loading-status" data-ref="loadingStatus">正在初始化世界...</div>
          <button class="oh-start-btn" data-ref="startBtn" disabled>
            <span>正在加载世界</span>
          </button>
          <div class="oh-welcome-hints">
            <span><kbd class="oh-kbd">WASD</kbd> 移动</span>
            <span><kbd class="oh-kbd">Space</kbd> 跳跃/滑翔伞</span>
            <span><kbd class="oh-kbd">C</kbd> 攀爬</span>
            <span><kbd class="oh-kbd">E</kbd> 究极手抓取</span>
            <span><kbd class="oh-kbd">G</kbd> 粘合</span>
            <span><kbd class="oh-kbd">1-7</kbd> 召唤部件</span>
            <span><kbd class="oh-kbd">T</kbd> 启动机关</span>
          </div>
        </div>
      </div>

      <!-- 2. Top Compass Bar & Altimeter -->
      <div class="oh-top-center">
        <div class="oh-compass-shell">
          <div class="oh-compass-pointer"></div>
          <div class="oh-compass-viewport">
            <div class="oh-compass-track" data-ref="compassTrack"></div>
          </div>
        </div>
        <div class="oh-altitude-strip">
          <span class="oh-alt-value" data-ref="altValue">海拔 0 m</span>
          <span class="oh-strip-sep"></span>
          <span class="oh-biome-pill" data-ref="biomeLabel">珊瑚海湾沙滩</span>
          <span class="oh-mode-badge" data-ref="modeBadge"></span>
        </div>
      </div>

      <!-- 3. Cinematic Biome Discovery Banner -->
      <div class="oh-biome-banner" data-ref="biomeBanner">
        <div class="oh-biome-banner-ornament">
          <span class="oh-biome-banner-line"></span>
          <span class="oh-biome-banner-diamond"></span>
          <span class="oh-biome-banner-line"></span>
        </div>
        <div class="oh-biome-banner-title" data-ref="biomeBannerTitle"></div>
        <div class="oh-biome-banner-sub" data-ref="biomeBannerSub"></div>
      </div>

      <!-- 4. BotW Circular Green Stamina Wheel -->
      <div class="oh-stamina-wheel is-hidden" data-ref="staminaWheel">
        <svg class="oh-stamina-svg" viewBox="0 0 54 54">
          <circle class="oh-stamina-bg" cx="27" cy="27" r="${STAMINA_RADIUS}"></circle>
          <circle
            class="oh-stamina-arc"
            data-ref="staminaArc"
            cx="27"
            cy="27"
            r="${STAMINA_RADIUS}"
            stroke-dasharray="${STAMINA_CIRCUMFERENCE.toFixed(2)}"
            stroke-dashoffset="0"
          ></circle>
          <circle class="oh-stamina-inner" cx="27" cy="27" r="14"></circle>
        </svg>
      </div>

      <!-- 5. Center Crosshair & Ultrahand Context Prompt -->
      <div class="oh-crosshair" data-ref="crosshair">
        <span class="oh-crosshair-ring"></span>
        <span class="oh-crosshair-dot"></span>
      </div>
      <div class="oh-context-prompt" data-ref="contextPrompt"></div>

      <!-- 6. Bottom Quick-Spawn Dock (1-7 + Activate) -->
      <div class="oh-dock-wrap">
        <div class="oh-dock" data-ref="spawnDock">
          ${propList
            .map(
              (prop) => `
            <button
              class="oh-dock-slot"
              type="button"
              data-prop-id="${prop.id}"
              title="[${prop.key}] 召唤 ${prop.name}"
            >
              <span class="oh-dock-key">${prop.key}</span>
              <span class="oh-dock-dot" style="background:${hexToCss(prop.accent)};"></span>
              <span class="oh-dock-icon">${PROP_ICONS[prop.id] || ''}</span>
              <span class="oh-dock-label">${PROP_SHORT_NAMES[prop.id] || prop.name}</span>
            </button>
          `
            )
            .join('')}
        </div>
        <button class="oh-activate-btn" type="button" data-ref="activateBtn" title="[T] 启动/停止附近风扇、动力轮、火箭与火药桶">
          <kbd class="oh-kbd">T</kbd>
          <span>启停机关</span>
        </button>
      </div>

      <!-- 7. Top-Right Compact Control Strip -->
      <div class="oh-top-right">
        <div class="oh-ctrl-row">
          <div class="oh-pill-group" data-ref="timeGroup">
            ${TIME_BUTTONS.map(
              (t) =>
                `<button class="oh-pill-btn${t.id === 'golden' ? ' is-active' : ''}" type="button" data-time-id="${t.id}">${t.label}</button>`
            ).join('')}
          </div>

          <div class="oh-dropdown" data-ref="teleportDropdown">
            <button class="oh-icon-btn" type="button" data-ref="teleportToggle">传送 ▾</button>
            <div class="oh-dropdown-menu" data-ref="teleportMenu">
              ${TELEPORT_ORDER.map((id) => {
                const lm = LANDMARKS[id];
                if (!lm) return '';
                const dispAlt = Math.max(0, Math.round(lm.y * WORLD_CONFIG.ALTITUDE_DISPLAY_SCALE));
                return `
                  <button class="oh-dropdown-item" type="button" data-landmark-id="${lm.id}">
                    <span>${lm.shortName || lm.name}</span>
                    <span class="oh-dropdown-alt">${dispAlt.toLocaleString()}m</span>
                  </button>
                `;
              }).join('')}
            </div>
          </div>

          <button class="oh-icon-btn" type="button" data-ref="charBtn" title="切换探索者角色模型">
            Seed-san ⇄
          </button>

          <button class="oh-icon-btn" type="button" data-ref="touchBtn" title="开启 / 关闭手机虚拟按键">
            🎮
          </button>

          <button class="oh-icon-btn" type="button" data-ref="muteBtn" title="[M] 静音 / 开启环境音与音效">
            🔊
          </button>

          <button class="oh-icon-btn" type="button" data-ref="helpBtn" title="[H] 显示 / 隐藏按键指南">
            H 指南
          </button>
        </div>

        <div class="oh-stats-pill" data-ref="statsPill">
          60 FPS · 0 物体 · 0 粘合
        </div>
      </div>

      <!-- 8. Controls Help Panel (H) -->
      <div class="oh-help-panel" data-ref="helpPanel">
        <div class="oh-help-header">
          <span class="oh-help-title">探索者操作指南</span>
          <button class="oh-help-close" type="button" data-ref="helpClose">×</button>
        </div>

        <div class="oh-help-section">
          <div class="oh-help-section-title">探索与滑翔</div>
          <div class="oh-help-list">
            <div class="oh-help-row"><span>移动 / 奔跑</span><span><kbd class="oh-kbd">WASD</kbd> + <kbd class="oh-kbd">Shift</kbd></span></div>
            <div class="oh-help-row"><span>跳跃 / 空中开合滑翔伞</span><span><kbd class="oh-kbd">Space</kbd></span></div>
            <div class="oh-help-row"><span>攀爬山崖 / 松手</span><span><kbd class="oh-kbd">C</kbd></span></div>
            <div class="oh-help-row"><span>旋转视角 / 镜头缩放</span><span>鼠标移动 / 滚轮</span></div>
          </div>
        </div>

        <div class="oh-help-section">
          <div class="oh-help-section-title">究极手与物理拼装</div>
          <div class="oh-help-list">
            <div class="oh-help-row"><span>召唤 7 种物理部件</span><span><kbd class="oh-kbd">1</kbd> – <kbd class="oh-kbd">7</kbd></span></div>
            <div class="oh-help-row"><span>抓取 / 放下部件</span><span><kbd class="oh-kbd">E</kbd></span></div>
            <div class="oh-help-row"><span>粘合到高亮目标</span><span><kbd class="oh-kbd">G</kbd></span></div>
            <div class="oh-help-row"><span>拆开粘合连接</span><span><kbd class="oh-kbd">X</kbd></span></div>
            <div class="oh-help-row"><span>旋转 / 推拉 / 投掷</span><span><kbd class="oh-kbd">Q/R</kbd> · 滚轮 · 左键</span></div>
            <div class="oh-help-row"><span>启停附近风扇/轮/火箭/桶</span><span><kbd class="oh-kbd">T</kbd></span></div>
          </div>
        </div>

        <div class="oh-help-section">
          <div class="oh-help-section-title">快捷功能</div>
          <div class="oh-help-list">
            <div class="oh-help-row"><span>静音切换 / 操作指南</span><span><kbd class="oh-kbd">M</kbd> / <kbd class="oh-kbd">H</kbd></span></div>
          </div>
        </div>
      </div>

      <!-- 9. Toast Notification Stack -->
      <div class="oh-toast-stack" data-ref="toastStack"></div>

      <!-- 10. Fatal Error Fallback -->
      <div class="oh-error-overlay" data-ref="errorOverlay">
        <div class="oh-error-card">
          <h2 data-ref="errorTitle">初始化异常</h2>
          <pre data-ref="errorDetail"></pre>
        </div>
      </div>
    `;

    this.container.appendChild(this.root);

    // Cache element references
    const ref = (name) => this.root.querySelector(`[data-ref="${name}"]`);
    this.el = {
      welcome: ref('welcome'),
      progressBar: ref('progressBar'),
      loadingStatus: ref('loadingStatus'),
      startBtn: ref('startBtn'),
      compassTrack: ref('compassTrack'),
      altValue: ref('altValue'),
      biomeLabel: ref('biomeLabel'),
      modeBadge: ref('modeBadge'),
      biomeBanner: ref('biomeBanner'),
      biomeBannerTitle: ref('biomeBannerTitle'),
      biomeBannerSub: ref('biomeBannerSub'),
      staminaWheel: ref('staminaWheel'),
      staminaArc: ref('staminaArc'),
      crosshair: ref('crosshair'),
      contextPrompt: ref('contextPrompt'),
      spawnDock: ref('spawnDock'),
      activateBtn: ref('activateBtn'),
      timeGroup: ref('timeGroup'),
      teleportDropdown: ref('teleportDropdown'),
      teleportToggle: ref('teleportToggle'),
      teleportMenu: ref('teleportMenu'),
      charBtn: ref('charBtn'),
      muteBtn: ref('muteBtn'),
      helpBtn: ref('helpBtn'),
      helpPanel: ref('helpPanel'),
      helpClose: ref('helpClose'),
      statsPill: ref('statsPill'),
      toastStack: ref('toastStack'),
      errorOverlay: ref('errorOverlay'),
      errorTitle: ref('errorTitle'),
      errorDetail: ref('errorDetail'),
    };

    this._initCompassElements();
    this._bindControls();
  }

  _initCompassElements() {
    const track = this.el.compassTrack;
    for (const c of COMPASS_CARDINALS) {
      const node = document.createElement('span');
      node.className = `oh-compass-mark${c.isCardinal ? ' is-cardinal' : ''}${c.isNorth ? ' is-north' : ''}`;
      node.textContent = c.label;
      track.appendChild(node);
      this._compassMarks.push({ ...c, el: node });
    }

    for (const pin of COMPASS_LANDMARK_IDS) {
      const lm = LANDMARKS[pin.id];
      if (!lm) continue;
      const node = document.createElement('span');
      node.className = `oh-compass-pin${pin.isSky ? ' is-sky' : ''}`;
      node.textContent = pin.label;
      track.appendChild(node);
      this._compassPins.push({ ...pin, x: lm.x, z: lm.z, el: node });
    }
  }

  _bindControls() {
    // Welcome start (button or clicking anywhere on overlay once ready)
    const handleStart = (e) => {
      if (!this._ready || !this._welcomeVisible) return;
      e.stopPropagation();
      this.dismissWelcome();
      this.callbacks.onStart?.();
    };
    this.el.startBtn.addEventListener('click', handleStart);
    this.el.welcome.addEventListener('click', handleStart);

    // Time-of-Day buttons
    this.el.timeGroup.querySelectorAll('[data-time-id]').forEach((btn) => {
      const id = btn.dataset.timeId;
      this._timeButtons.set(id, btn);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setActiveTimePreset(id);
        this.callbacks.onTimePreset?.(id);
      });
    });

    // Teleport dropdown
    this.el.teleportToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this._teleportOpen = !this._teleportOpen;
      this.el.teleportDropdown.classList.toggle('is-open', this._teleportOpen);
    });

    this.el.teleportMenu.querySelectorAll('[data-landmark-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const lmId = btn.dataset.landmarkId;
        this._teleportOpen = false;
        this.el.teleportDropdown.classList.remove('is-open');
        this.callbacks.onTeleport?.(lmId);
      });
    });

    // Character switcher
    this.el.charBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._activeCharIndex = (this._activeCharIndex + 1) % CHARACTER_MODELS.length;
      const nextModel = CHARACTER_MODELS[this._activeCharIndex];
      this.setActiveCharacter(nextModel.id);
      this.callbacks.onSwitchCharacter?.(nextModel);
    });

    // Virtual touch controls toggle
    this.el.touchBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextTouch = this.callbacks.onToggleTouch?.();
      if (typeof nextTouch === 'boolean') {
        this.setTouchActive(nextTouch);
      }
    });

    // Mute button
    this.el.muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextMuted = this.callbacks.onToggleMute?.();
      if (typeof nextMuted === 'boolean') {
        this.setMuted(nextMuted);
      } else {
        this.setMuted(!this._muted);
      }
    });

    // Help toggle
    this.el.helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHelp();
    });
    this.el.helpClose.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHelp(false);
    });

    // Quick-Spawn Dock slots (1-7)
    this.el.spawnDock.querySelectorAll('[data-prop-id]').forEach((btn) => {
      const propId = btn.dataset.propId;
      this._spawnSlots.set(propId, btn);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.flashSpawnSlot(propId);
        this.callbacks.onSpawnProp?.(propId);
      });
    });

    // Activate contraptions button (T)
    this.el.activateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onToggleActivate?.();
    });
  }

  _bindGlobalDismiss() {
    window.addEventListener('click', () => {
      if (this._teleportOpen) {
        this._teleportOpen = false;
        this.el.teleportDropdown.classList.remove('is-open');
      }
    });
  }

  // ==================== PUBLIC API ====================

  setLoadingProgress(percent, message) {
    const clamped = Math.max(0, Math.min(100, percent));
    this.el.progressBar.style.width = `${clamped}%`;
    if (message) {
      this.el.loadingStatus.textContent = message;
    }
  }

  setReady() {
    this._ready = true;
    this.el.progressBar.style.width = '100%';
    this.el.loadingStatus.textContent = '世界已就绪 · 推荐佩戴耳机体验海浪与高山风声';
    this.el.startBtn.disabled = false;
    this.el.startBtn.innerHTML = '<span>点击画面进入探索</span>';
  }

  dismissWelcome() {
    if (!this._welcomeVisible) return;
    this._welcomeVisible = false;
    this.el.welcome.classList.add('is-hidden');
  }

  isWelcomeVisible() {
    return this._welcomeVisible;
  }

  setActiveTimePreset(presetId) {
    this._activeTimeId = presetId;
    this._timeButtons.forEach((btn, id) => {
      btn.classList.toggle('is-active', id === presetId);
    });
  }

  setActiveCharacter(modelId) {
    const idx = CHARACTER_MODELS.findIndex((m) => m.id === modelId);
    if (idx >= 0) this._activeCharIndex = idx;
    const shortLabel = modelId === 'heroine' ? 'VRoid ⇄' : 'Seed-san ⇄';
    this.el.charBtn.textContent = shortLabel;
  }

  setTouchActive(active) {
    this.el.touchBtn?.classList.toggle('is-active', Boolean(active));
  }

  setMuted(muted) {
    this._muted = Boolean(muted);
    this.el.muteBtn.textContent = this._muted ? '🔇' : '🔊';
    this.el.muteBtn.classList.toggle('is-active', this._muted);
  }

  toggleHelp(force) {
    this._helpOpen = typeof force === 'boolean' ? force : !this._helpOpen;
    this.el.helpPanel.classList.toggle('is-open', this._helpOpen);
    this.el.helpBtn.classList.toggle('is-active', this._helpOpen);
  }

  flashSpawnSlot(propId) {
    const slot = this._spawnSlots.get(propId);
    if (!slot) return;
    slot.classList.remove('is-flash');
    void slot.offsetWidth;
    slot.classList.add('is-flash');
    setTimeout(() => slot.classList.remove('is-flash'), 240);
  }

  showToast(message, type = 'info', duration = 2600) {
    const toast = document.createElement('div');
    toast.className = `oh-toast is-${type}`;
    toast.textContent = message;
    this.el.toastStack.appendChild(toast);

    // Keep toast stack compact
    while (this.el.toastStack.children.length > 4) {
      this.el.toastStack.firstElementChild?.remove();
    }

    setTimeout(() => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 320);
    }, duration);
  }

  showBiomeBanner(biomeName, subtitle = '') {
    this.el.biomeBannerTitle.textContent = biomeName;
    this.el.biomeBannerSub.textContent = subtitle || 'OCEAN HIMALAYAS';
    this.el.biomeBanner.classList.add('is-visible');

    if (this._biomeBannerTimer) {
      clearTimeout(this._biomeBannerTimer);
    }
    this._biomeBannerTimer = setTimeout(() => {
      this.el.biomeBanner.classList.remove('is-visible');
    }, 3400);
  }

  showError(title, detail) {
    this.el.errorTitle.textContent = title || '运行异常';
    this.el.errorDetail.textContent = typeof detail === 'string' ? detail : String(detail?.stack || detail?.message || detail);
    this.el.errorOverlay.classList.add('is-visible');
  }

  /**
   * Per-frame lightweight HUD update.
   */
  update(dt, playerState, ultrahandState, stats) {
    if (!playerState) return;

    this._biomeCooldown = Math.max(0, this._biomeCooldown - dt);

    // 1. Compass & Landmark Pins
    const headingRad = Number.isFinite(playerState.headingRad)
      ? playerState.headingRad
      : -(playerState.yaw || 0);
    const headingDeg = (headingRad * 180) / Math.PI;
    const px = playerState.position?.x ?? 0;
    const pz = playerState.position?.z ?? 0;

    // 2.6px per degree gives ~155 deg visible arc in 410px compass bar
    const pxPerDeg = 2.6;

    for (const mark of this._compassMarks) {
      const diff = wrapAngleDeg(mark.deg - headingDeg);
      const visible = Math.abs(diff) < 88;
      if (visible) {
        const x = diff * pxPerDeg;
        const alpha = Math.max(0, 1 - Math.abs(diff) / 86);
        mark.el.style.opacity = alpha.toFixed(2);
        mark.el.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0) translate(-50%, -50%)`;
      } else {
        mark.el.style.opacity = '0';
      }
    }

    for (const pin of this._compassPins) {
      const dx = pin.x - px;
      const dz = pin.z - pz;
      const dist = Math.hypot(dx, dz);
      // Bearing clockwise from North (-Z)
      const bearingDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
      const diff = wrapAngleDeg(bearingDeg - headingDeg);
      const visible = dist > 18 && Math.abs(diff) < 76;
      if (visible) {
        const x = diff * pxPerDeg;
        const alpha = Math.max(0, Math.min(0.95, 1 - Math.abs(diff) / 76));
        pin.el.style.opacity = alpha.toFixed(2);
        pin.el.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0) translate(-50%, -50%)`;
      } else {
        pin.el.style.opacity = '0';
      }
    }

    // 2. Altimeter & Biome Name
    const dispAlt = Number.isFinite(playerState.displayAltitude)
      ? Math.round(playerState.displayAltitude)
      : Math.round((playerState.altitude || 0) * WORLD_CONFIG.ALTITUDE_DISPLAY_SCALE);
    const clampedAlt = Math.max(0, dispAlt);
    const altText = `海拔 ${clampedAlt.toLocaleString()} m`;
    if (altText !== this._lastAltText) {
      this._lastAltText = altText;
      this.el.altValue.textContent = altText;
    }

    const biomeObj = playerState.biome;
    const biomeName = typeof biomeObj === 'string' ? biomeObj : (biomeObj?.name || '海中喜马拉雅');
    const biomeId = typeof biomeObj === 'string' ? biomeObj : (biomeObj?.id || biomeName);

    if (biomeName !== this._lastBiomeName) {
      this._lastBiomeName = biomeName;
      this.el.biomeLabel.textContent = biomeName;
    }

    if (biomeId !== this._lastBiomeId) {
      const isInitial = this._lastBiomeId === null;
      this._lastBiomeId = biomeId;
      if (!isInitial && !this._welcomeVisible && this._biomeCooldown <= 0) {
        this._biomeCooldown = 4.5;
        this.showBiomeBanner(biomeName, BIOME_SUBTITLES[biomeId] || 'OCEAN HIMALAYAS');
        this.callbacks.onBiomeChange?.(biomeId, biomeName);
      }
    }

    // Mode / Updraft badge
    let modeText = '';
    let isUpdraft = false;
    const mode = playerState.mode || '';
    if (playerState.inUpdraft) {
      modeText = '上升气流';
      isUpdraft = true;
    } else if (mode === 'glide' || mode === 'gliding' || mode === 'paragliding') {
      modeText = '滑翔伞';
    } else if (mode === 'climb' || mode === 'climbing') {
      modeText = '攀爬中';
    } else if (mode === 'swim' || mode === 'swimming') {
      modeText = '海湾畅游';
    }

    const modeKey = `${modeText}:${isUpdraft}`;
    if (modeKey !== this._lastModeKey) {
      this._lastModeKey = modeKey;
      this.el.modeBadge.textContent = modeText;
      this.el.modeBadge.classList.toggle('is-visible', Boolean(modeText));
      this.el.modeBadge.classList.toggle('is-updraft', isUpdraft);
    }

    // 3. BotW Circular Green Stamina Wheel
    const maxStamina = Math.max(1, playerState.maxStamina ?? 100);
    const stamina = Math.max(0, Math.min(maxStamina, playerState.stamina ?? maxStamina));
    const ratio = stamina / maxStamina;
    const offset = STAMINA_CIRCUMFERENCE * (1 - ratio);
    this.el.staminaArc.style.strokeDashoffset = offset.toFixed(2);

    const isRecovering = stamina > this._prevStamina + 0.05 && ratio < 0.995;
    this._prevStamina = stamina;

    const shouldHideStamina =
      ratio >= 0.995 &&
      playerState.isGrounded &&
      mode !== 'climb' &&
      mode !== 'climbing' &&
      mode !== 'swim' &&
      mode !== 'swimming';

    this.el.staminaWheel.classList.toggle('is-hidden', shouldHideStamina);
    this.el.staminaWheel.classList.toggle('is-warn', ratio < 0.35 && ratio >= 0.18);
    this.el.staminaWheel.classList.toggle('is-danger', ratio < 0.18);
    this.el.staminaWheel.classList.toggle('is-recovering', isRecovering && ratio >= 0.18);

    // 4. Center Crosshair & Ultrahand Context Prompt
    this._updateUltrahandPrompt(ultrahandState);

    // 5. Compact FPS / Physics body counter (throttled ~4Hz)
    this._statsAccum += dt;
    if (this._statsAccum >= 0.25 && stats) {
      this._statsAccum = 0;
      const fps = Math.round(stats.fps || 60);
      const props = stats.props ?? 0;
      const joints = stats.joints ?? 0;
      this.el.statsPill.textContent = `${fps} FPS · ${props} 物体 · ${joints} 粘合`;
    }
  }

  _updateUltrahandPrompt(u) {
    const aimedName = u?.aimedName || '';
    const heldName = u?.heldName || '';
    const canWeld = Boolean(u?.canWeld);
    const weldTargetName = u?.weldTargetName || '';
    const hasJoints = Boolean(u?.hasJoints);

    const promptKey = `${aimedName}|${heldName}|${canWeld}|${weldTargetName}|${hasJoints}`;
    if (promptKey === this._lastPromptKey) return;
    this._lastPromptKey = promptKey;

    const isHolding = Boolean(heldName);
    const isAiming = !isHolding && Boolean(aimedName);

    this.el.crosshair.classList.toggle('is-aim', isAiming);
    this.el.crosshair.classList.toggle('is-hold', isHolding);
    this.el.crosshair.classList.toggle('is-weld', isHolding && canWeld);

    if (isHolding) {
      const parts = [];
      if (canWeld && weldTargetName) {
        parts.push(`<span class="oh-prompt-item is-gold"><kbd class="oh-kbd">G</kbd> 粘合到 <strong>${weldTargetName}</strong></span>`);
      } else {
        parts.push(`<span class="oh-prompt-item"><kbd class="oh-kbd">E</kbd> 放下 <strong>${heldName}</strong></span>`);
      }
      parts.push(`<span class="oh-prompt-item"><kbd class="oh-kbd">Q/R</kbd> 旋转</span>`);
      parts.push(`<span class="oh-prompt-item"><kbd class="oh-kbd">左键</kbd> 投掷</span>`);
      parts.push(`<span class="oh-prompt-item"><kbd class="oh-kbd">滚轮</kbd> 距离</span>`);
      if (hasJoints) {
        parts.push(`<span class="oh-prompt-item"><kbd class="oh-kbd">X</kbd> 拆开</span>`);
      }
      if (canWeld && weldTargetName) {
        parts.push(`<span class="oh-prompt-item"><kbd class="oh-kbd">E</kbd> 放下</span>`);
      }

      this.el.contextPrompt.innerHTML = parts.join('');
      this.el.contextPrompt.classList.add('is-visible');
      this.el.contextPrompt.classList.toggle('is-weld', canWeld);
    } else if (isAiming) {
      const parts = [
        `<span class="oh-prompt-item"><kbd class="oh-kbd">E</kbd> 抓取 <strong>${aimedName}</strong></span>`,
      ];
      if (hasJoints) {
        parts.push(`<span class="oh-prompt-item"><kbd class="oh-kbd">X</kbd> 拆开粘合</span>`);
      }
      this.el.contextPrompt.innerHTML = parts.join('');
      this.el.contextPrompt.classList.add('is-visible');
      this.el.contextPrompt.classList.remove('is-weld');
    } else {
      this.el.contextPrompt.classList.remove('is-visible', 'is-weld');
    }
  }
}
