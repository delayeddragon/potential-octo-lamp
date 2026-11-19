/**
 * RuneDeck — the Guardian: an anatomical dragon curled round a crystal hoard.
 *
 * One sculpted, skinned body (sculpt.js) hangs on a ~35 bone skeleton: a
 * swept tube for the torso and tail, a six-bone S-curved neck, a horned head
 * with a hinged jaw, four clawed legs, and two bat wings whose bone fingers
 * are extruded and whose dark-red membranes are skinned between neighbouring
 * fingers, so they stretch as the fingers spread. `update` breathes, flaps,
 * sways the tail, and turns the head to watch the nearest hero.
 *
 * Modelled in a frame where +X is the way the dragon faces (towards the
 * cavern's mouth), +Y is up and +Z is its right; the group turns that frame
 * to the mouth's bearing and stands it on the pit floor.
 */

import * as THREE from 'three';

import { TAU, seededRandom } from './geometry.js';
import { FINISH, Sculpt, buildSkeleton, defineBones, paint, surfaceMaterial } from './sculpt.js';
import { MAP, terrainHeight } from './shared.js';

const CYAN = { low: 0x0f9fc0, high: 0xcffcff, halo: 0x3fe8ff };

/** Paints: scales are blood red, the belly and bone pale, the membranes dark wine. */
const HIDE = paint(0x2a070c, 0xb8341f, FINISH.scale);
const BELLY = paint(0x6b4a2c, 0xf0c98a, FINISH.skin);
const BONE = paint(0x4f4838, 0xcfc4a6, FINISH.bone);
const HORN = paint(0x2a1d1a, 0xf4ecd6, FINISH.bone);
const CLAW = paint(0x2a2420, 0xe2dac0, FINISH.bone);
const TOOTH = paint(0xcfc6ac, 0xfff8e8, FINISH.bone);
const TONGUE = paint(0x5a0a14, 0xb04040, FINISH.skin);
const EYE = paint(0xff7a10, 0xffe070, FINISH.ember);
const PUPIL = paint(0x050202, 0x120404, FINISH.stone);
const NOSTRIL = paint(0x090203, 0x2a0a08, FINISH.obsidian);
const MEMBRANE = paint(0x24080f, 0xb02a3c, FINISH.membrane);
const STONE = paint(0x232a34, 0x667386, FINISH.stone);
const CRYSTAL = paint(0x0a7f9e, 0x8af0ff, FINISH.crystal, 0.75);
const AMBER = paint(0xb8560c, 0xffc060, FINISH.crystal, 0.8);

const RAD = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A point on the coil: bearing in degrees round the hoard, radius, height, and
 * a distance `ahead` along the body's own heading (towards the head).
 */
function coil(degrees, radius, y, ahead = 0) {
  const a = degrees * RAD;
  return [Math.cos(a) * radius - Math.sin(a) * ahead, y, Math.sin(a) * radius + Math.cos(a) * ahead];
}

/** Heading (towards the head) and outward direction of the coil at a bearing, on the floor plane. */
const heading = (degrees) => [-Math.sin(degrees * RAD), 0, Math.cos(degrees * RAD)];
const outward = (degrees) => [Math.cos(degrees * RAD), 0, Math.sin(degrees * RAD)];
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

/** Reads `values` (a number, an array spread evenly over 0..1, or u => value) at `u`. */
function along(values, u) {
  if (typeof values === 'function') return values(u);
  if (!Array.isArray(values)) return values;
  const at = Math.min(Math.max(u, 0), 1) * (values.length - 1);
  const i = Math.min(Math.floor(at), values.length - 2);
  return lerp(values[i], values[i + 1], at - i);
}

/** Bearing of the chest and of the hips round the hoard. */
const CHEST = -104;
const HIP = -194;

/** The torso, then the tail coiling inwards: 19 control points, from the chest's front to the tip. */
const SPINE = [];
const SPINE_RADIUS = [];
{
  const torso = [-86, -104, -126, -149, -172, -194];
  torso.forEach((degrees, i) => {
    SPINE.push(coil(degrees, i === 0 ? 2.3 : 2.2, [1.32, 1.22, 1.12, 1.06, 1.0, 0.95][i]));
    SPINE_RADIUS.push([0.78, 1.0, 1.06, 1.0, 0.92, 0.84][i]);
  });
  const length = 13;
  for (let k = 1; k <= length; k++) {
    const t = k / length;
    const r = 0.82 * (1 - t) ** 1.15 + 0.05;
    SPINE_RADIUS.push(r);
    SPINE.push(coil(HIP - k * 17.5, 2.2 - 0.95 * t ** 0.9, r * 0.88 + 0.04));
  }
}

/** The neck: six bones and the head's, rising from the chest in an S. */
const NECK = [
  coil(CHEST + 4, 2.25, 1.55, 0.0),
  coil(CHEST + 4, 2.2, 2.15, 0.4),
  coil(CHEST + 4, 2.1, 2.8, 0.8),
  coil(CHEST + 4, 1.95, 3.4, 0.85),
  coil(CHEST + 4, 1.85, 3.95, 0.65),
  coil(CHEST + 4, 1.8, 4.4, 0.8),
  coil(CHEST + 4, 1.75, 4.62, 1.3),
];
const NECK_RADIUS = [0.76, 0.68, 0.61, 0.55, 0.49, 0.43, 0.36];

const HEAD_AT = NECK[6];
const HEAD_PITCH = -0.3;
const HEAD_SIZE = 1.35;
/** The dragon is drawn a little larger than it is modelled. */
const SIZE = 1.12;

/** Where a point modelled in the head's own frame lands in the dragon's. */
function headPoint(x, y, z) {
  const c = Math.cos(HEAD_PITCH);
  const s = Math.sin(HEAD_PITCH);
  return [HEAD_AT[0] + (x * c - y * s) * HEAD_SIZE, HEAD_AT[1] + (x * s + y * c) * HEAD_SIZE, HEAD_AT[2] + z * HEAD_SIZE];
}

/** The wings: a shoulder on each side of the chest's back, and a wing frame (x ahead, y up, z away from the body). */
const WING_AT = coil(CHEST, 2.2, 2.2);
const WING = {
  elbow: [-0.9, 1.3, 1.3],
  wrist: [0.1, 3.0, 2.3],
  tips: [
    [-0.9, 4.9, 3.7],
    [-1.8, 4.0, 4.4],
    [-2.5, 2.5, 4.0],
    [-2.9, 1.0, 2.6],
  ],
  anchor: [-2.3, -0.2, 0.5],
};
const SIDES = [-1, 1];
const sideName = (side) => (side < 0 ? 'L' : 'R');

/** A wing-frame point in the dragon's frame. */
function wingPoint(side, [x, y, z]) {
  const f = heading(CHEST);
  const r = outward(CHEST);
  // Wing +Z points away from the body: outwards for the left wing, towards the hoard for the right.
  const away = side < 0 ? 1 : -1;
  return [WING_AT[0] + f[0] * x + r[0] * away * z, WING_AT[1] + y, WING_AT[2] + f[2] * x + r[2] * away * z];
}

/* -------------------------------------------------------------------------- */
/* Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

const TAIL_BONES = 7;
const BONE_LIST = [
  ['root', null, 0, 0, 0],
  ['body', 'root', ...SPINE[3]],
  ['chest', 'body', ...SPINE[1]],
  ...NECK.slice(0, 6).map((at, i) => [`neck${i}`, i ? `neck${i - 1}` : 'chest', ...at]),
  ['head', 'neck5', ...HEAD_AT],
  ['jaw', 'head', ...headPoint(-0.05, -0.2, 0)],
  ['eyeL', 'head', ...headPoint(0.52, 0.2, -0.37)],
  ['eyeR', 'head', ...headPoint(0.52, 0.2, 0.37)],
  ...Array.from({ length: TAIL_BONES }, (_, i) => [`tail${i}`, i ? `tail${i - 1}` : 'body', ...SPINE[5 + i * 2]]),
];
for (const side of SIDES) {
  const n = sideName(side);
  BONE_LIST.push([`shoulder${n}`, 'chest', ...wingPoint(side, [0, 0, 0])]);
  BONE_LIST.push([`elbow${n}`, `shoulder${n}`, ...wingPoint(side, WING.elbow)]);
  BONE_LIST.push([`wrist${n}`, `elbow${n}`, ...wingPoint(side, WING.wrist)]);
  for (let i = 0; i < 4; i++) BONE_LIST.push([`finger${n}${i}`, `wrist${n}`, ...wingPoint(side, WING.wrist)]);
}
const BONES = defineBones(BONE_LIST);
const ID = BONES.id;

/**
 * Skinning along a tube: each bone owns the stretch from its pivot (a control
 * point index) to the next, and blends half-and-half with its neighbour at the joint.
 */
function chain(joints, count) {
  const last = joints.length - 1;
  return (u) => {
    const x = u * (count - 1);
    let k = 0;
    while (k < last && joints[k + 1][1] <= x + 1e-9) k++;
    const [bone, from] = joints[k];
    const span = k < last ? joints[k + 1][1] - from : from - joints[k - 1][1];
    const t = Math.max(0, (x - from) / span);
    if (t < 0.5 && k > 0) return [bone, joints[k - 1][0], 0.5 * (1 - smooth(t * 2))];
    if (t >= 0.5 && k < last) return [bone, joints[k + 1][0], 0.5 * smooth(t * 2 - 1)];
    return [bone, bone, 0];
  };
}

/* -------------------------------------------------------------------------- */
/* Sculpting helpers                                                          */
/* -------------------------------------------------------------------------- */

const curveOf = (points) => new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, 'centripetal');

/** Overlapping scale relief for a tube: shingles that rise gently and drop sharply, staggered round the tube. */
function scales({ steps, sides, rows, amp, low = 0.25, high = 0.85 }) {
  const phase = (u, v) => (((u * steps) / (steps / rows) + (Math.round(v * sides) % 2) * 0.5) % 1 + 1) % 1;
  return {
    bump: (u, v) => 1 + amp * (phase(u, v) - 0.5),
    // Dorsal scales catch the light; each shingle is darker where the next one overlaps it.
    tint: (u, v) => lerp(low, high, 0.55 * phase(u, v) + 0.45 * Math.max(0, Math.sin(v * TAU))),
  };
}

const MATRIX = new THREE.Matrix4();
const QUAT = new THREE.Quaternion();
const POS = new THREE.Vector3();
const DIR = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

/** A cone-shaped horn, claw or spike standing at `at` and pointing along `dir`. */
function spike(s, ink, at, dir, radius, height, o = {}) {
  DIR.set(dir[0], dir[1], dir[2]).normalize();
  QUAT.setFromUnitVectors(UP, DIR);
  const matrix = new THREE.Matrix4().compose(POS.set(at[0], at[1], at[2]), QUAT, ONE);
  return s.cone(ink, 0, 0, 0, radius, height, { seg: 7, ...o, matrix });
}

/** Spikes along the back of a swept tube. */
function ridge(s, ink, curve, radius, flat, { from, to, count, up = [0, 1, 0], height, width, lean, skin, scale = 0.92 }) {
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const upward = new THREE.Vector3(...up);
  for (let k = 0; k < count; k++) {
    const t = count > 1 ? k / (count - 1) : 0;
    const u = lerp(from, to, t);
    curve.getPoint(u, point);
    curve.getTangent(u, tangent);
    const d = upward.clone().addScaledVector(tangent, -upward.dot(tangent)).normalize();
    const r = along(radius, u) * along(flat, u) * scale;
    const base = [point.x + d.x * r, point.y + d.y * r, point.z + d.z * r];
    const h = lerp(height[0], height[1], t);
    const w = lerp(width[0], width[1], t);
    spike(s, ink, base, [d.x + tangent.x * lean, d.y + tangent.y * lean, d.z + tangent.z * lean], w, h, { skin: skin ? () => skin(u) : undefined });
  }
}

/** A flat bone plate from `a` to `b`: a tapering, knuckled outline extruded `thick`, its face turned to `normal`. */
function boneRod(s, ink, a, b, widthA, widthB, thick, normal, bone, bow = 0) {
  const x = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const length = x.length();
  x.normalize();
  const z = new THREE.Vector3(...normal);
  z.addScaledVector(x, -z.dot(x)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const matrix = new THREE.Matrix4().makeBasis(x, y, z).setPosition(a[0], a[1], a[2]);
  const top = [];
  const bottom = [];
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = lerp(widthA, widthB, t) * (1 + 0.28 * Math.max(0, Math.cos(t * Math.PI * 4 - 0.4)) * (1 - t));
    const sway = bow * Math.sin(t * Math.PI);
    top.push([t * length, sway + w]);
    bottom.unshift([t * length, sway - w]);
  }
  const outline = [[-widthA * 0.7, 0], ...top, [length + widthB * 0.9, 0], ...bottom];
  return s.extrude(ink, 0, 0, 0, outline, thick, { matrix, smooth: true, curve: 5, bevel: Math.min(widthB, 0.03), along: 'x', bone });
}

/**
 * A sheet of membrane fanned from the wrist between two finger tips, its
 * trailing edge scalloped. Vertices blend from one finger's bone to the
 * other's (or to an anchor bone on the body) across the sheet.
 */
function membrane(m, ink, wrist, a, b, boneA, boneB, { anchor = false, scallop = 0.17 } = {}) {
  const rows = 9;
  const cols = 14;
  const va = new THREE.Vector3(a[0] - wrist[0], a[1] - wrist[1], a[2] - wrist[2]);
  const vb = new THREE.Vector3(b[0] - wrist[0], b[1] - wrist[1], b[2] - wrist[2]);
  const chord = new THREE.Vector3();
  const positions = [];
  const tints = [];
  const skins = [];
  const index = [];
  for (let i = 0; i <= rows; i++) {
    const r = i / rows;
    for (let j = 0; j <= cols; j++) {
      const t = j / cols;
      const reach = r * (1 - scallop * Math.sin(Math.PI * t) ** 0.8);
      chord.copy(va).lerp(vb, t).multiplyScalar(reach);
      // A slight billow, so the sheet is never a perfect plane.
      const billow = 0.1 * Math.sin(Math.PI * t) * Math.sin(Math.PI * r) * va.length() * 0.25;
      positions.push(wrist[0] + chord.x - billow * 0.6, wrist[1] + chord.y, wrist[2] + chord.z);
      // Dark veins along each finger and a paler, thinner web towards the trailing edge.
      const vein = Math.min(1, Math.min(t, 1 - t) / 0.06);
      tints.push((0.18 + 0.62 * r ** 0.8) * (0.55 + 0.45 * vein));
      skins.push(anchor ? [boneA, boneB, t * r * r] : [boneA, boneB, t]);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const p = i * (cols + 1) + j;
      index.push(p, p + 1, p + cols + 1, p + 1, p + cols + 2, p + cols + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('tint', new THREE.Float32BufferAttribute(tints, 1));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.userData.skins = skins;
  return m.add(geometry, ink);
}

/* -------------------------------------------------------------------------- */
/* The model                                                                  */
/* -------------------------------------------------------------------------- */

/** A leg: muscle, joints and a clawed foot. `joints` run shoulder, elbow, wrist, paw; `radii` thicken each in turn. */
function leg(s, joints, radii, degrees, side, toeLength = 0.55) {
  const [shoulder, elbow, wrist, paw] = joints;
  const f = heading(degrees);
  const o = outward(degrees);
  s.ball(HIDE, shoulder[0], shoulder[1], shoulder[2], radii[0], { seg: 16, rings: 12, sy: 1.08 });
  s.limb(HIDE, shoulder, elbow, radii[0] * 0.85, radii[1], { seg: 12 });
  s.ball(HIDE, elbow[0], elbow[1], elbow[2], radii[1] * 1.05);
  s.limb(HIDE, elbow, wrist, radii[1], radii[2], { seg: 12 });
  s.limb(HIDE, wrist, paw, radii[2], radii[3], { seg: 10 });
  s.ball(HIDE, paw[0], paw[1] + 0.02, paw[2], radii[3] * 1.15, { sx: 1.25, sy: 0.7 });
  // Elbow spur.
  spike(s, BONE, elbow, [-f[0] * 0.8 + o[0] * side * 0.5, 0.35, -f[2] * 0.8 + o[2] * side * 0.5], radii[1] * 0.35, 0.4);
  // Three toes fan out ahead of the paw, each with a hooked claw digging into the rock.
  for (const spread of [-1, 0, 1]) {
    const tip = [paw[0] + f[0] * toeLength + o[0] * spread * 0.2, 0.07, paw[2] + f[2] * toeLength + o[2] * spread * 0.2];
    s.limb(HIDE, [paw[0], paw[1] - 0.02, paw[2]], tip, radii[3] * 0.62, radii[3] * 0.4, { seg: 8, cap: 3 });
    spike(s, CLAW, [tip[0], tip[1] + 0.03, tip[2]], [f[0] + o[0] * spread * 0.2, -0.75, f[2] + o[2] * spread * 0.2], 0.06, 0.3, { seg: 6 });
  }
}

/** The head, modelled looking down +X about the skull's base, with the jaw on its own bone. */
function head(s) {
  const h = ID.head;
  const j = ID.jaw;
  const dorsal = (top, bottom) => (u, v) => bottom + (top - bottom) * (0.5 + 0.5 * Math.sin(v * TAU));
  s.group(HEAD_AT[0], HEAD_AT[1], HEAD_AT[2], { rz: HEAD_PITCH, s: HEAD_SIZE }, () => {
    s.bone(h);
    // Skull and a long, tapering muzzle.
    s.ball(HIDE, 0.12, 0.02, 0, 0.5, { seg: 22, rings: 16, sx: 1.15, sy: 0.92, tint: (x, y) => 0.45 + 0.3 * y });
    s.tube(HIDE, [[0.1, 0.05, 0], [0.7, 0.03, 0], [1.3, -0.02, 0], [1.76, -0.08, 0]], [0.42, 0.36, 0.3, 0.23], {
      flat: [1.0, 0.78],
      sides: 16,
      steps: 12,
      tint: dorsal(0.85, 0.2),
    });
    s.ball(HIDE, 1.76, -0.08, 0, 0.23, { sx: 0.9, sy: 0.72, tint: () => 0.7 });
    // Nostrils: raised rims with a dark pit.
    for (const side of [-1, 1]) {
      s.ball(HIDE, 1.62, 0.07, side * 0.14, 0.1, { tint: () => 0.9 });
      s.ball(NOSTRIL, 1.7, 0.06, side * 0.145, 0.058, { sx: 0.7 });
      // A bony brow shelf over each eye, and the ridge that runs back into the horn.
      s.tube(BONE, [[-0.1, 0.34, side * 0.26], [0.3, 0.42, side * 0.37], [0.72, 0.32, side * 0.34]], [0.1, 0.1, 0.045], { sides: 8, tint: (u) => 0.25 + 0.5 * u });
      // Cheek: a heavy jaw muscle with a bone spur.
      s.ball(HIDE, -0.05, -0.1, side * 0.37, 0.27, { sx: 1.15, tint: () => 0.5 });
      spike(s, HORN, [-0.15, -0.05, side * 0.5], [-0.8, -0.25, side * 0.9], 0.08, 0.55);
      spike(s, HORN, [0.2, -0.04, side * 0.43], [-0.2, -0.4, side * 0.9], 0.055, 0.36);
      // Horns sweep back, out and up, then curl in at the tip.
      s.tube(HORN, [[-0.1, 0.36, side * 0.3], [-0.5, 0.58, side * 0.46], [-0.95, 0.66, side * 0.58], [-1.35, 0.6, side * 0.54], [-1.62, 0.72, side * 0.44]], [0.17, 0.14, 0.1, 0.055, 0.004], {
        sides: 10,
        steps: 20,
        up: [0, 1, 0],
        tint: (u, v) => 0.15 + 0.8 * u + 0.1 * Math.sin(v * TAU),
      });
      // A second, shorter horn below, and spines along the cheek.
      s.tube(HORN, [[-0.1, 0.18, side * 0.42], [-0.42, 0.2, side * 0.64], [-0.72, 0.12, side * 0.72]], [0.1, 0.065, 0.004], { sides: 8, steps: 8, tint: (u) => 0.2 + 0.7 * u });
    }
    // Spines down the muzzle's ridge.
    for (let i = 0; i < 4; i++) spike(s, HORN, [0.35 + i * 0.32, 0.4 - i * 0.07, 0], [-0.4, 1, 0], 0.045 - i * 0.004, 0.2 - i * 0.025);
    // Upper teeth: a row of small ones and two great fangs.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) spike(s, TOOTH, [0.5 + i * 0.2, -0.1 - i * 0.004, side * (0.27 - i * 0.018)], [0.1, -1, 0], 0.03, 0.1 + (i === 3 ? 0.18 : 0), { seg: 5 });
    }

    // The lower jaw hangs from its own bone.
    s.bone(j);
    s.tube(HIDE, [[-0.02, -0.26, 0], [0.6, -0.3, 0], [1.2, -0.3, 0], [1.56, -0.25, 0]], [0.3, 0.26, 0.2, 0.13], {
      flat: [1.0, 0.52],
      sides: 14,
      steps: 12,
      tint: dorsal(0.65, 0.12),
    });
    s.ball(HIDE, 1.56, -0.26, 0, 0.13, { sy: 0.6, tint: () => 0.45 });
    s.tube(TONGUE, [[0.1, -0.22, 0], [0.7, -0.22, 0], [1.3, -0.2, 0]], [0.08, 0.07, 0.03], { flat: [1.5, 0.6], sides: 8, steps: 8, tint: (u) => 0.3 + 0.5 * u });
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) spike(s, TOOTH, [0.55 + i * 0.22, -0.22, side * (0.2 - i * 0.015)], [0, 1, 0], 0.028, 0.09 + (i === 4 ? 0.06 : 0), { seg: 5 });
      // Chin barbs.
      spike(s, HORN, [0.35 + (side > 0 ? 0 : 0.35), -0.4, side * 0.12], [-0.5, -0.5, side * 0.3], 0.04, 0.2);
    }
  });
  // Eyes sit in the skull's own frame: a glowing ball with a dark slit, each on a bone so it can blink.
  for (const side of [-1, 1]) {
    const bone = ID[side < 0 ? 'eyeL' : 'eyeR'];
    const at = headPoint(0.52, 0.2, side * 0.37);
    s.bone(bone);
    s.ball(EYE, at[0], at[1], at[2], 0.095 * HEAD_SIZE, { seg: 14, rings: 10, tint: (x, y, z) => 0.5 + 0.5 * z });
    const slit = headPoint(0.58, 0.2, side * 0.42);
    s.ball(PUPIL, slit[0], slit[1], slit[2], 0.05 * HEAD_SIZE, { sx: 0.4, sy: 1.9, sz: 0.5, ry: side * 0.55 });
  }
}

/** A wing: arm bones, bone fingers and (in `m`) the membranes stretched between them. */
function wing(s, m, side) {
  const n = sideName(side);
  const P = (p) => wingPoint(side, p);
  const shoulder = P([0, 0, 0]);
  const elbow = P(WING.elbow);
  const wrist = P(WING.wrist);
  const tips = WING.tips.map(P);
  const anchor = P(WING.anchor);
  // The plane of the wing, for the flat of the bones.
  const normal = new THREE.Vector3(wrist[0] - tips[0][0], 0, 0);
  const a = new THREE.Vector3(tips[0][0] - wrist[0], tips[0][1] - wrist[1], tips[0][2] - wrist[2]);
  const b = new THREE.Vector3(tips[3][0] - wrist[0], tips[3][1] - wrist[1], tips[3][2] - wrist[2]);
  normal.crossVectors(a, b).normalize();
  const face = [normal.x, normal.y, normal.z];

  s.bone(ID[`shoulder${n}`]);
  s.ball(HIDE, shoulder[0], shoulder[1] - 0.1, shoulder[2], 0.62, { seg: 18, rings: 12, tint: () => 0.55 });
  boneRod(s, BONE, shoulder, elbow, 0.15, 0.12, 0.2, face, ID[`shoulder${n}`], 0.05);
  s.bone(ID[`elbow${n}`]);
  s.ball(BONE, elbow[0], elbow[1], elbow[2], 0.15, { tint: () => 0.5 });
  spike(s, CLAW, elbow, [-0.7, 0.35, side * 0.1 + (side < 0 ? -0.5 : 0.5) * 0.3], 0.09, 0.5);
  boneRod(s, BONE, elbow, wrist, 0.12, 0.085, 0.17, face, ID[`elbow${n}`], -0.06);
  s.bone(ID[`wrist${n}`]);
  s.ball(BONE, wrist[0], wrist[1], wrist[2], 0.13, { tint: () => 0.55 });
  // The thumb claw hooks forward from the wrist.
  spike(s, CLAW, wrist, [0.9, 0.55, side < 0 ? -0.1 : 0.1], 0.08, 0.55);

  tips.forEach((tip, i) => {
    const bone = ID[`finger${n}${i}`];
    boneRod(s, BONE, wrist, tip, 0.075 - i * 0.006, 0.018, 0.11, face, bone, (i % 2 ? -1 : 1) * 0.05);
    spike(s, CLAW, tip, [tip[0] - wrist[0], tip[1] - wrist[1], tip[2] - wrist[2]], 0.04, 0.26, { bone });
    if (i > 0) membrane(m, MEMBRANE, wrist, tips[i - 1], tip, ID[`finger${n}${i - 1}`], bone);
  });
  membrane(m, MEMBRANE, wrist, tips[3], anchor, ID[`finger${n}3`], ID.chest, { anchor: true, scallop: 0.1 });
}

/** The crystal hoard the dragon is curled round. */
function hoard(s) {
  s.bone(ID.root);
  s.rock(STONE, 0, -0.12, 0, 1.25, { sy: 0.42, facet: false, seed: 3.7, rough: 0.2, detail: 2 });
  const random = seededRandom(7);
  const shards = [
    [0, 0, 0.3, 1.65, 0.05, 0.0],
    [0.45, 0.2, 0.24, 1.25, 0.3, -0.5],
    [-0.4, 0.25, 0.26, 1.35, -0.28, 0.4],
    [0.15, -0.5, 0.22, 1.1, 0.35, 0.3],
    [-0.2, -0.45, 0.2, 0.95, -0.4, -0.3],
    [0.75, -0.2, 0.17, 0.85, 0.55, -0.1],
    [-0.8, 0.0, 0.18, 0.9, -0.5, 0.1],
    [0.1, 0.8, 0.2, 1.0, 0.1, 0.5],
    [0.6, 0.6, 0.15, 0.7, 0.4, 0.5],
    [-0.5, 0.65, 0.16, 0.75, -0.3, 0.55],
  ];
  for (const [x, z, r, h, rz, rx] of shards) s.crystal(CRYSTAL, x, 0.12, z, r, h, { rz, rx, ry: random() * TAU });
  // A scatter of small gems among the shards.
  for (let i = 0; i < 9; i++) {
    const a = i * 2.3 + 0.4;
    const d = 0.7 + random() * 0.55;
    const warm = i % 3 === 0;
    s.gem(warm ? AMBER : CRYSTAL, Math.cos(a) * d, 0.12 + random() * 0.1, Math.sin(a) * d, 0.1 + random() * 0.06, 0.3 + random() * 0.2, { ry: random() * TAU, rz: (random() - 0.5) * 0.8 });
  }
}

/** Builds the sculpts: `body` (front-faced, lit by the hide material) and `wings` (the membranes). */
function sculpt() {
  const body = new Sculpt();
  const wings = new Sculpt();

  // Torso and tail: one swept tube, scaled, spined, tapering to a point.
  const spine = curveOf(SPINE);
  const joints = [['chest', 1], ['body', 3], ...Array.from({ length: TAIL_BONES }, (_, i) => [`tail${i}`, 5 + i * 2])].map(([name, at]) => [ID[name], at]);
  const spineSkin = chain(joints, SPINE.length);
  const spineSteps = (SPINE.length - 1) * 6;
  const relief = scales({ steps: spineSteps, sides: 16, rows: spineSteps / 4, amp: 0.07 });
  body.tube(HIDE, SPINE, SPINE_RADIUS, { flat: [1.0, 0.94], sides: 16, steps: spineSteps, skin: spineSkin, bump: relief.bump, tint: relief.tint });
  ridge(body, BONE, spine, SPINE_RADIUS, 0.94, { from: 0.08, to: 0.9, count: 20, height: [0.5, 0.14], width: [0.11, 0.045], lean: 0.7, skin: spineSkin });
  // A barbed blade at the tail's tip.
  {
    const tip = SPINE[SPINE.length - 1];
    const before = SPINE[SPINE.length - 2];
    const dir = [tip[0] - before[0], 0, tip[2] - before[2]];
    const len = Math.hypot(dir[0], dir[2]);
    const x = new THREE.Vector3(dir[0] / len, 0, dir[2] / len);
    const y = new THREE.Vector3(0, 1, 0);
    const z = new THREE.Vector3().crossVectors(x, y);
    const matrix = new THREE.Matrix4().makeBasis(x, z.clone().negate(), y).setPosition(tip[0], tip[1] + 0.0, tip[2]);
    // The blade lies flat: its outline runs along the tail's heading, its thickness is vertical.
    body.extrude(HORN, 0, 0, 0, [[-0.1, 0], [0.15, 0.12], [0.55, 0.3], [0.95, 0.0], [0.55, -0.3], [0.15, -0.12]], 0.05, { matrix, bevel: 0.012, bone: ID.tail6, along: 'x' });
  }

  // Neck: an S of scaled tube, with a pale ribbed throat down its front.
  const neck = curveOf(NECK);
  const neckSkin = chain([...Array.from({ length: 6 }, (_, i) => [ID[`neck${i}`], i]), [ID.head, 6]], NECK.length);
  const neckSteps = 36;
  const neckRelief = scales({ steps: neckSteps, sides: 16, rows: 14, amp: 0.06 });
  body.tube(HIDE, NECK, NECK_RADIUS, { up: [-1, 0, 0], sides: 16, steps: neckSteps, skin: neckSkin, bump: neckRelief.bump, tint: neckRelief.tint });
  {
    const throat = NECK.map((p, i) => [p[0] + (NECK_RADIUS[i] * 0.86) * 0.97, p[1], p[2] - NECK_RADIUS[i] * 0.86 * 0.2]);
    const ribs = scales({ steps: 36, sides: 8, rows: 18, amp: 0.1, low: 0.2, high: 0.8 });
    body.tube(BELLY, throat, NECK_RADIUS.map((r) => r * 0.5), { up: [-1, 0, 0], flat: [1.15, 0.5], sides: 8, steps: 36, skin: neckSkin, bump: ribs.bump, tint: (u) => 0.25 + 0.6 * ribs.tint(u, 0.25) });
  }
  ridge(body, BONE, neck, NECK_RADIUS, 1, { from: 0.08, to: 0.9, count: 8, up: [-1, 0, 0], height: [0.4, 0.22], width: [0.1, 0.06], lean: -0.7, skin: neckSkin });

  // Chest, shoulders and haunches.
  body.bone(ID.chest);
  const chest = coil(CHEST, 2.2, 1.35, 0.15);
  body.ball(HIDE, chest[0], chest[1], chest[2], 1.0, { seg: 22, rings: 16, sy: 0.98, tint: (x, y) => 0.45 + 0.25 * y });
  const breast = coil(CHEST, 2.2, 0.9, 0.7);
  body.ball(BELLY, breast[0], breast[1], breast[2], 0.62, { seg: 16, rings: 12, sy: 0.8, tint: (x, y) => 0.4 + 0.2 * y });
  body.bone(ID.body);
  const haunch = (degrees, radius) => coil(degrees, radius, 1.05, 0.1);

  // Front legs reach forward, gripping the rock; hind legs sit folded under big haunches.
  body.bone(ID.chest);
  leg(body, [coil(CHEST, 3.0, 1.15), coil(CHEST, 3.35, 0.55, -0.5), coil(CHEST, 3.2, 0.25, 0.5), coil(CHEST, 3.15, 0.14, 0.95)], [0.6, 0.4, 0.28, 0.2], CHEST, 1);
  leg(body, [coil(CHEST, 1.5, 1.15), coil(CHEST, 1.15, 0.55, -0.5), coil(CHEST, 1.3, 0.25, 0.5), coil(CHEST, 1.35, 0.14, 0.95)], [0.6, 0.4, 0.28, 0.2], CHEST, -1);
  body.bone(ID.body);
  for (const [side, radius] of [[1, 3.05], [-1, 1.4]]) {
    const hip = haunch(HIP + 22, radius);
    body.ball(HIDE, hip[0], hip[1], hip[2], 0.7, { seg: 20, rings: 14, sx: 1.15, sy: 0.9, tint: (x, y) => 0.4 + 0.3 * y });
    const knee = coil(HIP + 22, radius + side * 0.2, 0.55, 0.9);
    const hock = coil(HIP + 22, radius + side * 0.12, 0.7, -0.25);
    const foot = coil(HIP + 22, radius + side * 0.1, 0.14, 0.4);
    body.limb(HIDE, hip, knee, 0.5, 0.3, { seg: 12 });
    body.ball(HIDE, knee[0], knee[1], knee[2], 0.31);
    body.limb(HIDE, knee, hock, 0.3, 0.2, { seg: 10 });
    body.ball(HIDE, hock[0], hock[1], hock[2], 0.21);
    spike(body, BONE, hock, [-0.8, 0.3, 0], 0.07, 0.36);
    body.limb(HIDE, hock, foot, 0.2, 0.17, { seg: 10 });
    const f = heading(HIP + 22);
    const o = outward(HIP + 22);
    body.ball(HIDE, foot[0], foot[1] + 0.03, foot[2], 0.2, { sx: 1.2, sy: 0.7 });
    for (const spread of [-1, 0, 1]) {
      const tip = [foot[0] + f[0] * 0.55 + o[0] * spread * 0.2, 0.07, foot[2] + f[2] * 0.55 + o[2] * spread * 0.2];
      body.limb(HIDE, [foot[0], foot[1], foot[2]], tip, 0.11, 0.07, { seg: 8, cap: 3 });
      spike(body, CLAW, [tip[0], tip[1] + 0.03, tip[2]], [f[0] + o[0] * spread * 0.2, -0.75, f[2] + o[2] * spread * 0.2], 0.06, 0.3, { seg: 6 });
    }
  }

  head(body);
  for (const side of SIDES) wing(body, wings, side);
  hoard(body);
  return { body, wings };
}

/* -------------------------------------------------------------------------- */
/* Breath                                                                     */
/* -------------------------------------------------------------------------- */

const BREATH_VERTEX = /* glsl */ `
attribute vec4 aColor;
attribute float aSize;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(-view.z, 0.1);
  gl_Position = projectionMatrix * view;
}
`;

const BREATH_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
varying vec4 vColor;
void main() {
  float shape = texture2D(uMap, gl_PointCoord).a;
  gl_FragColor = vec4(vColor.rgb, vColor.a * shape);
}
`;

/** A small pool of smoke wisps and embers, in the group's own space; each live particle is one point. */
function createBreath(glowTexture, capacity = 72) {
  const position = new Float32Array(capacity * 3);
  const velocity = new Float32Array(capacity * 3);
  const color = new Float32Array(capacity * 4);
  const size = new Float32Array(capacity);
  const age = new Float32Array(capacity).fill(-1);
  const life = new Float32Array(capacity).fill(1);
  const kind = new Uint8Array(capacity);
  const random = seededRandom(11);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 4).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const uniforms = { uMap: { value: glowTexture }, uScale: { value: 400 } };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: BREATH_VERTEX, fragmentShader: BREATH_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  const target = new THREE.Vector2();
  points.onBeforeRender = (renderer, scene, camera) => {
    const current = renderer.getRenderTarget();
    const height = current ? current.height : renderer.getDrawingBufferSize(target).y;
    uniforms.uScale.value = height * 0.5 * camera.projectionMatrix.elements[5];
  };
  let cursor = 0;
  const SMOKE = [0.62, 0.42, 0.3];
  const GREY = [0.22, 0.22, 0.26];

  return {
    points,
    /** Releases a wisp (kind 0) or an ember (kind 1) at a point, heading along (dx, dy, dz). */
    emit(type, x, y, z, dx, dy, dz) {
      const i = cursor;
      cursor = (cursor + 1) % capacity;
      const spread = type ? 0.5 : 0.22;
      position.set([x, y, z], i * 3);
      velocity[i * 3] = dx * (type ? 0.9 : 0.55) + (random() - 0.5) * spread;
      velocity[i * 3 + 1] = dy * (type ? 0.9 : 0.55) + (random() - 0.5) * spread * 0.6 + (type ? 0.15 : 0.1);
      velocity[i * 3 + 2] = dz * (type ? 0.9 : 0.55) + (random() - 0.5) * spread;
      age[i] = 0;
      life[i] = type ? 1.1 + random() * 0.9 : 2.4 + random() * 1.2;
      kind[i] = type;
    },
    step(dt) {
      for (let i = 0; i < capacity; i++) {
        if (age[i] < 0) continue;
        age[i] += dt;
        const t = age[i] / life[i];
        if (t >= 1) {
          age[i] = -1;
          color[i * 4 + 3] = 0;
          size[i] = 0;
          continue;
        }
        const drag = Math.exp(-dt * (kind[i] ? 0.6 : 1.3));
        velocity[i * 3] *= drag;
        velocity[i * 3 + 1] = velocity[i * 3 + 1] * drag + dt * (kind[i] ? 0.35 : 0.22);
        velocity[i * 3 + 2] *= drag;
        for (let k = 0; k < 3; k++) position[i * 3 + k] += velocity[i * 3 + k] * dt;
        if (kind[i]) {
          // Embers glow orange-white and dim to nothing.
          const glow = (1 - t) ** 1.5;
          color[i * 4] = 1.9 * glow + 0.2;
          color[i * 4 + 1] = 0.75 * glow;
          color[i * 4 + 2] = 0.22 * glow;
          color[i * 4 + 3] = Math.min(1, t * 12) * 0.9;
          size[i] = 0.07 * (1 - t * 0.4);
        } else {
          // Smoke is warm where it leaves the nostril and cools to a thin grey haze.
          const cool = smooth(Math.min(1, t * 1.6));
          const fade = Math.min(1, t * 6) * (1 - t) ** 1.4;
          for (let k = 0; k < 3; k++) color[i * 4 + k] = lerp(SMOKE[k], GREY[k], cool);
          color[i * 4 + 3] = 0.2 * fade;
          size[i] = 0.2 + 0.75 * t;
        }
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.aColor.needsUpdate = true;
      geometry.attributes.aSize.needsUpdate = true;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The Guardian                                                               */
/* -------------------------------------------------------------------------- */

/** How far from the cavern a hero is noticed, and how far the head may turn. */
const NOTICE = 24;
const YAW_LIMIT = 1.55;
const PITCH_LIMITS = [-0.6, 0.45];
/** Share of the head's turn each neck bone and the head takes. */
const YAW_SHARE = [0.06, 0.08, 0.12, 0.16, 0.18, 0.2, 0.2];
const PITCH_SHARE = [0.0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.4];

const INVERSE = new THREE.Matrix4();
const NOSE = new THREE.Vector3();
const FORWARD = new THREE.Vector3();
const AXIS_FORWARD = new THREE.Vector3(...heading(CHEST));
const AXIS_UP = new THREE.Vector3(0, 1, 0);
const Q2 = new THREE.Quaternion();
const HERO = new THREE.Vector3();

/**
 * The Guardian, standing in the cavern pit. `heroes` (to `update`) is an
 * array of { x, y, z, dead } in world space, or null.
 */
export function buildDragon({ envMap = null, glowTexture, addHalo }) {
  const { x: cx, z: cz, mouth } = MAP.cavern;
  const floor = terrainHeight(cx, cz);
  const { body, wings } = sculpt();

  const hideMaterial = surfaceMaterial({
    envMap,
    envIntensity: 0.55,
    rim: 0xff6a3a,
    rimStrength: 0.3,
    physical: { sheen: 0.45, sheenColor: new THREE.Color(0xff5a3a), sheenRoughness: 0.5, clearcoat: 0.12, clearcoatRoughness: 0.55 },
  });
  const wingMaterial = surfaceMaterial({ envMap, envIntensity: 0.45, rim: 0xff4a5a, rimStrength: 0.8, side: THREE.DoubleSide });

  const rig = buildSkeleton(BONES);
  const hide = new THREE.SkinnedMesh(body.skinned(), hideMaterial);
  const sails = new THREE.SkinnedMesh(wings.skinned(), wingMaterial);
  for (const mesh of [hide, sails]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
  }
  hide.add(rig.roots[0]);

  const group = new THREE.Group();
  group.name = 'guardian-dragon';
  group.position.set(cx, floor, cz);
  group.rotation.y = -mouth;
  group.scale.setScalar(SIZE);
  group.add(hide, sails);
  group.updateMatrixWorld(true);
  hide.bind(rig.skeleton);
  sails.bind(rig.skeleton);

  // Glints on the eyes and the nostrils' breath ride on the head.
  const eyeGlows = [-1, 1].map((side) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: 0xffa01a, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
    const at = headPoint(0.62, 0.22, side * 0.45);
    sprite.position.set(at[0] - HEAD_AT[0], at[1] - HEAD_AT[1], at[2] - HEAD_AT[2]);
    sprite.scale.setScalar(0.5);
    rig.head.add(sprite);
    return sprite;
  });
  const nostrils = [-1, 1].map((side) => {
    const at = headPoint(1.78, 0.06, side * 0.145);
    return new THREE.Vector3(at[0] - HEAD_AT[0], at[1] - HEAD_AT[1], at[2] - HEAD_AT[2]);
  });
  const breathing = createBreath(glowTexture);
  group.add(breathing.points);

  addHalo(cx, floor + 0.6, cz, 6.5, CYAN.halo, 0.4);

  // Rest positions, so the pose can be rebuilt from them every frame.
  const chestRest = rig.chest.position.clone();
  const headRest = HEAD_AT;
  const state = { yaw: 0, pitch: 0, attention: 0, heroYaw: 0, heroPitch: 0, emitSmoke: 0, emitEmber: 0 };
  const uniforms = hideMaterial.userData.uniforms;

  /** Turns a bone about an axis through its pivot. */
  const turn = (bone, axis, angle) => bone.quaternion.setFromAxisAngle(axis, angle);

  return {
    group,
    update(time, dt = 1 / 60, heroes = null) {
      dt = Math.min(Math.max(dt, 0), 0.1);

      // Whom to watch: the nearest living hero within reach of the cavern.
      let target = null;
      let nearest = NOTICE * NOTICE;
      if (heroes) {
        for (let i = 0; i < heroes.length; i++) {
          const hero = heroes[i];
          if (!hero || hero.dead) continue;
          const d = (hero.x - cx) ** 2 + (hero.z - cz) ** 2;
          if (d < nearest) {
            nearest = d;
            target = hero;
          }
        }
      }
      group.updateMatrixWorld();
      if (target) {
        INVERSE.copy(group.matrixWorld).invert();
        HERO.set(target.x, (target.y ?? floor) + 0.9, target.z).applyMatrix4(INVERSE);
        const dx = HERO.x - headRest[0];
        const dy = HERO.y - headRest[1];
        const dz = HERO.z - headRest[2];
        state.heroYaw = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, Math.atan2(-dz, dx)));
        state.heroPitch = Math.max(PITCH_LIMITS[0], Math.min(PITCH_LIMITS[1], Math.atan2(dy, Math.hypot(dx, dz)) - HEAD_PITCH));
      }
      state.attention += ((target ? 1 : 0) - state.attention) * (1 - Math.exp(-dt * 1.4));
      // With no one about it looks slowly round its pit.
      const idleYaw = 0.5 * Math.sin(time * 0.21) + 0.18 * Math.sin(time * 0.47 + 1);
      const idlePitch = 0.1 * Math.sin(time * 0.33 + 0.5);
      const goalYaw = lerp(idleYaw, state.heroYaw, smooth(state.attention));
      const goalPitch = lerp(idlePitch, state.heroPitch, smooth(state.attention));
      const ease = 1 - Math.exp(-dt * 2.6);
      // Never faster than a head can plausibly turn.
      const maxStep = 2.0 * dt;
      state.yaw += Math.max(-maxStep, Math.min(maxStep, (goalYaw - state.yaw) * ease));
      state.pitch += Math.max(-maxStep, Math.min(maxStep, (goalPitch - state.pitch) * ease));

      // Breathing: the chest swells and rises, and the whole neck rides it.
      const breath = Math.sin(time * 1.15);
      rig.chest.scale.set(1 + 0.02 * breath, 1 + 0.035 * breath, 1 + 0.03 * breath);
      rig.chest.position.set(chestRest.x, chestRest.y + 0.03 * breath, chestRest.z);

      // The neck: its own slow undulation plus its share of the look.
      for (let i = 0; i < 6; i++) {
        const bone = rig[`neck${i}`];
        bone.rotation.set(0.012 * Math.sin(time * 0.5 + i * 0.5), state.yaw * YAW_SHARE[i], state.pitch * PITCH_SHARE[i] + 0.02 * Math.sin(time * 0.62 - i * 0.55));
      }
      rig.head.rotation.set(0, state.yaw * YAW_SHARE[6], state.pitch * PITCH_SHARE[6] + 0.02 * breath);
      // The jaw hangs a little open, and opens wider on a slow snort.
      const snort = Math.max(0, Math.sin(time * 0.37)) ** 8;
      rig.jaw.rotation.z = -(0.05 + 0.025 * breath + 0.16 * snort);
      // Blink, now and then.
      const phase = (time + 1.3) % 4.9;
      const blink = phase < 0.18 ? Math.sin((phase / 0.18) * Math.PI) : 0;
      rig.eyeL.scale.y = rig.eyeR.scale.y = 1 - 0.92 * blink;
      const shine = 0.4 + 0.12 * Math.sin(time * 0.9) + 0.25 * snort - 0.4 * blink;
      for (const glow of eyeGlows) glow.material.opacity = shine;
      uniforms.uPulse.value = 0.12 * Math.sin(time * 1.7) + 0.08;

      // Tail: a travelling sway, wider towards the tip.
      for (let i = 0; i < TAIL_BONES; i++) {
        rig[`tail${i}`].rotation.y = (0.012 + i * 0.014) * Math.sin(time * 0.8 - i * 0.7);
      }

      // Wings: a slow beat that lifts, spreads and folds them.
      for (const side of SIDES) {
        const n = sideName(side);
        const beat = Math.sin(time * 0.95 + (side < 0 ? 0 : 0.35));
        const lag = Math.sin(time * 0.95 + (side < 0 ? 0 : 0.35) - 0.7);
        const raise = (a) => -side * a;
        turn(rig[`shoulder${n}`], AXIS_FORWARD, raise(0.16 * beat - 0.02));
        Q2.setFromAxisAngle(AXIS_UP, side * 0.1 * lag);
        rig[`shoulder${n}`].quaternion.premultiply(Q2);
        turn(rig[`elbow${n}`], AXIS_FORWARD, raise(0.2 * lag));
        turn(rig[`wrist${n}`], AXIS_FORWARD, raise(-0.2 * lag));
        const spread = 0.5 + 0.5 * lag;
        for (let i = 0; i < 4; i++) {
          // The fingers fan apart as the wing opens and gather as it folds.
          turn(rig[`finger${n}${i}`], AXIS_FORWARD, raise((1.5 - i) * 0.17 * (spread - 0.15)));
        }
      }

      // Pose done: settle matrices, then let the nostrils breathe.
      rig.roots[0].updateMatrixWorld(true);
      INVERSE.copy(group.matrixWorld).invert();
      const exhale = smooth(Math.max(0, -Math.cos(time * 1.15)));
      state.emitSmoke += dt * (3 + 9 * exhale + 18 * snort);
      state.emitEmber += dt * (0.7 + 3 * snort);
      FORWARD.set(1, 0, 0);
      for (const type of [0, 1]) {
        const key = type ? 'emitEmber' : 'emitSmoke';
        while (state[key] >= 1) {
          state[key] -= 1;
          for (const nostril of nostrils) {
            NOSE.copy(nostril).applyMatrix4(rig.head.matrixWorld).applyMatrix4(INVERSE);
            FORWARD.set(Math.cos(HEAD_PITCH), Math.sin(HEAD_PITCH), 0).transformDirection(rig.head.matrixWorld).transformDirection(INVERSE);
            breathing.emit(type, NOSE.x, NOSE.y, NOSE.z, FORWARD.x * 0.6, FORWARD.y * 0.6, FORWARD.z * 0.6);
          }
        }
      }
      breathing.step(dt);
    },
  };
}
