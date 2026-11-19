/**
 * RuneDeck — the lobby's stage.
 *
 * A small real-time scene behind the lobby: the chosen champion stands on a rune
 * stone pedestal, breathing, its cloak stirring and its weapon shedding light.
 * The champions are the models the battle uses (heroes.js), posed by the same
 * rig; the pedestal and the hall around it are sculpted here.
 *
 * The hall takes on the realm of whoever stands in it. The light, the fog, the
 * glow of the runes and what rises through the air all cross over together:
 * sapphire light and climbing crystals for a Radiant champion, a crimson and
 * amber rim and embers for a Dire one.
 *
 * The lobby says where on the screen the champion belongs (`spot`, the box its
 * current tab keeps clear), and `setView` how to frame it there; the camera eases
 * from one framing to the next. On the Heroes tab the model can be turned by
 * dragging `dragSurface`, and keeps turning for a moment when let go.
 *
 * Nothing is drawn while `setPaused(true)` holds: the lobby pauses the stage for
 * as long as a match is on screen.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { canvasTexture } from './geometry.js';
import { buildHero } from './heroes.js';
import { FINISH, Sculpt, paint, studioEnvironment, surfaceMaterial } from './sculpt.js';
import { CHAMPIONS, CHAMPION_IDS } from './shared.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const FOV = 30;
const TAN_HALF_FOV = Math.tan((FOV * DEG) / 2);
/** Height of the floor the pedestal stands on. The champion stands on the pedestal's top, at 0. */
const FLOOR = -1.3;

/**
 * How each tab frames the champion. The slice of the scene from `low` to `high`
 * (world heights) fills the tab's hero spot on screen; `turn` and `tilt` (radians)
 * are where the camera stands round and above the pedestal, and `yaw` is how the
 * champion is turned towards it.
 */
const VIEWS = {
  play: { low: -1.45, high: 3.75, turn: -0.16, tilt: 0.03, yaw: 0.36 },
  heroes: { low: -0.62, high: 3.62, turn: 0.04, tilt: 0.01, yaw: 0.26 },
  // On these two the champion is seen through the lobby's frosted sheet, standing in the middle of the hall.
  deck: { low: -1.75, high: 4.25, turn: 0.1, tilt: 0.05, yaw: 0.3 },
  codex: { low: -1.75, high: 4.25, turn: -0.1, tilt: 0.05, yaw: 0.2 },
};

/** The colours of the hall under each realm. Everything between the two is a blend. */
const REALMS = {
  radiant: {
    zenith: 0x01030a,
    horizon: 0x081a40,
    haze: 0x2468ff,
    fog: 0x050c20,
    sky: 0x86b0ff,
    ground: 0x0a1230,
    key: 0xdfe9ff,
    rim: 0x2a70ff,
    edge: 0x35d6ff,
    glow: 0x59d2ff,
    stone: 0x1a4aa0,
  },
  dire: {
    zenith: 0x060202,
    horizon: 0x360c06,
    haze: 0xff4a12,
    fog: 0x180605,
    sky: 0xffa070,
    ground: 0x220a05,
    key: 0xffdfc0,
    rim: 0xff3414,
    edge: 0xffa22e,
    glow: 0xff6a1a,
    stone: 0xa0300f,
  },
};

/**
 * How brightly the hall is lit. The champion's armour is to read as armour, steel
 * and cloth and gold: only what glows of itself (a blade, a visor, the runes) is
 * bright enough to bloom.
 */
const LIGHT = { sky: 0.5, key: 1.9, rim: 2.6, edge: 1.4, underglow: 2, weapon: 0.7, runes: 1.35, pool: 0.3 };

/** How long a champion's flourish takes, and where in it the weapon is raised and the cut lands. */
const FLOURISH = { seconds: 1.15, windup: 0.3, impact: 0.52 };
/** Rune strokes as [x1, y1, x2, y2] segments inside a unit box. */
const RUNES = [
  [[0, -0.5, 0, 0.5], [0, -0.32, 0.34, -0.5], [0, -0.02, 0.34, -0.2]],
  [[0, -0.5, 0.36, 0], [0.36, 0, 0, 0.5], [0, 0.5, -0.36, 0], [-0.36, 0, 0, -0.5]],
  [[0, -0.5, 0, 0.5], [0, -0.5, -0.34, -0.14], [0, -0.5, 0.34, -0.14]],
  [[-0.34, -0.5, 0.34, 0.5], [0.34, -0.5, -0.34, 0.5]],
  [[0.26, -0.5, -0.26, -0.12], [-0.26, -0.12, 0.26, 0.12], [0.26, 0.12, -0.26, 0.5]],
  [[0, -0.5, 0, 0.5], [0, 0, -0.34, -0.42], [0, 0, 0.34, -0.42]],
  [[-0.22, -0.5, -0.22, 0.5], [-0.22, -0.5, 0.26, -0.25], [0.26, -0.25, -0.22, 0], [-0.22, 0, 0.3, 0.5]],
];

const smooth = (t) => t * t * (3 - 2 * t);
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

/* -------------------------------------------------------------------------- */
/* The hall                                                                   */
/* -------------------------------------------------------------------------- */

/** One rune, `size` tall: its strokes as bars lying in the XY plane about the origin. */
function carve(sculpt, ink, strokes, size, thick, depth) {
  for (const [x1, y1, x2, y2] of strokes) {
    const length = Math.hypot(x2 - x1, y2 - y1) * size + thick;
    sculpt.add(new THREE.BoxGeometry(length, thick, depth), ink, ((x1 + x2) / 2) * size, -((y1 + y2) / 2) * size, 0, { rz: -Math.atan2(y2 - y1, x2 - x1) });
  }
}

/** The pedestal, the floor's scattered rock and the standing stones behind: everything of stone. */
function sculptHall() {
  const s = new Sculpt();
  const slate = paint(0x1a2030, 0x4d5772, FINISH.stone);
  const basalt = paint(0x090b12, 0x232838, FINISH.stone);
  const bronze = paint(0x4a3814, 0xd9b666, FINISH.gold);

  // Three tiers: a wide twelve-sided plinth, a carved drum, and the round cap the champion stands on.
  s.lathe(basalt, 0, FLOOR, 0, [[2.66, 0], [2.66, 0.16], [2.52, 0.3], [0, 0.3]], { seg: 12, facet: true });
  s.lathe(slate, 0, FLOOR + 0.3, 0, [[2.12, 0], [2.02, 0.1], [1.92, 0.52], [2.0, 0.6], [0, 0.6]], { seg: 12, facet: true });
  s.lathe(slate, 0, FLOOR + 0.9, 0, [[1.78, 0], [1.82, 0.1], [1.74, 0.3], [1.62, 0.39], [0, 0.4]], { seg: 40 });
  s.torus(bronze, 0, FLOOR + 0.93, 0, 1.83, 0.04, { sides: 6, seg: 56 });
  s.torus(bronze, 0, -0.012, 0, 1.52, 0.022, { sides: 5, seg: 56 });
  // Six buttresses stand against the drum, a bronze cap on each; the faces between them carry the runes.
  for (let i = 0; i < 6; i++) {
    const phi = (15 + i * 60) * DEG;
    const x = Math.sin(phi) * 2.04;
    const z = Math.cos(phi) * 2.04;
    s.box(basalt, x, FLOOR + 0.3, z, 0.64, 0.66, 0.4, { ry: phi, round: 0.04 });
    s.box(bronze, x, FLOOR + 0.96, z, 0.5, 0.05, 0.3, { ry: phi });
  }

  // Rubble about the foot of it.
  for (const [x, z, r] of [[3.5, 1.9, 0.42], [-3.9, 0.9, 0.56], [-2.9, -3.3, 0.7], [4.3, -2.3, 0.62], [1.2, 4.1, 0.3], [-1.7, 3.6, 0.24], [5.6, 0.6, 0.36]]) {
    s.rock(basalt, x, FLOOR + r * 0.42, z, r, { sy: 0.8 });
  }
  // Standing stones in an arc behind: dark shapes for the far light to stand against.
  const stones = [
    [-14.5, -2.5, 1.5, 6.4, 0.07],
    [-11, -7, 1.3, 8.6, -0.05],
    [-6.8, -11, 1.7, 10.5, 0.04],
    [-2.6, -14, 1.2, 7.4, -0.06],
    [2.4, -15.5, 1.9, 12, 0.03],
    [7, -12.5, 1.4, 9, 0.06],
    [11.2, -8, 1.6, 7.2, -0.04],
    [14.8, -3, 1.3, 9.6, 0.05],
  ];
  stones.forEach(([x, z, r, h, lean], i) => {
    s.cyl(basalt, x, FLOOR - 0.2, z, r * 0.52, r, h, { seg: 5, facet: true, ry: i * 1.3, rz: lean, rx: lean * 0.7 });
    s.rock(basalt, x + r * 0.5, FLOOR + r * 0.3, z + r * 0.6, r * 0.55);
  });
  return s.geometry();
}

/** What glows on the stone: the seam and floor rings and the drum's runes (`fixed`), and the wheel of runes on the cap (`wheel`). */
function sculptInlays() {
  const ink = paint(0xffffff);
  const fixed = new Sculpt();
  fixed.torus(ink, 0, FLOOR + 0.31, 0, 2.17, 0.018, { sides: 4, seg: 48 });
  fixed.torus(ink, 0, FLOOR + 0.012, 0, 3.5, 0.02, { sides: 4, seg: 72, sy: 0.5 });
  fixed.torus(ink, 0, FLOOR + 0.012, 0, 4.9, 0.014, { sides: 4, seg: 96, sy: 0.5 });
  for (let i = 0; i < 24; i++) {
    const phi = (i / 24) * TAU;
    fixed.add(new THREE.BoxGeometry(0.03, 0.012, i % 2 ? 0.42 : 0.8), ink, Math.sin(phi) * 4.2, FLOOR + 0.012, Math.cos(phi) * 4.2, { ry: phi });
  }
  for (let i = 0; i < 6; i++) {
    const phi = (45 + i * 60) * DEG;
    fixed.group(Math.sin(phi) * 1.925, FLOOR + 0.62, Math.cos(phi) * 1.925, { ry: phi }, () => carve(fixed, ink, RUNES[i % RUNES.length], 0.34, 0.034, 0.03));
  }

  const wheel = new Sculpt();
  wheel.torus(ink, 0, 0.012, 0, 1.4, 0.014, { sides: 4, seg: 72, sy: 0.5 });
  wheel.torus(ink, 0, 0.012, 0, 1.08, 0.01, { sides: 4, seg: 64, sy: 0.5 });
  for (let i = 0; i < 12; i++) {
    const phi = (i / 12) * TAU;
    wheel.group(Math.sin(phi) * 1.24, 0.014, Math.cos(phi) * 1.24, { rx: -Math.PI / 2, ry: phi, order: 'YXZ' }, () => carve(wheel, ink, RUNES[(i * 3) % RUNES.length], 0.2, 0.024, 0.012));
  }
  return { fixed: fixed.geometry(), wheel: wheel.geometry() };
}

/* -------------------------------------------------------------------------- */
/* What rises through the air                                                 */
/* -------------------------------------------------------------------------- */

const DRIFT_VERTEX = /* glsl */ `
attribute vec4 aSeed;    // speed, phase (0..1), size, sway
uniform float uTime;
uniform float uHeight;
uniform float uFloor;
uniform float uPixels;
uniform float uFlicker;
varying float vFade;
varying float vHeat;
void main() {
  float y = mod(position.y + uTime * aSeed.x, uHeight);
  float k = y / uHeight;
  vec3 p = vec3(position.x, uFloor + y, position.z);
  p.x += sin(uTime * 0.7 + aSeed.y * 6.283 + y * 0.9) * aSeed.w;
  p.z += cos(uTime * 0.6 + aSeed.y * 4.1 + y * 0.7) * aSeed.w;
  float twinkle = 0.62 + 0.38 * sin(uTime * uFlicker * (0.6 + aSeed.y) + aSeed.y * 40.0);
  vFade = smoothstep(0.0, 0.1, k) * (1.0 - smoothstep(0.55, 1.0, k)) * twinkle;
  vHeat = 1.0 - k;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSeed.z * uPixels / -mv.z;
}
`;

const DRIFT_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uHot;
uniform vec3 uCool;
uniform float uOpacity;
varying float vFade;
varying float vHeat;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vFade * uOpacity;
  gl_FragColor = vec4(mix(uCool, uHot, vHeat * vHeat) * a, 1.0);
  #include <colorspace_fragment>
}
`;

const BUFFER = new THREE.Vector2();

/**
 * Points of light that climb from the floor, each on its own column: sparks or
 * embers. They move in the shader, so a frame costs nothing but the drawing.
 * `hot` and `cool` are [colour, brightness] at the floor and at the top of the climb.
 */
function createDrift(glowTexture, { count, reach, height, speed, size, sway, flicker, hot, cool }) {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * TAU;
    const radius = reach[0] + Math.sqrt(Math.random()) * (reach[1] - reach[0]);
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.random() * height;
    positions[i * 3 + 2] = Math.sin(angle) * radius;
    seeds[i * 4] = speed[0] + Math.random() * (speed[1] - speed[0]);
    seeds[i * 4 + 1] = Math.random();
    seeds[i * 4 + 2] = size[0] + Math.random() ** 2 * (size[1] - size[0]);
    seeds[i * 4 + 3] = sway * (0.4 + Math.random() * 0.6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const uniforms = {
    uMap: { value: glowTexture },
    uTime: { value: 0 },
    uHeight: { value: height },
    uFloor: { value: FLOOR },
    uPixels: { value: 400 },
    uFlicker: { value: flicker },
    uOpacity: { value: 0 },
    uHot: { value: new THREE.Color(hot[0]).multiplyScalar(hot[1]) },
    uCool: { value: new THREE.Color(cool[0]).multiplyScalar(cool[1]) },
  };
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({ uniforms, vertexShader: DRIFT_VERTEX, fragmentShader: DRIFT_FRAGMENT, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  points.frustumCulled = false;
  points.renderOrder = 3;
  // Point sizes are in pixels of whatever is being drawn into.
  points.onBeforeRender = (renderer, scene, camera) => {
    const target = renderer.getRenderTarget();
    const pixels = target ? target.height : renderer.getDrawingBufferSize(BUFFER).y;
    uniforms.uPixels.value = pixels * 0.5 * camera.projectionMatrix.elements[5];
  };
  return { points, uniforms };
}

/** Shards of crystal that climb slowly round the pedestal, turning as they go: the Radiant realm's. */
function createShards(count) {
  const geometry = new THREE.OctahedronGeometry(1).scale(0.42, 1.25, 0.42);
  const material = new THREE.MeshStandardMaterial({ color: 0x66c8ff, emissive: 0x2f9cff, emissiveIntensity: 1.5, metalness: 0.1, roughness: 0.2, flatShading: true });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  const shards = Array.from({ length: count }, () => ({
    angle: Math.random() * TAU,
    radius: 2.3 + Math.random() * 5.6,
    start: Math.random(),
    speed: 0.022 + Math.random() * 0.03,
    size: 0.07 + Math.random() ** 2 * 0.16,
    spin: (Math.random() - 0.5) * 1.6,
    tip: (Math.random() - 0.5) * 0.7,
  }));
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const HEIGHT = 7.5;
  return {
    mesh,
    /** `time` moves them; `shown` (0..1) is how much of the Radiant realm is in the hall. */
    update(time, shown) {
      mesh.visible = shown > 0.01;
      if (!mesh.visible) return;
      shards.forEach((shard, i) => {
        const k = (shard.start + time * shard.speed) % 1;
        const fade = smooth(Math.min(1, k / 0.12)) * (1 - smooth(Math.max(0, (k - 0.7) / 0.3)));
        const angle = shard.angle + time * 0.05;
        position.set(Math.cos(angle) * shard.radius, FLOOR + 0.4 + k * HEIGHT, Math.sin(angle) * shard.radius);
        euler.set(shard.tip, time * shard.spin, shard.tip * 0.6);
        matrix.compose(position, rotation.setFromEuler(euler), scale.setScalar(shard.size * fade * shown));
        mesh.setMatrixAt(i, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Sky                                                                        */
/* -------------------------------------------------------------------------- */

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform float uGlare;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.04, 0.5, dir.y));
  // A far light low behind the pedestal, for the champion to stand against.
  float behind = max(0.0, dot(normalize(vec3(dir.x, dir.y * 1.7 - 0.04, dir.z)), vec3(0.0, 0.0, -1.0)));
  col += uHaze * (pow(behind, 5.0) * 0.5 + pow(behind, 40.0) * 0.6) * uGlare;
  col *= 1.0 - smoothstep(0.0, -0.3, dir.y) * 0.8;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/* Stage                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Builds the stage on `canvas` and draws its first frame.
 *
 * @param options.spot         () => DOMRect of the box the champion should stand in, or null
 * @param options.dragSurface  the element over that box: dragging it turns the champion on the Heroes tab
 * @param options.hero, options.view   the champion and framing to open on
 * @param options.onQuality    (0.5..1) => void, when the picture is made coarser to keep the frame rate
 *
 * Resolves to the stage: `setHero(id, { flourish })`, `setView(name)`, `setEnergy(0..1)` (a search is
 * on: everything quickens), `flash()`, `setPaused(bool)`, `setBusy(bool)`, and for diagnostics
 * `lockQuality(bool)` and `stats()`. Rejects where WebGL 2 is not to be had.
 */
export async function createLobbyStage(canvas, { spot, dragSurface = null, hero: firstHero = CHAMPION_IDS[0], view: firstView = 'play', onQuality = () => {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x02040a, 1);
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(REALMS.radiant.fog, 12, 46);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 240);

  // As on the battlefield: the frame is drawn in linear HDR, bloomed, then converted for the screen.
  // A GPU without float render targets draws the scene directly instead.
  let composer = null;
  let bloom = null;
  if (renderer.extensions.has('EXT_color_buffer_float')) {
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.35, 0.9);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  /* ---------------------------------------------------------------- Light */

  const hemisphere = new THREE.HemisphereLight(REALMS.radiant.sky, REALMS.radiant.ground, LIGHT.sky);
  // The key light stands in front and above; it is the one that casts the champion's shadow on the stone.
  const key = new THREE.DirectionalLight(REALMS.radiant.key, LIGHT.key);
  key.position.set(-4.5, 8, 7.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -3.4, right: 3.4, top: 4.6, bottom: -2.2, near: 1, far: 26 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.03;
  // Two lights from behind draw the champion's edge in the colours of its realm.
  const rim = new THREE.DirectionalLight(REALMS.radiant.rim, LIGHT.rim);
  rim.position.set(5.5, 4.5, -8);
  const edge = new THREE.DirectionalLight(REALMS.radiant.edge, LIGHT.edge);
  edge.position.set(-7, 2.5, -5.5);
  // And the runes under its feet light it from below.
  const underglow = new THREE.PointLight(REALMS.radiant.glow, LIGHT.underglow, 9, 1.6);
  underglow.position.set(0, 0.35, 0.6);
  scene.add(hemisphere, key, key.target, rim, edge, underglow);

  const envMap = studioEnvironment(renderer);
  // The falloff the battlefield's glows use: soft in linear light, with the bloom supplying the outer haze.
  const glowTexture = canvasTexture(128, 128, (g, w) => {
    const gradient = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.18, 'rgba(255, 255, 255, 0.46)');
    gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.16)');
    gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.04)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = gradient;
    g.fillRect(0, 0, w, w);
  });

  /* ---------------------------------------------------------------- Scenery */

  const skyUniforms = { uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uHaze: { value: new THREE.Color() }, uGlare: { value: 1 } };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(120, 32, 20),
    new THREE.ShaderMaterial({ uniforms: skyUniforms, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, side: THREE.BackSide, depthWrite: false, fog: false }),
  );
  sky.renderOrder = -1;
  scene.add(sky);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(70, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0b0e16, roughness: 0.5, metalness: 0.35 }));
  floor.position.y = FLOOR;
  floor.receiveShadow = true;
  scene.add(floor);
  await pause();

  const stone = surfaceMaterial({ envMap, envIntensity: 0.45, rim: REALMS.radiant.stone, rimStrength: 0.5 });
  const hall = new THREE.Mesh(sculptHall(), stone);
  hall.castShadow = true;
  hall.receiveShadow = true;
  scene.add(hall);

  const inlays = sculptInlays();
  const runeLight = new THREE.MeshBasicMaterial({ color: REALMS.radiant.glow });
  const runes = new THREE.Mesh(inlays.fixed, runeLight);
  const wheel = new THREE.Mesh(inlays.wheel, runeLight);
  // Light pooled on the cap, under the champion's feet.
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(1.75, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: glowTexture, color: REALMS.radiant.glow, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  pool.position.y = 0.02;
  pool.renderOrder = 1;
  scene.add(runes, wheel, pool);
  await pause();

  const sparks = createDrift(glowTexture, { count: 150, reach: [0.6, 9.5], height: 8.5, speed: [0.16, 0.5], size: [0.05, 0.19], sway: 0.16, flicker: 2.2, hot: [0xeaffff, 2.2], cool: [0x2f8cff, 1.3] });
  const embers = createDrift(glowTexture, { count: 240, reach: [0.4, 8.5], height: 6.5, speed: [0.55, 1.7], size: [0.04, 0.15], sway: 0.34, flicker: 9, hot: [0xffe6a8, 2.6], cool: [0xff3a10, 1.2] });
  const shards = createShards(18);
  scene.add(sparks.points, embers.points, shards.mesh);

  /* ---------------------------------------------------------------- Champions */

  /** Built as they are first needed: { hero, realm, light }. */
  const champions = new Map();
  function summon(id) {
    if (champions.has(id)) return champions.get(id);
    const realm = CHAMPIONS[id].faction;
    const hero = buildHero(realm, { envMap, glowTexture, champions: [id] });
    hero.body.position.set(0, 0.03, 0);
    // The weapon lights the armour beside it: it is held before the right shoulder.
    const light = new THREE.PointLight(REALMS[realm].glow, 0, 3.4, 1.8);
    light.position.set(-0.42, 1.5, 0.45);
    hero.body.add(light);
    scene.add(hero.group, hero.effects);
    const made = { id, hero, realm, light };
    champions.set(id, made);
    return made;
  }

  /* ---------------------------------------------------------------- State */

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mixed = Object.fromEntries(Object.keys(REALMS.radiant).map((name) => [name, new THREE.Color()]));
  const radiant = Object.fromEntries(Object.entries(REALMS.radiant).map(([name, hex]) => [name, new THREE.Color(hex)]));
  const dire = Object.fromEntries(Object.entries(REALMS.dire).map(([name, hex]) => [name, new THREE.Color(hex)]));
  const pose = { strike: 0, moving: 0, gait: 0, phase: 0.6, facing: 0, wind: 0 };

  let current = null;
  /** How Dire the hall is: 0 for a Radiant champion, 1 for a Dire one, and between as it crosses. */
  let realm = 0;
  let viewName = VIEWS[firstView] ? firstView : 'play';
  let yaw = VIEWS[viewName].yaw;
  /** The champion's turning speed after a drag, in radians a second. */
  let spin = 0;
  let drag = null;
  /** 1 as a flourish begins, 0 once it is over. */
  let swing = 0;
  let flourishDue = -1;
  /** A champion steps onto the pedestal: 0 as it arrives, 1 once it stands. */
  let arrival = 1;
  /** The afterimage of the champion that stepped down. */
  let ghost = null;
  let energy = 0;
  let energyGoal = 0;
  let flare = 0;
  let time = 0;
  let climb = 0;
  let width = 1;
  let height = 1;
  /** Where the camera is, and where it is going: the distance, the point on screen the champion's middle falls on, and the angles. */
  const lens = { distance: 12, x: 0, y: 0, middle: 1.2, turn: 0, tilt: 0 };
  const goal = { ...lens };
  let framed = false;

  let paused = false;
  let frameId = 0;
  let last = 0;
  let frames = 0;
  let fps = 60;
  /** Something changed that a still stage (reduced motion) must be redrawn for. */
  let stale = true;
  /** Render-resolution multiplier: it steps down, and the bloom goes, if frames run long. */
  let quality = 1;
  let qualityLocked = false;
  let sampleFrames = -20;
  let sampleTime = 0;
  /** Something else has the machine (the battlefield being built behind a search): slow frames say nothing about this scene. */
  let busy = false;

  /* ---------------------------------------------------------------- Picture */

  function applyResolution() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2) * quality;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    if (composer) {
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
      bloom.enabled = quality > 0.7;
    }
  }

  function resize() {
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    applyResolution();
    stale = true;
  }

  /** Works out the framing the current tab asks for. Returns false while its hero spot is not laid out. */
  function aim() {
    const box = spot?.();
    if (!box || box.height < 8 || box.width < 8) return false;
    const view = VIEWS[viewName];
    goal.distance = Math.min(60, Math.max(4, (height * (view.high - view.low)) / (2 * TAN_HALF_FOV * box.height)));
    goal.x = box.left + box.width / 2;
    goal.y = box.top + box.height / 2;
    goal.middle = (view.low + view.high) / 2;
    goal.turn = view.turn;
    goal.tilt = view.tilt;
    return true;
  }

  function placeCamera(drift) {
    const turn = lens.turn + Math.sin(drift * 0.21) * 0.035;
    const tilt = lens.tilt + Math.sin(drift * 0.17 + 1) * 0.012;
    const level = Math.cos(tilt) * lens.distance;
    camera.position.set(Math.sin(turn) * level, lens.middle + Math.sin(tilt) * lens.distance, Math.cos(turn) * level);
    camera.lookAt(0, lens.middle, 0);
    // The champion's middle falls on the middle of its spot, wherever on the screen that is.
    camera.setViewOffset(width, height, width / 2 - lens.x, height / 2 - lens.y, width, height);
    scene.fog.near = lens.distance + 2;
    scene.fog.far = lens.distance + 38;
  }

  /** Where a flourish is at `t` (0..1): +1 with the weapon raised, through -1 as the cut lands, and back to 0. */
  function strikeAt(t) {
    const { windup, impact } = FLOURISH;
    if (t < windup) return smooth(t / windup);
    if (t < impact) return 1 - 2 * (1 - (1 - (t - windup) / (impact - windup)) ** 3);
    const k = (t - impact) / (1 - impact);
    return -1 + smooth(k);
  }

  function colour() {
    for (const name in mixed) mixed[name].lerpColors(radiant[name], dire[name], realm);
    const lift = 1 + flare * 1.6 + energy * 0.35;
    // Fire is never steady: under a Dire champion the light from the runes gutters.
    const gutter = 1 + realm * 0.16 * Math.sin(time * 11.3) * Math.sin(time * 7.1);
    skyUniforms.uZenith.value.copy(mixed.zenith);
    skyUniforms.uHorizon.value.copy(mixed.horizon);
    skyUniforms.uHaze.value.copy(mixed.haze);
    skyUniforms.uGlare.value = 1 + flare * 0.9 + energy * 0.25;
    scene.fog.color.copy(mixed.fog);
    hemisphere.color.copy(mixed.sky);
    hemisphere.groundColor.copy(mixed.ground);
    key.color.copy(mixed.key);
    rim.color.copy(mixed.rim);
    edge.color.copy(mixed.edge);
    underglow.color.copy(mixed.glow);
    underglow.intensity = LIGHT.underglow * lift * gutter;
    stone.userData.uniforms.uRim.value.copy(mixed.stone).multiplyScalar(0.5);
    runeLight.color.copy(mixed.glow).multiplyScalar((LIGHT.runes + 0.2 * Math.sin(time * 1.3)) * lift * gutter);
    pool.material.color.copy(mixed.glow);
    pool.material.opacity = Math.min(1, LIGHT.pool * lift * gutter);
    sparks.uniforms.uOpacity.value = 1 - realm;
    embers.uniforms.uOpacity.value = realm;
    if (bloom) bloom.strength = 0.5 + flare * 0.5;
  }

  function update(dt) {
    const still = reducedMotion.matches;
    const ambient = still ? 0 : dt;
    const ease = (rate) => (still ? 1 : 1 - Math.exp(-dt * rate));
    time += ambient;

    energy += (energyGoal - energy) * ease(3);
    flare = still ? 0 : Math.max(0, flare - dt * 1.4);
    climb += ambient * (1 + energy * 2.4);
    const target = current.realm === 'dire' ? 1 : 0;
    realm += (target - realm) * ease(2.2);
    if (Math.abs(target - realm) < 0.002) realm = target;

    // The camera eases to the framing its tab asks for; the first one is simply taken.
    if (aim()) {
      const k = framed ? ease(4.2) : 1;
      for (const name in lens) lens[name] += (goal[name] - lens[name]) * k;
      framed = true;
    }
    placeCamera(time);

    // On the Heroes tab the champion is left as it was turned; elsewhere it turns back to face its tab.
    if (viewName === 'heroes') {
      if (!drag) {
        yaw += spin * dt;
        spin *= Math.exp(-dt * 2.6);
        if (still || Math.abs(spin) < 0.01) spin = 0;
      }
    } else {
      spin = 0;
      const away = ((((VIEWS[viewName].yaw - yaw) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
      yaw += away * ease(3.4);
    }

    if (flourishDue >= 0) {
      flourishDue -= dt;
      if (flourishDue < 0 && !still) swing = 1;
    }
    swing = Math.max(0, swing - dt / FLOURISH.seconds);
    arrival = Math.min(1, arrival + (still ? 1 : dt / 0.4));
    const stand = 1 - (1 - arrival) ** 3;

    const { hero, light } = current;
    pose.strike = swing > 0 ? strikeAt(1 - swing) : 0;
    pose.facing = yaw;
    pose.wind = still ? 0 : 0.09 + 0.05 * Math.sin(time * 0.6) + energy * 0.12;
    hero.group.position.y = (stand - 1) * 0.22;
    hero.body.rotation.set(0, yaw, 0, 'YXZ');
    hero.body.scale.setScalar(hero.size * (0.93 + 0.07 * stand));
    hero.ring.rotation.y = time * 0.9;
    hero.pose(pose, time, ambient);
    light.intensity = (LIGHT.weapon + 0.2 * Math.sin(time * 2.3) + Math.abs(pose.strike) * 1.8) * stand;
    // Whoever stepped down sheds the last of its light.
    for (const other of champions.values()) if (other !== current) other.hero.rest(dt);

    if (ghost) {
      ghost.age += still ? 1 : dt / 0.5;
      if (ghost.age >= 1) {
        scene.remove(ghost.copy.object);
        ghost.copy.dispose();
        ghost = null;
      } else {
        ghost.copy.fade(0.55 * (1 - ghost.age) ** 2);
        ghost.copy.object.scale.setScalar(ghost.size * (1 + ghost.age * 0.06));
        ghost.copy.object.position.y = 0.03 + ghost.age * 0.18;
      }
    }

    wheel.rotation.y += ambient * (0.14 + energy * 1.1);
    sparks.uniforms.uTime.value = climb;
    embers.uniforms.uTime.value = climb;
    shards.update(climb, 1 - realm);
    colour();
  }

  const draw = () => (composer ? composer.render() : renderer.render(scene, camera));

  function frame(now) {
    frameId = requestAnimationFrame(frame);
    const dt = Math.min(Math.max(0, (now - last) / 1000), 0.1);
    last = now;
    // Asked for no motion, the stage is a picture: it is drawn again only when something about it changes.
    if (reducedMotion.matches && !stale && !drag && spin === 0) return;
    stale = false;
    if (dt > 0) fps += (1 / dt - fps) * 0.08;
    update(dt);
    draw();
    frames++;

    // Once a spell of frames averages under 38 a second, draw fewer pixels. The first frames do not count,
    // and nor do any drawn while the page is busy with something else.
    if (!busy && ++sampleFrames > 0) {
      sampleTime += dt;
      if (sampleFrames >= 50) {
        if (sampleTime / sampleFrames > 1 / 38 && quality > 0.5 && !qualityLocked) {
          quality = Math.max(0.5, quality - 0.17);
          applyResolution();
          onQuality(quality);
        }
        sampleFrames = 0;
        sampleTime = 0;
      }
    }
  }

  /* ---------------------------------------------------------------- Turning the champion */

  if (dragSurface) {
    const release = () => {
      if (!drag) return;
      // A hand that had stopped before letting go leaves the champion where it is.
      if (performance.now() - drag.at > 90) spin = 0;
      drag = null;
      dragSurface.classList.remove('is-turning');
    };
    dragSurface.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || viewName !== 'heroes' || paused) return;
      dragSurface.setPointerCapture(event.pointerId);
      // Dragging across the whole surface turns the champion most of the way round.
      drag = { id: event.pointerId, x: event.clientX, at: performance.now(), perPixel: (Math.PI * 1.6) / Math.max(240, dragSurface.clientWidth) };
      spin = 0;
      dragSurface.classList.add('is-turning');
    });
    dragSurface.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const now = performance.now();
      const turned = (event.clientX - drag.x) * drag.perPixel;
      const seconds = Math.max(0.004, (now - drag.at) / 1000);
      yaw += turned;
      spin = Math.max(-9, Math.min(9, spin * 0.5 + (turned / seconds) * 0.5));
      drag.x = event.clientX;
      drag.at = now;
      stale = true;
    });
    dragSurface.addEventListener('pointerup', release);
    dragSurface.addEventListener('pointercancel', release);
    // The arrow keys turn it too.
    dragSurface.addEventListener('keydown', (event) => {
      const push = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (!push || viewName !== 'heroes') return;
      event.preventDefault();
      if (reducedMotion.matches) yaw += push * 0.35;
      else spin = Math.max(-9, Math.min(9, spin + push * 2.6));
      stale = true;
    });
  }

  /* ---------------------------------------------------------------- Opening */

  window.addEventListener('resize', resize);
  // In a window small enough for the lobby to scroll, the champion's spot moves with the page.
  window.addEventListener(
    'scroll',
    () => {
      stale = true;
    },
    { passive: true },
  );
  reducedMotion.addEventListener?.('change', () => {
    stale = true;
  });
  resize();
  await pause();
  current = summon(CHAMPIONS[firstHero] ? firstHero : CHAMPION_IDS[0]);
  current.hero.group.visible = true;
  realm = current.realm === 'dire' ? 1 : 0;
  await pause();
  // Compiled before the first frame, so the stage does not stall as it appears.
  update(0);
  try {
    await renderer.compileAsync(scene, camera);
  } catch {
    // The first frame compiles whatever this could not.
  }
  update(0);
  draw();
  frames++;
  last = performance.now();
  frameId = requestAnimationFrame(frame);
  // The other champions are built once the stage is up, a moment apart, so that a first switch does not wait on one.
  CHAMPION_IDS.filter((id) => id !== current.id).forEach((id, i) => setTimeout(() => summon(id), 900 + i * 500));

  return {
    /** Puts `id` on the pedestal. With `flourish` it salutes with its weapon, whether or not it was already there. */
    setHero(id, { flourish = false } = {}) {
      if (!CHAMPIONS[id]) return;
      stale = true;
      if (id !== current.id) {
        const leaving = current;
        // The one stepping down leaves an afterimage that rises and fades.
        if (!reducedMotion.matches && !paused) {
          if (ghost) {
            scene.remove(ghost.copy.object);
            ghost.copy.dispose();
          }
          const copy = leaving.hero.ghost(new THREE.Color().copy(leaving.realm === 'dire' ? dire.glow : radiant.glow));
          copy.object.position.set(0, 0.03, 0);
          scene.add(copy.object);
          ghost = { copy, age: 0, size: leaving.hero.size };
        }
        leaving.hero.group.visible = false;
        current = summon(id);
        current.hero.group.visible = true;
        arrival = 0;
        swing = 0;
        flare = Math.max(flare, 0.55);
      }
      flourishDue = flourish ? (arrival < 1 ? 0.16 : 0) : -1;
    },

    /** Frames the champion as `name` asks: 'play', 'heroes', 'deck' or 'codex'. */
    setView(name) {
      if (!VIEWS[name] || name === viewName) return;
      viewName = name;
      stale = true;
    },

    /** 0 in the quiet lobby, 1 while a search is on: the runes turn faster and the air quickens. */
    setEnergy(value) {
      energyGoal = Math.min(1, Math.max(0, value));
      stale = true;
    },

    /** A burst of light from the runes: a champion equipped, an opponent found. */
    flash() {
      flare = 1;
      stale = true;
    },

    /** Stops drawing altogether, or starts again from where it stopped. */
    setPaused(value) {
      if (paused === Boolean(value)) return;
      paused = Boolean(value);
      cancelAnimationFrame(frameId);
      frameId = 0;
      if (paused) {
        drag = null;
        dragSurface?.classList.remove('is-turning');
        return;
      }
      last = performance.now();
      stale = true;
      sampleFrames = -20;
      sampleTime = 0;
      frameId = requestAnimationFrame(frame);
    },

    /** While `value` holds the frame rate is not judged: the page is busy building something else. */
    setBusy(value) {
      if (busy === Boolean(value)) return;
      busy = Boolean(value);
      sampleFrames = -20;
      sampleTime = 0;
    },

    /** Keeps full quality whatever the frame rate, for the console and for tests. */
    lockQuality(locked) {
      qualityLocked = locked;
      if (locked && quality !== 1) {
        quality = 1;
        applyResolution();
        onQuality(quality);
      }
    },

    /** Counters for the console and for tests. */
    stats: () => ({
      frames,
      fps: Math.round(fps),
      quality,
      paused,
      hero: current.id,
      view: viewName,
      realm: Number(realm.toFixed(3)),
      yaw: Number(yaw.toFixed(3)),
      spin: Number(spin.toFixed(3)),
      flourishing: swing > 0 || flourishDue >= 0,
      built: [...champions.keys()],
      distance: Number(lens.distance.toFixed(2)),
      centre: [Math.round(lens.x), Math.round(lens.y)],
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    }),
  };
}
