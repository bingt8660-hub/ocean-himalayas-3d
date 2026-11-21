/**
 * Deterministic procedural geography for "海中喜马拉雅" (Ocean Himalayas).
 * A colossal Himalayan arc rising straight out of a vast ocean — no Indian mainland plains.
 * Shared by Terrain Mesh, Rapier3D Heightfield Collider, Props, Character, and UI.
 */

import { WORLD_CONFIG } from '../config/worldConfig.js';

// --- Fast deterministic 2D hash & value/gradient noise ---
function hash2(ix, iz) {
  let n = ix * 374761393 + iz * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function noise2D(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** Standard fractal Brownian motion in [0, 1] */
export function fbm(x, z, octaves = 5, lacunarity = 2.05, gain = 0.5) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2D(x * freq, z * freq);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

/** Ridged multifractal noise in [0, 1] — creates sharp Himalayan arêtes & eroded ridges */
export function ridgedFbm(x, z, octaves = 5) {
  let sum = 0;
  let amp = 0.52;
  let freq = 1.0;
  let weight = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = noise2D(x * freq, z * freq);
    n = 1.0 - Math.abs(n * 2.0 - 1.0);
    n = n * n * weight;
    weight = Math.max(0.15, Math.min(1.0, n * 1.65));
    sum += n * amp;
    norm += amp;
    freq *= 2.12;
    amp *= 0.48;
  }
  return sum / norm;
}

function gaussian(dx, dz, rx, rz = rx) {
  const nx = dx / rx;
  const nz = dz / rz;
  return Math.exp(-(nx * nx + nz * nz));
}

function sharpPeak(x, z, cx, cz, radius, height, sharpness = 1.35) {
  const dx = x - cx;
  const dz = z - cz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const t = Math.max(0, 1 - dist / radius);
  if (t <= 0) return 0;
  // Combine sharp pyramidal ridge falloff with broad base
  const cone = Math.pow(t, sharpness);
  // Radial erosion ribs
  const angle = Math.atan2(dz, dx);
  const ribs = 0.86 + 0.14 * Math.sin(angle * 5.0 + cx * 0.03) * Math.cos(angle * 3.0 - cz * 0.02);
  return height * cone * ribs;
}

/**
 * Core terrain height function in meters (SEA_LEVEL = 0).
 * Coordinates: x in [-512, 512], z in [-512, 512].
 * North is -Z (where the towering Himalayan range rises).
 * South is +Z (where the turquoise coral bay & starting beach sit).
 */
export function getTerrainHeight(x, z) {
  const half = WORLD_CONFIG.WORLD_SIZE * 0.5;
  const rEdge = Math.max(Math.abs(x), Math.abs(z)) / half;
  // Smooth ocean drop-off near map boundaries so terrain blends cleanly below endless ocean
  const edgeFade = 1.0 - smoothstep(0.76, 0.98, rEdge);

  // Base ocean seabed depth (-26m far out)
  let h = -26.0;

  // Domain warp for organic tectonic curvature
  const wx = x + (fbm(x * 0.004 + 11.3, z * 0.004 - 5.7, 3) - 0.5) * 65.0;
  const wz = z + (fbm(x * 0.004 - 8.1, z * 0.004 + 14.2, 3) - 0.5) * 65.0;

  // 1. Curved Himalayan Tectonic Arc rising straight out of the ocean
  // Arc centerline: z_arc(x) ≈ -95 + 0.0014 * x^2
  const arcZ = -105.0 + 0.00135 * wx * wx;
  const distToArc = Math.abs(wz - arcZ);
  const arcSpanMask = Math.exp(-Math.pow(Math.abs(wx) / 290.0, 2.4));
  const arcProfile = Math.exp(-Math.pow(distToArc / 118.0, 1.85)) * arcSpanMask;

  // High-frequency ridged alpine detail
  const ridgeBig = ridgedFbm(wx * 0.0075 + 2.3, wz * 0.0075 - 1.9, 5);
  const ridgeFine = ridgedFbm(x * 0.022 - 4.1, z * 0.022 + 3.7, 4);
  const smoothVar = fbm(x * 0.008 + 7.2, z * 0.008 + 2.1, 4);

  // Lift the Himalayan massif straight from the sea
  h += arcProfile * (92.0 + ridgeBig * 112.0 + ridgeFine * 24.0);

  // 2. Iconic Named Peaks along the arc
  // Main Summit (Sky-Sea Everest) at (12, -108) -> ~278m!
  const mainPeak = sharpPeak(x, z, 12, -108, 198, 245, 1.35);
  h += mainPeak * (0.86 + 0.28 * ridgeBig);

  // West Peak (Nanga Sea Spire) at (-142, -62) -> ~215m
  const westPeak = sharpPeak(x, z, -142, -62, 148, 155, 1.36);
  h += westPeak * (0.85 + 0.26 * ridgeBig);

  // East Peak (Kangchen Cloud Peak) at (162, -68) -> ~212m
  const eastPeak = sharpPeak(x, z, 162, -68, 150, 152, 1.35);
  h += eastPeak * (0.85 + 0.26 * ridgeBig);

  // Secondary shoulder peaks framing the amphitheater
  h += sharpPeak(x, z, -68, -125, 115, 88, 1.3) * (0.86 + 0.24 * ridgeFine);
  h += sharpPeak(x, z, 96, -128, 118, 92, 1.3) * (0.86 + 0.24 * ridgeFine);

  // 3. Coastal Foothills, Stepped Alpine Plateaus & Waterfall Cliffs embracing the South Bay
  // East Coastal Cliff Plateau (twin waterfalls plunge into bay from here!)
  const eastPlateau = gaussian(x - 102, z - 86, 82, 74);
  h += eastPlateau * (64.0 + smoothVar * 22.0);

  // West Coastal Ridge & Starting Headland
  const westHeadland = gaussian(x + 98, z - 122, 86, 86);
  h += westHeadland * (48.0 + smoothVar * 16.0);

  // Scenic Starting Overlook & Beach Peninsula (South-West of bay)
  const startBeachShelf = gaussian(x + 48, z - 196, 78, 56);
  h += startBeachShelf * (31.5 + smoothVar * 5.5);

  // Gently sculpted sandy beach apron right at (-32, 192)
  const beachCove = gaussian(x + 28, z - 186, 36, 32);
  h = h * (1 - beachCove * 0.55) + (2.2 + smoothVar * 1.4) * (beachCove * 0.55);

  // Gentle climbable green ramp / mountain pass on the east flank
  const eastPass = gaussian(x - 148, z - 18, 72, 95);
  h += eastPass * (44.0 + smoothVar * 14.0);

  // 4. Carve the Turquoise Coral Lagoon Bay at (0, 125)
  // Makes water shallow & crystal clear with reefs near the shore!
  const bayMask = gaussian(x - 4, z - 122, 74, 62);
  const targetLagoonDepth = -4.2 + (smoothVar - 0.5) * 3.0;
  h = h * (1.0 - bayMask * 0.88) + targetLagoonDepth * (bayMask * 0.88);

  // 5. Outer Reef & Rocky Sea Islets (great destinations for rafts & paragliding!)
  const westIslet = gaussian(x + 215, z - 210, 44, 38);
  h += westIslet * (44.0 + ridgeFine * 14.0);

  const eastIslet = gaussian(x - 218, z - 192, 40, 42);
  h += eastIslet * (41.0 + ridgeFine * 15.0);

  const farSouthReef = gaussian(x - 18, z - 295, 36, 26);
  h += farSouthReef * (28.5 + smoothVar * 8.0);

  // Small glacial basin terrace halfway up the main slope for ruins & resting
  const midTerrace = gaussian(x - 10, z - 10, 42, 34);
  if (midTerrace > 0.05) {
    const terraceHeight = 62.0 + smoothVar * 6.0;
    h = h * (1 - midTerrace * 0.45) + terraceHeight * (midTerrace * 0.45);
  }

  // Subtle terrain micro-undulation everywhere above water
  if (h > -5) {
    const detail = (fbm(x * 0.045, z * 0.045, 3) - 0.5) * 2.4;
    h += detail * smoothstep(-5, 10, h);
  }

  // Walkable scenic snow overlook terrace crowning the Main Summit (prevents sharp-spire camera clipping)
  const summitPad = gaussian(x - 12, z + 108, 13, 13);
  if (summitPad > 0.05) {
    const padHeight = 272.0;
    h = h * (1 - summitPad * 0.82) + padHeight * (summitPad * 0.82);
  }

  // Apply smooth ocean edge fade so outer boundary stays underwater
  h = -26.0 * (1.0 - edgeFade) + h * edgeFade;

  return h;
}

/** Central-difference surface normal (unit vector {x, y, z}) */
export function getTerrainNormal(x, z, eps = 1.2) {
  const hL = getTerrainHeight(x - eps, z);
  const hR = getTerrainHeight(x + eps, z);
  const hD = getTerrainHeight(x, z - eps);
  const hU = getTerrainHeight(x, z + eps);

  const nx = hL - hR;
  const ny = 2.0 * eps;
  const nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

/** Biome classification for HUD, Footsteps Audio, and Procedural Vegetation */
export function getBiomeInfo(x, z, y = getTerrainHeight(x, z)) {
  if (y < WORLD_CONFIG.SEA_LEVEL - 0.3) {
    return { id: 'ocean', name: '蔚蓝珊瑚海', footstep: 'water' };
  }
  if (y > 195) {
    return { id: 'sky_summit', name: '喜马拉雅之巅 · 云端圣境', footstep: 'snow' };
  }
  if (y > 125) {
    return { id: 'glacier', name: '冰川雪峰 · 绝壁冰原', footstep: 'snow' };
  }
  if (y > WORLD_CONFIG.SNOWLINE_Y) {
    return { id: 'cloud_snowline', name: '喜马拉雅云海雪线', footstep: 'snow' };
  }
  if (y > 38) {
    return { id: 'alpine_forest', name: '高山草甸与松林', footstep: 'grass' };
  }
  if (y > 4.2) {
    return { id: 'coastal_cliff', name: '海崖飞瀑绿坡', footstep: 'grass' };
  }
  return { id: 'beach', name: '珊瑚海湾沙滩', footstep: 'sand' };
}

/**
 * Generates exact heightfield grid data matching BOTH Three.js PlaneGeometry AND Rapier3D Heightfield.
 * Verified experimentally:
 * - Rapier heightfield(nrows=SEG, ncols=SEG, rapierHeights, scale={x:WORLD_SIZE, y:1, z:WORLD_SIZE})
 *   uses column-major index: rapierHeights[ix * (SEG + 1) + iz]
 *   where ix in [0..SEG] -> x in [-WORLD_SIZE/2..+WORLD_SIZE/2]
 *   and   iz in [0..SEG] -> z in [-WORLD_SIZE/2..+WORLD_SIZE/2].
 * - Three.js PlaneGeometry(WORLD_SIZE, WORLD_SIZE, SEG, SEG) rotated -PI/2 around X
 *   uses row-major vertex index: iz * (SEG + 1) + ix.
 */
export function buildHeightfieldData() {
  const seg = WORLD_CONFIG.TERRAIN_SEGMENTS;
  const size = WORLD_CONFIG.WORLD_SIZE;
  const half = size * 0.5;
  const vertsPerSide = seg + 1;

  const rapierHeights = new Float32Array(vertsPerSide * vertsPerSide);
  const meshHeights = new Float32Array(vertsPerSide * vertsPerSide);

  let minY = Infinity;
  let maxY = -Infinity;

  for (let iz = 0; iz <= seg; iz++) {
    const z = -half + (iz / seg) * size;
    for (let ix = 0; ix <= seg; ix++) {
      const x = -half + (ix / seg) * size;
      const y = getTerrainHeight(x, z);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      rapierHeights[ix * vertsPerSide + iz] = y;
      meshHeights[iz * vertsPerSide + ix] = y;
    }
  }

  return { seg, size, vertsPerSide, rapierHeights, meshHeights, minY, maxY };
}

// --- Iconic Landmarks, Floating Islands, Waterfalls & Updrafts ---

// Helper to resolve ground y safely
function groundPos(x, z, yOffset = 0) {
  return { x, y: getTerrainHeight(x, z) + yOffset, z };
}

export const FLOATING_ISLANDS = [
  {
    id: 'sky_sanctuary',
    name: '云端古代神殿岛',
    x: -54,
    y: 238,
    z: -32,
    radius: 24,
    thickness: 18,
    hasRuin: true,
  },
  {
    id: 'sky_spire_east',
    name: '东天浮石遗迹',
    x: 96,
    y: 256,
    z: -48,
    radius: 17,
    thickness: 14,
    hasRuin: true,
  },
  {
    id: 'sky_bay_isle',
    name: '海湾望风浮岛',
    x: 10,
    y: 158,
    z: 75,
    radius: 15,
    thickness: 12,
    hasRuin: false,
  },
];

export const WATERFALLS = [
  {
    id: 'east_cliff_falls_1',
    topX: 70,
    topZ: 92,
    bottomX: 54,
    bottomZ: 106,
    width: 10.5,
  },
  {
    id: 'east_cliff_falls_2',
    topX: 84,
    topZ: 112,
    bottomX: 68,
    bottomZ: 124,
    width: 7.5,
  },
  {
    id: 'west_glacier_falls',
    topX: -54,
    topZ: 64,
    bottomX: -44,
    bottomZ: 88,
    width: 9.0,
  },
];

export const UPDRAFTS = [
  { x: -10, z: 145, baseY: 2, topY: 130, radius: 16, strength: 19 },
  { x: 52, z: 98, baseY: 5, topY: 145, radius: 15, strength: 21 },
  { x: -65, z: 58, baseY: 15, topY: 165, radius: 16, strength: 22 },
  { x: 18, z: 22, baseY: 45, topY: 215, radius: 18, strength: 24 },
  { x: -38, z: -20, baseY: 95, topY: 265, radius: 18, strength: 25 },
  { x: 78, z: -38, baseY: 100, topY: 275, radius: 17, strength: 25 },
];

export const LANDMARKS = {
  bay_camp: {
    id: 'bay_camp',
    name: '珊瑚海湾营地',
    shortName: '海湾营地',
    ...groundPos(-52, 198, 1.5),
    lookAt: { x: 12, y: 150, z: -108 },
  },
  beach_raft: {
    id: 'beach_raft',
    name: '沙滩木筏码头',
    shortName: '木筏沙滩',
    ...groundPos(-16, 168, 1.2),
    lookAt: { x: 12, y: 140, z: -108 },
  },
  waterfall_cliff: {
    id: 'waterfall_cliff',
    name: '飞瀑海崖高台',
    shortName: '瀑布悬崖',
    ...groundPos(96, 86, 1.8),
    lookAt: { x: 12, y: 160, z: -108 },
  },
  alpine_ruins: {
    id: 'alpine_ruins',
    name: '云海古遗迹',
    shortName: '山腰遗迹',
    ...groundPos(10, 6, 1.8),
    lookAt: { x: 12, y: 240, z: -108 },
  },
  main_summit: {
    id: 'main_summit',
    name: '喜马拉雅主峰',
    shortName: '雪山主峰',
    ...groundPos(12, -108, 2.2),
    lookAt: { x: 0, y: 40, z: 140 },
  },
  sky_sanctuary: {
    id: 'sky_sanctuary',
    name: '云端神殿浮岛',
    shortName: '浮空神殿',
    x: FLOATING_ISLANDS[0].x,
    y: FLOATING_ISLANDS[0].y + 2.2,
    z: FLOATING_ISLANDS[0].z,
    lookAt: { x: 12, y: 260, z: -108 },
  },
};

export const SPAWN_POINT = LANDMARKS.bay_camp;
