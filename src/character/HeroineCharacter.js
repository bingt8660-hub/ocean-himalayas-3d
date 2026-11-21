/**
 * Stylized Anime Heroine Character for "海中喜马拉雅" (Ocean Himalayas 3D).
 * Supports VRM 0.x & VRM 1.0 models via @pixiv/three-vrm, procedural humanoid
 * animations across all traversal states, BotW-style Paraglider, Ultrahand
 * emerald-cyan hand-orb, and an immediate stylized anime fallback rig.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function damp(current, target, lambda, dt) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Generates a sunlit linen & turquoise Himalayan-tribal Paraglider canvas texture.
 */
function createParagliderTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Warm sunlit cream-ivory linen base
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#fbf3df');
  grad.addColorStop(0.55, '#f2e2be');
  grad.addColorStop(1, '#e4cea0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  // Subtle woven linen grain
  ctx.strokeStyle = 'rgba(130, 100, 62, 0.08)';
  ctx.lineWidth = 1;
  for (let y = 0; y < 256; y += 6) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }
  for (let x = 0; x < 512; x += 8) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }

  // Deep turquoise tribal borders along leading & trailing edges
  ctx.fillStyle = '#1f8a8c';
  ctx.fillRect(0, 0, 512, 24);
  ctx.fillRect(0, 224, 512, 32);

  // Gold accent pinstripes
  ctx.fillStyle = '#d9a441';
  ctx.fillRect(0, 24, 512, 5);
  ctx.fillRect(0, 219, 512, 5);

  // Geometric Himalayan diamond / chevron tribal trim along trailing border
  ctx.fillStyle = '#f6e7c4';
  for (let x = 16; x < 512; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 229);
    ctx.lineTo(x + 11, 240);
    ctx.lineTo(x, 251);
    ctx.lineTo(x - 11, 240);
    ctx.closePath();
    ctx.fill();
  }

  // Wingtip turquoise panels
  ctx.fillStyle = 'rgba(31, 138, 140, 0.85)';
  ctx.beginPath();
  ctx.moveTo(0, 29);
  ctx.lineTo(68, 29);
  ctx.lineTo(42, 219);
  ctx.lineTo(0, 219);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(512, 29);
  ctx.lineTo(444, 29);
  ctx.lineTo(470, 219);
  ctx.lineTo(512, 219);
  ctx.closePath();
  ctx.fill();

  // Center stylized sky-mountain & wind crest emblem
  ctx.save();
  ctx.translate(256, 124);

  // Outer emerald-gold halo ring
  ctx.strokeStyle = '#1f8a8c';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, 58, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#d9a441';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, 50, 0, Math.PI * 2);
  ctx.stroke();

  // Stylized mountain silhouette inside crest
  ctx.fillStyle = '#1b6d75';
  ctx.beginPath();
  ctx.moveTo(-40, 22);
  ctx.lineTo(-14, -18);
  ctx.lineTo(0, 2);
  ctx.lineTo(14, -26);
  ctx.lineTo(40, 22);
  ctx.closePath();
  ctx.fill();

  // Snow cap accent
  ctx.fillStyle = '#fbf3df';
  ctx.beginPath();
  ctx.moveTo(14, -26);
  ctx.lineTo(24, -8);
  ctx.lineTo(17, -12);
  ctx.lineTo(14, -6);
  ctx.lineTo(8, -12);
  ctx.lineTo(4, -7);
  ctx.closePath();
  ctx.fill();

  // Golden wind wings flanking crest
  ctx.strokeStyle = '#c88c2e';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 66, -12);
    ctx.quadraticCurveTo(side * 108, -28, side * 140, -6);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(side * 68, 8);
    ctx.quadraticCurveTo(side * 102, 2, side * 128, 18);
    ctx.stroke();
  }
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export class HeroineCharacter {
  constructor(scene) {
    this.scene = scene;

    // Root positioned at feet (y = 0 at soles), local +Z is character forward
    this.root = new THREE.Group();
    this.root.name = 'HeroineRoot';
    this.scene.add(this.root);

    // Inner container for smooth body banking/swim pitch independent of root yaw
    this.modelContainer = new THREE.Group();
    this.modelContainer.name = 'HeroineModelContainer';
    this.root.add(this.modelContainer);

    this.vrm = null;
    this._loadToken = 0;
    this._restHipsY = 0.85;
    this._boneCache = new Map();
    this._smoothedRot = new Map();

    // Animation state accumulators
    this._time = 0;
    this._gaitPhase = 0;
    this._swimPhase = 0;
    this._climbPhase = 0;
    this._glideReveal = 0;
    this._blinkCooldown = 2.5;
    this._blinkElapsed = -1;
    this._tmpVec = new THREE.Vector3();
    this._tmpFwd = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();

    // Build stylized BotW Paraglider (hidden unless gliding)
    this.paragliderGroup = this._buildParaglider();
    this.paragliderGroup.visible = false;
    this.modelContainer.add(this.paragliderGroup);

    // Build Ultrahand glowing hand-orb in world space (synced to right palm every frame)
    this.ultrahandOrb = this._buildUltrahandOrb();
    this.ultrahandOrb.visible = false;
    this.scene.add(this.ultrahandOrb);

    // Build cute stylized anime fallback character immediately visible before VRM loads
    this.fallbackRig = this._buildFallbackCharacter();
    this.fallbackGroup = this.fallbackRig.group;
    this.modelContainer.add(this.fallbackGroup);
  }

  /**
   * Constructs a BotW-inspired wooden-framed cloth Paraglider with fluttering ribbons.
   */
  _buildParaglider() {
    const group = new THREE.Group();
    group.name = 'Paraglider';
    // Positioned above heroine's outstretched overhead hands
    group.position.set(0, 1.88, -0.02);

    const woodMat = new THREE.MeshStandardMaterial({
      color: 0x7b4c29,
      roughness: 0.78,
      metalness: 0.05,
    });
    const bindingMat = new THREE.MeshStandardMaterial({
      color: 0xd5a446,
      roughness: 0.55,
      metalness: 0.25,
    });
    const fabricTex = createParagliderTexture();
    const canopyMat = new THREE.MeshStandardMaterial({
      map: fabricTex,
      side: THREE.DoubleSide,
      roughness: 0.82,
      metalness: 0.02,
    });
    const ribbonMat = new THREE.MeshStandardMaterial({
      color: 0x2ec4b6,
      emissive: 0x0b4144,
      emissiveIntensity: 0.2,
      side: THREE.DoubleSide,
      roughness: 0.6,
    });

    // Arched airfoil canopy mesh (2.85m wingspan x 1.22m chord)
    const canopyGeo = new THREE.PlaneGeometry(2.85, 1.22, 24, 10);
    const pos = canopyGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i); // [-1.425, +1.425]
      const y = pos.getY(i); // [-0.61, +0.61] (becomes local Z after rotation)
      const nx = x / 1.425;  // [-1, 1]
      const ny = y / 0.61;   // [-1, 1]

      // Taper chord gracefully toward wingtips + subtle bat-wing sweep
      const taper = 1.0 - 0.34 * Math.pow(Math.abs(nx), 1.8);
      const sweep = -0.18 * Math.pow(Math.abs(nx), 1.5);
      const newY = y * taper + sweep;

      // Arch downwards toward wingtips (parabolic glider dome) + airfoil camber
      const arch = -0.34 * (nx * nx);
      const camber = 0.12 * (1.0 - ny * ny) * (1.0 - 0.45 * nx * nx);
      // Slight central gull dip
      const centerRidge = 0.05 * Math.cos(nx * Math.PI);
      const z = arch + camber + centerRidge;

      pos.setXYZ(i, x, newY, z);
    }
    canopyGeo.computeVertexNormals();
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    // Rotate plane so its width is X, chord is Z (+Z leading edge), arch is +Y
    canopy.rotation.x = -Math.PI / 2;
    canopy.position.set(0, 0.24, -0.05);
    canopy.castShadow = true;
    canopy.receiveShadow = true;
    group.add(canopy);
    this._canopyMesh = canopy;

    // Central spine beam
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.024, 1.32, 8), woodMat);
    spine.rotation.x = Math.PI / 2;
    spine.position.set(0, 0.21, -0.04);
    spine.castShadow = true;
    group.add(spine);

    // Main curved cross-spars (left & right wings)
    for (const side of [-1, 1]) {
      const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.016, 1.46, 8), woodMat);
      spar.rotation.z = side * (Math.PI / 2 + 0.23);
      spar.rotation.y = side * -0.12;
      spar.position.set(side * 0.68, 0.06, 0.03);
      spar.castShadow = true;
      group.add(spar);

      // Diagonal wooden strut descending from canopy down to handgrip
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 8), woodMat);
      strut.position.set(side * 0.25, -0.02, 0.04);
      strut.rotation.z = side * -0.22;
      strut.castShadow = true;
      group.add(strut);

      // Golden wrap binding on joints
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.008, 6, 12), bindingMat);
      ring.position.set(side * 0.30, -0.20, 0.04);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
    }

    // Horizontal wooden handlebar grip (aligned right where her raised hands meet)
    const handleBar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.78, 10), woodMat);
    handleBar.rotation.z = Math.PI / 2;
    handleBar.position.set(0, -0.21, 0.05);
    handleBar.castShadow = true;
    group.add(handleBar);

    // Center crest medallion knot
    const knot = new THREE.Mesh(new THREE.OctahedronGeometry(0.048, 0), bindingMat);
    knot.position.set(0, 0.20, 0.16);
    group.add(knot);

    // Fluttering turquoise wingtip ribbons
    this._gliderRibbons = [];
    for (const side of [-1, 1]) {
      const ribbonPivot = new THREE.Group();
      ribbonPivot.position.set(side * 1.32, -0.12, -0.42);
      const ribbonGeo = new THREE.PlaneGeometry(0.11, 0.72, 1, 6);
      ribbonGeo.translate(0, -0.36, 0);
      const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
      ribbon.rotation.x = Math.PI / 2 + 0.15;
      ribbonPivot.add(ribbon);
      group.add(ribbonPivot);
      this._gliderRibbons.push({ pivot: ribbonPivot, mesh: ribbon, side });
    }

    return group;
  }

  /**
   * Constructs the emerald-cyan Ultrahand energy orb & spinning Zonai runic ring.
   */
  _buildUltrahandOrb() {
    const group = new THREE.Group();
    group.name = 'UltrahandHandOrb';

    // Bright cyan-white core
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xd8fff6,
        transparent: true,
        opacity: 0.96,
      })
    );
    group.add(core);

    // Soft additive emerald-cyan aura
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(0.165, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0x3bf0c5,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    group.add(aura);

    // Rotating runic halo ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.18, 0.014, 8, 28),
      new THREE.MeshBasicMaterial({
        color: 0x52ffda,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    group.add(ring);

    // Local point light to softly illuminate heroine's hand & tunic while casting
    const light = new THREE.PointLight(0x45f0c8, 1.8, 5.5, 2);
    group.add(light);

    this._ultrahandCore = core;
    this._ultrahandAura = aura;
    this._ultrahandRing = ring;
    this._ultrahandLight = light;

    return group;
  }

  /**
   * Builds a charming stylized anime adventurer fallback character (facing +Z, height ~1.62m)
   * so a character is immediately visible while VRM downloads or if loading fails.
   */
  _buildFallbackCharacter() {
    const group = new THREE.Group();
    group.name = 'FallbackHeroine';

    const skinMat = new THREE.MeshStandardMaterial({ color: 0xffe0c8, roughness: 0.65 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x3b2c40, roughness: 0.55 });
    const tunicMat = new THREE.MeshStandardMaterial({ color: 0x26929b, roughness: 0.65 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xf4e3bd, roughness: 0.6 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xe2ad44, roughness: 0.35, metalness: 0.45 });
    const skirtMat = new THREE.MeshStandardMaterial({ color: 0x1d3557, roughness: 0.7 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x5c3a21, roughness: 0.78 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1c4b6e });
    const eyeHiMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    // Hips root
    const hips = new THREE.Group();
    hips.position.set(0, 0.86, 0);
    group.add(hips);

    // Torso / tunic
    const torso = new THREE.Group();
    hips.add(torso);

    const chestMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.125, 0.42, 12), tunicMat);
    chestMesh.position.y = 0.22;
    chestMesh.castShadow = true;
    chestMesh.receiveShadow = true;
    torso.add(chestMesh);

    // Sunlit cream scarf/collar
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.042, 8, 16), trimMat);
    scarf.rotation.x = Math.PI / 2;
    scarf.position.y = 0.42;
    scarf.castShadow = true;
    torso.add(scarf);

    // Flowing back scarf ribbon
    const scarfTail = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.34, 0.025), trimMat);
    scarfTail.position.set(0, 0.24, -0.15);
    scarfTail.rotation.x = 0.25;
    scarfTail.castShadow = true;
    torso.add(scarfTail);

    // Golden belt & pleated skirt
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.14, 0.055, 14), goldMat);
    belt.position.y = 0.02;
    torso.add(belt);

    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.26, 0.32, 16), skirtMat);
    skirt.position.y = -0.14;
    skirt.castShadow = true;
    skirt.receiveShadow = true;
    hips.add(skirt);

    // Head & anime hair
    const head = new THREE.Group();
    head.position.set(0, 0.46, 0);
    torso.add(head);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 8), skinMat);
    neck.position.y = 0.02;
    head.add(neck);

    const headSphere = new THREE.Mesh(new THREE.SphereGeometry(0.155, 18, 16), skinMat);
    headSphere.position.y = 0.16;
    headSphere.scale.set(0.95, 1.0, 0.94);
    headSphere.castShadow = true;
    head.add(headSphere);

    // Stylized anime eyes facing +Z
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 10), eyeMat);
      eye.position.set(side * 0.056, 0.155, 0.128);
      eye.scale.set(0.85, 1.15, 0.5);
      head.add(eye);

      const sparkle = new THREE.Mesh(new THREE.SphereGeometry(0.009, 6, 6), eyeHiMat);
      sparkle.position.set(side * 0.050, 0.166, 0.141);
      head.add(sparkle);
    }

    // Hair cap + bangs + ponytail
    const hairCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.166, 18, 16, 0, Math.PI * 2, 0, Math.PI * 0.64),
      hairMat
    );
    hairCap.position.set(0, 0.175, -0.012);
    hairCap.castShadow = true;
    head.add(hairCap);

    const backHair = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 12), hairMat);
    backHair.position.set(0, 0.12, -0.06);
    backHair.scale.set(1.06, 1.15, 0.78);
    head.add(backHair);

    const ponytail = new THREE.Group();
    ponytail.position.set(0, 0.18, -0.15);
    const ponyMesh = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.42, 10), hairMat);
    ponyMesh.position.set(0, -0.18, -0.05);
    ponyMesh.rotation.x = 0.35;
    ponyMesh.castShadow = true;
    ponytail.add(ponyMesh);
    head.add(ponytail);

    // Arms (left = +X, right = -X to match VRM1!)
    const buildArm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.18, 0.38, 0);
      torso.add(shoulder);

      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.042, 0.24, 10), tunicMat);
      sleeve.position.y = -0.11;
      sleeve.castShadow = true;
      shoulder.add(sleeve);

      const forearm = new THREE.Group();
      forearm.position.y = -0.23;
      shoulder.add(forearm);

      const lowerMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.032, 0.24, 10), skinMat);
      lowerMesh.position.y = -0.11;
      lowerMesh.castShadow = true;
      forearm.add(lowerMesh);

      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 8), skinMat);
      hand.position.y = -0.24;
      forearm.add(hand);

      return { shoulder, forearm, hand };
    };

    const leftArm = buildArm(1);   // +X = Left
    const rightArm = buildArm(-1); // -X = Right

    // Anchor at right hand palm for Ultrahand beam
    const rightHandAnchor = new THREE.Object3D();
    rightHandAnchor.position.set(0, -0.27, 0.05);
    rightArm.forearm.add(rightHandAnchor);

    // Legs (left = +X, right = -X)
    const buildLeg = (side) => {
      const upper = new THREE.Group();
      upper.position.set(side * 0.09, -0.02, 0);
      hips.add(upper);

      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.048, 0.42, 10), skinMat);
      thigh.position.y = -0.21;
      thigh.castShadow = true;
      upper.add(thigh);

      const lower = new THREE.Group();
      lower.position.y = -0.42;
      upper.add(lower);

      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.042, 0.40, 10), bootMat);
      shin.position.y = -0.20;
      shin.castShadow = true;
      lower.add(shin);

      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.06, 0.16), bootMat);
      foot.position.set(0, -0.40, 0.035);
      foot.castShadow = true;
      lower.add(foot);

      return { upper, lower };
    };

    const leftLeg = buildLeg(1);
    const rightLeg = buildLeg(-1);

    return {
      group,
      hips,
      torso,
      head,
      ponytail,
      scarfTail,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      rightHandAnchor,
    };
  }

  /**
   * Loads a VRM 0.x or VRM 1.0 model asynchronously, normalizes orientation (+Z forward),
   * scales cleanly to ~1.62m with feet at y = 0, and enables shadows + disables skinned culling.
   */
  async loadModel(url) {
    const token = ++this._loadToken;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    let gltf;
    try {
      gltf = await loader.loadAsync(url);
    } catch (err) {
      console.warn(`[HeroineCharacter] Failed to load VRM from "${url}":`, err);
      if (token === this._loadToken && !this.vrm) {
        this.fallbackGroup.visible = true;
      }
      return null;
    }

    const vrm = gltf?.userData?.vrm;
    if (!vrm) {
      console.warn(`[HeroineCharacter] Loaded file "${url}" did not contain VRM userData.`);
      return null;
    }

    // Abort if a newer loadModel() call was triggered while this one was in flight
    if (token !== this._loadToken) {
      VRMUtils.deepDispose(vrm.scene);
      return null;
    }

    // Dispose previous VRM cleanly
    if (this.vrm) {
      this.modelContainer.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }

    // Align VRM0 (+Z/-Z mismatch) so ALL models face +Z uniformly (same as VRM1)
    VRMUtils.rotateVRM0(vrm);

    // Reset transforms before measuring bounding box
    vrm.scene.position.set(0, 0, 0);
    vrm.scene.scale.setScalar(1);
    vrm.scene.updateMatrixWorld(true);

    // Measure height via Box3 (fallback to head/hips bone metric if needed)
    const rawBox = new THREE.Box3().setFromObject(vrm.scene);
    let rawHeight = rawBox.max.y - rawBox.min.y;
    if (!Number.isFinite(rawHeight) || rawHeight < 0.25 || rawHeight > 5.0) {
      const headNode = vrm.humanoid?.getNormalizedBoneNode('head');
      if (headNode) {
        headNode.getWorldPosition(this._tmpVec);
        rawHeight = Math.max(0.5, this._tmpVec.y * 1.14);
      } else {
        rawHeight = 1.62;
      }
    }

    const targetHeight = 1.62;
    const scale = clamp(targetHeight / rawHeight, 0.55, 2.2);
    vrm.scene.scale.setScalar(scale);
    vrm.scene.updateMatrixWorld(true);

    // Align soles of feet accurately to y = 0 inside this.root
    const scaledBox = new THREE.Box3().setFromObject(vrm.scene);
    if (Number.isFinite(scaledBox.min.y)) {
      vrm.scene.position.y -= scaledBox.min.y;
    }
    vrm.scene.updateMatrixWorld(true);

    // Configure shadows & disable frustum culling on skinned meshes so limbs never vanish
    vrm.scene.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.frustumCulled = false;
      }
    });

    // Cache normalized humanoid bone nodes for fast, zero-allocation animation
    this._boneCache.clear();
    this._smoothedRot.clear();
    const boneNames = [
      'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
      'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
      'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
      'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
      'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
    ];
    for (const name of boneNames) {
      const node = vrm.humanoid?.getNormalizedBoneNode(name) || null;
      if (node) {
        this._boneCache.set(name, node);
        this._smoothedRot.set(name, { x: 0, y: 0, z: 0 });
      }
    }

    const hipsNode = this._boneCache.get('hips');
    this._restHipsY = hipsNode ? hipsNode.position.y : 0.85;

    this.modelContainer.add(vrm.scene);
    this.vrm = vrm;
    this.fallbackGroup.visible = false;

    // Immediately settle into relaxed idle pose (out of T-pose on first rendered frame)
    this._applyVRMPose(1.0, {
      mode: 'idle',
      speed: 0,
      turnRate: 0,
      isUltrahand: false,
      verticalVel: 0,
      windStrength: 0,
    }, true);
    this.vrm.update(0.016);

    return vrm;
  }

  /**
   * Writes the world position of the heroine's right hand palm into targetVec
   * so UltrahandSystem can anchor its glowing energy beam directly to her hand.
   */
  getRightHandWorldPos(targetVec = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);

    if (this.vrm && this.vrm.humanoid) {
      const handNode =
        this.vrm.humanoid.getNormalizedBoneNode('rightHand') ||
        this.vrm.humanoid.getRawBoneNode('rightHand') ||
        this.vrm.humanoid.getNormalizedBoneNode('rightLowerArm');

      if (handNode) {
        handNode.getWorldPosition(targetVec);
        // Nudge slightly forward along character facing toward palm/fingertips
        this.root.getWorldQuaternion(this._tmpQuat);
        this._tmpFwd.set(0, 0, 0.08).applyQuaternion(this._tmpQuat);
        targetVec.add(this._tmpFwd);
        return targetVec;
      }
    }

    if (this.fallbackRig?.rightHandAnchor) {
      this.fallbackRig.rightHandAnchor.getWorldPosition(targetVec);
      return targetVec;
    }

    targetVec.copy(this.root.position);
    targetVec.y += 1.18;
    return targetVec;
  }

  /**
   * Smoothly damps a normalized VRM humanoid bone toward target Euler (XYZ) angles.
   */
  _setBone(name, rx, ry, rz, rate, dt, instant = false) {
    const node = this._boneCache.get(name);
    if (!node) return;
    const state = this._smoothedRot.get(name);
    if (!state) return;

    if (instant) {
      state.x = rx;
      state.y = ry;
      state.z = rz;
    } else {
      const alpha = 1 - Math.exp(-rate * dt);
      state.x += (rx - state.x) * alpha;
      state.y += (ry - state.y) * alpha;
      state.z += (rz - state.z) * alpha;
    }
    node.rotation.set(state.x, state.y, state.z);
  }

  /**
   * Updates procedural animations, paraglider visuals, Ultrahand hand-orb,
   * blinking expressions, and VRM spring bones.
   */
  update(dt, animState = {}) {
    const safeDt = Math.min(Math.max(dt || 0.016, 0.001), 0.05);
    this._time += safeDt;

    const {
      mode = 'idle',
      speed = 0,
      turnRate = 0,
      isUltrahand = false,
      verticalVel = 0,
      windStrength = 0,
    } = animState;

    // Advance rhythmic cycle phases
    if (mode === 'walk' || mode === 'run') {
      const gaitFreq = 5.4 + speed * 0.56;
      this._gaitPhase += safeDt * gaitFreq;
    } else {
      // Gently return gait phase when idle
      this._gaitPhase += safeDt * 1.2;
    }

    if (mode === 'swim') {
      this._swimPhase += safeDt * (2.6 + speed * 0.65);
    }
    if (mode === 'climb') {
      this._climbPhase += safeDt * (speed > 0.25 ? 2.8 + speed * 1.15 : 0.6);
    }

    // Smooth body container pitch / bank / vertical offset per traversal mode
    let targetBodyPitch = 0;
    let targetBodyRoll = 0;
    let targetBodyY = 0;

    if (mode === 'glide') {
      targetBodyPitch = 0.14;
      targetBodyRoll = clamp(-turnRate * 0.16, -0.34, 0.34);
      targetBodyY = 0.04;
    } else if (mode === 'swim') {
      // Tilt horizontally near water surface while floating
      targetBodyPitch = 1.08 + Math.sin(this._time * 2.4) * 0.04;
      targetBodyRoll = clamp(-turnRate * 0.12, -0.25, 0.25);
      targetBodyY = 0.42;
    } else if (mode === 'walk' || mode === 'run') {
      targetBodyRoll = clamp(-turnRate * 0.07, -0.18, 0.18);
    } else if (mode === 'climb') {
      targetBodyPitch = 0.05;
    }

    this.modelContainer.rotation.x = damp(this.modelContainer.rotation.x, targetBodyPitch, 8.5, safeDt);
    this.modelContainer.rotation.z = damp(this.modelContainer.rotation.z, targetBodyRoll, 8.5, safeDt);
    this.modelContainer.position.y = damp(this.modelContainer.position.y, targetBodyY, 9.0, safeDt);

    // Update Paraglider visibility, springy pop-in, banking & wind flutter
    const glideTarget = mode === 'glide' ? 1 : 0;
    this._glideReveal = damp(this._glideReveal, glideTarget, mode === 'glide' ? 14 : 18, safeDt);

    if (this._glideReveal > 0.02) {
      this.paragliderGroup.visible = true;
      const s = this._glideReveal;
      this.paragliderGroup.scale.set(s, 0.5 + 0.5 * s, s);
      const gust = 0.5 + clamp(windStrength, 0, 2);
      this.paragliderGroup.rotation.z = clamp(-turnRate * 0.14, -0.30, 0.30) + Math.sin(this._time * 3.8) * 0.025 * gust;
      this.paragliderGroup.rotation.x = -0.10 + clamp(-verticalVel * 0.015, -0.14, 0.14) + Math.cos(this._time * 4.5) * 0.02 * gust;

      // Flutter wingtip ribbons
      for (const r of this._gliderRibbons) {
        const wave = Math.sin(this._time * (11.0 + speed * 0.5) + r.side * 1.4);
        r.pivot.rotation.y = wave * 0.28 * gust;
        r.pivot.rotation.x = Math.cos(this._time * 8.5 + r.side) * 0.16 * gust;
      }
    } else {
      this.paragliderGroup.visible = false;
    }

    // Animate either loaded VRM or stylized fallback character
    if (this.vrm) {
      this._applyVRMPose(safeDt, animState, false);
      this._updateExpressions(safeDt, mode, windStrength);
      this.vrm.update(safeDt);
    } else {
      this._applyFallbackPose(safeDt, animState);
    }

    // Update Ultrahand glowing hand-orb synced directly to right palm in world space
    if (isUltrahand) {
      this.ultrahandOrb.visible = true;
      this.getRightHandWorldPos(this._tmpVec);
      this.ultrahandOrb.position.copy(this._tmpVec);

      const pulse = 1.0 + Math.sin(this._time * 7.5) * 0.14;
      this._ultrahandCore.scale.setScalar(pulse);
      this._ultrahandAura.scale.setScalar(1.0 + Math.cos(this._time * 5.2) * 0.18);
      this._ultrahandRing.rotation.z = this._time * 3.2;
      this._ultrahandRing.rotation.x = Math.sin(this._time * 2.1) * 0.45;
      this._ultrahandLight.intensity = 1.65 + Math.sin(this._time * 7.5) * 0.35;
    } else {
      this.ultrahandOrb.visible = false;
    }
  }

  /**
   * Procedural VRM 1.0 normalized bone animation (+Z forward, +X left, +Y up).
   * Right-hand rule verified:
   * - Legs: upperLeg.rx < 0 forward, lowerLeg.rx > 0 knee bend back
   * - Arms (from T-pose): leftUpperArm.rz < 0 lowers, rightUpperArm.rz > 0 lowers
   * - With arms lowered, upperArm.rx < 0 swings forward, > 0 swings backward
   * - Spine/chest: rx > 0 leans forward, rx < 0 arches backward
   */
  _applyVRMPose(dt, animState, instant = false) {
    const {
      mode = 'idle',
      speed = 0,
      turnRate = 0,
      isUltrahand = false,
      verticalVel = 0,
    } = animState;

    const t = this._time;
    const rate = 12.0;

    // Default neutral targets (arms relaxed down ~68 deg from T-pose!)
    let hipsY = this._restHipsY;
    let spineRx = 0.02, spineRy = 0, spineRz = 0;
    let chestRx = 0.01, chestRy = 0, chestRz = 0;
    let neckRx = 0, neckRy = 0;
    let headRx = 0, headRy = 0, headRz = 0;

    let lUA = { x: 0.04, y: 0, z: -1.18 };
    let rUA = { x: 0.04, y: 0, z: 1.18 };
    let lLA = { x: 0, y: -0.18, z: 0 };
    let rLA = { x: 0, y: 0.18, z: 0 };
    let lHand = { x: 0, y: 0, z: 0 };
    let rHand = { x: 0, y: 0, z: 0 };

    let lUL = { x: 0, y: 0, z: -0.02 };
    let rUL = { x: 0, y: 0, z: 0.02 };
    let lLL = { x: 0.05, y: 0, z: 0 };
    let rLL = { x: 0.05, y: 0, z: 0 };
    let lFoot = { x: 0, y: 0, z: 0 };
    let rFoot = { x: 0, y: 0, z: 0 };

    if (mode === 'idle') {
      const breath = Math.sin(t * 1.9);
      const sway = Math.sin(t * 0.85);
      spineRx = 0.025 + breath * 0.022;
      chestRx = Math.sin(t * 1.9 - 0.5) * 0.024;
      spineRz = sway * 0.018;
      headRy = Math.sin(t * 0.55) * 0.07;
      headRx = Math.sin(t * 1.1) * 0.025;
      lUA.z = -1.16 - breath * 0.02;
      rUA.z = 1.16 + breath * 0.02;
      lUA.x = 0.03 + breath * 0.02;
      rUA.x = 0.03 + breath * 0.02;
      lLA.y = -0.20;
      rLA.y = 0.20;
      hipsY = this._restHipsY + breath * 0.008;
    } else if (mode === 'walk' || mode === 'run') {
      const runBlend = clamp((speed - 6.2) / 6.5, 0, 1);
      const p = this._gaitPhase;
      const s = Math.sin(p);
      const c = Math.cos(p);

      const legAmp = 0.44 + runBlend * 0.44;
      const armAmp = 0.38 + runBlend * 0.48;

      // Crisp opposite leg stride
      lUL.x = -s * legAmp;
      rUL.x = s * legAmp;

      // Natural knee tuck on swing-through, straighter during ground stance
      lLL.x = Math.max(0.05, c * (0.52 + runBlend * 0.58) + 0.14 + runBlend * 0.20);
      rLL.x = Math.max(0.05, -c * (0.52 + runBlend * 0.58) + 0.14 + runBlend * 0.20);

      // Subtle ankle flexion
      lFoot.x = -c * 0.18;
      rFoot.x = c * 0.18;

      // Opposite arm swing with natural elbow bend
      lUA.z = -(1.14 - runBlend * 0.14);
      rUA.z = 1.14 - runBlend * 0.14;
      lUA.x = s * armAmp;
      rUA.x = -s * armAmp;

      lLA.y = -(0.28 + runBlend * 0.72) - Math.max(0, -s) * 0.26;
      rLA.y = (0.28 + runBlend * 0.72) + Math.max(0, s) * 0.26;

      // Athletic forward lean & counter-twist
      spineRx = 0.07 + runBlend * 0.18;
      chestRx = 0.05 + runBlend * 0.10;
      spineRy = -s * (0.05 + runBlend * 0.07);
      chestRy = -s * (0.04 + runBlend * 0.05);
      headRx = -(0.08 + runBlend * 0.16);
      headRy = clamp(turnRate * 0.12, -0.35, 0.35);

      // Subtle rhythmic vertical hip bob
      hipsY = this._restHipsY + Math.abs(c) * (0.022 + runBlend * 0.036);
    } else if (mode === 'jump' || mode === 'fall') {
      const rising = verticalVel > 0.6;
      const flutter = Math.sin(t * 7.5) * 0.06;

      if (rising) {
        // Energetic upward leap: front knee tucked, back leg extended
        spineRx = 0.08;
        chestRx = -0.06;
        lUL.x = -0.68;
        lLL.x = 1.12;
        rUL.x = 0.22;
        rLL.x = 0.45;

        lUA.z = -0.58;
        lUA.x = -0.38;
        lLA.y = -0.55;
        rUA.z = 0.58;
        rUA.x = 0.18;
        rLA.y = 0.48;
      } else {
        // Dynamic midair fall balance
        spineRx = 0.14;
        headRx = 0.10;
        lUL.x = -0.32 + flutter;
        lLL.x = 0.65 + flutter;
        rUL.x = -0.14 - flutter;
        rLL.x = 0.48 - flutter;

        lUA.z = -0.36 + flutter;
        lUA.x = -0.22;
        lLA.y = -0.45;
        rUA.z = 0.36 - flutter;
        rUA.x = -0.22;
        rLA.y = 0.45;
      }
    } else if (mode === 'glide') {
      // Both arms raised high gripping the Paraglider handlebar
      lUA.z = 1.24;
      lUA.x = -0.28;
      lUA.y = -0.18;
      lLA.z = 0.14;
      lLA.y = -0.32;

      rUA.z = -1.24;
      rUA.x = -0.28;
      rUA.y = 0.18;
      rLA.z = -0.14;
      rLA.y = 0.32;

      // Graceful trailing legs swaying in the high-altitude wind
      const windSway = Math.sin(t * 2.6) * 0.09;
      lUL.x = 0.26 + windSway;
      lLL.x = 0.44 + Math.sin(t * 2.6 + 0.6) * 0.10;
      rUL.x = 0.36 - windSway;
      rLL.x = 0.58 + Math.cos(t * 2.6 + 0.6) * 0.10;
      lFoot.x = 0.32;
      rFoot.x = 0.36;

      // Slight heroic back arch, head looking forward at horizon
      spineRx = -0.10;
      chestRx = -0.06;
      headRx = 0.06;
      headRy = clamp(turnRate * 0.16, -0.38, 0.38);
    } else if (mode === 'swim') {
      const p = this._swimPhase;
      const moveFactor = clamp(speed / 4.5, 0.25, 1.0);
      const s = Math.sin(p);
      const c = Math.cos(p);

      // Keep face looking up above the turquoise waves
      spineRx = -0.12;
      neckRx = -0.24;
      headRx = -0.68;

      // Rhythmic breaststroke sweep
      const sweep = (0.5 + 0.5 * s) * moveFactor;
      lUA.z = -0.25 + sweep * 0.62;
      lUA.y = -0.65 + c * 0.55 * moveFactor;
      lUA.x = -0.35;
      lLA.y = -0.45 - sweep * 0.45;

      rUA.z = 0.25 - sweep * 0.62;
      rUA.y = 0.65 - c * 0.55 * moveFactor;
      rUA.x = -0.35;
      rLA.y = 0.45 + sweep * 0.45;

      // Flutter kick
      const kick = Math.sin(p * 2.0) * (0.28 + 0.22 * moveFactor);
      lUL.x = 0.18 + kick;
      rUL.x = 0.18 - kick;
      lLL.x = 0.38 + Math.max(0, -kick) * 0.6;
      rLL.x = 0.38 + Math.max(0, kick) * 0.6;
      lFoot.x = 0.45;
      rFoot.x = 0.45;
    } else if (mode === 'climb') {
      const p = this._climbPhase;
      const s = Math.sin(p);
      const active = speed > 0.2 ? 1.0 : 0.18;

      spineRx = 0.10;
      chestRx = 0.06;
      headRx = -0.22; // Look up the cliff face

      // Alternating high hand reaches toward the cliff (+Z)
      const lReach = (0.5 + 0.5 * s) * active;
      const rReach = (0.5 - 0.5 * s) * active;

      lUA.z = 0.35 + lReach * 0.85;
      lUA.y = -0.78;
      lUA.x = -0.25;
      lLA.y = -0.75 + lReach * 0.35;

      rUA.z = -0.35 - rReach * 0.85;
      rUA.y = 0.78;
      rUA.x = -0.25;
      rLA.y = 0.75 - rReach * 0.35;

      // Opposite knee driving up to rock footholds
      lUL.x = -0.28 - rReach * 0.55;
      lLL.x = 0.52 + rReach * 0.62;
      rUL.x = -0.28 - lReach * 0.55;
      rLL.x = 0.52 + lReach * 0.62;
    }

    // Ultrahand override: raise right arm straight forward pointing along beam
    if (isUltrahand && mode !== 'glide' && mode !== 'climb') {
      rUA.z = 0.24;
      rUA.y = 1.28;
      rUA.x = -0.28 + Math.sin(t * 3.5) * 0.04;
      rLA.x = 0;
      rLA.y = 0.16;
      rLA.z = 0;
      rHand.z = -0.18;
      chestRy -= 0.12;
    }

    // Apply smoothed bone rotations
    const hipsNode = this._boneCache.get('hips');
    if (hipsNode) {
      hipsNode.position.y = instant ? hipsY : damp(hipsNode.position.y, hipsY, 12, dt);
    }

    this._setBone('spine', spineRx, spineRy, spineRz, rate, dt, instant);
    this._setBone('chest', chestRx, chestRy, chestRz, rate, dt, instant);
    this._setBone('neck', neckRx, neckRy, 0, rate, dt, instant);
    this._setBone('head', headRx, headRy, headRz, rate, dt, instant);

    this._setBone('leftUpperArm', lUA.x, lUA.y, lUA.z, rate + 2, dt, instant);
    this._setBone('rightUpperArm', rUA.x, rUA.y, rUA.z, rate + 2, dt, instant);
    this._setBone('leftLowerArm', lLA.x, lLA.y, lLA.z, rate + 2, dt, instant);
    this._setBone('rightLowerArm', rLA.x, rLA.y, rLA.z, rate + 2, dt, instant);
    this._setBone('leftHand', lHand.x, lHand.y, lHand.z, rate, dt, instant);
    this._setBone('rightHand', rHand.x, rHand.y, rHand.z, rate, dt, instant);

    this._setBone('leftUpperLeg', lUL.x, lUL.y, lUL.z, rate + 2, dt, instant);
    this._setBone('rightUpperLeg', rUL.x, rUL.y, rUL.z, rate + 2, dt, instant);
    this._setBone('leftLowerLeg', lLL.x, lLL.y, lLL.z, rate + 3, dt, instant);
    this._setBone('rightLowerLeg', rLL.x, rLL.y, rLL.z, rate + 3, dt, instant);
    this._setBone('leftFoot', lFoot.x, lFoot.y, lFoot.z, rate, dt, instant);
    this._setBone('rightFoot', rFoot.x, rFoot.y, rFoot.z, rate, dt, instant);
  }

  /**
   * Natural periodic eye blinking & subtle joyful expression when soaring in updrafts.
   */
  _updateExpressions(dt, mode, windStrength) {
    const em = this.vrm?.expressionManager;
    if (!em) return;

    if (this._blinkElapsed >= 0) {
      this._blinkElapsed += dt;
      const duration = 0.14;
      if (this._blinkElapsed >= duration) {
        this._blinkElapsed = -1;
        this._blinkCooldown = 2.2 + Math.random() * 3.4;
        em.setValue('blink', 0);
      } else {
        const half = duration * 0.5;
        const val = this._blinkElapsed < half
          ? this._blinkElapsed / half
          : 1 - (this._blinkElapsed - half) / half;
        em.setValue('blink', clamp(val, 0, 1));
      }
    } else {
      this._blinkCooldown -= dt;
      if (this._blinkCooldown <= 0) {
        this._blinkElapsed = 0;
      }
    }

    // Subtle smile when gliding through strong mountain updrafts
    const targetHappy = mode === 'glide' && windStrength > 0.6 ? 0.35 : 0.0;
    const curHappy = em.getValue('happy') || 0;
    em.setValue('happy', damp(curHappy, targetHappy, 4.0, dt));
  }

  /**
   * Animates the stylized anime fallback rig so movement feels lively even before VRM finishes loading.
   */
  _applyFallbackPose(dt, animState) {
    const rig = this.fallbackRig;
    if (!rig) return;
    const { mode = 'idle', speed = 0, isUltrahand = false } = animState;
    const t = this._time;

    let lLegX = 0, rLegX = 0, lKnee = 0.05, rKnee = 0.05;
    let lArmX = 0, rArmX = 0, lArmZ = 0.12, rArmZ = -0.12;
    let torsoX = 0;

    if (mode === 'walk' || mode === 'run') {
      const amp = 0.45 + clamp((speed - 6) / 7, 0, 1) * 0.45;
      const s = Math.sin(this._gaitPhase);
      const c = Math.cos(this._gaitPhase);
      lLegX = -s * amp;
      rLegX = s * amp;
      lKnee = Math.max(0.05, c * amp);
      rKnee = Math.max(0.05, -c * amp);
      lArmX = s * amp * 0.85;
      rArmX = -s * amp * 0.85;
      torsoX = 0.08 + clamp((speed - 6) / 7, 0, 1) * 0.14;
    } else if (mode === 'glide') {
      lArmZ = 2.65;
      rArmZ = -2.65;
      lArmX = -0.25;
      rArmX = -0.25;
      lLegX = 0.30 + Math.sin(t * 2.5) * 0.08;
      rLegX = 0.35 - Math.sin(t * 2.5) * 0.08;
      lKnee = 0.45;
      rKnee = 0.55;
    } else if (mode === 'jump' || mode === 'fall') {
      lLegX = -0.5;
      lKnee = 0.85;
      rLegX = 0.25;
      rKnee = 0.45;
      lArmZ = 0.85;
      rArmZ = -0.85;
    } else if (mode === 'swim') {
      const s = Math.sin(this._swimPhase);
      lArmX = -1.2 + s * 0.6;
      rArmX = -1.2 - s * 0.6;
      lLegX = 0.2 + Math.sin(this._swimPhase * 2) * 0.35;
      rLegX = 0.2 - Math.sin(this._swimPhase * 2) * 0.35;
    } else if (mode === 'climb') {
      const s = Math.sin(this._climbPhase);
      lArmX = -2.2 + s * 0.5;
      rArmX = -2.2 - s * 0.5;
      lLegX = -0.5 - s * 0.35;
      rLegX = -0.5 + s * 0.35;
      lKnee = 0.7;
      rKnee = 0.7;
    }

    if (isUltrahand && mode !== 'glide' && mode !== 'climb') {
      rArmX = -1.48;
      rArmZ = -0.10;
    }

    rig.torso.rotation.x = damp(rig.torso.rotation.x, torsoX, 10, dt);
    rig.leftLeg.upper.rotation.x = damp(rig.leftLeg.upper.rotation.x, lLegX, 12, dt);
    rig.rightLeg.upper.rotation.x = damp(rig.rightLeg.upper.rotation.x, rLegX, 12, dt);
    rig.leftLeg.lower.rotation.x = damp(rig.leftLeg.lower.rotation.x, lKnee, 12, dt);
    rig.rightLeg.lower.rotation.x = damp(rig.rightLeg.lower.rotation.x, rKnee, 12, dt);

    rig.leftArm.shoulder.rotation.x = damp(rig.leftArm.shoulder.rotation.x, lArmX, 12, dt);
    rig.leftArm.shoulder.rotation.z = damp(rig.leftArm.shoulder.rotation.z, lArmZ, 12, dt);
    rig.rightArm.shoulder.rotation.x = damp(rig.rightArm.shoulder.rotation.x, rArmX, 12, dt);
    rig.rightArm.shoulder.rotation.z = damp(rig.rightArm.shoulder.rotation.z, rArmZ, 12, dt);

    // Ponytail & scarf breeze sway
    const breeze = 0.15 + clamp(speed * 0.04, 0, 0.5);
    rig.ponytail.rotation.x = 0.25 + breeze + Math.sin(t * 4.5) * 0.12;
    rig.scarfTail.rotation.x = 0.25 + breeze + Math.cos(t * 5.2) * 0.15;
  }

  dispose() {
    if (this.vrm) {
      this.modelContainer.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.scene.remove(this.root);
    this.scene.remove(this.ultrahandOrb);
  }
}
