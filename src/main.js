/**
 * Main Entry & Integrator for "海中喜马拉雅" (Ocean Himalayas 3D).
 * Coordinates Three.js renderer, OceanHimalayasWorld, Rapier3D PhysicsEngine,
 * UltrahandSystem, VRM HeroineCharacter, PlayerController, SoundEngine, TouchControls, and HUD.
 */

import * as THREE from 'three';
import './ui/styles.css';

import { CHARACTER_MODELS, PROP_CATALOG, TIME_PRESETS } from './config/worldConfig.js';
import { LANDMARKS, SPAWN_POINT } from './world/terrainMath.js';
import { OceanHimalayasWorld } from './world/OceanHimalayasWorld.js';
import { PhysicsEngine } from './physics/PhysicsEngine.js';
import { UltrahandSystem } from './physics/UltrahandSystem.js';
import { HeroineCharacter } from './character/HeroineCharacter.js';
import { PlayerController } from './character/PlayerController.js';
import { SoundEngine } from './audio/SoundEngine.js';
import { HUD } from './ui/HUD.js';
import { TouchControls, isTouchDevice } from './ui/TouchControls.js';

const PROP_BY_KEY = new Map();
for (const prop of Object.values(PROP_CATALOG)) {
  PROP_BY_KEY.set(prop.key, prop);
  PROP_BY_KEY.set(`Digit${prop.key}`, prop);
}

const QUALITY_LABELS = {
  low: '流畅 (省电)',
  medium: '均衡 (推荐)',
  high: '极致',
};

const PRESET_LABELS = {
  raft: '🛶 涡轮木筏',
  buggy: '🏎️ 越野车',
  rocket_sled: '🚀 火箭板',
};

async function boot() {
  const container = document.getElementById('app') || document.body;

  // --- Audio & HUD (initialized immediately so loading progress is visible) ---
  const sound = new SoundEngine();

  let world = null;
  let physics = null;
  let heroine = null;
  let player = null;
  let ultrahand = null;
  let touchControls = null;
  let renderer = null;
  let camera = null;
  let modelLoadToken = 0;
  let isContextLost = false;

  const isMobile = isTouchDevice();
  let currentQuality = isMobile ? 'medium' : 'high';
  let currentMaxDpr = isMobile ? 1.35 : 2.0;

  // Reusable scratch vectors (zero per-frame allocations)
  const handPos = new THREE.Vector3();
  const camForward = new THREE.Vector3();
  const flatForward = new THREE.Vector3();
  const spawnOrigin = new THREE.Vector3();
  const activatePos = new THREE.Vector3();

  const handleAudioEvent = (eventOrType, detail, position) => {
    if (typeof eventOrType === 'string') {
      if (typeof detail === 'number') {
        sound.play(eventOrType, { intensity: detail, position });
      } else {
        sound.play(eventOrType, detail);
      }
    } else if (eventOrType && typeof eventOrType === 'object') {
      sound.play(eventOrType.type || eventOrType.event, eventOrType);
    }
  };

  const getViewportSize = () => {
    const vv = window.visualViewport;
    const width = Math.max(1, Math.round(vv?.width || window.innerWidth || 1));
    const height = Math.max(1, Math.round(vv?.height || window.innerHeight || 1));
    return { width, height };
  };

  const handleResize = () => {
    if (!renderer || !camera) return;
    const { width, height } = getViewportSize();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, currentMaxDpr));
    renderer.setSize(width, height);
  };

  const applyQualityPreset = (preset, silent = false) => {
    const next = preset === 'low' || preset === 'medium' || preset === 'high' ? preset : 'medium';
    currentQuality = next;

    let shadowsEnabled = true;
    if (next === 'low') {
      currentMaxDpr = 1.0;
      shadowsEnabled = false;
    } else if (next === 'medium') {
      currentMaxDpr = isMobile ? 1.35 : 1.5;
      shadowsEnabled = true;
    } else {
      currentMaxDpr = isMobile ? 1.75 : 2.0;
      shadowsEnabled = true;
    }

    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, currentMaxDpr));
      renderer.shadowMap.enabled = shadowsEnabled;
      renderer.shadowMap.needsUpdate = true;
    }

    world?.setQualityPreset?.(next);
    hud.setQualityPreset?.(next);

    if (!silent) {
      hud.showToast(`画质切换：${QUALITY_LABELS[next] || next}`, 'info', 1600);
    }
  };

  const isDocumentFullscreen = () =>
    Boolean(document.fullscreenElement || document.webkitFullscreenElement);

  const toggleFullscreen = async () => {
    const docEl = document.documentElement;
    try {
      if (isDocumentFullscreen()) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      } else if (docEl.requestFullscreen) {
        await docEl.requestFullscreen({ navigationUI: 'hide' }).catch(() => docEl.requestFullscreen());
      } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
      } else {
        hud.showToast('当前浏览器不支持全屏，可添加到主屏幕体验全屏', 'warn', 2600);
        return;
      }
      setTimeout(handleResize, 120);
    } catch {
      hud.showToast('浏览器限制了全屏切换', 'warn', 2000);
    }
  };

  const spawnProp = (propId) => {
    if (!physics || !player) return;
    const prop = PROP_CATALOG[propId];
    if (!prop) return;

    const state = player.getState();
    const pos = state?.position;
    if (!pos) return;

    player.getCameraForward(camForward);
    if (camForward.lengthSq() < 1e-4) camForward.set(0, 0, -1);
    camForward.normalize();

    spawnOrigin.set(pos.x, pos.y + 1.35, pos.z);
    physics.spawnPropInFrontOf(prop.id, spawnOrigin, camForward);
    sound.play('spawn');
    hud.flashSpawnSlot(prop.id);
    hud.showToast(`已召唤：${prop.name}`, 'info', 1500);
  };

  const spawnPresetContraption = (presetId) => {
    if (!physics || !player) return;
    const state = player.getState();
    const pos = state?.position;
    if (!pos) return;

    player.getCameraForward(camForward);
    flatForward.set(camForward.x, 0, camForward.z);
    if (flatForward.lengthSq() < 1e-4) flatForward.set(0, 0, -1);
    flatForward.normalize();

    spawnOrigin.set(pos.x, pos.y + 1.25, pos.z);
    if (typeof physics.spawnPresetContraption === 'function') {
      physics.spawnPresetContraption(presetId, spawnOrigin, flatForward);
      sound.play('spawn');
      hud.showToast(`已召唤整车：${PRESET_LABELS[presetId] || presetId}`, 'success', 2000);
    } else {
      hud.showToast('当前版本暂未启用整车预设', 'warn', 1800);
    }
  };

  const toggleNearbyContraptions = () => {
    if (!physics || !player) return;
    const state = player.getState();
    const pos = state?.position;
    if (!pos) return;

    activatePos.set(pos.x, pos.y + 1.0, pos.z);
    const result = physics.toggleActivateNearby(activatePos, 20);
    if (typeof result === 'number' && result === 0) {
      hud.showToast('附近暂无可启动的风扇、动力轮、火箭或火药桶', 'warn', 2000);
    } else {
      hud.showToast('已切换附近机关状态', 'success', 1600);
    }
  };

  const loadCharacterModel = async (model) => {
    if (!heroine || !model) return;
    const token = ++modelLoadToken;
    hud.setActiveCharacter(model.id);
    hud.setModelLoading?.(null, `加载 ${model.name}`);

    const isHttpHosted = window.location.protocol.startsWith('http');
    const urls = isHttpHosted
      ? [model.url, model.cdnUrl].filter(Boolean)
      : [model.cdnUrl, model.url].filter(Boolean);

    const onProgress = (pct) => {
      if (token !== modelLoadToken) return;
      hud.setModelLoading?.(pct, `加载 ${model.name}`);
    };

    let lastErr = null;
    for (const candidateUrl of urls) {
      try {
        await heroine.loadModel?.(candidateUrl, onProgress);
        if (token !== modelLoadToken) return;
        hud.setModelLoading?.(100, `角色已就绪`);
        hud.showToast(`角色已加载：${model.name}`, 'success', 2400);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    if (token !== modelLoadToken) return;
    hud.setModelLoading?.(false);
    console.warn('[OceanHimalayas] VRM model load warning:', lastErr);
    hud.showToast('模型加载受限，使用备用角色形象', 'warn', 2800);
  };

  const hud = new HUD(container, {
    onStart: () => {
      sound.unlock();
      sound.play('biome');
      document.activeElement?.blur?.();
      if (!isMobile && !touchControls?.enabled) {
        try {
          renderer?.domElement?.requestPointerLock?.();
        } catch {
          // Pointer lock is optional if browser blocks it
        }
      }
      hud.showBiomeBanner('珊瑚海湾沙滩', 'CORAL BAY SHORELINE');
    },
    onTimePreset: (presetId) => {
      sound.unlock();
      document.activeElement?.blur?.();
      if (world && TIME_PRESETS[presetId]) {
        world.setTimePreset(presetId);
        hud.showToast(`天色切换：${TIME_PRESETS[presetId].label}`, 'info', 1800);
      }
    },
    onQualityChange: (presetId) => {
      sound.unlock();
      document.activeElement?.blur?.();
      applyQualityPreset(presetId);
    },
    onSensitivityChange: (mult) => {
      player?.setTouchSensitivity?.(mult);
    },
    onToggleFullscreen: () => {
      sound.unlock();
      document.activeElement?.blur?.();
      toggleFullscreen();
    },
    onTeleport: (landmarkId) => {
      sound.unlock();
      document.activeElement?.blur?.();
      const lm = LANDMARKS[landmarkId];
      if (player && lm) {
        if (ultrahand?.heldProp) {
          player.getRightHandWorldPos(handPos);
          ultrahand.tryGrabOrRelease(handPos);
        }
        player.teleportTo(lm);
        sound.play('teleport');
        hud.showToast(`已传送至：${lm.name}`, 'success', 2200);
      }
    },
    onSwitchCharacter: (model) => {
      sound.unlock();
      document.activeElement?.blur?.();
      loadCharacterModel(model);
    },
    onToggleTouch: () => {
      sound.unlock();
      document.activeElement?.blur?.();
      if (!touchControls) return false;
      const active = touchControls.toggle();
      hud.showToast(active ? '已开启手机虚拟按键' : '已关闭虚拟按键', 'info', 1500);
      return active;
    },
    onToggleMute: () => {
      sound.unlock();
      document.activeElement?.blur?.();
      sound.setMuted(!sound.isMuted);
      hud.showToast(sound.isMuted ? '已静音' : '已开启环境音与音效', 'info', 1400);
      return sound.isMuted;
    },
    onSpawnProp: (propId) => {
      sound.unlock();
      document.activeElement?.blur?.();
      spawnProp(propId);
    },
    onToggleActivate: () => {
      sound.unlock();
      document.activeElement?.blur?.();
      toggleNearbyContraptions();
    },
    onBiomeChange: () => {
      sound.play('biome');
    },
  });

  // Sync fullscreen icon state cleanly
  const syncFullscreenUI = () => {
    hud.setFullscreenState?.(isDocumentFullscreen());
    setTimeout(handleResize, 80);
  };
  document.addEventListener('fullscreenchange', syncFullscreenUI);
  document.addEventListener('webkitfullscreenchange', syncFullscreenUI);

  try {
    hud.setLoadingProgress(12, '正在创建 WebGL 渲染引擎...');

    // --- Three.js Renderer, Scene & Camera ---
    const initialSize = getViewportSize();
    renderer = new THREE.WebGLRenderer({
      antialias: !isMobile,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, currentMaxDpr));
    renderer.setSize(initialSize.width, initialSize.height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Graceful WebGL context loss / restore handling for mobile tab switching
    renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      isContextLost = true;
      hud.showToast('3D 画面已暂挂，返回后自动恢复', 'warn', 4000);
    });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      isContextLost = false;
      handleResize();
      applyQualityPreset(currentQuality, true);
      hud.showToast('3D 画面已恢复', 'success', 2000);
    });

    const scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(
      60,
      initialSize.width / initialSize.height,
      0.2,
      4500
    );

    // Dynamic viewport resize + phone rotation listeners (iOS Safari & Android Chrome)
    window.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', () => {
      handleResize();
      setTimeout(handleResize, 120);
      setTimeout(handleResize, 360);
    });

    // --- 1. World Generation (Ocean + Himalayas + Sky + Clouds + Waterfalls) ---
    hud.setLoadingProgress(30, '正在雕琢喜马拉雅雪山与珊瑚海湾...');
    world = new OceanHimalayasWorld(scene, renderer);
    applyQualityPreset(currentQuality, true);
    world.setTimePreset('golden');
    hud.setActiveTimePreset('golden');

    // --- 2. Rapier3D Physics Engine ---
    hud.setLoadingProgress(58, '正在初始化 Rapier3D 物理世界与流体浮力...');
    physics = new PhysicsEngine();
    await physics.init(world.heightfieldData, scene);
    physics.onSoundEvent(handleAudioEvent);

    // --- 3. Character, PlayerController & Ultrahand ---
    hud.setLoadingProgress(84, '正在装配滑翔伞与究极手系统...');
    heroine = new HeroineCharacter(scene);
    player = new PlayerController(physics, heroine, camera, renderer.domElement);
    player.onAudioEvent(handleAudioEvent);
    player.teleportTo(SPAWN_POINT);
    hud.setSensitivity?.(player.touchSensitivityMult ?? 1.0);

    ultrahand = new UltrahandSystem(physics, scene, camera);

    // --- 4. Input Bindings (Keyboard + Mobile Virtual Touch Controls) ---
    const keys = Object.create(null);

    touchControls = new TouchControls(container, renderer.domElement, keys, {
      onInteract: () => sound.unlock(),
      onAutoEnable: () => hud.setTouchActive(true),
      onCanvasTap: () => hud.closeMobileSheets?.(),
      onLookDelta: (dx, dy) => player.applyLookDelta(dx, dy),
      onPinchZoom: (delta) => {
        if (ultrahand.heldProp) {
          ultrahand.adjustDistance(-delta * 0.8);
        } else {
          player.applyZoomDelta(delta);
        }
      },
      onGrabOrRelease: () => {
        const wasHeld = Boolean(ultrahand.heldProp);
        player.getRightHandWorldPos(handPos);
        ultrahand.tryGrabOrRelease(handPos);
        const nowHeld = Boolean(ultrahand.heldProp);
        if (!wasHeld && nowHeld) sound.play('grab');
        else if (wasHeld && !nowHeld) sound.play('release');
      },
      onWeld: () => {
        const beforeJoints = physics.getPropCount()?.joints ?? 0;
        const welded = ultrahand.tryWeld();
        const afterJoints = physics.getPropCount()?.joints ?? 0;
        if (welded || afterJoints > beforeJoints) {
          sound.play('weld');
          hud.showToast('究极手粘合成功', 'success', 1600);
        }
      },
      onLevelHeld: () => {
        if (ultrahand?.heldProp) {
          ultrahand?.levelHeld?.();
          sound.play('grab');
          hud.showToast('已水平摆正部件', 'info', 1200);
        }
      },
      onUnweld: () => {
        const beforeJoints = physics.getPropCount()?.joints ?? 0;
        const unwelded = ultrahand.tryUnweld();
        const afterJoints = physics.getPropCount()?.joints ?? 0;
        if (unwelded || afterJoints < beforeJoints) {
          sound.play('unweld');
          hud.showToast('已拆开粘合连接', 'info', 1500);
        }
      },
      onRotate: (axis, dir) => ultrahand.rotateHeld(axis, dir),
      onThrow: () => {
        if (ultrahand.heldProp) {
          ultrahand.throwHeld();
          sound.play('throw');
        }
      },
      onAdjustDistance: (delta) => ultrahand.adjustDistance(delta),
      onToggleActivate: () => toggleNearbyContraptions(),
      onSpawnProp: (propId) => spawnProp(propId),
      onSpawnPreset: (presetId) => spawnPresetContraption(presetId),
    });
    hud.setTouchActive(touchControls.enabled);
    hud.setMuted(sound.isMuted);
    hud.setFullscreenState?.(isDocumentFullscreen());

    const setKeyState = (e, pressed) => {
      keys[e.code] = pressed;
      if (e.key) {
        keys[e.key.toLowerCase()] = pressed;
      }
    };

    window.addEventListener('keydown', (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      sound.unlock();
      setKeyState(e, true);

      // Prevent Space from scrolling or re-clicking a focused HUD button
      if (e.code === 'Space' && !hud.isWelcomeVisible()) {
        e.preventDefault();
      }

      // Allow dismissing welcome overlay with Enter or Space once ready
      if (hud.isWelcomeVisible()) {
        if (e.code === 'Enter' || e.code === 'Space') {
          hud.el.startBtn?.click();
        }
        return;
      }

      // Q / R: rotate held Ultrahand object (supports holding key to continue rotating)
      if (e.code === 'KeyQ' && ultrahand.heldProp) {
        ultrahand.rotateHeld('y', e.shiftKey ? -1 : 1);
        return;
      }
      if (e.code === 'KeyR' && ultrahand.heldProp) {
        ultrahand.rotateHeld('x', e.shiftKey ? -1 : 1);
        return;
      }

      if (e.repeat) return;

      switch (e.code) {
        case 'KeyE': {
          const wasHeld = Boolean(ultrahand.heldProp);
          player.getRightHandWorldPos(handPos);
          ultrahand.tryGrabOrRelease(handPos);
          const nowHeld = Boolean(ultrahand.heldProp);
          if (!wasHeld && nowHeld) {
            sound.play('grab');
          } else if (wasHeld && !nowHeld) {
            sound.play('release');
          }
          break;
        }
        case 'KeyG': {
          const beforeJoints = physics.getPropCount()?.joints ?? 0;
          const welded = ultrahand.tryWeld();
          const afterJoints = physics.getPropCount()?.joints ?? 0;
          if (welded || afterJoints > beforeJoints) {
            sound.play('weld');
            hud.showToast('究极手粘合成功', 'success', 1600);
          }
          break;
        }
        case 'KeyX': {
          const beforeJoints = physics.getPropCount()?.joints ?? 0;
          const unwelded = ultrahand.tryUnweld();
          const afterJoints = physics.getPropCount()?.joints ?? 0;
          if (unwelded || afterJoints < beforeJoints) {
            sound.play('unweld');
            hud.showToast('已拆开粘合连接', 'info', 1500);
          }
          break;
        }
        case 'KeyT': {
          toggleNearbyContraptions();
          break;
        }
        case 'KeyH': {
          hud.toggleHelp();
          break;
        }
        case 'KeyM': {
          sound.setMuted(!sound.isMuted);
          hud.setMuted(sound.isMuted);
          hud.showToast(sound.isMuted ? '已静音' : '已开启音效', 'info', 1400);
          break;
        }
        default: {
          // 1-7 Quick Spawn Props
          const prop = PROP_BY_KEY.get(e.code) || PROP_BY_KEY.get(e.key);
          if (prop) {
            spawnProp(prop.id);
          }
          break;
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      setKeyState(e, false);
    });

    window.addEventListener('blur', () => {
      for (const k of Object.keys(keys)) {
        keys[k] = false;
      }
    });

    // Mouse Wheel: adjust Ultrahand hold distance when holding, else let PlayerController zoom camera
    window.addEventListener(
      'wheel',
      (e) => {
        if (hud.isWelcomeVisible()) return;
        if (ultrahand && ultrahand.heldProp) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          const delta = -Math.sign(e.deltaY) * 0.75;
          ultrahand.adjustDistance(delta);
        }
      },
      { passive: false, capture: true }
    );

    // Left Click: throw held Ultrahand object when interacting with viewport
    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || hud.isWelcomeVisible()) return;
      const onCanvas =
        document.pointerLockElement === renderer.domElement ||
        e.target === renderer.domElement;
      if (!onCanvas) return;

      sound.unlock();
      if (ultrahand && ultrahand.heldProp) {
        ultrahand.throwHeld();
        sound.play('throw');
      }
    });

    // --- 5. Ready! Start live render loop immediately & load VRM asynchronously ---
    hud.setLoadingProgress(100, '准备就绪');
    hud.setReady();

    // Non-blocking async load of default VRM character
    loadCharacterModel(CHARACTER_MODELS[0]);

    const getWaveHeight = (x, z, t) => world.getWaveHeight(x, z, t);

    let lastTime = performance.now();
    let elapsedTime = 0;
    let smoothedFps = 60;

    const animate = (now) => {
      requestAnimationFrame(animate);

      const rawDt = (now - lastTime) * 0.001;
      lastTime = now;
      const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
      elapsedTime += dt;

      if (rawDt > 0.0001) {
        const instFps = 1 / rawDt;
        smoothedFps = smoothedFps * 0.9 + Math.min(240, instFps) * 0.1;
      }

      if (isContextLost) return;

      const isUltrahandActive = Boolean(ultrahand.heldProp);

      // Step physics, character, ultrahand, and world visuals
      physics.step(dt, elapsedTime, getWaveHeight);
      player.update(dt, elapsedTime, keys, isUltrahandActive);

      player.getRightHandWorldPos(handPos);
      ultrahand.update(dt, handPos, camera);

      world.update(dt, elapsedTime, camera.position);

      // Gather state for Audio & HUD
      const playerState = player.getState();
      const ultrahandState = ultrahand.getHudState();
      const counts = physics.getPropCount() || { props: 0, joints: 0 };

      // Compute reliable compass heading from camera forward (0 = North -Z, +PI/2 = East +X)
      player.getCameraForward(camForward);
      const headingRad =
        camForward.lengthSq() > 1e-4
          ? Math.atan2(camForward.x, -camForward.z)
          : -(playerState?.yaw || 0);

      if (playerState) {
        sound.updateAmbience(
          playerState.altitude ?? 0,
          playerState.speed ?? 0,
          playerState.mode ?? 'idle',
          Boolean(playerState.inUpdraft)
        );
        hud.update(
          dt,
          { ...playerState, headingRad },
          ultrahandState,
          {
            fps: smoothedFps,
            props: counts.props,
            joints: counts.joints,
          }
        );
        touchControls?.update(playerState, ultrahandState);
      }

      renderer.render(scene, camera);
    };

    requestAnimationFrame(animate);
  } catch (err) {
    console.error('[OceanHimalayas] Fatal initialization error:', err);
    hud.showError('海中喜马拉雅启动失败', err);
  }
}

boot();
