/**
 * UltrahandSystem.js — Tears-of-the-Kingdom-inspired telekinetic Ultrahand system:
 * Raycast targeting, critically damped PD rigidbody carrying (preserving real collisions),
 * 45-degree precision rotation, distance control, glowing emerald energy beam + halo,
 * selection/hold wireframe highlight, and golden-emerald weld snap preview.
 */

import * as THREE from 'three';

const CENTER_NDC = new THREE.Vector2(0, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const BEAM_AXIS = new THREE.Vector3(0, 1, 0);

const MAX_AIM_DIST = 16.0;
const SNAP_DIST = 4.2;
const MIN_HOLD_DIST = 3.0;
const MAX_HOLD_DIST = 12.0;

// Scratch objects to avoid per-frame allocations
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qErr = new THREE.Quaternion();
const _box3 = new THREE.Box3();
const _size = new THREE.Vector3();

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class UltrahandSystem {
  constructor(physicsEngine, scene, camera) {
    this.physics = physicsEngine;
    this.scene = scene;
    this.camera = camera;

    this.aimedProp = null;
    this.heldProp = null;
    this.snapCandidate = null;
    this.holdDistance = 5.5;
    this.targetQuat = new THREE.Quaternion();

    this.raycaster = new THREE.Raycaster();
    this.raycaster.near = 0.2;
    this.raycaster.far = MAX_AIM_DIST;

    this._elapsed = 0;

    this._initVisuals();
  }

  _initVisuals() {
    // 1. Glowing emerald-cyan energy beam (inner core + outer aura cylinder + pulsing halo)
    this._beamGroup = new THREE.Group();
    this._beamGroup.visible = false;

    const coreGeo = new THREE.CylinderGeometry(0.032, 0.055, 1, 10, 1, true);
    this._beamCoreMat = new THREE.MeshBasicMaterial({
      color: 0xb8ffef,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._beamCore = new THREE.Mesh(coreGeo, this._beamCoreMat);

    const auraGeo = new THREE.CylinderGeometry(0.09, 0.16, 1, 12, 1, true);
    this._beamAuraMat = new THREE.MeshBasicMaterial({
      color: 0x26f0b8,
      transparent: true,
      opacity: 0.36,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._beamAura = new THREE.Mesh(auraGeo, this._beamAuraMat);

    this._beamGroup.add(this._beamCore, this._beamAura);

    // Pulsing Zonai halo ring around held object
    this._haloMat = new THREE.MeshBasicMaterial({
      color: 0x45ffcb,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._haloRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.04, 8, 32),
      this._haloMat
    );
    this._haloRing.visible = false;

    // 2. Crisp wireframe glow outline box for aimedProp / heldProp
    const unitBoxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this._outlineMat = new THREE.LineBasicMaterial({
      color: 0x52ffcf,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._outlineMesh = new THREE.LineSegments(unitBoxEdges, this._outlineMat);
    this._outlineMesh.visible = false;

    // 3. Pulsing golden-emerald snap preview line + midpoint orb + anchor rings
    this._snapGroup = new THREE.Group();
    this._snapGroup.visible = false;

    const snapTubeGeo = new THREE.CylinderGeometry(0.045, 0.045, 1, 10, 1, true);
    this._snapLineMat = new THREE.MeshBasicMaterial({
      color: 0x9bff6e,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._snapLine = new THREE.Mesh(snapTubeGeo, this._snapLineMat);

    this._snapOrbMat = new THREE.MeshBasicMaterial({
      color: 0xffe066,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._snapOrb = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 14, 12),
      this._snapOrbMat
    );

    this._snapRingMat = new THREE.MeshBasicMaterial({
      color: 0xffe066,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._snapRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.035, 8, 24),
      this._snapRingMat
    );

    this._snapGroup.add(this._snapLine, this._snapOrb, this._snapRing);

    if (this.scene) {
      this.scene.add(this._beamGroup);
      this.scene.add(this._haloRing);
      this.scene.add(this._outlineMesh);
      this.scene.add(this._snapGroup);
    }
  }

  /**
   * Per-frame update: raycast target, PD-drive held body with real collisions,
   * detect weld snap candidates, and update energy beam / outline / snap visuals.
   */
  update(dt, playerHandPos, camera = this.camera) {
    if (camera) this.camera = camera;
    const clampedDt = Math.min(Math.max(dt, 0.001), 0.05);
    this._elapsed += clampedDt;

    // Release gracefully if held prop was destroyed (e.g. barrel detonated)
    if (this.heldProp && this.heldProp._destroyed) {
      this.heldProp = null;
      this.snapCandidate = null;
    }

    if (this.heldProp) {
      this.aimedProp = this.heldProp;
      this._driveHeldProp(clampedDt);
      this._updateSnapCandidate();
    } else {
      this.snapCandidate = null;
      this._updateAimedProp();
    }

    this._updateVisuals(playerHandPos);
  }

  _updateAimedProp() {
    this.aimedProp = null;
    if (!this.camera || !this.physics || this.physics.props.length === 0) return;

    this.raycaster.setFromCamera(CENTER_NDC, this.camera);
    const meshes = [];
    for (let i = 0; i < this.physics.props.length; i++) {
      const p = this.physics.props[i];
      if (!p._destroyed && p.mesh) meshes.push(p.mesh);
    }
    if (meshes.length === 0) return;

    const hits = this.raycaster.intersectObjects(meshes, true);
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (hit.distance > MAX_AIM_DIST) break;
      const propId = hit.object?.userData?.propId;
      if (propId !== undefined) {
        const prop = this.physics.propById.get(propId);
        if (prop && !prop._destroyed) {
          this.aimedProp = prop;
          return;
        }
      }
    }
  }

  _driveHeldProp(dt) {
    const prop = this.heldProp;
    const body = prop.body;

    // Compute desired world hold position ahead of camera
    this.camera.getWorldDirection(_camForward).normalize();
    const targetPos = _v1
      .copy(this.camera.position)
      .addScaledVector(_camForward, this.holdDistance);

    // Clamp above terrain & floating islands so held objects don't bury underground
    const surfaceY = this.physics.getSurfaceHeightAt(
      targetPos.x,
      targetPos.z,
      targetPos.y + 3.0
    );
    const minY = surfaceY + (prop.halfExtentY || 0.5) + 0.25;
    if (targetPos.y < minY) {
      targetPos.y = minY;
    }

    // Wake entire welded assembly so contraptions move together cleanly
    const assembly = this.physics.getConnectedAssembly(prop);
    for (let i = 0; i < assembly.length; i++) {
      assembly[i].body.wakeUp();
    }

    // Critically damped linear velocity PD controller (keeps real collisions!)
    const t = body.translation();
    const lv = body.linvel();
    const errPos = _v2.set(targetPos.x - t.x, targetPos.y - t.y, targetPos.z - t.z);

    const kpLin = assembly.length > 1 ? 9.5 : 12.5;
    const maxSpeed = assembly.length > 1 ? 18.0 : 24.0;
    const desiredVel = _v3.copy(errPos).multiplyScalar(kpLin);
    const speed = desiredVel.length();
    if (speed > maxSpeed) {
      desiredVel.multiplyScalar(maxSpeed / speed);
    }

    const blendLin = 1 - Math.exp(-16.0 * dt);
    const curVel = _v4.set(lv.x, lv.y, lv.z).lerp(desiredVel, blendLin);
    body.setLinvel({ x: curVel.x, y: curVel.y, z: curVel.z }, true);

    // Critically damped angular velocity PD controller toward this.targetQuat
    const r = body.rotation();
    _q1.set(r.x, r.y, r.z, r.w).normalize();
    _q2.copy(_q1).invert();
    _qErr.copy(this.targetQuat).multiply(_q2).normalize();

    // Shortest-arc quaternion sign fix
    if (_qErr.w < 0) {
      _qErr.set(-_qErr.x, -_qErr.y, -_qErr.z, -_qErr.w);
    }

    const angle = 2 * Math.acos(clamp(_qErr.w, -1, 1));
    const desiredAng = _v3.set(0, 0, 0);
    if (angle > 0.002) {
      const sinHalf = Math.sqrt(Math.max(1e-8, 1 - _qErr.w * _qErr.w));
      const angGain = clamp(angle * 11.0, 0, 12.0);
      desiredAng.set(
        (_qErr.x / sinHalf) * angGain,
        (_qErr.y / sinHalf) * angGain,
        (_qErr.z / sinHalf) * angGain
      );
    }

    const av = body.angvel();
    const blendAng = 1 - Math.exp(-15.0 * dt);
    const curAng = _v4.set(av.x, av.y, av.z).lerp(desiredAng, blendAng);
    body.setAngvel({ x: curAng.x, y: curAng.y, z: curAng.z }, true);
  }

  _updateSnapCandidate() {
    this.snapCandidate = null;
    if (!this.heldProp) return;

    const heldAssembly = new Set(this.physics.getConnectedAssembly(this.heldProp));
    const ht = this.heldProp.body.translation();
    let bestProp = null;
    let bestDist = SNAP_DIST;

    for (let i = 0; i < this.physics.props.length; i++) {
      const p = this.physics.props[i];
      if (p._destroyed || heldAssembly.has(p)) continue;
      const pt = p.body.translation();
      const d = Math.hypot(pt.x - ht.x, pt.y - ht.y, pt.z - ht.z);
      if (d < bestDist) {
        bestDist = d;
        bestProp = p;
      }
    }

    this.snapCandidate = bestProp;
  }

  _updateVisuals(playerHandPos) {
    const t = this._elapsed;

    // 1. Energy beam & halo when holding a prop
    if (this.heldProp && !this.heldProp._destroyed) {
      const ht = this.heldProp.body.translation();
      const endPos = _v1.set(ht.x, ht.y, ht.z);
      const startPos = playerHandPos
        ? _v2.set(playerHandPos.x, playerHandPos.y, playerHandPos.z)
        : _v2.copy(this.camera.position).add(new THREE.Vector3(0, -0.45, 0));

      const diff = _v3.subVectors(endPos, startPos);
      const len = diff.length();

      if (len > 0.05) {
        this._beamGroup.visible = true;
        this._beamGroup.position.copy(startPos).add(endPos).multiplyScalar(0.5);
        _q1.setFromUnitVectors(BEAM_AXIS, _v4.copy(diff).divideScalar(len));
        this._beamGroup.quaternion.copy(_q1);

        const pulse = 0.88 + Math.sin(t * 14.0) * 0.16;
        this._beamCore.scale.set(pulse, len, pulse);
        this._beamAura.scale.set(1.0 + Math.sin(t * 9.0) * 0.2, len, 1.0 + Math.sin(t * 9.0) * 0.2);
        this._beamCoreMat.opacity = 0.78 + Math.sin(t * 18.0) * 0.15;
        this._beamAuraMat.opacity = 0.28 + Math.sin(t * 11.0) * 0.1;
      } else {
        this._beamGroup.visible = false;
      }

      // Pulsing Zonai halo around held prop facing the camera
      this._haloRing.visible = true;
      this._haloRing.position.copy(endPos);
      if (this.camera) {
        this._haloRing.quaternion.copy(this.camera.quaternion);
      }
      const haloRadius = Math.max(0.75, (this.heldProp.halfExtentY || 0.7) * 1.15);
      const haloPulse = haloRadius * (0.95 + Math.sin(t * 8.0) * 0.08);
      this._haloRing.scale.setScalar(haloPulse);
      this._haloRing.rotation.z += 0.03;
    } else {
      this._beamGroup.visible = false;
      this._haloRing.visible = false;
    }

    // 2. Subtle wireframe glow outline around aimedProp or heldProp
    const highlightProp = this.heldProp || this.aimedProp;
    if (highlightProp && !highlightProp._destroyed) {
      const def = highlightProp.def;
      if (def.shape === 'box') {
        _size.set(def.size[0], def.size[1], def.size[2]);
      } else if (def.shape === 'cylinder') {
        _size.set(def.radius * 2, def.length, def.radius * 2);
      } else if (def.shape === 'sphere') {
        _size.set(def.radius * 2, def.radius * 2, def.radius * 2);
      } else {
        _box3.setFromObject(highlightProp.mesh);
        _box3.getSize(_size);
      }

      this._outlineMesh.visible = true;
      this._outlineMesh.position.copy(highlightProp.mesh.position);
      this._outlineMesh.quaternion.copy(highlightProp.mesh.quaternion);
      this._outlineMesh.scale.copy(_size).multiplyScalar(1.06);

      if (this.heldProp) {
        this._outlineMat.color.setHex(0x4affc4);
        this._outlineMat.opacity = 0.85 + Math.sin(t * 12) * 0.12;
      } else {
        this._outlineMat.color.setHex(0x88fff0);
        this._outlineMat.opacity = 0.48 + Math.sin(t * 6) * 0.14;
      }
    } else {
      this._outlineMesh.visible = false;
    }

    // 3. Pulsing golden-emerald snap preview line between heldProp and snapCandidate
    if (this.heldProp && this.snapCandidate && !this.snapCandidate._destroyed) {
      const tA = this.heldProp.body.translation();
      const tB = this.snapCandidate.body.translation();
      const pA = _v1.set(tA.x, tA.y, tA.z);
      const pB = _v2.set(tB.x, tB.y, tB.z);
      const diff = _v3.subVectors(pB, pA);
      const len = diff.length();

      if (len > 0.05) {
        this._snapGroup.visible = true;
        const mid = _v4.copy(pA).add(pB).multiplyScalar(0.5);

        this._snapLine.position.copy(mid);
        _q1.setFromUnitVectors(BEAM_AXIS, diff.clone().divideScalar(len));
        this._snapLine.quaternion.copy(_q1);
        const pulse = 0.85 + Math.sin(t * 15) * 0.25;
        this._snapLine.scale.set(pulse, len, pulse);

        this._snapOrb.position.copy(mid);
        this._snapOrb.scale.setScalar(0.85 + Math.sin(t * 12) * 0.22);

        this._snapRing.position.copy(mid);
        if (this.camera) {
          this._snapRing.quaternion.copy(this.camera.quaternion);
        }
        this._snapRing.scale.setScalar(0.9 + Math.sin(t * 10) * 0.15);

        // Shift between emerald green & radiant gold
        const blend = 0.5 + 0.5 * Math.sin(t * 9.0);
        this._snapLineMat.color.setHex(0x3cf0a8).lerp(new THREE.Color(0xffd952), blend);
      } else {
        this._snapGroup.visible = false;
      }
    } else {
      this._snapGroup.visible = false;
    }
  }

  // --- Player Action Methods ---

  /** Grab aimedProp or release currently heldProp */
  tryGrabOrRelease(playerHandPos) {
    if (this.heldProp) {
      // Release cleanly, damping any sudden fling velocity
      const lv = this.heldProp.body.linvel();
      this.heldProp.body.setLinvel(
        {
          x: clamp(lv.x, -8, 8),
          y: clamp(lv.y, -8, 8),
          z: clamp(lv.z, -8, 8),
        },
        true
      );
      this.heldProp = null;
      this.snapCandidate = null;
      return false;
    }

    if (this.aimedProp && !this.aimedProp._destroyed) {
      this.heldProp = this.aimedProp;
      const t = this.heldProp.body.translation();
      const r = this.heldProp.body.rotation();
      const origin = this.camera ? this.camera.position : playerHandPos;
      if (origin) {
        const dist = Math.hypot(t.x - origin.x, t.y - origin.y, t.z - origin.z);
        this.holdDistance = clamp(dist, 3.2, 11.0);
      } else {
        this.holdDistance = 5.5;
      }
      this.targetQuat.set(r.x, r.y, r.z, r.w).normalize();

      const assembly = this.physics.getConnectedAssembly(this.heldProp);
      for (let i = 0; i < assembly.length; i++) {
        assembly[i].body.wakeUp();
      }
      this.physics.emitSound('grab', 0.9, new THREE.Vector3(t.x, t.y, t.z));
      return true;
    }

    return false;
  }

  /** Throw the currently held prop forward with a strong heroic impulse */
  throwHeld() {
    if (!this.heldProp || this.heldProp._destroyed) return false;

    const prop = this.heldProp;
    this.heldProp = null;
    this.snapCandidate = null;

    this.camera.getWorldDirection(_camForward).normalize();
    const mass = prop.body.mass();
    const impulseMag = 18.0 * mass;

    prop.body.wakeUp();
    prop.body.applyImpulse(
      {
        x: _camForward.x * impulseMag,
        y: (_camForward.y * 18.0 + 2.5) * mass,
        z: _camForward.z * impulseMag,
      },
      true
    );

    const t = prop.body.translation();
    this.physics.emitSound('grab', 1.0, new THREE.Vector3(t.x, t.y, t.z));
    return true;
  }

  /**
   * Rotate target hold quaternion in crisp 45-degree increments.
   * axis: 'y' (world yaw) or 'x' (camera-relative pitch), dir: +1 or -1.
   */
  rotateHeld(axis, dir = 1) {
    if (!this.heldProp || this.heldProp._destroyed) return false;
    const stepAngle = (Math.PI / 4) * (dir >= 0 ? 1 : -1);

    if (axis === 'y') {
      _q1.setFromAxisAngle(WORLD_UP, stepAngle);
    } else {
      // Rotate around camera's right vector so pitching always feels intuitive!
      this.camera.getWorldDirection(_camForward).normalize();
      _camRight.crossVectors(_camForward, WORLD_UP);
      if (_camRight.lengthSq() < 1e-4) {
        _camRight.set(1, 0, 0);
      } else {
        _camRight.normalize();
      }
      _q1.setFromAxisAngle(_camRight, stepAngle);
    }

    this.targetQuat.premultiply(_q1).normalize();
    return true;
  }

  /** Push or pull the held prop smoothly within [3.0, 12.0] meters */
  adjustDistance(delta) {
    this.holdDistance = clamp(
      this.holdDistance + delta,
      MIN_HOLD_DIST,
      MAX_HOLD_DIST
    );
    return this.holdDistance;
  }

  /** Weld heldProp to snapCandidate if in range */
  tryWeld() {
    if (!this.heldProp || !this.snapCandidate) return null;
    if (this.heldProp._destroyed || this.snapCandidate._destroyed) return null;

    const joint = this.physics.weldProps(this.heldProp, this.snapCandidate);
    if (joint) {
      // Zero residual hand-carry drift and release smoothly so the contraption settles cleanly
      this.heldProp.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.heldProp.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.heldProp = null;
      this.snapCandidate = null;
    }
    return joint;
  }

  /** Unweld all joints on heldProp or aimedProp */
  tryUnweld() {
    const target = this.heldProp || this.aimedProp;
    if (!target || target._destroyed) return false;
    return this.physics.unweldProp(target) > 0;
  }

  /** State snapshot for UI HUD prompts */
  getHudState() {
    const activeTarget = this.heldProp || this.aimedProp;
    const hasJoints = Boolean(
      activeTarget &&
        !activeTarget._destroyed &&
        this.physics.joints.some(
          (j) => j.propA === activeTarget || j.propB === activeTarget
        )
    );

    return {
      aimedName:
        this.aimedProp && !this.aimedProp._destroyed
          ? this.aimedProp.def.name
          : null,
      heldName:
        this.heldProp && !this.heldProp._destroyed
          ? this.heldProp.def.name
          : null,
      canWeld: Boolean(
        this.heldProp &&
          !this.heldProp._destroyed &&
          this.snapCandidate &&
          !this.snapCandidate._destroyed
      ),
      weldTargetName:
        this.snapCandidate && !this.snapCandidate._destroyed
          ? this.snapCandidate.def.name
          : null,
      hasJoints,
    };
  }
}
