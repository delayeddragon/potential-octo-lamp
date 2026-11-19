/**
 * RuneDeck — battlefield renderer (Three.js).
 *
 * A MOBA camera, pitched 42 degrees and turned a little off the lanes, hangs
 * close over a battlefield twice the size of the screen: Radiant on the left,
 * Dire on the right, the River in its canyon between them. The frame is
 * rendered in HDR and bloomed, so lava, crystals and spell effects glow; every
 * unit and prop casts a real shadow, from a shadow map that follows the view.
 *
 * Built for a steady 60 FPS:
 *  - the terrain is one grid mesh whose surface is painted by a procedural
 *    shader and baked to a texture once (terrain.js);
 *  - static props are merged into three meshes: lit, glowing and wind-swayed (scenery.js);
 *  - render resolution steps down, and bloom switches off, on a GPU that cannot keep up.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { FOV, PITCH, YAW, createCameraRig } from './camera.js';
import { buildDragon } from './dragon.js';
import { buildHero } from './heroes.js';
import { Batch, LIGHT_DIR, TAU, canvasTexture, pen, seededRandom } from './geometry.js';
import { buildLavaFalls, buildParticles, buildScenery } from './scenery.js';
import { CARDS, CHAMPIONS, FLAG, LEVEL, MAP, RUNES, SIDES, STRUCTURES, UNIT_TYPES, groundHeight, heroSpawn } from './shared.js';
import { studioEnvironment } from './sculpt.js';
import { buildStructure } from './structures.js';
import { LAVA_FALLS, createTerrain } from './terrain.js';
import { createUnitLayer } from './units.js';

const SIN_P = Math.sin(PITCH);
const COS_P = Math.cos(PITCH);
/** Unit vector from any point towards the camera. Glows are nudged along it so they bloom over their source. */
const TO_CAMERA = new THREE.Vector3(Math.sin(YAW) * COS_P, SIN_P, Math.cos(YAW) * COS_P);
const VOID_COLOR = 0x05070f;
/** Distance haze: where it starts and where it is complete, as depth from the camera. */
const HAZE_COLOR = 0x0b1226;
const FOG = { near: 46, far: 150 };
/** Half-width of the square of ground the shadow map covers, centred on the view. */
const SHADOW_REACH = 36;
const SHADOW_MAP = 2048;
/** Heights between which the ground can lie, for finding the point under the cursor. */
const PICK_TOP = 9.5;
const PICK_BOTTOM = LEVEL.bed - 0.2;
const TEAM_COLOR = { radiant: 0x4fc3ff, dire: 0xff5a36 };
const RUNE_COLOR = { damage: 0xffa41a, haste: 0x5dffb0, regen: 0xb48cff };
const GOLD = 0xffd766;
const LIFESTEAL_COLOR = 0xff2a4a;
/**
 * Ability colours by champion, whichever side he fights on. The Aether Knight's
 * are gold and cyan; Morgath's are ember and violet, so a glance tells whose spells they are.
 */
const SPELL = {
  aether_knight: { slash: 0xffd766, shield: 0xffcf5a, bolt: 0x5ff0ff, boltCore: 0xeaffff, pillar: 0xffd766, pillarCore: 0xfff3c4, blink: 0x4aa8ff, blinkCore: 0xd6ebff },
  morgath: { slash: 0xff8a3a, shield: 0xff7a2e, bolt: 0xc77dff, boltCore: 0xf3e2ff, pillar: 0xff5a2a, pillarCore: 0xffd2a0, blink: 0xb04aff, blinkCore: 0xecd6ff },
};
/** How far glowing materials are pushed past white, so the bloom pass picks them up. */
const GLOW_BOOST = 1.3;

/** The colours of the Lightning Bolt card: a clear sky's white-blue, neither champion's own. */
const BOLT_CARD = { bolt: 0x9fe8ff, boltCore: 0xffffff };
/** How long the camera takes to reach a fallen structure at the end of a match, and how close it draws in (a share of its normal distance). */
const FINALE_PAN = 2.5;
const FINALE_ZOOM = { throne: 0.55, tower: 0.7 };
/** How far each blast of the finale throws the camera, in world units: the tremor before a Throne goes, its three blasts, and a Tower's fall. */
const FINALE_JOLT = { rumble: 0.1, throne: [0.55, 0.4, 0.5], tower: 0.28 };

const easeOut = (k) => 1 - (1 - k) ** 3;

/**
 * Hands the main thread back to the browser so it can paint. A background tab
 * gets no animation frames, so a timer stands in for one there.
 */
export const breathe = () =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 60);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      // One more turn of the event loop, so the frame is on screen before work resumes.
      setTimeout(resolve, 0);
    });
  });

const R = MAP.river;
const A = new THREE.Vector3();
const EDGE = new THREE.Vector3();

/** A ring laid over the terrain, so it neither floats above a hollow nor sinks into a rise. */
function drapedRing(cx, cz, inner, outer, segments = 128) {
  const positions = [];
  const index = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * TAU;
    for (const radius of [inner, outer]) {
      const x = cx + Math.cos(angle) * radius;
      const z = cz + Math.sin(angle) * radius;
      positions.push(x, groundHeight(x, z) + 0.07, z);
    }
    if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2 + 1, i * 2 - 2, i * 2 + 1, i * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

function rubble(p, def) {
  const dire = def.side === 'dire';
  const random = seededRandom(def.x * 31 + def.z * 17 + 5);
  const count = def.kind === 'throne' ? 16 : 9;
  for (let i = 0; i < count; i++) {
    const a = random() * TAU;
    const d = random() * def.radius * 0.9;
    const r = 0.3 + random() * 0.45;
    p.rock(dire ? 0x15121a : 0x6f7a8f, Math.cos(a) * d, r * 0.4, Math.sin(a) * d, r, {
      top: dire ? 0x4f4160 : 0xc5cfdf,
      sy: 0.65,
      ry: random() * TAU,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Battlefield                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Builds the whole battlefield, compiles its shaders and rehearses a battle, so
 * that nothing is left to prepare once the match is on screen. The work is done
 * in stages; `report(fraction, label)` is called as each begins, and the page
 * gets a chance to paint between them.
 */
export async function createBattlefield(canvas, report = () => {}) {
  const stage = (fraction, label) => {
    report(fraction, label);
    return breathe();
  };
  await stage(0, 'Raising the terrain');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(VOID_COLOR, 1);
  // Units and heroes move, so the shadow map is redrawn every frame.
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  // Atmosphere: the far side of the view sinks into a blue dusk.
  scene.fog = new THREE.Fog(HAZE_COLOR, FOG.near, FOG.far);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 2, 400);
  const rig = createCameraRig(camera);

  // The frame is drawn in linear HDR, bloomed, then converted for the screen.
  // A GPU without float render targets draws the scene directly instead.
  let composer = null;
  let bloomPass = null;
  if (renderer.extensions.has('EXT_color_buffer_float')) {
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.3, 0.9);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }
  const render = () => (composer ? composer.render() : renderer.render(scene, camera));

  scene.add(new THREE.HemisphereLight(0xdbeaff, 0x2a2233, 1.0));
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.9);
  sun.position.copy(LIGHT_DIR).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  Object.assign(sun.shadow.camera, { left: -SHADOW_REACH, right: SHADOW_REACH, top: SHADOW_REACH, bottom: -SHADOW_REACH, near: 1, far: 190 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // The shadow map covers only the ground in view and follows the camera. It moves in
  // whole texels of its own grid, so shadows do not shimmer as the view pans.
  const SHADOW_TEXEL = (SHADOW_REACH * 2) / SHADOW_MAP;
  const SUN_RIGHT = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), LIGHT_DIR).normalize();
  const SUN_UP = new THREE.Vector3().crossVectors(LIGHT_DIR, SUN_RIGHT);
  function aimSun(x, z) {
    A.set(x, 0, z);
    const across = A.dot(SUN_RIGHT);
    const along = A.dot(SUN_UP);
    A.addScaledVector(SUN_RIGHT, Math.round(across / SHADOW_TEXEL) * SHADOW_TEXEL - across);
    A.addScaledVector(SUN_UP, Math.round(along / SHADOW_TEXEL) * SHADOW_TEXEL - along);
    sun.target.position.copy(A);
    sun.position.copy(A).addScaledVector(LIGHT_DIR, 90);
    sun.target.updateMatrixWorld();
  }

  const solidMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.04 });
  const glowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  glowMaterial.color.setScalar(GLOW_BOOST);
  // What the sculpted models' armour and crystal reflect. Only they use it: the terrain keeps its painted light.
  const envMap = studioEnvironment(renderer);

  // Glows are added in linear light, where a soft falloff spreads far wider than it does on screen.
  // These ramps are the on-screen ones raised to the display gamma; the bloom pass supplies the outer haze.
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
  const beamTexture = canvasTexture(64, 256, (g, w, h) => {
    const rise = g.createLinearGradient(0, h, 0, 0);
    rise.addColorStop(0, 'rgba(255, 255, 255, 1)');
    rise.addColorStop(0.35, 'rgba(255, 255, 255, 0.3)');
    rise.addColorStop(0.7, 'rgba(255, 255, 255, 0.06)');
    rise.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = rise;
    g.fillRect(0, 0, w, h);
    const across = g.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, 'rgba(255, 255, 255, 0)');
    across.addColorStop(0.25, 'rgba(255, 255, 255, 0.2)');
    across.addColorStop(0.5, 'rgba(255, 255, 255, 1)');
    across.addColorStop(0.75, 'rgba(255, 255, 255, 0.2)');
    across.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = across;
    g.fillRect(0, 0, w, h);
  });

  /* ---------------------------------------------------------------- Terrain */

  const terrain = createTerrain(renderer, { voidColor: VOID_COLOR, hazeColor: HAZE_COLOR, fog: FOG });
  scene.add(...terrain.meshes);

  /* ---------------------------------------------------------------- Halos */

  const halos = [];
  function addHalo(x, y, z, size, color, opacity = 0.6) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    // Nudged towards the camera so the glow blooms over its source.
    sprite.position.set(x + TO_CAMERA.x * 0.7, y + TO_CAMERA.y * 0.7, z + TO_CAMERA.z * 0.7);
    sprite.scale.setScalar(size);
    scene.add(sprite);
    halos.push({ sprite, size, opacity, phase: halos.length * 1.7 });
    return sprite;
  }

  /* ---------------------------------------------------------------- Torches */

  // A flame is a hot core inside a coloured tongue, over a pool of its own light; each gutters on its own.
  const torches = [];
  function addTorch(x, y, z, color, size = 1) {
    const sprite = (tint, opacity) =>
      new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: tint, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    const flame = sprite(color, 0.95);
    const core = sprite(0xfff3c4, 0.9);
    const light = sprite(color, 0.45);
    flame.center.set(0.5, 0.32);
    flame.position.set(x, y, z);
    core.position.set(x + TO_CAMERA.x * 0.2, y + TO_CAMERA.y * 0.2, z + TO_CAMERA.z * 0.2);
    light.position.set(x + TO_CAMERA.x * 0.5, y + TO_CAMERA.y * 0.5, z + TO_CAMERA.z * 0.5);
    scene.add(light, flame, core);
    torches.push({ flame, core, light, y, size, phase: torches.length * 2.31 });
  }

  /* ---------------------------------------------------------------- Scenery */

  await stage(0.22, 'Growing forests and caverns');
  // Trees share the lit material, plus a wind that bends each one from the ground up.
  const wind = { value: 0 };
  const sway = (shader) => {
    shader.uniforms.uWind = wind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float gust = sin(uWind * 1.6 + position.x * 0.35 + position.z * 0.28) + 0.5 * sin(uWind * 2.9 + position.x * 0.8 - position.z * 0.6);
        transformed.x += gust * aSway * 0.05;
        transformed.z += cos(uWind * 1.3 + position.z * 0.4 + position.x * 0.2) * aSway * 0.028;`,
      );
  };
  const foliageMaterial = solidMaterial.clone();
  foliageMaterial.onBeforeCompile = sway;
  // The same wind in the shadow pass, so each tree's shadow sways with it.
  const foliageDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  foliageDepth.onBeforeCompile = sway;

  await stage(0.4, 'Waking the Guardian');
  const dragon = buildDragon({ envMap, glowTexture, addHalo });
  const lavaFalls = buildLavaFalls({ addHalo });
  scene.add(dragon.group, ...lavaFalls.meshes);
  {
    const solid = new Batch();
    const glow = new Batch();
    const foliage = new Batch();
    const { rocks } = buildScenery({ solid, glow, foliage, addHalo, addTorch });
    terrain.setRocks(rocks);
    const props = solid.build(solidMaterial);
    const trees = foliage.build(foliageMaterial);
    trees.customDepthMaterial = foliageDepth;
    for (const mesh of [props, trees]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // One mesh spans the whole map, so it is always partly in view.
      mesh.frustumCulled = false;
    }
    const lights = glow.build(glowMaterial);
    lights.frustumCulled = false;
    scene.add(props, trees, lights);
  }

  /* ---------------------------------------------------------------- Structures */

  await stage(0.48, 'Raising towers and thrones');
  const structures = new Map();
  for (const def of STRUCTURES) {
    const radiant = def.side === 'radiant';
    const throne = def.kind === 'throne';
    // A sculpted spire (structures.js): arches round a core, rune rings turning about the shaft, and an orb over the summit.
    const model = buildStructure(def, { envMap });
    // Thrones stand on their base plateau and towers on the terrace below it.
    const base = groundHeight(def.x, def.z);
    const group = new THREE.Group();
    group.position.set(def.x, base, def.z);
    group.add(model.group);

    const rubbleBatch = new Batch();
    rubble(pen(rubbleBatch, rubbleBatch), def);
    const ruins = rubbleBatch.build(solidMaterial);
    ruins.position.set(def.x, base, def.z);
    ruins.castShadow = true;
    ruins.receiveShadow = true;
    ruins.visible = false;
    scene.add(group, ruins);

    // A faint circle, draped over the ground, shows how far the structure can fire.
    const range = new THREE.Mesh(
      drapedRing(def.x, def.z, def.range - 0.09, def.range),
      new THREE.MeshBasicMaterial({ color: TEAM_COLOR[def.side], transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }),
    );
    scene.add(range);

    const halo = addHalo(def.x, base + def.muzzle, def.z, throne ? 7.5 : 4.2, radiant ? 0x2f9cff : 0xff5a1a, radiant ? 0.16 : 0.28);
    // `fire` jumps to 1 as the structure shoots and runs down, which the orb answers with a recoil and a pulse of light.
    structures.set(def.id, { def, base, group, model, ruins, halo, range, atk: -1, fire: 0, shake: 0, collapse: -1, fall: 0.9 });
  }

  /* ---------------------------------------------------------------- Heroes and rune */

  await stage(0.58, 'Forging the heroes');
  const heroes = {};
  for (const side of ['radiant', 'dire']) {
    const hero = buildHero(side, { envMap, glowTexture });
    const spawn = heroSpawn(side);
    hero.group.position.set(spawn.x, groundHeight(spawn.x, spawn.z), spawn.z);
    // The effects (sparks off the blade) live in world space, so they trail behind a moving hero.
    scene.add(hero.group, hero.effects);
    heroes[side] = hero;
  }
  /** The spell colours of whichever champion a side is playing. */
  const spellOf = (side) => SPELL[heroes[side].champion];

  const runeRing = new THREE.Mesh(
    new THREE.RingGeometry(3.2, 3.34, 4).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7af3ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  runeRing.position.y = LEVEL.pad + 0.5;
  scene.add(runeRing);
  const padHalo = addHalo(0, LEVEL.pad + 0.6, 0, 10, 0x4fe6ff, 0.45);

  // One floating gem per rune kind; only the kind waiting on the pad is shown.
  const runeGems = {};
  for (const [kind, low, high] of [['damage', 0xffa41a, 0xfff6c8], ['haste', 0x2fe08a, 0xe6fff2], ['regen', 0x8a5cff, 0xf0e6ff]]) {
    const batch = new Batch();
    pen(batch, batch).gem(low, 0, -0.55, 0, 0.42, 1.1, { glow: true, top: high });
    runeGems[kind] = batch.build(glowMaterial);
    scene.add(runeGems[kind]);
  }
  const runeBeam = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: beamTexture, color: RUNE_COLOR.damage, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  runeBeam.center.set(0.5, 0);
  runeBeam.scale.set(1.5, 6, 1);
  runeBeam.position.set(0, LEVEL.pad + 0.3, 0);
  const runeHalo = addHalo(0, LEVEL.pad + 1.6, 0, 4.2, RUNE_COLOR.damage, 0.7);
  scene.add(runeBeam);

  // Where the hero has been told to walk: a green ring that stays until it arrives.
  const waypoint = new THREE.Group();
  {
    const green = { color: 0x6dffa8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide };
    waypoint.add(
      new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ ...green, opacity: 0.9 })),
      new THREE.Mesh(new THREE.RingGeometry(0.78, 0.84, 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ ...green, opacity: 0.55 })),
      new THREE.Mesh(new THREE.CircleGeometry(0.14, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ ...green, opacity: 0.9 })),
    );
    waypoint.visible = false;
    waypoint.renderOrder = 4;
    scene.add(waypoint);
  }

  const particles = buildParticles([
    // Embers thrown up where each lava fall lands, and motes over the crystal hoard. (The dragon breathes its own smoke.)
    ...LAVA_FALLS.map((fall) => {
      const x = fall.x + fall.dx * fall.length;
      const z = fall.z + fall.dz * fall.length;
      return { x, y: groundHeight(x, z) + 0.2, z, spread: 2.4, rise: 3.5, color: [0xff5a1a, 0xffd27a], count: 16, size: 0.14 };
    }),
    { x: MAP.cavern.x, y: groundHeight(MAP.cavern.x, MAP.cavern.z) + 0.3, z: MAP.cavern.z, spread: 7, rise: 3, color: [0x3fe8ff, 0xdffcff], count: 40, size: 0.13 },
  ]);
  scene.add(particles.points);

  /* ---------------------------------------------------------------- Deploy preview */

  // A glowing placement circle that follows the cursor while a card is armed:
  // green rim over a blue fill where the card may land, red where it may not.
  const previewMaterial = (opacity, blending = THREE.AdditiveBlending) =>
    new THREE.MeshBasicMaterial({ transparent: true, opacity, blending, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  const previewRing = new THREE.Mesh(new THREE.RingGeometry(0.87, 1, 72).rotateX(-Math.PI / 2), previewMaterial(1));
  const previewHalo = new THREE.Mesh(new THREE.RingGeometry(1, 1.3, 72).rotateX(-Math.PI / 2), previewMaterial(0.4));
  const previewDisc = new THREE.Mesh(new THREE.CircleGeometry(0.87, 48).rotateX(-Math.PI / 2), previewMaterial(0.38));
  // Shades the part of the field where troops and buildings cannot be placed.
  const forbidden = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), previewMaterial(0.2, THREE.NormalBlending));
  forbidden.material.color.set(0xff3030);
  const previewParts = [forbidden, previewDisc, previewHalo, previewRing];
  let previewRadius = 1;
  for (const mesh of previewParts) {
    mesh.visible = false;
    mesh.renderOrder = 5;
    scene.add(mesh);
  }

  /* ---------------------------------------------------------------- Effects */

  const fxGroup = new THREE.Group();
  scene.add(fxGroup);
  const ringGeometry = new THREE.RingGeometry(0.88, 1, 56).rotateX(-Math.PI / 2);
  const effects = [];

  /** `update(k, dt)` runs every frame with k from 0 to 1; `done` cleans up. */
  function effect(duration, update, done, delay = 0) {
    effects.push({ age: -delay, duration, update, done });
  }

  /**
   * Whether new effects should be skipped: the view is not being drawn (a hidden
   * tab keeps receiving snapshots) or too many are already alive. Without this a
   * minute in the background would return as one enormous burst.
   */
  const muted = () => effects.length > 600 || performance.now() - lastTime > 1_500;

  /**
   * Reports that something on the field made a noise, to whoever set
   * `onCue(name, x, z, detail)`: the match controller, which plays the sound.
   * Nothing is reported unless a match is running: the rehearsal before a first
   * match is played unheard. Unlike the effects, sounds do not wait on the frame
   * rate, so a struggling machine loses pictures before it loses sound; the
   * sound engine itself keeps quiet in a hidden tab.
   */
  const cue = (name, x, z, detail) => {
    if (running) api.onCue?.(name, x, z, detail);
  };

  function additive(color, opacity = 1) {
    return { color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false };
  }

  function ring(x, z, color, from, to, duration, delay = 0) {
    if (muted()) return;
    const mesh = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ ...additive(color, 0), side: THREE.DoubleSide }));
    mesh.position.set(x, groundHeight(x, z) + 0.08, z);
    mesh.visible = false;
    fxGroup.add(mesh);
    effect(
      duration,
      (k) => {
        mesh.visible = true;
        mesh.scale.setScalar(from + (to - from) * easeOut(k));
        mesh.material.opacity = (1 - k) * 0.95;
      },
      () => {
        fxGroup.remove(mesh);
        mesh.material.dispose();
      },
      delay,
    );
  }

  function flash(x, y, z, color, size, duration, delay = 0, depthTest = true) {
    if (muted()) return;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(color, 0), depthTest }));
    sprite.position.set(x + TO_CAMERA.x, y + TO_CAMERA.y, z + TO_CAMERA.z);
    fxGroup.add(sprite);
    effect(
      duration,
      (k) => {
        sprite.scale.setScalar(size * (0.4 + 0.6 * easeOut(k)));
        sprite.material.opacity = 1 - k * k;
      },
      () => {
        fxGroup.remove(sprite);
        sprite.material.dispose();
      },
      delay,
    );
  }

  /** A pillar of light. Sprites stay upright on screen, so height is scaled by the camera pitch. */
  function beam(x, z, color, width, height, duration, delay = 0) {
    if (muted()) return;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: beamTexture, ...additive(color, 0) }));
    sprite.center.set(0.5, 0);
    sprite.position.set(x, groundHeight(x, z) + 0.05, z);
    fxGroup.add(sprite);
    effect(
      duration,
      (k) => {
        sprite.scale.set(width * (1 - 0.5 * k), height * COS_P * (0.6 + 0.4 * easeOut(k)), 1);
        sprite.material.opacity = Math.sin(Math.min(1, k * 4) * (Math.PI / 2)) * (1 - k);
      },
      () => {
        fxGroup.remove(sprite);
        sprite.material.dispose();
      },
      delay,
    );
  }

  function sparks(x, y, z, color, count, speed, duration, size = 0.36) {
    if (muted()) return;
    const floor = groundHeight(x, z) + 0.05;
    const material = new THREE.SpriteMaterial({ map: glowTexture, ...additive(color) });
    const bits = Array.from({ length: count }, () => {
      const sprite = new THREE.Sprite(material);
      const angle = Math.random() * TAU;
      const spread = speed * (0.35 + Math.random() * 0.65);
      sprite.position.set(x, y, z);
      sprite.scale.setScalar(size * (0.6 + Math.random() * 0.8));
      fxGroup.add(sprite);
      return { sprite, vx: Math.cos(angle) * spread, vy: speed * (0.5 + Math.random()), vz: Math.sin(angle) * spread };
    });
    effect(
      duration,
      (k, dt) => {
        material.opacity = 1 - k * k;
        for (const bit of bits) {
          bit.vy -= 9 * dt;
          bit.sprite.position.x += bit.vx * dt;
          bit.sprite.position.y = Math.max(floor, bit.sprite.position.y + bit.vy * dt);
          bit.sprite.position.z += bit.vz * dt;
        }
      },
      () => {
        for (const bit of bits) fxGroup.remove(bit.sprite);
        material.dispose();
      },
    );
  }

  // The same two, with the height given above the ground at (x, z) rather than as a world height.
  const flashAt = (x, above, z, ...rest) => flash(x, groundHeight(x, z) + above, z, ...rest);
  /** A flash many times the size of its source. The ground would cut such a sprite in two along a hard line, so it is drawn over everything. */
  const glare = (x, y, z, color, size, duration, delay = 0) => flash(x, y, z, color, size, duration, delay, false);
  const sparksAt = (x, above, z, ...rest) => sparks(x, groundHeight(x, z) + above, z, ...rest);

  function explosion(x, z, radius) {
    flashAt(x, 0.8, z, 0xfff0b0, radius * 2.4, 0.4);
    flashAt(x, 0.8, z, 0xff6a14, radius * 4, 0.7);
    ring(x, z, 0xffffff, 0.3, radius * 0.9, 0.3);
    ring(x, z, 0xffb040, 0.3, radius, 0.55);
    ring(x, z, 0xff5a14, 0.2, radius * 1.35, 0.85, 0.06);
    sparksAt(x, 0.5, z, 0xffa033, 22, 7, 0.9, 0.42);
  }

  /** Motes that drift upwards and fade: healing light, or the sparks of a burning pillar when `speed` is high. */
  function rise(x, z, radius, color, count, duration, speed = 1) {
    if (muted()) return;
    const ground = groundHeight(x, z);
    const material = new THREE.SpriteMaterial({ map: glowTexture, ...additive(color) });
    const bits = Array.from({ length: count }, () => {
      const sprite = new THREE.Sprite(material);
      const angle = Math.random() * TAU;
      const reach = Math.sqrt(Math.random()) * radius;
      sprite.position.set(x + Math.cos(angle) * reach, ground + 0.1 + Math.random() * 0.7, z + Math.sin(angle) * reach);
      sprite.scale.setScalar(0.25 + Math.random() * 0.3);
      fxGroup.add(sprite);
      return { sprite, speed: (1.4 + Math.random() * 2.2) * speed };
    });
    effect(
      duration,
      (k, dt) => {
        material.opacity = Math.sin(Math.min(1, k * 5) * (Math.PI / 2)) * (1 - k * k);
        for (const bit of bits) bit.sprite.position.y += bit.speed * dt;
      },
      () => {
        for (const bit of bits) fxGroup.remove(bit.sprite);
        material.dispose();
      },
    );
  }

  /** Projectile looks. Their materials are shared by every bolt in flight and never disposed. */
  const BOLTS = {
    energy: { color: 0x3fa8ff, core: 0xeaffff, size: 1.7 },
    magma: { color: 0xff5a14, core: 0xffe9a0, size: 1.9 },
    arcane: { color: 0x4f8cff, core: 0xdfeaff, size: 1.15 },
    boltRadiant: { color: 0x59d2ff, core: 0xffffff, size: 0.8 },
    boltDire: { color: 0xff7a3a, core: 0xfff0c0, size: 0.8 },
  };
  for (const style of Object.values(BOLTS)) {
    style.head = new THREE.SpriteMaterial({ map: glowTexture, ...additive(style.color) });
    style.heart = new THREE.SpriteMaterial({ map: glowTexture, ...additive(style.core) });
    style.tail = new THREE.SpriteMaterial({ map: glowTexture, ...additive(style.color, 0.45) });
  }

  /**
   * A glowing projectile that homes on a moving target. `aim()` returns the
   * target's current position, or null once it is gone; the bolt then finishes
   * its flight to the last place it saw.
   */
  function bolt(kind, from, aim, speed) {
    const goal = muted() ? null : aim();
    if (!goal) return;
    const style = BOLTS[kind];
    const head = new THREE.Sprite(style.head);
    const heart = new THREE.Sprite(style.heart);
    // Small bolts fly in numbers, so they get a shorter trail and no muzzle flash.
    const small = style.size < 1;
    const tails = Array.from({ length: small ? 1 : 2 }, () => new THREE.Sprite(style.tail));
    head.scale.setScalar(style.size);
    heart.scale.setScalar(style.size * 0.45);
    tails.forEach((tail, i) => tail.scale.setScalar(style.size * (0.75 - i * 0.22)));

    const at = new THREE.Vector3(from.x, from.y, from.z);
    const heading = new THREE.Vector3(goal.x - at.x, goal.y - at.y, goal.z - at.z).normalize();
    const place = () => {
      head.position.copy(at);
      heart.position.set(at.x + TO_CAMERA.x * 0.15, at.y + TO_CAMERA.y * 0.15, at.z + TO_CAMERA.z * 0.15);
      tails.forEach((tail, i) => tail.position.copy(at).addScaledVector(heading, -(i + 1) * style.size * 0.38));
    };
    place();
    fxGroup.add(...tails, head, heart);
    if (!small) flash(from.x, from.y, from.z, style.color, style.size * 1.5, 0.18);

    effect(
      4,
      (_k, dt) => {
        Object.assign(goal, aim());
        heading.set(goal.x - at.x, goal.y - at.y, goal.z - at.z);
        const gap = heading.length();
        if (gap <= speed * dt) return true;
        at.addScaledVector(heading.divideScalar(gap), speed * dt);
        place();
        return false;
      },
      () => {
        fxGroup.remove(head, heart, ...tails);
        flash(goal.x, goal.y, goal.z, style.color, style.size * 1.8, 0.22);
        if (style.size > 1.4) sparks(goal.x, goal.y, goal.z, style.core, 5, 3, 0.35, 0.25);
      },
    );
  }

  const rayTexture = canvasTexture(64, 4, (g, w, h) => {
    const across = g.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, 'rgba(255, 255, 255, 0)');
    across.addColorStop(0.25, 'rgba(255, 255, 255, 0.2)');
    across.addColorStop(0.5, 'rgba(255, 255, 255, 1)');
    across.addColorStop(0.75, 'rgba(255, 255, 255, 0.2)');
    across.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = across;
    g.fillRect(0, 0, w, h);
  });
  const VIEW_DIR = new THREE.Vector3();

  /** A straight beam between two points, drawn as a ribbon that faces the camera. */
  function ray(from, to, color, width, duration) {
    if (muted()) return;
    VIEW_DIR.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2).sub(camera.position);
    const across = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z)
      .cross(VIEW_DIR)
      .normalize()
      .multiplyScalar(width / 2);
    const corners = [
      [from, -1],
      [from, 1],
      [to, 1],
      [to, -1],
    ].flatMap(([p, s]) => [p.x + across.x * s, p.y + across.y * s, p.z + across.z * s]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: rayTexture, ...additive(color), side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    fxGroup.add(mesh);
    effect(
      duration,
      (k) => {
        mesh.material.opacity = 1 - k * k;
      },
      () => {
        fxGroup.remove(mesh);
        geometry.dispose();
        mesh.material.dispose();
      },
    );
  }

  /** A Golem's fists hitting the ground: shockwave rings and flying rubble, after `delay` seconds. */
  function slam(x, z, color, delay) {
    ring(x, z, 0xd8c8a8, 0.3, 2.6, 0.5, delay);
    ring(x, z, color, 0.2, 3.4, 0.7, delay + 0.05);
    flashAt(x, 0.5, z, color, 5, 0.35, delay);
    effect(0.01, () => {}, () => sparksAt(x, 0.3, z, 0xb9ad98, 12, 5, 0.6, 0.34), delay);
  }

  /** A meteor that arcs from the caster's Throne onto the marked target circle. */
  function fireball(side, to, radius, travel) {
    const throne = STRUCTURES.find((s) => s.side === side && s.kind === 'throne');
    const from = { x: throne.x, y: groundHeight(throne.x, throne.z) + throne.height, z: throne.z };
    const land = groundHeight(to.x, to.z);
    const target = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ ...additive(0xff7a1a, 0), side: THREE.DoubleSide }));
    target.position.set(to.x, land + 0.1, to.z);
    target.scale.setScalar(radius);
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(0xffa033) }));
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(0xfff6d0) }));
    head.scale.setScalar(3.6);
    core.scale.setScalar(1.5);
    fxGroup.add(target, head, core);
    flash(from.x, from.y, from.z, 0xffa033, 6, 0.4);

    let trail = 0;
    effect(
      travel,
      (k, dt) => {
        const x = from.x + (to.x - from.x) * k;
        const z = from.z + (to.z - from.z) * k;
        const y = from.y + (land + 0.4 - from.y) * k + Math.sin(k * Math.PI) * 8;
        head.position.set(x, y, z);
        core.position.set(x + TO_CAMERA.x * 0.2, y + TO_CAMERA.y * 0.2, z + TO_CAMERA.z * 0.2);
        target.material.opacity = 0.35 + 0.5 * k;
        trail += dt;
        if (trail > 0.025) {
          trail = 0;
          flash(x - TO_CAMERA.x, y - TO_CAMERA.y, z - TO_CAMERA.z, 0xff6a14, 2, 0.4);
        }
      },
      () => {
        fxGroup.remove(target, head, core);
        for (const sprite of [target, head, core]) sprite.material.dispose();
        explosion(to.x, to.z, radius);
      },
    );
  }

  /* ---------------------------------------------------------------- Hero abilities */

  /** A colour pushed past white, so the bloom pass makes it glow. */
  const hot = (hex, boost = 1.6) => new THREE.Color(hex).multiplyScalar(boost);

  // A crescent that brightens from its tail to its leading edge. With additive
  // blending black is invisible, so the gradient lives in the vertex colours.
  const SLASH_SWEEP = 1.7;
  const slashGeometry = (() => {
    const segments = 26;
    const positions = [];
    const colors = [];
    const index = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = SLASH_SWEEP * (0.5 - t);
      const inner = 1 - 0.36 * Math.sin(Math.PI * t) ** 0.7;
      const glow = t ** 1.6;
      positions.push(Math.cos(angle) * inner, Math.sin(angle) * inner, 0, Math.cos(angle), Math.sin(angle), 0);
      colors.push(0, 0, 0, glow, glow, glow);
      if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2 + 1, i * 2 - 2, i * 2 + 1, i * 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(index);
    return geometry;
  })();

  /**
   * A sword cut: a crescent of light swept round in front of a hero facing
   * `facing`. The cut lies flat, so the camera above always sees its full arc;
   * `cant` tips it off level (positive sweeps left to right, negative right to left).
   */
  function slash(x, y, z, facing, color, size, cant) {
    if (muted()) return;
    // Local X points the way the hero faces. The crescent is modelled upright and laid over onto its side.
    const holder = new THREE.Group();
    holder.position.set(x, y, z);
    holder.rotation.y = facing - Math.PI / 2;
    const plane = new THREE.Group();
    plane.rotation.x = cant - Math.sign(cant) * (Math.PI / 2);
    const outer = new THREE.Mesh(slashGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, ...additive(hot(color, 2.2), 0), side: THREE.DoubleSide }));
    const core = new THREE.Mesh(slashGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, ...additive(hot(0xfff8e0, 1.6), 0), side: THREE.DoubleSide }));
    outer.scale.setScalar(size);
    core.scale.setScalar(size * 0.93);
    plane.add(outer, core);
    holder.add(plane);
    holder.visible = false;
    fxGroup.add(holder);
    effect(
      0.28,
      (k) => {
        holder.visible = true;
        // The leading edge travels from behind one shoulder, across the front, and past the other.
        const turn = 2.75 - 2.6 * easeOut(k);
        outer.rotation.z = core.rotation.z = turn;
        outer.material.opacity = Math.sin(Math.min(1, k * 3) * (Math.PI / 2)) * (1 - k * k);
        core.material.opacity = outer.material.opacity * 0.8;
      },
      () => {
        fxGroup.remove(holder);
        outer.material.dispose();
        core.material.dispose();
      },
    );
  }

  /** A camera-facing ribbon through `points` ([x, y, z] each): one stroke of lightning. */
  function ribbonGeometry(points, width) {
    const positions = [];
    const uvs = [];
    const index = [];
    const last = points.length - 1;
    points.forEach((point, i) => {
      const before = points[Math.max(0, i - 1)];
      const after = points[Math.min(last, i + 1)];
      EDGE.set(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
      VIEW_DIR.set(point[0], point[1], point[2]).sub(camera.position);
      EDGE.cross(VIEW_DIR).normalize().multiplyScalar(width / 2);
      positions.push(point[0] - EDGE.x, point[1] - EDGE.y, point[2] - EDGE.z, point[0] + EDGE.x, point[1] + EDGE.y, point[2] + EDGE.z);
      uvs.push(0, i / last, 1, i / last);
      if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2 + 1, i * 2 - 2, i * 2 + 1, i * 2);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    return geometry;
  }

  /**
   * Thunder Strike: jagged bolts fall from the sky onto (x, z), then arcs keep
   * crawling over the ground for `linger` seconds, as long as the stun lasts.
   */
  function lightning(x, z, colors, radius, linger) {
    if (muted()) return;
    const ground = groundHeight(x, z);
    const jagged = (from, to, joints, wobble) =>
      Array.from({ length: joints + 1 }, (_, i) => {
        const t = i / joints;
        // The kinks shrink towards the ground so the bolt lands on its mark.
        const kink = i === 0 || i === joints ? 0 : wobble * (1 - t * 0.6);
        return [
          from[0] + (to[0] - from[0]) * t + (Math.random() - 0.5) * kink,
          from[1] + (to[1] - from[1]) * t + (Math.random() - 0.5) * kink * 0.4,
          from[2] + (to[2] - from[2]) * t + (Math.random() - 0.5) * kink * 0.5,
        ];
      });
    const strike = (delay, life, power) => {
      const sky = [x + (Math.random() - 0.5) * 6, ground + 20, z - 2 + (Math.random() - 0.5) * 2];
      const trunk = jagged(sky, [x, ground + 0.1, z], 12, 2.2);
      const strokes = [
        [trunk, colors.bolt, 1.25, 0.8],
        [trunk, colors.boltCore, 0.4, 1],
      ];
      // Forks split off the trunk and die out in the air.
      for (const joint of [3, 6, 8]) {
        const [fx0, fy0, fz0] = trunk[joint];
        const reach = 2 + Math.random() * 2.5;
        const fork = jagged(trunk[joint], [fx0 + (Math.random() - 0.5) * reach * 2, fy0 - reach * 1.2, fz0 + (Math.random() - 0.5) * reach], 4, 1);
        strokes.push([fork, colors.bolt, 0.42, 0.7]);
      }
      const meshes = strokes.map(([points, color, width, opacity]) => {
        const mesh = new THREE.Mesh(
          ribbonGeometry(points, width),
          new THREE.MeshBasicMaterial({ map: rayTexture, ...additive(hot(color, 1.9), 0), side: THREE.DoubleSide }),
        );
        mesh.userData.opacity = opacity * power;
        mesh.frustumCulled = false;
        mesh.visible = false;
        fxGroup.add(mesh);
        return mesh;
      });
      effect(
        life,
        (k) => {
          const flicker = k < 0.2 ? 1 : 0.4 + 0.6 * Math.abs(Math.sin(k * 34));
          for (const mesh of meshes) {
            mesh.visible = true;
            mesh.material.opacity = mesh.userData.opacity * flicker * (1 - k * k);
          }
        },
        () => {
          for (const mesh of meshes) {
            fxGroup.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
          }
        },
        delay,
      );
    };
    strike(0, 0.3, 1);
    strike(0.09, 0.26, 0.8);
    strike(0.2, 0.3, 0.9);

    flashAt(x, 1.2, z, colors.boltCore, radius * 2.6, 0.35);
    flashAt(x, 0.8, z, colors.bolt, radius * 5, 0.65);
    flashAt(x, 14, z - 2, colors.bolt, 10, 0.35);
    ring(x, z, colors.boltCore, 0.3, radius, 0.32);
    ring(x, z, colors.bolt, 0.3, radius * 1.15, 0.6, 0.06);
    ring(x, z, colors.bolt, radius, radius, linger);
    sparksAt(x, 0.5, z, colors.bolt, 22, 8, 0.8, 0.34);
    sparksAt(x, 0.5, z, colors.boltCore, 10, 5, 0.6, 0.26);

    let since = 0;
    effect(linger, (_k, dt) => {
      since += dt;
      if (since < 0.08) return;
      since = 0;
      const angle = Math.random() * TAU;
      const reach = Math.sqrt(Math.random()) * radius * 0.95;
      const from = { x: x + Math.cos(angle) * reach, y: ground + 0.12, z: z + Math.sin(angle) * reach };
      const to = { x: from.x + (Math.random() - 0.5) * 1.8, y: ground + 0.2 + Math.random() * 1.1, z: from.z + (Math.random() - 0.5) * 1.8 };
      ray(from, to, colors.bolt, 0.2, 0.14);
    });
  }

  // Streaks of light that thin out towards the sky; the columns of a pillar turn it about its axis.
  const pillarTexture = canvasTexture(128, 256, (g, w, h) => {
    const random = seededRandom(11);
    for (let i = 0; i < 34; i++) {
      g.fillStyle = `rgba(255, 255, 255, ${(0.12 + random() * 0.5).toFixed(3)})`;
      g.fillRect(random() * w, 0, 1 + random() * 7, h);
    }
    const rise = g.createLinearGradient(0, h, 0, 0);
    rise.addColorStop(0, 'rgba(255, 255, 255, 1)');
    rise.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
    rise.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = rise;
    g.fillRect(0, 0, w, h);
  });
  pillarTexture.wrapS = THREE.RepeatWrapping;
  const pillarGeometry = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true).translate(0, 0.5, 0);
  const sealGeometry = new THREE.RingGeometry(0.86, 1, 6).rotateX(-Math.PI / 2);
  const sigilGeometry = new THREE.RingGeometry(0.52, 0.6, 3).rotateX(-Math.PI / 2);
  const poolGeometry = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  const PILLAR_HEIGHT = 30;

  /**
   * Divine Judgment: after `delay` seconds a pillar of light falls from orbit
   * onto (x, z) and burns for `duration`, pulsing a shockwave on every damage tick.
   */
  function pillar(x, z, radius, colors, delay, duration, tick) {
    if (muted()) return;
    const lit = (geometry, color, boost, map) => {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map, ...additive(hot(color, boost), 0), side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      return mesh;
    };
    const column = lit(pillarGeometry, colors.pillar, 1.1, pillarTexture);
    const core = lit(pillarGeometry, colors.pillarCore, 1.3, pillarTexture);
    const pool = lit(poolGeometry, colors.pillar, 1, glowTexture);
    const seal = lit(sealGeometry, colors.pillar, 1.6);
    const sigils = [lit(sigilGeometry, colors.pillarCore, 1.6), lit(sigilGeometry, colors.pillarCore, 1.6)];
    const haze = new THREE.Sprite(new THREE.SpriteMaterial({ map: beamTexture, ...additive(colors.pillar, 0) }));
    column.scale.set(radius * 0.5, PILLAR_HEIGHT, radius * 0.5);
    core.scale.set(radius * 0.2, PILLAR_HEIGHT, radius * 0.2);
    pool.scale.setScalar(radius * 1.15);
    pool.position.y = 0.07;
    seal.scale.setScalar(radius);
    seal.position.y = 0.1;
    sigils.forEach((sigil, i) => {
      sigil.scale.setScalar(radius);
      sigil.position.y = 0.11;
      sigil.rotation.y = i * Math.PI;
    });
    haze.center.set(0.5, 0);
    haze.scale.set(radius * 1.5, PILLAR_HEIGHT * COS_P, 1);
    const group = new THREE.Group();
    group.position.set(x, groundHeight(x, z), z);
    group.add(pool, seal, ...sigils, haze, column, core);
    group.visible = false;
    fxGroup.add(group);

    // A closing circle warns of the strike; the pillar lands with the first tick of damage.
    ring(x, z, colors.pillar, radius, radius * 0.3, delay);
    ring(x, z, colors.pillarCore, radius * 1.05, radius * 1.05, delay);

    let emitted = 0;
    let ticks = 0;
    effect(
      duration,
      (k, dt) => {
        group.visible = true;
        const t = k * duration;
        const arrive = Math.min(1, t / 0.2);
        const power = arrive * Math.min(1, (duration - t) / 0.5) * (0.86 + 0.14 * Math.sin(t * 24));
        // The light falls out of the sky, then holds.
        column.position.y = core.position.y = (1 - easeOut(arrive)) * PILLAR_HEIGHT;
        column.rotation.y += dt * 1.5;
        core.rotation.y -= dt * 2.6;
        seal.rotation.y += dt * 0.8;
        sigils[0].rotation.y -= dt * 1.6;
        sigils[1].rotation.y -= dt * 1.6;
        column.material.opacity = 0.42 * power;
        core.material.opacity = 0.6 * power;
        haze.material.opacity = 0.22 * power;
        pool.material.opacity = 0.45 * power;
        seal.material.opacity = 0.9 * power;
        sigils[0].material.opacity = sigils[1].material.opacity = 0.8 * power;

        emitted += dt;
        if (emitted > 0.1) {
          emitted = 0;
          rise(x, z, radius * 0.85, colors.pillarCore, 8, 0.85, 5);
        }
        if (t >= ticks * tick) {
          ticks++;
          ring(x, z, colors.pillar, 0.5, radius, 0.45);
          ring(x, z, colors.pillarCore, 0.3, radius * 0.7, 0.3);
          sparksAt(x, 0.4, z, colors.pillar, 12, 7.5, 0.75, 0.3);
          flashAt(x, 0.6, z, colors.pillarCore, radius * 1.1, 0.25);
        }
      },
      () => {
        fxGroup.remove(group);
        for (const mesh of [column, core, pool, seal, ...sigils, haze]) mesh.material.dispose();
        ring(x, z, colors.pillar, radius * 0.6, radius * 1.4, 0.5);
        sparksAt(x, 0.6, z, colors.pillarCore, 18, 6, 0.9, 0.3);
      },
      delay,
    );
  }

  /* ---------------------------------------------------------------- Morgath's spells, debris and spins */

  /** Runs `act` after `delay` seconds, unless the effects are cleared first. */
  const later = (delay, act) => effect(0.01, () => {}, act, delay);

  /**
   * Chunks thrown out of a blast: crystal shards, lumps of magma. They tumble
   * under gravity, lie where they land and fade out over the last of `duration`.
   */
  const shardGeometry = new THREE.OctahedronGeometry(1, 0).scale(0.45, 1, 0.45);
  function debris(x, y, z, color, count, speed, duration, size = 0.34) {
    if (muted()) return;
    const floor = groundHeight(x, z) + 0.1;
    const material = new THREE.MeshBasicMaterial(additive(hot(color, 1.4), 1));
    const bits = Array.from({ length: count }, () => {
      const mesh = new THREE.Mesh(shardGeometry, material);
      const angle = Math.random() * TAU;
      const spread = speed * (0.3 + Math.random() * 0.7);
      mesh.position.set(x, y, z);
      mesh.scale.setScalar(size * (0.6 + Math.random() * 0.9));
      mesh.frustumCulled = false;
      fxGroup.add(mesh);
      return {
        mesh,
        vx: Math.cos(angle) * spread,
        vy: speed * (0.6 + Math.random() * 0.9),
        vz: Math.sin(angle) * spread,
        turn: [Math.random() * 9 - 4.5, Math.random() * 9 - 4.5],
      };
    });
    effect(
      duration,
      (k, dt) => {
        material.opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
        for (const bit of bits) {
          const { mesh } = bit;
          bit.vy -= 14 * dt;
          mesh.position.x += bit.vx * dt;
          mesh.position.y += bit.vy * dt;
          mesh.position.z += bit.vz * dt;
          if (mesh.position.y <= floor) {
            // Lying on the ground: it skids to a halt.
            mesh.position.y = floor;
            bit.vy = 0;
            bit.vx *= 0.9;
            bit.vz *= 0.9;
            bit.turn[0] = bit.turn[1] = 0;
          }
          mesh.rotation.x += bit.turn[0] * dt;
          mesh.rotation.z += bit.turn[1] * dt;
        }
      },
      () => {
        for (const bit of bits) fxGroup.remove(bit.mesh);
        material.dispose();
      },
    );
  }

  // A band of light with a bright head and a tail that fades behind it, laid flat: the sweep of a spinning blade.
  const spinGeometry = (() => {
    const segments = 48;
    const positions = [];
    const colors = [];
    const index = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = t * TAU;
      const glow = t ** 2.2;
      positions.push(Math.cos(angle) * 0.7, 0, Math.sin(angle) * 0.7, Math.cos(angle), 0, Math.sin(angle));
      colors.push(0, 0, 0, glow, glow, glow);
      if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2 + 1, i * 2 - 2, i * 2 + 1, i * 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(index);
    return geometry;
  })();

  /**
   * A blade whirling a full turn round (x, y, z) at `radius`: the Valkyrie's
   * spin. The band turns once over `duration` with its bright head leading, and
   * a ring on the ground marks how far the blow reaches.
   */
  function spin(x, y, z, radius, color, duration) {
    if (muted()) return;
    const holder = new THREE.Group();
    holder.position.set(x, y, z);
    holder.visible = false;
    const outer = new THREE.Mesh(spinGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, ...additive(hot(color, 2), 0), side: THREE.DoubleSide }));
    const core = new THREE.Mesh(spinGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, ...additive(hot(0xffffff, 1.5), 0), side: THREE.DoubleSide }));
    outer.scale.setScalar(radius);
    core.scale.set(radius * 0.94, 1, radius * 0.94);
    holder.add(outer, core);
    fxGroup.add(holder);
    effect(
      duration * 1.15,
      (k) => {
        holder.visible = true;
        const turn = Math.min(1, k / 0.87);
        holder.rotation.y = -TAU * easeOut(turn) + 1;
        outer.material.opacity = Math.sin(Math.min(1, k * 5) * (Math.PI / 2)) * (1 - k * k);
        core.material.opacity = outer.material.opacity * 0.8;
      },
      () => {
        fxGroup.remove(holder);
        outer.material.dispose();
        core.material.dispose();
      },
    );
    ring(x, z, color, radius * 0.8, radius, duration * 1.4);
    sparksAt(x, 0.5, z, color, 8, 4.5, 0.4, 0.22);
  }

  /** Magma Cleave: a molten crescent swept through the arc in front of Morgath, and embers where it passes. */
  function cleave(x, z, tx, tz, range, arc, colors) {
    const facing = Math.atan2(tx - x, tz - z);
    const y = groundHeight(x, z) + 1.2;
    slash(x, y, z, facing, colors.slash, range, 0.32);
    slash(x, y, z, facing, colors.pillar, range * 0.82, -0.32);
    flashAt(x, 1.2, z, colors.slash, 4, 0.3);
    const half = (arc * Math.PI) / 360;
    for (let i = 0; i < 7; i++) {
      const angle = facing + half * (i / 3 - 1);
      const px = x + Math.sin(angle) * range * 0.9;
      const pz = z + Math.cos(angle) * range * 0.9;
      sparksAt(px, 0.5, pz, i % 2 ? colors.slash : colors.pillarCore, 4, 4, 0.6, 0.26);
      flashAt(px, 0.6, pz, colors.slash, 1.8, 0.35, 0.05 + i * 0.02);
    }
    rise(x + Math.sin(facing) * range * 0.6, z + Math.cos(facing) * range * 0.6, range * 0.45, colors.slash, 14, 1.0, 2);
  }

  // The spike: a five-sided cone of black glass with a violet glow in it.
  const spikeGeometry = new THREE.ConeGeometry(0.42, 1, 5).translate(0, 0.5, 0);
  const obsidian = new THREE.MeshStandardMaterial({
    color: 0x17121f,
    roughness: 0.28,
    metalness: 0.55,
    emissive: 0x4a1a8a,
    emissiveIntensity: 0.6,
    flatShading: true,
    envMap,
    envMapIntensity: 1.2,
  });
  const SPIKES = 10;

  /**
   * Obsidian Spike: a row of spikes bursts from the ground one after another
   * along the line towards (tx, tz), a tall one on the line and a shorter one
   * beside it, holds for a moment and sinks back.
   */
  function spikes(x, z, tx, tz, width, colors) {
    if (muted()) return;
    const length = Math.hypot(tx - x, tz - z) || 1;
    const dx = (tx - x) / length;
    const dz = (tz - z) / length;
    ray({ x, y: groundHeight(x, z) + 0.4, z }, { x: tx, y: groundHeight(tx, tz) + 0.4, z: tz }, colors.bolt, width * 0.7, 0.4);
    for (let i = 0; i < SPIKES; i++) {
      const along = ((i + 1) / SPIKES) * length;
      const delay = i * 0.045;
      const flank = (i % 2 ? 1 : -1) * width * 0.45;
      for (const [lateral, tall, girth] of [[(Math.random() - 0.5) * 0.4, 2.4 + Math.random() * 0.8, 1.2], [flank, 1.3 + Math.random() * 0.6, 0.8]]) {
        const px = x + dx * along - dz * lateral;
        const pz = z + dz * along + dx * lateral;
        const mesh = new THREE.Mesh(spikeGeometry, obsidian);
        mesh.position.set(px, groundHeight(px, pz) - 0.05, pz);
        mesh.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * TAU, (Math.random() - 0.5) * 0.3);
        mesh.visible = false;
        fxGroup.add(mesh);
        effect(
          1.05,
          (k) => {
            mesh.visible = true;
            const sink = k > 0.72 ? (k - 0.72) / 0.28 : 0;
            const out = easeOut(Math.min(1, k / 0.12)) * (1 - sink * sink);
            mesh.scale.set(girth * (1 - 0.4 * sink), tall * out + 0.001, girth * (1 - 0.4 * sink));
          },
          () => fxGroup.remove(mesh),
          delay,
        );
        later(delay, () => {
          ring(px, pz, colors.bolt, 0.2, 1.2, 0.3);
          sparksAt(px, 0.3, pz, colors.bolt, 5, 4.5, 0.5, 0.22);
          flashAt(px, 0.6, pz, colors.boltCore, 1.6, 0.25);
        });
      }
    }
  }

  const rockGeometry = new THREE.IcosahedronGeometry(1, 1);
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0x1b0f0c,
    roughness: 0.8,
    emissive: 0xff4a10,
    emissiveIntensity: 0.9,
    flatShading: true,
    envMap,
  });
  const METEOR_START = { x: -12, y: 34, z: -8 };

  /**
   * Cataclysmic Meteor: a circle on the ground closes in on (x, z) for `delay`
   * seconds while a burning rock falls out of the sky onto it, then the blast,
   * and a crater that burns for `burn` seconds.
   */
  function meteor(x, z, radius, colors, delay, burn) {
    if (muted()) return;
    const ground = groundHeight(x, z);
    ring(x, z, colors.pillar, radius, radius, delay);
    ring(x, z, colors.pillarCore, radius * 1.7, radius * 0.4, delay);
    flashAt(x, 0.3, z, colors.pillar, radius * 2.4, delay);

    const rock = new THREE.Mesh(rockGeometry, rockMaterial);
    rock.scale.setScalar(1.3);
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(hot(colors.pillar, 1.2)) }));
    const heart = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(colors.pillarCore) }));
    head.scale.setScalar(7);
    heart.scale.setScalar(3.4);
    fxGroup.add(rock, head, heart);
    const at = new THREE.Vector3();
    let trail = 0;
    effect(
      delay,
      (k, dt) => {
        const fall = k * k;
        at.set(x + METEOR_START.x * (1 - fall), ground + 0.6 + (METEOR_START.y - 0.6) * (1 - fall), z + METEOR_START.z * (1 - fall));
        rock.position.copy(at);
        rock.rotation.x += dt * 3;
        rock.rotation.y += dt * 2;
        head.position.copy(at);
        heart.position.set(at.x + TO_CAMERA.x * 0.2, at.y + TO_CAMERA.y * 0.2, at.z + TO_CAMERA.z * 0.2);
        trail += dt;
        if (trail > 0.03) {
          trail = 0;
          flash(at.x, at.y, at.z, colors.pillar, 3.2, 0.45);
          sparks(at.x, at.y, at.z, colors.pillarCore, 2, 2, 0.4, 0.3);
        }
      },
      () => {
        fxGroup.remove(rock, head, heart);
        head.material.dispose();
        heart.material.dispose();
        flashAt(x, 1, z, 0xffffff, radius * 3, 0.3);
        flashAt(x, 1, z, colors.pillar, radius * 6, 0.9);
        ring(x, z, 0xffffff, 0.5, radius * 1.1, 0.35);
        ring(x, z, colors.pillarCore, 0.5, radius * 1.6, 0.7, 0.04);
        ring(x, z, colors.pillar, 0.5, radius * 2.2, 1.0, 0.1);
        beam(x, z, colors.pillar, radius * 0.8, 12, 0.7);
        sparksAt(x, 0.6, z, colors.pillarCore, 26, 9, 1.0, 0.4);
        sparksAt(x, 0.6, z, colors.pillar, 18, 6, 1.2, 0.34);
        debris(x, ground + 0.6, z, colors.pillar, 16, 9, 1.4, 0.4);
        crater(x, z, radius, colors, burn);
      },
    );
  }

  /** The hole a meteor leaves: a scorched floor, a lake of lava in it and embers rising for `burn` seconds. */
  function crater(x, z, radius, colors, burn) {
    const ground = groundHeight(x, z);
    const place = (mesh, lift) => {
      mesh.position.set(x, ground + lift, z);
      mesh.scale.setScalar(radius);
      fxGroup.add(mesh);
      return mesh;
    };
    const scorch = place(new THREE.Mesh(poolGeometry, new THREE.MeshBasicMaterial({ color: 0x070404, transparent: true, opacity: 0, depthWrite: false })), 0.06);
    const lava = place(new THREE.Mesh(poolGeometry, new THREE.MeshBasicMaterial({ map: glowTexture, ...additive(hot(colors.pillar, 1.1), 0) })), 0.07);
    const rim = place(new THREE.Mesh(sealGeometry, new THREE.MeshBasicMaterial({ ...additive(hot(colors.pillar, 1.7), 0), side: THREE.DoubleSide })), 0.09);
    let emitted = 0;
    effect(
      burn,
      (k, dt) => {
        const t = k * burn;
        const power = Math.min(1, t / 0.2) * Math.min(1, (burn - t) / 0.7);
        const flicker = 0.8 + 0.2 * Math.sin(t * 17) * Math.sin(t * 5.3);
        scorch.material.opacity = 0.65 * power;
        lava.material.opacity = 0.7 * power * flicker;
        rim.material.opacity = 0.9 * power * flicker;
        rim.rotation.y += dt * 0.6;
        emitted += dt;
        if (emitted > 0.12) {
          emitted = 0;
          rise(x, z, radius * 0.85, colors.pillar, 6, 0.9, 2.4);
          if (Math.random() < 0.4) sparksAt(x + (Math.random() - 0.5) * radius, 0.3, z + (Math.random() - 0.5) * radius, colors.pillarCore, 3, 4, 0.6, 0.22);
        }
      },
      () => {
        for (const mesh of [scorch, lava, rim]) {
          fxGroup.remove(mesh);
          mesh.material.dispose();
        }
      },
    );
  }

  /**
   * A Throne goes up. Radiant's is a crystal and bursts into light and glittering
   * shards; Dire's is a forge and heaves out magma, in rings that run across the
   * ground. Three blasts follow one another over a second and a half.
   */
  function throneBlast(view) {
    const { x, z, height, radius, side } = view.def;
    const radiant = side === 'radiant';
    const mid = view.base + height * 0.5;
    const [main, core] = radiant ? [0x59d2ff, 0xe6fbff] : [0xff5a14, 0xffd9a0];
    const shard = radiant ? 0x9fe8ff : 0xff7a1a;
    // Only the finale shakes the camera and is heard: the rehearsal plays these blasts unseen.
    const jolt = (stage) => {
      if (!finaleRun) return;
      rig.jolt(FINALE_JOLT.throne[stage]);
      cue('blast', x, z, { side, stage });
    };

    jolt(0);
    glare(x, mid, z, 0xffffff, radius * 9, 0.6);
    glare(x, mid, z, main, radius * 14, 1.4);
    for (let i = 0; i < 4; i++) ring(x, z, i % 2 ? core : main, 0.5, radius * (3 + i * 1.6), 0.9 + i * 0.15, i * 0.28);
    sparks(x, mid, z, core, 36, 12, 1.4, 0.5);
    debris(x, mid, z, shard, radiant ? 34 : 24, 10, 2.2, radiant ? 0.4 : 0.55);
    if (radiant) {
      for (let i = 0; i < 4; i++) beam(x + (Math.random() - 0.5) * radius, z + (Math.random() - 0.5) * radius, core, 1.4, 18, 1.1, i * 0.12);
    } else {
      rise(x, z, radius * 1.4, main, 40, 1.8, 3);
      ring(x, z, 0x2a0c05, 1, radius * 6, 1.4, 0.15);
    }

    later(0.5, () => {
      jolt(1);
      glare(x, mid + 1, z, core, radius * 11, 0.9);
      ring(x, z, main, 1, radius * (radiant ? 6 : 9), 1.2);
      sparks(x, mid, z, main, 30, 10, 1.3, 0.46);
      debris(x, mid, z, shard, radiant ? 26 : 18, 8, 2, radiant ? 0.34 : 0.5);
    });
    later(1.0, () => {
      jolt(2);
      glare(x, view.base + 1, z, main, radius * 10, 1.2);
      for (let i = 0; i < 2; i++) ring(x, z, i ? core : main, 1, radius * (radiant ? 7 : 12), 1.4, i * 0.2);
      rise(x, z, radius * 1.6, radiant ? core : main, 36, 1.6, 2.6);
      sparksAt(x, 1, z, core, 24, 8, 1.2, 0.4);
    });
  }

  /**
   * A fading copy of a hero in the pose it holds right now, left where it stood:
   * the afterimage of a dash or a blink. `facing` turns it, or null keeps the hero's own heading.
   */
  function ghost(side, x, z, facing, color, duration, delay = 0) {
    if (muted()) return;
    const hero = heroes[side];
    const copy = hero.ghost(hot(color, 1.2));
    copy.object.position.set(x, groundHeight(x, z) + 0.05, z);
    if (facing !== null) copy.object.rotation.set(0, facing, 0);
    copy.object.visible = false;
    fxGroup.add(copy.object);
    effect(
      duration,
      (k) => {
        copy.object.visible = true;
        copy.fade(0.6 * (1 - k) ** 1.5);
        copy.object.scale.setScalar(hero.size * (1 + 0.08 * k));
      },
      () => {
        fxGroup.remove(copy.object);
        copy.dispose();
      },
      delay,
    );
  }

  let slashes = 0;
  /** The match-ending sequence in progress, or null: { live, resolve }. */
  let finaleRun = null;

  const fx = {
    // Primitives the unit layer builds its attack and death effects from.
    cue,
    bolt,
    ray,
    slam,
    sparks,
    ring,
    flash,
    beam,
    rise,

    /** A hero's sword cut. Successive cuts come from alternate sides. */
    heroSlash(side, x, y, z, facing) {
      slash(x, y, z, facing, spellOf(side).slash, 1.9, slashes++ % 2 ? -0.32 : 0.32);
    },

    spin,

    /** A hero has reached a new level: rings of light climb his body and a column of gold rises round him. */
    levelUp(side) {
      const view = units.hero(side);
      if (!view || view.dead) return;
      const { x, z } = view;
      for (let i = 0; i < 3; i++) ring(x, z, i === 1 ? 0xfff1b8 : GOLD, 0.4, 2.8, 0.7, i * 0.12);
      beam(x, z, 0xfff1b8, 2.2, 9, 0.9);
      flashAt(x, 1.4, z, 0xffe9a0, 7, 0.5);
      rise(x, z, 1.3, GOLD, 26, 1.4, 2.6);
      sparksAt(x, 1.2, z, 0xfff1b8, 14, 5, 0.8, 0.28);
      // A halo that climbs from the feet to above the head, following the hero.
      const halo = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ ...additive(GOLD, 0), side: THREE.DoubleSide }));
      halo.visible = false;
      fxGroup.add(halo);
      effect(
        0.9,
        (k) => {
          const at = units.hero(side);
          if (!at) return;
          halo.visible = true;
          halo.position.set(at.x, at.y + 0.1 + 3.2 * easeOut(k), at.z);
          halo.scale.setScalar(1.5 * (1 - 0.3 * k));
          halo.material.opacity = (1 - k) * 0.9;
        },
        () => {
          fxGroup.remove(halo);
          halo.material.dispose();
        },
      );
    },

    /** Lifesteal: life drawn out of the victim along a crimson thread back to the hero. */
    drain(from, to) {
      ray(from, to, LIFESTEAL_COLOR, 0.34, 0.26);
      flash(to.x, to.y, to.z, LIFESTEAL_COLOR, 2.6, 0.32);
      rise(to.x, to.z, 0.6, 0xff6a7a, 4, 0.6, 2);
    },

    /** An Aegis Shield giving out: the sphere bursts into shards. */
    shieldBreak(side, x, y, z) {
      const color = spellOf(side).shield;
      if (heroes[side].champion === 'morgath') {
        // The Flame Cloak gutters out in a burst of embers.
        sparks(x, y, z, 0xffb050, 22, 6, 0.8, 0.32);
        sparks(x, y, z, color, 12, 3.5, 0.6, 0.3);
        ring(x, z, color, 1.4, 3.2, 0.45);
        flash(x, y, z, 0xffd2a0, 5, 0.35);
        rise(x, z, 2, color, 14, 0.9, 2);
        return;
      }
      sparks(x, y, z, color, 16, 5, 0.6, 0.3);
      ring(x, z, color, 1.6, 2.6, 0.35);
      flash(x, y, z, color, 4.5, 0.3);
    },

    /** Bounty paid for a kill: a burst of coins. The HUD floats the amount above it. */
    gold(x, y, z) {
      sparks(x, y, z, GOLD, 7, 3.4, 0.7, 0.26);
      flash(x, y, z, 0xfff1b8, 2.2, 0.35);
      ring(x, z, GOLD, 0.2, 1.1, 0.4);
    },

    card(card, side, x, z) {
      const team = TEAM_COLOR[side];
      if (card.id === 'fireball') {
        fireball(side, { x, z }, card.radius, card.travelMs / 1000);
      } else if (card.id === 'lightning_bolt') {
        // Instant: no warning and no waiting, a white flash from a clear sky, and the stunned arcs on the ground.
        flashAt(x, 0.4, z, 0xffffff, card.radius * 3.4, 0.14);
        lightning(x, z, BOLT_CARD, card.radius, card.stunMs / 1000);
      } else if (card.id === 'healing_wave') {
        for (let i = 0; i < 3; i++) ring(x, z, i === 1 ? 0xd8ffe6 : 0x3dff8f, 0.3, card.radius, 0.8, i * 0.14);
        flashAt(x, 1, z, 0x3dff8f, card.radius * 2.6, 0.8);
        rise(x, z, card.radius, 0x7dffb0, 34, 1.5);
      } else {
        // Summoning flare where the troops or the building appear.
        ring(x, z, team, 0.2, card.radius, 0.5);
        ring(x, z, 0xffffff, 0.2, card.radius * 1.3, 0.75, 0.08);
        beam(x, z, team, card.radius * 1.4, 6, 0.7);
        flashAt(x, 0.8, z, team, card.radius * 2.6, 0.5);
        sparksAt(x, 0.4, z, team, 12, 4, 0.8);
      }
    },

    /**
     * `event` is the server's cast event: who cast, where the hero stood (x, z)
     * and where the ability landed (tx, tz). `ability` is the champion's own
     * entry of `CHAMPIONS`; its `id` chooses the effect.
     */
    cast({ side, x, z, tx, tz }, ability) {
      const colors = spellOf(side);
      // The hero turns to the spot and swings; a spell that lands later keeps its blade raised until it does.
      units.cast(side, tx, tz, ability.kind === 'shield' ? 0.3 : (ability.delayMs ?? 0) / 1000);
      switch (ability.id) {
        case 'slash_dash': {
          // Afterimages down the path, a streak of light, and a wide cut where it ends.
          const facing = Math.atan2(tx - x, tz - z);
          const y0 = groundHeight(x, z);
          const y1 = groundHeight(tx, tz);
          for (let i = 0; i < 4; i++) {
            ghost(side, x + ((tx - x) * i) / 4, z + ((tz - z) * i) / 4, facing, colors.slash, 0.55, i * 0.04);
          }
          ray({ x, y: y0 + 1.2, z }, { x: tx, y: y1 + 1.2, z: tz }, colors.slash, 1.8, 0.42);
          ray({ x, y: y0 + 1.25, z }, { x: tx, y: y1 + 1.25, z: tz }, 0xfff8e0, 0.5, 0.3);
          slash(tx, y1 + 1.3, tz, facing, colors.slash, 2.7, 0.5);
          slash(tx, y1 + 1.3, tz, facing, colors.slash, 2.3, -0.5);
          ring(tx, tz, colors.slash, 0.4, 2.4, 0.35);
          flashAt(tx, 1.3, tz, 0xfff6d0, 4.6, 0.3);
          sparksAt(tx, 1, tz, colors.slash, 14, 6, 0.55);
          break;
        }
        case 'aegis_shield':
          // The sphere itself is drawn on the hero for as long as the shield holds.
          ring(x, z, colors.shield, 0.4, 2.8, 0.5);
          ring(x, z, 0xffffff, 0.3, 2.2, 0.35, 0.05);
          beam(x, z, colors.shield, 2.4, 5, 0.5);
          flashAt(x, 1.4, z, colors.shield, 6, 0.45);
          sparksAt(x, 1.2, z, colors.shield, 12, 4, 0.6, 0.28);
          break;
        case 'thunder_strike':
          lightning(tx, tz, colors, ability.radius, ability.stunMs / 1000);
          break;
        case 'divine_judgment':
          pillar(tx, tz, ability.radius, colors, ability.delayMs / 1000, ability.durationMs / 1000, ability.tickMs / 1000);
          break;
        case 'magma_cleave':
          cleave(x, z, tx, tz, ability.range, ability.arc, colors);
          break;
        case 'flame_cloak': {
          // The cloak itself is drawn on the hero for as long as the shield holds.
          const reach = ability.auraRadius;
          ring(x, z, colors.shield, 0.4, reach * 1.1, 0.5);
          ring(x, z, colors.pillarCore, 0.3, reach * 0.85, 0.35, 0.05);
          beam(x, z, colors.shield, 2.2, 6, 0.6);
          flashAt(x, 1.4, z, colors.shield, 6, 0.45);
          sparksAt(x, 1.2, z, colors.pillarCore, 14, 4.5, 0.7, 0.28);
          rise(x, z, reach * 0.8, colors.shield, 22, 1.2, 2.2);
          break;
        }
        case 'obsidian_spike':
          spikes(x, z, tx, tz, ability.width, colors);
          break;
        case 'cataclysmic_meteor':
          meteor(tx, tz, ability.radius, colors, ability.delayMs / 1000, ability.burn.durationMs / 1000);
          break;
        default:
          throw new Error(`No effect for ability "${ability.id}"`);
      }
    },

    /** `event` is the server's item event: a relic bought, a blink from (x, z) to (tx, tz), or a rune drunk. */
    item({ side, key, x, z, tx, tz, bought, rune }) {
      const colors = spellOf(side);
      if (bought) {
        const color = key === 'Z' ? colors.blink : LIFESTEAL_COLOR;
        for (let i = 0; i < 2; i++) ring(x, z, color, 0.3, 2.6, 0.6, i * 0.14);
        beam(x, z, color, 1.6, 7, 0.8);
        flashAt(x, 1.3, z, color, 5, 0.5);
        sparksAt(x, 1.2, z, GOLD, 16, 5, 0.9, 0.28);
      } else if (key === 'Z') {
        // Blink Boots: the hero winks out in a flash, leaving a ghost, and arrives in a brighter one.
        ghost(side, x, z, null, colors.blink, 0.5);
        ring(x, z, colors.blink, 1.8, 0.2, 0.3);
        beam(x, z, colors.blink, 0.9, 9, 0.35);
        flashAt(x, 1.2, z, colors.blinkCore, 5, 0.3);
        ray({ x, y: groundHeight(x, z) + 1.2, z }, { x: tx, y: groundHeight(tx, tz) + 1.2, z: tz }, colors.blink, 0.45, 0.28);
        flashAt(tx, 1.2, tz, colors.blinkCore, 5.5, 0.45);
        flashAt(tx, 1.2, tz, colors.blink, 7.5, 0.65);
        ring(tx, tz, colors.blink, 0.3, 2.8, 0.45);
        ring(tx, tz, 0xffffff, 0.2, 1.8, 0.3, 0.04);
        beam(tx, tz, colors.blink, 1.7, 10, 0.5);
        sparksAt(tx, 0.8, tz, colors.blinkCore, 16, 5, 0.6);
      } else if (rune) {
        // The bottled rune, drunk.
        const color = RUNE_COLOR[rune];
        for (let i = 0; i < 3; i++) ring(x, z, color, 0.3, 3.2, 0.6, i * 0.13);
        beam(x, z, color, 2, 9, 0.8);
        flashAt(x, 1.3, z, color, 6.5, 0.5);
        sparksAt(x, 1, z, color, 18, 5.5, 0.9);
        rise(x, z, 1.4, color, 14, 1.1, 1.6);
      }
    },

    rune(kind) {
      const color = RUNE_COLOR[kind];
      beam(0, 0, color, 2.6, 13, 1.2);
      ring(0, 0, color, 0.4, 3.4, 0.9);
      ring(0, 0, 0xffffff, 0.4, 3.4, 1.1, 0.15);
      flashAt(0, 1.4, 0, color, 7, 0.8);
      sparksAt(0, 1, 0, color, 20, 5, 1.0);
    },

    runeTaken(kind) {
      const color = RUNE_COLOR[kind];
      ring(0, 0, color, 2.4, 0.3, 0.45);
      flashAt(0, 1.6, 0, color, 6, 0.5);
      sparksAt(0, 1.4, 0, color, 18, 6, 0.9);
    },

    ping(x, z) {
      for (let i = 0; i < 3; i++) ring(x, z, i === 1 ? 0xffffff : 0xffd766, 0.2, 1.7, 0.8, i * 0.22);
      beam(x, z, 0xffe9a0, 0.5, 5, 1.0);
    },

    /** A closing ring where the hero was told to go (or, in red, whom to attack). */
    marker(x, z, hostile) {
      const color = hostile ? 0xff5a4a : 0x6dffa8;
      ring(x, z, color, 1.3, 0.3, 0.34);
      ring(x, z, color, 0.8, 0.2, 0.34, 0.08);
      flashAt(x, 0.2, z, color, 1.8, 0.3);
    },

    /** A structure takes a hit: it shudders, and flashes if the blow was heavy. */
    hit(id, heavy) {
      const view = structures.get(id);
      if (!view) return;
      view.shake = Math.max(view.shake, heavy ? 0.3 : 0.1);
      if (heavy) flash(view.def.x, view.base + view.def.height * 0.45, view.def.z, 0xffc880, 4.5, 0.3);
    },

    destroyed(id) {
      const view = structures.get(id);
      if (!view || view.collapse >= 0) return;
      const { x, z, height, radius } = view.def;
      view.collapse = 0;
      view.halo.visible = false;
      view.range.visible = false;
      glare(x, view.base + height * 0.5, z, 0xffffff, radius * 5, 0.5);
      glare(x, view.base + height * 0.4, z, view.def.side === 'radiant' ? 0x59d2ff : 0xff6a14, radius * 8, 1.0);
      for (let i = 0; i < 3; i++) ring(x, z, 0xffe9c0, 0.4, radius * 2.4, 0.9, i * 0.15);
      sparks(x, view.base + height * 0.5, z, 0xffd9a0, 28, 8, 1.3, 0.5);
    },
  };

  /* ---------------------------------------------------------------- Units */

  await stage(0.66, 'Mustering the armies');
  const structureList = [...structures.values()];
  const watched = [null, null];
  const units = createUnitLayer({
    scene,
    envMap,
    // How the camera sees the world: the unit layer faces its health bars along these.
    view: {
      right: [rig.right.x, 0, rig.right.z],
      up: [rig.ahead.x * SIN_P, COS_P, rig.ahead.z * SIN_P],
      ahead: rig.ahead,
      tanPitch: rig.tanPitch,
    },
    heroes,
    fx,
    colors: { spell: spellOf, aegis: SPELL.aether_knight.shield, cloak: SPELL.morgath.shield, rune: RUNE_COLOR, lifesteal: LIFESTEAL_COLOR },
    glowTexture,
    // Attacks aimed at a Tower or Throne land part-way up it; a fallen one is no target.
    structurePoint(id) {
      const view = structureList[-id - 1];
      return view && view.collapse < 0 ? { x: view.def.x, y: view.base + view.def.height * 0.4, z: view.def.z } : null;
    },
  });

  /* ---------------------------------------------------------------- Frame loop */

  let width = 1;
  let height = 1;
  let time = 0;
  let lastTime = 0;
  let frameId = 0;
  let running = false;
  let fps = 60;
  let cpuMs = 0;
  /** Render-resolution multiplier. It steps down if frames run long, to hold 60 FPS on weak GPUs. */
  let quality = 1;
  /** Set from the console (runedeck.lockQuality) to keep full quality whatever the frame rate. */
  let qualityLocked = false;
  let sampleFrames = 0;
  let sampleTime = 0;
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);

  function applyResolution() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2) * quality;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    if (composer) {
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
      // Bloom is the first thing a struggling GPU gives up.
      bloomPass.enabled = quality > 0.7;
    }
    particles.uniforms.uPixels.value = (height * ratio) / (2 * tanHalfFov);
  }

  const api = {
    fx,
    /** Called once per rendered frame with (dt seconds, timestamp ms). */
    onFrame: null,
    /**
     * Called with (name, x, z, detail) whenever something on the field makes a noise that no
     * server event announces: an attack ('sword', 'clang', 'bow', 'staff', 'frost', 'slam', 'spin',
     * 'tower'), the Lifesteal Blade drinking ('drain'), a troop falling ('fall'), and the finale
     * ('rumble', 'blast', 'collapse').
     */
    onCue: null,

    /** The camera rig: pan, drag, zoom, follow, fly and footprint. See camera.js. */
    camera: rig,

    get pixelsPerUnit() {
      return rig.pixelsPerUnit;
    },

    /** Sizes the view for the window; `insets` (CSS pixels) is the part of it the HUD covers. */
    resize(nextWidth, nextHeight, insets = { top: 0, bottom: 0 }) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      rig.resize(width, height, insets);
      applyResolution();
      if (!running) render();
    },

    start() {
      if (running) return;
      running = true;
      sampleFrames = -30;
      sampleTime = 0;
      lastTime = performance.now();
      frameId = requestAnimationFrame(frame);
    },

    stop() {
      running = false;
      cancelAnimationFrame(frameId);
    },

    /** Restores every structure and clears units and effects, ready for a new match. */
    reset() {
      if (finaleRun) {
        // A finale in progress ends here, and whoever awaits it is released.
        finaleRun.live = false;
        finaleRun.resolve();
        finaleRun = null;
      }
      rig.release();
      // Finishing an effect can start another (a meteor ends in an explosion), so drain in passes.
      for (let pass = 0; effects.length && pass < 4; pass++) {
        for (const item of effects.splice(0)) item.done?.();
      }
      for (const view of structures.values()) {
        view.atk = -1;
        view.fire = 0;
        view.range.visible = true;
        view.shake = 0;
        view.collapse = -1;
        view.fall = 0.9;
        view.group.visible = true;
        view.group.scale.set(1, 1, 1);
        view.group.position.set(view.def.x, view.base, view.def.z);
        view.ruins.visible = false;
        view.halo.visible = true;
      }
      units.clear();
      api.setRune(null);
      api.setWaypoint(null);
      api.setPreview(null);
    },

    /**
     * Applies a server snapshot. Units glide to their new positions, and every
     * unit or structure whose attack counter changed swings or fires.
     */
    sync(state) {
      // The finale holds the field as it fell: later snapshots have no part in it.
      if (finaleRun) return;
      state.structures.forEach(([hp, atk, targetId], index) => {
        const view = structureList[index];
        if (view.atk !== -1 && atk !== view.atk && hp > 0) {
          const { def } = view;
          bolt(def.side === 'radiant' ? 'energy' : 'magma', { x: def.x, y: view.base + def.muzzle, z: def.z }, () => units.point(targetId), def.shotSpeed);
          cue('tower', def.x, def.z, { side: def.side });
          view.fire = 1;
        }
        view.atk = atk;
      });
      units.sync(state.units);
    },

    /**
     * Sets which champion each side fights as: `{ radiant, dire }`, each an id
     * of `CHAMPIONS`. Both sides may choose the same one. Call it after `reset()`
     * and before the match's first snapshot; a side left out keeps its champion.
     */
    setHeroes({ radiant, dire }) {
      for (const [side, champion] of [['radiant', radiant], ['dire', dire]]) {
        if (champion) heroes[side].setChampion(champion);
      }
      units.retune();
    },

    /**
     * The end of a match. Every unit and hero freezes where it stands, and the
     * camera is taken from the player and carried over `FINALE_PAN` seconds to
     * the structure that fell (`focus`, its id in `STRUCTURES`, or null for none):
     * a Throne is shaken, blown apart in three blasts and left as ruins, a Tower
     * simply falls. `onBlast` runs as it goes up. Resolves when the sequence is
     * over, after about six seconds for a Throne. Snapshots are ignored, and the
     * field and the camera stay as they are, until `reset()`.
     *
     * It may start after `fx.destroyed(focus)`: the collapse is wound back and
     * played again from the pan, so the player never sees the ruin early.
     */
    finale({ focus, onBlast }) {
      units.freeze();
      const view = structures.get(focus);
      if (!view) return Promise.resolve();
      if (finaleRun) {
        finaleRun.live = false;
        finaleRun.resolve();
      }
      return new Promise((resolve) => {
        const run = { live: true, resolve };
        finaleRun = run;
        const step = (delay, act) => later(delay, () => run.live && act());
        const { def } = view;
        const throne = def.kind === 'throne';

        view.collapse = -1;
        view.fall = throne ? 1.8 : 0.9;
        view.group.visible = true;
        view.group.scale.set(1, 1, 1);
        view.ruins.visible = false;
        view.halo.visible = true;
        view.range.visible = false;
        rig.cinema({ x: def.x, z: def.z, zoom: throne ? FINALE_ZOOM.throne : FINALE_ZOOM.tower, seconds: FINALE_PAN });

        const color = def.side === 'radiant' ? 0x59d2ff : 0xff6a14;
        const rumble = throne ? 0.8 : 0;
        // The ground is heard to shake from the moment the camera sets off until the blast.
        cue('rumble', def.x, def.z, { seconds: FINALE_PAN + rumble });
        if (throne) {
          step(FINALE_PAN, () => {
            view.shake = rumble;
            rig.jolt(FINALE_JOLT.rumble);
            ring(def.x, def.z, color, 0.5, def.radius * 3, 0.9);
            rise(def.x, def.z, def.radius, color, 20, 1.2, 2);
            glare(def.x, view.base + def.height * 0.5, def.z, color, def.radius * 5, 0.8);
          });
        }
        step(FINALE_PAN + rumble, () => {
          fx.destroyed(def.id);
          if (throne) {
            throneBlast(view);
          } else {
            rig.jolt(FINALE_JOLT.tower);
            cue('collapse', def.x, def.z);
          }
          onBlast?.();
        });
        // The collapse runs its course and the ruins lie there for a moment before the sequence ends.
        step(FINALE_PAN + rumble + view.fall + 0.9, () => resolve());
      });
    },

    /** Smoothed position of a side's hero: { x, y, z, facing, dead }, or null. */
    heroView: (side) => units.hero(side),

    /**
     * Where a unit or structure stands and whose it is, by its snapshot id:
     * { x, y, z, side, hero }, `y` being the top of it, or null if it is not on the field.
     */
    locate(id) {
      if (id > 0) return units.locate(id);
      const view = structureList[-id - 1];
      return view ? { x: view.def.x, y: view.base + view.def.height * 0.85, z: view.def.z, side: view.def.side, hero: false } : null;
    },

    /** Id of the enemy unit or structure of `side` at a ground point, or 0 for open ground. */
    pickTarget(x, z, side) {
      const id = units.pick(x, z, side);
      if (id) return id;
      // As with units, a click anywhere up a Tower's height counts: its body covers the ground beyond its foot.
      const index = structureList.findIndex(({ def, collapse }) => {
        if (def.side === side || collapse >= 0) return false;
        const reach = (def.height * 0.8) / rig.tanPitch;
        const along = Math.min(reach, Math.max(0, (x - def.x) * rig.ahead.x + (z - def.z) * rig.ahead.z));
        return Math.hypot(def.x + rig.ahead.x * along - x, def.z + rig.ahead.z * along - z) < def.radius + 0.3;
      });
      return index === -1 ? 0 : -(index + 1);
    },

    /** World position to CSS pixels inside the canvas. */
    project(x, y, z) {
      A.set(x, y, z).project(camera);
      return { x: (A.x * 0.5 + 0.5) * width, y: (0.5 - A.y * 0.5) * height };
    },

    /** Client coordinates to the point on the ground under them, whatever tier that ground is on. */
    pick(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
      raycaster.setFromCamera(pointer, camera);
      const { origin, direction } = raycaster.ray;
      if (direction.y > -0.01) return null;
      const below = (t) => origin.y + direction.y * t <= groundHeight(origin.x + direction.x * t, origin.z + direction.z * t);
      // Walk the ray down from the highest ground to the lowest, then close in on where it goes under.
      let near = (PICK_TOP - origin.y) / direction.y;
      const stride = (PICK_BOTTOM - PICK_TOP) / direction.y / 48;
      let far = near + stride;
      for (let i = 1; i < 48 && !below(far); i++) {
        near = far;
        far += stride;
      }
      for (let i = 0; i < 10; i++) {
        const mid = (near + far) / 2;
        if (below(mid)) far = mid;
        else near = mid;
      }
      return { x: origin.x + direction.x * far, z: origin.z + direction.z * far };
    },

    /** Shows the rune waiting on the River pad: a kind from RUNES, or null for an empty pad. */
    setRune(kind) {
      for (const name in runeGems) runeGems[name].visible = name === kind;
      runeBeam.visible = runeHalo.visible = Boolean(kind);
      if (!kind) return;
      runeBeam.material.color.set(RUNE_COLOR[kind]);
      runeHalo.material.color.set(RUNE_COLOR[kind]);
    },

    /** Marks where the hero is walking to ({ x, z }), or clears the mark with null. */
    setWaypoint(point) {
      waypoint.visible = Boolean(point);
      if (point) waypoint.position.set(point.x, groundHeight(point.x, point.z) + 0.09, point.z);
    },

    /** `preview` is null or { x, z, radius, valid, side, restricted }. */
    setPreview(preview) {
      previewRing.visible = previewHalo.visible = previewDisc.visible = Boolean(preview);
      forbidden.visible = Boolean(preview?.restricted);
      if (!preview) return;
      previewRadius = preview.radius;
      previewRing.material.color.set(preview.valid ? 0x4dff9a : 0xff3b30);
      previewHalo.material.color.set(preview.valid ? 0x4dff9a : 0xff3b30);
      previewDisc.material.color.set(preview.valid ? 0x2f9cff : 0xff3b30);
      for (const mesh of [previewRing, previewHalo, previewDisc]) mesh.position.set(preview.x, groundHeight(preview.x, preview.z) + 0.1, preview.z);
      if (preview.restricted) {
        // Everything from the near bank of the River to the enemy's edge.
        const bank = R.halfWidth + 1.4;
        const far = MAP.halfWidth + 1;
        const sign = preview.side === 'radiant' ? 1 : -1;
        forbidden.scale.set(far + bank, 1, (MAP.halfDepth + 1) * 2);
        forbidden.position.set((sign * (far - bank)) / 2, 0.09, 0);
      }
    },

    /** Diagnostics: hold full resolution and bloom even when the frame rate drops. */
    lockQuality(locked = true) {
      qualityLocked = locked;
      if (locked && quality !== 1) {
        quality = 1;
        applyResolution();
      }
    },

    stats() {
      return {
        fps: Math.round(fps),
        quality,
        cpuMs: +cpuMs.toFixed(2),
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        units: units.count(),
        pixelRatio: renderer.getPixelRatio(),
        programs: renderer.info.programs.length,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      };
    },
  };

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function frame(now) {
    if (!running) return;
    frameId = requestAnimationFrame(frame);
    const began = performance.now();
    // A frame queued before start() carries an older timestamp; time must never run backwards.
    const dt = Math.min(Math.max(0, (now - lastTime) / 1000), 0.1);
    lastTime = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.08;

    // Once a second's worth of frames averages under 45 FPS, render fewer pixels.
    // The first frames after start are skipped so load-time hitches do not count.
    if (++sampleFrames > 0) {
      sampleTime += dt;
      if (sampleFrames >= 60) {
        if (sampleTime / sampleFrames > 1 / 45 && quality > 0.5 && !qualityLocked) {
          quality = Math.max(0.5, quality - 0.17);
          applyResolution();
        }
        sampleFrames = 0;
        sampleTime = 0;
      }
    }

    advance(dt);
    api.onFrame?.(dt, now);
    render();
    keepPrograms();
    cpuMs += (performance.now() - began - cpuMs) * 0.1;
  }

  /** Moves everything on the battlefield forward by `dt` seconds. */
  function advance(dt) {
    time += dt;
    rig.update(dt);
    const { focus } = rig;
    // The shadow map looks a little past the focus, where more of the view lies.
    aimSun(focus.x + rig.ahead.x * 6, focus.z + rig.ahead.z * 6);
    scene.fog.near = FOG.near * rig.zoom;
    scene.fog.far = FOG.far * rig.zoom;
    terrain.update(time, focus.x, focus.z, rig.zoom);
    lavaFalls.update(time);
    wind.value = time;
    particles.uniforms.uTime.value = time;

    for (const torch of torches) {
      const t = time + torch.phase;
      const flicker = 0.8 + 0.12 * Math.sin(t * 13) + 0.08 * Math.sin(t * 29.3) + 0.06 * Math.sin(t * 47.1);
      torch.flame.scale.set(0.85 * torch.size * flicker, 1.5 * torch.size * (0.8 + 0.4 * flicker), 1);
      torch.flame.position.y = torch.y + 0.06 * Math.sin(t * 17);
      torch.core.scale.setScalar(0.42 * torch.size * flicker);
      torch.light.scale.setScalar(3.6 * torch.size * (0.85 + 0.3 * flicker));
      torch.light.material.opacity = 0.45 * flicker;
    }

    for (const view of structures.values()) {
      if (view.group.visible) view.model.update(time, dt, view.fire);
      view.fire = Math.max(0, view.fire - dt / 0.5);

      if (view.shake > 0) {
        view.shake = Math.max(0, view.shake - dt);
        view.group.position.x = view.def.x + Math.sin(time * 90) * view.shake * 0.3;
        view.group.position.z = view.def.z + Math.cos(time * 70) * view.shake * 0.2;
      }
      if (view.collapse >= 0 && view.collapse < 1) {
        view.collapse = Math.min(1, view.collapse + dt / view.fall);
        view.group.scale.y = 1 - 0.96 * view.collapse ** 2;
        if (view.collapse === 1) {
          view.group.visible = false;
          view.ruins.visible = true;
        }
      }
    }

    units.update(dt, time);
    // The Guardian watches whichever hero strays nearest its cavern.
    watched[0] = units.hero('radiant');
    watched[1] = units.hero('dire');
    dragon.update(time, dt, watched);

    if (previewRing.visible) {
      const pulse = Math.sin(time * 6);
      previewRing.scale.setScalar(previewRadius * (1 + 0.025 * pulse));
      previewHalo.scale.setScalar(previewRadius * (1 + 0.05 * pulse));
      previewDisc.scale.setScalar(previewRadius);
      previewHalo.material.opacity = 0.4 + 0.15 * pulse;
    }

    runeRing.rotation.y = time * 0.5;
    runeRing.material.opacity = 0.5 + 0.25 * Math.sin(time * 2);
    for (const name in runeGems) {
      runeGems[name].position.y = LEVEL.pad + 1.75 + Math.sin(time * 2) * 0.16;
      runeGems[name].rotation.y = time * 1.6;
    }
    pillarTexture.offset.x = time * 0.3;
    if (waypoint.visible) {
      waypoint.scale.setScalar(1 + 0.12 * Math.sin(time * 7));
      waypoint.rotation.y = time * 1.2;
    }
    padHalo.material.opacity = 0.4 + 0.12 * Math.sin(time * 2);

    for (const halo of halos) {
      if (!halo.sprite.visible) continue;
      const pulse = 0.5 + 0.5 * Math.sin(time * 1.8 + halo.phase);
      halo.sprite.scale.setScalar(halo.size * (0.94 + 0.1 * pulse));
      if (halo.sprite !== padHalo) halo.sprite.material.opacity = halo.opacity * (0.8 + 0.2 * pulse);
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      const item = effects[i];
      item.age += dt;
      if (item.age < 0) continue;
      const k = Math.min(item.age / item.duration, 1);
      // An update may return true to finish early, as a bolt does on impact.
      if (item.update(k, dt) === true || k >= 1) {
        item.done?.();
        effects.splice(i, 1);
      }
    }
  }

  /* ---------------------------------------------------------------- Preparation */

  /**
   * three.js deletes a shader program when the last material using it is
   * disposed, and compiles it again for the next one. Effects make and dispose
   * materials all match long, so each spell would stall a frame on a compile.
   * Holding one extra reference to every program keeps it alive for good.
   *
   * `usedTimes` is the renderer's own reference count (three.js r187). If a
   * later version drops it, this does nothing and effects merely compile again.
   */
  const kept = new WeakSet();
  let keptCount = 0;
  function keepPrograms() {
    const { programs } = renderer.info;
    if (!programs || programs.length === keptCount) return;
    for (const program of programs) {
      if (kept.has(program)) continue;
      kept.add(program);
      if (typeof program.usedTimes === 'number') program.usedTimes++;
    }
    keptCount = programs.length;
  }

  /** One of every unit, fighting, with every status effect a hero can carry. */
  function rehearsalState(step) {
    const flags = [
      FLAG.shielded | FLAG.empowered | FLAG.hasted | FLAG.regen | FLAG.lifesteal | FLAG.burning,
      FLAG.stunned | FLAG.slowed | FLAG.burning,
      FLAG.dead,
      0,
    ][step % 4];
    const list = [];
    SIDES.forEach((side, sideIndex) => {
      const sign = sideIndex ? 1 : -1;
      UNIT_TYPES.forEach((type, typeIndex) => {
        const id = 1 + sideIndex * UNIT_TYPES.length + typeIndex;
        // Every unit aims at its opposite number; each step is a fresh attack and a wound.
        const foe = 1 + (1 - sideIndex) * UNIT_TYPES.length + typeIndex;
        const x = sign * (3 + (step % 2) * 0.4);
        const z = (typeIndex - (UNIT_TYPES.length - 1) / 2) * 1.8;
        list.push([id, typeIndex, sideIndex, x, z, 1000 - step, step, foe, type === 'hero' ? flags : step === 1 ? FLAG.slowed | FLAG.burning : 0]);
      });
    });
    return {
      structures: STRUCTURES.map((def, index) => [def.maxHp, step, 1 + (index % (UNIT_TYPES.length * 2))]),
      units: list,
    };
  }

  /**
   * Every effect in the game, for both sides, as a list of steps. They are
   * played a few at a time: effects are dropped when too many run at once.
   * The two champions each play all their spells for both sides, so that both
   * models stand on both sides (a mirror match is two of one).
   */
  function rehearsalSteps() {
    const steps = [];
    const pairings = [
      { radiant: 'aether_knight', dire: 'morgath' },
      { radiant: 'morgath', dire: 'aether_knight' },
    ];
    pairings.forEach((pairing) => {
      steps.push(() => {
        api.setHeroes(pairing);
        // A frame of its own, with the heroes under every status effect, so that each model is drawn wearing its shield.
        api.sync(rehearsalState(0));
        advance(0.1);
        render();
        keepPrograms();
      });
      SIDES.forEach((side, sideIndex) => {
        const sign = sideIndex ? 1 : -1;
        const x = sign * 3;
        const tx = sign * 6;
        const y = groundHeight(x, 0) + 1.2;
        for (const ability of CHAMPIONS[pairing[side]].abilities) steps.push(() => fx.cast({ side, x, z: 0, tx, tz: 2 }, ability));
        steps.push(() => {
          fx.heroSlash(side, x, y, 0, 0);
          fx.heroSlash(side, x, y, 0, 1);
          fx.drain({ x, y, z: 0 }, { x: tx, y, z: 0 });
          fx.shieldBreak(side, x, y, 0);
          fx.levelUp(side);
        });
      });
    });
    SIDES.forEach((side, sideIndex) => {
      const sign = sideIndex ? 1 : -1;
      const x = sign * 3;
      const tx = sign * 6;
      for (const key of ['Z', 'X']) steps.push(() => fx.item({ side, key, x, z: 0, bought: true }));
      steps.push(() => fx.item({ side, key: 'Z', x, z: 0, tx, tz: -2 }));
      for (const rune in RUNES) steps.push(() => fx.item({ side, key: 'C', x, z: 0, rune }));
      for (const card of CARDS) steps.push(() => fx.card(card, side, tx, 3));
    });
    for (const kind in RUNES) {
      steps.push(() => {
        api.setRune(kind);
        fx.rune(kind);
        fx.runeTaken(kind);
      });
    }
    steps.push(() => {
      fx.gold(0, 2, 4);
      fx.ping(2, -4);
      fx.marker(-2, 4, false);
      fx.marker(-2, -4, true);
      api.setWaypoint({ x: 1, z: 5 });
    });
    // The deployment preview in each of its colours, with and without the forbidden zone.
    for (const valid of [true, false]) {
      steps.push(() => api.setPreview({ x: 0, z: -4, radius: 2, valid, side: valid ? 'radiant' : 'dire', restricted: !valid }));
    }
    for (const view of structureList) steps.push(() => fx.hit(view.def.id, true));
    // The blasts that end a match, which the finale itself would show only after its camera had flown there.
    for (const view of structureList) if (view.def.kind === 'throne') steps.push(() => throneBlast(view));
    for (const view of structureList) steps.push(() => fx.destroyed(view.def.id));
    return steps;
  }

  /**
   * Compiles every shader and plays a short battle off screen, so that the
   * first spell, deployment or collapse of the real match finds its shaders,
   * textures and buffers already on the graphics card.
   */
  async function prepare() {
    await stage(0.72, 'Compiling shaders');
    width = 320;
    height = 180;
    rig.resize(width, height, { top: 0, bottom: 0 });
    applyResolution();

    // Hidden and off-screen objects are skipped by the renderer, so show everything once.
    const hidden = [];
    const culled = [];
    const uncull = (object) => {
      if (!object.frustumCulled) return;
      culled.push(object);
      object.frustumCulled = false;
    };
    scene.traverse((object) => {
      uncull(object);
      if (object.visible) return;
      hidden.push(object);
      object.visible = true;
    });
    try {
      await renderer.compileAsync(scene, camera);
      await breathe();
      render();
      keepPrograms();
      // The scenery is on the graphics card now; only what the rehearsal adds still needs drawing unseen.
      for (const object of culled.splice(0)) object.frustumCulled = true;

      // Some graphics drivers finish preparing a shader only when it first fills
      // pixels, so the camera looks over every part of the map once.
      await stage(0.78, 'Surveying the battlefield');
      const COLUMNS = 5;
      const ROWS = 3;
      for (let i = 0; i < COLUMNS * ROWS; i++) {
        const column = i % COLUMNS;
        const row = Math.floor(i / COLUMNS);
        rig.lookAt(((column / (COLUMNS - 1)) * 2 - 1) * (MAP.halfWidth - 4), ((row / (ROWS - 1)) * 2 - 1) * (MAP.halfDepth - 8), true);
        advance(0);
        render();
        if (i % 3 === 2) await stage(0.78 + (0.08 * (i + 1)) / (COLUMNS * ROWS), 'Surveying the battlefield');
      }
      keepPrograms();
      for (const object of hidden.splice(0)) object.visible = false;
      rig.lookAt(0, 0, true);
      const scenery = new Set();
      scene.traverse((object) => scenery.add(object));

      await stage(0.86, 'Rehearsing the battle');
      const steps = rehearsalSteps();
      const total = steps.length;
      const SYNC_EVERY = 8;
      /** Frames that follow the last step, for effects that unfold over seconds (a meteor, a pillar of light). */
      const TAIL = 36;
      let tail = TAIL;
      for (let i = 0; tail > 0; i++) {
        // Effects are dropped when frames stop coming; the rehearsal must not look like a stall.
        lastTime = performance.now();
        if (i % SYNC_EVERY === 0) api.sync(rehearsalState(i / SYNC_EVERY));
        for (let n = 0; n < 4 && steps.length && effects.length < 300; n++) steps.shift()();
        if (!steps.length) tail--;
        // The last units fall, so their deaths are rehearsed too.
        if (tail === 8) api.sync({ structures: rehearsalState(0).structures, units: [] });
        advance(0.1);
        scene.traverse((object) => {
          if (!scenery.has(object)) uncull(object);
        });
        render();
        // Before the effects end and let go of their shaders.
        keepPrograms();
        if (i % 4 === 3) {
          const k = (total - steps.length + TAIL - tail) / (total + TAIL);
          await stage(0.86 + 0.14 * k, 'Rehearsing the battle');
        }
      }
    } finally {
      for (const object of hidden) object.visible = false;
      for (const object of culled) object.frustumCulled = true;
    }
  }

  await prepare();
  api.reset();
  fps = 60;
  report(1, 'Battlefield ready');
  return api;
}
