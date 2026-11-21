/**
 * OceanHimalayasWorld — Terrain, Sky, Stylized Ocean, Cloud Sea, Floating Islands,
 * Animated Waterfalls, Forests, Grass, Ruins, Prayer Flags, Campfires & Updrafts.
 *
 * Designed in Breath-of-the-Wild / Studio Ghibli painterly aesthetic for "海中喜马拉雅".
 */

import * as THREE from 'three';
import { WORLD_CONFIG, TIME_PRESETS } from '../config/worldConfig.js';
import {
  buildHeightfieldData,
  getTerrainHeight,
  getTerrainNormal,
  fbm,
  noise2D,
  FLOATING_ISLANDS,
  WATERFALLS,
  UPDRAFTS,
  LANDMARKS,
} from './terrainMath.js';

// --- Deterministic Seeded PRNG (Mulberry32) ---
function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Lightweight self-contained BufferGeometry merger for static instanced shapes
 * (supports position, normal, optional uv; converts all inputs to non-indexed).
 */
function mergeSimpleGeometries(geometries) {
  const nonIndexed = geometries.map((g) => (g.index ? g.toNonIndexed() : g));
  let totalVerts = 0;
  let hasUv = true;
  for (const g of nonIndexed) {
    totalVerts += g.attributes.position.count;
    if (!g.attributes.uv) hasUv = false;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = hasUv ? new Float32Array(totalVerts * 2) : null;

  let vOffset = 0;
  for (const g of nonIndexed) {
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position.array;
    const norm = g.attributes.normal.array;
    positions.set(pos, vOffset * 3);
    normals.set(norm, vOffset * 3);
    if (uvs && g.attributes.uv) {
      uvs.set(g.attributes.uv.array, vOffset * 2);
    }
    vOffset += g.attributes.position.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (uvs) {
    merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }
  return merged;
}

// Named high peaks for Tibetan shrines & prayer flags
const HIGH_PEAKS = [
  { id: 'main_summit', x: 19, z: -114, scale: 1.15 },
  { id: 'west_peak', x: -142, z: -62, scale: 1.0 },
  { id: 'east_peak', x: 162, z: -68, scale: 1.0 },
];

// Dynamic quality presets for smooth desktop & smartphone performance
const QUALITY_PRESETS = {
  low: {
    grassRatio: 0.25,
    pineRatio: 0.48,
    cloudBeltRatio: 0.55,
    highCloudRatio: 0.55,
    waterfallMistRatio: 0.5,
    castShadow: false,
    shadowMapSize: 1024,
    shadowHalf: 72,
  },
  medium: {
    grassRatio: 0.55,
    pineRatio: 0.75,
    cloudBeltRatio: 0.75,
    highCloudRatio: 0.75,
    waterfallMistRatio: 0.75,
    castShadow: true,
    shadowMapSize: 1024,
    shadowHalf: 72,
  },
  high: {
    grassRatio: 1.0,
    pineRatio: 1.0,
    cloudBeltRatio: 1.0,
    highCloudRatio: 1.0,
    waterfallMistRatio: 1.0,
    castShadow: true,
    shadowMapSize: 2048,
    shadowHalf: 120,
  },
};

function detectMobileDevice() {
  if (typeof window === 'undefined') return false;
  const coarsePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  const narrowTouch =
    window.innerWidth <= 900 &&
    ('ontouchstart' in window || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0));
  const mobileUA =
    typeof navigator !== 'undefined' &&
    /Android|iPhone|iPad|iPod|Mobile|MicroMessenger/i.test(navigator.userAgent || '');
  return Boolean(coarsePointer || narrowTouch || mobileUA);
}

export class OceanHimalayasWorld {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    // Detect coarse pointer / smartphone environment for clean mobile-first defaults
    this._isMobile = detectMobileDevice();
    this.qualityLevel = this._isMobile ? 'medium' : 'high';

    // Core shared heightfield data (1:1 with Rapier3D Heightfield collider)
    this.heightfieldData = buildHeightfieldData();
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.currentPresetId = 'golden';
    this._time = 0;

    // Instanced mesh references & original maximum instance counts for zero-jank quality scaling
    this._pineTrunkMesh = null;
    this._pineFoliageMesh = null;
    this._grassMesh = null;
    this._maxPineCount = 0;
    this._maxGrassCount = 0;
    this._maxCloudBeltCount = 0;
    this._maxHighCloudCount = 0;
    this._maxWaterfallMistCount = 0;

    // Animated registries updated each frame
    this._shaderUniformSets = [];
    this._cloudRingData = [];
    this._highCloudData = [];
    this._waterfallMistData = [];
    this._campfires = [];
    this._zonaiGlowMaterials = [];
    this._updraftMaterials = [];
    this._waterfallMaterials = [];
    this._prayerFlagUniforms = [];
    this._grassUniforms = [];
    this._terrainUniforms = null;
    this._dummy = new THREE.Object3D();

    // 1. Lighting & Exponential Atmospheric Fog
    this._setupLightingAndFog();

    // 2. Sky Dome (painterly gradient + Mie sun halo + wispy clouds + twinkling stars)
    this._buildSkyDome();

    // 3. Ocean Himalayas Terrain Mesh (exact 1:1 heightfield + painterly BotW shader)
    this._buildTerrain();

    // 4. Stylized Animated Ocean (depth-aware coral turquoise lagoon + shoreline foam + glints)
    this._buildOcean();

    // 5. Swirling Himalayan Cloud Sea Belt + High Sky Cumulus
    this._buildClouds();

    // 6. Floating Sky Islands (inverted rocky cones, lush grass tops, vines, Zonai ruins)
    this._buildFloatingIslands();

    // 7. Animated Cascading Waterfalls + Splash Pools & Rising Mist
    this._buildWaterfalls();

    // 8. Forests, Swaying Meadows, Ancient Ruins, Prayer Flags, Campfires & Updrafts
    this._buildForests();
    this._buildGrass();
    this._buildLandmarksAndFlags();
    this._buildCampfires();
    this._buildUpdrafts();

    // Apply initial quality preset ('medium' on mobile, 'high' on desktop)
    this.setQualityPreset(this.qualityLevel);

    // Initialize world with dramatic "日照金山" (golden hour) preset
    this.setTimePreset('golden');
  }

  // =========================================================================
  // 1. Lighting & Fog
  // =========================================================================
  _setupLightingAndFog() {
    const initQuality = QUALITY_PRESETS[this.qualityLevel] || QUALITY_PRESETS.medium;

    this.sunLight = new THREE.DirectionalLight(0xffc985, 2.8);
    this.sunLight.castShadow = initQuality.castShadow;
    this.sunLight.shadow.mapSize.set(initQuality.shadowMapSize, initQuality.shadowMapSize);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 920;
    const shadowHalf = initQuality.shadowHalf;
    this.sunLight.shadow.camera.left = -shadowHalf;
    this.sunLight.shadow.camera.right = shadowHalf;
    this.sunLight.shadow.camera.top = shadowHalf;
    this.sunLight.shadow.camera.bottom = -shadowHalf;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.08;
    this._shadowFrustumSize = shadowHalf * 2;
    this._shadowTarget = new THREE.Vector3(0, 20, 80);

    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.hemiLight = new THREE.HemisphereLight(0x7ec0ee, 0x3d5563, 1.05);
    this.scene.add(this.hemiLight);

    this.fog = new THREE.FogExp2(0x9ec4d9, 0.00085);
    this.scene.fog = this.fog;
  }

  // =========================================================================
  // 2. Sky Dome
  // =========================================================================
  _buildSkyDome() {
    const skyGeo = new THREE.SphereGeometry(
      4200,
      this._isMobile ? 36 : 48,
      this._isMobile ? 24 : 32
    );

    this._skyUniforms = {
      uSunDir: { value: new THREE.Vector3(-0.7, 0.28, 0.65).normalize() },
      uSkyTop: { value: new THREE.Color(0x2665ad) },
      uSkyHorizon: { value: new THREE.Color(0xf4c794) },
      uSunColor: { value: new THREE.Color(0xffc985) },
      uNight: { value: 0.0 },
      uTime: { value: 0.0 },
    };

    const skyMat = new THREE.ShaderMaterial({
      uniforms: this._skyUniforms,
      precision: 'highp',
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vWorldDir;
        void main() {
          vWorldDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyHorizon;
        uniform vec3 uSunColor;
        uniform float uNight;
        uniform float uTime;

        varying vec3 vWorldDir;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        // Unrolled 3-octave sky fBm (loop-free & mobile GPU friendly)
        float fbmSky(vec2 p) {
          mat2 m = mat2(1.65, 1.15, -1.15, 1.65);
          float s = 0.56 * vnoise(p);
          p = m * p;
          s += 0.29 * vnoise(p);
          p = m * p;
          s += 0.15 * vnoise(p);
          return s;
        }

        void main() {
          vec3 dir = normalize(vWorldDir);
          float elev = clamp(dir.y, -0.25, 1.0);
          float hT = pow(max(clamp(elev, 0.0, 1.0), 0.0001), 0.56);

          // Rich Ghibli 3-stop sky gradient (horizon -> crisp azure mid -> deep zenith)
          vec3 midSky = mix(uSkyHorizon, uSkyTop, 0.48) + vec3(-0.02, 0.05, 0.08) * (1.0 - uNight);
          vec3 col = mix(uSkyHorizon, midSky, smoothstep(0.0, 0.32, hT));
          col = mix(col, uSkyTop, smoothstep(0.24, 0.95, hT));

          // Below horizon blends softly into hazy sea mist
          if (dir.y < 0.0) {
            vec3 belowCol = mix(uSkyHorizon, uSkyTop * 0.55, clamp(-dir.y * 2.2, 0.0, 1.0));
            col = mix(col, belowCol, smoothstep(0.0, -0.18, dir.y));
          }

          // Sun / Moon directional glow & Mie horizon scatter
          vec3 sunD = normalize(uSunDir);
          float sunDot = max(dot(dir, sunD), 0.0001);

          // Warm horizon Mie band concentrated near sun azimuth (NaN-safe at zenith on mobile GPUs)
          float horizonBand = exp(-abs(dir.y) * 5.2);
          vec2 dirXZ = dir.xz / max(length(dir.xz), 0.0001);
          vec2 sunXZ = sunD.xz / max(length(sunD.xz), 0.0001);
          float sunAzScatter = pow(max(dot(dirXZ, sunXZ), 0.0001), 2.5);
          float goldenFactor = (1.0 - uNight) * clamp(1.15 - sunD.y * 1.4, 0.25, 1.0);
          col += uSunColor * horizonBand * (0.22 + 0.48 * sunAzScatter) * goldenFactor;

          // Mie halo + sharp celestial disc
          float mieWide = pow(sunDot, 7.0) * (0.35 * (1.0 - uNight) + 0.14 * uNight);
          float mieTight = pow(sunDot, 96.0) * (0.85 * (1.0 - uNight) + 0.35 * uNight);
          float disc = smoothstep(0.9985, 0.9994, sunDot);
          vec3 discCol = mix(uSunColor * 1.65 + vec3(0.35, 0.25, 0.12), vec3(0.88, 0.94, 1.0) * 1.4, uNight);
          col += uSunColor * mieWide + discCol * mieTight + discCol * disc * 1.8;

          // Subtle painterly high-altitude cloud bands
          if (dir.y > 0.03) {
            vec2 cloudUV = dir.xz / (dir.y + 0.16) * 0.65;
            cloudUV += vec2(uTime * 0.0045, uTime * 0.0018);
            float n1 = fbmSky(cloudUV * 1.4);
            float n2 = fbmSky(cloudUV * 2.9 - vec2(uTime * 0.003, 0.0));
            float cloudMask = smoothstep(0.50, 0.78, n1 * 0.72 + n2 * 0.28);
            cloudMask *= smoothstep(0.03, 0.22, dir.y) * (1.0 - smoothstep(0.72, 0.98, dir.y) * 0.45);

            // Painterly sunlit cloud color with warm silver-gold rim near sun
            vec3 cloudBase = mix(uSkyHorizon * 0.95 + vec3(0.18), vec3(0.18, 0.26, 0.42), uNight);
            vec3 cloudLit = mix(vec3(1.0, 0.96, 0.90), uSunColor * 1.15, goldenFactor * 0.75);
            cloudLit = mix(cloudLit, vec3(0.38, 0.52, 0.78), uNight);
            float sunEdge = pow(sunDot, 3.0) * 0.65 + 0.35;
            vec3 cloudCol = mix(cloudBase, cloudLit, clamp(sunEdge + n2 * 0.35, 0.0, 1.0));
            col = mix(col, cloudCol, cloudMask * (0.58 - 0.28 * uNight));
          }

          // Twinkling procedural stars & subtle Milky Way when uNight > 0.2
          if (uNight > 0.15 && dir.y > 0.02) {
            float starFade = smoothstep(0.15, 0.85, uNight) * smoothstep(0.02, 0.26, dir.y);
            // Spherical grid for crisp stars
            float phi = atan(dir.z, dir.x);
            float theta = asin(clamp(dir.y, -1.0, 1.0));
            vec2 starGrid = vec2(phi * 48.0, theta * 48.0);
            vec2 cell = floor(starGrid);
            vec2 local = fract(starGrid) - 0.5;
            float rnd = hash21(cell);
            if (rnd > 0.925) {
              vec2 jitter = vec2(hash21(cell + 17.3) - 0.5, hash21(cell + 51.7) - 0.5) * 0.62;
              float d = length(local - jitter);
              float twinkle = 0.62 + 0.38 * sin(uTime * (2.2 + rnd * 4.5) + rnd * 62.8);
              float starCore = smoothstep(0.16, 0.01, d) * twinkle;
              vec3 starTint = mix(vec3(0.78, 0.88, 1.0), vec3(1.0, 0.92, 0.76), fract(rnd * 27.1));
              col += starTint * starCore * starFade * 1.45;
            }
            // Second finer star layer
            vec2 starGrid2 = vec2(phi * 92.0 + 13.0, theta * 92.0 - 7.0);
            vec2 cell2 = floor(starGrid2);
            float rnd2 = hash21(cell2 + 99.1);
            if (rnd2 > 0.96) {
              float d2 = length(fract(starGrid2) - 0.5);
              float tw2 = 0.55 + 0.45 * sin(uTime * 3.1 + rnd2 * 90.0);
              col += vec3(0.82, 0.90, 1.0) * smoothstep(0.22, 0.02, d2) * tw2 * starFade * 0.85;
            }
            // Faint Milky Way arc across zenith
            float mwBand = exp(-pow((dir.x * 0.55 + dir.z * 0.45 - 0.25 * dir.y) * 3.4, 2.0));
            float mwNoise = fbmSky(vec2(phi * 2.4, theta * 3.2));
            col += vec3(0.16, 0.24, 0.45) * mwBand * mwNoise * starFade * 0.48;
          }

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    this.skyDome = new THREE.Mesh(skyGeo, skyMat);
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -10;
    this.scene.add(this.skyDome);
  }

  // =========================================================================
  // 3. Ocean Himalayas Terrain Mesh
  // =========================================================================
  _buildTerrain() {
    const { seg, size, vertsPerSide, meshHeights } = this.heightfieldData;
    const half = size * 0.5;

    const geometry = new THREE.PlaneGeometry(size, size, seg, seg);
    geometry.rotateX(-Math.PI / 2);

    const pos = geometry.attributes.position;
    const vertCount = pos.count;

    // Set vertex Y strictly from heightfieldData.meshHeights[iz * (seg + 1) + ix]
    for (let iz = 0; iz <= seg; iz++) {
      for (let ix = 0; ix <= seg; ix++) {
        const idx = iz * vertsPerSide + ix;
        pos.setY(idx, meshHeights[idx]);
      }
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();

    // Rich Breath-of-the-Wild painterly vertex coloring by altitude + slope + noise
    const normals = geometry.attributes.normal;
    const colors = new Float32Array(vertCount * 3);

    // Biome palette colors (linear-friendly vivid painterly tones)
    const cDeepSeabed = new THREE.Color(0x0d364d);
    const cCoralSeabed = new THREE.Color(0x3baea8);
    const cShallowSand = new THREE.Color(0xd2cc9e);
    const cBeachSand = new THREE.Color(0xebd7a3);
    const cBeachWarm = new THREE.Color(0xdec082);
    const cGrassLush = new THREE.Color(0x5da844);
    const cGrassSunlit = new THREE.Color(0x7cc14e);
    const cGrassAlpine = new THREE.Color(0x4b8747);
    const cCliffSlate = new THREE.Color(0x556272);
    const cCliffDark = new THREE.Color(0x3f4a59);
    const cCliffOchre = new THREE.Color(0x988165);
    const cSnowBright = new THREE.Color(0xf4f8fd);
    const cSnowShadow = new THREE.Color(0xc9dff5);
    const cGlacierCyan = new THREE.Color(0x88cde3);

    const tmp = new THREE.Color();
    const cliffCol = new THREE.Color();
    const snowCol = new THREE.Color();

    for (let iz = 0; iz <= seg; iz++) {
      const z = -half + (iz / seg) * size;
      for (let ix = 0; ix <= seg; ix++) {
        const idx = iz * vertsPerSide + ix;
        const x = -half + (ix / seg) * size;
        const y = meshHeights[idx];
        const ny = clamp(normals.getY(idx), 0, 1);

        // Multi-scale painterly variation
        const nPatch = fbm(x * 0.015 + 3.1, z * 0.015 - 2.4, 3);
        const nFine = noise2D(x * 0.065 - 1.7, z * 0.065 + 4.3);
        const strata = 0.5 + 0.5 * Math.sin(y * 0.34 + nPatch * 5.2);

        // Base color by elevation (seabed -> beach -> meadow)
        if (y < 0.0) {
          if (y > -8.0) {
            const t = smoothstep(-8.0, 0.0, y);
            tmp.copy(cCoralSeabed).lerp(cShallowSand, t * 0.72 + nFine * 0.15);
          } else {
            const t = smoothstep(-24.0, -8.0, y);
            tmp.copy(cDeepSeabed).lerp(cCoralSeabed, t);
          }
        } else if (y < 4.5) {
          const t = smoothstep(0.0, 4.5, y);
          tmp.copy(cBeachSand).lerp(cBeachWarm, nPatch * 0.55);
          if (y > 2.8) {
            const toGrass = smoothstep(2.8, 4.5, y);
            tmp.lerp(cGrassLush, toGrass * 0.75);
          }
          // Wet shoreline darkening right near SEA_LEVEL
          if (t < 0.25) {
            tmp.multiplyScalar(0.84 + 0.16 * (t / 0.25));
          }
        } else {
          // Coastal & Alpine meadows (4.5..92m)
          const alpineT = smoothstep(42.0, 92.0, y);
          tmp.copy(cGrassLush).lerp(cGrassSunlit, smoothstep(0.32, 0.74, nPatch));
          tmp.lerp(cGrassAlpine, alpineT * 0.65);
          // Subtle warm meadow variation
          const warmAccent = smoothstep(0.65, 0.92, nFine) * (1.0 - alpineT) * 0.14;
          tmp.r = Math.min(1, tmp.r + warmAccent);
          tmp.g = Math.min(1, tmp.g + warmAccent * 0.6);
        }

        // Steep Cliffs (normal.y < 0.72) — weathered Himalayan granite + ochre strata
        const cliffFactor = 1.0 - smoothstep(0.56, 0.78, ny);
        if (cliffFactor > 0.001 && y > -6.0) {
          cliffCol.copy(cCliffDark).lerp(cCliffSlate, nPatch);
          cliffCol.lerp(cCliffOchre, strata * 0.36 * (1.0 - smoothstep(105.0, 165.0, y)));
          tmp.lerp(cliffCol, cliffFactor);
        }

        // Snow & Glaciers (y > 88m with slope-based accumulation & noise edge)
        const snowLine = WORLD_CONFIG.SNOWLINE_Y + (nPatch - 0.5) * 14.0 - (ny - 0.7) * 18.0;
        const snowAltMask = smoothstep(snowLine - 6.0, snowLine + 16.0, y);
        // Snow sticks strongly to gentler faces, and even steep walls above 138m gather snow streaks
        const slopeSnowAllow = smoothstep(0.42, 0.74, ny) + smoothstep(135.0, 185.0, y) * 0.42;
        const snowMask = clamp(snowAltMask * clamp(slopeSnowAllow, 0, 1), 0, 1);

        if (snowMask > 0.001) {
          snowCol.copy(cSnowShadow).lerp(cSnowBright, smoothstep(0.25, 0.85, ny * 0.7 + nFine * 0.45));
          // Pale glacier cyan crevices on steeper icy shelves above 115m
          const glacierCrevice =
            smoothstep(112.0, 160.0, y) *
            (1.0 - smoothstep(0.45, 0.78, ny)) *
            smoothstep(0.35, 0.75, strata);
          snowCol.lerp(cGlacierCyan, glacierCrevice * 0.65);
          tmp.lerp(snowCol, snowMask);
        }

        colors[idx * 3] = tmp.r;
        colors[idx * 3 + 1] = tmp.g;
        colors[idx * 3 + 2] = tmp.b;
      }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Shared custom uniforms for terrain painterly shader patch
    this._terrainUniforms = {
      uTime: { value: 0.0 },
      uSunDir: { value: new THREE.Vector3(-0.7, 0.28, 0.65).normalize() },
      uSunColor: { value: new THREE.Color(0xffc985) },
      uNight: { value: 0.0 },
    };

    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.02,
      flatShading: false,
    });

    terrainMat.customProgramCacheKey = () => 'ocean-himalayas-terrain-v1';
    terrainMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this._terrainUniforms.uTime;
      shader.uniforms.uSunDir = this._terrainUniforms.uSunDir;
      shader.uniforms.uSunColor = this._terrainUniforms.uSunColor;
      shader.uniforms.uNight = this._terrainUniforms.uNight;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;
          `
        )
        .replace(
          '#include <worldpos_vertex>',
          /* glsl */ `
          #include <worldpos_vertex>
          vec4 tWorldPos = modelMatrix * vec4(transformed, 1.0);
          vTerrainWorldPos = tWorldPos.xyz;
          vTerrainWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
          `
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform float uTime;
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          uniform float uNight;
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;

          float tHash(vec2 p) {
            p = fract(p * vec2(127.1, 311.7));
            p += dot(p, p + 34.5);
            return fract(p.x * p.y);
          }

          float tNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
              mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x),
              u.y
            );
          }
          `
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          {
            // World-space painterly micro-detail (grass weave, rock strata, snow grain)
            float detailA = tNoise(vTerrainWorldPos.xz * 0.22);
            float detailB = tNoise(vTerrainWorldPos.xz * 0.78 + vec2(vTerrainWorldPos.y * 0.28, 0.0));
            float rockBand = sin(vTerrainWorldPos.y * 0.72 + detailA * 3.6) * 0.5 + 0.5;
            float steepMask = 1.0 - smoothstep(0.55, 0.80, vTerrainWorldNormal.y);
            float micro = mix(detailA * 0.6 + detailB * 0.4, rockBand * 0.55 + detailB * 0.45, steepMask);
            diffuseColor.rgb *= (0.91 + 0.18 * micro);

            // Shallow turquoise seabed caustics
            if (vTerrainWorldPos.y < 0.6 && vTerrainWorldPos.y > -12.0) {
              float shallowMask = smoothstep(-11.0, -0.8, vTerrainWorldPos.y) * (1.0 - smoothstep(-0.2, 0.6, vTerrainWorldPos.y));
              vec2 cUv1 = vTerrainWorldPos.xz * 0.24 + vec2(uTime * 0.28, uTime * 0.19);
              vec2 cUv2 = vTerrainWorldPos.xz * 0.31 - vec2(uTime * 0.22, -uTime * 0.26);
              float c1 = clamp(1.0 - abs(tNoise(cUv1) * 2.0 - 1.0), 0.0, 1.0);
              float c2 = clamp(1.0 - abs(tNoise(cUv2) * 2.0 - 1.0), 0.0, 1.0);
              float caust = c1 * c1 * c1 + c2 * c2 * c2;
              diffuseColor.rgb += vec3(0.20, 0.68, 0.72) * caust * shallowMask * (0.45 * (1.0 - uNight * 0.75));
            }
          }
          `
        )
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `
          {
            vec3 nW = normalize(vTerrainWorldNormal);
            vec3 sDir = normalize(uSunDir);
            float ndl = dot(nW, sDir);

            // Subtle BotW painterly soft cel-band lift on sunlit slopes
            float celBand = smoothstep(-0.08, 0.28, ndl);
            outgoingLight *= mix(0.92, 1.07, celBand);

            // Dramatic "日照金山" Alpenglow on high snow peaks during low sun angles!
            float snowHeightMask = smoothstep(82.0, 138.0, vTerrainWorldPos.y);
            float lowSunMask = (1.0 - uNight) * clamp(1.0 - smoothstep(0.18, 0.62, sDir.y), 0.0, 1.0);
            float sunFacing = smoothstep(-0.05, 0.65, ndl);
            vec3 alpenglowColor = mix(vec3(1.0, 0.56, 0.26), uSunColor, 0.45);
            outgoingLight += alpenglowColor * snowHeightMask * lowSunMask * sunFacing * 0.36;

            // Cool crisp Himalayan sky-blue shadow tint on shaded snow faces
            float shadeSnow = snowHeightMask * (1.0 - celBand);
            outgoingLight += vec3(0.06, 0.14, 0.26) * shadeSnow * (0.42 - 0.22 * uNight);
          }
          #include <opaque_fragment>
          `
        );
    };

    this.terrainMesh = new THREE.Mesh(geometry, terrainMat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = true;
    this.scene.add(this.terrainMesh);
  }

  // =========================================================================
  // 4. Animated Stylized Ocean
  // =========================================================================
  _buildOcean() {
    const { seg, size, vertsPerSide, meshHeights } = this.heightfieldData;

    // Encode terrain height in [-26m, +14m] (40m window -> 0.156m precision) into RGBA8 texture
    // Works universally across all WebGL GPUs with hardware LinearFilter!
    const texData = new Uint8Array(vertsPerSide * vertsPerSide * 4);
    const minH = -26.0;
    const maxH = 14.0;
    const invRange = 1.0 / (maxH - minH);

    for (let iz = 0; iz <= seg; iz++) {
      for (let ix = 0; ix <= seg; ix++) {
        const idx = iz * vertsPerSide + ix;
        const h = meshHeights[idx];
        const norm = clamp((h - minH) * invRange, 0, 1);
        const byteVal = Math.round(norm * 255);
        const p = idx * 4;
        texData[p] = byteVal;
        texData[p + 1] = byteVal;
        texData[p + 2] = byteVal;
        texData[p + 3] = 255;
      }
    }

    const heightTex = new THREE.DataTexture(
      texData,
      vertsPerSide,
      vertsPerSide,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    heightTex.minFilter = THREE.LinearFilter;
    heightTex.magFilter = THREE.LinearFilter;
    heightTex.wrapS = THREE.ClampToEdgeWrapping;
    heightTex.wrapT = THREE.ClampToEdgeWrapping;
    heightTex.flipY = false;
    heightTex.needsUpdate = true;

    // Mobile-friendly ocean tessellation (112x112 mobile / 144x144 desktop) — smooth waves matching getWaveHeight
    const oceanSegs = this._isMobile ? 112 : 144;
    const oceanGeo = new THREE.PlaneGeometry(
      WORLD_CONFIG.OCEAN_SIZE,
      WORLD_CONFIG.OCEAN_SIZE,
      oceanSegs,
      oceanSegs
    );
    oceanGeo.rotateX(-Math.PI / 2);

    this._oceanUniforms = {
      uTime: { value: 0.0 },
      uSunDir: { value: new THREE.Vector3(-0.7, 0.28, 0.65).normalize() },
      uSunColor: { value: new THREE.Color(0xffc985) },
      uSkyTop: { value: new THREE.Color(0x2665ad) },
      uSkyHorizon: { value: new THREE.Color(0xf4c794) },
      uFogColor: { value: new THREE.Color(0x9ec4d9) },
      uFogDensity: { value: 0.00085 },
      uNight: { value: 0.0 },
      uHeightMap: { value: heightTex },
      uWorldSize: { value: size },
      uSeaLevel: { value: WORLD_CONFIG.SEA_LEVEL },
    };

    const oceanMat = new THREE.ShaderMaterial({
      uniforms: this._oceanUniforms,
      precision: 'highp',
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSeaLevel;

        varying vec3 vWorldPos;
        varying float vWaveHeight;
        varying float vFogDepth;

        float computeWave(vec2 xz, float t) {
          float w1 = sin(xz.x * 0.028 + xz.y * 0.019 + t * 1.15) * 0.16;
          float w2 = sin(xz.x * -0.021 + xz.y * 0.034 + t * 0.88) * 0.11;
          float w3 = cos((xz.x + xz.y) * 0.045 - t * 1.45) * 0.06;
          return w1 + w2 + w3;
        }

        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float w = computeWave(wp.xz, uTime);
          wp.y = uSeaLevel + w;
          vWorldPos = wp.xyz;
          vWaveHeight = w;

          vec4 mvPos = viewMatrix * wp;
          vFogDepth = -mvPos.z;
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyHorizon;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uNight;
        uniform sampler2D uHeightMap;
        uniform float uWorldSize;

        varying vec3 vWorldPos;
        varying float vWaveHeight;
        varying float vFogDepth;

        float hash21(vec2 p) {
          p = fract(p * vec2(127.1, 311.7));
          p += dot(p, p + 34.12);
          return fract(p.x * p.y);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
            mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        // Loop-free 2-octave unrolled water fBm for crisp ripples at mobile-friendly ALU cost
        float fbmWater(vec2 p) {
          float s = 0.64 * noise(p);
          s += 0.36 * noise(p * 2.07 + vec2(11.3, 7.7));
          return s;
        }

        void main() {
          // Lookup terrain height from baked heightfield texture
          vec2 uv = (vWorldPos.xz / uWorldSize) + 0.5;
          float inBounds = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          float hNorm = texture2D(uHeightMap, clamp(uv, 0.002, 0.998)).r;
          float terrainH = mix(-26.0, -26.0 + hNorm * 40.0, inBounds);
          float depth = max(0.0, vWorldPos.y - terrainH);

          // Discard dry inland pixels cleanly (with slight shore feather)
          if (vWorldPos.y < terrainH - 0.15) discard;

          // Animated high-frequency stylized ripple normals (forward differences reuse r1/r2)
          vec2 p1 = vWorldPos.xz * 0.14 + vec2(uTime * 0.36, uTime * 0.24);
          vec2 p2 = vWorldPos.xz * 0.23 - vec2(uTime * 0.28, -uTime * 0.31);
          float r1 = fbmWater(p1);
          float r2 = fbmWater(p2);
          float ripple = (r1 + r2) * 0.5;

          float eps = 0.35;
          float rx = fbmWater(p1 + vec2(eps, 0.0)) - r1;
          float rz = fbmWater(p2 + vec2(0.0, eps)) - r2;
          vec3 N = normalize(vec3(-rx * 0.84, 1.0, -rz * 0.84));

          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L = normalize(uSunDir);

          // BotW / Ghibli Ocean Palette: shallow coral turquoise -> cerulean -> deep sapphire
          vec3 cShallow = mix(vec3(0.24, 0.87, 0.82), vec3(0.08, 0.28, 0.38), uNight);
          vec3 cMid     = mix(vec3(0.07, 0.48, 0.68), vec3(0.04, 0.16, 0.30), uNight);
          vec3 cDeep    = mix(vec3(0.04, 0.21, 0.44), vec3(0.02, 0.07, 0.18), uNight);

          float tShallow = smoothstep(0.0, 6.5, depth);
          float tDeep = smoothstep(5.0, 22.0, depth);
          vec3 waterCol = mix(cShallow, cMid, tShallow);
          waterCol = mix(waterCol, cDeep, tDeep);

          // Painterly sunlit wave-band sheen
          float waveHighlight = smoothstep(0.56, 0.82, ripple + vWaveHeight * 0.65);
          waterCol += mix(vec3(0.08, 0.20, 0.24), vec3(0.03, 0.07, 0.14), uNight) * waveHighlight;

          // Fresnel sky reflection
          float fresnelBase = clamp(1.0 - max(dot(N, V), 0.0), 0.0001, 1.0);
          float fresnel = pow(fresnelBase, 3.6);
          vec3 skyRefl = mix(uSkyHorizon, uSkyTop, 0.38);
          waterCol = mix(waterCol, skyRefl, clamp(fresnel * 0.72, 0.06, 0.75));

          // Golden sun specular glints (BotW crisp sparkle + warm path)
          vec3 H = normalize(L + V);
          float ndh = max(dot(N, H), 0.0001);
          float specBroad = pow(ndh, 48.0) * (0.48 * (1.0 - uNight * 0.65));
          float specSparkle = smoothstep(0.992, 0.999, ndh * (0.94 + 0.12 * ripple));
          specSparkle += pow(ndh, 320.0) * 1.65;
          waterCol += uSunColor * (specBroad + specSparkle * (1.15 - 0.55 * uNight));

          // Sparkling animated shoreline white foam where water depth is shallow
          float shoreWave = sin(depth * 4.4 - uTime * 2.6 + r1 * 4.2) * 0.5 + 0.5;
          float foamContact = 1.0 - smoothstep(0.0, 0.85, depth);
          float foamBand = (1.0 - smoothstep(0.2, 2.8, depth)) * smoothstep(0.54, 0.80, shoreWave * 0.72 + r2 * 0.55);
          // Subtle open-ocean whitecap flecks
          float openFoam = smoothstep(0.76, 0.92, r1 * r2 * 1.45 + vWaveHeight * 0.38) * 0.32;
          float totalFoam = clamp(foamContact * 0.95 + foamBand * 0.85 + openFoam, 0.0, 1.0);
          vec3 foamColor = mix(vec3(0.96, 0.99, 1.0), vec3(0.48, 0.60, 0.78), uNight);
          foamColor = mix(foamColor, uSunColor * 0.5 + vec3(0.55), (1.0 - uNight) * 0.25);
          waterCol = mix(waterCol, foamColor, totalFoam);

          // Alpha: translucent turquoise over shallow reefs, opaque deep sapphire ocean
          float alpha = mix(0.48, 0.95, smoothstep(0.25, 7.5, depth));
          alpha = clamp(max(alpha, totalFoam * 0.92), 0.0, 0.97);
          // Smooth edge feather right where water kisses sand
          alpha *= smoothstep(-0.12, 0.18, vWorldPos.y - terrainH);

          // Exact Three.js FogExp2 atmospheric blending into the horizon
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
          waterCol = mix(waterCol, uFogColor, clamp(fogFactor, 0.0, 1.0));

          gl_FragColor = vec4(waterCol, alpha);
        }
      `,
    });

    this.oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
    this.oceanMesh.position.y = WORLD_CONFIG.SEA_LEVEL;
    this.oceanMesh.renderOrder = 2;
    this.scene.add(this.oceanMesh);
  }

  // =========================================================================
  // 5. Swirling Himalayan Cloud Sea Belt + High Sky Clouds
  // =========================================================================
  _buildClouds() {
    const rng = createRng(90210);

    // Build a soft stylized multi-lobe cloud cluster geometry (3 overlapping puffs)
    const cloudDetail = this._isMobile ? 1 : 2;
    const lobeA = new THREE.IcosahedronGeometry(1.0, cloudDetail);
    lobeA.scale(1.45, 0.56, 1.15);
    const lobeB = new THREE.IcosahedronGeometry(0.78, cloudDetail);
    lobeB.scale(1.2, 0.52, 1.0);
    lobeB.translate(0.95, -0.06, 0.22);
    const lobeC = new THREE.IcosahedronGeometry(0.72, cloudDetail);
    lobeC.scale(1.15, 0.48, 0.95);
    lobeC.translate(-0.88, -0.09, -0.18);
    const cloudGeo = mergeSimpleGeometries([lobeA, lobeB, lobeC]);
    lobeA.dispose();
    lobeB.dispose();
    lobeC.dispose();

    this._cloudUniforms = {
      uSunDir: { value: new THREE.Vector3(-0.7, 0.28, 0.65).normalize() },
      uSunColor: { value: new THREE.Color(0xffc985) },
      uSkyTop: { value: new THREE.Color(0x2665ad) },
      uSkyHorizon: { value: new THREE.Color(0xf4c794) },
      uFogColor: { value: new THREE.Color(0x9ec4d9) },
      uFogDensity: { value: 0.00085 },
      uNight: { value: 0.0 },
    };

    const createCloudMaterial = (baseOpacity) =>
      new THREE.ShaderMaterial({
        uniforms: {
          ...this._cloudUniforms,
          uOpacity: { value: baseOpacity },
        },
        precision: 'highp',
        transparent: true,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying vec3 vWorldNormal;
          varying vec3 vWorldPos;
          varying float vFogDepth;
          void main() {
            mat4 instMat = modelMatrix;
            #ifdef USE_INSTANCING
              instMat = modelMatrix * instanceMatrix;
            #endif
            vec4 wp = instMat * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            vWorldNormal = normalize(mat3(instMat) * normal);
            vec4 mvPos = viewMatrix * wp;
            vFogDepth = -mvPos.z;
            gl_Position = projectionMatrix * mvPos;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          uniform vec3 uSkyTop;
          uniform vec3 uSkyHorizon;
          uniform vec3 uFogColor;
          uniform float uFogDensity;
          uniform float uNight;
          uniform float uOpacity;

          varying vec3 vWorldNormal;
          varying vec3 vWorldPos;
          varying float vFogDepth;

          void main() {
            vec3 N = normalize(vWorldNormal);
            vec3 L = normalize(uSunDir);
            vec3 V = normalize(cameraPosition - vWorldPos);

            float ndl = dot(N, L) * 0.5 + 0.5;
            float upFactor = N.y * 0.5 + 0.5;

            // Studio Ghibli sunlit cloud shading: luminous sunlit cream tops, soft sky-blue undersides
            vec3 dayLit = mix(vec3(1.0, 0.99, 0.96), uSunColor * 1.18, clamp(1.0 - L.y * 1.1, 0.12, 0.55));
            vec3 dayShadow = mix(uSkyTop * 0.42 + vec3(0.46, 0.52, 0.62), uSkyHorizon * 0.85, 0.48);
            vec3 nightLit = vec3(0.32, 0.42, 0.60);
            vec3 nightShadow = vec3(0.14, 0.20, 0.34);

            vec3 litCol = mix(dayLit, nightLit, uNight);
            vec3 shadowCol = mix(dayShadow, nightShadow, uNight);

            float shade = smoothstep(0.18, 0.82, ndl * 0.55 + upFactor * 0.55);
            vec3 col = mix(shadowCol, litCol, shade);

            // Soft silver/golden forward-scattering rim when looking toward sun
            float rimEdge = clamp(1.0 - max(dot(N, V), 0.0), 0.0001, 1.0);
            float sunBack = max(dot(-V, L), 0.0001);
            float rim = pow(rimEdge, 2.2) * (sunBack * sunBack);
            col += uSunColor * rim * (0.45 * (1.0 - uNight * 0.65));

            // Soften puff silhouettes with edge-facing alpha falloff
            float edgeSoft = smoothstep(0.08, 0.62, abs(dot(N, V)));
            float alpha = uOpacity * (0.32 + 0.68 * edgeSoft);

            // Scene exponential fog
            float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
            col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));

            gl_FragColor = vec4(col, alpha);
          }
        `,
      });

    // 5a. Delicate Swirling Himalayan Cloud Sea Belt hugging the mountain waist (y ~ CLOUD_BELT_Y)
    // Kept compact around the Himalayan massif so snow peaks soar boldly above & bay sky stays clear!
    const beltCount = 110;
    this._maxCloudBeltCount = beltCount;
    const beltMat = createCloudMaterial(0.52);
    this._cloudBeltMesh = new THREE.InstancedMesh(cloudGeo, beltMat, beltCount);
    this._cloudBeltMesh.renderOrder = 3;
    this._cloudBeltMesh.frustumCulled = false;

    const beltCenterX = 8;
    const beltCenterZ = -108;

    for (let i = 0; i < beltCount; i++) {
      // Wrap wispy cloud ribbons along the mid-mountain flanks
      const angle = (i / beltCount) * Math.PI * 2 + (rng() - 0.5) * 0.22;
      const band = i % 2;
      const radius = band === 0 ? 128 + rng() * 52 : 178 + rng() * 58;

      // Elliptical along East-West Himalayan arc, slim along North-South so it never covers the bay
      const rx = radius * 1.28;
      const rz = radius * 0.56;
      const baseY = WORLD_CONFIG.CLOUD_BELT_Y - 4.0 + (rng() - 0.5) * 14.0;
      const scaleX = 12 + rng() * 16;
      const scaleY = 3.2 + rng() * 4.2;
      const scaleZ = 10 + rng() * 14;
      const orbitSpeed = (0.004 + rng() * 0.005) * (band === 1 ? -0.75 : 1.0);
      const bobAmp = 0.8 + rng() * 1.6;
      const bobPhase = rng() * Math.PI * 2;
      const rotY = rng() * Math.PI * 2;

      this._cloudRingData.push({
        centerX: beltCenterX,
        centerZ: beltCenterZ,
        rx,
        rz,
        angle,
        baseY,
        scaleX,
        scaleY,
        scaleZ,
        orbitSpeed,
        bobAmp,
        bobPhase,
        rotY,
      });
    }

    // Deterministic Fisher-Yates shuffle so reducing .count thins clouds evenly 360° around peaks
    for (let i = this._cloudRingData.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = this._cloudRingData[i];
      this._cloudRingData[i] = this._cloudRingData[j];
      this._cloudRingData[j] = tmp;
    }

    this.scene.add(this._cloudBeltMesh);

    // 5b. High Sky Ghibli Cumulus Clusters (y ~ 285..385m)
    const highCount = 72;
    this._maxHighCloudCount = highCount;
    const highMat = createCloudMaterial(0.72);
    this._highCloudMesh = new THREE.InstancedMesh(cloudGeo, highMat, highCount);
    this._highCloudMesh.renderOrder = 3;
    this._highCloudMesh.frustumCulled = false;

    for (let i = 0; i < highCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = 220 + rng() * 780;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist - 60;
      const y = 285 + rng() * 110;
      const sx = 28 + rng() * 44;
      const sy = 10 + rng() * 16;
      const sz = 22 + rng() * 34;
      this._highCloudData.push({
        x,
        y,
        z,
        sx,
        sy,
        sz,
        driftSpeed: 1.8 + rng() * 2.8,
        rotY: rng() * Math.PI * 2,
        phase: rng() * Math.PI * 2,
      });
    }
    this.scene.add(this._highCloudMesh);

    this._updateCloudMatrices(0);
  }

  _updateCloudMatrices(elapsedTime) {
    const dummy = this._dummy;

    const beltActive = Math.min(this._cloudBeltMesh.count, this._cloudRingData.length);
    for (let i = 0; i < beltActive; i++) {
      const c = this._cloudRingData[i];
      const a = c.angle + elapsedTime * c.orbitSpeed;
      const x = c.centerX + Math.cos(a) * c.rx;
      const z = c.centerZ + Math.sin(a) * c.rz;
      const y = c.baseY + Math.sin(elapsedTime * 0.45 + c.bobPhase) * c.bobAmp;

      dummy.position.set(x, y, z);
      dummy.rotation.set(0, c.rotY + a * 0.35, 0);
      dummy.scale.set(c.scaleX, c.scaleY, c.scaleZ);
      dummy.updateMatrix();
      this._cloudBeltMesh.setMatrixAt(i, dummy.matrix);
    }
    this._cloudBeltMesh.instanceMatrix.needsUpdate = true;

    const wrapSpan = 1900;
    const highActive = Math.min(this._highCloudMesh.count, this._highCloudData.length);
    for (let i = 0; i < highActive; i++) {
      const c = this._highCloudData[i];
      const wx = ((c.x + elapsedTime * c.driftSpeed + wrapSpan * 0.5) % wrapSpan) - wrapSpan * 0.5;
      const wy = c.y + Math.sin(elapsedTime * 0.25 + c.phase) * 2.5;
      dummy.position.set(wx, wy, c.z);
      dummy.rotation.set(0, c.rotY, 0);
      dummy.scale.set(c.sx, c.sy, c.sz);
      dummy.updateMatrix();
      this._highCloudMesh.setMatrixAt(i, dummy.matrix);
    }
    this._highCloudMesh.instanceMatrix.needsUpdate = true;
  }

  // =========================================================================
  // 6. Floating Sky Islands (FLOATING_ISLANDS)
  // =========================================================================
  _buildFloatingIslands() {
    const rng = createRng(4411);
    const ruinStoneMat = new THREE.MeshStandardMaterial({
      color: 0xaab0a8,
      roughness: 0.9,
      metalness: 0.05,
    });
    const mossStoneMat = new THREE.MeshStandardMaterial({
      color: 0x7e9478,
      roughness: 0.92,
      metalness: 0.04,
    });
    const vineMat = new THREE.MeshStandardMaterial({
      color: 0x3b7d42,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    const zonaiGlowMat = new THREE.MeshStandardMaterial({
      color: 0x265e5d,
      emissive: new THREE.Color(0x38f2d4),
      emissiveIntensity: 1.6,
      roughness: 0.35,
      metalness: 0.2,
    });
    this._zonaiGlowMaterials.push(zonaiGlowMat);

    for (const island of FLOATING_ISLANDS) {
      const group = new THREE.Group();
      group.position.set(island.x, island.y, island.z);

      const R = island.radius;
      const T = island.thickness;

      // 6a. Sculpted inverted rocky cone underside (top sits at y = -0.35 relative to island.y)
      const rockGeo = new THREE.CylinderGeometry(R * 0.96, R * 0.12, T, 22, 6, false);
      rockGeo.translate(0, -T * 0.5 - 0.35, 0);
      const rPos = rockGeo.attributes.position;
      const rCols = new Float32Array(rPos.count * 3);
      const cRockTop = new THREE.Color(0x6e7874);
      const cRockMid = new THREE.Color(0x555e6a);
      const cRockTip = new THREE.Color(0x3b424d);
      const cTmp = new THREE.Color();

      for (let i = 0; i < rPos.count; i++) {
        const vx = rPos.getX(i);
        const vy = rPos.getY(i);
        const vz = rPos.getZ(i);
        const depthT = clamp((-vy - 0.35) / T, 0, 1);
        const angle = Math.atan2(vz, vx);
        const n = fbm(Math.cos(angle) * 2.2 + island.x * 0.1, depthT * 3.5 + island.z * 0.1, 3);
        const crag = 0.78 + n * 0.44;
        if (depthT > 0.04) {
          rPos.setX(i, vx * crag);
          rPos.setZ(i, vz * crag);
          if (depthT > 0.95) {
            rPos.setY(i, vy - n * 4.5);
          }
        }
        cTmp.copy(cRockTop).lerp(cRockMid, smoothstep(0.0, 0.55, depthT));
        cTmp.lerp(cRockTip, smoothstep(0.5, 1.0, depthT));
        rCols[i * 3] = cTmp.r;
        rCols[i * 3 + 1] = cTmp.g;
        rCols[i * 3 + 2] = cTmp.b;
      }
      rockGeo.setAttribute('color', new THREE.BufferAttribute(rCols, 3));
      rockGeo.computeVertexNormals();

      const rockMesh = new THREE.Mesh(
        rockGeo,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.92,
          metalness: 0.04,
          flatShading: true,
        })
      );
      rockMesh.castShadow = true;
      rockMesh.receiveShadow = true;
      group.add(rockMesh);

      // 6b. Lush flat walkable mossy grass cap (top plane sits precisely at local y = 0 -> world island.y)
      const capGeo = new THREE.CylinderGeometry(R * 1.02, R * 0.96, 1.4, 24, 1);
      capGeo.translate(0, -0.7, 0);
      const cPos = capGeo.attributes.position;
      for (let i = 0; i < cPos.count; i++) {
        const vx = cPos.getX(i);
        const vz = cPos.getZ(i);
        const rad = Math.hypot(vx, vz);
        if (rad > R * 0.35) {
          const ang = Math.atan2(vz, vx);
          const edgeJagged = 0.94 + 0.12 * noise2D(Math.cos(ang) * 3.0 + island.x, Math.sin(ang) * 3.0);
          cPos.setX(i, vx * edgeJagged);
          cPos.setZ(i, vz * edgeJagged);
        }
      }
      capGeo.computeVertexNormals();
      const capMesh = new THREE.Mesh(
        capGeo,
        new THREE.MeshStandardMaterial({
          color: 0x64b34a,
          roughness: 0.88,
          metalness: 0.01,
        })
      );
      capMesh.castShadow = true;
      capMesh.receiveShadow = true;
      group.add(capMesh);

      // 6c. Hanging emerald vines & aerial roots dangling below rim
      const vineCount = Math.floor(R * 0.85);
      for (let v = 0; v < vineCount; v++) {
        const ang = (v / vineCount) * Math.PI * 2 + rng() * 0.25;
        const vr = R * (0.86 + rng() * 0.12);
        const vineLen = 5.5 + rng() * (T * 0.85);
        const vineGeo = new THREE.PlaneGeometry(0.55 + rng() * 0.35, vineLen, 1, 5);
        vineGeo.translate(0, -vineLen * 0.5, 0);
        // Gentle curved sway shape
        const vp = vineGeo.attributes.position;
        for (let k = 0; k < vp.count; k++) {
          const vy = vp.getY(k);
          vp.setZ(k, Math.sin(vy * 0.45 + v) * 0.35);
        }
        vineGeo.computeVertexNormals();
        const vine = new THREE.Mesh(vineGeo, vineMat);
        vine.position.set(Math.cos(ang) * vr, -0.4, Math.sin(ang) * vr);
        vine.rotation.y = ang + Math.PI * 0.5;
        group.add(vine);
      }

      // 6d. Floating orbital mini-boulders tethered near the island underside
      for (let b = 0; b < 5; b++) {
        const ang = rng() * Math.PI * 2;
        const br = R * (1.12 + rng() * 0.35);
        const by = -2.5 - rng() * (T * 0.65);
        const bSize = 1.1 + rng() * 1.8;
        const bMesh = new THREE.Mesh(
          new THREE.DodecahedronGeometry(bSize, 0),
          mossStoneMat
        );
        bMesh.position.set(Math.cos(ang) * br, by, Math.sin(ang) * br);
        bMesh.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        bMesh.castShadow = true;
        group.add(bMesh);
      }

      // 6e. Ancient Zonai Ruins & Glowing Monoliths (when hasRuin) OR Wind-swept Sky Pines
      if (island.hasRuin) {
        const ringR = R * 0.66;
        const pillarCount = R > 20 ? 8 : 6;

        // Weathered circular stone paving ring
        const ringGeo = new THREE.RingGeometry(ringR - 2.6, ringR + 2.2, 24);
        ringGeo.rotateX(-Math.PI / 2);
        const ringMesh = new THREE.Mesh(ringGeo, mossStoneMat);
        ringMesh.position.y = 0.06;
        ringMesh.receiveShadow = true;
        group.add(ringMesh);

        for (let p = 0; p < pillarCount; p++) {
          const ang = (p / pillarCount) * Math.PI * 2 + 0.3;
          const px = Math.cos(ang) * ringR;
          const pz = Math.sin(ang) * ringR;
          const broken = p % 3 === 1;
          const h = broken ? 3.2 + rng() * 2.2 : 6.8 + rng() * 1.4;

          const col = new THREE.Mesh(
            new THREE.CylinderGeometry(0.62, 0.78, h, 8),
            ruinStoneMat
          );
          col.position.set(px, h * 0.5, pz);
          col.castShadow = true;
          col.receiveShadow = true;
          group.add(col);

          // Capital slab on unbroken pillars
          if (!broken) {
            const cap = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 1.9), mossStoneMat);
            cap.position.set(px, h + 0.25, pz);
            cap.rotation.y = -ang;
            cap.castShadow = true;
            group.add(cap);
          }
        }

        // Grand Ancient Stone Archway on the north edge framing the Himalayan peaks
        const archZ = -ringR * 0.85;
        const archSpan = R > 20 ? 8.0 : 6.0;
        const archH = R > 20 ? 9.5 : 7.5;
        const leftP = new THREE.Mesh(new THREE.BoxGeometry(1.5, archH, 1.5), ruinStoneMat);
        leftP.position.set(-archSpan * 0.5, archH * 0.5, archZ);
        leftP.castShadow = true;
        const rightP = leftP.clone();
        rightP.position.x = archSpan * 0.5;
        const lintel = new THREE.Mesh(
          new THREE.BoxGeometry(archSpan + 2.8, 1.45, 2.0),
          mossStoneMat
        );
        lintel.position.set(0, archH + 0.65, archZ);
        lintel.castShadow = true;
        group.add(leftP, rightP, lintel);

        // Glowing Turquoise Zonai Monoliths flanking the sanctuary
        const monolithPositions = [
          [-ringR * 0.42, archZ + 2.2],
          [ringR * 0.42, archZ + 2.2],
        ];
        for (const [mx, mz] of monolithPositions) {
          const monoBase = new THREE.Mesh(new THREE.BoxGeometry(1.6, 4.6, 1.1), ruinStoneMat);
          monoBase.position.set(mx, 2.3, mz);
          monoBase.castShadow = true;
          group.add(monoBase);

          // Etched glowing cyan rune band + hovering crystal core
          const runeStrip = new THREE.Mesh(
            new THREE.BoxGeometry(1.68, 0.9, 1.18),
            zonaiGlowMat
          );
          runeStrip.position.set(mx, 3.0, mz);
          group.add(runeStrip);

          const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.68, 0), zonaiGlowMat);
          crystal.position.set(mx, 5.45, mz);
          group.add(crystal);
        }

        if (island.id === 'sky_sanctuary') {
          const sanctLight = new THREE.PointLight(0x42f5d8, 2.6, 42, 1.6);
          sanctLight.position.set(0, 6.0, archZ + 2.5);
          group.add(sanctLight);
        }
      } else {
        // Non-ruin sky island: lush lone sky-pines & weathered lookout rock
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3d28, roughness: 0.95 });
        const pineMat = new THREE.MeshStandardMaterial({ color: 0x2f7545, roughness: 0.85 });
        const treeOffsets = [
          [-4.2, -3.5, 1.15],
          [5.1, -1.8, 0.95],
          [-1.5, 5.2, 0.85],
        ];
        for (const [tx, tz, sc] of treeOffsets) {
          const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(0.28 * sc, 0.45 * sc, 3.5 * sc, 6),
            trunkMat
          );
          trunk.position.set(tx, 1.75 * sc, tz);
          trunk.castShadow = true;
          group.add(trunk);

          for (let tier = 0; tier < 3; tier++) {
            const cone = new THREE.Mesh(
              new THREE.ConeGeometry((2.4 - tier * 0.52) * sc, (2.6 - tier * 0.25) * sc, 7),
              pineMat
            );
            cone.position.set(tx, (3.2 + tier * 1.45) * sc, tz);
            cone.castShadow = true;
            group.add(cone);
          }
        }
      }

      this.scene.add(group);
    }
  }

  // =========================================================================
  // 7. Animated Waterfalls + Rising Mist Particles (WATERFALLS)
  // =========================================================================
  _buildWaterfalls() {
    const rng = createRng(7717);
    const mistPuffGeo = new THREE.IcosahedronGeometry(1.0, 1);
    const mistMat = new THREE.MeshBasicMaterial({
      color: 0xe6f8ff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this._mistMaterial = mistMat;

    const puffsPerWaterfall = 16;
    const totalMistPuffs = WATERFALLS.length * puffsPerWaterfall;
    this._maxWaterfallMistCount = totalMistPuffs;
    this._waterfallMistMesh = new THREE.InstancedMesh(mistPuffGeo, mistMat, totalMistPuffs);
    this._waterfallMistMesh.renderOrder = 4;
    this._waterfallMistMesh.frustumCulled = false;

    const perWaterfallMist = [];

    for (const wf of WATERFALLS) {
      const dx = wf.bottomX - wf.topX;
      const dz = wf.bottomZ - wf.topZ;
      const segLen = Math.hypot(dx, dz) || 1;
      const dirX = dx / segLen;
      const dirZ = dz / segLen;
      // Perpendicular vector across waterfall width
      const perpX = -dirZ;
      const perpZ = dirX;

      // Trace cascade from slightly behind crest down to SEA_LEVEL so it always splashes cleanly into bay
      let endDist = segLen;
      for (let d = segLen; d <= segLen * 3.2; d += 2.0) {
        const sx = wf.topX + dirX * d;
        const sz = wf.topZ + dirZ * d;
        endDist = d;
        if (getTerrainHeight(sx, sz) <= WORLD_CONFIG.SEA_LEVEL - 0.5) break;
      }

      const stepsU = 8;
      const stepsV = 24;
      const positions = [];
      const uvs = [];
      const indices = [];

      const startDist = -3.0;
      const totalDist = endDist - startDist;

      for (let iv = 0; iv <= stepsV; iv++) {
        const v = iv / stepsV; // 0 = crest, 1 = splash base
        const dist = startDist + v * totalDist;
        const cx = wf.topX + dirX * dist;
        const cz = wf.topZ + dirZ * dist;
        const groundY = getTerrainHeight(cx, cz);

        // Gently arch ribbon above terrain cliff and plunge into sea at base
        const clearance = v < 0.08 ? 0.4 + v * 12.0 : 1.4 + Math.sin(v * Math.PI) * 1.1;
        const cy =
          v > 0.92
            ? Math.max(WORLD_CONFIG.SEA_LEVEL - 0.4, groundY * (1 - (v - 0.92) / 0.08))
            : Math.max(WORLD_CONFIG.SEA_LEVEL - 0.3, groundY + clearance);

        const halfW = wf.width * (0.48 + v * 0.24);

        for (let iu = 0; iu <= stepsU; iu++) {
          const u = iu / stepsU; // 0..1 across width
          const across = (u - 0.5) * 2.0; // -1..1
          // Convex water curtain bow (slightly proud in the middle)
          const bow = (1.0 - across * across) * 0.85;
          const px = cx + perpX * across * halfW + dirX * bow;
          const pz = cz + perpZ * across * halfW + dirZ * bow;
          const py = cy + bow * 0.35;
          positions.push(px, py, pz);
          uvs.push(u, v);
        }
      }

      const row = stepsU + 1;
      for (let iv = 0; iv < stepsV; iv++) {
        for (let iu = 0; iu < stepsU; iu++) {
          const a = iv * row + iu;
          const b = a + 1;
          const c = a + row;
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }

      const wfGeo = new THREE.BufferGeometry();
      wfGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      wfGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      wfGeo.setIndex(indices);
      wfGeo.computeVertexNormals();

      const wfUniforms = {
        uTime: { value: 0.0 },
        uSunColor: { value: new THREE.Color(0xffc985) },
        uFogColor: { value: new THREE.Color(0x9ec4d9) },
        uFogDensity: { value: 0.00085 },
        uNight: { value: 0.0 },
      };

      const wfMat = new THREE.ShaderMaterial({
        uniforms: wfUniforms,
        precision: 'highp',
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying float vFogDepth;
          void main() {
            vUv = uv;
            vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
            vFogDepth = -mvPos.z;
            gl_Position = projectionMatrix * mvPos;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uSunColor;
          uniform vec3 uFogColor;
          uniform float uFogDensity;
          uniform float uNight;

          varying vec2 vUv;
          varying float vFogDepth;

          float hash(vec2 p) {
            p = fract(p * vec2(127.1, 311.7));
            p += dot(p, p + 34.12);
            return fract(p.x * p.y);
          }

          float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
              mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
              u.y
            );
          }

          void main() {
            // Fast scrolling vertical foaming streaks
            vec2 uv1 = vec2(vUv.x * 7.5, vUv.y * 5.0 - uTime * 2.15);
            vec2 uv2 = vec2(vUv.x * 14.0 + 3.1, vUv.y * 9.0 - uTime * 3.4);
            float streak1 = noise(uv1);
            float streak2 = noise(uv2);
            float foam = smoothstep(0.32, 0.80, streak1 * 0.62 + streak2 * 0.52);

            // Surge foam at crest & splash bottom
            float crestFoam = 1.0 - smoothstep(0.0, 0.14, vUv.y);
            float splashFoam = smoothstep(0.76, 0.98, vUv.y);
            foam = clamp(foam + crestFoam * 0.55 + splashFoam * 0.72, 0.0, 1.0);

            // Feathered edges
            float sideMask = smoothstep(0.0, 0.16, vUv.x) * (1.0 - smoothstep(0.84, 1.0, vUv.x));
            float topMask = smoothstep(0.0, 0.07, vUv.y);
            float botMask = 1.0 - smoothstep(0.95, 1.0, vUv.y);

            vec3 aquaCol = mix(vec3(0.42, 0.88, 0.94), vec3(0.16, 0.34, 0.48), uNight);
            vec3 whiteCol = mix(vec3(0.96, 0.99, 1.0), vec3(0.56, 0.68, 0.84), uNight);
            whiteCol = mix(whiteCol, uSunColor * 0.45 + vec3(0.58), (1.0 - uNight) * 0.28);

            vec3 col = mix(aquaCol, whiteCol, foam);
            float alpha = (0.58 + 0.38 * foam) * sideMask * topMask * botMask;

            float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
            col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));

            gl_FragColor = vec4(col, alpha);
          }
        `,
      });

      this._waterfallMaterials.push(wfMat);
      const wfMesh = new THREE.Mesh(wfGeo, wfMat);
      wfMesh.renderOrder = 3;
      this.scene.add(wfMesh);

      // Splash foam ring at sea base
      const splashX = wf.topX + dirX * endDist;
      const splashZ = wf.topZ + dirZ * endDist;
      const splashGeo = new THREE.CircleGeometry(wf.width * 0.82, 20);
      splashGeo.rotateX(-Math.PI / 2);
      const splashMat = new THREE.MeshBasicMaterial({
        color: 0xe8fbff,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
      });
      const splashRing = new THREE.Mesh(splashGeo, splashMat);
      splashRing.position.set(splashX, WORLD_CONFIG.SEA_LEVEL + 0.35, splashZ);
      splashRing.renderOrder = 3;
      this.scene.add(splashRing);

      // Rising mist puffs around splash base
      const puffs = [];
      for (let m = 0; m < puffsPerWaterfall; m++) {
        puffs.push({
          baseX: splashX + (rng() - 0.5) * wf.width * 1.15,
          baseZ: splashZ + (rng() - 0.5) * wf.width * 0.9,
          baseY: WORLD_CONFIG.SEA_LEVEL + 0.5,
          driftX: dirX * (1.2 + rng() * 1.5) + (rng() - 0.5) * 1.2,
          driftZ: dirZ * (1.2 + rng() * 1.5) + (rng() - 0.5) * 1.2,
          riseHeight: 6.5 + rng() * 7.0,
          speed: 0.28 + rng() * 0.24,
          phase: rng(),
          baseScale: 1.4 + rng() * 1.8,
        });
      }
      perWaterfallMist.push(puffs);
    }

    // Interleave mist puffs round-robin across waterfalls so scaling .count keeps every waterfall misty
    for (let m = 0; m < puffsPerWaterfall; m++) {
      for (let w = 0; w < perWaterfallMist.length; w++) {
        const entry = perWaterfallMist[w][m];
        entry.idx = this._waterfallMistData.length;
        this._waterfallMistData.push(entry);
      }
    }

    this.scene.add(this._waterfallMistMesh);
    this._updateWaterfallMist(0);
  }

  _updateWaterfallMist(elapsedTime) {
    const dummy = this._dummy;
    const activeMist = Math.min(this._waterfallMistMesh.count, this._waterfallMistData.length);
    for (let i = 0; i < activeMist; i++) {
      const m = this._waterfallMistData[i];
      const life = (elapsedTime * m.speed + m.phase) % 1.0;
      const scale = m.baseScale * (0.55 + life * 1.35) * Math.sin(life * Math.PI);
      dummy.position.set(
        m.baseX + m.driftX * life * 2.2,
        m.baseY + life * m.riseHeight,
        m.baseZ + m.driftZ * life * 2.2
      );
      dummy.rotation.set(0, elapsedTime * 0.4 + i, 0);
      dummy.scale.set(scale * 1.2, scale * 0.85, scale * 1.2);
      dummy.updateMatrix();
      this._waterfallMistMesh.setMatrixAt(m.idx, dummy.matrix);
    }
    this._waterfallMistMesh.instanceMatrix.needsUpdate = true;
  }

  // =========================================================================
  // 8a. Instanced Stylized Himalayan Pine Forests
  // =========================================================================
  _buildForests() {
    const rng = createRng(1337);

    // Trunk geometry (1 draw call for all trunks)
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.44, 3.2, 6);
    trunkGeo.translate(0, 1.6, 0);

    // 3-tier stylized Himalayan cedar foliage merged into 1 BufferGeometry (1 draw call for all trees!)
    const cone1 = new THREE.ConeGeometry(2.35, 3.3, 7);
    cone1.translate(0, 3.6, 0);
    const cone2 = new THREE.ConeGeometry(1.85, 3.0, 7);
    cone2.translate(0, 5.5, 0);
    const cone3 = new THREE.ConeGeometry(1.25, 2.7, 7);
    cone3.translate(0, 7.2, 0);
    const foliageGeo = mergeSimpleGeometries([cone1, cone2, cone3]);
    cone1.dispose();
    cone2.dispose();
    cone3.dispose();

    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x5c3c26,
      roughness: 0.94,
    });
    const foliageMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0.02,
      flatShading: true,
    });

    const avoidSpots = [
      { x: LANDMARKS.bay_camp.x, z: LANDMARKS.bay_camp.z, r: 14 },
      { x: LANDMARKS.beach_raft.x, z: LANDMARKS.beach_raft.z, r: 15 },
      { x: LANDMARKS.waterfall_cliff.x, z: LANDMARKS.waterfall_cliff.z, r: 12 },
      { x: LANDMARKS.alpine_ruins.x, z: LANDMARKS.alpine_ruins.z, r: 18 },
      ...WATERFALLS.map((w) => ({
        x: (w.topX + w.bottomX) * 0.5,
        z: (w.topZ + w.bottomZ) * 0.5,
        r: 18,
      })),
    ];

    const placements = [];
    const targetCount = 620;
    const maxAttempts = 6500;

    for (let attempt = 0; attempt < maxAttempts && placements.length < targetCount; attempt++) {
      const x = (rng() - 0.5) * 680;
      const z = (rng() - 0.5) * 640 + 25;
      const y = getTerrainHeight(x, z);
      if (y < 12.0 || y > 82.0) continue;

      const normal = getTerrainNormal(x, z);
      if (normal.y < 0.74) continue;

      // Natural forest clustering with fbm
      if (fbm(x * 0.022 + 5.1, z * 0.022 - 3.3, 2) < 0.36) continue;

      let blocked = false;
      for (const spot of avoidSpots) {
        if ((x - spot.x) ** 2 + (z - spot.z) ** 2 < spot.r * spot.r) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      const scale = (0.78 + rng() * 0.72) * (1.0 - smoothstep(64, 84, y) * 0.25);
      placements.push({ x, y: y - 0.35, z, scale, rotY: rng() * Math.PI * 2, alt: y });
    }

    const count = placements.length;
    this._maxPineCount = count;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const foliages = new THREE.InstancedMesh(foliageGeo, foliageMat, count);
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    foliages.castShadow = true;
    foliages.receiveShadow = true;

    const dummy = this._dummy;
    const cPineWarm = new THREE.Color(0x3a7d44);
    const cPineDeep = new THREE.Color(0x23593a);
    const cPineFrost = new THREE.Color(0x4b7f7c);
    const col = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const p = placements[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set((rng() - 0.5) * 0.06, p.rotY, (rng() - 0.5) * 0.06);
      dummy.scale.set(p.scale, p.scale * (0.92 + rng() * 0.24), p.scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      foliages.setMatrixAt(i, dummy.matrix);

      col.copy(cPineDeep).lerp(cPineWarm, rng());
      // Frosty blue-spruce tint near snowline
      const frostT = smoothstep(62, 82, p.alt);
      col.lerp(cPineFrost, frostT * 0.65);
      foliages.setColorAt(i, col);
    }

    trunks.instanceMatrix.needsUpdate = true;
    foliages.instanceMatrix.needsUpdate = true;
    if (foliages.instanceColor) foliages.instanceColor.needsUpdate = true;

    this._pineTrunkMesh = trunks;
    this._pineFoliageMesh = foliages;
    this.scene.add(trunks);
    this.scene.add(foliages);
  }

  // =========================================================================
  // 8b. Instanced Wind-Swaying BotW Grass Tufts
  // =========================================================================
  _buildGrass() {
    const rng = createRng(5521);

    // Stylized 3-blade crossed grass tuft merged into one BufferGeometry
    const blades = [];
    for (let b = 0; b < 3; b++) {
      const g = new THREE.ConeGeometry(0.055, 0.48, 3, 2);
      g.translate(0, 0.24, 0);
      g.rotateZ((b - 1) * 0.24);
      g.rotateY((b * Math.PI) / 3);
      blades.push(g);
    }
    const tuftGeo = mergeSimpleGeometries(blades);
    blades.forEach((g) => g.dispose());

    const grassUniforms = {
      uTime: { value: 0.0 },
    };
    this._grassUniforms.push(grassUniforms);

    const grassMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    grassMat.customProgramCacheKey = () => 'botw-wind-grass-v1';
    grassMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = grassUniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform float uTime;
          `
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          {
            float tipFactor = clamp(position.y / 0.95, 0.0, 1.0);
            vec3 instOrigin = vec3(0.0);
            #ifdef USE_INSTANCING
              instOrigin = instanceMatrix[3].xyz;
            #endif
            float gust = sin(uTime * 2.4 + instOrigin.x * 0.14 + instOrigin.z * 0.11) * 0.24
                       + sin(uTime * 4.1 + instOrigin.x * 0.32) * 0.08;
            transformed.x += gust * tipFactor * tipFactor;
            transformed.z += gust * 0.55 * tipFactor * tipFactor;
          }
          `
        );
    };

    const placements = [];
    const targetCount = 1550;

    // Seed dense picturesque tufts near bay_camp & coastal meadows first, then broader foothills
    const clusters = [
      { cx: LANDMARKS.bay_camp.x, cz: LANDMARKS.bay_camp.z, spread: 75, count: 600 },
      { cx: LANDMARKS.waterfall_cliff.x, cz: LANDMARKS.waterfall_cliff.z, spread: 68, count: 350 },
      { cx: -75, cz: 135, spread: 90, count: 350 },
      { cx: 10, cz: 20, spread: 140, count: 250 },
    ];

    for (const cl of clusters) {
      let placed = 0;
      let tries = 0;
      while (placed < cl.count && tries < cl.count * 8 && placements.length < targetCount) {
        tries++;
        const x = cl.cx + (rng() - 0.5) * 2 * cl.spread;
        const z = cl.cz + (rng() - 0.5) * 2 * cl.spread;
        const y = getTerrainHeight(x, z);
        if (y < 4.8 || y > 68.0) continue;
        const normal = getTerrainNormal(x, z);
        if (normal.y < 0.80) continue;

        placements.push({
          x,
          y: y - 0.08,
          z,
          scale: 0.7 + rng() * 0.95,
          rotY: rng() * Math.PI * 2,
          tint: rng(),
        });
        placed++;
      }
    }

    // Deterministic Fisher-Yates shuffle so scaling .count thins grass uniformly across all meadows
    for (let i = placements.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmpPlacement = placements[i];
      placements[i] = placements[j];
      placements[j] = tmpPlacement;
    }

    this._maxGrassCount = placements.length;
    const grassMesh = new THREE.InstancedMesh(tuftGeo, grassMat, placements.length);
    grassMesh.receiveShadow = true;

    const dummy = this._dummy;
    const cA = new THREE.Color(0x69b848);
    const cB = new THREE.Color(0x8fd154);
    const cC = new THREE.Color(0x4c963d);
    const tmp = new THREE.Color();

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.rotY, 0);
      dummy.scale.set(p.scale * 1.15, p.scale, p.scale * 1.15);
      dummy.updateMatrix();
      grassMesh.setMatrixAt(i, dummy.matrix);

      tmp.copy(cA).lerp(p.tint > 0.5 ? cB : cC, Math.abs(p.tint - 0.5) * 1.8);
      grassMesh.setColorAt(i, tmp);
    }

    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
    this._grassMesh = grassMesh;
    this.scene.add(grassMesh);
  }

  // =========================================================================
  // 8c. Ancient Stone Ruins, Summit Shrines & Fluttering Tibetan Prayer Flags
  // =========================================================================
  _buildLandmarksAndFlags() {
    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0x9fa5a0,
      roughness: 0.92,
      metalness: 0.04,
    });
    const darkStoneMat = new THREE.MeshStandardMaterial({
      color: 0x6f767c,
      roughness: 0.94,
    });
    const woodMat = new THREE.MeshStandardMaterial({
      color: 0x734e31,
      roughness: 0.9,
    });
    const ropeMat = new THREE.MeshBasicMaterial({ color: 0xdfd6c3 });

    // Shared animated prayer-flag shader factory (5 sacred Tibetan colors: blue, white, red, green, yellow)
    const flagColors = [0x2978d4, 0xf4f5f0, 0xd6362c, 0x2c9448, 0xf2bf29];
    const flagUniforms = { uTime: { value: 0.0 } };
    this._prayerFlagUniforms.push(flagUniforms);

    const flagMats = flagColors.map((hex) => {
      const mat = new THREE.MeshStandardMaterial({
        color: hex,
        roughness: 0.78,
        side: THREE.DoubleSide,
      });
      mat.customProgramCacheKey = () => 'prayer-flag-flutter-v1';
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = flagUniforms.uTime;
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            /* glsl */ `
            #include <common>
            uniform float uTime;
            `
          )
          .replace(
            '#include <begin_vertex>',
            /* glsl */ `
            #include <begin_vertex>
            {
              // Top edge (position.y == 0) pinned to cord; bottom (-0.68) flutters in alpine wind
              float flutter = clamp(-position.y / 0.68, 0.0, 1.0);
              vec3 flagWorld = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              float phase = uTime * 7.2 + flagWorld.x * 0.65 + flagWorld.z * 0.55 + position.x * 4.0;
              transformed.z += sin(phase) * 0.24 * flutter;
              transformed.x += cos(phase * 0.85) * 0.08 * flutter;
            }
            `
          );
      };
      return mat;
    });

    const addPrayerFlagLine = (parent, pA, pB, count = 10) => {
      // Catenary rope
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const p = new THREE.Vector3().lerpVectors(pA, pB, t);
        p.y -= Math.sin(t * Math.PI) * (pA.distanceTo(pB) * 0.11);
        pts.push(p);
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const ropeGeo = new THREE.TubeGeometry(curve, 14, 0.035, 4, false);
      parent.add(new THREE.Mesh(ropeGeo, ropeMat));

      const flagGeo = new THREE.PlaneGeometry(0.55, 0.68, 2, 3);
      flagGeo.translate(0, -0.34, 0);
      const dir = new THREE.Vector3().subVectors(pB, pA);
      const yaw = Math.atan2(dir.x, dir.z) + Math.PI * 0.5;

      for (let i = 1; i <= count; i++) {
        const t = i / (count + 1);
        const pos = curve.getPoint(t);
        const flag = new THREE.Mesh(flagGeo, flagMats[(i - 1) % flagMats.length]);
        flag.position.copy(pos);
        flag.rotation.y = yaw;
        parent.add(flag);
      }
    };

    // --- 1. Alpine Ruins at LANDMARKS.alpine_ruins (10, 6) ---
    {
      const rx = LANDMARKS.alpine_ruins.x;
      const rz = LANDMARKS.alpine_ruins.z;
      const ry = getTerrainHeight(rx, rz);
      const ruins = new THREE.Group();
      ruins.position.set(rx, ry, rz);

      // Stepped stone foundation platform
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(8.8, 9.6, 1.4, 12), darkStoneMat);
      plinth.position.y = -0.35;
      plinth.receiveShadow = true;
      ruins.add(plinth);

      // Weathered stone archway facing the main Himalayan peak
      const archL = new THREE.Mesh(new THREE.BoxGeometry(1.4, 7.6, 1.4), stoneMat);
      archL.position.set(-4.2, 3.6, -5.5);
      archL.castShadow = true;
      const archR = archL.clone();
      archR.position.x = 4.2;
      const archTop = new THREE.Mesh(new THREE.BoxGeometry(10.6, 1.3, 1.9), darkStoneMat);
      archTop.position.set(0, 7.6, -5.5);
      archTop.castShadow = true;
      ruins.add(archL, archR, archTop);

      // Broken weathered perimeter pillars + prayer flags strung between them
      const pillarAngles = [-2.2, -1.0, 0.7, 1.8, 2.7];
      const pillarTops = [];
      for (let i = 0; i < pillarAngles.length; i++) {
        const a = pillarAngles[i];
        const px = Math.cos(a) * 7.2;
        const pz = Math.sin(a) * 7.2;
        const h = i % 2 === 0 ? 5.2 : 3.4;
        const pMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.68, h, 8), stoneMat);
        pMesh.position.set(px, h * 0.5, pz);
        pMesh.castShadow = true;
        pMesh.receiveShadow = true;
        ruins.add(pMesh);
        pillarTops.push(new THREE.Vector3(px, h - 0.25, pz));
      }

      // Glowing turquoise Zonai rune brazier stone at altar edge
      const altar = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.2, 1.8, 6), darkStoneMat);
      altar.position.set(0, 0.9, -4.0);
      altar.castShadow = true;
      ruins.add(altar);

      const runeCore = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.52, 0),
        this._zonaiGlowMaterials[0]
      );
      runeCore.position.set(0, 2.35, -4.0);
      ruins.add(runeCore);

      // Prayer flags strung from archway to flanking pillars
      addPrayerFlagLine(ruins, new THREE.Vector3(-4.2, 6.8, -5.5), pillarTops[0], 9);
      addPrayerFlagLine(ruins, new THREE.Vector3(4.2, 6.8, -5.5), pillarTops[4], 9);
      addPrayerFlagLine(ruins, pillarTops[1], pillarTops[2], 10);

      this.scene.add(ruins);
    }

    // --- 2. Summit Cairn Shrines & Tibetan Prayer Flag Poles on Main, West & East Peaks ---
    for (const peak of HIGH_PEAKS) {
      const py = getTerrainHeight(peak.x, peak.z);
      const shrine = new THREE.Group();
      shrine.position.set(peak.x, py, peak.z);
      const s = peak.scale;

      // Stacked Himalayan stone mani cairn / stupa base
      const base1 = new THREE.Mesh(
        new THREE.CylinderGeometry(1.8 * s, 2.5 * s, 1.8 * s, 8),
        darkStoneMat
      );
      base1.position.y = 0.6 * s;
      base1.castShadow = true;
      base1.receiveShadow = true;
      shrine.add(base1);

      const base2 = new THREE.Mesh(
        new THREE.CylinderGeometry(1.1 * s, 1.6 * s, 1.4 * s, 8),
        stoneMat
      );
      base2.position.y = 2.0 * s;
      base2.castShadow = true;
      shrine.add(base2);

      // Tall central wooden prayer-flag pole
      const poleH = 8.5 * s;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * s, 0.17 * s, poleH, 6), woodMat);
      pole.position.y = poleH * 0.5 + 1.2 * s;
      pole.castShadow = true;
      shrine.add(pole);

      // Golden finial tip on summit pole
      const finial = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.32 * s, 0),
        new THREE.MeshStandardMaterial({
          color: 0xffd166,
          emissive: 0x553300,
          roughness: 0.35,
          metalness: 0.7,
        })
      );
      finial.position.y = poleH + 1.35 * s;
      shrine.add(finial);

      // 4 radiating fluttering Tibetan prayer-flag lines staked into the snow crest
      const poleTop = new THREE.Vector3(0, poleH + 0.8 * s, 0);
      const anchorDist = 7.8 * s;
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2 + 0.45;
        const ax = Math.cos(ang) * anchorDist;
        const az = Math.sin(ang) * anchorDist;
        const localGroundDelta = getTerrainHeight(peak.x + ax, peak.z + az) - py;
        const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 2.2, 5), woodMat);
        stake.position.set(ax, localGroundDelta + 0.9, az);
        shrine.add(stake);

        addPrayerFlagLine(
          shrine,
          poleTop,
          new THREE.Vector3(ax, localGroundDelta + 1.8, az),
          peak.id === 'main_summit' ? 12 : 9
        );
      }

      this.scene.add(shrine);
    }

    // --- 3. Waterfall Cliff Overlook Flag Pole & Beach Raft Wooden Mooring Posts ---
    {
      const wx = LANDMARKS.waterfall_cliff.x + 5.5;
      const wz = LANDMARKS.waterfall_cliff.z - 4.0;
      const wy = getTerrainHeight(wx, wz);
      const cliffGroup = new THREE.Group();
      cliffGroup.position.set(wx, wy, wz);
      const p1 = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 6.2, 6), woodMat);
      p1.position.set(0, 3.0, 0);
      const p2 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 4.2, 6), woodMat);
      p2.position.set(5.5, getTerrainHeight(wx + 5.5, wz + 2.5) - wy + 2.0, 2.5);
      cliffGroup.add(p1, p2);
      addPrayerFlagLine(
        cliffGroup,
        new THREE.Vector3(0, 5.8, 0),
        new THREE.Vector3(5.5, p2.position.y + 1.8, 2.5),
        9
      );
      this.scene.add(cliffGroup);
    }

    // Small weathered wooden pier posts at beach_raft to frame the raft-building shore
    {
      const bx = LANDMARKS.beach_raft.x + 4.5;
      const bz = LANDMARKS.beach_raft.z - 7.0;
      const dockGroup = new THREE.Group();
      const postOffsets = [
        [-2.2, 0],
        [2.2, 0],
        [-2.2, -4.5],
        [2.2, -4.5],
      ];
      for (const [ox, oz] of postOffsets) {
        const px = bx + ox;
        const pz = bz + oz;
        const py = getTerrainHeight(px, pz);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 3.6, 6), woodMat);
        post.position.set(px, Math.max(py, WORLD_CONFIG.SEA_LEVEL - 1.2) + 1.2, pz);
        post.castShadow = true;
        dockGroup.add(post);
      }
      // Wooden deck planks across the mooring posts
      const deckY = Math.max(getTerrainHeight(bx, bz), WORLD_CONFIG.SEA_LEVEL + 0.65) + 0.85;
      for (let i = 0; i < 6; i++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.16, 0.72), woodMat);
        plank.position.set(bx, deckY, bz - i * 0.88);
        plank.castShadow = true;
        plank.receiveShadow = true;
        dockGroup.add(plank);
      }
      this.scene.add(dockGroup);
    }
  }

  // =========================================================================
  // 8d. Cozy Flickering Campfires at bay_camp & beach_raft
  // =========================================================================
  _buildCampfires() {
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6f747a, roughness: 0.95 });
    const logMat = new THREE.MeshStandardMaterial({ color: 0x4d311f, roughness: 0.92 });
    const emberMat = new THREE.MeshBasicMaterial({ color: 0xff5a1f });
    const outerFlameMat = new THREE.MeshBasicMaterial({
      color: 0xff7b24,
      transparent: true,
      opacity: 0.86,
    });
    const innerFlameMat = new THREE.MeshBasicMaterial({
      color: 0xffe875,
      transparent: true,
      opacity: 0.94,
    });

    const fireSites = [
      { x: LANDMARKS.bay_camp.x + 4.2, z: LANDMARKS.bay_camp.z - 3.6 },
      { x: LANDMARKS.beach_raft.x - 4.4, z: LANDMARKS.beach_raft.z + 3.8 },
    ];

    for (let s = 0; s < fireSites.length; s++) {
      const site = fireSites[s];
      const y = getTerrainHeight(site.x, site.z);
      const group = new THREE.Group();
      group.position.set(site.x, y, site.z);

      // Ring of river stones
      for (let i = 0; i < 9; i++) {
        const ang = (i / 9) * Math.PI * 2;
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.28, 0), stoneMat);
        rock.position.set(Math.cos(ang) * 0.92, 0.14, Math.sin(ang) * 0.92);
        rock.scale.set(1.2, 0.72, 1.0);
        rock.castShadow = true;
        group.add(rock);
      }

      // Crossed firewood logs
      for (let i = 0; i < 4; i++) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.35, 6), logMat);
        const ang = (i / 4) * Math.PI + 0.35;
        log.position.set(Math.cos(ang) * 0.12, 0.28, Math.sin(ang) * 0.12);
        log.rotation.z = Math.PI * 0.36;
        log.rotation.y = ang;
        group.add(log);
      }

      // Glowing ember bed
      const embers = new THREE.Mesh(new THREE.CircleGeometry(0.62, 10), emberMat);
      embers.rotation.x = -Math.PI / 2;
      embers.position.y = 0.08;
      group.add(embers);

      // Layered stylized flickering flame cones
      const outerFlame = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.25, 6), outerFlameMat);
      outerFlame.position.y = 0.72;
      group.add(outerFlame);

      const innerFlame = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.85, 5), innerFlameMat);
      innerFlame.position.y = 0.56;
      group.add(innerFlame);

      // Cozy sitting log beside the camp fire
      const bench = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 2.6, 7), logMat);
      bench.rotation.z = Math.PI * 0.5;
      bench.rotation.y = 0.5;
      bench.position.set(-1.9, 0.24, 1.4);
      bench.castShadow = true;
      bench.receiveShadow = true;
      group.add(bench);

      // Rising ember sparks
      const sparks = [];
      for (let k = 0; k < 5; k++) {
        const sp = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.06, 0),
          new THREE.MeshBasicMaterial({ color: 0xffb347 })
        );
        group.add(sp);
        sparks.push({ mesh: sp, phase: k * 0.2 + s * 0.37, angle: k * 1.4 });
      }

      // Warm campfire point light
      const light = new THREE.PointLight(0xff8c3a, 3.2, 24, 1.8);
      light.position.set(0, 1.45, 0);
      group.add(light);

      this.scene.add(group);
      this._campfires.push({
        light,
        outerFlame,
        innerFlame,
        sparks,
        phase: s * 2.1,
      });
    }
  }

  // =========================================================================
  // 8e. Visible Rising Wind-Ribbon Spirals at UPDRAFTS
  // =========================================================================
  _buildUpdrafts() {
    const updraftMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uNight: { value: 0.0 },
        uFogColor: { value: new THREE.Color(0x9ec4d9) },
        uFogDensity: { value: 0.00085 },
      },
      precision: 'highp',
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vFogDepth;
        void main() {
          vUv = uv;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vFogDepth = -mvPos.z;
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uNight;
        uniform vec3 uFogColor;
        uniform float uFogDensity;

        varying vec2 vUv;
        varying float vFogDepth;

        void main() {
          // Rising airy wind streaks along the helical ribbon
          float flow = fract(vUv.y * 2.6 - uTime * 0.72);
          float streak = smoothstep(0.0, 0.22, flow) * (1.0 - smoothstep(0.45, 0.82, flow));
          float across = sin(vUv.x * 3.14159265);
          float verticalFade = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.84, 1.0, vUv.y));

          vec3 col = mix(vec3(0.76, 0.98, 1.0), vec3(0.46, 0.85, 1.0), uNight);
          float alpha = streak * across * verticalFade * (0.16 + 0.08 * uNight);

          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
          alpha *= (1.0 - clamp(fogFactor, 0.0, 0.92));

          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    this._updraftMaterials.push(updraftMat);

    for (let uIdx = 0; uIdx < UPDRAFTS.length; uIdx++) {
      const u = UPDRAFTS[uIdx];
      const height = u.topY - u.baseY;
      const ribbonCount = 2;

      for (let r = 0; r < ribbonCount; r++) {
        const turns = 2.4 + (r % 2) * 0.4;
        const baseRad = u.radius * (0.45 + r * 0.22);
        const phaseOffset = (r / ribbonCount) * Math.PI * 2 + uIdx * 0.9;
        const segsY = 44;
        const ribbonWidth = 0.36;

        const positions = [];
        const uvs = [];
        const indices = [];

        for (let i = 0; i <= segsY; i++) {
          const t = i / segsY;
          const y = u.baseY + t * height;
          const angle = phaseOffset + t * turns * Math.PI * 2;
          const rad = baseRad * (0.85 + Math.sin(t * Math.PI) * 0.35);
          const cx = u.x + Math.cos(angle) * rad;
          const cz = u.z + Math.sin(angle) * rad;

          // Ribbon oriented vertically so it catches the eye from any angle while gliding
          positions.push(cx, y - ribbonWidth * 0.5, cz);
          uvs.push(0, t);
          positions.push(cx, y + ribbonWidth * 0.5, cz);
          uvs.push(1, t);
        }

        for (let i = 0; i < segsY; i++) {
          const a = i * 2;
          const b = a + 1;
          const c = a + 2;
          const d = a + 3;
          indices.push(a, c, b, b, c, d);
        }

        const rGeo = new THREE.BufferGeometry();
        rGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        rGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        rGeo.setIndex(indices);

        const mesh = new THREE.Mesh(rGeo, updraftMat);
        mesh.renderOrder = 4;
        this.scene.add(mesh);
      }
    }
  }

  // =========================================================================
  // 9. Public API
  // =========================================================================

  /**
   * Dynamically scales rendering quality ('low' | 'medium' | 'high') with zero geometry rebuild.
   * Adjusts InstancedMesh draw counts, directional shadow map size & bounds, and shadow casting.
   */
  setQualityPreset(level) {
    const normalized = QUALITY_PRESETS[level] ? level : 'medium';
    const cfg = QUALITY_PRESETS[normalized];
    this.qualityLevel = normalized;

    // 1. Scale InstancedMesh counts instantaneously (zero geometry rebuild, zero jank)
    if (this._grassMesh && this._maxGrassCount > 0) {
      this._grassMesh.count = Math.max(1, Math.round(this._maxGrassCount * cfg.grassRatio));
    }

    if (this._pineTrunkMesh && this._pineFoliageMesh && this._maxPineCount > 0) {
      const pineCount = Math.max(1, Math.round(this._maxPineCount * cfg.pineRatio));
      this._pineTrunkMesh.count = pineCount;
      this._pineFoliageMesh.count = pineCount;
    }

    if (this._cloudBeltMesh && this._maxCloudBeltCount > 0) {
      this._cloudBeltMesh.count = Math.max(1, Math.round(this._maxCloudBeltCount * cfg.cloudBeltRatio));
    }

    if (this._highCloudMesh && this._maxHighCloudCount > 0) {
      this._highCloudMesh.count = Math.max(1, Math.round(this._maxHighCloudCount * cfg.highCloudRatio));
    }

    // Refresh active cloud matrices immediately so scaling up never shows un-updated instances
    if (this._cloudBeltMesh && this._highCloudMesh) {
      this._updateCloudMatrices(this._time);
    }

    if (this._waterfallMistMesh && this._maxWaterfallMistCount > 0) {
      this._waterfallMistMesh.count = Math.max(
        WATERFALLS.length,
        Math.round(this._maxWaterfallMistCount * cfg.waterfallMistRatio)
      );
      this._updateWaterfallMist(this._time);
    }

    // 2. Update directional sun shadows & dispose old shadow map cleanly when resizing or disabling
    if (this.sunLight) {
      const prevCastShadow = this.sunLight.castShadow;
      this.sunLight.castShadow = cfg.castShadow;

      const cam = this.sunLight.shadow.camera;
      if (
        cam.left !== -cfg.shadowHalf ||
        cam.right !== cfg.shadowHalf ||
        cam.top !== cfg.shadowHalf ||
        cam.bottom !== -cfg.shadowHalf
      ) {
        cam.left = -cfg.shadowHalf;
        cam.right = cfg.shadowHalf;
        cam.top = cfg.shadowHalf;
        cam.bottom = -cfg.shadowHalf;
        this._shadowFrustumSize = cfg.shadowHalf * 2;
      }

      const mapSizeChanged =
        this.sunLight.shadow.mapSize.width !== cfg.shadowMapSize ||
        this.sunLight.shadow.mapSize.height !== cfg.shadowMapSize;

      if (mapSizeChanged) {
        this.sunLight.shadow.map?.dispose();
        this.sunLight.shadow.map = null;
        this.sunLight.shadow.mapPass?.dispose?.();
        this.sunLight.shadow.mapPass = null;
        this.sunLight.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
      } else if (!cfg.castShadow && this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
        this.sunLight.shadow.mapPass?.dispose?.();
        this.sunLight.shadow.mapPass = null;
      }

      cam.updateProjectionMatrix();

      if (this.renderer && this.renderer.shadowMap) {
        const prevRendererShadow = this.renderer.shadowMap.enabled;
        this.renderer.shadowMap.enabled = cfg.castShadow;
        this.renderer.shadowMap.needsUpdate = true;

        // Recompile lit/VRM materials cleanly whenever shadow mapping toggles on/off
        if (prevRendererShadow !== cfg.castShadow || prevCastShadow !== cfg.castShadow) {
          this.scene.traverse((obj) => {
            if (!obj.isMesh || !obj.material) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const mat of mats) {
              if (mat && (mat.isMeshStandardMaterial || mat.isMToonMaterial || mat.lights)) {
                mat.needsUpdate = true;
              }
            }
          });
        }
      }
    }

    return this.qualityLevel;
  }

  /**
   * Switch time-of-day atmosphere preset ('golden' | 'morning' | 'noon' | 'night').
   */
  setTimePreset(presetId) {
    const preset = TIME_PRESETS[presetId] || TIME_PRESETS.golden;
    this.currentPresetId = preset.id;

    // Compass azimuth: 0° = North (-Z), 90° = East (+X), 180° = South (+Z), 270° = West (-X)
    const el = THREE.MathUtils.degToRad(preset.sunElevation);
    const az = THREE.MathUtils.degToRad(preset.sunAzimuth);
    this.sunDirection
      .set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az))
      .normalize();

    // Update Three.js lights & exponential fog
    this.sunLight.color.setHex(preset.sunColor);
    this.sunLight.intensity = preset.sunIntensity;
    this.sunLight.position
      .copy(this._shadowTarget)
      .addScaledVector(this.sunDirection, 420);
    this.sunLight.target.position.copy(this._shadowTarget);
    this.sunLight.target.updateMatrixWorld();

    this.hemiLight.color.setHex(preset.hemiSky);
    this.hemiLight.groundColor.setHex(preset.hemiGround);
    this.hemiLight.intensity = preset.hemiIntensity;

    this.fog.color.setHex(preset.fogColor);
    this.fog.density = preset.fogDensity;

    if (this.renderer && 'toneMappingExposure' in this.renderer) {
      this.renderer.toneMappingExposure = preset.ambientNight > 0.5 ? 1.05 : 1.12;
    }

    // Sync all custom shader uniforms
    const sunColor = new THREE.Color(preset.sunColor);
    const skyTop = new THREE.Color(preset.skyTop);
    const skyHorizon = new THREE.Color(preset.skyHorizon);
    const fogColor = new THREE.Color(preset.fogColor);
    const night = preset.ambientNight;

    if (this._skyUniforms) {
      this._skyUniforms.uSunDir.value.copy(this.sunDirection);
      this._skyUniforms.uSkyTop.value.copy(skyTop);
      this._skyUniforms.uSkyHorizon.value.copy(skyHorizon);
      this._skyUniforms.uSunColor.value.copy(sunColor);
      this._skyUniforms.uNight.value = night;
    }

    if (this._terrainUniforms) {
      this._terrainUniforms.uSunDir.value.copy(this.sunDirection);
      this._terrainUniforms.uSunColor.value.copy(sunColor);
      this._terrainUniforms.uNight.value = night;
    }

    if (this._oceanUniforms) {
      this._oceanUniforms.uSunDir.value.copy(this.sunDirection);
      this._oceanUniforms.uSunColor.value.copy(sunColor);
      this._oceanUniforms.uSkyTop.value.copy(skyTop);
      this._oceanUniforms.uSkyHorizon.value.copy(skyHorizon);
      this._oceanUniforms.uFogColor.value.copy(fogColor);
      this._oceanUniforms.uFogDensity.value = preset.fogDensity;
      this._oceanUniforms.uNight.value = night;
    }

    if (this._cloudUniforms) {
      this._cloudUniforms.uSunDir.value.copy(this.sunDirection);
      this._cloudUniforms.uSunColor.value.copy(sunColor);
      this._cloudUniforms.uSkyTop.value.copy(skyTop);
      this._cloudUniforms.uSkyHorizon.value.copy(skyHorizon);
      this._cloudUniforms.uFogColor.value.copy(fogColor);
      this._cloudUniforms.uFogDensity.value = preset.fogDensity;
      this._cloudUniforms.uNight.value = night;
    }

    for (const mat of this._waterfallMaterials) {
      mat.uniforms.uSunColor.value.copy(sunColor);
      mat.uniforms.uFogColor.value.copy(fogColor);
      mat.uniforms.uFogDensity.value = preset.fogDensity;
      mat.uniforms.uNight.value = night;
    }

    if (this._mistMaterial) {
      this._mistMaterial.color.setHex(night > 0.5 ? 0x6b87ad : 0xeaf8ff);
      this._mistMaterial.opacity = night > 0.5 ? 0.26 : 0.42;
    }

    for (const mat of this._updraftMaterials) {
      mat.uniforms.uFogColor.value.copy(fogColor);
      mat.uniforms.uFogDensity.value = preset.fogDensity;
      mat.uniforms.uNight.value = night;
    }

    this._nightFactor = night;
  }

  /**
   * Returns animated ocean wave height in meters around SEA_LEVEL (0), ~±0.33m swell.
   * Matches the ocean vertex shader 1:1 for realistic floating rafts & swimming.
   */
  getWaveHeight(x, z, time = this._time) {
    const w1 = Math.sin(x * 0.028 + z * 0.019 + time * 1.15) * 0.16;
    const w2 = Math.sin(x * -0.021 + z * 0.034 + time * 0.88) * 0.11;
    const w3 = Math.cos((x + z) * 0.045 - time * 1.45) * 0.06;
    return WORLD_CONFIG.SEA_LEVEL + w1 + w2 + w3;
  }

  /**
   * Per-frame animation update for shaders, clouds, waterfalls, campfires, flags, updrafts & shadow camera.
   */
  update(dt, elapsedTime, cameraPos) {
    this._time = elapsedTime;

    // 1. Update shader time uniforms
    if (this._skyUniforms) this._skyUniforms.uTime.value = elapsedTime;
    if (this._terrainUniforms) this._terrainUniforms.uTime.value = elapsedTime;
    if (this._oceanUniforms) this._oceanUniforms.uTime.value = elapsedTime;

    for (const mat of this._waterfallMaterials) {
      mat.uniforms.uTime.value = elapsedTime;
    }
    for (const mat of this._updraftMaterials) {
      mat.uniforms.uTime.value = elapsedTime;
    }
    for (const u of this._grassUniforms) {
      u.uTime.value = elapsedTime;
    }
    for (const u of this._prayerFlagUniforms) {
      u.uTime.value = elapsedTime;
    }

    // 2. Cloud sea swirl & high sky drift
    this._updateCloudMatrices(elapsedTime);

    // 3. Waterfall splash mist puffs
    this._updateWaterfallMist(elapsedTime);

    // 4. Campfire flame flicker, rising sparks & warm point light
    const nightBoost = this._nightFactor ? 1.55 : 1.0;
    for (const cf of this._campfires) {
      const f1 = Math.sin(elapsedTime * 11.5 + cf.phase);
      const f2 = Math.cos(elapsedTime * 17.3 + cf.phase * 1.7);
      const flicker = 0.82 + 0.18 * f1 + 0.1 * f2;

      cf.light.intensity = 3.2 * nightBoost * flicker;
      cf.light.position.x = f2 * 0.08;
      cf.light.position.z = f1 * 0.08;

      cf.outerFlame.scale.set(0.92 + 0.12 * f2, 0.88 + 0.22 * f1, 0.92 - 0.1 * f2);
      cf.outerFlame.rotation.y = elapsedTime * 2.5 + cf.phase;
      cf.innerFlame.scale.set(0.95 - 0.08 * f1, 0.9 + 0.25 * f2, 0.95 + 0.08 * f1);

      for (const sp of cf.sparks) {
        const life = (elapsedTime * 0.65 + sp.phase) % 1.0;
        const r = 0.15 + life * 0.48;
        sp.mesh.position.set(
          Math.cos(sp.angle + elapsedTime * 2.0) * r,
          0.45 + life * 2.8,
          Math.sin(sp.angle + elapsedTime * 2.0) * r
        );
        const sc = Math.max(0.01, (1.0 - life) * 1.15);
        sp.mesh.scale.setScalar(sc);
      }
    }

    // 5. Pulse ancient Zonai monolith glow
    const zonaiPulse = 1.25 + 0.55 * Math.sin(elapsedTime * 2.2) + (this._nightFactor || 0) * 0.7;
    for (const mat of this._zonaiGlowMaterials) {
      mat.emissiveIntensity = zonaiPulse;
    }

    // 6. Keep Sky Dome centered on camera & reposition directional sun shadow frustum smoothly
    if (cameraPos) {
      if (this.skyDome) {
        this.skyDome.position.copy(cameraPos);
      }

      if (this.sunLight && this.sunLight.castShadow) {
        // Snap shadow camera target to coarse world texel grid to prevent shadow swimming
        const texelStep = this._shadowFrustumSize / 128;
        const targetX = Math.round(cameraPos.x / texelStep) * texelStep;
        const targetY = Math.round(clamp(cameraPos.y, 0, 220) / texelStep) * texelStep;
        const targetZ = Math.round(cameraPos.z / texelStep) * texelStep;

        const lerpAlpha = Math.min(1, dt > 0 ? dt * 6.0 : 1.0);
        this._shadowTarget.x += (targetX - this._shadowTarget.x) * lerpAlpha;
        this._shadowTarget.y += (targetY - this._shadowTarget.y) * lerpAlpha;
        this._shadowTarget.z += (targetZ - this._shadowTarget.z) * lerpAlpha;

        this.sunLight.target.position.copy(this._shadowTarget);
        this.sunLight.position
          .copy(this._shadowTarget)
          .addScaledVector(this.sunDirection, 420);
        this.sunLight.target.updateMatrixWorld();
      }
    }
  }
}
