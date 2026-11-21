/**
 * Physics-Driven Player Controller & Third-Person Orbit Camera for "海中喜马拉雅".
 * Handles Rapier3D dynamic capsule locomotion, moving-platform (raft/vehicle) velocity
 * inheritance, BotW-style Paragliding with Himalayan Updraft soaring, Ocean Swimming,
 * Cliff Climbing, Stamina, Camera Collision Avoidance, and Pointer-Lock + Drag orbit.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD_CONFIG } from '../config/worldConfig.js';
import {
  SPAWN_POINT,
  UPDRAFTS,
  getTerrainHeight,
  getBiomeInfo,
} from '../world/terrainMath.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function damp(current, target, lambda, dt) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

function shortestAngleDiff(from, to) {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

function isKeyPressed(keys, codes) {
  if (!keys) return false;
  if (keys instanceof Set) {
    for (let i = 0; i < codes.length; i++) {
      if (keys.has(codes[i])) return true;
    }
    return false;
  }
  for (let i = 0; i < codes.length; i++) {
    if (keys[codes[i]]) return true;
  }
  return false;
}

export class PlayerController {
  constructor(physicsEngine, heroine, camera, domElement) {
    this.physics = physicsEngine;
    this.RAPIER = physicsEngine?.RAPIER || RAPIER;
    this.world = physicsEngine?.world;
    this.heroine = heroine;
    this.camera = camera;
    this.domElement = domElement;

    // Capsule dimensions: halfHeight=0.46, radius=0.34 -> total height ~1.60m, feet at bodyY - 0.80
    this.capsuleHalfHeight = 0.46;
    this.capsuleRadius = 0.34;
    this.feetOffset = this.capsuleHalfHeight + this.capsuleRadius; // 0.80m

    // Create Rapier dynamic capsule rigidbody
    const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(SPAWN_POINT.x, SPAWN_POINT.y, SPAWN_POINT.z)
      .lockRotations()
      .setCcdEnabled(true)
      .setLinearDamping(0.05);

    this.body = this.world.createRigidBody(bodyDesc);
    this.rigidBody = this.body; // convenient alias

    const colliderDesc = this.RAPIER.ColliderDesc.capsule(
      this.capsuleHalfHeight,
      this.capsuleRadius
    )
      .setFriction(0.0)
      .setRestitution(0.0)
      .setMass(62);

    this.collider = this.world.createCollider(colliderDesc, this.body);

    // Movement & traversal state
    this.mode = 'idle'; // 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'glide' | 'swim' | 'climb'
    this.maxStamina = 100;
    this.stamina = 100;
    this._staminaRegenDelay = 0;
    this._exhausted = false;

    this.isGrounded = false;
    this.inUpdraft = false;
    this._coyoteTimer = 0;
    this._jumpBufferTimer = 0;
    this._heightAboveGround = 0;
    this._groundNormal = new THREE.Vector3(0, 1, 0);
    this._platformVel = new THREE.Vector3();
    this._wasInWater = false;

    // Climbing state
    this._climbNormal = new THREE.Vector3(0, 0, 1);
    this._climbStepDist = 0;
    this._climbCooldown = 0;

    // Edge-triggered key memory
    this._prevSpaceDown = false;
    this._prevClimbKeyDown = false;

    // Facing & locomotion audio accumulators
    this.facingHeading = 0;
    this._turnRate = 0;
    this._stepDistance = 0;
    this._swimStrokeTimer = 0;
    this._horizontalSpeed = 0;

    // Camera orbit state
    this.yaw = 0;
    this.pitch = 0.14;
    this.minPitch = -0.62;
    this.maxPitch = 1.18;
    this.cameraDistance = 6.5;
    this.minCameraDistance = 4.0;
    this.maxCameraDistance = 14.0;
    this.currentCamDistance = 6.5;
    this.mouseSensitivity = 0.0024;
    this.dragSensitivity = 0.0042;
    this.isPointerLocked = false;
    this._isUltrahandActive = false;

    // Drag fallback state (works cleanly inside sandboxed iframes without pointer lock)
    this._isDragging = false;
    this._dragButton = -1;
    this._dragMoved = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._lastMouseX = 0;
    this._lastMouseY = 0;

    // Audio event listeners & optional custom wheel callback
    this._audioListeners = [];
    this._wheelCallback = null;

    // Reusable scratch vectors (zero per-frame allocations)
    this._camPivot = new THREE.Vector3();
    this._camDesired = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    this._moveDir = new THREE.Vector3();
    this._camForwardXZ = new THREE.Vector3();
    this._camRightXZ = new THREE.Vector3();
    this._wallRight = new THREE.Vector3();
    this._wallUp = new THREE.Vector3();
    this._tmpPos = new THREE.Vector3();
    this._tmpVel = new THREE.Vector3();

    // Initialize orientation looking from SPAWN_POINT toward SPAWN_POINT.lookAt
    this._aimAt(SPAWN_POINT, SPAWN_POINT.lookAt);

    // Sync initial character visual & camera immediately
    this._syncVisualAndCamera(0.016, false, 0);

    // Bind pointer lock, mouse drag, and zoom controls
    this._bindInputEvents();
  }

  /** Register audio callback: (eventName, detail) */
  onAudioEvent(cb) {
    if (typeof cb === 'function') {
      this._audioListeners.push(cb);
    }
  }

  /** Optional hook if external code wants to intercept wheel events */
  setWheelHandler(cb) {
    this._wheelCallback = typeof cb === 'function' ? cb : null;
  }

  _emitAudio(eventName, detail = {}) {
    for (let i = 0; i < this._audioListeners.length; i++) {
      try {
        this._audioListeners[i](eventName, detail);
      } catch (_) {
        // Keep physics loop isolated from audio callback issues
      }
    }
  }

  _bindInputEvents() {
    this._onPointerLockChange = () => {
      this.isPointerLocked = document.pointerLockElement === this.domElement;
      if (this.isPointerLocked) {
        this._isDragging = false;
      }
    };

    this._onMouseDown = (e) => {
      if (e.target !== this.domElement) return;
      // Right-drag (2), middle-drag (1), or left-drag (0, when not holding Ultrahand prop)
      if (e.button === 2 || e.button === 1 || (e.button === 0 && !this.isPointerLocked && !this._isUltrahandActive)) {
        this._isDragging = true;
        this._dragButton = e.button;
        this._dragMoved = false;
        this._dragStartX = e.clientX;
        this._dragStartY = e.clientY;
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
      }
    };

    this._onMouseMove = (e) => {
      if (this.isPointerLocked) {
        const dx = clamp(e.movementX || 0, -120, 120);
        const dy = clamp(e.movementY || 0, -120, 120);
        this.yaw -= dx * this.mouseSensitivity;
        this.pitch = clamp(this.pitch + dy * this.mouseSensitivity, this.minPitch, this.maxPitch);
      } else if (this._isDragging) {
        const dx = e.clientX - this._lastMouseX;
        const dy = e.clientY - this._lastMouseY;
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;

        if (!this._dragMoved && Math.hypot(e.clientX - this._dragStartX, e.clientY - this._dragStartY) > 5) {
          this._dragMoved = true;
        }
        this.yaw -= dx * this.dragSensitivity;
        this.pitch = clamp(this.pitch + dy * this.dragSensitivity, this.minPitch, this.maxPitch);
      }
    };

    this._onMouseUp = (e) => {
      if (!this._isDragging) return;
      const wasShortLeftClick =
        this._dragButton === 0 &&
        !this._dragMoved &&
        !this.isPointerLocked &&
        !this._isUltrahandActive &&
        e.target === this.domElement;

      this._isDragging = false;
      this._dragButton = -1;

      if (wasShortLeftClick && this.domElement?.requestPointerLock) {
        try {
          const maybePromise = this.domElement.requestPointerLock();
          if (maybePromise && typeof maybePromise.catch === 'function') {
            maybePromise.catch(() => {});
          }
        } catch {
          // Safe fallback to drag-orbit when pointer lock is unavailable
        }
      }
    };

    this._onWheel = (e) => {
      if (this._wheelCallback && this._wheelCallback(e) === true) return;
      if (this._isUltrahandActive || e.defaultPrevented) return;
      const zoomStep = Math.sign(e.deltaY) * 0.65;
      this.cameraDistance = clamp(
        this.cameraDistance + zoomStep,
        this.minCameraDistance,
        this.maxCameraDistance
      );
    };

    this._onContextMenu = (e) => {
      if (e.target === this.domElement) {
        e.preventDefault();
      }
    };

    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    this.domElement.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    this.domElement.addEventListener('wheel', this._onWheel, { passive: true });
    this.domElement.addEventListener('contextmenu', this._onContextMenu);
  }

  /** Smooth external camera rotation (used by mobile touch-look) */
  applyLookDelta(dx, dy) {
    const sens = this.dragSensitivity * 1.15;
    this.yaw -= clamp(dx, -140, 140) * sens;
    this.pitch = clamp(this.pitch + clamp(dy, -140, 140) * sens, this.minPitch, this.maxPitch);
  }

  /** Smooth external camera zoom (used by mobile two-finger pinch) */
  applyZoomDelta(delta) {
    this.cameraDistance = clamp(
      this.cameraDistance + delta,
      this.minCameraDistance,
      this.maxCameraDistance
    );
  }

  /**
   * Computes camera yaw/pitch and heroine facing from origin toward a target point.
   */
  _aimAt(from, lookAt) {
    if (!from || !lookAt) return;
    const dx = lookAt.x - from.x;
    const dy = lookAt.y - (from.y + 1.4);
    const dz = lookAt.z - from.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz < 1e-4) return;

    // Camera forward XZ = (-sin(yaw), -cos(yaw)) -> align with (dx, dz)
    this.yaw = Math.atan2(-dx, -dz);
    // Negative pitch aims camera upward toward towering Himalayan peaks
    const lookPitch = -Math.atan2(dy, horiz);
    this.pitch = clamp(lookPitch * 0.55 + 0.08, -0.22, 0.36);

    // Heroine local +Z = (sin(heading), cos(heading)) -> face toward lookAt
    this.facingHeading = Math.atan2(dx, dz);
  }

  /**
   * Teleports player cleanly to a landmark, resets velocity & traversal states,
   * and aims camera toward landmark.lookAt if provided.
   */
  teleportTo(landmark) {
    if (!landmark) return;
    const tx = landmark.x ?? SPAWN_POINT.x;
    const ty = (landmark.y ?? SPAWN_POINT.y) + 0.35;
    const tz = landmark.z ?? SPAWN_POINT.z;

    this.body.setTranslation({ x: tx, y: ty, z: tz }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.wakeUp?.();

    this.mode = 'idle';
    this.inUpdraft = false;
    this.isGrounded = false;
    this._wasInWater = ty < WORLD_CONFIG.SEA_LEVEL - 0.35;
    this.stamina = this.maxStamina;
    this._exhausted = false;
    this._staminaRegenDelay = 0;
    this._coyoteTimer = 0;
    this._jumpBufferTimer = 0;
    this._climbCooldown = 0;
    this.currentCamDistance = this.cameraDistance;

    if (landmark.lookAt) {
      this._aimAt({ x: tx, y: ty, z: tz }, landmark.lookAt);
    }

    this._syncVisualAndCamera(0.016, this._isUltrahandActive, 0);
  }

  /**
   * Writes the normalized 3D camera forward direction into targetVec.
   */
  getCameraForward(targetVec = new THREE.Vector3()) {
    const cosPitch = Math.cos(this.pitch);
    targetVec.set(
      -Math.sin(this.yaw) * cosPitch,
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * cosPitch
    );
    return targetVec.normalize();
  }

  /**
   * Delegates to HeroineCharacter for Ultrahand energy beam anchoring.
   */
  getRightHandWorldPos(targetVec = new THREE.Vector3()) {
    return this.heroine.getRightHandWorldPos(targetVec);
  }

  /**
   * Casts a Rapier ray excluding the player's own collider and rigidbody.
   */
  _castWorldRay(ox, oy, oz, dx, dy, dz, maxToi) {
    const ray = new this.RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    return this.world.castRayAndGetNormal(
      ray,
      maxToi,
      true,
      undefined,
      undefined,
      this.collider,
      this.body
    );
  }

  /**
   * Multi-sample downward ground detection + moving dynamic platform velocity inheritance.
   */
  _probeGround(pos, vel) {
    const rayStartOffset = 0.35; // Start safely inside lower capsule
    const feetBelowRay = this.feetOffset - rayStartOffset; // 0.45m
    const probeMax = 14.0;

    // Center ray first, then 4 perimeter rays so ledges & wooden raft planks feel rock-solid
    const offsets = [
      [0, 0],
      [0.21, 0],
      [-0.21, 0],
      [0, 0.21],
      [0, -0.21],
    ];

    let bestHit = null;
    let bestToi = Infinity;

    for (let i = 0; i < offsets.length; i++) {
      const [ox, oz] = offsets[i];
      const maxDist = i === 0 ? probeMax : 0.72;
      const hit = this._castWorldRay(
        pos.x + ox,
        pos.y - rayStartOffset,
        pos.z + oz,
        0,
        -1,
        0,
        maxDist
      );
      if (hit && hit.timeOfImpact < bestToi) {
        bestToi = hit.timeOfImpact;
        bestHit = hit;
        if (i === 0 && hit.timeOfImpact - feetBelowRay <= 0.14) {
          break; // Clean center contact
        }
      }
    }

    this._platformVel.set(0, 0, 0);

    if (bestHit) {
      const distToFeet = bestToi - feetBelowRay;
      this._heightAboveGround = Math.max(0, distToFeet);
      const ny = bestHit.normal ? bestHit.normal.y : 1.0;

      if (distToFeet <= 0.16 && vel.y <= 3.8 && ny >= 0.42) {
        this.isGrounded = true;
        if (bestHit.normal) {
          this._groundNormal.set(bestHit.normal.x, bestHit.normal.y, bestHit.normal.z).normalize();
        } else {
          this._groundNormal.set(0, 1, 0);
        }

        // Inherit horizontal velocity of dynamic physics props (rafts, buggies, sky ships!)
        const parentBody = bestHit.collider?.parent?.();
        if (parentBody && parentBody.isDynamic()) {
          const pv = parentBody.linvel();
          const pav = parentBody.angvel();
          const pt = parentBody.translation();
          // Contact point relative to platform COM: v = linvel + angvel x r
          const rx = pos.x - pt.x;
          const ry = pos.y - this.feetOffset - pt.y;
          const rz = pos.z - pt.z;
          const vx = pv.x + (pav.y * rz - pav.z * ry);
          const vz = pv.z + (pav.x * ry - pav.y * rx);
          this._platformVel.set(
            clamp(vx, -32, 32),
            clamp(pv.y, -15, 15),
            clamp(vz, -32, 32)
          );
        }
        return;
      }
    } else {
      const terrainY = getTerrainHeight(pos.x, pos.z);
      const refFloor = Math.max(WORLD_CONFIG.SEA_LEVEL, terrainY);
      this._heightAboveGround = Math.max(0, pos.y - this.feetOffset - refFloor);
    }

    this.isGrounded = false;
    this._groundNormal.set(0, 1, 0);
  }

  /**
   * Probes forward for a climbable steep cliff/rock surface.
   */
  _probeClimbWall(pos, dirX, dirZ, maxDist = 1.25) {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-4) return null;
    const nx = dirX / len;
    const nz = dirZ / len;

    // Check chest height and slightly lower waist height
    const hitChest = this._castWorldRay(pos.x, pos.y + 0.18, pos.z, nx, 0, nz, maxDist);
    const hitWaist = hitChest || this._castWorldRay(pos.x, pos.y - 0.15, pos.z, nx, 0, nz, maxDist);
    if (!hitWaist || !hitWaist.normal) return null;

    // Must be steep enough to climb (not a flat floor or ceiling)
    if (Math.abs(hitWaist.normal.y) > 0.68) return null;

    // Avoid climbing tiny dynamic props
    const parentBody = hitWaist.collider?.parent?.();
    if (parentBody && parentBody.isDynamic()) return null;

    return hitWaist;
  }

  /**
   * Checks whether player is inside any Himalayan thermal updraft cylinder.
   */
  _sampleUpdraft(pos) {
    let bestLift = 0;
    for (let i = 0; i < UPDRAFTS.length; i++) {
      const u = UPDRAFTS[i];
      if (pos.y < u.baseY - 4 || pos.y > u.topY + 4) continue;
      const distSq = (pos.x - u.x) * (pos.x - u.x) + (pos.z - u.z) * (pos.z - u.z);
      if (distSq <= u.radius * u.radius) {
        const radialFade = 1.0 - 0.35 * (Math.sqrt(distSq) / u.radius);
        const topFade = clamp((u.topY + 4 - pos.y) / 14.0, 0.15, 1.0);
        const lift = u.strength * radialFade * topFade;
        if (lift > bestLift) bestLift = lift;
      }
    }
    return bestLift;
  }

  /**
   * Drains stamina smoothly and enforces brief recovery delay.
   */
  _drainStamina(amount) {
    this.stamina = Math.max(0, this.stamina - amount);
    this._staminaRegenDelay = 0.45;
    if (this.stamina <= 0.1) {
      this._exhausted = true;
    }
  }

  /**
   * Main per-frame controller update.
   */
  update(dt, elapsedTime, keys, isUltrahandActive = false) {
    const safeDt = clamp(dt || 0.016, 0.001, 0.05);
    this._isUltrahandActive = Boolean(isUltrahandActive);
    if (this._climbCooldown > 0) this._climbCooldown -= safeDt;

    // Read current Rapier rigidbody state
    const t = this.body.translation();
    const v = this.body.linvel();
    const pos = this._tmpPos.set(t.x, t.y, t.z);
    const vel = this._tmpVel.set(v.x, v.y, v.z);

    // Safety rescue if somehow pushed out of map abyss
    if (pos.y < -45) {
      const safeY = Math.max(WORLD_CONFIG.SEA_LEVEL + 2, getTerrainHeight(pos.x, pos.z) + 2);
      this.body.setTranslation({ x: pos.x, y: safeY, z: pos.z }, true);
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      pos.y = safeY;
      vel.set(0, 0, 0);
    }

    // Read movement & action inputs (keyboard + mobile analog joystick)
    const keyFwd =
      (isKeyPressed(keys, ['KeyW', 'w', 'ArrowUp']) ? 1 : 0) -
      (isKeyPressed(keys, ['KeyS', 's', 'ArrowDown']) ? 1 : 0);
    const keyRight =
      (isKeyPressed(keys, ['KeyD', 'd', 'ArrowRight']) ? 1 : 0) -
      (isKeyPressed(keys, ['KeyA', 'a', 'ArrowLeft']) ? 1 : 0);
    const analogFwd = typeof keys?._analogFwd === 'number' ? keys._analogFwd : 0;
    const analogRight = typeof keys?._analogRight === 'number' ? keys._analogRight : 0;

    const fwdIn = clamp(keyFwd + analogFwd, -1, 1);
    const rightIn = clamp(keyRight + analogRight, -1, 1);
    const sprintDown =
      isKeyPressed(keys, ['ShiftLeft', 'ShiftRight', 'shift']) || Boolean(keys?._touchSprint);
    const spaceDown = isKeyPressed(keys, ['Space', ' ']) || Boolean(keys?._touchSpace);
    const climbKeyDown = isKeyPressed(keys, ['KeyC', 'c']) || Boolean(keys?._touchClimb);

    const spaceJustPressed = spaceDown && !this._prevSpaceDown;
    const climbJustPressed = climbKeyDown && !this._prevClimbKeyDown;
    this._prevSpaceDown = spaceDown;
    this._prevClimbKeyDown = climbKeyDown;

    if (spaceJustPressed) {
      this._jumpBufferTimer = 0.12;
    } else if (this._jumpBufferTimer > 0) {
      this._jumpBufferTimer -= safeDt;
    }

    // Camera-relative horizontal basis
    this._camForwardXZ.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._camRightXZ.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    this._moveDir
      .set(0, 0, 0)
      .addScaledVector(this._camForwardXZ, fwdIn)
      .addScaledVector(this._camRightXZ, rightIn);
    const moveMag = Math.min(1, this._moveDir.length());
    const hasMoveInput = moveMag > 0.08;
    if (hasMoveInput) {
      this._moveDir.normalize();
    }

    // Probe ground, platforms, water, and updrafts
    this._probeGround(pos, vel);

    if (this.isGrounded) {
      this._coyoteTimer = 0.14;
    } else if (this._coyoteTimer > 0) {
      this._coyoteTimer -= safeDt;
    }

    const inWater = pos.y < WORLD_CONFIG.SEA_LEVEL - 0.35;
    if (inWater && !this._wasInWater && vel.y < -2.2) {
      this._emitAudio('splash', { intensity: clamp(-vel.y / 14, 0.35, 1.0) });
    }
    this._wasInWater = inWater;

    const updraftLift = this._sampleUpdraft(pos);
    this.inUpdraft = this.mode === 'glide' && updraftLift > 0;

    // --- Mode Transitions ---

    // 1. Toggle / Engage Cliff Climbing ('C' key)
    if (this.mode === 'climb') {
      if (climbJustPressed) {
        this.mode = 'fall';
        this._climbCooldown = 0.25;
      }
    } else if (
      this._climbCooldown <= 0 &&
      !inWater &&
      this.stamina > 6 &&
      (climbJustPressed || (climbKeyDown && fwdIn > 0))
    ) {
      const lookX = hasMoveInput ? this._moveDir.x : Math.sin(this.facingHeading);
      const lookZ = hasMoveInput ? this._moveDir.z : Math.cos(this.facingHeading);
      const wallHit = this._probeClimbWall(pos, lookX, lookZ, 1.3);
      if (wallHit) {
        this.mode = 'climb';
        this._climbNormal.set(wallHit.normal.x, wallHit.normal.y, wallHit.normal.z).normalize();
        this._emitAudio('climb', { intensity: 0.7 });
      }
    }

    // 2. Enter Swimming when dropping into ocean below SEA_LEVEL - 0.35
    if (inWater && this.mode !== 'climb') {
      if (this.mode !== 'swim') {
        this.mode = 'swim';
        this.inUpdraft = false;
      }
    } else if (this.mode === 'swim' && !inWater) {
      this.mode = this.isGrounded ? 'idle' : 'fall';
    }

    // 3. Paraglider deploy / stow on Space while airborne
    if (
      spaceJustPressed &&
      this.mode !== 'swim' &&
      this.mode !== 'climb' &&
      !this.isGrounded &&
      this._coyoteTimer <= 0
    ) {
      if (this.mode === 'glide') {
        this.mode = 'fall';
        this.inUpdraft = false;
      } else if (this._heightAboveGround > 1.2 && this.stamina > 4) {
        this.mode = 'glide';
        this._jumpBufferTimer = 0;
        this._emitAudio('glide_open', { intensity: 0.9 });
      }
    }

    // --- Mode-Specific Physics & Locomotion ---

    let nextVx = vel.x;
    let nextVy = vel.y;
    let nextVz = vel.z;
    let drainedThisFrame = false;
    let windStrength = 0;

    if (this.mode === 'climb') {
      // Re-verify cliff wall contact right in front of heroine
      const wallHit = this._probeClimbWall(
        pos,
        -this._climbNormal.x,
        -this._climbNormal.z,
        1.45
      );

      if (spaceJustPressed) {
        // Leap away & upward off cliff!
        nextVx = this._climbNormal.x * 5.6 + (hasMoveInput ? this._moveDir.x * 2.4 : 0);
        nextVy = 8.0;
        nextVz = this._climbNormal.z * 5.6 + (hasMoveInput ? this._moveDir.z * 2.4 : 0);
        this.mode = 'jump';
        this._climbCooldown = 0.28;
        this._emitAudio('jump', { intensity: 0.9 });
      } else if (!wallHit) {
        if (fwdIn > 0) {
          // Graceful mantle onto cliff top ledge!
          nextVx = -this._climbNormal.x * 4.4;
          nextVy = 6.2;
          nextVz = -this._climbNormal.z * 4.4;
          this.mode = 'jump';
          this._climbCooldown = 0.35;
          this._emitAudio('climb', { intensity: 0.85 });
        } else {
          this.mode = 'fall';
        }
      } else {
        // Smoothly adapt to curved cliff normal
        this._climbNormal.lerp(
          new THREE.Vector3(wallHit.normal.x, wallHit.normal.y, wallHit.normal.z).normalize(),
          1 - Math.exp(-10 * safeDt)
        ).normalize();

        // Wall tangent axes: UP x Normal = wallRight, Normal x wallRight = wallUp
        this._wallRight.crossVectors(WORLD_UP, this._climbNormal).normalize();
        this._wallUp.crossVectors(this._climbNormal, this._wallRight).normalize();

        const climbSpeed = 4.2;
        const moveMag = Math.min(1, Math.hypot(fwdIn, rightIn));
        const tx =
          this._wallUp.x * fwdIn * climbSpeed +
          this._wallRight.x * rightIn * climbSpeed -
          this._climbNormal.x * 1.8;
        const ty =
          this._wallUp.y * fwdIn * climbSpeed +
          this._wallRight.y * rightIn * climbSpeed -
          this._climbNormal.y * 1.2;
        const tz =
          this._wallUp.z * fwdIn * climbSpeed +
          this._wallRight.z * rightIn * climbSpeed -
          this._climbNormal.z * 1.8;

        // Counteract Rapier's 1-tick gravity impulse cleanly so she never creeps downward on cliffs
        const baseClimbVy = vel.y - WORLD_CONFIG.GRAVITY * safeDt;
        nextVx = damp(vel.x, tx, 16, safeDt);
        nextVy = damp(baseClimbVy, ty, 18, safeDt);
        nextVz = damp(vel.z, tz, 16, safeDt);

        // Face straight into the rock wall
        this.facingHeading = Math.atan2(-this._climbNormal.x, -this._climbNormal.z);

        // Drain stamina while climbing
        const drainRate = moveMag > 0.1 ? 14.5 : 2.5;
        this._drainStamina(drainRate * safeDt);
        drainedThisFrame = true;

        if (moveMag > 0.1) {
          this._climbStepDist += climbSpeed * moveMag * safeDt;
          if (this._climbStepDist >= 1.25) {
            this._climbStepDist = 0;
            this._emitAudio('climb', { intensity: 0.65 });
          }
        }

        // Release if bottom grounded while climbing downward, or out of stamina
        if (this.stamina <= 0.1 || (this.isGrounded && fwdIn < 0)) {
          this.mode = this.isGrounded ? 'idle' : 'fall';
          this._climbCooldown = 0.35;
        }
      }
    } else if (this.mode === 'swim') {
      const wantsSprint = sprintDown && hasMoveInput && !this._exhausted && this.stamina > 2;
      const swimSpeed = wantsSprint ? 8.2 : 5.2;

      if (wantsSprint) {
        this._drainStamina(16.0 * safeDt);
        drainedThisFrame = true;
      }

      const targetVx = hasMoveInput ? this._moveDir.x * swimSpeed : 0;
      const targetVz = hasMoveInput ? this._moveDir.z * swimSpeed : 0;

      nextVx = damp(vel.x, targetVx, 6.5, safeDt);
      nextVz = damp(vel.z, targetVz, 6.5, safeDt);

      // Buoyant upward stabilization toward water surface (SEA_LEVEL - 0.24)
      const targetSurfaceY = WORLD_CONFIG.SEA_LEVEL - 0.24 + Math.sin(elapsedTime * 2.2) * 0.06;
      const depthError = targetSurfaceY - pos.y;
      const desiredVy = clamp(depthError * 6.5, -3.5, 5.5);
      const baseSwimVy = vel.y - WORLD_CONFIG.GRAVITY * safeDt;
      nextVy = damp(baseSwimVy, desiredVy, 8.5, safeDt);

      // Allow leaping out of shallow water onto beaches or rafts with Space!
      if (spaceJustPressed && (this.isGrounded || this._heightAboveGround < 1.35 || pos.y > WORLD_CONFIG.SEA_LEVEL - 0.65)) {
        nextVy = 7.6;
        this.mode = 'jump';
        this._emitAudio('splash', { intensity: 0.75 });
        this._emitAudio('jump', { intensity: 0.8 });
      }

      if (hasMoveInput) {
        this.facingHeading = Math.atan2(this._moveDir.x, this._moveDir.z);
        this._swimStrokeTimer += safeDt * (wantsSprint ? 2.4 : 1.5);
        if (this._swimStrokeTimer >= 1.0) {
          this._swimStrokeTimer = 0;
          this._emitAudio('splash', { intensity: wantsSprint ? 0.55 : 0.32 });
        }
      }
    } else if (this.mode === 'glide') {
      if (this.isGrounded || this.stamina <= 0.1) {
        this.mode = this.isGrounded ? 'idle' : 'fall';
        this.inUpdraft = false;
      } else {
        const glideSpeed = 12.5;
        let targetVx;
        let targetVz;

        if (hasMoveInput) {
          targetVx = this._moveDir.x * glideSpeed;
          targetVz = this._moveDir.z * glideSpeed;
          this.facingHeading = Math.atan2(this._moveDir.x, this._moveDir.z);
        } else {
          // Gentle airy forward drift even with hands off WASD
          targetVx = Math.sin(this.facingHeading) * 4.8;
          targetVz = Math.cos(this.facingHeading) * 4.8;
        }

        nextVx = damp(vel.x, targetVx, 4.2, safeDt);
        nextVz = damp(vel.z, targetVz, 4.2, safeDt);

        const baseGlideVy = vel.y - WORLD_CONFIG.GRAVITY * safeDt;
        if (updraftLift > 0) {
          // Soar strongly upward inside Himalayan updrafts (up to +11 m/s!)
          this.inUpdraft = true;
          const targetLiftVy = clamp(updraftLift * 0.48, 6.5, 11.0);
          nextVy = damp(baseGlideVy, targetLiftVy, 5.2, safeDt);
          windStrength = 1.4;
          // Minimal stamina cost while riding an updraft so players reach cloud sea & sky islands!
          this._drainStamina(1.2 * safeDt);
          drainedThisFrame = true;
        } else {
          this.inUpdraft = false;
          // Smooth BotW glide descent damped cleanly to -2.4 m/s
          nextVy = damp(baseGlideVy, -2.4, 6.0, safeDt);
          windStrength = 0.65;
          this._drainStamina(5.5 * safeDt);
          drainedThisFrame = true;
        }
      }
    } else {
      // Ground & Airborne Locomotion ('idle' | 'walk' | 'run' | 'jump' | 'fall')
      const wantsSprint =
        sprintDown && hasMoveInput && this.isGrounded && !this._exhausted && this.stamina > 2;
      const moveSpeed = wantsSprint ? 13.5 : 7.5;

      if (wantsSprint) {
        this._drainStamina(18.0 * safeDt);
        drainedThisFrame = true;
      }

      const relVx = vel.x - this._platformVel.x;
      const relVz = vel.z - this._platformVel.z;

      const targetRelVx = hasMoveInput ? this._moveDir.x * moveSpeed : 0;
      const targetRelVz = hasMoveInput ? this._moveDir.z * moveSpeed : 0;

      const accel = this.isGrounded ? (hasMoveInput ? 14.0 : 16.0) : (hasMoveInput ? 4.8 : 1.2);
      const newRelVx = damp(relVx, targetRelVx, accel, safeDt);
      const newRelVz = damp(relVz, targetRelVz, accel, safeDt);

      nextVx = newRelVx + this._platformVel.x;
      nextVz = newRelVz + this._platformVel.z;

      if (hasMoveInput) {
        this.facingHeading = Math.atan2(this._moveDir.x, this._moveDir.z);
      }

      // Jump with coyote time & jump buffer
      if (this._jumpBufferTimer > 0 && (this.isGrounded || this._coyoteTimer > 0)) {
        nextVy = 8.6 + Math.max(0, this._platformVel.y * 0.5);
        this.isGrounded = false;
        this._coyoteTimer = 0;
        this._jumpBufferTimer = 0;
        this.mode = 'jump';
        this._emitAudio('jump', { intensity: 1.0 });
      } else if (this.isGrounded) {
        const horizSpeed = Math.hypot(newRelVx, newRelVz);
        if (horizSpeed > 0.45) {
          this.mode = wantsSprint && horizSpeed > 8.5 ? 'run' : 'walk';

          // Footstep cadence emitter
          this._stepDistance += horizSpeed * safeDt;
          const strideLen = this.mode === 'run' ? 2.45 : 1.75;
          if (this._stepDistance >= strideLen) {
            this._stepDistance = 0;
            const biome = getBiomeInfo(pos.x, pos.z, pos.y - this.feetOffset);
            this._emitAudio('footstep', {
              surface: biome.footstep,
              footstep: biome.footstep,
              biome,
              speed: horizSpeed,
            });
          }
        } else {
          this.mode = 'idle';
          this._stepDistance = 0.8; // Crisp step right after starting to walk
        }
      } else {
        this.mode = nextVy > 0.5 ? 'jump' : 'fall';
        windStrength = clamp(-nextVy / 18.0, 0, 1.2);
      }
    }

    // Apply computed linear velocity to Rapier rigidbody
    this.body.setLinvel({ x: nextVx, y: nextVy, z: nextVz }, true);

    // Regenerate stamina smoothly on ground / raft (or slowly when treading water)
    if (!drainedThisFrame) {
      if (this._staminaRegenDelay > 0) {
        this._staminaRegenDelay -= safeDt;
      } else if (this.isGrounded) {
        this.stamina = Math.min(this.maxStamina, this.stamina + 28.0 * safeDt);
        if (this.stamina >= 22) this._exhausted = false;
      } else if (this.mode === 'swim' && !hasMoveInput) {
        this.stamina = Math.min(this.maxStamina, this.stamina + 8.0 * safeDt);
        if (this.stamina >= 22) this._exhausted = false;
      }
    }

    // Track relative speed for animations & HUD
    this._horizontalSpeed =
      this.mode === 'climb'
        ? Math.hypot(nextVx, nextVy, nextVz)
        : Math.hypot(nextVx - this._platformVel.x, nextVz - this._platformVel.z);

    // Sync Heroine visual mesh, animations, and collision-safe orbit camera
    this._syncVisualAndCamera(safeDt, this._isUltrahandActive, windStrength);
  }

  /**
   * Updates HeroineCharacter transform & animations, plus third-person camera with
   * terrain & Rapier obstacle collision avoidance.
   */
  _syncVisualAndCamera(dt, isUltrahandActive, windStrength) {
    const t = this.body.translation();
    const v = this.body.linvel();

    // Position heroine root so soles rest at bodyY - feetOffset
    this.heroine.root.position.set(t.x, t.y - this.feetOffset, t.z);

    // When Ultrahand is active while standing still, gently turn heroine toward camera aim
    if (isUltrahandActive && this.mode === 'idle') {
      this.facingHeading = Math.atan2(-Math.sin(this.yaw), -Math.cos(this.yaw));
    }

    // Smooth shortest-angle heading rotation & turnRate for natural leaning/banking
    const prevRotY = this.heroine.root.rotation.y;
    const diff = shortestAngleDiff(prevRotY, this.facingHeading);
    const turnLambda = this.mode === 'glide' ? 5.5 : 13.0;
    const step = diff * (1 - Math.exp(-turnLambda * dt));
    this.heroine.root.rotation.y = prevRotY + step;
    this._turnRate = damp(this._turnRate, clamp(step / Math.max(dt, 0.001), -8, 8), 10, dt);

    // Update HeroineCharacter procedural animation, Paraglider, hand-orb & VRM spring bones
    this.heroine.update(dt, {
      mode: this.mode,
      speed: this._horizontalSpeed,
      turnRate: this._turnRate,
      isUltrahand: isUltrahandActive,
      verticalVel: v.y,
      windStrength,
    });

    // --- Third-Person Orbit Camera with Collision Avoidance ---
    const pivotY = t.y - this.feetOffset + (this.mode === 'swim' ? 1.15 : 1.44);
    this._camPivot.set(t.x, pivotY, t.z);

    // Subtle over-the-shoulder right offset when casting Ultrahand for unobstructed aim
    const shoulderOffset = isUltrahandActive ? 0.45 : 0.0;
    if (shoulderOffset > 0) {
      this._camPivot.x += Math.cos(this.yaw) * shoulderOffset;
      this._camPivot.z -= Math.sin(this.yaw) * shoulderOffset;
    }

    // Direction from pivot toward camera
    const cosPitch = Math.cos(this.pitch);
    this._camDir.set(
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch
    ).normalize();

    let targetDist = this.cameraDistance;

    // 1. Rapier raycast obstacle avoidance (mountains, cliffs, sky islands, large rocks)
    const camHit = this._castWorldRay(
      this._camPivot.x,
      this._camPivot.y,
      this._camPivot.z,
      this._camDir.x,
      this._camDir.y,
      this._camDir.z,
      this.cameraDistance + 0.45
    );
    if (camHit) {
      targetDist = Math.min(targetDist, Math.max(1.35, camHit.timeOfImpact - 0.38));
    }

    // Pull camera in quickly on collision, ease out smoothly once unobstructed
    const distLambda = targetDist < this.currentCamDistance ? 22.0 : 7.5;
    this.currentCamDistance = damp(this.currentCamDistance, targetDist, distLambda, dt);

    this._camDesired
      .copy(this._camPivot)
      .addScaledVector(this._camDir, this.currentCamDistance);

    // 2. Analytical terrain floor clamp so camera never clips below terrain heightfield
    const terrainAtCam = getTerrainHeight(this._camDesired.x, this._camDesired.z);
    const minCamY = Math.max(terrainAtCam + 0.55, WORLD_CONFIG.SEA_LEVEL - 8.0);
    if (this._camDesired.y < minCamY) {
      this._camDesired.y = minCamY;
    }

    this.camera.position.copy(this._camDesired);
    this.camera.lookAt(this._camPivot);
  }

  /**
   * Returns complete snapshot of player physics, altitude, biome, and traversal state for HUD & Audio.
   */
  getState() {
    const t = this.body.translation();
    const v = this.body.linvel();
    const feetY = t.y - this.feetOffset;
    const altitude = feetY - WORLD_CONFIG.SEA_LEVEL;
    const displayAltitude = Math.round(
      Math.max(0, altitude) * WORLD_CONFIG.ALTITUDE_DISPLAY_SCALE
    );
    const biome = getBiomeInfo(t.x, t.z, feetY);

    return {
      position: { x: t.x, y: feetY, z: t.z },
      velocity: { x: v.x, y: v.y, z: v.z },
      mode: this.mode,
      stamina: this.stamina,
      maxStamina: this.maxStamina,
      altitude,
      displayAltitude,
      biome,
      yaw: this.yaw,
      pitch: this.pitch,
      speed: this._horizontalSpeed,
      isGrounded: this.isGrounded,
      inUpdraft: this.inUpdraft,
    };
  }

  dispose() {
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    this.domElement.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    this.domElement.removeEventListener('wheel', this._onWheel);
    this.domElement.removeEventListener('contextmenu', this._onContextMenu);
  }
}
