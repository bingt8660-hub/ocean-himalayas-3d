/**
 * Main Entry & Integrator for "海中喜马拉雅" (Ocean Himalayas 3D).
 * Coordinates Three.js renderer, OceanHimalayasWorld, Rapier3D PhysicsEngine,
 * UltrahandSystem, VRM HeroineCharacter, PlayerController, SoundEngine, and HUD.
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

const PROP_BY_KEY = new Map();
for (const prop of Object.values(PROP_CATALOG)) {
  PROP_BY_KEY.set(prop.key, prop);
  PROP_BY_KEY.set(`Digit${prop.key}`, prop);
}

async function boot() {
  const container = document.getElementById('app') || document.body;

  // --- Audio & HUD (initialized immediately so loading progress is visible) ---
  const sound = new SoundEngine();

  let world = null;
  let physics = null;
  let heroine = null;
  let player = null;
  let ultrahand = null;
  let renderer = null;
  let modelLoadToken = 0;

  // Reusable scratch vectors (zero per-frame allocations)
  const handPos = new THREE.Vector3();
  const camForward = new THREE.Vector3();
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

    const isHttpHosted = window.location.protocol.startsWith('http');
    const urls = isHttpHosted
      ? [model.url, model.cdnUrl].filter(Boolean)
      : [model.cdnUrl, model.url].filter(Boolean);

    let lastErr = null;
    for (const candidateUrl of urls) {
      try {
        await heroine.loadModel(candidateUrl);
        if (token !== modelLoadToken) return;
        hud.showToast(`角色已加载：${model.name}`, 'success', 2600);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    if (token !== modelLoadToken) return;
    console.warn('[OceanHimalayas] VRM model load warning:', lastErr);
    hud.showToast(`模型加载受限，使用备用角色形象`, 'warn', 2800);
  };

  const hud = new HUD(container, {
    onStart: () => {
      sound.unlock();
      sound.play('biome');
      document.activeElement?.blur?.();
      try {
        renderer?.domElement?.requestPointerLock?.();
      } catch {
        // Pointer lock is optional if browser blocks it
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

  try {
    hud.setLoadingProgress(12, '正在创建 WebGL 渲染引擎...');

    // --- Three.js Renderer, Scene & Camera ---
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.2,
      4500
    );

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // --- 1. World Generation (Ocean + Himalayas + Sky + Clouds + Waterfalls) ---
    hud.setLoadingProgress(30, '正在雕琢喜马拉雅雪山与珊瑚海湾...');
    world = new OceanHimalayasWorld(scene, renderer);
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

    ultrahand = new UltrahandSystem(physics, scene, camera);

    // --- 4. Input Bindings ---
    const keys = Object.create(null);

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
