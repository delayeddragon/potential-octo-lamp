/**
 * RuneDeck — unit render layer.
 *
 * Draws everything that moves: lane creeps, card troops, Frost Towers and both
 * heroes, with their health bars, ground rings and attack animations. Positions
 * come from server snapshots and are smoothed between them.
 *
 * Each unit type is one instanced rig per side (troops.js): a sculpted model
 * on a small skeleton, posed for every unit on every frame and drawn in one
 * call. All health bars, all ground decals and all weapon trails are one draw
 * call each, so a full battlefield costs about twenty draw calls however many
 * units are on it.
 *
 * The two heroes are rigs of their own (heroes.js) and wear their buffs here:
 * the Aegis sphere or Morgath's Flame Cloak, the rune auras, the Lifesteal
 * Blade's crimson wisps. Anything on fire (`FLAG.burning`) sheds flames.
 *
 * Animation is driven by three numbers per unit: `gait` and `moving` for the
 * walk, and `strike` for the attack (+1 wound up, -1 struck through, 0 ready).
 * An attack arrives from the server as it lands, so a unit that is due to
 * strike winds up beforehand (`ready`) and the blow itself is quick.
 */

import * as THREE from 'three';

import { canvasTexture, seededRandom } from './geometry.js';
import { FLAG, MATCH, SIDES, UNITS, UNIT_TYPES, groundHeight } from './shared.js';
import { PALETTE, TROOPS, createTroop } from './troops.js';

const TAU = Math.PI * 2;
const CAPACITY = 128;
/** Seconds a unit takes to reach its newest snapshot position; a little over the snapshot interval. */
const LERP_S = (MATCH.snapshotMs / 1000) * 1.2;
/** Seconds before its next attack is due that a unit starts to wind up, and how long it holds the pose if none comes. */
const ANTICIPATE_S = 0.3;
const HOLD_S = 0.35;
const DEATH_S = 0.4;
/** A jump longer than this is a blink or a respawn and is shown instantly. */
const TELEPORT = 6.4;
/** How far to each side the ground is sampled for its slope, and the step in height that counts as a ledge. */
const SLOPE_PROBE = 0.3;
const LEDGE = 0.4;
/** Flames alive at once, across every burning unit and the Flame Cloak's ring. */
const FLAMES = 220;
/** How far the Flame Cloak's fire reaches round the hero (the ability's `auraRadius`). */
const CLOAK_RADIUS = 3;

/* -------------------------------------------------------------------------- */
/* Shaders                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The hand-written shaders work in display (sRGB) colours. The frame is linear
 * HDR, so each one decodes its result with this before the standard output conversion.
 */
export const GLSL_TO_LINEAR = /* glsl */ `
vec3 toLinear(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;

/** Camera-facing quads, spanned by the camera's own right and up vectors (which never change: it only pans). */
const barVertex = (right, up) => /* glsl */ `
attribute vec3 aAnchor;
attribute vec2 aSize;
attribute vec4 aFill;   // rgb colour, a = health fraction
varying vec2 vUv;
varying vec4 vFill;
varying float vAspect;
void main() {
  vUv = uv;
  vFill = aFill;
  vAspect = aSize.x / aSize.y;
  vec3 world = aAnchor + vec3(${right.map((n) => n.toFixed(4)).join(', ')}) * (position.x * aSize.x)
             + vec3(${up.map((n) => n.toFixed(4)).join(', ')}) * (position.y * aSize.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const BAR_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec4 vFill;
varying float vAspect;
${GLSL_TO_LINEAR}
void main() {
  float frameX = 0.2 / vAspect;
  vec2 edge = min(vUv, 1.0 - vUv);
  float inner = (vUv.x - frameX) / (1.0 - 2.0 * frameX);
  vec3 col = inner <= vFill.a ? vFill.rgb * (0.65 + 0.7 * vUv.y) : vec3(0.05, 0.06, 0.1);
  if (edge.y < 0.2 || edge.x < frameX) col = vec3(0.0);
  gl_FragColor = vec4(toLinear(col), 0.95);
  #include <colorspace_fragment>
}
`;

const DECAL_VERTEX = /* glsl */ `
attribute vec3 aAnchor;
attribute vec4 aParams;   // x: radius, y: kind (0 shadow, 1 team ring, 2 thin range ring), z: opacity
attribute vec2 aSlope;    // rise of the ground per unit of x and of z, so the disc lies along it
attribute vec3 aTint;
varying vec2 vUv;
varying vec4 vParams;
varying vec3 vTint;
void main() {
  vUv = uv;
  vParams = aParams;
  vTint = aTint;
  vec3 disc = position * aParams.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(aAnchor + vec3(disc.x, dot(aSlope, disc.xz), disc.z), 1.0);
}
`;

const DECAL_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec4 vParams;
varying vec3 vTint;
${GLSL_TO_LINEAR}
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = vParams.y < 0.5 ? smoothstep(1.0, 0.25, r)
          : vParams.y < 1.5 ? smoothstep(0.1, 0.03, abs(r - 0.86))
          : smoothstep(0.014, 0.004, abs(r - 0.98));
  gl_FragColor = vec4(toLinear(vTint), a * vParams.z);
  #include <colorspace_fragment>
}
`;

/** A weapon's trail: a band round part of a circle, standing in the plane of the cut. */
const TRAIL_VERTEX = /* glsl */ `
attribute vec3 aAnchor;
attribute vec4 aFrame;   // heading, roll of the cut's plane, reach, how far round the blade has come (0..1)
attribute vec4 aTint;    // rgb colour, a = opacity
varying vec2 vUv;
varying float vHead;
varying vec4 vTint;
void main() {
  vUv = uv;
  vHead = aFrame.w;
  vTint = aTint;
  vec3 p = position * aFrame.z;
  float c = cos(aFrame.y), s = sin(aFrame.y);
  p = vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
  c = cos(aFrame.x), s = sin(aFrame.x);
  p = vec3(p.x * c + p.z * s, p.y, p.z * c - p.x * s);
  gl_Position = projectionMatrix * viewMatrix * vec4(aAnchor + p, 1.0);
}
`;

const TRAIL_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying float vHead;
varying vec4 vTint;
${GLSL_TO_LINEAR}
void main() {
  // Bright at the blade, fading back along the way it came; sharp at the tip's edge, soft towards the hand.
  float along = smoothstep(vHead - 0.5, vHead, vUv.x) * step(vUv.x, vHead);
  float across = vUv.y * vUv.y * smoothstep(1.0, 0.9, vUv.y);
  float a = along * along * across * vTint.a;
  gl_FragColor = vec4(toLinear(mix(vTint.rgb, vec3(1.0), along * across * 0.5)) * 1.25 * a, 1.0);
  #include <colorspace_fragment>
}
`;

/** The arc of a downward cut, from over the shoulder (behind and above) to low in front. */
const TRAIL_ARC = { from: 2.25, to: -0.55, inner: 0.66, steps: 18 };

function trailGeometry() {
  const { from, to, inner, steps } = TRAIL_ARC;
  const positions = [];
  const uvs = [];
  const index = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const angle = from + (to - from) * u;
    for (const [radius, v] of [[inner, 0], [1, 1]]) {
      positions.push(0, Math.sin(angle) * radius, Math.cos(angle) * radius);
      uvs.push(u, v);
    }
    if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2, i * 2 - 1, i * 2 + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  return geometry;
}

function instancedQuads(plane, attributes, material, renderOrder) {
  const geometry = new THREE.InstancedBufferGeometry().copy(plane);
  plane.dispose();
  const arrays = {};
  for (const [name, size, count] of attributes) {
    arrays[name] = new Float32Array(count * size);
    const attribute = new THREE.InstancedBufferAttribute(arrays[name], size);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
  }
  geometry.instanceCount = 0;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return { mesh, geometry, arrays };
}

/** Shortest turn from one heading to another, taking `amount` (0..1) of it. */
function turn(from, to, amount) {
  const delta = ((((to - from + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return from + delta * Math.min(1, amount);
}

/* -------------------------------------------------------------------------- */
/* Layer                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param kit.scene          scene to draw into
 * @param kit.envMap         prefiltered environment for the models' metal to reflect
 * @param kit.view           how the camera sees the world: { right, up } as [x, y, z], `ahead` (up-screen along the ground,
 *                           { x, z }) and tanPitch
 * @param kit.heroes         hero models (heroes.js) built by the battlefield, by side
 * @param kit.fx             effect primitives: bolt, ray, slam, sparks, ring, flash, beam, rise, heroSlash, drain, shieldBreak,
 *                           and `cue(name, x, z, detail)` for what an attack or a death sounds like
 * @param kit.colors         { spell: (side) -> the colours of that side's champion, aegis, cloak, rune: by kind, lifesteal }
 * @param kit.glowTexture    soft round sprite texture
 * @param kit.structurePoint id (negative) -> aim point on a Tower or Throne, or null if it has fallen
 */
export function createUnitLayer({ scene, envMap, view, heroes, fx, colors, glowTexture, structurePoint }) {
  const { ahead, tanPitch } = view;

  /* ---------------------------------------------------------------- Instanced unit meshes */

  const WHITE = new THREE.Color(1, 1, 1);
  const FLASH = new THREE.Color(2.4, 2.4, 2.4);
  const kinds = new Map();
  for (const type of UNIT_TYPES) {
    if (!TROOPS[type]) continue;
    for (const side of SIDES) {
      const troop = createTroop(type, side, CAPACITY, envMap);
      const { mesh } = troop.rig;
      // Allocates the per-instance colour buffer, used for hit flashes and the frost tint.
      mesh.setColorAt(0, WHITE);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
      kinds.set(`${type}:${side}`, { troop, rig: troop.rig, mesh, count: 0 });
    }
  }

  const bars = instancedQuads(
    new THREE.PlaneGeometry(1, 1),
    [['aAnchor', 3, CAPACITY], ['aSize', 2, CAPACITY], ['aFill', 4, CAPACITY]],
    new THREE.ShaderMaterial({ vertexShader: barVertex(view.right, view.up), fragmentShader: BAR_FRAGMENT, transparent: true, depthTest: false, depthWrite: false }),
    10,
  );
  const decals = instancedQuads(
    new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
    [['aAnchor', 3, CAPACITY * 3], ['aParams', 4, CAPACITY * 3], ['aSlope', 2, CAPACITY * 3], ['aTint', 3, CAPACITY * 3]],
    new THREE.ShaderMaterial({ vertexShader: DECAL_VERTEX, fragmentShader: DECAL_FRAGMENT, transparent: true, depthWrite: false }),
    1,
  );
  const trails = instancedQuads(
    trailGeometry(),
    [['aAnchor', 3, CAPACITY], ['aFrame', 4, CAPACITY], ['aTint', 4, CAPACITY]],
    new THREE.ShaderMaterial({ vertexShader: TRAIL_VERTEX, fragmentShader: TRAIL_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    3,
  );
  scene.add(bars.mesh, decals.mesh, trails.mesh);

  // These run for every unit on every frame, so they write straight into the buffers.
  function addBar(x, y, z, width, height, fraction, rgb) {
    if (bars.geometry.instanceCount >= CAPACITY) return;
    const i = bars.geometry.instanceCount++;
    const { aAnchor, aSize, aFill } = bars.arrays;
    aAnchor[i * 3] = x;
    aAnchor[i * 3 + 1] = y;
    aAnchor[i * 3 + 2] = z;
    aSize[i * 2] = width;
    aSize[i * 2 + 1] = height;
    aFill[i * 4] = rgb[0];
    aFill[i * 4 + 1] = rgb[1];
    aFill[i * 4 + 2] = rgb[2];
    aFill[i * 4 + 3] = fraction;
  }

  const tint = new THREE.Color();
  /** The streak a blade leaves: `head` is how far round its arc the blade has come. */
  function addTrail(x, y, z, heading, roll, reach, head, opacity, hex) {
    if (trails.geometry.instanceCount >= CAPACITY) return;
    const i = trails.geometry.instanceCount++;
    const { aAnchor, aFrame, aTint } = trails.arrays;
    tint.setHex(hex, THREE.LinearSRGBColorSpace);
    aAnchor[i * 3] = x;
    aAnchor[i * 3 + 1] = y;
    aAnchor[i * 3 + 2] = z;
    aFrame[i * 4] = heading;
    aFrame[i * 4 + 1] = roll;
    aFrame[i * 4 + 2] = reach;
    aFrame[i * 4 + 3] = head;
    aTint[i * 4] = tint.r;
    aTint[i * 4 + 1] = tint.g;
    aTint[i * 4 + 2] = tint.b;
    aTint[i * 4 + 3] = opacity;
  }

  function addDecal(x, y, z, radius, kind, opacity, hex, slopeX = 0, slopeZ = 0) {
    if (decals.geometry.instanceCount >= CAPACITY * 3) return;
    const i = decals.geometry.instanceCount++;
    const { aAnchor, aParams, aSlope, aTint } = decals.arrays;
    aSlope[i * 2] = slopeX;
    aSlope[i * 2 + 1] = slopeZ;
    tint.setHex(hex, THREE.LinearSRGBColorSpace);
    aAnchor[i * 3] = x;
    aAnchor[i * 3 + 1] = y;
    aAnchor[i * 3 + 2] = z;
    aParams[i * 4] = radius;
    aParams[i * 4 + 1] = kind;
    aParams[i * 4 + 2] = opacity;
    aTint[i * 3] = tint.r;
    aTint[i * 3 + 1] = tint.g;
    aTint[i * 3 + 2] = tint.b;
  }

  /* ---------------------------------------------------------------- Hero extras */

  const additive = (color, opacity) => ({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  /** A colour pushed past white, so the bloom pass makes it glow. */
  const hot = (hex, boost = 1.6) => new THREE.Color(hex).multiplyScalar(boost);
  const shellGeometry = new THREE.IcosahedronGeometry(1, 3);
  const latticeGeometry = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.03, 1));
  const hoopGeometry = new THREE.TorusGeometry(1.15, 0.024, 6, 56);
  const auraGeometry = new THREE.IcosahedronGeometry(1, 2);

  /**
   * Tongues of fire, bright at the foot and fading to nothing at the tip. The
   * Flame Cloak wraps them round the hero, and they are scrolled round it.
   */
  const tongueTexture = canvasTexture(256, 128, (g, w, h) => {
    const random = seededRandom(23);
    for (let i = 0; i < 18; i++) {
      const x = (i / 18) * w + random() * 6;
      const width = 9 + random() * 9;
      const top = h * (0.08 + random() * 0.4);
      g.fillStyle = `rgba(255, 255, 255, ${(0.55 + random() * 0.45).toFixed(3)})`;
      g.beginPath();
      g.moveTo(x - width, h);
      g.quadraticCurveTo(x - width * 0.6, h * 0.55, x + (random() - 0.5) * 8, top);
      g.quadraticCurveTo(x + width * 0.6, h * 0.55, x + width, h);
      g.fill();
    }
    g.globalCompositeOperation = 'destination-in';
    const fade = g.createLinearGradient(0, h, 0, 0);
    fade.addColorStop(0, 'rgba(255, 255, 255, 1)');
    fade.addColorStop(0.6, 'rgba(255, 255, 255, 0.75)');
    fade.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = fade;
    g.fillRect(0, 0, w, h);
  });
  tongueTexture.wrapS = THREE.RepeatWrapping;
  const cloakGeometry = new THREE.CylinderGeometry(0.86, 1.2, 1, 28, 1, true).translate(0, 0.5, 0);

  for (const side of SIDES) {
    const hero = heroes[side];
    const sprite = (hex, size) => {
      const node = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, ...additive(hot(hex), 1) }));
      node.scale.setScalar(size);
      return node;
    };

    // Aegis Shield: a sphere of energy, a lattice turning inside it and two hoops orbiting it.
    const shell = new THREE.Mesh(shellGeometry, new THREE.MeshBasicMaterial({ ...additive(hot(colors.aegis, 1.1), 0.2), side: THREE.DoubleSide }));
    const lattice = new THREE.LineSegments(latticeGeometry, new THREE.LineBasicMaterial(additive(hot(colors.aegis, 2.2), 0.8)));
    const hoops = [0, 1].map(() => {
      const hoop = new THREE.Mesh(hoopGeometry, new THREE.MeshBasicMaterial(additive(hot(0xfff3c4, 2.2), 0.9)));
      hoop.rotation.order = 'YXZ';
      return hoop;
    });
    const shield = new THREE.Group();
    shield.position.y = 1.4;
    shield.add(shell, lattice, ...hoops);

    // Flame Cloak: two shells of fire turning against each other round the hero.
    const cloakShell = (hex, boost, opacity) => {
      const texture = tongueTexture.clone();
      texture.needsUpdate = true;
      texture.wrapS = THREE.RepeatWrapping;
      return new THREE.Mesh(cloakGeometry, new THREE.MeshBasicMaterial({ map: texture, ...additive(hot(hex, boost), opacity), side: THREE.DoubleSide }));
    };
    const cloakOuter = cloakShell(0xff6a1a, 1.5, 0.85);
    const cloakInner = cloakShell(0xffd37a, 1.6, 0.9);
    cloakOuter.scale.set(1, 3.3, 1);
    cloakInner.scale.set(0.74, 2.7, 0.74);
    const cloak = new THREE.Group();
    cloak.add(cloakOuter, cloakInner);

    // Double Damage: a flickering shell of amber fire.
    const power = new THREE.Mesh(auraGeometry, new THREE.MeshBasicMaterial({ ...additive(hot(colors.rune.damage, 1.4), 0.22), side: THREE.DoubleSide }));
    power.position.y = 1.35;

    // Lifesteal Blade: crimson wisps circling the hero. Stun: sparks circling its head.
    const wisps = [0, 1, 2].map(() => sprite(colors.lifesteal, 0.5));
    const stars = [0, 1, 2].map(() => sprite(0xfff2a0, 0.42));

    for (const node of [shield, cloak, power, ...wisps, ...stars]) {
      node.visible = false;
      hero.group.add(node);
    }
    Object.assign(hero, { shield, shell, lattice, hoops, cloak, cloakOuter, cloakInner, power, wisps, stars });
  }

  /* ---------------------------------------------------------------- Flames */

  // A teardrop that is white-hot at its heart, drawn up into a point.
  const flameTexture = canvasTexture(64, 96, (g, w, h) => {
    g.beginPath();
    g.moveTo(w / 2, 2);
    g.bezierCurveTo(w * 0.92, h * 0.42, w * 0.98, h * 0.82, w / 2, h - 2);
    g.bezierCurveTo(w * 0.02, h * 0.82, w * 0.08, h * 0.42, w / 2, 2);
    g.clip();
    const heart = g.createRadialGradient(w / 2, h * 0.7, 0, w / 2, h * 0.7, h * 0.52);
    heart.addColorStop(0, 'rgba(255, 255, 255, 1)');
    heart.addColorStop(0.5, 'rgba(255, 255, 255, 0.8)');
    heart.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = heart;
    g.fillRect(0, 0, w, h);
  });
  // One material per tone, shared by the whole pool: a flame is a sprite that rises and shrinks.
  const flameTones = [0xffe27a, 0xff8a1f, 0xe8321a].map((hex) => new THREE.SpriteMaterial({ map: flameTexture, ...additive(hot(hex, 1.5), 1) }));
  const flameGroup = new THREE.Group();
  scene.add(flameGroup);
  const flames = Array.from({ length: FLAMES }, (_, i) => {
    const sprite = new THREE.Sprite(flameTones[i % flameTones.length]);
    sprite.center.set(0.5, 0.08);
    sprite.visible = false;
    flameGroup.add(sprite);
    return { sprite, age: 1, life: 1, size: 1, vx: 0, vy: 0, vz: 0 };
  });
  let nextFlame = 0;

  /** Lights a flame at (x, y, z) of about `size` world units; the oldest is put out if the pool is full. */
  function ignite(x, y, z, size) {
    const flame = flames[nextFlame];
    nextFlame = (nextFlame + 1) % FLAMES;
    flame.age = 0;
    flame.life = 0.45 + Math.random() * 0.4;
    flame.size = size * (0.7 + Math.random() * 0.6);
    flame.vx = (Math.random() - 0.5) * 0.5;
    flame.vy = 1.2 + Math.random() * 1.3;
    flame.vz = (Math.random() - 0.5) * 0.5;
    flame.sprite.position.set(x, y, z);
    flame.sprite.visible = true;
  }

  function burnFlames(dt, time) {
    for (const flame of flames) {
      if (flame.age >= 1) continue;
      flame.age = Math.min(1, flame.age + dt / flame.life);
      const { sprite } = flame;
      if (flame.age >= 1) {
        sprite.visible = false;
        continue;
      }
      sprite.position.x += flame.vx * dt;
      sprite.position.y += flame.vy * dt;
      sprite.position.z += flame.vz * dt;
      // Flames lick: they swell as they leave the fuel, then thin out to a point.
      const body = Math.sin(Math.min(1, flame.age * 5) * (Math.PI / 2)) * (1 - flame.age) ** 0.7;
      const lick = 1 + 0.12 * Math.sin(time * 21 + flame.size * 40);
      sprite.scale.set(flame.size * 0.8 * body * lick, flame.size * 1.5 * body, 1);
    }
  }

  /** Sheds flames from a burning unit: `rate` a second, over the height of its body. */
  function kindle(view, dt, rate) {
    view.kindle += dt * rate;
    const body = view.def.height * view.scale;
    while (view.kindle >= 1) {
      view.kindle -= 1;
      const angle = Math.random() * TAU;
      const reach = Math.sqrt(Math.random()) * view.def.radius * 0.8;
      ignite(view.x + Math.cos(angle) * reach, view.y + body * (0.05 + Math.random() * 0.5), view.z + Math.sin(angle) * reach, 0.55 + body * 0.2);
    }
  }

  /* ---------------------------------------------------------------- Views */

  /** id -> view of a unit in the latest snapshot. */
  const views = new Map();
  /** Fallen units, still drawn while they shrink away. */
  const dying = [];
  const heroViews = { radiant: null, dire: null };
  let stamp = 0;
  /** Held still for the end of a match: every view keeps the pose it had at `heldTime`. */
  let frozen = false;
  let heldTime = 0;

  function createView(id, type, side, x, z, hp, atk) {
    const def = UNITS[type];
    return {
      id,
      type,
      def,
      side,
      kind: kinds.get(`${type}:${side}`),
      /** Timing of its attack animation: { swing (seconds), windup, impact (fractions of it) }. */
      spec: type === 'hero' ? heroes[side].spec : TROOPS[type],
      palette: PALETTE[side],
      scale: def.scale ?? 1,
      x,
      z,
      y: groundHeight(x, z),
      /** Rise of the ground underfoot per unit of x and of z. */
      slopeX: 0,
      slopeZ: 0,
      fromX: x,
      fromZ: z,
      toX: x,
      toZ: z,
      t: 1,
      facing: side === 'radiant' ? Math.PI / 2 : -Math.PI / 2,
      hp,
      atk,
      targetId: 0,
      flags: 0,
      /** 1 as an attack lands, running down to 0 over the swing. */
      swing: 0,
      /** The attack pose: +1 wound up, -1 struck through, 0 at the ready. */
      strike: 0,
      /** Wind-up ahead of an attack that is due, where the last one started from, and seconds since it. */
      ready: 0,
      windAt: 0,
      since: 60,
      /** A Frost Tower's recoil after a shot (1 -> 0), and the extra turn its rings have picked up. */
      fire: 0,
      spun: 0,
      spawn: 0,
      flash: 0,
      moving: 0,
      /** Stride phase, advanced by the ground covered. */
      gait: 0,
      /** Seconds since the Aegis Shield or Flame Cloak went up, and since the last buff particles were shed. */
      shieldAge: 0,
      shed: 0,
      /** Flames owed to a burning unit (whole flames are lit as it adds up). */
      kindle: 0,
      /** A cast in progress: seconds of the pose still to hold before the blow, and the heading the caster turns to. */
      hold: 0,
      aim: 0,
      aimFor: 0,
      life: 1,
      phase: (id * 2.399) % TAU,
      stamp: 0,
    };
  }

  /** Where attacks aimed at `id` should land: chest height on a unit, mid-height on a structure. */
  function point(id) {
    if (id < 0) return structurePoint(id);
    const view = views.get(id);
    if (!view || view.flags & FLAG.dead) return null;
    return { x: view.x, y: view.y + view.def.height * 0.55, z: view.z };
  }

  function sync(list) {
    stamp++;
    for (const [id, typeIndex, sideIndex, x, z, hp, atk, targetId, flags] of list) {
      let view = views.get(id);
      if (!view) {
        view = createView(id, UNIT_TYPES[typeIndex], SIDES[sideIndex], x, z, hp, atk);
        views.set(id, view);
        if (view.type === 'hero') heroViews[view.side] = view;
      } else if (Math.hypot(x - view.x, z - view.z) > TELEPORT) {
        Object.assign(view, { x, z, fromX: x, fromZ: z, toX: x, toZ: z, t: 1 });
      } else {
        Object.assign(view, { fromX: view.x, fromZ: view.z, toX: x, toZ: z, t: 0 });
      }
      if (hp < view.hp) view.flash = 1;
      const before = view.flags;
      view.hp = hp;
      view.flags = flags;
      view.stamp = stamp;
      if (view.type === 'hero') {
        if ((before ^ flags) & FLAG.dead) heroChanged(view);
        if (flags & FLAG.shielded & ~before) view.shieldAge = 0;
        // The shield ran out or was beaten down.
        if (before & FLAG.shielded & ~flags && !(flags & FLAG.dead)) fx.shieldBreak(view.side, view.x, view.y + 1.4, view.z);
      }
      if (atk !== view.atk) {
        view.atk = atk;
        view.targetId = targetId;
        if (!(flags & FLAG.dead)) attack(view);
      }
    }
    for (const view of views.values()) {
      if (view.stamp === stamp) continue;
      views.delete(view.id);
      if (view.type === 'hero') heroViews[view.side] = null;
      else die(view);
    }
  }

  /** Plays the unit's attack: a projectile, an ice beam, a ground slam or a melee swing. */
  function attack(view) {
    view.swing = 1;
    view.windAt = view.ready;
    view.ready = 0;
    view.since = 0;
    const { def, spec } = view;
    // What the blow sounds like. A golem's fists are heard when they land, a moment after the swing begins.
    if (def.slam) fx.cue('slam', view.x, view.z, { delay: spec.swing * spec.impact });
    else fx.cue(def.spin ? 'spin' : def.shot === 'arcane' ? 'bow' : def.shot ? 'staff' : def.beam ? 'frost' : view.type === 'hero' ? 'sword' : 'clang', view.x, view.z);
    // The axe goes all the way round whatever it is aimed at: the sweep needs no target.
    if (def.spin) fx.spin(view.x, view.y + 1.1 * view.scale, view.z, def.spin, view.palette.glow[0], spec.swing * 0.62);
    const target = point(view.targetId);
    if (!target) return;
    if (def.shot) {
      // The bolt leaves the staff's orb or the bow: the muzzle is [to the unit's left, up, ahead] on the model.
      const kind = def.shot === 'arcane' ? 'arcane' : view.side === 'radiant' ? 'boltRadiant' : 'boltDire';
      const [left, up, ahead] = spec.muzzle;
      const sin = Math.sin(view.facing);
      const cos = Math.cos(view.facing);
      const hand = { x: view.x + (cos * left + sin * ahead) * view.scale, y: view.y + up * view.scale, z: view.z + (cos * ahead - sin * left) * view.scale };
      fx.bolt(kind, hand, () => point(view.targetId), def.shotSpeed);
    } else if (def.beam) {
      fx.ray({ x: view.x, y: view.y + spec.muzzle[1] * view.scale, z: view.z }, target, 0x9fe9ff, 0.5, 0.28);
      fx.flash(target.x, target.y, target.z, 0xbff4ff, 1.6, 0.3);
    } else if (def.slam) {
      // The fists land a moment after the event, just short of the building.
      const gap = Math.hypot(target.x - view.x, target.z - view.z) || 1;
      const reach = Math.min(gap, def.radius + 1.1);
      fx.slam(view.x + ((target.x - view.x) / gap) * reach, view.z + ((target.z - view.z) / gap) * reach, view.palette.glow[0], spec.swing * spec.impact);
    } else if (view.type === 'hero') {
      // A sword cut: a crescent of light in front of the hero, sparks where it bites.
      const heading = Math.atan2(target.x - view.x, target.z - view.z);
      fx.heroSlash(view.side, view.x + Math.sin(heading) * 0.75, view.y + 1.45, view.z + Math.cos(heading) * 0.75, heading);
      fx.sparks(target.x, target.y, target.z, colors.spell(view.side).slash, 7, 3, 0.32, 0.24);
      if (view.flags & FLAG.lifesteal) {
        fx.drain(target, { x: view.x, y: view.y + 1.3, z: view.z });
        fx.cue('drain', view.x, view.z);
      }
    } else {
      // Dozens of troops swing every second, so their hits are a single cheap flash.
      fx.flash(target.x, target.y, target.z, 0xfff2c8, 1.1, 0.18);
    }
  }

  /** Shatter: a burst of fragments in the unit's colours while its model sinks away. */
  function die(view) {
    const { def, palette } = view;
    const big = view.scale;
    const y = view.y + def.height * 0.5;
    const frost = view.type === 'frost_tower';
    fx.sparks(view.x, y, view.z, frost ? 0xbff4ff : palette.glow[0], Math.round(8 * big), 3.5 + big, 0.7, 0.3 * big);
    fx.sparks(view.x, y, view.z, frost ? 0x6fb8ff : palette.cloth[1], Math.round(6 * big), 2.5 + big, 0.55, 0.22 * big);
    fx.ring(view.x, view.z, frost ? 0xbff4ff : palette.team, 0.2, def.radius * 2.4, 0.45);
    if (big > 2) fx.flash(view.x, y, view.z, palette.glow[0], 5 * big, 0.5);
    fx.cue('fall', view.x, view.z);
    view.life = 1;
    dying.push(view);
  }

  function heroChanged(view) {
    const { palette } = view;
    if (view.flags & FLAG.dead) {
      fx.sparks(view.x, view.y + 1.2, view.z, palette.glow[1], 22, 6, 1.0, 0.45);
      fx.sparks(view.x, view.y + 1.2, view.z, palette.cloth[1], 14, 4, 0.8, 0.35);
      for (let i = 0; i < 2; i++) fx.ring(view.x, view.z, palette.team, 0.3, 3, 0.7, i * 0.15);
      fx.flash(view.x, view.y + 1.2, view.z, palette.glow[1], 7, 0.6);
    } else {
      fx.beam(view.toX, view.toZ, palette.team, 2, 9, 0.9);
      fx.ring(view.toX, view.toZ, palette.team, 0.3, 2.6, 0.6);
    }
  }

  /* ---------------------------------------------------------------- Frame */

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const color = new THREE.Color();

  /** Advances a view's smoothing and animation clocks. */
  function advance(view, dt) {
    view.t = Math.min(1, view.t + dt / LERP_S);
    const x = view.fromX + (view.toX - view.fromX) * view.t;
    const z = view.fromZ + (view.toZ - view.fromZ) * view.t;
    const vx = dt > 0 ? (x - view.x) / dt : 0;
    const vz = dt > 0 ? (z - view.z) / dt : 0;
    const walking = Math.hypot(vx, vz) > 0.5;
    view.x = x;
    view.z = z;
    view.y = groundHeight(x, z);
    // The slope underfoot tilts the rings drawn on the ground. A probe that falls off a ledge is ignored.
    const east = groundHeight(x + SLOPE_PROBE, z) - view.y;
    const west = view.y - groundHeight(x - SLOPE_PROBE, z);
    const south = groundHeight(x, z + SLOPE_PROBE) - view.y;
    const north = view.y - groundHeight(x, z - SLOPE_PROBE);
    view.slopeX = Math.max(Math.abs(east), Math.abs(west)) < LEDGE ? (east + west) / (2 * SLOPE_PROBE) : 0;
    view.slopeZ = Math.max(Math.abs(south), Math.abs(north)) < LEDGE ? (south + north) / (2 * SLOPE_PROBE) : 0;
    view.moving += ((walking ? 1 : 0) - view.moving) * Math.min(1, dt * 10);
    view.gait += Math.hypot(vx, vz) * dt * 2.5;

    // Face the target while fighting, otherwise the way it is walking. A caster turns to what it is casting at.
    const target = view.swing > 0 || !walking ? point(view.targetId) : null;
    if (view.aimFor > 0) {
      view.aimFor -= dt;
      view.facing = turn(view.facing, view.aim, dt * 18);
    } else if (target) view.facing = turn(view.facing, Math.atan2(target.x - x, target.z - z), dt * 14);
    else if (walking) view.facing = turn(view.facing, Math.atan2(vx, vz), dt * 10);

    // An attack that is about due is wound up for, so the blow can land the moment the server says it has.
    const { spec } = view;
    view.since += dt;
    const due = view.def.attackMs / 1000;
    const winding = view.swing <= 0 && !walking && view.since > due - ANTICIPATE_S && view.since < due + HOLD_S && point(view.targetId) !== null;
    // A spell that takes time to land (a meteor, a pillar) is held wound up, then let go.
    if (view.hold > 0) {
      view.hold -= dt;
      if (view.hold <= 0) {
        view.swing = 1;
        view.windAt = 1;
        view.since = 0;
      }
    }
    view.ready = Math.min(1, Math.max(0, view.ready + (winding || view.hold > 0 ? dt / 0.24 : -dt / 0.18)));
    view.swing = Math.max(0, view.swing - dt / spec.swing);
    view.strike = strike(view);
    view.fire = view.swing;
    view.spun += view.swing * dt * 5;
    view.spawn = Math.min(1, view.spawn + dt / 0.3);
    view.flash = Math.max(0, view.flash - dt * 4.5);
  }

  /** Where a view is in its attack: +1 wound up, through -1 as the blow lands, and back to 0. */
  function strike(view) {
    const { windup, impact } = view.spec;
    if (impact <= windup) return 0;
    if (view.swing <= 0) return view.ready;
    const t = 1 - view.swing;
    if (t < windup) return view.windAt + (1 - view.windAt) * (t / windup);
    if (t < impact) return 1 - 2 * (1 - (1 - (t - windup) / (impact - windup)) ** 3);
    const k = (t - impact) / (1 - impact);
    return -1 + k * k * (3 - 2 * k);
  }

  function draw(view, time, dt) {
    const { def, kind, palette, spec } = view;
    const grow = 1 - (1 - view.spawn) ** 3;
    const size = view.scale * grow * (0.25 + 0.75 * view.life);
    const heading = def.building ? 0 : view.facing;

    position.set(view.x, view.y - (1 - view.life) * def.height * 0.5, view.z);
    euler.set(0, heading, 0);
    matrix.compose(position, quaternion.setFromEuler(euler), scale.setScalar(size));

    // Instance colour: frost tint while slowed, gold while stunned, a white flash when hit.
    if (view.flags & FLAG.slowed) color.setRGB(0.55, 0.85, 1.5);
    else if (view.flags & FLAG.stunned) color.setRGB(1.35, 1.2, 0.55);
    else color.setRGB(1, 1, 1);
    color.lerp(FLASH, view.flash * 0.7);

    const i = kind.count++;
    if (i >= CAPACITY) return;
    kind.troop.pose(view, time);
    kind.rig.write(i);
    kind.mesh.setMatrixAt(i, matrix);
    kind.mesh.setColorAt(i, color);

    // A blade leaves a streak of light while it cuts, which fades as the blow is recovered from.
    if (spec.trail && view.swing > 0 && view.life === 1) {
      const t = 1 - view.swing;
      if (t >= spec.windup) {
        const fade = t < spec.impact ? 1 : Math.max(0, 1 - (t - spec.impact) / 0.22);
        const head = t < spec.impact ? (1 - view.strike) / 2 : 1;
        if (fade > 0) addTrail(view.x, view.y + 0.92 * spec.height * size, view.z, heading, 0.5, spec.trail * size, head, fade * 0.8, palette.glow[0]);
      }
    }

    if (view.flags & FLAG.burning && view.life === 1) kindle(view, dt, 7 + 2 * view.scale);

    const ground = view.y + 0.04;
    addDecal(view.x, ground, view.z, def.radius * 1.6, 0, 0.3 * view.life, 0x000000, view.slopeX, view.slopeZ);
    addDecal(view.x, ground + 0.01, view.z, Math.max(def.radius * 1.35, 0.3 * view.scale + 0.25), 1, 0.9 * view.life, palette.team, view.slopeX, view.slopeZ);
    if (def.building && view.life === 1) addDecal(view.x, ground, view.z, def.range, 2, 0.5, 0x9fe9ff);
    if (view.life === 1) {
      const width = Math.min(2.6, Math.max(1.1, def.radius * 2.4));
      addBar(view.x, view.y + def.height * grow + 0.4, view.z, width, view.scale > 2 ? 0.26 : 0.18, view.hp / def.hp, palette.bar);
    }
  }

  function drawHero(view, time, dt) {
    const hero = heroes[view.side];
    const { flags } = view;
    const dead = Boolean(flags & FLAG.dead);
    hero.group.visible = !dead;
    if (dead) {
      hero.rest(dt);
      return;
    }
    hero.group.position.set(view.x, view.y, view.z);
    hero.body.position.set(0, 0.03, 0);
    hero.body.rotation.set(0, view.facing, 0, 'YXZ');
    hero.ring.rotation.y = time * 0.9;
    // Lit from within for a moment when struck.
    hero.body.scale.setScalar(hero.size * (1 + view.flash * 0.06));
    hero.pose(view, time, dt);

    // The shield spell pops open, then holds for as long as the shield does; it flares when it soaks a blow.
    // The Aether Knight's is the Aegis sphere; Morgath's is the Flame Cloak.
    const shielded = Boolean(flags & FLAG.shielded);
    const burningCloak = hero.champion === 'morgath';
    hero.shield.visible = shielded && !burningCloak;
    hero.cloak.visible = shielded && burningCloak;
    if (shielded) {
      view.shieldAge += dt;
      const open = Math.min(1, view.shieldAge / 0.28);
      const overshoot = 1 + 2.2 * (open - 1) ** 3 + 1.2 * (open - 1) ** 2;
      const pop = 0.35 + 0.65 * overshoot;
      if (burningCloak) {
        hero.cloak.scale.setScalar(pop);
        const flare = 1 + view.flash * 0.35;
        hero.cloakOuter.scale.y = 3.3 * flare * (1 + 0.05 * Math.sin(time * 13));
        hero.cloakInner.scale.y = 2.7 * flare * (1 + 0.06 * Math.sin(time * 17 + 1));
        hero.cloakOuter.material.map.offset.x = time * 0.35;
        hero.cloakInner.material.map.offset.x = -time * 0.55;
        // The fire reaches out to its full radius on the ground, and flames stand up along its edge.
        const ground = view.y + 0.05;
        addDecal(view.x, ground, view.z, CLOAK_RADIUS * pop, 0, 0.22, colors.cloak, view.slopeX, view.slopeZ);
        addDecal(view.x, ground + 0.01, view.z, (CLOAK_RADIUS / 0.86) * pop, 1, 0.8, colors.cloak, view.slopeX, view.slopeZ);
        view.kindle += dt * 22;
        while (view.kindle >= 1) {
          view.kindle -= 1;
          const angle = Math.random() * TAU;
          ignite(view.x + Math.cos(angle) * CLOAK_RADIUS * pop, view.y + 0.1, view.z + Math.sin(angle) * CLOAK_RADIUS * pop, 0.9);
        }
      } else {
        hero.shield.scale.setScalar(1.8 * pop);
        hero.lattice.rotation.set(time * 0.7, time * 1.4, 0);
        hero.shell.rotation.y = -time * 0.5;
        hero.shell.material.opacity = 0.17 + 0.05 * Math.sin(time * 5) + 0.3 * view.flash;
        hero.hoops[0].rotation.set(1.05, time * 2.2, 0);
        hero.hoops[1].rotation.set(-1.05, -time * 1.7, 0);
      }
    }
    if (flags & FLAG.burning) kindle(view, dt, 22);

    const empowered = Boolean(flags & FLAG.empowered);
    hero.power.visible = empowered;
    if (empowered) {
      hero.power.scale.setScalar(1.5 + Math.sin(time * 9) * 0.1);
      hero.power.rotation.y = time * 2;
    }

    const stunned = Boolean(flags & FLAG.stunned);
    const vampiric = Boolean(flags & FLAG.lifesteal);
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * TAU;
      hero.stars[i].visible = stunned;
      hero.stars[i].position.set(Math.cos(time * 6 + angle) * 0.55, 3.1, Math.sin(time * 6 + angle) * 0.55);
      hero.wisps[i].visible = vampiric;
      hero.wisps[i].position.set(Math.cos(time * 2.4 + angle) * 1.05, 0.9 + 0.5 * Math.sin(time * 3 + angle * 2), Math.sin(time * 2.4 + angle) * 1.05);
    }

    // Auras on the ground, and what the running buffs shed into the air.
    const ground = view.y + 0.05;
    const { slopeX, slopeZ } = view;
    if (vampiric) addDecal(view.x, ground, view.z, 1.5, 1, 0.75, colors.lifesteal, slopeX, slopeZ);
    if (empowered) addDecal(view.x, ground, view.z, 1.85, 1, 0.8, colors.rune.damage, slopeX, slopeZ);
    if (flags & FLAG.hasted) addDecal(view.x, ground, view.z, 1.85, 1, 0.8, colors.rune.haste, slopeX, slopeZ);
    if (flags & FLAG.regen) addDecal(view.x, ground, view.z, 1.85, 1, 0.8, colors.rune.regen, slopeX, slopeZ);
    view.shed += dt;
    if (view.shed > 0.09) {
      view.shed = 0;
      // Haste leaves a streak of light behind a running hero; Arcane Regen lifts motes around it.
      if (flags & FLAG.hasted && view.moving > 0.5) fx.flash(view.x, view.y + 0.9, view.z, colors.rune.haste, 2.4, 0.4);
      if (flags & FLAG.regen) fx.rise(view.x, view.z, 0.9, colors.rune.regen, 2, 0.8, 1.2);
      if (empowered) fx.rise(view.x, view.z, 0.7, colors.rune.damage, 1, 0.6, 1.6);
      if (shielded && burningCloak) fx.rise(view.x, view.z, CLOAK_RADIUS * 0.8, colors.cloak, 2, 1.1, 1.3);
    }
  }

  function update(dt, time) {
    // Frozen units are still drawn, but no clock of theirs runs: no stride, swing, idle sway or flame moves on.
    if (frozen) {
      dt = 0;
      time = heldTime;
    } else {
      heldTime = time;
    }
    for (const kind of kinds.values()) kind.count = 0;
    bars.geometry.instanceCount = 0;
    decals.geometry.instanceCount = 0;
    trails.geometry.instanceCount = 0;

    for (const view of views.values()) {
      advance(view, dt);
      if (view.type === 'hero') drawHero(view, time, dt);
      else draw(view, time, dt);
    }
    for (let i = dying.length - 1; i >= 0; i--) {
      const view = dying[i];
      view.life -= dt / DEATH_S;
      if (view.life <= 0) dying.splice(i, 1);
      else draw(view, time, dt);
    }
    burnFlames(dt, time);

    for (const { rig, mesh, count } of kinds.values()) {
      mesh.count = Math.min(count, CAPACITY);
      if (!mesh.count) continue;
      rig.texture.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
    for (const quads of [bars, decals, trails]) {
      for (const attribute of Object.values(quads.geometry.attributes)) {
        if (attribute.isInstancedBufferAttribute) attribute.needsUpdate = true;
      }
    }
  }

  return {
    sync,
    update,
    point,

    /** A side's hero has changed champion: its blow takes the new champion's timing. */
    retune() {
      for (const view of Object.values(heroViews)) if (view) view.spec = heroes[view.side].spec;
    },

    /**
     * The side's hero casts towards (tx, tz): it turns to the spot and swings.
     * With `hold` seconds it stays wound up for that long first and strikes
     * when the spell lands.
     */
    cast(side, tx, tz, hold) {
      const view = heroViews[side];
      if (!view || view.flags & FLAG.dead) return;
      // A spell cast at the hero's own feet (a shield) has no direction to turn to.
      if (Math.hypot(tx - view.x, tz - view.z) > 0.5) {
        view.aim = Math.atan2(tx - view.x, tz - view.z);
        view.aimFor = hold + 0.4;
      }
      if (hold > 0) {
        view.hold = hold;
      } else {
        view.swing = 1;
        view.windAt = view.ready;
        view.ready = 0;
        view.since = 0;
      }
    },

    /** The smoothed position of a side's hero, or null before the first snapshot. */
    hero(side) {
      const view = heroViews[side];
      return view ? { x: view.x, y: view.y, z: view.z, facing: view.facing, dead: Boolean(view.flags & FLAG.dead) } : null;
    },

    /**
     * Id of the enemy of `side` under a ground point, or 0. A click lands on a
     * unit's body, which the tilted camera shows covering the ground from its
     * feet to some way up-screen of them, so the whole of that stretch counts.
     */
    pick(x, z, side) {
      let best = 0;
      let bestGap = Infinity;
      for (const view of views.values()) {
        if (view.side === side || view.flags & FLAG.dead) continue;
        const reach = (view.def.height * 0.85) / tanPitch;
        const along = Math.min(reach, Math.max(0, (x - view.x) * ahead.x + (z - view.z) * ahead.z));
        const gap = Math.hypot(view.x + ahead.x * along - x, view.z + ahead.z * along - z) - view.def.radius;
        if (gap < 0.5 && gap < bestGap) {
          best = view.id;
          bestGap = gap;
        }
      }
      return best;
    },

    /** Where a unit stands and whose it is: { x, y (the top of its head), z, side, hero }, or null once it has left the field. */
    locate(id) {
      const view = views.get(id);
      return view ? { x: view.x, y: view.y + view.def.height, z: view.z, side: view.side, hero: view.type === 'hero' } : null;
    },

    /** Stops every unit and hero where it stands, mid-stride and mid-swing, until `clear()`. */
    freeze() {
      frozen = true;
    },

    clear() {
      frozen = false;
      views.clear();
      dying.length = 0;
      heroViews.radiant = heroViews.dire = null;
      for (const side of SIDES) {
        heroes[side].group.visible = false;
        heroes[side].reset();
      }
      for (const flame of flames) {
        flame.age = 1;
        flame.sprite.visible = false;
      }
      update(0, 0);
    },

    count: () => views.size,
  };
}
