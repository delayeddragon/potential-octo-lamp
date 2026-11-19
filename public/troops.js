/**
 * RuneDeck — troop models: lane creeps, card units and the Frost Tower.
 *
 * Each kind is a sculpted, many-part model hung on a small skeleton and drawn
 * as one instanced rig (sculpt.js): a soldier has hips, a chest, a head, arms
 * with elbows, legs with knees, a blade in one hand and a shield on the other
 * arm. `pose` turns a unit's animation state into bone angles:
 *
 *   gait, moving   stride phase and how much of a walk is showing (0..1)
 *   strike         the attack: +1 wound up, -1 struck through, 0 at the ready
 *   time, phase    the clock, and the unit's own offset into it
 *
 * Every model faces +Z and stands on the origin; its left (shield) side is +X.
 * A hanging limb swings forwards with a negative turn about X.
 */

import { TorusGeometry } from 'three';

import { FINISH, Sculpt, createRig, defineBones, paint } from './sculpt.js';

const TAU = Math.PI * 2;

export const PALETTE = {
  radiant: {
    team: 0x4fc3ff,
    bar: [0.31, 0.76, 1.0],
    armor: [0x6f7f9c, 0xe6ecf7],
    cloth: [0x1648b8, 0x58b8ff],
    robe: [0x232c6a, 0x5a6fd0],
    stone: [0x5e6878, 0xc3cbda],
    glow: [0x39b8ff, 0xeaffff],
    trim: [0xb98a2c, 0xf7e3a0],
    dark: [0x2c3550, 0x56627f],
    skin: 0xd9c2a8,
  },
  dire: {
    team: 0xff5a36,
    bar: [1.0, 0.33, 0.24],
    armor: [0x2c2433, 0x7a6788],
    cloth: [0x8f141c, 0xff6a4a],
    robe: [0x3a1838, 0x8a3a6a],
    stone: [0x2a2530, 0x6e5f7a],
    glow: [0xff6a1a, 0xfff0c0],
    trim: [0x7a2a14, 0xf0803a],
    dark: [0x141118, 0x3b3044],
    skin: 0xb8a59a,
  },
};

const LEATHER = [0x2e2019, 0x6b4a32];
const WOOD = [0x3a2616, 0x8a6238];

/** The paints one side's troops are made of. */
function inks(side) {
  const c = PALETTE[side];
  const radiant = side === 'radiant';
  return {
    steel: paint(c.armor[0], c.armor[1], radiant ? FINISH.steel : FINISH.iron),
    plate: paint(c.armor[1], radiant ? 0xffffff : c.armor[1], radiant ? FINISH.chrome : FINISH.obsidian),
    mail: paint(c.dark[0], c.dark[1], FINISH.iron),
    dark: paint(c.dark[0], c.dark[1], FINISH.leather),
    cloth: paint(c.cloth[0], c.cloth[1], FINISH.cloth),
    robe: paint(c.robe[0], c.robe[1], FINISH.cloth),
    trim: paint(c.trim[0], c.trim[1], FINISH.gold),
    stone: paint(c.stone[0], c.stone[1], FINISH.stone),
    slab: paint(c.stone[0], c.stone[1], [0.05, 0.72, 0]),
    glow: paint(c.glow[0], c.glow[1], FINISH.glow),
    ember: paint(c.glow[0], c.glow[1], FINISH.ember),
    crystal: paint(c.glow[0], c.glow[1], FINISH.crystal),
    leather: paint(LEATHER[0], LEATHER[1], FINISH.leather),
    wood: paint(WOOD[0], WOOD[1], FINISH.wood),
    skin: paint(c.skin, c.skin, FINISH.skin),
    void: paint(0x05060c, 0x0c0f1a, FINISH.cloth),
    blade: paint(0xaab4c8, 0xffffff, FINISH.chrome),
  };
}

/** Scales a bone list's pivots: the same skeleton for a creep and for the bigger card unit. */
const scaled = (list, k) => defineBones(list.map(([name, parent, x, y, z]) => [name, parent, x * k, y * k, z * k]));

/* -------------------------------------------------------------------------- */
/* Soldiers: Melee Creeps and the Footmen Squad                               */
/* -------------------------------------------------------------------------- */

const SOLDIER_BONES = [
  ['root', null, 0, 0, 0],
  ['hips', 'root', 0, 0.56, 0],
  ['chest', 'hips', 0, 0.62, 0],
  ['head', 'chest', 0, 1.02, 0],
  ['armL', 'chest', 0.215, 0.96, 0],
  ['foreL', 'armL', 0.25, 0.75, 0],
  ['armR', 'chest', -0.215, 0.96, 0],
  ['foreR', 'armR', -0.25, 0.75, 0],
  ['blade', 'foreR', -0.265, 0.56, 0.02],
  ['thighL', 'hips', 0.085, 0.55, 0],
  ['shinL', 'thighL', 0.09, 0.3, 0],
  ['thighR', 'hips', -0.085, 0.55, 0],
  ['shinR', 'thighR', -0.09, 0.3, 0],
  ['tabard', 'hips', 0, 0.6, 0.17],
];

/**
 * An armoured soldier: rounded helm with a visor, cuirass under a team tabard,
 * chainmail skirt, greaves, a shield strapped to the left forearm and a sword.
 * `elite` is the Footman: taller, plumed, with a kite shield and a longer blade.
 */
function soldier(side, elite) {
  const k = elite ? 1.24 : 1;
  const bones = scaled(SOLDIER_BONES, k);
  const b = bones.id;
  const ink = inks(side);
  const s = new Sculpt();

  s.group(0, 0, 0, { s: k }, () => {
    // Legs: mailed thighs, a knee cop and a steel greave over a leather boot.
    for (const [sx, thigh, shin] of [[1, b.thighL, b.shinL], [-1, b.thighR, b.shinR]]) {
      s.bone(thigh).limb(ink.mail, [sx * 0.085, 0.55, 0], [sx * 0.09, 0.31, 0], 0.072, 0.058, { seg: 8, cap: 2 });
      s.bone(shin).ball(ink.plate, sx * 0.09, 0.3, 0.035, 0.05, { seg: 8, rings: 6 });
      s.limb(ink.steel, [sx * 0.09, 0.29, 0], [sx * 0.09, 0.08, 0], 0.06, 0.047, { seg: 8, cap: 2 });
      s.box(ink.leather, sx * 0.09, 0, 0.035, 0.1, 0.075, 0.2, { round: 0.03 });
    }

    // Hips: a chainmail skirt under a belt.
    s.bone(b.hips).lathe(ink.mail, 0, 0, 0, [[0.15, 0.63], [0.19, 0.52], [0.225, 0.37], [0.2, 0.375], [0.14, 0.56]], { seg: 14 });
    s.torus(ink.leather, 0, 0.61, 0, 0.158, 0.024, { sides: 6, seg: 14, sz: 0.86 });
    s.ball(ink.trim, 0, 0.61, 0.15, 0.03, { seg: 8, rings: 6 });

    // Chest: a rounded cuirass with the team's tabard over it, front and back.
    const cuirass = [[0.12, 0.58], [0.165, 0.66], [0.185, 0.8], [0.215, 0.93], [0.185, 1.0], [0.1, 1.04], [0, 1.048]];
    s.bone(b.chest).lathe(ink.steel, 0, 0, 0, cuirass, { seg: 14, sz: 0.8 });
    const over = cuirass.slice(1, 6).map(([r, h]) => [r + 0.012, h]);
    s.lathe(ink.cloth, 0, 0, 0, over, { seg: 6, start: -0.55, arc: 1.1, sz: 0.8 });
    s.lathe(ink.cloth, 0, 0, 0, over, { seg: 6, start: Math.PI - 0.55, arc: 1.1, sz: 0.8 });
    s.gem(ink.trim, 0, 0.86, 0.172, 0.04, 0.085, { sz: 0.4 });
    s.cyl(ink.mail, 0, 1.0, 0, 0.06, 0.07, 0.07, { seg: 8 });

    // The tabard's hanging tail sways with the stride.
    s.bone(b.tabard).extrude(ink.cloth, 0, 0.6, 0.178, [[-0.095, 0], [0.095, 0], [0.095, -0.2], [0, -0.28], [-0.095, -0.2]], 0.014, { rx: -0.23 });
    s.extrude(ink.trim, 0, 0.44, 0.222, [[-0.03, 0], [0, 0.04], [0.03, 0], [0, -0.04]], 0.008, { rx: -0.23 });

    // Arms: mail sleeves, steel bracers, layered pauldrons.
    for (const [sx, arm, fore] of [[1, b.armL, b.foreL], [-1, b.armR, b.foreR]]) {
      s.bone(arm).limb(ink.mail, [sx * 0.215, 0.96, 0], [sx * 0.25, 0.76, 0], 0.056, 0.048, { seg: 8, cap: 2 });
      s.ball(ink.plate, sx * 0.235, 0.985, 0, 0.088, { seg: 10, rings: 7, sy: 0.78 });
      s.ball(ink.steel, sx * 0.262, 0.935, 0, 0.07, { seg: 10, rings: 6, sy: 0.7 });
      s.torus(ink.trim, sx * 0.24, 0.96, 0, 0.082, 0.01, { sides: 5, seg: 12, rz: sx * 0.35 });
      s.bone(fore).limb(ink.steel, [sx * 0.25, 0.75, 0], [sx * 0.265, 0.6, 0], 0.05, 0.043, { seg: 8, cap: 2 });
      s.ball(ink.leather, sx * 0.265, 0.56, 0.005, 0.046, { seg: 8, rings: 6 });
    }

    // Head: a rounded helm, a visor with a lit eye slit, and a crest.
    s.bone(b.head).ball(ink.void, 0, 1.115, 0.02, 0.1, { seg: 10, rings: 8 });
    s.ball(ink.plate, 0, 1.135, -0.005, 0.128, { seg: 14, rings: 10, sy: 1.04 });
    s.lathe(ink.steel, 0, 1.12, 0, [[0.118, -0.1], [0.137, -0.06], [0.14, -0.005], [0.132, 0.03]], { seg: 10, start: -1.15, arc: 2.3 });
    s.box(ink.glow, 0, 1.118, 0.128, 0.15, 0.02, 0.03, { round: 0.008 });
    s.torus(ink.trim, 0, 1.152, -0.005, 0.129, 0.011, { sides: 5, seg: 16 });
    s.tube(ink.trim, [[0, 1.16, 0.13], [0, 1.25, 0.06], [0, 1.275, -0.03], [0, 1.2, -0.13]], 0.013, { sides: 5, flat: [0.8, 1.6], up: [1, 0, 0] });
    if (elite) {
      // A flowing plume in the team's colour.
      s.tube(ink.cloth, [[0, 1.27, 0.05], [0, 1.37, -0.02], [0, 1.37, -0.14], [0, 1.25, -0.25], [0, 1.1, -0.29]], [0.02, 0.055, 0.06, 0.045, 0.012], {
        sides: 7,
        flat: [0.45, 1],
        up: [1, 0, 0],
      });
    } else {
      s.cone(ink.plate, 0, 1.262, -0.01, 0.022, 0.07, { seg: 6 });
    }

    // Shield, strapped to the outside of the left forearm: it faces forwards when the arm is raised on guard.
    s.bone(b.foreL).group(0.312, 0.66, 0, { ry: Math.PI / 2 }, () => {
      if (elite) {
        const kite = (v) => 0.17 * Math.min(1, Math.sin(Math.min(1, v * 1.15) * Math.PI * 0.5) ** 0.8) * (v > 0.9 ? 1 - (v - 0.9) * 1.6 : 1);
        s.plate(ink.steel, 0, -0.3, 0, 0.52, (v) => kite(v) + 0.014, { bend: 1.5, thick: 0.02, nu: 6, nv: 9 });
        s.plate(ink.cloth, 0, -0.275, 0.012, 0.48, kite, { bend: 1.5, thick: 0.014, nu: 6, nv: 9 });
        s.extrude(ink.trim, 0, 0.03, 0.03, [[0, 0.1], [0.028, 0.028], [0.1, 0], [0.028, -0.028], [0, -0.13], [-0.028, -0.028], [-0.1, 0], [-0.028, 0.028]], 0.014);
        s.ball(ink.trim, 0, 0.03, 0.036, 0.03, { seg: 8, rings: 6 });
      } else {
        s.cyl(ink.steel, 0, 0, -0.012, 0.2, 0.2, 0.024, { seg: 16, rx: Math.PI / 2 });
        s.lathe(ink.cloth, 0, 0, 0.012, [[0.17, 0], [0.12, 0.016], [0.06, 0.024], [0, 0.026]], { seg: 16, rx: Math.PI / 2 });
        s.torus(ink.trim, 0, 0, 0.014, 0.182, 0.014, { sides: 5, seg: 18, rx: Math.PI / 2 });
        s.ball(ink.trim, 0, 0, 0.03, 0.05, { seg: 10, rings: 6, sz: 0.7 });
      }
    });

    // Sword: modelled point-up, held point-forward in the hanging right hand.
    const reach = elite ? 0.66 : 0.5;
    s.bone(b.blade).group(-0.265, 0.56, 0.02, { rx: Math.PI / 2 }, () => {
      s.ball(ink.trim, 0, -0.085, 0, 0.026, { seg: 8, rings: 6 });
      s.cyl(ink.leather, 0, -0.07, 0, 0.017, 0.017, 0.12, { seg: 6 });
      s.box(ink.trim, 0, 0.045, 0, elite ? 0.2 : 0.15, 0.028, 0.04, { round: 0.012 });
      s.extrude(ink.blade, 0, 0, 0, [[-0.03, 0.07], [0.03, 0.07], [0.026, reach], [0, reach + 0.08], [-0.026, reach]], 0.006, { bevel: 0.009, bevelDepth: 0.007 });
    });
  });

  return { sculpt: s, bones };
}

/** Half a ring standing on its ends, facing outwards at `angle` round a circle: an arch. */
const arch = (radius, tube, angle) => new TorusGeometry(radius, tube, 5, 10, Math.PI).rotateY(Math.PI / 2 - angle);

export const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** A pose value: `ready` at rest, towards `wound` as the strike winds up, towards `struck` as it lands. */
export const key = (u, ready, wound, struck) => ready + (u > 0 ? (wound - ready) * u : (ready - struck) * u);

/** Legs, hips and arm swing shared by everything that walks on two legs. */
export function stride(rig, view, time, reach, knee) {
  const { id, rot, shift, size } = rig;
  const m = view.moving;
  const step = Math.sin(view.gait);
  const lift = Math.cos(view.gait);
  rot[id.thighL * 3] = -step * reach * m;
  rot[id.thighR * 3] = step * reach * m;
  rot[id.shinL * 3] = Math.max(0, lift) * knee * m + 0.04;
  rot[id.shinR * 3] = Math.max(0, -lift) * knee * m + 0.04;
  // The body rises as each leg passes under it, and breathes when it stands.
  shift[id.root * 3 + 1] = -m * 0.03 * (1 - Math.abs(lift)) * rig.height;
  rot[id.hips * 3 + 2] = step * 0.05 * m;
  rot[id.chest * 3 + 1] = step * 0.14 * m;
  size[id.chest] = 1 + Math.sin(time * 2.1 + view.phase) * 0.014 * (1 - m);
  return step * m;
}

function poseSoldier(rig, view, time) {
  const { id, rot, shift } = rig;
  rig.rest();
  const u = view.strike;
  const walk = stride(rig, view, time, 0.62, 1.0);
  const calm = 1 - Math.abs(u);
  const sway = Math.sin(time * 1.7 + view.phase);

  // Wind up over the right shoulder, cut down across the body, recover.
  rot[id.chest * 3] += key(u, 0.06, -0.14, 0.34);
  rot[id.chest * 3 + 1] += key(u, 0, -0.5, 0.55);
  rot[id.head * 3 + 1] = key(u, 0, 0.3, -0.3) + sway * 0.06 * calm;
  rot[id.armR * 3] = key(u, -0.42, -2.75, -1.0) - walk * 0.4 * calm;
  rot[id.armR * 3 + 2] = key(u, -0.12, -0.35, 0.5);
  rot[id.foreR * 3] = key(u, -0.75, -1.0, -0.15);
  rot[id.blade * 3] = key(u, -0.45, -0.5, 0.75) + sway * 0.04 * calm;
  rot[id.blade * 3 + 2] = key(u, 0, 0.3, -0.5);
  shift[id.root * 3 + 2] = key(u, 0, -0.05, 0.16) * rig.height;
  shift[id.root * 3 + 1] += key(u, 0, 0, -0.035) * rig.height;
  rot[id.thighL * 3] += key(u, 0, 0.1, -0.5);
  rot[id.shinL * 3] += key(u, 0, 0, 0.45);
  rot[id.thighR * 3] += key(u, 0, -0.1, 0.3);

  // The shield stays up on guard, and comes across the body as the blow lands.
  rot[id.armL * 3] = key(u, -0.3, -0.5, -0.1) + walk * 0.3;
  rot[id.armL * 3 + 1] = key(u, -0.95, -1.15, -0.45);
  rot[id.foreL * 3] = key(u, -1.35, -1.5, -1.1) + sway * 0.03;
  rot[id.tabard * 3] = -view.moving * 0.3 - Math.abs(walk) * 0.25 + sway * 0.03 + key(u, 0, 0.1, -0.35);
}

/* -------------------------------------------------------------------------- */
/* Valkyrie Spinner                                                           */
/* -------------------------------------------------------------------------- */

const VALKYRIE_BONES = [...SOLDIER_BONES, ['braid', 'head', 0, 1.1, -0.11]];
const VALKYRIE_SCALE = 1.22;
/** Hair the colour of straw, the same for both sides. */
const HAIR = [0x9a6e22, 0xf0d27a];

/**
 * A shield-maiden: a winged helm over a long braid, a breastplate in the team's
 * colour, bare arms ringed in gold, a round shield and a double-bladed great
 * axe. The axe is modelled point-up in the right hand, like the soldier's sword.
 */
function valkyrie(side) {
  const k = VALKYRIE_SCALE;
  const bones = scaled(VALKYRIE_BONES, k);
  const b = bones.id;
  const ink = inks(side);
  const hair = paint(HAIR[0], HAIR[1], FINISH.leather);
  const s = new Sculpt();

  s.group(0, 0, 0, { s: k }, () => {
    // Legs: wrapped leather boots under steel greaves, with a bright knee cop.
    for (const [sx, thigh, shin] of [[1, b.thighL, b.shinL], [-1, b.thighR, b.shinR]]) {
      s.bone(thigh).limb(ink.skin, [sx * 0.085, 0.55, 0], [sx * 0.09, 0.31, 0], 0.066, 0.052, { seg: 8, cap: 2 });
      s.bone(shin).ball(ink.plate, sx * 0.09, 0.3, 0.035, 0.05, { seg: 8, rings: 6 });
      s.limb(ink.leather, [sx * 0.09, 0.29, 0], [sx * 0.09, 0.08, 0], 0.058, 0.046, { seg: 8, cap: 2 });
      s.limb(ink.steel, [sx * 0.09, 0.28, 0.01], [sx * 0.09, 0.14, 0.012], 0.062, 0.05, { seg: 8, cap: 2 });
      s.torus(ink.trim, sx * 0.09, 0.2, 0, 0.056, 0.01, { sides: 5, seg: 12 });
      s.box(ink.leather, sx * 0.09, 0, 0.035, 0.1, 0.075, 0.2, { round: 0.03 });
    }

    // Hips: a skirt of leather straps hung from a gold-studded belt, under a team-coloured sash.
    s.bone(b.hips).lathe(ink.leather, 0, 0, 0, [[0.15, 0.63], [0.2, 0.5], [0.235, 0.38], [0.21, 0.385], [0.14, 0.56]], { seg: 16 });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      s.box(ink.steel, Math.sin(a) * 0.205, 0.46, Math.cos(a) * 0.185, 0.07, 0.19, 0.012, { round: 0.004, ry: a, rx: 0.12 });
    }
    s.torus(ink.trim, 0, 0.62, 0, 0.158, 0.026, { sides: 6, seg: 16, sz: 0.86 });
    s.ball(ink.trim, 0, 0.61, 0.15, 0.034, { seg: 8, rings: 6 });

    // Chest: a polished breastplate with a team-coloured sash, a gold collar and a winged emblem.
    const cuirass = [[0.115, 0.58], [0.155, 0.66], [0.175, 0.8], [0.2, 0.93], [0.17, 0.99], [0.09, 1.03], [0, 1.04]];
    s.bone(b.chest).lathe(ink.plate, 0, 0, 0, cuirass, { seg: 14, sz: 0.76 });
    const over = cuirass.slice(1, 5).map(([r, h]) => [r + 0.012, h]);
    s.lathe(ink.cloth, 0, 0, 0, over, { seg: 6, start: -0.4, arc: 0.8, sz: 0.76 });
    s.lathe(ink.cloth, 0, 0, 0, over, { seg: 6, start: Math.PI - 0.4, arc: 0.8, sz: 0.76 });
    s.torus(ink.trim, 0, 0.985, 0, 0.14, 0.014, { sides: 5, seg: 16, sz: 0.76 });
    s.torus(ink.trim, 0, 0.64, 0, 0.15, 0.014, { sides: 5, seg: 16, sz: 0.76 });
    for (const sx of [1, -1]) {
      s.extrude(ink.trim, sx * 0.06, 0.88, 0.152, [[0, 0.02], [sx * 0.08, 0.05], [sx * 0.07, 0], [sx * 0.04, -0.025], [0, -0.03]], 0.01, { ry: sx * 0.35 });
    }
    s.gem(ink.glow, 0, 0.87, 0.158, 0.03, 0.06, { sz: 0.4 });
    s.cyl(ink.skin, 0, 1.0, 0, 0.05, 0.06, 0.07, { seg: 8 });
    s.bone(b.tabard).extrude(ink.cloth, 0, 0.6, 0.178, [[-0.085, 0], [0.085, 0], [0.09, -0.22], [0, -0.32], [-0.09, -0.22]], 0.014, { rx: -0.23 });
    s.extrude(ink.trim, 0, 0.4, 0.226, [[-0.03, 0], [0, 0.04], [0.03, 0], [0, -0.04]], 0.008, { rx: -0.23 });

    // Arms: bare, with gold bands, a bracer and one big winged pauldron.
    for (const [sx, arm, fore] of [[1, b.armL, b.foreL], [-1, b.armR, b.foreR]]) {
      s.bone(arm).limb(ink.skin, [sx * 0.215, 0.96, 0], [sx * 0.25, 0.76, 0], 0.052, 0.044, { seg: 8, cap: 2 });
      s.ball(ink.plate, sx * 0.235, 0.99, 0, 0.09, { seg: 10, rings: 7, sy: 0.74 });
      s.torus(ink.trim, sx * 0.24, 0.96, 0, 0.084, 0.01, { sides: 5, seg: 12, rz: sx * 0.35 });
      s.torus(ink.trim, sx * 0.246, 0.84, 0, 0.05, 0.012, { sides: 5, seg: 10 });
      s.bone(fore).limb(ink.skin, [sx * 0.25, 0.75, 0], [sx * 0.265, 0.6, 0], 0.044, 0.038, { seg: 8, cap: 2 });
      s.limb(ink.steel, [sx * 0.25, 0.72, 0], [sx * 0.262, 0.62, 0], 0.052, 0.046, { seg: 8, cap: 2 });
      s.torus(ink.trim, sx * 0.253, 0.7, 0, 0.05, 0.01, { sides: 5, seg: 10 });
      s.ball(ink.skin, sx * 0.265, 0.56, 0.005, 0.042, { seg: 8, rings: 6 });
    }

    // Head: a face, a silver helm with a nasal bar and a pair of swept wings, and a long braid.
    s.bone(b.head).ball(ink.skin, 0, 1.115, 0.025, 0.09, { seg: 10, rings: 8 });
    s.ball(ink.plate, 0, 1.15, -0.012, 0.122, { seg: 14, rings: 10, sy: 0.96 });
    s.torus(ink.trim, 0, 1.155, -0.005, 0.123, 0.011, { sides: 5, seg: 16 });
    s.box(ink.steel, 0, 1.12, 0.118, 0.03, 0.14, 0.02, { round: 0.008 });
    s.ball(ink.void, -0.036, 1.14, 0.098, 0.011, { seg: 6, rings: 4 });
    s.ball(ink.void, 0.036, 1.14, 0.098, 0.011, { seg: 6, rings: 4 });
    for (const sx of [1, -1]) {
      // A wing sweeps back and up off each temple.
      s.extrude(ink.plate, sx * 0.125, 1.2, -0.02, [[0, 0], [sx * 0.07, 0.06], [sx * 0.19, 0.2], [sx * 0.15, 0.21], [sx * 0.12, 0.18], [sx * 0.11, 0.21], [sx * 0.07, 0.16], [sx * 0.04, 0.1]], 0.012, { ry: -sx * 0.5, rz: sx * 0.2 });
      s.extrude(ink.trim, sx * 0.128, 1.19, -0.02, [[0, 0], [sx * 0.04, 0.03], [sx * 0.05, -0.01]], 0.016, { ry: -sx * 0.5 });
    }
    // The braid hangs from the back of the head and swings on its own bone.
    s.tube(hair, [[0, 1.17, -0.1], [0, 1.1, -0.16], [0, 0.98, -0.2]], [0.05, 0.05, 0.045], { sides: 6, steps: 6 });
    s.bone(b.braid).tube(hair, [[0, 1.1, -0.11], [0, 1.0, -0.18], [0, 0.86, -0.2], [0, 0.7, -0.18], [0, 0.58, -0.17]], [0.045, 0.04, 0.036, 0.03, 0.012], { sides: 6, steps: 12, bump: (u) => 1 + 0.12 * Math.sin(u * 40) });
    s.ball(ink.trim, 0, 0.7, -0.18, 0.03, { seg: 8, rings: 6 });

    // Round shield, strapped to the left forearm.
    s.bone(b.foreL).group(0.312, 0.66, 0, { ry: Math.PI / 2 }, () => {
      s.cyl(ink.steel, 0, 0, -0.012, 0.25, 0.25, 0.026, { seg: 20, rx: Math.PI / 2 });
      s.lathe(ink.cloth, 0, 0, 0.012, [[0.21, 0], [0.15, 0.018], [0.07, 0.028], [0, 0.03]], { seg: 20, rx: Math.PI / 2 });
      s.torus(ink.trim, 0, 0, 0.014, 0.228, 0.016, { sides: 5, seg: 24, rx: Math.PI / 2 });
      s.torus(ink.trim, 0, 0, 0.026, 0.12, 0.01, { sides: 5, seg: 18, rx: Math.PI / 2 });
      s.ball(ink.trim, 0, 0, 0.034, 0.06, { seg: 10, rings: 6, sz: 0.7 });
    });

    // Great axe: a long haft, a spike on top and a broad crescent blade on each side.
    s.bone(b.blade).group(-0.265, 0.56, 0.02, { rx: Math.PI / 2 }, () => {
      s.ball(ink.trim, 0, -0.17, 0, 0.03, { seg: 8, rings: 6 });
      s.cyl(ink.wood, 0, -0.15, 0, 0.022, 0.022, 0.95, { seg: 8 });
      for (const y of [-0.1, 0.02, 0.14]) s.cyl(ink.leather, 0, y, 0, 0.027, 0.027, 0.08, { seg: 8 });
      s.box(ink.trim, 0, 0.74, 0, 0.1, 0.07, 0.07, { round: 0.02 });
      s.cone(ink.blade, 0, 0.78, 0, 0.026, 0.2, { seg: 6 });
      for (const sx of [1, -1]) {
        s.extrude(ink.blade, 0, 0, 0, [[0, 0.65], [sx * 0.1, 0.62], [sx * 0.24, 0.55], [sx * 0.31, 0.7], [sx * 0.26, 0.86], [sx * 0.12, 0.8], [0, 0.78]], 0.014, { bevel: 0.008, bevelDepth: 0.006 });
        s.tube(ink.glow, [[sx * 0.04, 0.7, 0], [sx * 0.16, 0.7, 0], [sx * 0.26, 0.7, 0]], 0.008, { sides: 4, steps: 4 });
      }
    });
  });

  return { sculpt: s, bones };
}

function poseValkyrie(rig, view, time) {
  const { id, rot, shift } = rig;
  rig.rest();
  const walk = stride(rig, view, time, 0.58, 1.0);
  const sway = Math.sin(time * 1.6 + view.phase);
  const t = 1 - view.swing;
  const spinning = view.swing > 0;

  // On guard: the axe stands upright in the right hand, the shield is up on the left.
  rot[id.chest * 3] += 0.05 + view.ready * 0.12;
  rot[id.chest * 3 + 1] += view.ready * -0.35;
  rot[id.head * 3 + 1] = sway * 0.05;
  rot[id.armR * 3] = -0.55 - walk * 0.25 - view.ready * 0.5;
  rot[id.armR * 3 + 2] = -0.14 - view.ready * 0.25;
  rot[id.foreR * 3] = -1.0;
  rot[id.blade * 3] = -1.0 + view.ready * 0.5 + sway * 0.03;
  rot[id.armL * 3] = -0.3 + walk * 0.25;
  rot[id.armL * 3 + 1] = -0.95;
  rot[id.foreL * 3] = -1.35 + sway * 0.03;
  shift[id.root * 3 + 1] += -view.ready * 0.03 * rig.height;
  rot[id.tabard * 3] = -view.moving * 0.3 - Math.abs(walk) * 0.25 + sway * 0.03;
  rot[id.braid * 3] = 0.12 + view.moving * 0.5 + Math.sin(time * 5 + view.phase) * 0.05 * view.moving + sway * 0.04;

  if (spinning) {
    // The whole body turns once, the axe held straight out to the right so its head sweeps the full circle.
    const progress = clamp01(t / 0.86);
    const turn = progress * progress * (3 - 2 * progress);
    const out = Math.sin(clamp01(t / 0.9) * Math.PI) ** 0.5;
    rot[id.root * 3 + 1] = turn * TAU;
    rot[id.armR * 3] = -0.55 * (1 - out);
    rot[id.armR * 3 + 2] = -0.14 + (-Math.PI / 2 + 0.14) * out;
    rot[id.foreR * 3] = -1.0 * (1 - out);
    // Turned about the forearm's own axis, the axe points down the outstretched arm.
    rot[id.blade * 3] = -1.0 * (1 - out) + (Math.PI / 2) * out;
    rot[id.chest * 3] += 0.12 * out;
    rot[id.braid * 3] += 0.5 * out;
    rot[id.armL * 3 + 2] = 0.35 * out;
    rot[id.hips * 3 + 2] += 0.08 * out;
    shift[id.root * 3 + 1] += -0.05 * out * rig.height;
  }
}

/* -------------------------------------------------------------------------- */
/* Casters: Ranged Creeps (staff) and Arcane Archers (bow)                    */
/* -------------------------------------------------------------------------- */

const CASTER_BONES = [
  ['root', null, 0, 0, 0],
  ['hips', 'root', 0, 0.56, 0],
  ['chest', 'hips', 0, 0.62, 0],
  ['head', 'chest', 0, 1.02, 0],
  ['armL', 'chest', 0.2, 0.95, 0],
  ['foreL', 'armL', 0.235, 0.75, 0],
  ['armR', 'chest', -0.2, 0.95, 0],
  ['foreR', 'armR', -0.235, 0.75, 0],
  ['thighL', 'hips', 0.08, 0.5, 0],
  ['shinL', 'thighL', 0.08, 0.28, 0],
  ['thighR', 'hips', -0.08, 0.5, 0],
  ['shinR', 'thighR', -0.08, 0.28, 0],
  ['robe', 'hips', 0, 0.62, 0],
];
const HAND_L = [0.25, 0.56, 0.02];
const HAND_R = [-0.25, 0.56, 0.02];
/** The bow, in its own frame: half its height, and how far behind the grip the string sits. */
const BOW = { half: 0.44, back: 0.14, draw: 0.3 };
const STAFF = { foot: -0.56, head: 0.5, orb: 0.66 };

/**
 * A hooded battle-mage: sculpted robes that fall in folds, a cowl with two lit
 * eyes in its shadow and a quiver on the back. The Ranged Creep carries a
 * crystal staff with a mana orb turning above its head; the Arcane Archer
 * (`elite`) a recurved bow strung with light.
 */
function caster(side, elite) {
  const k = elite ? 1.24 : 1;
  const [hx, hy, hz] = elite ? HAND_L : HAND_R;
  const item = elite
    ? [
        ['bow', 'foreL', hx, hy, hz],
        ['stringT', 'bow', hx, hy + BOW.back, hz + BOW.half],
        ['stringB', 'bow', hx, hy + BOW.back, hz - BOW.half],
        ['arrow', 'bow', hx, hy + BOW.back, hz],
      ]
    : [
        ['staff', 'foreR', hx, hy, hz],
        ['orb', 'staff', hx, hy, hz + STAFF.orb],
        ['halo', 'orb', hx, hy, hz + STAFF.orb],
      ];
  const bones = scaled([...CASTER_BONES, ...item], k);
  const b = bones.id;
  const ink = inks(side);
  const eyes = elite ? paint(0x59b8ff, 0xeaffff, FINISH.ember) : ink.ember;
  const s = new Sculpt();

  s.group(0, 0, 0, { s: k }, () => {
    for (const [sx, thigh, shin] of [[1, b.thighL, b.shinL], [-1, b.thighR, b.shinR]]) {
      s.bone(thigh).limb(ink.dark, [sx * 0.08, 0.5, 0], [sx * 0.08, 0.29, 0], 0.06, 0.05, { seg: 6, cap: 2 });
      s.bone(shin).limb(ink.leather, [sx * 0.08, 0.28, 0], [sx * 0.08, 0.07, 0], 0.052, 0.045, { seg: 6, cap: 2 });
      s.box(ink.leather, sx * 0.08, 0, 0.03, 0.095, 0.07, 0.19, { round: 0.03 });
    }

    // The skirt of the robe: a bell that falls in deep folds, hemmed in the team's colour.
    const bell = (u) => 0.15 + 0.17 * u ** 0.85;
    s.bone(b.robe).tube(ink.robe, [[0, 0.64, 0], [0, 0.4, 0], [0, 0.2, 0], [0, 0.055, 0]], bell, {
      steps: 7,
      sides: 26,
      up: [0, 0, 1],
      flat: [1, 0.88],
      bump: (u, v) => 1 + 0.085 * u * Math.sin(v * TAU * 8),
      tint: (u, v) => 1 - u * 0.85 + 0.12 * Math.sin(v * TAU * 8) * u,
      caps: false,
    });
    s.tube(ink.cloth, [[0, 0.075, 0], [0, 0.045, 0]], 0.325, { steps: 1, sides: 26, up: [0, 0, 1], flat: [1, 0.88], bump: (u, v) => 1 + 0.085 * Math.sin(v * TAU * 8) });

    // Chest: the robe's bodice, a sash and a mantle over the shoulders.
    s.bone(b.chest).lathe(ink.robe, 0, 0, 0, [[0.13, 0.58], [0.16, 0.72], [0.185, 0.9], [0.16, 0.99], [0.08, 1.03], [0, 1.036]], { seg: 12, sz: 0.8 });
    s.torus(ink.cloth, 0, 0.64, 0, 0.15, 0.03, { sides: 6, seg: 14, sz: 0.84 });
    s.gem(ink.trim, 0, 0.64, 0.15, 0.036, 0.07, { sz: 0.45 });
    s.lathe(ink.cloth, 0, 0, 0, [[0.085, 1.05], [0.2, 0.995], [0.25, 0.9], [0.255, 0.85], [0.225, 0.86], [0.18, 0.95]], { seg: 14, sz: 0.84 });
    s.torus(ink.trim, 0, 0.855, 0, 0.253, 0.011, { sides: 5, seg: 18, sz: 0.84 });
    s.gem(ink.glow, 0, 0.95, 0.19, 0.03, 0.06, { sz: 0.5 });

    // A quiver slung across the back, its arrows fletched with light.
    s.group(-0.06, 0.7, -0.17, { rz: 0.42, rx: -0.12 }, () => {
      s.cyl(ink.leather, 0, 0, 0, 0.05, 0.042, 0.34, { seg: 8 });
      s.torus(ink.trim, 0, 0.32, 0, 0.051, 0.01, { sides: 5, seg: 10 });
      for (const [ax, az] of [[0.018, 0.012], [-0.02, 0.006], [0, -0.022]]) {
        s.cyl(ink.wood, ax, 0.3, az, 0.006, 0.006, 0.16, { seg: 4 });
        s.gem(eyes, ax, 0.47, az, 0.018, 0.07);
      }
    });

    // Arms in wide sleeves.
    for (const [sx, arm, fore] of [[1, b.armL, b.foreL], [-1, b.armR, b.foreR]]) {
      s.bone(arm).limb(ink.robe, [sx * 0.2, 0.95, 0], [sx * 0.235, 0.76, 0], 0.058, 0.056, { seg: 8, cap: 2 });
      s.bone(fore).limb(ink.robe, [sx * 0.235, 0.75, 0], [sx * 0.248, 0.61, 0], 0.052, 0.074, { seg: 8, cap: 2 });
      s.torus(ink.trim, sx * 0.248, 0.6, 0, 0.07, 0.01, { sides: 5, seg: 10 });
      s.ball(ink.skin, sx * 0.25, 0.56, 0.01, 0.04, { seg: 8, rings: 6 });
    }

    // Head: a deep cowl, nothing in it but two points of light.
    s.bone(b.head).ball(ink.robe, 0, 1.125, -0.012, 0.138, { seg: 14, rings: 10 });
    s.ball(ink.void, 0, 1.108, 0.045, 0.1, { seg: 12, rings: 8 });
    s.torus(ink.cloth, 0, 1.112, 0.07, 0.108, 0.026, { sides: 6, seg: 16, rx: Math.PI / 2 });
    s.tube(ink.robe, [[0, 1.2, -0.02], [0, 1.23, -0.11], [0, 1.15, -0.2], [0, 1.02, -0.23]], [0.1, 0.085, 0.05, 0.012], { sides: 8, up: [1, 0, 0] });
    for (const sx of [-1, 1]) s.ball(eyes, sx * 0.042, 1.118, 0.137, 0.019, { seg: 6, rings: 5 });

    if (elite) {
      // The bow is modelled upright and aimed along +Z, then laid along the hanging arm: raising the arm stands it up.
      const { half, back } = BOW;
      s.bone(b.bow).group(hx, hy, hz, { rx: Math.PI / 2 }, () => {
        const limbs = [[0, -half, -back], [0, -half * 0.82, -back * 0.42], [0, -half * 0.45, -0.005], [0, 0, 0.012], [0, half * 0.45, -0.005], [0, half * 0.82, -back * 0.42], [0, half, -back]];
        s.tube(ink.wood, limbs, [0.008, 0.017, 0.022, 0.027, 0.022, 0.017, 0.008], { sides: 6, steps: 18, up: [0, 0, 1], flat: [0.75, 1.25] });
        s.cyl(ink.leather, 0, -0.06, 0.012, 0.03, 0.03, 0.12, { seg: 6 });
        for (const sy of [-1, 1]) {
          s.torus(ink.trim, 0, sy * half * 0.45, -0.005, 0.024, 0.008, { sides: 4, seg: 8 });
          s.gem(ink.glow, 0, sy * (half + 0.012), -back - 0.005, 0.026, 0.09);
        }
        s.bone(b.stringT).limb(ink.glow, [0, half, -back], [0, 0, -back], 0.006, 0.006, { seg: 4, cap: 1 });
        s.bone(b.stringB).limb(ink.glow, [0, -half, -back], [0, 0, -back], 0.006, 0.006, { seg: 4, cap: 1 });
        s.bone(b.arrow).limb(ink.ember, [0, 0, -back], [0, 0, -back + 0.46], 0.009, 0.009, { seg: 5, cap: 1 });
        s.gem(ink.ember, 0, 0, -back + 0.5, 0.03, 0.12, { rx: Math.PI / 2 });
      });
    } else {
      // The staff is modelled head-up, and lies point-forward in the hanging hand: bending the elbow stands it up.
      s.bone(b.staff).group(hx, hy, hz, { rx: Math.PI / 2 }, () => {
        s.tube(ink.wood, [[0, STAFF.foot, 0], [0.012, -0.2, 0], [-0.008, 0.2, 0], [0, STAFF.head, 0]], [0.014, 0.02, 0.019, 0.022], { sides: 6, up: [0, 0, 1] });
        s.cone(ink.trim, 0, STAFF.foot, 0, 0.02, 0.07, { seg: 6, rx: Math.PI });
        for (const y of [-0.08, 0.06, STAFF.head - 0.04]) s.torus(ink.trim, 0, y, 0, 0.023, 0.008, { sides: 4, seg: 8 });
        // A claw of three prongs cradles the orb.
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * TAU;
          const [cx, cz] = [Math.cos(a), Math.sin(a)];
          s.tube(ink.trim, [[0, STAFF.head - 0.02, 0], [cx * 0.075, STAFF.head + 0.06, cz * 0.075], [cx * 0.095, STAFF.orb, cz * 0.095], [cx * 0.05, STAFF.orb + 0.11, cz * 0.05]], [0.014, 0.013, 0.01, 0.003], { sides: 5 });
        }
        s.crystal(ink.crystal, 0, STAFF.head, 0, 0.03, 0.09);
        s.bone(b.orb).ball(ink.ember, 0, STAFF.orb, 0, 0.055, { seg: 12, rings: 8 });
        s.gem(ink.crystal, 0, STAFF.orb, 0, 0.075, 0.2, { ry: 0.6 });
        s.bone(b.halo).torus(ink.glow, 0, STAFF.orb, 0, 0.115, 0.008, { sides: 4, seg: 18 });
        for (let i = 0; i < 3; i++) s.gem(ink.glow, Math.cos((i / 3) * TAU) * 0.115, STAFF.orb, Math.sin((i / 3) * TAU) * 0.115, 0.016, 0.045);
      });
    }
  });

  return { sculpt: s, bones };
}

/** What both casters share: the walk under the robe, the skirt's sway, the breathing. */
function poseRobed(rig, view, time) {
  const { id, rot } = rig;
  rig.rest();
  const walk = stride(rig, view, time, 0.5, 0.8);
  const sway = Math.sin(time * 1.5 + view.phase);
  rot[id.robe * 3] = view.moving * 0.14 + sway * 0.015;
  rot[id.robe * 3 + 2] = walk * 0.07 + sway * 0.02;
  rot[id.head * 3] = 0.05 + sway * 0.03;
  return walk;
}

function poseStaff(rig, view, time) {
  const { id, rot, shift, size } = rig;
  const walk = poseRobed(rig, view, time);
  const u = view.strike;
  const cast = Math.max(0, -u);
  const bob = Math.sin(time * 2.6 + view.phase);

  // The staff is drawn back as the spell gathers, then thrust at the target; it recoils as the bolt leaves.
  rot[id.chest * 3] += key(u, 0.04, -0.1, 0.2);
  rot[id.chest * 3 + 1] += key(u, 0, -0.35, 0.3);
  rot[id.armR * 3] = key(u, -0.15, 0.35, -1.05) - walk * 0.2;
  rot[id.armR * 3 + 2] = key(u, -0.2, -0.45, -0.1);
  rot[id.foreR * 3] = key(u, -1.3, -1.85, -0.75);
  rot[id.staff * 3] = key(u, -0.05, -0.4, 0.5) + walk * 0.08;
  shift[id.root * 3 + 2] = key(u, 0, -0.03, 0.07) * rig.height;
  // The free hand steadies the spell.
  rot[id.armL * 3] = key(u, -0.1, -0.9, -1.3) + walk * 0.35;
  rot[id.armL * 3 + 2] = key(u, 0.12, 0.25, 0.1);
  rot[id.foreL * 3] = key(u, -0.25, -1.0, -0.4);

  // The mana orb floats and turns above the staff's head, swelling as the spell gathers.
  shift[id.orb * 3 + 2] = (0.03 + bob * 0.02 + cast * 0.05) * rig.height;
  rot[id.orb * 3 + 2] = time * 1.6 + view.phase;
  size[id.orb] = 1 + Math.max(0, u) * 0.45 + cast * 0.8 + bob * 0.05;
  rot[id.halo * 3 + 2] = time * 2.8;
  rot[id.halo * 3] = 0.5 + bob * 0.2;
}

function poseBow(rig, view, time) {
  const { id, rot, shift, size } = rig;
  const walk = poseRobed(rig, view, time);
  // The bow comes up and is drawn as the shot nears, snaps forward on release, then is lowered.
  const u = view.strike;
  const up = clamp01(Math.abs(u) * 1.6 + (u < 0 ? 0.3 : 0));
  const draw = clamp01(u);
  const snap = Math.max(0, -u);

  rot[id.chest * 3 + 1] += -0.85 * up;
  rot[id.chest * 3] += 0.03 - 0.06 * draw;
  rot[id.head * 3 + 1] = 0.75 * up;
  // Bow arm: out along the line of the shot.
  rot[id.armL * 3] = -0.35 - 1.2 * up + walk * 0.25;
  rot[id.armL * 3 + 2] = 0.1 + 0.75 * up;
  rot[id.foreL * 3] = -0.55 * (1 - up);
  rot[id.bow * 3 + 1] = 0.5 * (1 - up);
  rot[id.bow * 3] = -0.12 * snap;
  // String hand: to the string, then back to the cheek.
  rot[id.armR * 3] = -0.2 - walk * 0.3 - 1.25 * up;
  rot[id.armR * 3 + 2] = -0.1 + 0.55 * up - 0.5 * draw;
  rot[id.foreR * 3] = -0.4 - 0.7 * up - 0.9 * draw;
  rot[id.foreR * 3 + 2] = 0.9 * draw;
  shift[id.root * 3 + 2] = -0.03 * draw * rig.height;

  // The string bends back to the nock, and a bolt of light forms on it.
  const pull = BOW.draw * draw * rig.height;
  const angle = Math.atan2(pull, BOW.half * rig.height);
  rot[id.stringT * 3] = angle;
  rot[id.stringB * 3] = -angle;
  size[id.stringT] = size[id.stringB] = 1 / Math.cos(angle);
  shift[id.arrow * 3 + 1] = pull;
  size[id.arrow] = Math.max(0.001, clamp01(draw * 2.5) * (1 + Math.sin(time * 18) * 0.06));
}

/* -------------------------------------------------------------------------- */
/* Siege Golem                                                                */
/* -------------------------------------------------------------------------- */

const GOLEM_BONES = defineBones([
  ['root', null, 0, 0, 0],
  ['hips', 'root', 0, 0.5, 0],
  ['chest', 'hips', 0, 0.62, 0],
  ['head', 'chest', 0, 1.1, 0.12],
  ['armL', 'chest', 0.4, 1.0, 0.02],
  ['foreL', 'armL', 0.5, 0.68, 0.03],
  ['armR', 'chest', -0.4, 1.0, 0.02],
  ['foreR', 'armR', -0.5, 0.68, 0.03],
  ['thighL', 'hips', 0.17, 0.48, 0],
  ['shinL', 'thighL', 0.19, 0.25, 0],
  ['thighR', 'hips', -0.17, 0.48, 0],
  ['shinR', 'thighR', -0.19, 0.25, 0],
  ['runes', 'chest', 0, 0.92, 0],
]);

/**
 * A colossus of boulder plates locked together and bound with glowing chains:
 * broad hunched shoulders, a small head sunk between them with crystal eyes, a
 * molten heart showing through its chest and fists as big as its head.
 */
function golem(side) {
  const bones = GOLEM_BONES;
  const b = bones.id;
  const ink = inks(side);
  const s = new Sculpt();
  // Worn, rounded boulders: big ones get the finer mesh.
  const boulder = (paintOf, x, y, z, r, o) => s.rock(paintOf, x, y, z, r, { detail: r >= 0.14 ? 2 : 1, rough: 0.2, facet: false, ...o });
  const chain = paint(PALETTE[side].glow[0], PALETTE[side].glow[0], [0.2, 0.45, 0.85]);

  for (const [sx, thigh, shin] of [[1, b.thighL, b.shinL], [-1, b.thighR, b.shinR]]) {
    s.bone(thigh);
    boulder(ink.stone, sx * 0.175, 0.37, 0, 0.14, { sy: 1.2, seed: 3 + sx });
    s.bone(shin);
    boulder(ink.slab, sx * 0.19, 0.24, 0.05, 0.085, { seed: 7 + sx });
    boulder(ink.stone, sx * 0.195, 0.12, 0.03, 0.15, { sy: 0.85, sz: 1.3, seed: 11 + sx });
    s.torus(chain, sx * 0.19, 0.21, 0.02, 0.135, 0.01, { sides: 4, seg: 12, rz: sx * 0.15 });
  }

  // Hips: a keystone boulder, girdled with a belt in the team's colour.
  s.bone(b.hips);
  boulder(ink.stone, 0, 0.55, 0, 0.25, { sy: 0.8, sx: 1.15, seed: 21 });
  s.torus(ink.cloth, 0, 0.6, 0, 0.268, 0.032, { sides: 6, seg: 16 });
  s.extrude(ink.cloth, 0, 0.6, 0.27, [[-0.09, 0], [0.09, 0], [0.07, -0.22], [0, -0.27], [-0.07, -0.22]], 0.02, { rx: -0.1 });
  s.gem(ink.glow, 0, 0.5, 0.3, 0.035, 0.08, { sz: 0.5 });

  // Chest: interlocking plates round a molten heart.
  s.bone(b.chest);
  boulder(ink.stone, 0, 0.9, 0, 0.36, { sx: 1.22, sy: 0.92, detail: 2, seed: 31 });
  boulder(ink.slab, 0.2, 0.97, 0.2, 0.2, { sy: 0.9, sz: 0.7, seed: 33 });
  boulder(ink.slab, -0.2, 0.97, 0.2, 0.2, { sy: 0.9, sz: 0.7, seed: 35 });
  boulder(ink.slab, 0.14, 0.72, 0.2, 0.15, { sz: 0.7, seed: 37 });
  boulder(ink.slab, -0.14, 0.72, 0.2, 0.15, { sz: 0.7, seed: 39 });
  boulder(ink.stone, 0, 1.1, -0.17, 0.27, { sx: 1.3, sy: 0.8, seed: 41 });
  boulder(ink.slab, 0, 0.82, -0.26, 0.22, { sx: 1.2, seed: 43 });
  s.ball(ink.ember, 0, 0.86, 0.2, 0.12, { seg: 10, rings: 8 });
  s.gem(ink.crystal, 0, 0.86, 0.3, 0.07, 0.17, { sz: 0.6 });
  // Cracks of light between the plates.
  for (const [x, y, rz, length] of [[0.13, 1.02, 0.6, 0.2], [-0.15, 1.0, -0.8, 0.18], [0.1, 0.7, -0.5, 0.16], [-0.09, 0.69, 0.4, 0.15], [0.28, 0.84, 0.1, 0.13], [-0.28, 0.86, -0.1, 0.13]]) {
    s.box(ink.ember, x, y, 0.315 - Math.abs(x) * 0.25, 0.018, length, 0.02, { rz, round: 0.006 });
  }
  // Crystals growing from the back.
  for (const [x, y, z, r, h, rz, rx] of [[0.2, 1.18, -0.2, 0.06, 0.3, -0.5, -0.5], [-0.16, 1.2, -0.24, 0.05, 0.24, 0.4, -0.7], [0.02, 1.24, -0.26, 0.07, 0.34, 0, -0.6]]) {
    s.crystal(ink.crystal, x, y, z, r, h, { rz, rx });
  }
  // Chains of light bind the plates: across the chest both ways, and round the waist.
  s.chain(chain, 0, 0.92, 0, 0.43, { links: 26, link: 0.034, rz: 0.62, sz: 0.86 });
  s.chain(chain, 0, 0.92, 0, 0.43, { links: 26, link: 0.034, rz: -0.62, sz: 0.86 });
  // A slow ring of runes turns about the chest.
  s.bone(b.runes);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    s.gem(ink.glow, Math.cos(a) * 0.6, 0.92 + (i % 2) * 0.05, Math.sin(a) * 0.6, 0.026, 0.09, { ry: -a });
  }

  // Head: sunk between the shoulders, with crystal eyes.
  s.bone(b.head);
  boulder(ink.stone, 0, 1.2, 0.14, 0.135, { sy: 0.92, seed: 51 });
  boulder(ink.slab, 0, 1.28, 0.12, 0.11, { sy: 0.5, sx: 1.2, seed: 53 });
  boulder(ink.slab, 0, 1.12, 0.21, 0.075, { sx: 1.3, sy: 0.7, seed: 55 });
  for (const sx of [-1, 1]) s.gem(ink.ember, sx * 0.055, 1.212, 0.255, 0.03, 0.05, { sz: 0.6, rz: sx * 0.3 });

  // Arms: shoulder boulders, banded forearms and fists like wrecking balls.
  for (const [sx, arm, fore] of [[1, b.armL, b.foreL], [-1, b.armR, b.foreR]]) {
    s.bone(arm);
    boulder(ink.stone, sx * 0.43, 1.05, 0.01, 0.215, { sy: 0.9, seed: 61 + sx });
    boulder(ink.slab, sx * 0.47, 1.17, 0, 0.13, { sy: 0.6, seed: 63 + sx });
    boulder(ink.stone, sx * 0.47, 0.83, 0.02, 0.125, { sy: 1.25, seed: 65 + sx });
    s.crystal(ink.crystal, sx * 0.5, 1.18, -0.04, 0.045, 0.2, { rz: -sx * 0.55 });
    s.gem(ink.glow, sx * 0.6, 1.02, 0.1, 0.03, 0.09, { rz: sx * 0.4 });
    s.bone(fore);
    boulder(ink.stone, sx * 0.52, 0.53, 0.04, 0.155, { sy: 1.3, seed: 67 + sx });
    s.chain(chain, sx * 0.525, 0.44, 0.04, 0.17, { links: 12, link: 0.03 });
    
    boulder(ink.stone, sx * 0.535, 0.27, 0.06, 0.2, { seed: 69 + sx, detail: 2 });
    for (const dx of [-0.09, 0.02, 0.12]) boulder(ink.slab, sx * 0.535 + dx, 0.17, 0.2, 0.07, { seed: 71 + dx * 100 + sx });
  }

  return { sculpt: s, bones };
}

function poseGolem(rig, view, time) {
  const { id, rot, shift, size } = rig;
  rig.rest();
  const u = view.strike;
  const walk = stride(rig, view, time, 0.5, 0.7);
  const breath = Math.sin(time * 1.3 + view.phase);
  const up = Math.max(0, u);
  const down = Math.max(0, -u);

  // Both fists go up over the head, then the whole body comes down behind them.
  rot[id.hips * 3 + 2] += walk * 0.06;
  rot[id.chest * 3] += key(u, 0.16, -0.38, 0.62) + breath * 0.012;
  rot[id.chest * 3 + 2] = -walk * 0.07;
  rot[id.head * 3] = key(u, 0, 0.3, -0.35);
  shift[id.root * 3 + 1] += key(u, 0, 0.03, -0.13) * rig.height;
  shift[id.root * 3 + 2] = key(u, 0, -0.04, 0.1) * rig.height;
  for (let sx = 1; sx >= -1; sx -= 2) {
    const arm = sx > 0 ? id.armL : id.armR;
    const fore = sx > 0 ? id.foreL : id.foreR;
    rot[arm * 3] = key(u, -0.12 + sx * walk * 0.35, -2.85, -0.62);
    rot[arm * 3 + 2] = key(u, sx * 0.1, -sx * 0.12, -sx * 0.2);
    rot[fore * 3] = key(u, -0.3, -0.45, -0.2);
  }
  rot[id.thighL * 3] += -0.55 * down - 0.1 * up;
  rot[id.thighR * 3] += -0.55 * down - 0.1 * up;
  rot[id.shinL * 3] += 0.85 * down + 0.1 * up;
  rot[id.shinR * 3] += 0.85 * down + 0.1 * up;

  rot[id.runes * 3 + 1] = time * 0.9 + view.phase;
  shift[id.runes * 3 + 1] = breath * 0.02 * rig.height;
  size[id.runes] = 1 + up * 0.25;
}

/* -------------------------------------------------------------------------- */
/* Frost Tower                                                                */
/* -------------------------------------------------------------------------- */

const FROST_BONES = defineBones([
  ['root', null, 0, 0, 0],
  ['ringA', 'root', 0, 1.2, 0],
  ['ringB', 'root', 0, 1.85, 0],
  ['orb', 'root', 0, 2.52, 0],
  ['shards', 'orb', 0, 2.52, 0],
]);

/**
 * A tiered spire of pale stone and ice: a stepped footing, a ring of carved
 * arches round a frozen core, a tapering shaft and a crown of ice prongs with
 * an orb of frost levitating over it. Two rings of runes turn about the shaft.
 */
function frostTower(side) {
  const bones = FROST_BONES;
  const b = bones.id;
  const ink = inks(side);
  const stone = paint(0x55657c, 0xb9c8da, FINISH.stone);
  const pale = paint(0x7f93aa, 0xe2eef8, [0.1, 0.55, 0]);
  const ice = paint(0x1f7fe0, 0xa8e4ff, [0.1, 0.14, 0.4]);
  const frost = paint(0x4ab8f8, 0xc8f2ff, [0, 0.5, 0.9]);
  const rune = paint(0x2f9cf0, 0x9fe0ff, [0, 0.5, 0.7]);
  const s = new Sculpt();

  // Footing: three steps, the middle one banded in the team's colour.
  s.bone(b.root);
  s.lathe(stone, 0, 0, 0, [[0, 0], [0.98, 0], [0.98, 0.14], [0.9, 0.2], [0.8, 0.2], [0.8, 0.34], [0.74, 0.38], [0.6, 0.38], [0.6, 0.5], [0, 0.5]], { seg: 8, facet: true });
  s.torus(ink.cloth, 0, 0.27, 0, 0.815, 0.04, { sides: 6, seg: 8 });
  // A ring of carved arches round a core of ice.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const [cx, cz] = [Math.cos(a) * 0.5, Math.sin(a) * 0.5];
    s.cyl(pale, cx, 0.5, cz, 0.05, 0.065, 0.62, { seg: 6 });
    s.box(pale, cx, 0.48, cz, 0.15, 0.06, 0.15, { round: 0.02, ry: -a });
    const mid = a + TAU / 12;
    s.add(arch(0.25, 0.04, mid), pale, Math.cos(mid) * 0.433, 1.1, Math.sin(mid) * 0.433);
    s.gem(rune, Math.cos(mid) * 0.47, 1.33, Math.sin(mid) * 0.47, 0.03, 0.08, { ry: -mid });
  }
  s.crystal(ice, 0, 0.45, 0, 0.26, 1.0);
  s.lathe(stone, 0, 0, 0, [[0.6, 1.34], [0.64, 1.38], [0.64, 1.46], [0.5, 1.52], [0.34, 1.6], [0.27, 1.9], [0.24, 2.05], [0.33, 2.12], [0.33, 2.18], [0, 2.18]], { seg: 8, facet: true });
  s.torus(ink.trim, 0, 1.46, 0, 0.645, 0.022, { sides: 5, seg: 8 });
  // Ice grows up the shaft and crowns it with prongs that cradle the orb.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    s.crystal(ice, Math.cos(a) * 0.3, 1.5, Math.sin(a) * 0.3, 0.09, 0.5, { rz: -Math.cos(a) * 0.3, rx: Math.sin(a) * 0.3 });
    const c = a + TAU / 8;
    s.tube(ice, [[Math.cos(c) * 0.26, 2.14, Math.sin(c) * 0.26], [Math.cos(c) * 0.4, 2.36, Math.sin(c) * 0.4], [Math.cos(c) * 0.37, 2.62, Math.sin(c) * 0.37], [Math.cos(c) * 0.2, 2.86, Math.sin(c) * 0.2]], [0.075, 0.06, 0.04, 0.004], { sides: 5, facet: true });
  }

  // Two rings of runes turning about the shaft.
  for (const [bone, y, radius] of [[b.ringA, 1.2, 0.86], [b.ringB, 1.85, 0.58]]) {
    s.bone(bone).torus(rune, 0, y, 0, radius, 0.016, { sides: 4, seg: 32 });
    s.torus(rune, 0, y, 0, radius - 0.07, 0.007, { sides: 4, seg: 32 });
    const count = Math.round(radius * 12);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      const [x, z] = [Math.cos(a) * (radius - 0.035), Math.sin(a) * (radius - 0.035)];
      if (i % 2) s.gem(frost, x, y, z, 0.03, 0.1, { ry: -a });
      else s.box(frost, x, y - 0.012, z, 0.012, 0.024, 0.07, { ry: -a + 0.6 });
    }
  }

  // The orb: a core of light in a shell of ice, with shards circling it.
  s.bone(b.orb).ball(frost, 0, 2.52, 0, 0.17, { seg: 14, rings: 10 });
  s.gem(ice, 0, 2.52, 0, 0.24, 0.56, { ry: 0.4 });
  s.bone(b.shards);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    s.gem(ice, Math.cos(a) * 0.36, 2.52 + (i % 2 ? 0.07 : -0.07), Math.sin(a) * 0.36, 0.045, 0.16, { ry: -a });
  }

  return { sculpt: s, bones };
}

function poseFrost(rig, view, time) {
  const { id, rot, shift, size } = rig;
  rig.rest();
  // `fire` runs 1 -> 0 after a shot: the orb kicks down and swells, the rings spin up.
  const fire = view.fire;
  const kick = fire > 0 ? Math.sin(Math.min(1, (1 - fire) * 2.2) * Math.PI) : 0;
  const spin = time + view.phase;
  rot[id.ringA * 3 + 1] = spin * 0.8 + view.spun;
  rot[id.ringA * 3] = Math.sin(spin * 0.7) * 0.08;
  rot[id.ringB * 3 + 1] = -spin * 1.3 - view.spun * 1.5;
  rot[id.ringB * 3 + 2] = 0.16 + Math.sin(spin * 0.9) * 0.08;
  size[id.ringA] = 1 + kick * 0.08;
  shift[id.orb * 3 + 1] = Math.sin(spin * 2.1) * 0.07 - kick * 0.24;
  size[id.orb] = 1 + Math.sin(spin * 3.3) * 0.04 + fire * fire * 0.55;
  rot[id.orb * 3 + 1] = spin * 0.9;
  rot[id.shards * 3 + 1] = spin * 1.7;
  rot[id.shards * 3] = Math.sin(spin) * 0.25;
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How each kind is built and moved.
 *  - swing: seconds its attack animation lasts;
 *  - windup, impact: the points of that (0..1) where the wind-up ends and the blow lands;
 *  - muzzle: where a shot leaves it, [to its left, up, ahead] in model units;
 *  - trail: reach of the arc its weapon draws in the air (model units), if it has one.
 */
export const TROOPS = {
  melee: { build: (side) => soldier(side, false), pose: poseSoldier, height: 1, swing: 0.42, windup: 0.14, impact: 0.42, trail: 0.78 },
  footman: { build: (side) => soldier(side, true), pose: poseSoldier, height: 1.24, swing: 0.46, windup: 0.14, impact: 0.42, trail: 1.12 },
  ranged: { build: (side) => caster(side, false), pose: poseStaff, height: 1, swing: 0.5, windup: 0.1, impact: 0.3, muzzle: [-0.25, 1.4, 0.5] },
  archer: { build: (side) => caster(side, true), pose: poseBow, height: 1.24, swing: 0.5, windup: 0.08, impact: 0.2, muzzle: [0.1, 1.2, 0.75] },
  valkyrie: { build: valkyrie, pose: poseValkyrie, height: VALKYRIE_SCALE, swing: 0.7, windup: 0.1, impact: 0.4 },
  golem: { build: golem, pose: poseGolem, height: 1, swing: 0.85, windup: 0.2, impact: 0.44 },
  frost_tower: { build: frostTower, pose: poseFrost, height: 1, swing: 0.6, windup: 0, impact: 0, muzzle: [0, 2.52, 0] },
};

/** One instanced rig for a kind of troop on one side. `pose(view, time)` sets it for `write`. */
export function createTroop(type, side, capacity, envMap) {
  const spec = TROOPS[type];
  const { sculpt, bones } = spec.build(side);
  const rig = createRig(sculpt, bones, capacity, { envMap, envIntensity: 0.7, rim: PALETTE[side].team, rimStrength: 0.4 });
  rig.height = spec.height;
  rig.triangles = sculpt.index.length / 3;
  return { rig, spec, pose: (view, time) => spec.pose(rig, view, time) };
}
