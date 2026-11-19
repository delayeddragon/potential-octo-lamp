/**
 * RuneDeck — terrain: the multi-tiered ground, its painted surface and the River.
 *
 * The relief comes from `terrainHeight` in shared.js, the same function that
 * places units, so what is drawn is what is walked on. The ground is one grid
 * mesh, finer where the canyon and the cavern need it. Its surface is painted
 * by a procedural shader and baked to a texture once: grass, dirt and cobble
 * roads, obsidian and ash, rock faces with strata, and the sunlight and
 * hollows of the relief itself. Per frame only the glow, a detail grain and
 * the atmosphere are added. The River is a separate sheet of animated water
 * lying in the canyon.
 */

import * as THREE from 'three';

import { LIGHT_DIR } from './geometry.js';
import { LANES, LEVEL, MAP, TRAIL, terrainHeight } from './shared.js';
import { GLSL_TO_LINEAR } from './units.js';

/** The ground reaches past the playable field, so its rim can rise and then fade into the void. */
export const GROUND_W = 116;
export const GROUND_D = 74;
/** Size of one texel of the height and road field handed to the shaders. */
const FIELD_CELL = 0.2;
/** Half-widths of the roads and radii of the plazas they open into. */
export const PATH = { lane: 1.75, trail: 1.05, throne: 7.6, tower: 3.7, heroPad: 2.3 };
/** Fog of war: how far from the camera's focus the land starts to dim and where it is dimmest, and by how much. */
const VEIL = { near: 19, far: 36, strength: 0.42 };
/** Rocks, pillars and stairs standing in the River, for the water shader: a fixed number of slots. */
const ROCK_SLOTS = 24;

/**
 * Molten falls on the Dire cliffs: each pours from (x, z) for `length` units
 * along (dx, dz) and ends in a pool at the foot of the cliff.
 */
export const LAVA_FALLS = [
  { x: 13.5, z: -33, dx: 0, dz: 1, length: 8.9, width: 1.5 },
  { x: 26, z: -33.2, dx: 0, dz: 1, length: 9.1, width: 1.9 },
  { x: 38.5, z: -32.8, dx: 0, dz: 1, length: 8.7, width: 1.4 },
  { x: 53, z: -12.5, dx: -1, dz: 0, length: 8.9, width: 1.7 },
  { x: 53.2, z: 8, dx: -1, dz: 0, length: 9.1, width: 1.4 },
];

const f = (value) => Number(value).toFixed(3);
const R = MAP.river;

/* -------------------------------------------------------------------------- */
/* Roads                                                                      */
/* -------------------------------------------------------------------------- */

function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

function polylineDistance(px, pz, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    best = Math.min(best, segmentDistance(px, pz, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]));
  }
  return best;
}

// The lanes mirror on both axes, so one quadrant of one lane (and the span of its bridge) stands for all four.
const LANE_QUADRANT = LANES.bottom.filter((point) => point.x < 2.5).map((point) => [point.x, point.z]);

/** Signed distance to the nearest road or plaza: negative on it. Props stay off the roads by this. */
export function pathDistance(x, z) {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  return Math.min(
    polylineDistance(-ax, az, LANE_QUADRANT) - PATH.lane,
    polylineDistance(ax, z, TRAIL) - PATH.trail,
    Math.hypot(ax - MAP.throneX, z) - PATH.throne,
    Math.hypot(ax - MAP.towerX, az - MAP.laneZ) - PATH.tower,
    Math.hypot(ax - MAP.heroX, z) - PATH.heroPad,
  );
}

/* -------------------------------------------------------------------------- */
/* Shaders                                                                    */
/* -------------------------------------------------------------------------- */

const GLSL_NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p) {
  float n = hash21(p);
  return vec2(n, hash21(p + n + 17.17));
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const GLSL_FIELD = /* glsl */ `
const vec2 GROUND = vec2(${f(GROUND_W)}, ${f(GROUND_D)});
float riverCenter(float z) {
  return sin(z * ${f(R.freq1)}) * ${f(R.amp1)} + sin(z * ${f(R.freq2)} + ${f(R.phase2)}) * ${f(R.amp2)};
}
// Signed distance to the water's edge; negative in the River and the rune pool.
float riverDist(vec2 p) {
  float channel = abs(p.x - riverCenter(p.y)) - (${f(R.halfWidth)} + ${f(R.wobble)} * sin(p.y * ${f(R.wobbleFreq)} + ${f(R.wobblePhase)}));
  float pool = length(p) - ${f(R.poolRadius)};
  float h = clamp(0.5 + 0.5 * (pool - channel) / ${f(R.blend)}, 0.0, 1.0);
  return mix(pool, channel, h) - ${f(R.blend)} * h * (1.0 - h);
}
float outsideField(vec2 p) {
  vec2 d = abs(p) - vec2(${f(MAP.halfWidth + 0.6)}, ${f(MAP.halfDepth + 0.6)});
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
`;

const lavaPools = LAVA_FALLS.map(
  (fall) => `  d = min(d, length(p - vec2(${f(fall.x + fall.dx * fall.length)}, ${f(fall.z + fall.dz * fall.length)})));`,
).join('\n');

/** One-off bake: colour in rgb, emissive strength (lava, rune carvings, crystal veins) in alpha. */
const BAKE_FRAGMENT = /* glsl */ `
uniform sampler2D uField;   // r: terrain height, g: signed distance to the nearest road
varying vec2 vUv;
${GLSL_NOISE}
${GLSL_FIELD}

const vec3 SUN = vec3(${f(LIGHT_DIR.x)}, ${f(LIGHT_DIR.y)}, ${f(LIGHT_DIR.z)});
const vec2 CAVERN = vec2(${f(MAP.cavern.x)}, ${f(MAP.cavern.z)});

float fbm(vec2 p) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec2(11.7, 5.3);
    amp *= 0.5;
  }
  return sum;
}

// x: distance to the nearest cell edge, y: random value per cell.
vec2 voronoi(vec2 x) {
  vec2 n = floor(x);
  vec2 u = fract(x);
  vec2 nearestCell = vec2(0.0);
  vec2 nearest = vec2(0.0);
  float best = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + hash22(n + g) - u;
      float d = dot(r, r);
      if (d < best) { best = d; nearest = r; nearestCell = g; }
    }
  }
  float edge = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = nearestCell + vec2(float(i), float(j));
      vec2 r = g + hash22(n + g) - u;
      vec2 between = r - nearest;
      if (dot(between, between) > 0.00001) edge = min(edge, dot(0.5 * (nearest + r), normalize(between)));
    }
  }
  return vec2(edge, hash21(n + nearestCell + 0.5));
}

float band(float d, float radius, float width) {
  return smoothstep(width, 0.0, abs(d - radius));
}

vec2 field(vec2 p) {
  return texture2D(uField, p / GROUND + 0.5).rg;
}

// Distance to the nearest pool at the foot of a lava fall.
float lavaPool(vec2 p) {
  float d = 99.0;
${lavaPools}
  return d;
}

// 'verge' is 1 beside a road, where tufts and wildflowers crowd in.
vec3 grass(vec2 p, float verge) {
  float broad = fbm(p * 0.22 + 3.0);
  float patchy = fbm(p * 1.3 + 17.0);
  float blades = vnoise(p * vec2(13.0, 17.0));
  vec3 c = mix(vec3(0.035, 0.26, 0.14), vec3(0.10, 0.46, 0.21), broad);
  c = mix(c, vec3(0.21, 0.58, 0.25), smoothstep(0.52, 0.80, patchy) * 0.55);
  c = mix(c, vec3(0.30, 0.42, 0.14), smoothstep(0.62, 0.78, fbm(p * 0.5 + 60.0)) * 0.45);
  c *= 0.84 + 0.30 * blades;
  // Tufts: dark clumps with a lit tip.
  vec2 tuftCell = floor(p * 2.2);
  vec2 tuftAt = fract(p * 2.2) - 0.2 - 0.6 * hash22(tuftCell + 2.0);
  float tuft = step(0.80 - 0.45 * verge, hash21(tuftCell + 31.0)) * smoothstep(0.30, 0.05, length(tuftAt * vec2(1.0, 1.6)));
  c = mix(c, vec3(0.03, 0.20, 0.09), tuft * 0.75);
  c += vec3(0.10, 0.22, 0.06) * tuft * smoothstep(0.12, 0.0, length(tuftAt - vec2(0.0, 0.08)));
  // Wildflowers in three colours.
  vec2 cell = floor(p * 1.5);
  float bloom = step(0.88 - 0.5 * verge, hash21(cell + 11.0))
              * smoothstep(0.15, 0.06, length(fract(p * 1.5) - 0.2 - 0.6 * hash22(cell + 5.0)));
  float kind = hash21(cell + 23.0);
  vec3 petal = kind < 0.34 ? vec3(0.72, 0.95, 1.0) : kind < 0.67 ? vec3(1.0, 0.92, 0.50) : vec3(1.0, 0.62, 0.78);
  return mix(c, petal, bloom);
}

vec3 dirt(vec2 p) {
  vec3 c = mix(vec3(0.31, 0.22, 0.14), vec3(0.50, 0.39, 0.25), fbm(p * 0.9 + 40.0));
  c *= 0.84 + 0.30 * vnoise(p * 9.0);
  vec2 pebble = voronoi(p * 3.1 + 7.0);
  return mix(c, vec3(0.60, 0.57, 0.52), step(0.84, pebble.y) * smoothstep(0.06, 0.18, pebble.x) * 0.7);
}

// Rounded cobbles of uneven size, bedded in earth and moss. The lookup is warped so no row ever lines up.
vec3 cobble(vec2 p) {
  vec2 w = p + (vec2(vnoise(p * 0.7), vnoise(p * 0.7 + 9.0)) - 0.5) * 0.9;
  vec2 v = voronoi(w * 1.35);
  vec3 stone = mix(vec3(0.40, 0.43, 0.46), vec3(0.72, 0.72, 0.68), v.y);
  stone = mix(stone, vec3(0.57, 0.48, 0.36), step(0.72, fract(v.y * 7.3)) * 0.55);
  stone *= 0.80 + 0.30 * vnoise(p * 12.0);
  stone *= 0.84 + 0.22 * smoothstep(0.05, 0.40, v.x);
  vec3 joint = mix(vec3(0.20, 0.15, 0.10), vec3(0.12, 0.30, 0.13), smoothstep(0.40, 0.70, fbm(p * 1.9 + 8.0)));
  return mix(joint, stone, smoothstep(0.03, 0.16, v.x));
}

// Broad flagstones for the plazas; the older ones have cracked.
vec3 flagstone(vec2 p) {
  vec2 w = p + (vec2(vnoise(p * 0.45 + 2.0), vnoise(p * 0.45 + 11.0)) - 0.5) * 1.7;
  vec2 v = voronoi(w * vec2(0.66, 0.50) + 21.0);
  vec3 slab = mix(vec3(0.47, 0.50, 0.54), vec3(0.70, 0.72, 0.72), v.y);
  slab *= 0.84 + 0.26 * vnoise(p * 8.0);
  vec2 crack = voronoi(p * 1.5 + v.y * 37.0);
  float cracked = step(0.45, v.y) * smoothstep(0.035, 0.0, crack.x) * smoothstep(0.10, 0.30, v.x);
  slab = mix(slab, vec3(0.13, 0.15, 0.14), cracked * 0.85);
  return mix(vec3(0.12, 0.22, 0.13), slab, smoothstep(0.02, 0.09, v.x));
}

// 'heat' forces the lava cracks open, as around the pool of a lava fall.
vec4 obsidian(vec2 p, float heat) {
  vec2 plate = voronoi(p * 0.5 + 9.0);
  float grain = fbm(p * 0.9 + 21.0);
  vec3 c = mix(vec3(0.050, 0.043, 0.062), vec3(0.135, 0.110, 0.140), plate.y * 0.55 + grain * 0.45);
  c *= 0.78 + 0.34 * vnoise(p * 9.0);
  c += vec3(0.16, 0.13, 0.18) * pow(vnoise(vec2(p.x * 2.2 + p.y * 1.4, p.y * 7.0)), 5.0) * 0.8;
  c *= 0.80 + 0.20 * smoothstep(0.0, 0.12, plate.x);
  // The fissures wander, and open and pinch shut along their length: cracked ground, not a net of seams.
  vec2 w = p + (vec2(fbm(p * 0.33 + 4.0), fbm(p * 0.33 + 23.0)) - 0.5) * 3.4;
  vec2 crack = voronoi(w * 0.60 + vec2(3.0, 41.0));
  float region = max(smoothstep(0.42, 0.64, fbm(p * 0.20 + 57.0)), heat);
  float open = mix(smoothstep(0.34, 0.58, fbm(p * 0.85 + 77.0)), 1.0, heat);
  float core = smoothstep(0.065, 0.0, crack.x) * region * (0.15 + 0.85 * open);
  float warm = smoothstep(0.40, 0.0, crack.x) * region * (0.35 + 0.65 * open);
  c = mix(c, vec3(0.30, 0.045, 0.02), warm * 0.6);
  return vec4(c, clamp(core * 0.9 + warm * 0.22, 0.0, 1.0));
}

vec3 ash(vec2 p) {
  vec3 c = mix(vec3(0.075, 0.068, 0.072), vec3(0.215, 0.195, 0.185), fbm(p * 0.8 + 90.0));
  c *= 0.80 + 0.34 * vnoise(p * 10.0);
  // Cinders.
  vec2 v = voronoi(p * 3.4 + 2.0);
  return mix(c, vec3(0.03, 0.025, 0.03), step(0.80, v.y) * smoothstep(0.05, 0.16, v.x) * 0.8);
}

// Rock faces. The strata follow height, so they run level along every wall.
vec3 rockFace(vec2 p, float h, float dire) {
  float layer = vnoise(vec2(h * 4.6 + vnoise(p * 0.6) * 1.3, p.x * 0.13 + p.y * 0.11));
  float ledge = smoothstep(0.30, 0.70, fract(h * 1.45 + vnoise(p * 0.33) * 0.8));
  vec3 pale = mix(vec3(0.47, 0.49, 0.50), vec3(0.310, 0.255, 0.330), dire);
  vec3 dark = mix(vec3(0.24, 0.27, 0.32), vec3(0.090, 0.074, 0.112), dire);
  vec3 c = mix(dark, pale, layer * 0.65 + ledge * 0.35);
  c *= 0.80 + 0.32 * vnoise(p * 7.0);
  vec2 v = voronoi(p * 0.9 + 3.0);
  return c * (0.72 + 0.28 * smoothstep(0.0, 0.10, v.x));
}

void main() {
  vec2 p = (vUv - 0.5) * GROUND;
  vec2 q = abs(p);
  vec2 here = field(p);
  float h = here.x;

  // The relief, read back from the height field: its normal, how steep it is, and whether it is a hollow or a crest.
  const float E = 0.22;
  float hl = field(p - vec2(E, 0.0)).x;
  float hr = field(p + vec2(E, 0.0)).x;
  float hd = field(p - vec2(0.0, E)).x;
  float hu = field(p + vec2(0.0, E)).x;
  vec3 n = normalize(vec3(hl - hr, 2.0 * E, hd - hu));
  float grade = length(vec2(hl - hr, hd - hu)) / (2.0 * E);
  float steep = smoothstep(0.55, 1.05, grade);
  float hollow = hl + hr + hd + hu - 4.0 * h;

  float dire = step(riverCenter(p.y), p.x);
  float rd = riverDist(p);
  float outside = outsideField(p);
  // A warped edge: the roads swell and narrow like trodden paths, never ruled lines.
  float pd = here.y + (fbm(p * 0.45 + 31.0) - 0.5) * 1.1 + (vnoise(p * 2.1 + 4.0) - 0.5) * 0.3;
  float onPath = smoothstep(0.10, -0.10, pd) * (1.0 - smoothstep(0.0, 1.5, outside));
  float inRoad = -pd;

  float throneD = length(q - vec2(${f(MAP.throneX)}, 0.0));
  float towerD = length(q - vec2(${f(MAP.towerX)}, ${f(MAP.laneZ)}));
  float heroD = length(q - vec2(${f(MAP.heroX)}, 0.0));
  float plaza = max(smoothstep(${f(PATH.throne + 0.2)}, ${f(PATH.throne - 1.0)}, throneD),
                    max(smoothstep(${f(PATH.tower + 0.3)}, ${f(PATH.tower - 0.5)}, towerD), smoothstep(${f(PATH.heroPad + 0.3)}, ${f(PATH.heroPad - 0.3)}, heroD)));
  // Where a road climbs between tiers it is cut into steps, one for every hand of height.
  float tread = fract(h / 0.15);
  float stairs = smoothstep(0.07, 0.17, grade) * onPath * (1.0 - steep);
  float riser = smoothstep(0.0, 0.16, tread) * (0.86 + 0.20 * smoothstep(0.55, 1.0, tread));

  // Most of the map is plain grass or plain rock, so each other material is only worked out where it shows.
  vec3 col;
  float glow = 0.0;
  float inField = 1.0 - smoothstep(0.0, 1.0, outside);
  if (dire < 0.5) {
    float verge = smoothstep(1.7, 0.0, pd) * (1.0 - onPath);
    col = grass(p, verge);
    col = mix(col, col * vec3(0.74, 0.72, 0.52) + vec3(0.03, 0.02, 0.0), smoothstep(1.1, 0.0, pd) * 0.6);
    if (onPath > 0.0) {
      // Trodden dirt, with cobbles where the road was once paved and flagstones on the plazas.
      float paved = smoothstep(0.42, 0.60, fbm(p * 0.30 + 71.0) + 0.22 * smoothstep(0.2, 1.4, inRoad));
      vec3 road = mix(dirt(p), cobble(p), paved);
      if (plaza > 0.0) road = mix(road, flagstone(p), plaza);
      road = mix(road, mix(vec3(0.50, 0.53, 0.56), vec3(0.72, 0.74, 0.74), vnoise(p * 1.7)) * riser, stairs * 0.9);
      col = mix(col, road, onPath);
    }
    // Mossy curbstones, some of them missing, hold the edge of the road.
    float curb = smoothstep(0.30, 0.18, abs(pd + 0.20)) * (1.0 - plaza) * inField;
    if (curb > 0.0) {
      vec2 curbCell = voronoi(p * 1.15 + 13.0);
      vec3 curbCol = mix(vec3(0.38, 0.41, 0.40), vec3(0.62, 0.64, 0.60), curbCell.y) * (0.85 + 0.25 * vnoise(p * 10.0));
      curbCol = mix(curbCol, vec3(0.16, 0.38, 0.15), smoothstep(0.42, 0.70, fbm(p * 2.3 + 5.0)) * 0.8);
      col = mix(col, curbCol, curb * step(0.18, curbCell.y) * smoothstep(0.03, 0.12, curbCell.x));
    }
  } else {
    float toPool = lavaPool(p);
    vec4 rock = obsidian(p, smoothstep(5.0, 1.2, toPool));
    // The ground beside the road is burnt black.
    col = rock.rgb * (1.0 - 0.45 * smoothstep(1.4, 0.0, pd));
    glow = rock.a;
    if (onPath > 0.0) {
      // Scorched ash, slabs of cracked basalt, and veins of magma that wander under both.
      float paved = smoothstep(0.42, 0.60, fbm(p * 0.30 + 71.0) + 0.22 * smoothstep(0.2, 1.4, inRoad));
      vec2 w = p + (vec2(vnoise(p * 0.6 + 3.0), vnoise(p * 0.6 + 14.0)) - 0.5) * 1.1;
      vec2 slabCell = voronoi(w * 0.85 + 5.0);
      vec3 slab = mix(vec3(0.13, 0.115, 0.13), vec3(0.26, 0.225, 0.235), slabCell.y) * (0.80 + 0.30 * vnoise(p * 9.0));
      slab = mix(vec3(0.045, 0.03, 0.03), slab, smoothstep(0.02, 0.11, slabCell.x));
      vec3 road = mix(ash(p), slab, max(paved, plaza));
      vec2 vein = voronoi(w * 0.36 + vec2(3.0, 41.0));
      float veinMask = smoothstep(0.38, 0.60, fbm(p * 0.17 + 57.0));
      float core = smoothstep(0.05, 0.0, vein.x) * veinMask;
      float warm = smoothstep(0.30, 0.0, vein.x) * veinMask;
      road = mix(road, vec3(0.34, 0.05, 0.02), warm * 0.65);
      float roadGlow = core * 0.9 + warm * 0.2;
      road = mix(road, mix(vec3(0.17, 0.15, 0.17), vec3(0.30, 0.26, 0.27), vnoise(p * 1.7)) * riser, stairs * 0.9);
      // Embers glow in the riser of every step.
      roadGlow = max(roadGlow * (1.0 - stairs), stairs * (1.0 - smoothstep(0.0, 0.10, tread)) * 0.55);
      col = mix(col, road, onPath);
      glow = mix(glow, roadGlow, onPath);
    }
    // A broken molten seam runs along the kerb.
    float kerb = band(pd, 0.0, 0.16) * inField;
    if (kerb > 0.0) {
      kerb *= smoothstep(0.30, 0.60, vnoise(p * 0.9 + 12.0));
      col = mix(col, vec3(0.50, 0.09, 0.02), kerb * 0.65);
      glow = max(glow, kerb * 0.55);
    }
    // Lava pools at the foot of the falls.
    if (toPool < 2.2) {
      float pool = smoothstep(1.45, 0.75, toPool + (fbm(p * 1.4 + 9.0) - 0.5) * 0.9);
      col = mix(col, mix(vec3(0.85, 0.16, 0.02), vec3(1.0, 0.62, 0.14), fbm(p * 2.2 + 3.0)), pool);
      glow = max(glow, pool);
    }
  }

  // Rune circles carved into the plazas.
  float ticks = step(0.5, fract(atan(q.y, q.x - ${f(MAP.throneX)}) * 3.8197));
  float carve = band(throneD, 6.90, 0.06) + band(throneD, 6.50, 0.13) * ticks * 0.7 + band(throneD, 6.10, 0.04)
              + band(towerD, 3.15, 0.055) + band(heroD, 1.80, 0.05);
  carve = clamp(carve, 0.0, 1.0) * (1.0 - stairs);
  col = mix(col, mix(vec3(0.20, 0.52, 0.80), vec3(0.50, 0.10, 0.03), dire), carve * 0.65);
  glow = max(glow, carve * 0.8);

  // Contact shading at the foot of each structure.
  col *= mix(0.64, 1.0, smoothstep(3.1, 4.3, throneD));
  col *= mix(0.68, 1.0, smoothstep(1.7, 2.6, towerD));

  // Bare rock wherever the ground stands too steep to hold soil, and on the heights.
  float bare = max(steep, smoothstep(2.2, 3.4, h) * 0.85);
  if (bare > 0.0) {
    vec3 face = rockFace(p, h, dire);
    // Moss settles on what Radiant rock faces the sky; magma seeps from the seams of the Dire cliffs.
    face = mix(face, vec3(0.14, 0.33, 0.15), (1.0 - dire) * smoothstep(0.50, 0.75, fbm(p * 1.1 + 13.0)) * smoothstep(0.45, 0.85, n.y) * 0.7);
    col = mix(col, face, bare);
    glow *= 1.0 - bare;
    if (dire > 0.5) {
      float seep = bare * smoothstep(0.05, 0.0, voronoi(p * 0.55 + 77.0).x) * smoothstep(0.45, 0.65, fbm(p * 0.25 + 19.0));
      col = mix(col, vec3(0.42, 0.07, 0.02), seep * 0.7);
      glow = max(glow, seep * 0.8);
    }
  }

  // The Guardian's pit: scoured stone threaded with veins of crystal light.
  float pit = smoothstep(${f(MAP.cavern.pit + 1.3)}, ${f(MAP.cavern.pit - 0.4)}, length(p - CAVERN));
  if (pit > 0.0) {
    vec2 lode = voronoi(p * 0.8 + 5.0);
    col = mix(col, rockFace(p * 1.3, h, 0.0) * 1.08, pit);
    float lodeGlow = pit * smoothstep(0.06, 0.0, lode.x) * step(0.35, lode.y);
    col = mix(col, vec3(0.20, 0.75, 0.85), lodeGlow * 0.7);
    glow = max(glow * (1.0 - pit), lodeGlow * 0.85);
  }

  // The canyon: a wet shore above the waterline, a pebbled bed below it.
  float canyon = smoothstep(0.5, -0.1, rd);
  if (canyon > 0.0) {
    vec3 bed = mix(vec3(0.40, 0.44, 0.36), vec3(0.11, 0.10, 0.12), dire) * (0.72 + 0.36 * vnoise(p * 5.0));
    vec2 stone = voronoi(p * 1.9 + 4.0);
    bed = mix(bed, bed * 1.45, step(0.6, stone.y) * smoothstep(0.05, 0.20, stone.x));
    float under = smoothstep(${f(LEVEL.water + 0.25)}, ${f(LEVEL.water - 0.35)}, h) * canyon;
    col = mix(col, bed, under);
    col *= 1.0 - 0.30 * canyon * smoothstep(${f(LEVEL.water + 1.0)}, ${f(LEVEL.water + 0.1)}, h);
    col *= mix(1.0, mix(0.60, 1.0, smoothstep(${f(LEVEL.bed)}, -0.3, h)), canyon);
    glow *= 1.0 - canyon;
  }

  // Sunlight on the relief. Level ground keeps its painted brightness; slopes turn towards or away from the sun.
  float sun = clamp(dot(n, SUN) / SUN.y, 0.0, 1.25);
  col *= mix(0.52, 1.0, sun);
  // Hollows gather shadow and crests catch a little light.
  col *= 1.0 - clamp(hollow * 1.5, -0.14, 0.34);

  // Beyond the field the ground darkens, then crumbles into the void.
  col *= 1.0 - 0.15 * smoothstep(0.0, 3.0, outside);
  col = mix(col, mix(vec3(0.020, 0.040, 0.085), vec3(0.070, 0.022, 0.030), dire), smoothstep(8.5, 12.5, outside));
  glow *= 1.0 - smoothstep(7.5, 11.5, outside);

  gl_FragColor = vec4(col, glow);
}
`;

const BAKE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SURFACE_VERTEX = /* glsl */ `
varying vec3 vWorld;
varying float vDepth;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 view = viewMatrix * world;
  vWorld = world.xyz;
  vDepth = -view.z;
  gl_Position = projectionMatrix * view;
}
`;

/** The veil and haze every ground shader finishes with: `lin` is linear colour. */
const GLSL_ATMOSPHERE = /* glsl */ `
uniform vec3 uVoid;
uniform vec3 uHaze;
uniform vec3 uFog;     // view depth where the haze starts and where it is thickest, and its strength
uniform vec2 uFocus;   // the point on the ground the camera is looking at
uniform vec3 uVeil;    // distance from the focus where the fog of war starts and where it is fullest, and its strength
// Fog of war: the land beyond the camera's reach dims and cools.
float veilAt(vec2 p) {
  return smoothstep(uVeil.x, uVeil.y, length((p - uFocus) * vec2(1.0, 1.25))) * uVeil.z;
}
vec3 veiled(vec3 col, float veil) {
  return mix(col, vec3(dot(col, vec3(0.30, 0.50, 0.20))) * vec3(0.50, 0.60, 0.88), veil);
}
vec3 hazed(vec3 lin, float depth) {
  return mix(lin, uHaze, smoothstep(uFog.x, uFog.y, depth) * uFog.z);
}
`;

/** Per-frame terrain: the baked map plus a fine grain, pulsing emissive and the atmosphere. */
const TERRAIN_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uDetail;
uniform float uTime;
varying vec3 vWorld;
varying float vDepth;
${GLSL_FIELD}
${GLSL_TO_LINEAR}
${GLSL_ATMOSPHERE}

void main() {
  vec2 p = vWorld.xz;
  vec4 base = texture2D(uMap, p / GROUND + 0.5);
  // The camera sits closer than the bake resolves; a tiling grain keeps the ground crisp.
  float grain = texture2D(uDetail, p * 0.31).r * 0.6 + texture2D(uDetail, p * 1.17 + 0.37).r * 0.4;
  vec3 col = base.rgb * (0.80 + 0.40 * grain);
  float dire = smoothstep(-0.3, 0.3, p.x - riverCenter(p.y));

  float pulse = 0.72 + 0.28 * sin(uTime * 1.7 + p.x * 0.9 + p.y * 1.3);
  vec3 lava = mix(vec3(0.95, 0.14, 0.02), vec3(1.0, 0.80, 0.28), smoothstep(0.3, 0.95, base.a)) * pulse * 1.3;
  vec3 arcane = vec3(0.30, 0.82, 1.0) * (0.8 + 0.2 * sin(uTime * 1.2 + p.x));
  vec3 emissive = mix(arcane, lava, dire) * base.a;
  col += emissive;

  float veil = veilAt(p);
  float fade = smoothstep(9.0, 13.0, outsideField(p));
  vec3 lin = toLinear(mix(veiled(col, veil), uVoid, fade));
  // Energy past white, for the bloom: molten cracks and arcane veins.
  lin += toLinear(emissive) * ${f(0.55)} * (1.0 - fade) * (1.0 - veil);
  gl_FragColor = vec4(hazed(lin, vDepth), 1.0);
  #include <colorspace_fragment>
}
`;

/** The River: a sheet of water in the canyon, shaded by how deep the bed lies beneath it. */
const WATER_FRAGMENT = /* glsl */ `
uniform sampler2D uField;
uniform float uTime;
uniform vec3 uRocks[${ROCK_SLOTS}];   // x, z and radius of everything that stands in the current
varying vec3 vWorld;
varying float vDepth;
${GLSL_NOISE}
${GLSL_FIELD}
${GLSL_TO_LINEAR}
${GLSL_ATMOSPHERE}

float flow(vec2 p) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 3; i++) {
    sum += amp * vnoise(p);
    p = p * 2.02 + vec2(7.1, 3.7);
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec2 p = vWorld.xz;
  float depth = ${f(LEVEL.water)} - texture2D(uField, p / GROUND + 0.5).r;
  if (depth < -0.04) discard;
  float t = uTime;
  float deep = smoothstep(0.0, 0.8, depth);
  vec2 q = vec2(p.x - riverCenter(p.y), p.y);
  float n1 = flow(q * vec2(0.9, 0.32) + vec2(0.0, -t * 0.42));
  float n2 = flow(q * vec2(1.7, 0.70) + vec2(n1 * 1.6 + 3.0, -t * 0.75));
  vec3 c = mix(vec3(0.16, 0.72, 0.74), vec3(0.02, 0.26, 0.48), deep);
  c += vec3(0.30, 0.95, 1.0) * pow(n2, 3.0) * 1.3;

  // Current streaks running downstream.
  float streak = sin((q.y * 0.8 - t * 1.4 + n1 * 5.0) * 3.0) * 0.5 + 0.5;
  c += vec3(0.55, 1.0, 1.0) * smoothstep(0.86, 1.0, streak) * (0.15 + 0.5 * n2) * 0.55 * deep;

  // Rings spreading from the rune pad.
  float r = length(p);
  float padRing = sin(r * 3.4 - t * 2.6) * 0.5 + 0.5;
  c += vec3(0.45, 1.0, 1.0) * smoothstep(0.78, 1.0, padRing) * smoothstep(7.4, 3.6, r) * 0.32;

  // Scattered drip ripples.
  vec2 cell = floor(p * 0.4);
  vec2 centre = (cell + 0.2 + 0.6 * hash22(cell)) * 2.5;
  float age = fract(t * 0.35 + hash21(cell + 9.0));
  c += vec3(0.6, 1.0, 1.0) * smoothstep(0.07, 0.0, abs(length(p - centre) - age * 1.1)) * (1.0 - age) * 0.45 * deep;

  // Foam laps at the canyon walls...
  float foam = smoothstep(0.42, 0.03, depth) * (0.55 + 0.45 * sin(depth * 16.0 - t * 2.2 + n1 * 7.0));
  // ...and collars every rock, pillar and stair in the current, which also sheds widening ripples and a wake.
  for (int i = 0; i < ${ROCK_SLOTS}; i++) {
    vec3 rock = uRocks[i];
    if (rock.z <= 0.0) continue;
    vec2 d = p - rock.xy;
    float gap = length(d) - rock.z;
    if (gap > 3.0) continue;
    float churn = 0.6 + 0.4 * sin(atan(d.y, d.x) * 5.0 + t * 3.0 + n1 * 6.0);
    foam += smoothstep(0.40, 0.02, gap) * churn;
    float ripple = sin(gap * 8.0 - t * 4.2) * 0.5 + 0.5;
    c += vec3(0.5, 1.0, 1.0) * smoothstep(0.72, 1.0, ripple) * smoothstep(2.4, 0.1, gap) * 0.30;
    // The wake trails downstream, towards +z.
    float wake = smoothstep(rock.z * 0.9, 0.0, abs(d.x)) * smoothstep(0.0, 0.6, d.y) * smoothstep(rock.z * 5.0, rock.z, d.y);
    foam += wake * (0.35 + 0.35 * sin(d.y * 7.0 - t * 5.0 + n1 * 8.0)) * 0.6;
  }
  c = mix(c, vec3(0.86, 1.0, 1.0), clamp(foam, 0.0, 1.0) * 0.8);

  float veil = veilAt(p);
  float fade = smoothstep(9.0, 13.0, outsideField(p));
  vec3 lin = toLinear(mix(veiled(c, veil), uVoid, fade));
  // The brightest water glows past white, for the bloom.
  lin += vec3(0.08, 0.45, 0.60) * pow(max(c.g - 0.80, 0.0) * 3.0, 2.0) * (1.0 - fade) * (1.0 - veil);
  float alpha = smoothstep(-0.04, 0.10, depth) * mix(0.74, 0.97, deep);
  gl_FragColor = vec4(hazed(lin, vDepth), alpha);
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/** Terrain height and road distance on a regular grid, as a texture for the shaders. */
function buildFieldTexture() {
  const cols = Math.round(GROUND_W / FIELD_CELL);
  const rows = Math.round(GROUND_D / FIELD_CELL);
  const data = new Uint16Array(cols * rows * 2);
  const half = THREE.DataUtils.toHalfFloat;
  for (let row = 0; row < rows; row++) {
    const z = -GROUND_D / 2 + (row + 0.5) * FIELD_CELL;
    for (let col = 0; col < cols; col++) {
      const x = -GROUND_W / 2 + (col + 0.5) * FIELD_CELL;
      const i = (row * cols + col) * 2;
      data[i] = half(terrainHeight(x, z));
      data[i + 1] = half(Math.max(-8, Math.min(8, pathDistance(x, z))));
    }
  }
  const texture = new THREE.DataTexture(data, cols, rows, THREE.RGFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** A tiling grain: wrapped value noise in three octaves. */
function buildDetailTexture() {
  const size = 256;
  const data = new Uint8Array(size * size);
  const lattice = (period, seed) => {
    const values = new Float32Array(period * period);
    let state = seed;
    for (let i = 0; i < values.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) | 0;
      values[i] = (state >>> 8) / 16777216;
    }
    return (x, y) => {
      const x0 = Math.floor(x) % period;
      const y0 = Math.floor(y) % period;
      const x1 = (x0 + 1) % period;
      const y1 = (y0 + 1) % period;
      const u = x - Math.floor(x);
      const v = y - Math.floor(y);
      const su = u * u * (3 - 2 * u);
      const sv = v * v * (3 - 2 * v);
      const top = values[y0 * period + x0] * (1 - su) + values[y0 * period + x1] * su;
      const bottom = values[y1 * period + x0] * (1 - su) + values[y1 * period + x1] * su;
      return top * (1 - sv) + bottom * sv;
    };
  };
  const octaves = [[16, 0.5, lattice(16, 7)], [48, 0.3, lattice(48, 21)], [128, 0.2, lattice(128, 55)]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (const [period, weight, sample] of octaves) sum += weight * sample((x / size) * period, (y / size) * period);
      data[y * size + x] = Math.round(Math.min(1, Math.max(0, sum)) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Grid lines from -half to half, spaced by `step(position)`. */
function gridLines(half, step) {
  const lines = [-half];
  while (lines[lines.length - 1] < half - 1e-6) {
    const at = lines[lines.length - 1];
    lines.push(Math.min(half, at + step(at)));
  }
  return lines;
}

/** The ground mesh: a grid draped over the relief, finest across the canyon and the cavern. */
function buildGroundGeometry() {
  const { cavern } = MAP;
  const xs = gridLines(GROUND_W / 2, (x) => (Math.abs(x) < 9.6 ? 0.2 : Math.abs(x - cavern.x) < cavern.radius + 1 ? 0.3 : 0.5));
  const zs = gridLines(GROUND_D / 2, () => 0.3);
  const positions = new Float32Array(xs.length * zs.length * 3);
  zs.forEach((z, row) => {
    xs.forEach((x, col) => {
      positions.set([x, terrainHeight(x, z), z], (row * xs.length + col) * 3);
    });
  });
  const index = new Uint32Array((xs.length - 1) * (zs.length - 1) * 6);
  let at = 0;
  for (let row = 0; row < zs.length - 1; row++) {
    for (let col = 0; col < xs.length - 1; col++) {
      const a = row * xs.length + col;
      const b = a + 1;
      const c = a + xs.length;
      const d = c + 1;
      // Split each cell along its flatter diagonal, which keeps the cliff edges clean.
      if (Math.abs(positions[a * 3 + 1] - positions[d * 3 + 1]) < Math.abs(positions[b * 3 + 1] - positions[c * 3 + 1])) {
        index.set([a, c, d, a, d, b], at);
      } else {
        index.set([a, c, b, b, c, d], at);
      }
      at += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * @param renderer  used once, to bake the surface
 * @param voidColor colour the ground fades into beyond its rim
 * @param hazeColor colour of the distance haze, matching the scene's fog
 */
export function createTerrain(renderer, { voidColor, hazeColor, fog }) {
  const fieldTexture = buildFieldTexture();

  // ?bake=1024 lowers the bake resolution, for diagnostics on a software renderer.
  const requested = Number(new URLSearchParams(window.location.search).get('bake')) || 4096;
  const bakeWidth = Math.min(requested, renderer.capabilities.maxTextureSize);
  const target = new THREE.WebGLRenderTarget(bakeWidth, Math.round((bakeWidth * GROUND_D) / GROUND_W), {
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  {
    const bakeMaterial = new THREE.ShaderMaterial({
      uniforms: { uField: { value: fieldTexture } },
      vertexShader: BAKE_VERTEX,
      fragmentShader: BAKE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMaterial);
    quad.frustumCulled = false;
    renderer.setRenderTarget(target);
    renderer.render(quad, new THREE.Camera());
    renderer.setRenderTarget(null);
    quad.geometry.dispose();
    bakeMaterial.dispose();
  }

  const atmosphere = {
    uVoid: { value: new THREE.Color().setHex(voidColor, THREE.LinearSRGBColorSpace) },
    uHaze: { value: new THREE.Color(hazeColor) },
    uFog: { value: new THREE.Vector3(fog.near, fog.far, 1) },
    uFocus: { value: new THREE.Vector2() },
    uVeil: { value: new THREE.Vector3(VEIL.near, VEIL.far, VEIL.strength) },
  };
  const time = { value: 0 };
  const rocks = Array.from({ length: ROCK_SLOTS }, () => new THREE.Vector3());

  const geometry = buildGroundGeometry();
  const ground = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: { ...atmosphere, uMap: { value: target.texture }, uDetail: { value: buildDetailTexture() }, uTime: time },
      vertexShader: SURFACE_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
    }),
  );

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(30, GROUND_D).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: { ...atmosphere, uField: { value: fieldTexture }, uTime: time, uRocks: { value: rocks } },
      vertexShader: SURFACE_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      depthWrite: false,
    }),
  );
  water.position.y = LEVEL.water;
  water.renderOrder = -2;

  // The ground shader is unlit, so a transparent copy of the same surface shows the shadows cast onto it.
  const shadows = new THREE.Mesh(
    geometry,
    new THREE.ShadowMaterial({ color: 0x02040a, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
  );
  shadows.receiveShadow = true;
  shadows.renderOrder = -1;

  for (const mesh of [ground, water, shadows]) mesh.frustumCulled = false;

  return {
    meshes: [ground, water, shadows],

    /** `list` is [{ x, z, radius }]: what stands in the River and should gather foam. */
    setRocks(list) {
      rocks.forEach((slot, i) => {
        const rock = list[i];
        if (rock) slot.set(rock.x, rock.z, rock.radius);
        else slot.set(0, 0, 0);
      });
    },

    /**
     * Advances the animation and moves the fog of war with the camera's focus. `zoom` is the camera's
     * distance as a share of normal: the haze and the veil stretch with it, so pulling back does not thicken them.
     */
    update(seconds, focusX, focusZ, zoom = 1) {
      time.value = seconds;
      atmosphere.uFocus.value.set(focusX, focusZ);
      atmosphere.uFog.value.set(fog.near * zoom, fog.far * zoom, 1);
      atmosphere.uVeil.value.set(VEIL.near * zoom, VEIL.far * zoom, VEIL.strength);
    },
  };
}
