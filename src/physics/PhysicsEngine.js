/**
 * PhysicsEngine.js — Rapier3D physics, Zonai-inspired procedural props,
 * multi-point ocean wave buoyancy, Ultrahand rigid welding, active contraptions
 * (fans, rockets, powered wheels), explosive barrels, and starter vehicles/rafts.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { WORLD_CONFIG, PROP_CATALOG } from '../config/worldConfig.js';
import { FLOATING_ISLANDS, getTerrainHeight } from '../world/terrainMath.js';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 3;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_Y = new THREE.Vector3(0, 1, 0);

// Reusable scratch math objects to keep per-frame allocations near zero
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class PhysicsEngine {
  constructor() {
    this.RAPIER = null;
    this.world = null;
    this.eventQueue = null;
    this.scene = null;

    this.terrainCollider = null;
    this.islandColliders = [];

    this.props = [];
    this.propById = new Map();
    this.propByCollider = new Map();
    this.propByBody = new Map();
    this.joints = [];
    this.particles = [];

    this._soundListeners = [];
    this._pendingDetonations = [];
    this._nextPropId = 1;
    this._nextJointId = 1;
    this._accumulator = 0;
    this._elapsed = 0;

    this._heldProp = null;
    this._spawningStarters = false;
    this._spawningPreset = false;
    this.maxProps = this._detectMobile() ? 75 : 110;

    // Shared particle & glue resources initialized in init()
    this._particleGeo = null;
    this._glueGeo = null;
    this._glueCoreGeo = null;
    this._glueMat = null;
    this._glueCoreMat = null;
  }

  _detectMobile() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return false;
    }
    const coarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    const touch =
      (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    const smallScreen =
      Math.min(window.innerWidth || 9999, window.innerHeight || 9999) <= 900;
    return Boolean(coarse || (touch && smallScreen));
  }

  /** Track currently Ultrahand-held prop so prop-cap pruning never despawns it */
  setHeldProp(prop) {
    this._heldProp = prop && !prop._destroyed ? prop : null;
  }

  /**
   * Initialize Rapier3D WASM, terrain heightfield, floating island colliders,
   * and spawn ready-to-play starter contraptions.
   */
  async init(heightfieldData, scene) {
    await RAPIER.init();
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: WORLD_CONFIG.GRAVITY, z: 0 });
    this.eventQueue = new RAPIER.EventQueue(true);
    this.scene = scene;

    // 1. Static Terrain Heightfield Collider (exact column-major match)
    if (heightfieldData) {
      const { seg, size, rapierHeights } = heightfieldData;
      const terrainDesc = RAPIER.ColliderDesc.heightfield(
        seg,
        seg,
        rapierHeights,
        { x: size, y: 1, z: size }
      )
        .setFriction(0.85)
        .setRestitution(0.08);
      this.terrainCollider = this.world.createCollider(terrainDesc);
    }

    // 2. Static Cylindrical Colliders for Floating Sky Islands (top surface at island.y)
    this.islandColliders = [];
    for (const island of FLOATING_ISLANDS) {
      const islandDesc = RAPIER.ColliderDesc.cylinder(
        island.thickness * 0.5,
        island.radius
      )
        .setTranslation(island.x, island.y - island.thickness * 0.5, island.z)
        .setFriction(0.85)
        .setRestitution(0.08);
      this.islandColliders.push(this.world.createCollider(islandDesc));
    }

    // 3. Reset collections & prepare shared VFX geometry/materials
    this.props = [];
    this.propById = new Map();
    this.propByCollider = new Map();
    this.propByBody = new Map();
    this.joints = [];
    this.particles = [];
    this._pendingDetonations = [];

    this._particleGeo = new THREE.IcosahedronGeometry(1, 0);
    this._glueGeo = new THREE.SphereGeometry(0.28, 12, 10);
    this._glueCoreGeo = new THREE.SphereGeometry(0.14, 10, 8);
    this._glueMat = new THREE.MeshStandardMaterial({
      color: 0x2de6a8,
      emissive: 0x16b882,
      emissiveIntensity: 0.9,
      roughness: 0.2,
      metalness: 0.1,
      transparent: true,
      opacity: 0.72,
    });
    this._glueCoreMat = new THREE.MeshBasicMaterial({
      color: 0xb8ffea,
      transparent: true,
      opacity: 0.9,
    });

    // 4. Populate world with immediately playable starter contraptions
    this.spawnStarterContraptions();
  }

  /** Register callback: (eventType, intensity, position) */
  onSoundEvent(callback) {
    if (typeof callback === 'function') {
      this._soundListeners.push(callback);
    }
  }

  emitSound(eventType, intensity = 1.0, position = null) {
    for (let i = 0; i < this._soundListeners.length; i++) {
      try {
        this._soundListeners[i](eventType, intensity, position);
      } catch (_) {
        // Isolate audio callback failures from physics simulation
      }
    }
  }

  /** Surface height considering both terrain and floating island tops */
  getSurfaceHeightAt(x, z, referenceY = Infinity) {
    let h = getTerrainHeight(x, z);
    for (let i = 0; i < FLOATING_ISLANDS.length; i++) {
      const isl = FLOATING_ISLANDS[i];
      const dx = x - isl.x;
      const dz = z - isl.z;
      if (dx * dx + dz * dz <= (isl.radius + 1.0) * (isl.radius + 1.0)) {
        if (referenceY >= isl.y - 3.0 && isl.y > h) {
          h = isl.y;
        }
      }
    }
    return h;
  }

  /**
   * Spawn a physical prop from PROP_CATALOG with a bespoke BotW/Zonai-styled Three.js mesh.
   */
  spawnProp(typeId, position, quaternion = null) {
    const def = PROP_CATALOG[typeId];
    if (!def) {
      console.warn(`[PhysicsEngine] Unknown prop typeId: ${typeId}`);
      return null;
    }

    if (!this._spawningStarters && !this._spawningPreset) {
      this._enforcePropCap(1);
    }

    const id = this._nextPropId++;
    const pos = {
      x: position.x ?? 0,
      y: position.y ?? 2,
      z: position.z ?? 0,
    };
    const quat = quaternion
      ? { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }
      : { x: 0, y: 0, z: 0, w: 1 };

    // Build Three.js Group mesh & sub-part handles for animations
    const { group, subParts } = this._createPropMesh(typeId, def, id);
    group.position.set(pos.x, pos.y, pos.z);
    group.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    if (this.scene) {
      this.scene.add(group);
    }

    // Create Rapier dynamic RigidBody
    const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation(quat)
      .setLinearDamping(0.16)
      .setAngularDamping(0.32)
      .setCcdEnabled(typeId === 'rocket' || typeId === 'boulder' || typeId === 'barrel');

    const body = this.world.createRigidBody(bodyDesc);

    // Create matching Collider
    let colliderDesc;
    if (def.shape === 'box') {
      const [sx, sy, sz] = def.size;
      colliderDesc = this.RAPIER.ColliderDesc.cuboid(sx * 0.5, sy * 0.5, sz * 0.5);
    } else if (def.shape === 'cylinder') {
      colliderDesc = this.RAPIER.ColliderDesc.cylinder(def.length * 0.5, def.radius);
    } else if (def.shape === 'sphere') {
      colliderDesc = this.RAPIER.ColliderDesc.ball(def.radius);
    } else {
      colliderDesc = this.RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5);
    }

    colliderDesc
      .setMass(def.mass)
      .setFriction(def.friction)
      .setRestitution(def.restitution)
      .setActiveEvents(this.RAPIER.ActiveEvents.COLLISION_EVENTS);

    const collider = this.world.createCollider(colliderDesc, body);

    const prop = {
      id,
      typeId,
      def,
      body,
      collider,
      mesh: group,
      active: false,
      burnLeft: def.burnDuration || 0,
      cooldownLeft: 0,
      wasInWater: pos.y < WORLD_CONFIG.SEA_LEVEL,
      subParts,
      buoyancyPoints: this._buildBuoyancyPoints(def),
      halfExtentY: this._estimateHalfExtent(def),
      _lastImpactTime: -10,
      _lastParticleTime: 0,
      _isStarter: Boolean(this._spawningStarters),
      _isHeld: false,
      _destroyed: false,
    };

    this.props.push(prop);
    this.propById.set(id, prop);
    this.propByCollider.set(collider.handle, prop);
    this.propByBody.set(body.handle, prop);

    return prop;
  }

  _estimateHalfExtent(def) {
    if (def.shape === 'box') {
      return Math.max(def.size[1] * 0.5, 0.2);
    }
    if (def.shape === 'cylinder') {
      return Math.max(def.radius, def.length * 0.5);
    }
    return def.radius || 0.6;
  }

  /** Generate 4–8 well-distributed local buoyancy sample points per shape */
  _buildBuoyancyPoints(def) {
    if (def.shape === 'box') {
      const [sx, sy, sz] = def.size;
      const hx = sx * 0.42;
      const hy = -sy * 0.25;
      const hz = sz * 0.42;
      return [
        new THREE.Vector3(-hx, hy, -hz),
        new THREE.Vector3(hx, hy, -hz),
        new THREE.Vector3(-hx, hy, hz),
        new THREE.Vector3(hx, hy, hz),
        new THREE.Vector3(0, hy, -hz),
        new THREE.Vector3(0, hy, hz),
      ];
    }
    if (def.shape === 'cylinder') {
      const hl = def.length * 0.42;
      const r = def.radius * 0.72;
      if (def.length >= def.radius * 2.2) {
        // Elongated cylinder (log, rocket, barrel)
        return [
          new THREE.Vector3(0, -hl, 0),
          new THREE.Vector3(0, hl, 0),
          new THREE.Vector3(r, -hl * 0.5, 0),
          new THREE.Vector3(-r, -hl * 0.5, 0),
          new THREE.Vector3(0, hl * 0.5, r),
          new THREE.Vector3(0, hl * 0.5, -r),
        ];
      }
      // Disc-like cylinder (wheel, fan)
      return [
        new THREE.Vector3(r, 0, 0),
        new THREE.Vector3(-r, 0, 0),
        new THREE.Vector3(0, 0, r),
        new THREE.Vector3(0, 0, -r),
        new THREE.Vector3(0, hl, 0),
        new THREE.Vector3(0, -hl, 0),
      ];
    }
    // Sphere (boulder)
    const r = (def.radius || 1) * 0.65;
    return [
      new THREE.Vector3(0, -r, 0),
      new THREE.Vector3(r, 0, 0),
      new THREE.Vector3(-r, 0, 0),
      new THREE.Vector3(0, 0, r),
      new THREE.Vector3(0, 0, -r),
      new THREE.Vector3(0, r, 0),
    ];
  }

  /** Build distinctive BotW / Zonai-inspired Three.js Group meshes */
  _createPropMesh(typeId, def, propId) {
    const group = new THREE.Group();
    const subParts = {};

    if (typeId === 'plank') {
      const [sx, sy, sz] = def.size;
      const woodMat = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: 0.78,
        metalness: 0.04,
      });
      const darkWoodMat = new THREE.MeshStandardMaterial({
        color: def.accent,
        roughness: 0.84,
        metalness: 0.04,
      });
      const ironMat = new THREE.MeshStandardMaterial({
        color: 0x3b4248,
        roughness: 0.45,
        metalness: 0.72,
      });

      // Main cedar deck body (slightly inset so beveled end caps stand out)
      const mainBoard = new THREE.Mesh(
        new THREE.BoxGeometry(sx - 0.14, sy, sz),
        woodMat
      );
      group.add(mainBoard);

      // Chamfer-like stepped end caps
      const endGeo = new THREE.BoxGeometry(0.1, sy * 0.84, sz * 0.96);
      const endL = new THREE.Mesh(endGeo, darkWoodMat);
      endL.position.x = -sx * 0.5 + 0.05;
      const endR = new THREE.Mesh(endGeo, darkWoodMat);
      endR.position.x = sx * 0.5 - 0.05;
      group.add(endL, endR);

      // Plank seam grooves
      const seamGeo = new THREE.BoxGeometry(sx - 0.16, sy + 0.012, 0.035);
      for (const zOff of [-sz * 0.24, sz * 0.24]) {
        const seam = new THREE.Mesh(seamGeo, darkWoodMat);
        seam.position.z = zOff;
        group.add(seam);
      }

      // Iron corner bands & cross cleats
      const strapGeo = new THREE.BoxGeometry(0.16, sy + 0.03, sz + 0.03);
      for (const xOff of [-sx * 0.38, sx * 0.38]) {
        const strap = new THREE.Mesh(strapGeo, ironMat);
        strap.position.x = xOff;
        group.add(strap);
      }

      // Corner iron brackets
      const cornerGeo = new THREE.BoxGeometry(0.24, sy + 0.04, 0.24);
      for (const sxSign of [-1, 1]) {
        for (const szSign of [-1, 1]) {
          const corner = new THREE.Mesh(cornerGeo, ironMat);
          corner.position.set(
            sxSign * (sx * 0.5 - 0.14),
            0,
            szSign * (sz * 0.5 - 0.12)
          );
          group.add(corner);
        }
      }
    } else if (typeId === 'log') {
      const r = def.radius;
      const len = def.length;
      const barkMat = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: 0.9,
        metalness: 0.02,
      });
      const darkBarkMat = new THREE.MeshStandardMaterial({
        color: 0x52341e,
        roughness: 0.94,
        metalness: 0.02,
      });
      const endGrainMat = new THREE.MeshStandardMaterial({
        color: def.accent,
        roughness: 0.72,
        metalness: 0.02,
      });
      const heartwoodMat = new THREE.MeshStandardMaterial({
        color: 0x9e6c3f,
        roughness: 0.75,
        metalness: 0.02,
      });

      // Main cylindrical pine trunk along local Y
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.96, r, len, 14),
        barkMat
      );
      group.add(trunk);

      // Longitudinal bark ridges
      const ridgeGeo = new THREE.BoxGeometry(0.08, len * 0.95, 0.08);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const ridge = new THREE.Mesh(ridgeGeo, darkBarkMat);
        ridge.position.set(Math.cos(a) * (r * 0.94), 0, Math.sin(a) * (r * 0.94));
        ridge.rotation.y = -a;
        group.add(ridge);
      }

      // Light wood end-grain caps + inner growth ring discs
      const capGeo = new THREE.CylinderGeometry(r * 0.86, r * 0.86, 0.04, 14);
      const ringGeo = new THREE.CylinderGeometry(r * 0.48, r * 0.48, 0.05, 12);
      for (const ySign of [-1, 1]) {
        const cap = new THREE.Mesh(capGeo, endGrainMat);
        cap.position.y = ySign * (len * 0.5 - 0.01);
        const ring = new THREE.Mesh(ringGeo, heartwoodMat);
        ring.position.y = ySign * (len * 0.5);
        group.add(cap, ring);
      }
    } else if (typeId === 'wheel') {
      const r = def.radius;
      const w = def.length;
      const stoneMat = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: 0.72,
        metalness: 0.22,
      });
      const bronzeMat = new THREE.MeshStandardMaterial({
        color: 0x9b824d,
        roughness: 0.42,
        metalness: 0.65,
      });
      const runeMat = new THREE.MeshStandardMaterial({
        color: def.accent,
        emissive: def.accent,
        emissiveIntensity: 0.45,
        roughness: 0.25,
        metalness: 0.2,
      });

      // Rotating sub-group around local Y axle
      const rotor = new THREE.Group();
      group.add(rotor);

      // Carved stone tire cylinder
      const tire = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.96, r * 0.96, w, 20),
        stoneMat
      );
      rotor.add(tire);

      // 12 carved stone treads around perimeter
      const treadGeo = new THREE.BoxGeometry(0.14, w * 0.92, 0.12);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const tread = new THREE.Mesh(treadGeo, stoneMat);
        tread.position.set(Math.cos(a) * (r * 0.95), 0, Math.sin(a) * (r * 0.95));
        tread.rotation.y = -a;
        rotor.add(tread);
      }

      // Antique bronze rim rings & spokes on both sides
      const rimGeo = new THREE.TorusGeometry(r * 0.68, 0.055, 8, 20);
      const spokeGeo = new THREE.BoxGeometry(r * 1.32, 0.06, 0.1);
      for (const ySign of [-1, 1]) {
        const rim = new THREE.Mesh(rimGeo, bronzeMat);
        rim.rotation.x = Math.PI * 0.5;
        rim.position.y = ySign * (w * 0.5 + 0.01);
        rotor.add(rim);

        for (let s = 0; s < 3; s++) {
          const spoke = new THREE.Mesh(spokeGeo, bronzeMat);
          spoke.position.y = ySign * (w * 0.5 + 0.015);
          spoke.rotation.y = (s / 3) * Math.PI;
          rotor.add(spoke);
        }
      }

      // Glowing cyan Zonai rune hub core
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.3, r * 0.3, w + 0.09, 12),
        runeMat
      );
      rotor.add(hub);

      subParts.rotor = rotor;
      subParts.glowMat = runeMat;
    } else if (typeId === 'fan') {
      const r = def.radius;
      const len = def.length;
      const housingMat = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: 0.58,
        metalness: 0.38,
      });
      const bronzeMat = new THREE.MeshStandardMaterial({
        color: 0xa68a52,
        roughness: 0.38,
        metalness: 0.68,
      });
      const tealGlowMat = new THREE.MeshStandardMaterial({
        color: def.accent,
        emissive: def.accent,
        emissiveIntensity: 0.55,
        roughness: 0.2,
        metalness: 0.15,
      });
      const bladeMat = new THREE.MeshStandardMaterial({
        color: 0x628088,
        roughness: 0.35,
        metalness: 0.65,
      });

      // Outer open-ended Zonai turbine barrel (local Y = thrust axis, pushes toward +Y)
      const shroud = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r * 0.96, len, 18, 1, true),
        housingMat
      );
      shroud.material.side = THREE.DoubleSide;
      group.add(shroud);

      // Thick ornamental rim collars at +Y (forward/intake) and -Y (exhaust)
      const frontRim = new THREE.Mesh(
        new THREE.TorusGeometry(r * 0.97, 0.065, 8, 20),
        bronzeMat
      );
      frontRim.rotation.x = Math.PI * 0.5;
      frontRim.position.y = len * 0.46;
      group.add(frontRim);

      const backRim = new THREE.Mesh(
        new THREE.TorusGeometry(r * 0.94, 0.06, 8, 20),
        bronzeMat
      );
      backRim.rotation.x = Math.PI * 0.5;
      backRim.position.y = -len * 0.46;
      group.add(backRim);

      // Glowing teal Zonai energy ring
      const glowRing = new THREE.Mesh(
        new THREE.TorusGeometry(r * 0.84, 0.045, 8, 20),
        tealGlowMat
      );
      glowRing.rotation.x = Math.PI * 0.5;
      glowRing.position.y = len * 0.32;
      group.add(glowRing);

      // Rear exhaust glow ring
      const exhaustRing = new THREE.Mesh(
        new THREE.TorusGeometry(r * 0.78, 0.035, 8, 20),
        tealGlowMat
      );
      exhaustRing.rotation.x = Math.PI * 0.5;
      exhaustRing.position.y = -len * 0.35;
      group.add(exhaustRing);

      // Animated 4-blade spinning rotor
      const rotor = new THREE.Group();
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.22, r * 0.22, len * 0.68, 10),
        bronzeMat
      );
      rotor.add(hub);

      const bladeGeo = new THREE.BoxGeometry(r * 0.72, 0.045, 0.22);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const holder = new THREE.Group();
        holder.rotation.y = a;
        const blade = new THREE.Mesh(bladeGeo, bladeMat);
        blade.position.x = r * 0.46;
        blade.rotation.x = 0.42;
        holder.add(blade);
        rotor.add(holder);
      }
      group.add(rotor);

      subParts.rotor = rotor;
      subParts.glowMat = tealGlowMat;
    } else if (typeId === 'rocket') {
      const r = def.radius;
      const len = def.length;
      const bodyMat = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: 0.45,
        metalness: 0.52,
      });
      const brassMat = new THREE.MeshStandardMaterial({
        color: 0xc29c55,
        roughness: 0.35,
        metalness: 0.75,
      });
      const nozzleGlowMat = new THREE.MeshStandardMaterial({
        color: def.accent,
        emissive: 0xff5511,
        emissiveIntensity: 0.6,
        roughness: 0.3,
        metalness: 0.3,
      });

      // Main cylindrical hull along local Y
      const hullLen = len * 0.62;
      const hull = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.92, r, hullLen, 14),
        bodyMat
      );
      hull.position.y = -len * 0.04;
      group.add(hull);

      // Pointed nose cone at +Y (thrust direction)
      const nose = new THREE.Mesh(
        new THREE.ConeGeometry(r * 0.92, len * 0.34, 14),
        brassMat
      );
      nose.position.y = hullLen * 0.5 - len * 0.04 + len * 0.17;
      group.add(nose);

      // Brass reinforcement bands
      const bandGeo = new THREE.CylinderGeometry(r * 1.03, r * 1.03, 0.08, 14);
      for (const yOff of [-len * 0.24, len * 0.12]) {
        const band = new THREE.Mesh(bandGeo, brassMat);
        band.position.y = yOff;
        group.add(band);
      }

      // 3 swept aerodynamic tail fins
      const finGeo = new THREE.BoxGeometry(0.05, 0.42, 0.24);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const finHolder = new THREE.Group();
        finHolder.rotation.y = a;
        const fin = new THREE.Mesh(finGeo, brassMat);
        fin.position.set(0, -len * 0.28, r * 1.12);
        fin.rotation.x = 0.25;
        finHolder.add(fin);
        group.add(finHolder);
      }

      // Glowing orange exhaust nozzle at -Y
      const nozzle = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.68, r * 0.95, len * 0.18, 12),
        nozzleGlowMat
      );
      nozzle.position.y = -len * 0.42;
      group.add(nozzle);

      // Dynamic flame cone (outer orange + inner white-yellow core), hidden until active
      const flameGroup = new THREE.Group();
      flameGroup.position.y = -len * 0.52;
      const outerFlame = new THREE.Mesh(
        new THREE.ConeGeometry(r * 0.85, 1.85, 10),
        new THREE.MeshBasicMaterial({
          color: 0xff6b1a,
          transparent: true,
          opacity: 0.88,
        })
      );
      outerFlame.rotation.x = Math.PI; // point downward (-Y)
      outerFlame.position.y = -0.92;
      const innerFlame = new THREE.Mesh(
        new THREE.ConeGeometry(r * 0.46, 1.2, 8),
        new THREE.MeshBasicMaterial({
          color: 0xfff2a6,
          transparent: true,
          opacity: 0.95,
        })
      );
      innerFlame.rotation.x = Math.PI;
      innerFlame.position.y = -0.58;
      flameGroup.add(outerFlame, innerFlame);
      flameGroup.visible = false;
      group.add(flameGroup);

      subParts.flame = flameGroup;
      subParts.glowMat = nozzleGlowMat;
    } else if (typeId === 'boulder') {
      const r = def.radius;
      const geo = new THREE.IcosahedronGeometry(r, 1);
      const posAttr = geo.attributes.position;
      const colors = new Float32Array(posAttr.count * 3);
      const granite = new THREE.Color(def.color);
      const darkGranite = new THREE.Color(0x555e68);
      const snow = new THREE.Color(def.accent);
      const tmp = new THREE.Color();

      for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i);
        const vy = posAttr.getY(i);
        const vz = posAttr.getZ(i);
        // Deterministic faceted craggy granite displacement
        const n =
          Math.sin(vx * 3.7 + propId * 1.9) *
            Math.cos(vy * 4.3 - propId * 0.7) *
            Math.sin(vz * 3.1 + propId * 2.3);
        const scale = 0.88 + 0.2 * (n * 0.5 + 0.5);
        posAttr.setXYZ(i, vx * scale, vy * scale, vz * scale);

        const ny = vy / r;
        if (ny > 0.42) {
          const snowBlend = clamp((ny - 0.42) / 0.45, 0, 1);
          tmp.copy(granite).lerp(snow, snowBlend * 0.92);
        } else {
          const shade = clamp((ny + 1) * 0.5, 0, 1);
          tmp.copy(darkGranite).lerp(granite, shade);
        }
        colors[i * 3] = tmp.r;
        colors[i * 3 + 1] = tmp.g;
        colors[i * 3 + 2] = tmp.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();

      const rockMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.05,
        flatShading: true,
      });
      const rock = new THREE.Mesh(geo, rockMat);
      group.add(rock);
    } else if (typeId === 'barrel') {
      const r = def.radius;
      const len = def.length;
      const redWoodMat = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: 0.72,
        metalness: 0.06,
      });
      const ironMat = new THREE.MeshStandardMaterial({
        color: 0x2c3035,
        roughness: 0.42,
        metalness: 0.78,
      });
      const warnMat = new THREE.MeshStandardMaterial({
        color: def.accent,
        emissive: 0xff6600,
        emissiveIntensity: 0.65,
        roughness: 0.3,
        metalness: 0.2,
      });

      // Barrel body (slight mid-bulge via 3 stacked tapered cylinders)
      const mid = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.02, r * 1.02, len * 0.52, 14),
        redWoodMat
      );
      const topHalf = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.9, r * 1.02, len * 0.24, 14),
        redWoodMat
      );
      topHalf.position.y = len * 0.38;
      const botHalf = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.02, r * 0.9, len * 0.24, 14),
        redWoodMat
      );
      botHalf.position.y = -len * 0.38;
      group.add(mid, topHalf, botHalf);

      // Forged iron hoops
      const hoopGeo = new THREE.CylinderGeometry(r * 1.04, r * 1.04, 0.075, 14);
      for (const yOff of [-len * 0.33, len * 0.33]) {
        const hoop = new THREE.Mesh(hoopGeo, ironMat);
        hoop.position.y = yOff;
        group.add(hoop);
      }

      // Glowing explosive warning band around the waist
      const warnBand = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.05, r * 1.05, 0.14, 14),
        warnMat
      );
      group.add(warnBand);

      subParts.glowMat = warnMat;
    }

    // Tag all child meshes for Raycaster prop identification & shadow casting
    group.userData.propId = propId;
    group.traverse((obj) => {
      obj.userData.propId = propId;
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    return { group, subParts };
  }

  /**
   * Populate the Ocean Himalayas with immediately playable contraptions & sandbox parts.
   */
  spawnStarterContraptions() {
    this._spawningStarters = true;
    try {
      // 1. Beach Wooden Raft floating gently in the shallow coral bay right by beach_raft
      // Water depth at (-5, 146) is ~ -1.35m, just a few steps off the sandy shore
      this._spawnBeachRaft(-5, 146);

      // 2. Coastal Starter Buggy near bay_camp (-42, 186)
      this._spawnCoastalBuggy(-42, 186);

      // 3. Cliffside Boulders & Barrels at waterfall_cliff (92, 88) and main_summit (16, -100)
      this._spawnCliffsideHazards();

      // 4. Alpine Rocket Sled near alpine_ruins (14, 10)
      this._spawnAlpineRocketSled(14, 10);

      // 5. Spare Parts Pile near bay_camp (-58, 192) ready for Ultrahand building
      this._spawnSparePartsPile(-58, 192);
    } finally {
      this._spawningStarters = false;
    }
  }

  _spawnBeachRaft(cx, cz) {
    const baseY = 0.55;
    // Rotate logs so cylinder local Y lies horizontally along Z
    const logQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI * 0.5
    );
    const logs = [];
    for (const xOff of [-0.78, 0, 0.78]) {
      const log = this.spawnProp('log', { x: cx + xOff, y: baseY, z: cz }, logQuat);
      if (log) logs.push(log);
    }

    // 2 cedar planks laid transversely across the 3 logs
    const plankF = this.spawnProp('plank', { x: cx, y: baseY + 0.44, z: cz - 0.85 });
    const plankB = this.spawnProp('plank', { x: cx, y: baseY + 0.44, z: cz + 0.85 });

    // Stern turbine fan facing forward (-Z) with slight upward planing trim so the bow rides high on waves
    const fanQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      -Math.PI * 0.43
    );
    const fan = this.spawnProp(
      'fan',
      { x: cx, y: baseY + 0.92, z: cz + 1.48 },
      fanQuat
    );

    // Weld raft rigidly together (silent during initial world setup)
    const silent = true;
    if (logs.length === 3) {
      this.weldProps(logs[0], logs[1], silent);
      this.weldProps(logs[1], logs[2], silent);
      if (plankF) {
        this.weldProps(plankF, logs[0], silent);
        this.weldProps(plankF, logs[1], silent);
        this.weldProps(plankF, logs[2], silent);
      }
      if (plankB) {
        this.weldProps(plankB, logs[0], silent);
        this.weldProps(plankB, logs[1], silent);
        this.weldProps(plankB, logs[2], silent);
      }
    }
    if (plankF && plankB) {
      this.weldProps(plankF, plankB, silent);
    }
    if (fan && plankB) {
      this.weldProps(fan, plankB, silent);
    }
  }

  _spawnCoastalBuggy(cx, cz) {
    const groundY = getTerrainHeight(cx, cz);
    const baseY = groundY + 1.35;

    // Chassis plank rotated 90° around Y so its 3.2m length runs front-to-back along Z
    // Facing -Z (north toward the bay & coastal slopes)
    const chassisQuat = new THREE.Quaternion().setFromAxisAngle(
      WORLD_UP,
      Math.PI * 0.5
    );
    const chassis = this.spawnProp('plank', { x: cx, y: baseY, z: cz }, chassisQuat);

    // 4 Zonai powered wheels with local +Y axle pointing to +X:
    // Rotating local +Y by -90 deg around Z aligns +Y -> +X!
    // Then cross(WORLD_UP, +X) = (0, 0, -1) = forward (-Z)!
    const wheelQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      -Math.PI * 0.5
    );
    const wheelOffsets = [
      { x: -1.02, y: -0.22, z: -1.12 },
      { x: 1.02, y: -0.22, z: -1.12 },
      { x: -1.02, y: -0.22, z: 1.12 },
      { x: 1.02, y: -0.22, z: 1.12 },
    ];
    const wheels = [];
    for (const off of wheelOffsets) {
      const w = this.spawnProp(
        'wheel',
        { x: cx + off.x, y: baseY + off.y, z: cz + off.z },
        wheelQuat
      );
      if (w) wheels.push(w);
    }

    // Rear booster fan facing forward (-Z)
    const fanQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      -Math.PI * 0.5
    );
    const fan = this.spawnProp(
      'fan',
      { x: cx, y: baseY + 0.68, z: cz + 1.48 },
      fanQuat
    );

    const silent = true;
    if (chassis) {
      for (const w of wheels) {
        this.weldProps(chassis, w, silent);
      }
      if (fan) {
        this.weldProps(chassis, fan, silent);
      }
    }
  }

  _spawnCliffsideHazards() {
    // Waterfall Cliff overlook (92, 88) — boulders & explosive barrels ready to cascade down
    const cliffSpots = [
      { type: 'boulder', x: 92, z: 88, dy: 1.15 },
      { type: 'boulder', x: 89.2, z: 91.2, dy: 1.15 },
      { type: 'boulder', x: 95.0, z: 90.5, dy: 1.15 },
      { type: 'barrel', x: 90.8, z: 89.4, dy: 0.62 },
      { type: 'barrel', x: 93.4, z: 89.2, dy: 0.62 },
    ];

    // Main Summit ridge near (16, -100) & flatter crown edge (13.5, -104)
    const summitSpots = [
      { type: 'boulder', x: 14.5, z: -102.5, dy: 1.2 },
      { type: 'boulder', x: 16.0, z: -100.0, dy: 1.2 },
      { type: 'boulder', x: 11.8, z: -103.8, dy: 1.2 },
      { type: 'barrel', x: 15.2, z: -101.2, dy: 0.65 },
      { type: 'barrel', x: 13.4, z: -102.0, dy: 0.65 },
    ];

    for (const s of [...cliffSpots, ...summitSpots]) {
      const y = getTerrainHeight(s.x, s.z) + s.dy;
      this.spawnProp(s.type, { x: s.x, y, z: s.z });
    }
  }

  _spawnAlpineRocketSled(cx, cz) {
    const groundY = getTerrainHeight(cx, cz);
    const baseY = groundY + 0.45;

    // Plank sled oriented along Z (facing +Z out over the glacial amphitheater & ocean bay)
    const sledQuat = new THREE.Quaternion().setFromAxisAngle(
      WORLD_UP,
      Math.PI * 0.5
    );
    const plank = this.spawnProp('plank', { x: cx, y: baseY, z: cz }, sledQuat);
    if (plank) {
      plank.collider.setFriction(1.25);
    }

    // 2 rockets mounted symmetrically at the sled's longitudinal CoM, angled skyward & forward (+Z)!
    const rocketQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI * 0.16
    );
    const rLeft = this.spawnProp(
      'rocket',
      { x: cx - 0.85, y: baseY + 0.35, z: cz + 0.1 },
      rocketQuat
    );
    const rRight = this.spawnProp(
      'rocket',
      { x: cx + 0.85, y: baseY + 0.35, z: cz + 0.1 },
      rocketQuat
    );

    const silent = true;
    if (plank && rLeft) this.weldProps(plank, rLeft, silent);
    if (plank && rRight) this.weldProps(plank, rRight, silent);
  }

  _spawnSparePartsPile(cx, cz) {
    const horizontalLogQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI * 0.5
    );
    const uprightWheelQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      -Math.PI * 0.5
    );

    const parts = [
      { type: 'plank', dx: -2.2, dz: -1.8, dy: 0.45, q: null },
      { type: 'plank', dx: -2.2, dz: 0.4, dy: 0.45, q: null },
      { type: 'log', dx: 1.8, dz: -2.4, dy: 0.65, q: horizontalLogQ },
      { type: 'wheel', dx: 1.5, dz: 0.2, dy: 0.9, q: uprightWheelQ },
      { type: 'wheel', dx: 3.1, dz: 0.8, dy: 0.9, q: uprightWheelQ },
      { type: 'fan', dx: -0.2, dz: 2.4, dy: 0.55, q: null },
      { type: 'rocket', dx: 1.8, dz: 2.5, dy: 1.0, q: null },
      { type: 'barrel', dx: -3.2, dz: 2.5, dy: 0.72, q: null },
    ];

    for (const p of parts) {
      const x = cx + p.dx;
      const z = cz + p.dz;
      const y = getTerrainHeight(x, z) + p.dy;
      this.spawnProp(p.type, { x, y, z }, p.q);
    }
  }

  /**
   * Rigidly weld two props at their exact current world alignment (TotK Ultrahand style).
   */
  weldProps(propA, propB, silent = false) {
    if (!propA || !propB || propA === propB) return null;
    if (propA._destroyed || propB._destroyed) return null;

    // Prevent duplicate weld between same pair
    for (let i = 0; i < this.joints.length; i++) {
      const j = this.joints[i];
      if (
        (j.propA === propA && j.propB === propB) ||
        (j.propA === propB && j.propB === propA)
      ) {
        return j;
      }
    }

    const tA = propA.body.translation();
    const rA = propA.body.rotation();
    const tB = propB.body.translation();
    const rB = propB.body.rotation();

    const pA = _v1.set(tA.x, tA.y, tA.z);
    const pB = _v2.set(tB.x, tB.y, tB.z);
    const qA = _q1.set(rA.x, rA.y, rA.z, rA.w);
    const qB = _q2.set(rB.x, rB.y, rB.z, rB.w);

    // Midpoint in world space
    const midWorld = _v3.copy(pA).add(pB).multiplyScalar(0.5);

    const qAInv = _q3.copy(qA).invert();
    const anchor1 = new THREE.Vector3().copy(midWorld).sub(pA).applyQuaternion(qAInv);

    const qBInv = new THREE.Quaternion().copy(qB).invert();
    const anchor2 = new THREE.Vector3().copy(midWorld).sub(pB).applyQuaternion(qBInv);

    // Zero-drift relative frames: qA * frame1 === qB * frame2
    const frame1 = { x: 0, y: 0, z: 0, w: 1 };
    const frame2Q = qBInv.clone().multiply(qA).normalize();
    const frame2 = { x: frame2Q.x, y: frame2Q.y, z: frame2Q.z, w: frame2Q.w };

    const jointData = this.RAPIER.JointData.fixed(
      { x: anchor1.x, y: anchor1.y, z: anchor1.z },
      frame1,
      { x: anchor2.x, y: anchor2.y, z: anchor2.z },
      frame2
    );

    const joint = this.world.createImpulseJoint(jointData, propA.body, propB.body, true);
    // Disable internal contact fighting between tightly welded overlapping parts
    if (typeof joint.setContactsEnabled === 'function') {
      joint.setContactsEnabled(false);
    }

    // Glowing emerald Zonai glue-orb mesh connecting the weld midpoint
    const glueMesh = new THREE.Group();
    const outerOrb = new THREE.Mesh(this._glueGeo, this._glueMat);
    outerOrb.scale.set(1.15, 0.82, 1.15);
    const coreOrb = new THREE.Mesh(this._glueCoreGeo, this._glueCoreMat);
    glueMesh.add(outerOrb, coreOrb);
    glueMesh.position.copy(midWorld);
    if (this.scene) {
      this.scene.add(glueMesh);
    }

    const record = {
      id: this._nextJointId++,
      propA,
      propB,
      joint,
      anchor1,
      anchor2,
      glueMesh,
    };
    this.joints.push(record);

    if (!silent) {
      this.emitSound('weld', 1.0, midWorld.clone());
    }
    return record;
  }

  /** Remove all welded joints attached to `prop` */
  unweldProp(prop, silent = false) {
    if (!prop) return 0;

    let removed = 0;
    const remaining = [];
    const pos = prop.body ? prop.body.translation() : { x: 0, y: 0, z: 0 };

    for (let i = 0; i < this.joints.length; i++) {
      const rec = this.joints[i];
      if (rec.propA === prop || rec.propB === prop) {
        try {
          this.world.removeImpulseJoint(rec.joint, true);
        } catch (_) {
          // Joint already removed
        }
        if (rec.glueMesh && this.scene) {
          this.scene.remove(rec.glueMesh);
        }
        if (rec.propA && !rec.propA._destroyed) rec.propA.body.wakeUp();
        if (rec.propB && !rec.propB._destroyed) rec.propB.body.wakeUp();
        removed++;
      } else {
        remaining.push(rec);
      }
    }

    this.joints = remaining;
    if (removed > 0 && !silent) {
      this.emitSound('unweld', 0.9, new THREE.Vector3(pos.x, pos.y, pos.z));
    }
    return removed;
  }

  /** BFS over welded joints to retrieve the entire connected contraption assembly */
  getConnectedAssembly(rootProp) {
    if (!rootProp || rootProp._destroyed) return [];
    const visited = new Set([rootProp]);
    const queue = [rootProp];
    while (queue.length > 0) {
      const curr = queue.shift();
      for (let i = 0; i < this.joints.length; i++) {
        const j = this.joints[i];
        let neighbor = null;
        if (j.propA === curr) neighbor = j.propB;
        else if (j.propB === curr) neighbor = j.propA;
        if (neighbor && !neighbor._destroyed && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    return Array.from(visited);
  }

  /**
   * Find the nearest activatable contraption (or any prop welded to an activatable part)
   * within `radius` and toggle the entire assembly together.
   */
  toggleActivateNearby(pos, radius = 14) {
    const px = pos.x ?? 0;
    const py = pos.y ?? 0;
    const pz = pos.z ?? 0;
    const r2 = radius * radius;

    let bestProp = null;
    let bestDist2 = Infinity;

    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (p._destroyed) continue;
      const t = p.body.translation();
      const dx = t.x - px;
      const dy = t.y - py;
      const dz = t.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2 || d2 >= bestDist2) continue;

      // Check if this prop or any part in its welded assembly is activatable
      if (p.def.activatable) {
        bestProp = p;
        bestDist2 = d2;
      } else {
        const assembly = this.getConnectedAssembly(p);
        if (assembly.some((part) => part.def.activatable)) {
          bestProp = p;
          bestDist2 = d2;
        }
      }
    }

    if (!bestProp) return null;
    return this.togglePropActive(bestProp);
  }

  /** Toggle active state across `prop`'s entire welded assembly */
  togglePropActive(prop) {
    if (!prop || prop._destroyed) return null;
    const assembly = this.getConnectedAssembly(prop);

    // Separate explosives from reusable contraption parts
    const explosives = assembly.filter((p) => p.def.explosive && !p._destroyed);
    const machines = assembly.filter(
      (p) => p.def.activatable && !p.def.explosive && !p._destroyed
    );

    let newActive = false;
    if (machines.length > 0) {
      const anyOn = machines.some((p) => p.active);
      newActive = !anyOn;

      let playedFan = false;
      let playedRocket = false;

      for (const m of machines) {
        m.body.wakeUp();
        if (m.typeId === 'rocket') {
          if (newActive) {
            m.active = true;
            m.burnLeft = m.def.burnDuration || 5.5;
            m.cooldownLeft = 0;
            if (!playedRocket) {
              const t = m.body.translation();
              this.emitSound('rocket', 1.0, new THREE.Vector3(t.x, t.y, t.z));
              playedRocket = true;
            }
          } else {
            m.active = false;
          }
        } else if (m.typeId === 'fan') {
          m.active = newActive;
          if (newActive && !playedFan) {
            const t = m.body.translation();
            this.emitSound('fan', 0.9, new THREE.Vector3(t.x, t.y, t.z));
            playedFan = true;
          }
        } else if (m.typeId === 'wheel') {
          m.active = newActive;
          // Lower rolling resistance when powered; restore high parking-brake friction when off
          m.collider.setFriction(newActive ? 0.08 : m.def.friction);
          if (newActive && !playedFan) {
            const t = m.body.translation();
            this.emitSound('fan', 0.6, new THREE.Vector3(t.x, t.y, t.z));
            playedFan = true;
          }
        }
      }

      // Wake all parts in the contraption so it responds immediately
      for (const part of assembly) {
        if (!part._destroyed) part.body.wakeUp();
      }
    }

    // Detonate any explosive barrel in the activated assembly
    for (const barrel of explosives) {
      this.detonateBarrel(barrel);
    }

    return { prop, assembly, active: newActive };
  }

  /** Detonate an explosive barrel with radial blast impulse, chain reactions & fireball VFX */
  detonateBarrel(prop) {
    if (!prop || prop._destroyed) return;
    prop._destroyed = true;

    const t = prop.body.translation();
    const blastPos = new THREE.Vector3(t.x, t.y, t.z);
    const blastRadius = prop.def.blastRadius || 11;
    const blastImpulse = prop.def.blastImpulse || 460;

    // Remove joints, mesh, and rigidbody cleanly
    this.unweldProp(prop);
    if (prop.mesh && this.scene) {
      this.scene.remove(prop.mesh);
    }
    this.propById.delete(prop.id);
    this.propByCollider.delete(prop.collider.handle);
    this.propByBody.delete(prop.body.handle);
    const idx = this.props.indexOf(prop);
    if (idx !== -1) this.props.splice(idx, 1);

    try {
      this.world.removeRigidBody(prop.body);
    } catch (_) {
      // Body already removed
    }

    // Apply radial explosion impulse to all nearby rigidbodies & trigger chain detonations
    for (let i = 0; i < this.props.length; i++) {
      const other = this.props[i];
      if (other._destroyed) continue;
      const ot = other.body.translation();
      const dx = ot.x - blastPos.x;
      const dy = ot.y - blastPos.y;
      const dz = ot.z - blastPos.z;
      const dist = Math.hypot(dx, dy, dz);

      if (dist < blastRadius) {
        const falloff = Math.pow(1 - dist / blastRadius, 1.25);
        const invDist = dist > 0.05 ? 1 / dist : 1;
        const mag = blastImpulse * falloff;

        other.body.wakeUp();
        other.body.applyImpulse(
          {
            x: dx * invDist * mag,
            y: (dy * invDist + 0.55) * mag,
            z: dz * invDist * mag,
          },
          true
        );

        // Staggered chain detonation on nearby barrels
        if (other.def.explosive && dist < blastRadius * 0.88) {
          this._queueDetonation(other, 0.08 + dist * 0.015);
        }
      }
    }

    this._spawnExplosionVFX(blastPos);
    this.emitSound('explosion', 1.0, blastPos);
  }

  _queueDetonation(prop, delaySec) {
    if (!prop || prop._destroyed) return;
    if (this._pendingDetonations.some((d) => d.prop === prop)) return;
    this._pendingDetonations.push({ prop, timer: delaySec });
  }

  /** Advance physics simulation, buoyancy, contraptions, visuals, and particles */
  step(dt, elapsedTime, getWaveHeight) {
    if (!this.world) return;
    const clampedDt = Math.min(Math.max(dt, 0), 0.05);
    this._elapsed = elapsedTime;

    // 1. Process staggered chain detonations
    if (this._pendingDetonations.length > 0) {
      for (let i = this._pendingDetonations.length - 1; i >= 0; i--) {
        const item = this._pendingDetonations[i];
        item.timer -= clampedDt;
        if (item.timer <= 0) {
          this._pendingDetonations.splice(i, 1);
          this.detonateBarrel(item.prop);
        }
      }
    }

    // 2. Fixed-timestep physics substeps
    this._accumulator += clampedDt;
    let substeps = 0;
    while (this._accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
      this._applyForces(FIXED_DT, elapsedTime, getWaveHeight);
      this.world.step(this.eventQueue);
      this._processCollisions();
      this._accumulator -= FIXED_DT;
      substeps++;
    }
    if (substeps === MAX_SUBSTEPS && this._accumulator > FIXED_DT) {
      this._accumulator = 0;
    }

    // 3. Sync Three.js meshes, animate rotors/flames/glue, and update particles
    this._syncVisuals(clampedDt, elapsedTime);
    this._updateParticles(clampedDt);
  }

  _applyForces(dt, elapsedTime, getWaveHeight) {
    const absG = Math.abs(WORLD_CONFIG.GRAVITY);

    for (let i = 0; i < this.props.length; i++) {
      const prop = this.props[i];
      if (prop._destroyed) continue;
      const body = prop.body;

      // Cooldown tick for rockets
      if (prop.cooldownLeft > 0) {
        prop.cooldownLeft = Math.max(0, prop.cooldownLeft - dt);
      }

      body.resetForces(false);
      body.resetTorques(false);

      const t = body.translation();
      const r = body.rotation();
      const lv = body.linvel();
      const av = body.angvel();
      const mass = body.mass();

      _v1.set(t.x, t.y, t.z);
      _q1.set(r.x, r.y, r.z, r.w);

      // --- A. Multi-Point Water Buoyancy & Hydrodynamic Drag ---
      const pts = prop.buoyancyPoints;
      const nPts = pts.length;
      let submergedCount = 0;
      let totalSubDepth = 0;
      const hullHalf =
        prop.def.shape === 'box'
          ? prop.def.size[1] * 0.5
          : prop.def.radius || 0.4;
      const depthScale = Math.max(0.45, hullHalf * 2.0);

      for (let p = 0; p < nPts; p++) {
        _v2.copy(pts[p]).applyQuaternion(_q1).add(_v1);
        const waveY =
          typeof getWaveHeight === 'function'
            ? getWaveHeight(_v2.x, _v2.z, elapsedTime)
            : WORLD_CONFIG.SEA_LEVEL;

        const depth = waveY - (_v2.y - hullHalf);
        if (depth > 0) {
          submergedCount++;
          const subFactor = clamp(depth / depthScale, 0, 1.5);
          totalSubDepth += subFactor;

          const buoyForce = (mass * absG * prop.def.buoyancy * subFactor) / nPts;
          body.addForceAtPoint(
            { x: 0, y: buoyForce, z: 0 },
            { x: _v2.x, y: _v2.y, z: _v2.z },
            false
          );
        }
      }

      const inWater = submergedCount > 0;
      if (inWater) {
        const subRatio = clamp(totalSubDepth / nPts, 0.12, 1.2);
        // Smooth horizontal glide + strong vertical/angular damping so rafts sail briskly and stay rock-stable
        const horizDrag = 0.65 * subRatio * mass;
        const vertDrag = 4.2 * subRatio * mass;
        body.addForce(
          {
            x: -lv.x * horizDrag,
            y: -lv.y * vertDrag,
            z: -lv.z * horizDrag,
          },
          false
        );
        const angDrag = 2.8 * subRatio * mass * 0.25;
        body.addTorque(
          {
            x: -av.x * angDrag,
            y: -av.y * angDrag,
            z: -av.z * angDrag,
          },
          false
        );

        // Emit splash on water entry
        if (!prop.wasInWater && lv.y < -1.4) {
          const splashIntensity = clamp(Math.abs(lv.y) / 14, 0.2, 1.0);
          this.emitSound('splash', splashIntensity, _v1.clone());
          this._spawnSplashVFX(_v1, splashIntensity);
        }
      }
      prop.wasInWater = inWater;

      // --- B. Active Contraption Propulsion Forces ---
      if (!prop.active) continue;

      if (prop.typeId === 'fan') {
        // Thrust along local +Y
        _v3.copy(LOCAL_Y).applyQuaternion(_q1);
        const thrust = prop.def.thrustForce || 560;
        body.addForce(
          { x: _v3.x * thrust, y: _v3.y * thrust, z: _v3.z * thrust },
          true
        );
      } else if (prop.typeId === 'rocket') {
        if (prop.burnLeft > 0) {
          prop.burnLeft -= dt;
          _v3.copy(LOCAL_Y).applyQuaternion(_q1);
          const thrust = prop.def.thrustForce || 1450;
          body.addForce(
            { x: _v3.x * thrust, y: _v3.y * thrust, z: _v3.z * thrust },
            true
          );
          if (prop.burnLeft <= 0) {
            prop.burnLeft = 0;
            prop.active = false;
            prop.cooldownLeft = 1.2;
          }
        } else {
          prop.active = false;
        }
      } else if (prop.typeId === 'wheel') {
        // Axle is local +Y; forward drive direction = cross(WORLD_UP, axleWorld)
        _v3.copy(LOCAL_Y).applyQuaternion(_q1).normalize();
        _v4.crossVectors(WORLD_UP, _v3);
        const driveLen = _v4.length();

        if (driveLen > 0.15) {
          _v4.divideScalar(driveLen);

          // Ground contact check (terrain/floating island surface OR collider contact)
          const surfY = this.getSurfaceHeightAt(t.x, t.z, t.y);
          let grounded = t.y - prop.def.radius - 0.55 <= surfY;
          if (!grounded) {
            this.world.contactPairsWith(prop.collider, () => {
              grounded = true;
            });
          }

          if (grounded) {
            const forwardSpeed = lv.x * _v4.x + lv.y * _v4.y + lv.z * _v4.z;
            const maxSpeed = 20.0;
            const speedFactor = clamp(1 - forwardSpeed / maxSpeed, 0, 1);
            const driveForce = (prop.def.torqueStrength || 220) * 2.35 * speedFactor;

            body.addForce(
              {
                x: _v4.x * driveForce,
                y: _v4.y * driveForce,
                z: _v4.z * driveForce,
              },
              true
            );

            // Mild lateral anti-skid damping along wheel axle
            const lateralSpeed = lv.x * _v3.x + lv.y * _v3.y + lv.z * _v3.z;
            const latDamp = -lateralSpeed * mass * 2.2;
            body.addForce(
              { x: _v3.x * latDamp, y: _v3.y * latDamp, z: _v3.z * latDamp },
              false
            );
          }

          // If wheel is solo (unwelded), apply real spin torque so it rolls away on its own!
          const isWelded = this.joints.some(
            (j) => j.propA === prop || j.propB === prop
          );
          if (!isWelded) {
            const spinTorque = -(prop.def.torqueStrength || 220) * 0.45;
            body.addTorque(
              {
                x: _v3.x * spinTorque,
                y: _v3.y * spinTorque,
                z: _v3.z * spinTorque,
              },
              true
            );
          }
        }
      }
    }
  }

  _processCollisions() {
    this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      if (!started) return;
      const p1 = this.propByCollider.get(handle1);
      const p2 = this.propByCollider.get(handle2);
      if (!p1 && !p2) return;

      const v1 = p1 && !p1._destroyed ? p1.body.linvel() : { x: 0, y: 0, z: 0 };
      const v2 = p2 && !p2._destroyed ? p2.body.linvel() : { x: 0, y: 0, z: 0 };
      const relSpeed = Math.hypot(v1.x - v2.x, v1.y - v2.y, v1.z - v2.z);

      if (relSpeed < 2.6) return;

      const primary = p1 || p2;
      if (this._elapsed - primary._lastImpactTime > 0.14) {
        primary._lastImpactTime = this._elapsed;
        const pt = primary.body.translation();
        const intensity = clamp((relSpeed - 2.2) / 14, 0.15, 1.0);
        this.emitSound('impact', intensity, new THREE.Vector3(pt.x, pt.y, pt.z));
      }

      // Hard impact detonates explosive barrels!
      if (relSpeed > 9.5) {
        if (p1 && p1.def.explosive && !p1._destroyed) {
          this._queueDetonation(p1, 0);
        }
        if (p2 && p2.def.explosive && !p2._destroyed) {
          this._queueDetonation(p2, 0);
        }
      }
    });
  }

  _syncVisuals(dt, elapsedTime) {
    // 1. Sync prop meshes & animate active Zonai sub-parts
    for (let i = 0; i < this.props.length; i++) {
      const prop = this.props[i];
      if (prop._destroyed) continue;
      const t = prop.body.translation();
      const r = prop.body.rotation();

      prop.mesh.position.set(t.x, t.y, t.z);
      prop.mesh.quaternion.set(r.x, r.y, r.z, r.w);

      if (prop.typeId === 'fan') {
        if (prop.subParts.rotor) {
          prop.subParts.rotor.rotation.y += (prop.active ? 22.0 : 0.8) * dt;
        }
        if (prop.subParts.glowMat) {
          prop.subParts.glowMat.emissiveIntensity = prop.active
            ? 1.5 + Math.sin(elapsedTime * 14) * 0.25
            : 0.4;
        }
        if (prop.active && elapsedTime - prop._lastParticleTime > 0.08) {
          prop._lastParticleTime = elapsedTime;
          this._spawnFanAirParticle(prop);
        }
      } else if (prop.typeId === 'rocket') {
        const burning = prop.active && prop.burnLeft > 0;
        if (prop.subParts.flame) {
          prop.subParts.flame.visible = burning;
          if (burning) {
            const flicker = 0.85 + Math.sin(elapsedTime * 55 + prop.id) * 0.25;
            prop.subParts.flame.scale.set(
              0.92 + Math.random() * 0.16,
              flicker,
              0.92 + Math.random() * 0.16
            );
          }
        }
        if (prop.subParts.glowMat) {
          prop.subParts.glowMat.emissiveIntensity = burning ? 2.2 : 0.45;
        }
        if (burning && elapsedTime - prop._lastParticleTime > 0.035) {
          prop._lastParticleTime = elapsedTime;
          this._spawnRocketSmokeParticle(prop);
        }
      } else if (prop.typeId === 'wheel') {
        if (prop.subParts.rotor && prop.active) {
          prop.subParts.rotor.rotation.y -= 11.5 * dt;
        }
        if (prop.subParts.glowMat) {
          prop.subParts.glowMat.emissiveIntensity = prop.active
            ? 1.45 + Math.sin(elapsedTime * 10) * 0.2
            : 0.35;
        }
      } else if (prop.typeId === 'barrel') {
        if (prop.subParts.glowMat) {
          prop.subParts.glowMat.emissiveIntensity =
            0.55 + Math.sin(elapsedTime * 5.0 + prop.id) * 0.25;
        }
      }
    }

    // 2. Sync emerald Zonai glue-orb visuals between welded props
    for (let i = 0; i < this.joints.length; i++) {
      const rec = this.joints[i];
      if (!rec.glueMesh || rec.propA._destroyed) continue;
      const tA = rec.propA.body.translation();
      const rA = rec.propA.body.rotation();
      _q1.set(rA.x, rA.y, rA.z, rA.w);
      _v1.copy(rec.anchor1).applyQuaternion(_q1).add(
        _v2.set(tA.x, tA.y, tA.z)
      );
      rec.glueMesh.position.copy(_v1);
      const pulse = 0.94 + Math.sin(elapsedTime * 4.5 + rec.id) * 0.08;
      rec.glueMesh.scale.setScalar(pulse);
    }
  }

  // --- Lightweight Procedural VFX Particles ---

  _spawnParticle(pos, vel, color, size, life, growRate = 0.5, gravityScale = 0) {
    if (!this.scene || this.particles.length > 140) return;
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this._particleGeo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(size);
    this.scene.add(mesh);

    this.particles.push({
      mesh,
      mat,
      vel: vel.clone(),
      size,
      life,
      maxLife: life,
      growRate,
      gravityScale,
    });
  }

  _spawnFanAirParticle(prop) {
    const t = prop.body.translation();
    const r = prop.body.rotation();
    _q1.set(r.x, r.y, r.z, r.w);
    // Exhaust blows toward -Y
    _v1.set(0, -1, 0).applyQuaternion(_q1);
    const spawnPos = new THREE.Vector3(
      t.x + _v1.x * 0.4 + (Math.random() - 0.5) * 0.45,
      t.y + _v1.y * 0.4 + (Math.random() - 0.5) * 0.45,
      t.z + _v1.z * 0.4 + (Math.random() - 0.5) * 0.45
    );
    const vel = _v1.clone().multiplyScalar(8.5 + Math.random() * 3.5);
    this._spawnParticle(spawnPos, vel, 0xcafbf5, 0.14, 0.32, 2.2, 0);
  }

  _spawnRocketSmokeParticle(prop) {
    const t = prop.body.translation();
    const r = prop.body.rotation();
    _q1.set(r.x, r.y, r.z, r.w);
    _v1.set(0, -1, 0).applyQuaternion(_q1);
    const spawnPos = new THREE.Vector3(
      t.x + _v1.x * 0.95 + (Math.random() - 0.5) * 0.22,
      t.y + _v1.y * 0.95 + (Math.random() - 0.5) * 0.22,
      t.z + _v1.z * 0.95 + (Math.random() - 0.5) * 0.22
    );
    const vel = _v1.clone().multiplyScalar(11 + Math.random() * 5);
    vel.x += (Math.random() - 0.5) * 2.2;
    vel.y += (Math.random() - 0.5) * 2.2;
    vel.z += (Math.random() - 0.5) * 2.2;

    const isSpark = Math.random() < 0.45;
    this._spawnParticle(
      spawnPos,
      vel,
      isSpark ? 0xff9b38 : 0xdde5ee,
      isSpark ? 0.18 : 0.26,
      isSpark ? 0.35 : 0.72,
      isSpark ? -0.4 : 2.1,
      isSpark ? 0.2 : -0.15
    );
  }

  _spawnSplashVFX(pos, intensity) {
    const count = Math.round(5 + intensity * 6);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = (1.5 + Math.random() * 4.5) * intensity;
      const vel = new THREE.Vector3(
        Math.cos(angle) * spd,
        (2.8 + Math.random() * 4.2) * intensity,
        Math.sin(angle) * spd
      );
      this._spawnParticle(
        new THREE.Vector3(pos.x, WORLD_CONFIG.SEA_LEVEL + 0.15, pos.z),
        vel,
        0xdcf8ff,
        0.16 + Math.random() * 0.14,
        0.55 + Math.random() * 0.25,
        0.8,
        0.75
      );
    }
  }

  _spawnExplosionVFX(pos) {
    // Central expanding flash fireball
    this._spawnParticle(pos, new THREE.Vector3(0, 0.8, 0), 0xfff3b0, 1.1, 0.38, 12.0, 0);
    this._spawnParticle(pos, new THREE.Vector3(0, 1.4, 0), 0xff5a1f, 0.9, 0.55, 9.5, -0.1);

    // 22 fiery embers & smoke plumes
    for (let i = 0; i < 22; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const spd = 6 + Math.random() * 14;
      const vel = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * spd,
        Math.abs(Math.cos(phi)) * spd + 3.5,
        Math.sin(phi) * Math.sin(theta) * spd
      );
      const roll = Math.random();
      const color = roll < 0.4 ? 0xff7722 : roll < 0.72 ? 0xffd059 : 0x4a4542;
      this._spawnParticle(
        pos,
        vel,
        color,
        0.28 + Math.random() * 0.35,
        0.65 + Math.random() * 0.55,
        roll >= 0.72 ? 2.4 : 0.4,
        roll >= 0.72 ? -0.18 : 0.55
      );
    }
  }

  _updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        if (this.scene) this.scene.remove(p.mesh);
        p.mat.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y += WORLD_CONFIG.GRAVITY * p.gravityScale * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      const frac = p.life / p.maxLife;
      const s = Math.max(0.02, p.size + (1 - frac) * p.growRate * p.size);
      p.mesh.scale.setScalar(s);
      p.mat.opacity = frac * 0.85;
    }
  }

  // --- Utility APIs for PlayerController, UltrahandSystem, and HUD ---

  getPropByColliderHandle(handle) {
    return this.propByCollider.get(handle) || null;
  }

  getPropCount() {
    return {
      props: this.props.length,
      joints: this.joints.length,
    };
  }

  /** Spawn a prop cleanly 4.5m in front of the player & safely above terrain */
  spawnPropInFrontOf(typeId, origin, forwardDir) {
    const def = PROP_CATALOG[typeId];
    if (!def) return null;

    const dir = new THREE.Vector3(forwardDir.x, forwardDir.y, forwardDir.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();

    const dist = 4.5;
    const x = origin.x + dir.x * dist;
    const z = origin.z + dir.z * dist;
    const desiredY = origin.y + Math.max(dir.y * dist, 0) + 1.3;
    const clearance = this._estimateHalfExtent(def) + 0.35;
    const minGroundY = this.getSurfaceHeightAt(x, z, desiredY + 2) + clearance;
    const y = Math.max(desiredY, minGroundY);

    // Align prop yaw nicely with player's horizontal facing direction
    const yaw = Math.atan2(dir.x, dir.z);
    const quat = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, yaw);

    // For fans, orient thrust along horizontal forward direction right out of the box!
    if (typeId === 'fan') {
      const pitchForward = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        Math.PI * 0.5
      );
      quat.multiply(pitchForward);
    }

    return this.spawnProp(typeId, { x, y, z }, quat);
  }

  /** Cleanly despawn a prop, removing its joints, physics body, and Three.js resources */
  _despawnProp(prop) {
    if (!prop || prop._destroyed) return false;
    prop._destroyed = true;

    if (this._heldProp === prop) {
      this._heldProp = null;
    }

    // Drop any queued detonation for this prop
    for (let i = this._pendingDetonations.length - 1; i >= 0; i--) {
      if (this._pendingDetonations[i].prop === prop) {
        this._pendingDetonations.splice(i, 1);
      }
    }

    this.unweldProp(prop, true);

    if (prop.mesh) {
      if (this.scene) {
        this.scene.remove(prop.mesh);
      }
      const disposedGeos = new Set();
      const disposedMats = new Set();
      prop.mesh.traverse((obj) => {
        if (obj.geometry && !disposedGeos.has(obj.geometry)) {
          disposedGeos.add(obj.geometry);
          obj.geometry.dispose();
        }
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (let m = 0; m < mats.length; m++) {
            const mat = mats[m];
            if (mat && !disposedMats.has(mat)) {
              disposedMats.add(mat);
              mat.dispose();
            }
          }
        }
      });
    }

    this.propById.delete(prop.id);
    if (prop.collider) this.propByCollider.delete(prop.collider.handle);
    if (prop.body) this.propByBody.delete(prop.body.handle);

    const idx = this.props.indexOf(prop);
    if (idx !== -1) this.props.splice(idx, 1);

    try {
      if (prop.body && this.world) {
        this.world.removeRigidBody(prop.body);
      }
    } catch (_) {
      // Body already removed
    }

    return true;
  }

  /**
   * Soft safety cap on total dynamic props (75 mobile / 110 desktop).
   * Gracefully despawns oldest unheld, non-starter loose props first so mobile RAM
   * and physics FPS stay smooth no matter how much the player spawns.
   */
  _enforcePropCap(incomingCount = 1) {
    const cap = this.maxProps || 110;
    while (this.props.length + incomingCount > cap) {
      // Build set of props currently held (or welded to a held prop)
      const heldSet = new Set();
      if (this._heldProp && !this._heldProp._destroyed) {
        const heldAssembly = this.getConnectedAssembly(this._heldProp);
        for (let i = 0; i < heldAssembly.length; i++) {
          heldSet.add(heldAssembly[i]);
        }
      }
      for (let i = 0; i < this.props.length; i++) {
        const p = this.props[i];
        if (p._isHeld && !p._destroyed && !heldSet.has(p)) {
          const assembly = this.getConnectedAssembly(p);
          for (let j = 0; j < assembly.length; j++) {
            heldSet.add(assembly[j]);
          }
        }
      }

      // Build set of welded props so loose props are always preferred for pruning
      const weldedSet = new Set();
      for (let i = 0; i < this.joints.length; i++) {
        const j = this.joints[i];
        if (j.propA) weldedSet.add(j.propA);
        if (j.propB) weldedSet.add(j.propB);
      }

      // Pass 1: oldest unheld, non-starter loose prop
      let candidate = null;
      for (let i = 0; i < this.props.length; i++) {
        const p = this.props[i];
        if (p._destroyed || p._isStarter || heldSet.has(p) || weldedSet.has(p)) {
          continue;
        }
        candidate = p;
        break;
      }

      if (candidate) {
        this._despawnProp(candidate);
        continue;
      }

      // Pass 2 fallback: if no loose props remain (e.g. many preset contraptions spawned),
      // gracefully recycle the oldest unheld, non-starter prop / contraption assembly
      let fallback = null;
      for (let i = 0; i < this.props.length; i++) {
        const p = this.props[i];
        if (p._destroyed || p._isStarter || heldSet.has(p)) {
          continue;
        }
        fallback = p;
        break;
      }

      if (!fallback) break;

      const assembly = this.getConnectedAssembly(fallback);
      const canDespawnWholeAssembly =
        assembly.length > 1 &&
        assembly.every((part) => !part._isStarter && !heldSet.has(part));

      if (canDespawnWholeAssembly) {
        for (let i = 0; i < assembly.length; i++) {
          this._despawnProp(assembly[i]);
        }
      } else {
        this._despawnProp(fallback);
      }
    }
  }

  /** Sample max terrain/island surface height over a contraption's footprint */
  _getFootprintSurfaceHeight(cx, cz, refY, radius = 1.5) {
    let maxH = this.getSurfaceHeightAt(cx, cz, refY);
    const offsets = [
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius],
    ];
    for (let i = 0; i < offsets.length; i++) {
      const h = this.getSurfaceHeightAt(cx + offsets[i][0], cz + offsets[i][1], refY);
      if (h > maxH) maxH = h;
    }
    return maxH;
  }

  /**
   * One-tap complete contraption preset spawner for mobile & quick-build play.
   * Supported presetIds: 'raft' (涡轮木筏), 'buggy' (四轮越野车), 'rocket_sled' (冲天火箭板).
   * Returns { presetId, count, rootProp } or null if unknown preset.
   */
  spawnPresetContraption(presetId, origin, forwardDir) {
    if (!this.world) return null;

    const PRESET_COUNTS = {
      raft: 6,
      buggy: 6,
      rocket_sled: 3,
    };
    const expectedCount = PRESET_COUNTS[presetId];
    if (!expectedCount) return null;

    const origX = origin?.x ?? 0;
    const origY = origin?.y ?? 2;
    const origZ = origin?.z ?? 0;

    // Project forwardDir onto horizontal XZ plane so contraptions spawn cleanly level
    let fx = forwardDir?.x ?? 0;
    let fz = forwardDir?.z ?? -1;
    const horizLen = Math.hypot(fx, fz);
    if (horizLen < 1e-5) {
      fx = 0;
      fz = -1;
    } else {
      fx /= horizLen;
      fz /= horizLen;
    }

    // Yaw mapping local forward (-Z) -> (fx, 0, fz)
    const yaw = Math.atan2(-fx, -fz);
    const baseQuat = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, yaw);

    const dist = presetId === 'rocket_sled' ? 5.0 : 5.5;
    const cx = origX + fx * dist;
    const cz = origZ + fz * dist;
    const refY = origY + 2.5;
    const footprintY = this._getFootprintSurfaceHeight(
      cx,
      cz,
      refY,
      presetId === 'rocket_sled' ? 1.4 : 1.6
    );
    const floorY = Math.max(footprintY, WORLD_CONFIG.SEA_LEVEL);

    const clearance =
      presetId === 'buggy' ? 1.25 : 0.55;
    const baseY = floorY + clearance;
    const centerPos = new THREE.Vector3(cx, baseY, cz);

    const spawnPart = (typeId, lx, ly, lz, localQuat = null) => {
      const worldPos = new THREE.Vector3(lx, ly, lz)
        .applyQuaternion(baseQuat)
        .add(centerPos);
      const worldQuat = localQuat
        ? baseQuat.clone().multiply(localQuat).normalize()
        : baseQuat.clone();
      return this.spawnProp(typeId, worldPos, worldQuat);
    };

    // Enforce soft prop cap once up front so newly spawned parts are never pruned mid-build
    this._enforcePropCap(expectedCount);
    this._spawningPreset = true;

    const spawned = [];
    let rootProp = null;
    const silent = true;

    try {
      if (presetId === 'raft') {
        const logLocalQ = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          Math.PI * 0.5
        );
        const logs = [];
        for (const xOff of [-0.78, 0, 0.78]) {
          const log = spawnPart('log', xOff, 0, 0, logLocalQ);
          if (log) {
            logs.push(log);
            spawned.push(log);
          }
        }

        const plankF = spawnPart('plank', 0, 0.44, -0.85);
        const plankB = spawnPart('plank', 0, 0.44, 0.85);
        if (plankF) spawned.push(plankF);
        if (plankB) spawned.push(plankB);

        // Stern fan facing forward (-Z) with slight upward planing trim
        const fanLocalQ = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          -Math.PI * 0.43
        );
        const fan = spawnPart('fan', 0, 0.92, 1.48, fanLocalQ);
        if (fan) spawned.push(fan);

        if (logs.length === 3) {
          this.weldProps(logs[0], logs[1], silent);
          this.weldProps(logs[1], logs[2], silent);
          if (plankF) {
            this.weldProps(plankF, logs[0], silent);
            this.weldProps(plankF, logs[1], silent);
            this.weldProps(plankF, logs[2], silent);
          }
          if (plankB) {
            this.weldProps(plankB, logs[0], silent);
            this.weldProps(plankB, logs[1], silent);
            this.weldProps(plankB, logs[2], silent);
          }
        }
        if (plankF && plankB) {
          this.weldProps(plankF, plankB, silent);
        }
        if (fan && plankB) {
          this.weldProps(fan, plankB, silent);
        }

        rootProp = logs[1] || plankF || spawned[0] || null;
      } else if (presetId === 'buggy') {
        const chassisLocalQ = new THREE.Quaternion().setFromAxisAngle(
          WORLD_UP,
          Math.PI * 0.5
        );
        const chassis = spawnPart('plank', 0, 0, 0, chassisLocalQ);
        if (chassis) spawned.push(chassis);

        // Axle +Y -> local +X so cross(WORLD_UP, +X) = local forward (-Z)
        const wheelLocalQ = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          -Math.PI * 0.5
        );
        const wheelOffsets = [
          [-1.02, -0.22, -1.12],
          [1.02, -0.22, -1.12],
          [-1.02, -0.22, 1.12],
          [1.02, -0.22, 1.12],
        ];
        const wheels = [];
        for (let i = 0; i < wheelOffsets.length; i++) {
          const [wx, wy, wz] = wheelOffsets[i];
          const w = spawnPart('wheel', wx, wy, wz, wheelLocalQ);
          if (w) {
            wheels.push(w);
            spawned.push(w);
          }
        }

        // Rear booster fan thrusting cleanly forward (-Z)
        const fanLocalQ = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          -Math.PI * 0.5
        );
        const fan = spawnPart('fan', 0, 0.68, 1.48, fanLocalQ);
        if (fan) spawned.push(fan);

        if (chassis) {
          for (let i = 0; i < wheels.length; i++) {
            this.weldProps(chassis, wheels[i], silent);
          }
          if (fan) {
            this.weldProps(chassis, fan, silent);
          }
        }

        rootProp = chassis || spawned[0] || null;
      } else if (presetId === 'rocket_sled') {
        const sledLocalQ = new THREE.Quaternion().setFromAxisAngle(
          WORLD_UP,
          Math.PI * 0.5
        );
        const plank = spawnPart('plank', 0, 0, 0, sledLocalQ);
        if (plank) {
          spawned.push(plank);
        }

        // Two Zonai rockets angled forward (-Z) and ~34° upward for dramatic launch
        const rocketLocalQ = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          -Math.PI * 0.31
        );
        const rLeft = spawnPart('rocket', -0.85, 0.36, 0.05, rocketLocalQ);
        const rRight = spawnPart('rocket', 0.85, 0.36, 0.05, rocketLocalQ);
        if (rLeft) spawned.push(rLeft);
        if (rRight) spawned.push(rRight);

        if (plank && rLeft) this.weldProps(plank, rLeft, silent);
        if (plank && rRight) this.weldProps(plank, rRight, silent);

        rootProp = plank || spawned[0] || null;
      }
    } finally {
      this._spawningPreset = false;
    }

    for (let i = 0; i < spawned.length; i++) {
      spawned[i].body.wakeUp();
    }

    return {
      presetId,
      count: spawned.length,
      rootProp,
    };
  }
}
