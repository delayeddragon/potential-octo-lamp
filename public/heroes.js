/**
 * RuneDeck — hero models: the Aether Knight (Radiant) and Morgath (Dire).
 *
 * Each hero is one sculpted, many-part model on a skeleton of its own (hips,
 * chest, head, arms with elbows, legs with knees, weapon), drawn through the
 * same rig as the troops (sculpt.js) with a single instance. Around it hang the
 * things a rigid skeleton cannot do: a cloak of cloth that streams out behind a
 * running hero, and the motes of light or fire that the weapon sheds.
 *
 * Models face +Z and stand on the origin; the left (shield) side is +X.
 */

import * as THREE from 'three';

import { FINISH, Sculpt, createRig, defineBones, ghostMaterial, paint, surfaceMaterial } from './sculpt.js';
import { key, stride } from './troops.js';

const TAU = Math.PI * 2;
const HALF = Math.PI / 2;


/** The skeleton both heroes share; `w` widens the shoulders and the stance. */
const skeleton = (w, extra) =>
  defineBones([
    ['root', null, 0, 0, 0],
    ['hips', 'root', 0, 0.94, 0],
    ['chest', 'hips', 0, 1.04, 0],
    ['head', 'chest', 0, 1.62, 0],
    ['armL', 'chest', 0.34 * w, 1.5, 0],
    ['foreL', 'armL', 0.4 * w, 1.18, 0],
    ['armR', 'chest', -0.34 * w, 1.5, 0],
    ['foreR', 'armR', -0.4 * w, 1.18, 0],
    ['blade', 'foreR', -0.42 * w, 0.87, 0.03],
    ['thighL', 'hips', 0.13 * w, 0.92, 0],
    ['shinL', 'thighL', 0.14 * w, 0.5, 0],
    ['thighR', 'hips', -0.13 * w, 0.92, 0],
    ['shinR', 'thighR', -0.14 * w, 0.5, 0],
    ['tabard', 'hips', 0, 0.96, 0.2],
    ...extra,
  ]);

/** The profile of a shallow dome, `r` wide and `h` high: a pauldron plate. */
const dome = (r, h) => [[r, 0], [r * 0.97, h * 0.3], [r * 0.8, h * 0.7], [r * 0.45, h * 0.95], [0, h]];

/** A star of `points` rays as an outline. */
const star = (points, outer, inner) =>
  Array.from({ length: points * 2 }, (_, i) => {
    const angle = (i / (points * 2)) * TAU + HALF;
    const r = i % 2 ? inner : outer;
    return [Math.cos(angle) * r, Math.sin(angle) * r];
  });

/* -------------------------------------------------------------------------- */
/* Aether Knight                                                              */
/* -------------------------------------------------------------------------- */

function knight() {
  const bones = skeleton(1, [['plume', 'head', 0, 1.96, -0.02]]);
  const b = bones.id;
  const s = new Sculpt();
  const silver = paint(0x6f7a92, 0xdfe4ee, [0.75, 0.42, 0]);
  const bright = paint(0xaab2c4, 0xf4f6fa, [0.82, 0.34, 0]);
  const gold = paint(0xb98a2c, 0xf7e3a0, FINISH.gold);
  const mail = paint(0x2c3550, 0x56627f, FINISH.iron);
  const blue = paint(0x1648b8, 0x58b8ff, FINISH.cloth);
  const light = paint(0x59d2ff, 0xeaffff, FINISH.glow);
  const trimLight = paint(0x1fa4f0, 0x8fe4ff, [0, 0.5, 0.8]);
  const leather = paint(0x2e2019, 0x6b4a32, FINISH.leather);
  const dark = paint(0x05060c, 0x0c0f1a, FINISH.cloth);
  const edge = paint(0x9fdcff, 0xffffff, [0.9, 0.22, 0.22]);

  // Legs: mail under a cuisse, a winged knee cop, a banded greave and a sabaton.
  for (const [sx, thigh, shin] of [[1, b.thighL, b.shinL], [-1, b.thighR, b.shinR]]) {
    s.bone(thigh).limb(mail, [sx * 0.13, 0.92, 0], [sx * 0.14, 0.52, 0], 0.105, 0.085, { seg: 10, cap: 3 });
    s.lathe(silver, sx * 0.134, 0, 0, [[0.098, 0.56], [0.118, 0.66], [0.126, 0.8], [0.114, 0.9]], { seg: 8, start: -1.2 + sx * 0.5, arc: 2.4 });
    s.torus(gold, sx * 0.137, 0.57, 0, 0.099, 0.012, { sides: 5, seg: 12 });
    // A tasset hangs from the belt over the outside of each thigh.
    s.plate(silver, sx * 0.225, 0.64, 0.01, 0.32, (v) => 0.1 * (0.55 + 0.45 * Math.sin(v * HALF)), { ry: sx * HALF, bend: 2.2, thick: 0.02, nu: 4, nv: 5 });
    s.plate(gold, sx * 0.232, 0.63, 0.01, 0.07, (v) => 0.062 * (0.3 + 0.7 * v), { ry: sx * HALF, bend: 2.2, thick: 0.014, nu: 4, nv: 2 });

    s.bone(shin).ball(bright, sx * 0.14, 0.5, 0.045, 0.078, { seg: 10, rings: 8, sz: 0.85 });
    s.cone(gold, sx * 0.14, 0.5, 0.1, 0.032, 0.085, { seg: 6, rx: HALF * 0.75 });
    s.limb(silver, [sx * 0.14, 0.47, 0], [sx * 0.14, 0.13, 0], 0.09, 0.066, { seg: 10, cap: 3 });
    s.torus(gold, sx * 0.14, 0.41, 0, 0.088, 0.011, { sides: 5, seg: 12 });
    s.torus(gold, sx * 0.14, 0.17, 0, 0.07, 0.011, { sides: 5, seg: 12 });
    s.gem(light, sx * 0.14, 0.3, 0.078, 0.02, 0.075, { sz: 0.5 });
    s.box(silver, sx * 0.14, 0, 0.04, 0.13, 0.1, 0.27, { round: 0.04 });
    s.ball(bright, sx * 0.14, 0.045, 0.165, 0.062, { seg: 8, rings: 6, sy: 0.72 });
  }

  // Hips: a mail skirt under two rings of plate, and a jewelled belt.
  s.bone(b.hips).lathe(mail, 0, 0, 0, [[0.19, 1.02], [0.25, 0.86], [0.28, 0.7], [0.25, 0.71], [0.17, 0.94]], { seg: 16, sz: 0.8 });
  s.lathe(silver, 0, 0, 0, [[0.2, 1.02], [0.262, 0.9], [0.275, 0.84], [0.255, 0.845]], { seg: 16, sz: 0.8 });
  s.torus(gold, 0, 0.843, 0, 0.274, 0.012, { sides: 5, seg: 18, sz: 0.8 });
  s.torus(gold, 0, 1.01, 0, 0.198, 0.03, { sides: 6, seg: 18, sz: 0.8 });
  s.ball(gold, 0, 1.01, 0.158, 0.05, { seg: 8, rings: 6, sz: 0.6 });
  s.gem(light, 0, 1.01, 0.18, 0.03, 0.07, { sz: 0.5 });

  // The tabard's tail, in the team's blue with a golden star.
  s.bone(b.tabard).extrude(gold, 0, 0.972, 0.2, [[-0.115, 0], [0.115, 0], [0.125, -0.31], [0, -0.45], [-0.125, -0.31]], 0.012, { rx: -0.2 });
  s.extrude(blue, 0, 0.972, 0.214, [[-0.1, 0], [0.1, 0], [0.108, -0.3], [0, -0.42], [-0.108, -0.3]], 0.012, { rx: -0.2 });
  s.extrude(gold, 0, 0.8, 0.26, star(4, 0.06, 0.022), 0.01, { rx: -0.2 });

  // Chest: a plate cuirass tapered to the waist, a second plate over the breast and gold inlay.
  const cuirass = [[0.185, 1.0], [0.2, 1.06], [0.225, 1.18], [0.285, 1.36], [0.3, 1.46], [0.25, 1.56], [0.13, 1.615], [0, 1.625]];
  s.bone(b.chest).lathe(silver, 0, 0, 0, cuirass, { seg: 18, sz: 0.74 });
  s.lathe(bright, 0, 0, 0, cuirass.slice(2, 6).map(([r, h]) => [r + 0.014, h]), { seg: 10, start: -0.95, arc: 1.9, sz: 0.74 });
  s.lathe(gold, 0, 0, 0, [[0.236, 1.172], [0.248, 1.185], [0.236, 1.2]], { seg: 10, start: -0.95, arc: 1.9, sz: 0.74 });
  s.torus(gold, 0, 1.065, 0, 0.203, 0.013, { sides: 5, seg: 18, sz: 0.74 });
  s.tube(gold, [[0, 1.19, 0.182], [0, 1.3, 0.21], [0, 1.4, 0.226]], 0.011, { sides: 5 });
  for (const sx of [1, -1]) {
    s.tube(gold, [[sx * 0.04, 1.42, 0.226], [sx * 0.14, 1.475, 0.2], [sx * 0.23, 1.5, 0.15]], [0.013, 0.011, 0.006], { sides: 5 });
    s.tube(gold, [[sx * 0.04, 1.37, 0.224], [sx * 0.13, 1.35, 0.2], [sx * 0.2, 1.28, 0.152]], [0.011, 0.009, 0.005], { sides: 5 });
  }
  s.torus(gold, 0, 1.4, 0.228, 0.052, 0.013, { sides: 6, seg: 14, rx: HALF });
  s.gem(light, 0, 1.4, 0.236, 0.042, 0.1, { sz: 0.5 });
  s.cyl(silver, 0, 1.57, 0, 0.1, 0.135, 0.1, { seg: 12 });
  s.torus(gold, 0, 1.615, 0, 0.122, 0.014, { sides: 5, seg: 14 });
  // The cape's collar, and the clasps that pin it to the shoulders.
  s.tube(blue, [[-0.27, 1.575, -0.1], [-0.14, 1.6, -0.19], [0.14, 1.6, -0.19], [0.27, 1.575, -0.1]], 0.042, { sides: 7 });
  for (const sx of [1, -1]) {
    s.ball(gold, sx * 0.25, 1.59, 0.02, 0.045, { seg: 8, rings: 6 });
    s.gem(light, sx * 0.25, 1.6, 0.05, 0.02, 0.05, { sz: 0.6 });
  }

  // Arms: mail, three overlapping pauldron plates trimmed with light, a winged couter, a vambrace and a gauntlet.
  for (const [sx, arm, fore] of [[1, b.armL, b.foreL], [-1, b.armR, b.foreR]]) {
    s.bone(arm).limb(mail, [sx * 0.34, 1.5, 0], [sx * 0.4, 1.2, 0], 0.075, 0.065, { seg: 8, cap: 3 });
    s.limb(silver, [sx * 0.368, 1.38, 0], [sx * 0.394, 1.26, 0], 0.08, 0.073, { seg: 8, cap: 2 });
    const layers = [[0, 0, -0.32, 0.175, 0.125, bright], [0.075, -0.075, -0.6, 0.142, 0.09, silver], [0.118, -0.16, -0.85, 0.116, 0.07, bright]];
    for (const [dx, dy, tilt, r, h, ink] of layers) {
      s.group(sx * (0.355 + dx), 1.525 + dy, 0, { rz: sx * tilt }, () => {
        s.lathe(ink, 0, 0, 0, dome(r, h), { seg: 12, sz: 1.08 });
        s.torus(gold, 0, 0.004, 0, r, 0.012, { sides: 5, seg: 14, sz: 1.08 });
        s.torus(trimLight, 0, 0.03, 0, r * 0.985, 0.007, { sides: 4, seg: 14, sz: 1.08 });
      });
    }
    s.bone(fore).ball(bright, sx * 0.4, 1.18, -0.012, 0.072, { seg: 10, rings: 8 });
    s.cone(gold, sx * 0.4, 1.18, -0.055, 0.032, 0.085, { seg: 6, rx: -HALF * 0.8 });
    s.limb(silver, [sx * 0.4, 1.15, 0], [sx * 0.42, 0.94, 0], 0.07, 0.058, { seg: 10, cap: 3 });
    s.torus(gold, sx * 0.405, 1.1, 0, 0.068, 0.01, { sides: 5, seg: 12 });
    s.torus(gold, sx * 0.418, 0.955, 0, 0.06, 0.01, { sides: 5, seg: 12 });
    s.gem(light, sx * 0.475, 1.03, 0, 0.018, 0.085, { sx: 0.5 });
    s.cyl(gold, sx * 0.42, 0.905, 0, 0.066, 0.058, 0.04, { seg: 10 });
    s.ball(mail, sx * 0.42, 0.87, 0.005, 0.062, { seg: 8, rings: 6 });
  }

  // Head: a domed helm, a visor with a lit eye slit, golden wings and a ridge that carries the plume.
  s.bone(b.head).ball(dark, 0, 1.765, 0.02, 0.13, { seg: 10, rings: 8 });
  s.ball(bright, 0, 1.79, -0.005, 0.166, { seg: 16, rings: 12, sy: 1.08 });
  s.lathe(silver, 0, 1.775, 0, [[0.13, -0.165], [0.172, -0.09], [0.181, -0.005], [0.173, 0.04]], { seg: 12, start: -1.25, arc: 2.5, sz: 1.12 });
  s.lathe(silver, 0, 1.775, 0, [[0.176, 0.075], [0.183, 0.11], [0.165, 0.15]], { seg: 12, start: -1.2, arc: 2.4, sz: 1.1 });
  s.box(light, 0, 1.815, 0.168, 0.22, 0.032, 0.03, { round: 0.01 });
  for (const sx of [1, -1]) {
    s.ball(light, sx * 0.058, 1.832, 0.186, 0.024, { seg: 8, rings: 6 });
    s.extrude(gold, sx * 0.168, 1.81, -0.01, [[0, -0.03], [0.07, 0], [0.24, 0.17], [0.14, 0.12], [0.2, 0.26], [0.1, 0.17], [0.12, 0.31], [0.03, 0.19], [-0.03, 0.06]], 0.014, { ry: HALF, rz: sx * -0.22, bevel: 0.004 });
    // Breathing slits in the visor.
    for (let i = 0; i < 3; i++) s.box(dark, sx * (0.04 + i * 0.035), 1.67 + i * 0.006, 0.19 - i * 0.012, 0.012, 0.05, 0.012);
  }
  s.torus(gold, 0, 1.853, -0.005, 0.166, 0.014, { sides: 5, seg: 18 });
  s.tube(gold, [[0, 1.875, 0.155], [0, 1.975, 0.07], [0, 2.0, -0.04], [0, 1.93, -0.155]], 0.016, { sides: 5, flat: [0.8, 1.8], up: [1, 0, 0] });
  s.bone(b.plume).tube(paint(0x1f58d8, 0x9fe4ff, FINISH.cloth), [[0, 1.98, 0.03], [0, 2.15, -0.02], [0, 2.17, -0.2], [0, 2.02, -0.38], [0, 1.78, -0.47], [0, 1.56, -0.45]], [0.02, 0.07, 0.088, 0.078, 0.052, 0.012], {
    sides: 8,
    steps: 22,
    flat: [0.5, 1],
    up: [1, 0, 0],
    bump: (u, v) => 1 + 0.12 * Math.sin(v * TAU * 4) * Math.sin(u * Math.PI),
  });

  // Kite shield on the left forearm: gold rim, blue field, a golden sunburst about a crystal.
  s.bone(b.foreL).group(0.5, 1.04, 0, { ry: HALF }, () => {
    const kite = (v) => 0.25 * Math.min(1, Math.sin(Math.min(1, v * 1.2) * HALF) ** 0.8) * (v > 0.88 ? 1 - (v - 0.88) * 2 : 1);
    s.plate(gold, 0, -0.44, 0, 0.84, (v) => kite(v) + 0.024, { bend: 1.15, thick: 0.03, nu: 8, nv: 12 });
    s.plate(blue, 0, -0.4, 0.014, 0.775, (v) => kite(v) * 0.94, { bend: 1.15, thick: 0.022, nu: 8, nv: 12, dome: 0.03 });
    s.plate(silver, 0, -0.33, 0.024, 0.2, (v) => 0.018 + v * 0.02, { thick: 0.016, nu: 2, nv: 3 });
    s.extrude(gold, 0, 0.08, 0.05, star(8, 0.16, 0.07), 0.014, { bevel: 0.004 });
    s.torus(gold, 0, 0.08, 0.06, 0.062, 0.016, { sides: 6, seg: 16, rx: HALF });
    s.gem(light, 0, 0.08, 0.068, 0.05, 0.11, { sz: 0.45 });
    for (const [px, py] of [[-0.17, 0.3], [0.17, 0.3], [-0.2, 0.08], [0.2, 0.08], [-0.13, -0.16], [0.13, -0.16]]) s.ball(gold, px, py, 0.03 - 1.15 * px * px, 0.02, { seg: 6, rings: 4 });
  });

  // Rune broadsword: pommel, wrapped grip, curved crossguard, and a blade with a channel of light down it.
  s.bone(b.blade).group(-0.42, 0.87, 0.03, { rx: HALF, ry: HALF }, () => {
    s.ball(gold, 0, -0.135, 0, 0.042, { seg: 10, rings: 8 });
    s.gem(light, 0, -0.19, 0, 0.026, 0.075);
    s.cyl(leather, 0, -0.11, 0, 0.024, 0.024, 0.21, { seg: 8 });
    for (const y of [-0.06, 0, 0.055]) s.torus(gold, 0, y, 0, 0.026, 0.007, { sides: 4, seg: 10 });
    s.extrude(gold, 0, 0, 0, [[-0.21, 0.118], [-0.185, 0.165], [-0.07, 0.122], [0, 0.14], [0.07, 0.122], [0.185, 0.165], [0.21, 0.118], [0.16, 0.092], [0.05, 0.08], [-0.05, 0.08], [-0.16, 0.092]], 0.044, { bevel: 0.008 });
    s.ball(light, 0, 0.11, 0, 0.036, { seg: 8, rings: 6 });
    for (const sx of [1, -1]) s.ball(light, sx * 0.19, 0.135, 0, 0.022, { seg: 6, rings: 5 });
    s.extrude(edge, 0, 0, 0, [[-0.06, 0.13], [0.06, 0.13], [0.052, 0.98], [0, 1.18], [-0.052, 0.98]], 0.008, { bevel: 0.015, bevelDepth: 0.01 });
    s.box(light, 0, 0.16, 0, 0.03, 0.8, 0.036, { round: 0.01 });
    for (const y of [0.3, 0.46, 0.62, 0.78]) s.extrude(light, 0, y, 0, [[0, 0.034], [0.026, 0], [0, -0.034], [-0.026, 0]], 0.04);
  });

  return { sculpt: s, bones };
}

function poseKnight(rig, view, time) {
  const { id, rot, shift } = rig;
  rig.rest();
  const u = view.strike;
  const walk = stride(rig, view, time, 0.6, 0.95);
  const calm = 1 - Math.abs(u);
  const sway = Math.sin(time * 1.6 + view.phase);

  // Wind up over the right shoulder, cut down across the body, recover.
  rot[id.chest * 3] += key(u, 0.05, -0.16, 0.36);
  rot[id.chest * 3 + 1] += key(u, 0, -0.55, 0.6);
  rot[id.head * 3 + 1] = key(u, 0, 0.32, -0.32) + sway * 0.07 * calm;
  rot[id.armR * 3] = key(u, -0.4, -2.75, -1.05) - walk * 0.4 * calm;
  rot[id.armR * 3 + 2] = key(u, -0.16, -0.38, 0.5);
  rot[id.foreR * 3] = key(u, -0.72, -1.0, -0.15);
  rot[id.blade * 3] = key(u, -0.5, -0.55, 0.8) + sway * 0.04 * calm;
  rot[id.blade * 3 + 2] = key(u, 0, 0.3, -0.5);
  shift[id.root * 3 + 2] = key(u, 0, -0.07, 0.24);
  shift[id.root * 3 + 1] += key(u, 0, 0, -0.06);
  rot[id.thighL * 3] += key(u, 0, 0.1, -0.5);
  rot[id.shinL * 3] += key(u, 0, 0, 0.45);
  rot[id.thighR * 3] += key(u, 0, -0.1, 0.3);

  // The shield stays up on guard, and comes across the body as the blow lands.
  rot[id.armL * 3] = key(u, -0.32, -0.5, -0.1) + walk * 0.3;
  rot[id.armL * 3 + 1] = key(u, -0.95, -1.15, -0.45);
  rot[id.foreL * 3] = key(u, -1.3, -1.5, -1.1) + sway * 0.03;
  rot[id.tabard * 3] = -view.moving * 0.3 - Math.abs(walk) * 0.25 + sway * 0.03 + key(u, 0, 0.1, -0.35);
  rot[id.plume * 3] = view.moving * 0.22 + sway * 0.05 + key(u, 0, -0.2, 0.3);
  rot[id.plume * 3 + 2] = Math.sin(time * 2.3 + view.phase) * 0.05;
}

/* -------------------------------------------------------------------------- */
/* Morgath                                                                    */
/* -------------------------------------------------------------------------- */

const WIDE = 1.14;

function warlord() {
  const bones = skeleton(WIDE, [
    ['core', 'chest', 0, 1.38, 0.2],
    ['flameA', 'blade', -0.42 * WIDE, 0.87, 0.75],
    ['flameB', 'blade', -0.42 * WIDE, 0.87, 1.3],
  ]);
  const b = bones.id;
  const s = new Sculpt();
  const obsidian = paint(0x141118, 0x3b3044, FINISH.obsidian);
  const iron = paint(0x2b2433, 0x71607c, FINISH.iron);
  const mail = paint(0x100d14, 0x2e2636, FINISH.iron);
  const copper = paint(0x7a2a14, 0xf0803a, FINISH.gold);
  const magma = paint(0xff5a14, 0xffe0a0, FINISH.ember);
  const seam = paint(0xc8381f, 0xff7a2a, [0, 0.6, 1.1]);
  const horn = paint(0x1a1418, 0xa08a6c, FINISH.bone);
  const crimson = paint(0x5a0c14, 0xc8381f, FINISH.cloth);
  const leather = paint(0x1c1412, 0x4a3226, FINISH.leather);
  const dark = paint(0x040305, 0x0c080c, FINISH.cloth);
  const w = WIDE;

  /** A spike standing on a point and leaning by (rx, rz). */
  const spike = (ink, x, y, z, r, h, o) => s.cone(ink, x, y, z, r, h, { seg: 6, ...o });

  // Legs: heavy plate with a spiked knee, a seam of fire down the greave and a clawed sabaton.
  for (const [sx, thigh, shin] of [[1, b.thighL, b.shinL], [-1, b.thighR, b.shinR]]) {
    const hx = sx * 0.13 * w;
    const kx = sx * 0.14 * w;
    s.bone(thigh).limb(mail, [hx, 0.92, 0], [kx, 0.52, 0], 0.12, 0.098, { seg: 10, cap: 3 });
    s.lathe(obsidian, kx - sx * 0.005, 0, 0, [[0.11, 0.56], [0.134, 0.68], [0.14, 0.82], [0.125, 0.92]], { seg: 6, start: -1.2 + sx * 0.5, arc: 2.4, facet: true });
    s.plate(obsidian, sx * 0.27, 0.62, 0.01, 0.36, (v) => 0.12 * (0.2 + 0.8 * Math.sqrt(v)), { ry: sx * HALF, bend: 1.8, thick: 0.03, nu: 4, nv: 5 });
    s.bone(shin).ball(obsidian, kx, 0.5, 0.045, 0.09, { seg: 8, rings: 6, sz: 0.85 });
    spike(iron, kx, 0.51, 0.1, 0.04, 0.17, { rx: HALF * 0.7 });
    s.limb(obsidian, [kx, 0.47, 0], [kx, 0.13, 0], 0.104, 0.078, { seg: 8, cap: 3 });
    s.box(seam, kx, 0.17, 0.076, 0.022, 0.26, 0.03, { round: 0.008, rx: 0.07 });
    s.torus(iron, kx, 0.42, 0, 0.102, 0.014, { sides: 5, seg: 10 });
    s.torus(iron, kx, 0.16, 0, 0.083, 0.014, { sides: 5, seg: 10 });
    s.box(obsidian, kx, 0, 0.04, 0.15, 0.11, 0.29, { round: 0.04 });
    for (const dx of [-0.045, 0, 0.045]) spike(iron, kx + dx, 0.03, 0.16, 0.024, 0.09, { rx: HALF * 0.9 });
  }

  // Hips: a skirt of sharp plates under a copper belt, and a torn crimson loincloth.
  s.bone(b.hips).lathe(mail, 0, 0, 0, [[0.21, 1.02], [0.27, 0.86], [0.3, 0.72], [0.27, 0.73], [0.18, 0.94]], { seg: 14, sz: 0.8 });
  s.lathe(obsidian, 0, 0, 0, [[0.22, 1.03], [0.285, 0.9], [0.31, 0.8]], { seg: 10, sz: 0.8, facet: true });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    spike(obsidian, Math.sin(a) * 0.3, 0.82, Math.cos(a) * 0.3 * 0.8, 0.05, 0.14, { rx: Math.PI - Math.cos(a) * 0.3, rz: Math.sin(a) * 0.3 });
  }
  s.torus(copper, 0, 1.02, 0, 0.215, 0.032, { sides: 6, seg: 18, sz: 0.8 });
  s.gem(magma, 0, 1.02, 0.185, 0.045, 0.1, { sz: 0.5 });
  s.bone(b.tabard).extrude(crimson, 0, 0.972, 0.215, [[-0.11, 0], [0.11, 0], [0.12, -0.3], [0.07, -0.42], [0.04, -0.33], [0, -0.47], [-0.05, -0.34], [-0.09, -0.43], [-0.12, -0.28]], 0.014, { rx: -0.2 });
  s.extrude(copper, 0, 0.83, 0.262, [[0, 0.06], [0.045, 0], [0, -0.06], [-0.045, 0]], 0.01, { rx: -0.2 });

  // Chest: a broad cuirass of obsidian around a molten core, cracked with fire.
  const cuirass = [[0.2, 1.0], [0.225, 1.08], [0.26, 1.2], [0.34, 1.38], [0.35, 1.48], [0.28, 1.58], [0.14, 1.63], [0, 1.64]];
  const DEEP = 0.78;
  /** A point on the breastplate: `phi` round from the front, at height h, lifted `out` off the surface. */
  const onChest = (phi, h, out = 0) => {
    let i = 0;
    while (i < cuirass.length - 2 && cuirass[i + 1][1] < h) i++;
    const [r0, h0] = cuirass[i];
    const [r1, h1] = cuirass[i + 1];
    const r = r0 + ((r1 - r0) * (h - h0)) / (h1 - h0) + out;
    return [Math.sin(phi) * r, h, Math.cos(phi) * r * DEEP];
  };
  s.bone(b.chest).lathe(obsidian, 0, 0, 0, cuirass, { seg: 18, sz: DEEP });
  s.lathe(iron, 0, 0, 0, cuirass.slice(2, 6).map(([r, h]) => [r + 0.016, h]), { seg: 5, start: -1.0, arc: 2.0, sz: DEEP, facet: true });
  s.torus(copper, 0, 1.085, 0, 0.228, 0.014, { sides: 5, seg: 18, sz: DEEP });
  s.torus(iron, 0, 1.38, 0.268, 0.105, 0.024, { sides: 6, seg: 14, rx: HALF });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + 0.39;
    spike(obsidian, Math.cos(a) * 0.105, 1.38 + Math.sin(a) * 0.105, 0.262, 0.03, 0.1, { rz: a - HALF, rx: 0.25 });
  }
  // Cracks run out from the core across the plate.
  for (const [phi, h, bend] of [[-0.75, 1.52, 0.1], [0.8, 1.5, -0.08], [-0.9, 1.24, -0.1], [0.85, 1.22, 0.12], [0.1, 1.14, 0.2], [-0.2, 1.57, -0.1]]) {
    const from = onChest(phi * 0.18, 1.38 + (h - 1.38) * 0.3, 0.02);
    const mid = onChest(phi * 0.6 + bend, 1.38 + (h - 1.38) * 0.65, 0.02);
    const to = onChest(phi, h, 0.018);
    s.tube(seam, [from, mid, to], [0.014, 0.011, 0.003], { sides: 4, steps: 8 });
  }
  s.cyl(iron, 0, 1.58, 0, 0.11, 0.15, 0.1, { seg: 10 });
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + 0.45;
    spike(iron, Math.sin(a) * 0.14, 1.62, Math.cos(a) * 0.12, 0.032, 0.13, { rx: Math.cos(a) * 0.7, rz: -Math.sin(a) * 0.7 });
  }
  s.tube(crimson, [[-0.3, 1.59, -0.1], [-0.15, 1.62, -0.22], [0.15, 1.62, -0.22], [0.3, 1.59, -0.1]], 0.05, { sides: 6 });
  s.bone(b.core).ball(magma, 0, 1.38, 0.2, 0.1, { seg: 12, rings: 8, sz: 0.75 });

  // Arms: jagged magma pauldrons of piled rock and spikes, a spiked couter and a clawed gauntlet.
  for (const [sx, arm, fore] of [[1, b.armL, b.foreL], [-1, b.armR, b.foreR]]) {
    const ax = sx * 0.34 * w;
    const ex = sx * 0.4 * w;
    const wx = sx * 0.42 * w;
    s.bone(arm).limb(mail, [ax, 1.5, 0], [ex, 1.2, 0], 0.09, 0.078, { seg: 8, cap: 3 });
    s.rock(obsidian, ax + sx * 0.03, 1.56, 0, 0.2, { detail: 1, rough: 0.22, sy: 0.72, seed: 3 + sx });
    s.rock(iron, ax + sx * 0.12, 1.46, 0.01, 0.15, { detail: 1, rough: 0.24, sy: 0.8, seed: 9 + sx });
    s.rock(obsidian, ax + sx * 0.14, 1.36, 0, 0.11, { detail: 1, rough: 0.2, sy: 0.9, seed: 14 + sx });
    s.torus(seam, ax + sx * 0.085, 1.505, 0, 0.165, 0.016, { sides: 4, seg: 12, rz: sx * -0.75 });
    s.torus(seam, ax + sx * 0.14, 1.405, 0, 0.125, 0.013, { sides: 4, seg: 12, rz: sx * -1.0 });
    spike(iron, ax + sx * 0.0, 1.66, 0, 0.05, 0.26, { rz: sx * -0.25 });
    spike(iron, ax + sx * 0.1, 1.63, 0.08, 0.042, 0.22, { rz: sx * -0.75, rx: 0.35 });
    spike(iron, ax + sx * 0.1, 1.63, -0.08, 0.042, 0.24, { rz: sx * -0.7, rx: -0.4 });
    spike(obsidian, ax + sx * 0.2, 1.5, 0, 0.04, 0.2, { rz: sx * -1.25 });
    s.gem(magma, ax + sx * 0.05, 1.67, 0.11, 0.03, 0.07);

    s.bone(fore).ball(obsidian, ex, 1.18, -0.012, 0.085, { seg: 8, rings: 6 });
    spike(iron, ex, 1.18, -0.06, 0.036, 0.16, { rx: -HALF * 0.85 });
    s.limb(obsidian, [ex, 1.15, 0], [wx, 0.94, 0], 0.085, 0.07, { seg: 8, cap: 3 });
    s.torus(seam, ex + sx * 0.006, 1.09, 0, 0.083, 0.011, { sides: 4, seg: 10 });
    s.torus(seam, wx - sx * 0.004, 0.97, 0, 0.074, 0.011, { sides: 4, seg: 10 });
    for (const dz of [-0.035, 0.035]) spike(iron, ex + sx * 0.08, 1.03, dz, 0.022, 0.1, { rz: sx * -1.3 });
    s.ball(obsidian, wx, 0.87, 0.005, 0.076, { seg: 8, rings: 6 });
    for (const dz of [-0.04, 0, 0.04]) spike(iron, wx + sx * 0.04, 0.85, dz + 0.01, 0.018, 0.07, { rz: sx * -1.9 });
  }

  // Head: a dark iron helm with slanted burning eyes, a barred jaw and two curved horns.
  s.bone(b.head).ball(dark, 0, 1.765, 0.02, 0.135, { seg: 10, rings: 8 });
  s.ball(iron, 0, 1.8, -0.005, 0.172, { seg: 14, rings: 10, sy: 1.1 });
  s.lathe(obsidian, 0, 1.775, 0, [[0.11, -0.2], [0.17, -0.11], [0.186, -0.01], [0.178, 0.03]], { seg: 6, start: -1.2, arc: 2.4, sz: 1.12, facet: true });
  s.lathe(obsidian, 0, 1.775, 0, [[0.18, 0.075], [0.19, 0.12], [0.165, 0.17]], { seg: 6, start: -1.2, arc: 2.4, sz: 1.1, facet: true });
  s.box(dark, 0, 1.805, 0.16, 0.24, 0.045, 0.03);
  for (const sx of [1, -1]) {
    s.box(magma, sx * 0.07, 1.818, 0.178, 0.085, 0.024, 0.03, { round: 0.008, rz: sx * 0.32 });
    for (let i = 0; i < 2; i++) s.box(seam, sx * (0.03 + i * 0.04), 1.63 + i * 0.012, 0.2 - i * 0.014, 0.012, 0.08, 0.012);
    s.tube(horn, [[sx * 0.14, 1.9, -0.02], [sx * 0.3, 1.94, -0.02], [sx * 0.4, 2.08, 0.03], [sx * 0.36, 2.27, 0.12], [sx * 0.26, 2.38, 0.2]], [0.062, 0.056, 0.044, 0.026, 0.004], {
      sides: 8,
      steps: 18,
      up: [0, 0, 1],
      bump: (u) => 1 + 0.09 * Math.sin(u * 46),
    });
    s.torus(copper, sx * 0.165, 1.905, -0.02, 0.066, 0.014, { sides: 5, seg: 10, rz: HALF });
  }
  for (const [y, z, h] of [[1.975, 0.06, 0.13], [1.99, -0.03, 0.17], [1.96, -0.12, 0.13]]) spike(iron, 0, y, z, 0.032, h, { rx: -0.3 + z * -3 });

  // Greatsword, held in both hands: a serrated slab of obsidian with a vein of fire and tongues of flame along it.
  s.bone(b.blade).group(-0.42 * w, 0.87, 0.03, { rx: HALF, ry: HALF }, () => {
    s.gem(iron, 0, -0.31, 0, 0.05, 0.15);
    s.cyl(leather, 0, -0.26, 0, 0.028, 0.028, 0.42, { seg: 8 });
    for (const y of [-0.2, -0.1, 0, 0.1]) s.torus(copper, 0, y, 0, 0.03, 0.008, { sides: 4, seg: 10 });
    s.extrude(iron, 0, 0, 0, [[-0.27, 0.2], [-0.21, 0.26], [-0.1, 0.18], [0, 0.22], [0.1, 0.18], [0.21, 0.26], [0.27, 0.2], [0.22, 0.14], [0.07, 0.13], [0, 0.1], [-0.07, 0.13], [-0.22, 0.14]], 0.06, { bevel: 0.01 });
    s.ball(magma, 0, 0.17, 0, 0.048, { seg: 8, rings: 6 });
    const outline = [[-0.085, 0.2], [-0.115, 0.36], [-0.082, 0.42], [-0.105, 0.72], [-0.076, 0.78], [-0.095, 1.1], [-0.066, 1.16], [-0.078, 1.48], [0, 1.78], [0.076, 1.48], [0.096, 1.1], [0.106, 0.72], [0.112, 0.36], [0.085, 0.2]];
    s.extrude(paint(0x16121a, 0x5a4a66, FINISH.obsidian), 0, 0, 0, outline, 0.014, { bevel: 0.02, bevelDepth: 0.012 });
    s.box(magma, 0, 0.25, 0, 0.042, 1.2, 0.05, { round: 0.012 });
    for (const y of [0.5, 0.82, 1.14]) s.extrude(seam, 0, y, 0, [[0, 0.05], [0.05, 0], [0, -0.05], [-0.05, 0]], 0.046);
    // Tongues of flame lick up both edges; two bones make them flicker out of step.
    for (let i = 0; i < 8; i++) {
      const side = i % 2 ? 1 : -1;
      const y = 0.3 + i * 0.17;
      s.bone(i % 4 < 2 ? b.flameA : b.flameB).tube(magma, [[side * 0.08, y, 0], [side * 0.16, y + 0.1, 0], [side * 0.11, y + 0.24, 0], [side * 0.15, y + 0.36, 0]], [0.034, 0.03, 0.018, 0.002], {
        sides: 5,
        steps: 9,
        flat: [1, 0.45],
        up: [0, 0, 1],
        tint: (u) => u,
      });
    }
    s.bone(b.blade);
  });

  return { sculpt: s, bones };
}

function poseWarlord(rig, view, time) {
  const { id, rot, shift, size } = rig;
  rig.rest();
  const u = view.strike;
  const walk = stride(rig, view, time, 0.55, 0.9);
  const calm = 1 - Math.abs(u);
  const sway = Math.sin(time * 1.4 + view.phase);

  // Both hands on the hilt: the blade stands before the right shoulder, heaves back overhead, and cleaves down.
  rot[id.chest * 3] += key(u, 0.08, -0.26, 0.46);
  rot[id.chest * 3 + 1] += key(u, -0.18, -0.4, 0.3);
  rot[id.head * 3] = key(u, 0.05, 0.2, -0.3);
  rot[id.head * 3 + 1] = key(u, 0.18, 0.3, -0.25) + sway * 0.06 * calm;
  const lift = key(u, -0.8, -2.7, -0.95) + sway * 0.03 * calm;
  const bend = key(u, -1.05, -0.95, -0.2);
  rot[id.armR * 3] = lift;
  rot[id.armR * 3 + 1] = key(u, 0.42, 0.25, 0.5);
  rot[id.armR * 3 + 2] = key(u, 0.02, -0.1, 0.1);
  rot[id.foreR * 3] = bend;
  rot[id.armL * 3] = lift - 0.08;
  rot[id.armL * 3 + 1] = key(u, -0.62, -0.4, -0.66);
  rot[id.armL * 3 + 2] = key(u, -0.1, 0.1, -0.16);
  rot[id.foreL * 3] = bend - 0.1;
  rot[id.blade * 3] = key(u, 0.45, 0.85, 1.25) + sway * 0.03 * calm;
  rot[id.blade * 3 + 1] = key(u, -0.1, 0, 0);
  rot[id.blade * 3 + 2] = key(u, 0.22, 0.1, 0);
  shift[id.root * 3 + 2] = key(u, 0, -0.1, 0.3);
  shift[id.root * 3 + 1] += key(u, 0, 0.02, -0.12);
  rot[id.thighL * 3] += key(u, 0, 0.12, -0.6);
  rot[id.shinL * 3] += key(u, 0, 0, 0.6);
  rot[id.thighR * 3] += key(u, 0, -0.12, 0.38);
  rot[id.tabard * 3] = -view.moving * 0.3 - Math.abs(walk) * 0.25 + sway * 0.03 + key(u, 0, 0.1, -0.35);

  // The core beats; the flames flicker, and flare as the blade comes down.
  size[id.core] = 1 + Math.sin(time * 3.1 + view.phase) * 0.07 + Math.abs(u) * 0.12;
  const flare = 1 + Math.max(0, -u) * 0.35;
  size[id.flameA] = (1 + Math.sin(time * 17) * 0.1 + Math.sin(time * 29.3) * 0.06) * flare;
  size[id.flameB] = (1 + Math.sin(time * 19.7 + 2) * 0.1 + Math.sin(time * 31.1) * 0.06) * flare;
}

/* -------------------------------------------------------------------------- */
/* Cloth                                                                      */
/* -------------------------------------------------------------------------- */

const TINT = new THREE.Color();

/**
 * A cloak: strips of cloth hung side by side from the shoulders, each a grid
 * of points re-hung every frame. One wide strip is a cape; several narrow ones
 * of uneven length, each ending in a point, are a cloak in tatters.
 *
 * @param strips  [{ from, to (x of its sides at the top), length, flare, point (0..1: how far the hem narrows), phase, cols }]
 * @param o.ink, o.trim   paints of the cloth and of the band along its hem
 * @param o.top, o.back   where it hangs from, relative to the chest's pivot
 */
function createCloth(strips, { rows = 12, ink, trim, top, back, material }) {
  const positions = [];
  const colors = [];
  const surfaces = [];
  const index = [];
  const layout = [];
  for (const strip of strips) {
    const cols = strip.cols ?? 2;
    const base = positions.length / 3;
    layout.push({ ...strip, cols, base });
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      for (let i = 0; i <= cols; i++) {
        positions.push(0, 0, 0);
        const banded = trim && v > 0.9 && v < 0.97;
        const paintOf = banded ? trim : ink;
        TINT.lerpColors(paintOf.high, paintOf.low, banded ? 0.4 : v ** 0.8);
        colors.push(TINT.r, TINT.g, TINT.b);
        surfaces.push(...paintOf.finish);
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = base + j * (cols + 1) + i;
        const c = a + cols + 1;
        // Wound to face backwards, away from the wearer.
        index.push(a, a + 1, c, a + 1, c + 1, c);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute(positions, 3);
  position.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aSurface', new THREE.Float32BufferAttribute(surfaces, 3));
  geometry.setIndex(index);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const array = position.array;
  /**
   * Hangs the cloth again.
   * @param lift  how far it streams out behind (0 hanging, 1 flying)
   * @param sway  how far it swings to one side
   */
  function update(time, lift, sway) {
    for (const strip of layout) {
      const { cols, base, length, flare = 1, point = 0, phase = 0 } = strip;
      const step = length / rows;
      const centre = (strip.from + strip.to) / 2;
      const half = (strip.to - strip.from) / 2;
      let y = top;
      let z = back;
      for (let j = 0; j <= rows; j++) {
        const v = j / rows;
        if (j) {
          // Each row hangs from the one above, at an angle that a wave runs down.
          const wave = Math.sin(time * (3.2 + lift * 3.5) - v * 4.4 + phase) * (0.06 + 0.2 * lift) * v;
          const angle = Math.max(0.03, 0.1 + lift * (0.3 + 0.7 * v) + wave + Math.sin(time * 1.3 + phase * 2) * 0.03);
          y -= Math.cos(angle) * step;
          z -= Math.sin(angle) * step;
        }
        const narrow = 1 - point * Math.max(0, (v - 0.7) / 0.3) ** 1.5;
        for (let i = 0; i <= cols; i++) {
          const u = (i / cols) * 2 - 1;
          const x = (centre + u * half * narrow) * (1 + (flare - 1) * v);
          const at = (base + j * (cols + 1) + i) * 3;
          const ripple = Math.sin(x * 9 + time * (2.6 + lift * 3) + phase) * 0.028 * v * (1 + 2.5 * lift);
          array[at] = x + sway * v * v * length;
          array[at + 1] = y;
          // The cloth wraps a little way round the shoulders at the top.
          array[at + 2] = z + ripple + (1 - v) ** 3 * Math.abs(x) * 0.45;
        }
      }
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  return { mesh, update };
}

/* -------------------------------------------------------------------------- */
/* Motes                                                                      */
/* -------------------------------------------------------------------------- */

const MOTE_VERTEX = /* glsl */ `
attribute vec3 aState;   // size, age (0..1), heat (0..1)
uniform float uPixels;
varying vec2 vState;
void main() {
  vState = aState.yz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aState.x * (1.0 - aState.y * 0.55) * uPixels / gl_Position.w;
}
`;

const MOTE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uHot;
uniform vec3 uCool;
varying vec2 vState;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * smoothstep(0.0, 0.12, vState.x) * (1.0 - vState.x);
  vec3 col = mix(uHot, uCool, smoothstep(0.0, 0.7, vState.x)) * (0.6 + 0.4 * vState.y);
  gl_FragColor = vec4(col * a, 1.0);
  #include <colorspace_fragment>
}
`;

const BUFFER = new THREE.Vector2();

/**
 * Sparks shed in the world: each is born on the weapon, then drifts on its own,
 * so they trail behind a moving blade. `rise` lifts them like embers.
 */
function createMotes(glowTexture, { count, hot, cool, size, rise, life }) {
  const positions = new Float32Array(count * 3);
  const states = new Float32Array(count * 3);
  const velocity = new Float32Array(count * 3);
  const ages = new Float32Array(count).fill(1);
  const spans = new Float32Array(count).fill(1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aState', new THREE.BufferAttribute(states, 3).setUsage(THREE.DynamicDrawUsage));
  const uniforms = {
    uMap: { value: glowTexture },
    uPixels: { value: 400 },
    uHot: { value: new THREE.Color(hot[0]).multiplyScalar(hot[1]) },
    uCool: { value: new THREE.Color(cool[0]).multiplyScalar(cool[1]) },
  };
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({ uniforms, vertexShader: MOTE_VERTEX, fragmentShader: MOTE_FRAGMENT, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  points.frustumCulled = false;
  points.renderOrder = 4;
  // Point sizes are in pixels of whatever is being drawn into.
  points.onBeforeRender = (renderer, scene, camera) => {
    const target = renderer.getRenderTarget();
    const height = target ? target.height : renderer.getDrawingBufferSize(BUFFER).y;
    uniforms.uPixels.value = height * 0.5 * camera.projectionMatrix.elements[5];
  };

  let next = 0;
  let owed = 0;
  return {
    points,
    /** Sheds `rate` motes a second from points picked by `emit(out, k)`, k random in 0..1. */
    update(dt, rate, emit, scale) {
      for (let i = 0; i < count; i++) {
        if (ages[i] >= 1) continue;
        ages[i] = Math.min(1, ages[i] + dt / spans[i]);
        velocity[i * 3 + 1] += rise * dt * scale;
        for (let k = 0; k < 3; k++) positions[i * 3 + k] += velocity[i * 3 + k] * dt;
        states[i * 3 + 1] = ages[i];
      }
      owed = Math.min(owed + rate * dt, 6);
      while (owed >= 1) {
        owed -= 1;
        const i = next;
        next = (next + 1) % count;
        const at = emit(Math.random());
        positions[i * 3] = at.x;
        positions[i * 3 + 1] = at.y;
        positions[i * 3 + 2] = at.z;
        velocity[i * 3] = (Math.random() - 0.5) * 0.5 * scale;
        velocity[i * 3 + 1] = (0.2 + Math.random() * 0.5) * rise * scale;
        velocity[i * 3 + 2] = (Math.random() - 0.5) * 0.5 * scale;
        ages[i] = 0;
        spans[i] = life * (0.6 + Math.random() * 0.8);
        states[i * 3] = size * scale * (0.6 + Math.random() * 0.8);
        states[i * 3 + 1] = 0;
        states[i * 3 + 2] = Math.random();
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.aState.needsUpdate = true;
    },
    /** Puts every mote out. */
    clear() {
      ages.fill(1);
      states.fill(0);
      geometry.attributes.aState.needsUpdate = true;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Hero                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What makes each champion look like itself: the model, its pose, its cloak and
 * its motes, and the timings of its blow. The colours of a side (the rim light
 * and the ring on the ground) belong to the side, so a champion keeps its own
 * armour on either side and still reads as that side's.
 */
const LOOK = {
  aether_knight: {
    build: knight,
    pose: poseKnight,
    size: 1.4,
    spec: { swing: 0.46, windup: 0.14, impact: 0.42 },
    cloak: {
      ink: paint(0x0c1f7a, 0x2f62e6, FINISH.cloth),
      trim: paint(0xb98a2c, 0xf7e3a0, FINISH.gold),
      strips: [{ from: -0.27, to: 0.27, length: 1.3, flare: 1.42, cols: 8 }],
      top: 0.53,
      back: -0.19,
    },
    // Motes of light drift off the rune blade.
    motes: { count: 28, hot: [0xeaffff, 2.2], cool: [0x2f9cff, 1.4], size: 0.2, rise: 0.5, life: 0.9, rate: 9, from: 0.3, to: 1.15, spread: 0.05 },
  },
  morgath: {
    build: warlord,
    pose: poseWarlord,
    size: 1.5,
    spec: { swing: 0.56, windup: 0.16, impact: 0.46 },
    cloak: {
      ink: paint(0x3d060c, 0xb01c20, FINISH.cloth),
      trim: null,
      strips: [
        { from: -0.33, to: -0.19, length: 1.02, flare: 1.5, point: 0.9, phase: 0.4 },
        { from: -0.2, to: -0.06, length: 1.3, flare: 1.5, point: 0.7, phase: 1.9 },
        { from: -0.07, to: 0.07, length: 1.12, flare: 1.5, point: 0.95, phase: 3.1 },
        { from: 0.06, to: 0.2, length: 1.34, flare: 1.5, point: 0.75, phase: 4.6 },
        { from: 0.19, to: 0.33, length: 0.96, flare: 1.5, point: 0.9, phase: 5.7 },
      ],
      top: 0.55,
      back: -0.23,
    },
    // The greatsword burns: embers climb off the whole length of it.
    motes: { count: 72, hot: [0xffe6a8, 2.6], cool: [0xff4a12, 1.5], size: 0.3, rise: 1.5, life: 0.75, rate: 46, from: 0.3, to: 1.75, spread: 0.1 },
  },
};

/** Each side's rim light on the models, and the colour of the ring it stands in. */
const TEAM = {
  radiant: { rim: 0x4fc3ff, ring: 0x59d2ff },
  dire: { rim: 0xff5a36, ring: 0xff6a1a },
};

/** A champion's sculpt is built once: its CPU arrays are only read, so both sides' rigs share it. */
const SCULPTS = new Map();
const sculptOf = (champion) => {
  if (!SCULPTS.has(champion)) SCULPTS.set(champion, LOOK[champion].build());
  return SCULPTS.get(champion);
};

/** The champions a hero can be, in the order they are built. */
export const HERO_MODELS = Object.keys(LOOK);

/**
 * One champion's body on one side: the rig, the cloak that streams from it and
 * the motes it sheds. Everything lives under `body` and `effects` so that a
 * hero can hold several and show one.
 */
function createModel(champion, side, { envMap, glowTexture }) {
  const look = LOOK[champion];
  const size = look.size;
  const { sculpt, bones } = sculptOf(champion);
  const options = { envMap, envIntensity: 0.8, rim: TEAM[side].rim, rimStrength: 0.5 };
  const rig = createRig(sculpt, bones, 1, options);
  rig.height = 1.5;
  rig.mesh.count = 1;
  rig.mesh.setMatrixAt(0, new THREE.Matrix4());

  const body = new THREE.Group();
  body.add(rig.mesh);
  const cloth = createCloth(look.cloak.strips, { ...look.cloak, material: surfaceMaterial({ ...options, side: THREE.DoubleSide }) });
  body.add(cloth.mesh);

  const motes = createMotes(glowTexture, look.motes);
  const b = bones.id;
  const world = new THREE.Matrix4();
  const at = new THREE.Vector3();
  let lift = 0;
  let liftSpeed = 0;
  let sway = 0;
  let swaySpeed = 0;
  let heading = null;

  return {
    body,
    motes,
    look,
    triangles: sculpt.index.length / 3,

    /** Poses the model for this frame; `parent` is the hero's `body`, already placed. */
    pose(parent, view, time, dt) {
      look.pose(rig, view, time);
      const matrices = rig.write(0);
      rig.texture.needsUpdate = true;

      // The cloak is flung back by running and by the lunge of a blow, and swings out of a turn.
      // `view.wind` (the lobby's stage sets it; a battle does not) stirs it where the hero only stands.
      const turned = heading === null || dt <= 0 ? 0 : (((view.facing - heading + Math.PI) % TAU) + TAU) % TAU - Math.PI;
      heading = view.facing;
      const step = Math.min(dt, 0.05);
      const wantLift = Math.min(1, view.moving * 0.72 + Math.max(0, -view.strike) * 0.5 + (view.wind ?? 0));
      liftSpeed += ((wantLift - lift) * 60 - liftSpeed * 9) * step;
      lift = Math.min(1.2, Math.max(0, lift + liftSpeed * step));
      const wantSway = step > 0 ? Math.max(-0.5, Math.min(0.5, (turned / step) * 0.06)) : 0;
      swaySpeed += ((wantSway - sway) * 50 - swaySpeed * 8) * step;
      sway += swaySpeed * step;
      cloth.mesh.matrix.copy(matrices[b.chest]);
      cloth.update(time + view.phase, lift, sway);

      // Motes are born along the blade, in the world.
      parent.updateWorldMatrix(true, false);
      world.multiplyMatrices(parent.matrixWorld, matrices[b.blade]);
      const { from, to, spread, rate } = look.motes;
      motes.update(dt, rate * (1 + Math.abs(view.strike) * 1.5), (k) => at.set((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread * 2, from + (to - from) * k).applyMatrix4(world), size);
    },

    /** A flat, glowing copy of the model frozen in its pose of this moment. */
    ghost(color) {
      const { data, width } = rig.texture.image;
      const texture = new THREE.DataTexture(data.slice(), width, 1, THREE.RGBAFormat, THREE.FloatType);
      texture.needsUpdate = true;
      const skin = ghostMaterial({ value: texture }, color);
      const flat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.InstancedMesh(rig.mesh.geometry, skin, 1);
      mesh.setMatrixAt(0, new THREE.Matrix4());
      mesh.frustumCulled = false;
      const cloak = new THREE.Mesh(cloth.mesh.geometry.clone(), flat);
      cloak.matrixAutoUpdate = false;
      cloak.matrix.copy(cloth.mesh.matrix);
      cloak.frustumCulled = false;
      const object = new THREE.Group();
      object.add(mesh, cloak);
      return {
        object,
        fade(opacity) {
          skin.opacity = opacity;
          flat.opacity = opacity * 0.6;
        },
        dispose() {
          texture.dispose();
          skin.dispose();
          flat.dispose();
          cloak.geometry.dispose();
          mesh.dispose();
        },
      };
    },

    reset() {
      motes.clear();
      heading = null;
    },
  };
}

/**
 * Builds a side's hero: one model per champion, of which the chosen one shows.
 *
 * Returns the hero's `group` (stands on the hero's ground point: team ring,
 * contact shadow and `body`), the `body` to place, turn and scale by `size`,
 * and `effects`, a group that stays at the world's origin and holds what the
 * hero sheds. `setChampion(id)` chooses the model; `size`, `spec` and
 * `champion` follow it. `pose(view, time, dt)` animates it from a unit view's
 * `gait`, `moving`, `strike`, `phase` and `facing`.
 *
 * Every model is built up front, so choosing a champion at the start of a match
 * compiles and uploads nothing. `champions` builds only those named: the lobby's
 * stage shows one champion a side, and has no use for the rest.
 */
export function buildHero(side, { envMap, glowTexture, champions = HERO_MODELS }) {
  const models = new Map(champions.map((champion) => [champion, createModel(champion, side, { envMap, glowTexture })]));
  const body = new THREE.Group();
  const effects = new THREE.Group();
  for (const model of models.values()) {
    model.body.visible = false;
    model.motes.points.visible = false;
    body.add(model.body);
    effects.add(model.motes.points);
  }

  // Team ring: arcs of light that turn slowly on the ground.
  const ring = new THREE.Group();
  const ringMaterial = new THREE.MeshBasicMaterial({ color: TEAM[side].ring, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (let i = 0; i < 4; i++) {
    const arc = new THREE.Mesh(new THREE.RingGeometry(0.86, 1.02, 10, 1, (i * TAU) / 4, TAU / 4 - 0.4).rotateX(-HALF), ringMaterial);
    arc.position.y = 0.06;
    ring.add(arc);
  }
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1.05, 24).rotateX(-HALF), new THREE.MeshBasicMaterial({ map: glowTexture, color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
  shadow.position.y = 0.04;

  const group = new THREE.Group();
  group.add(shadow, ring, body);
  group.visible = false;

  const hero = {
    group,
    body,
    ring,
    size: 0,
    effects,
    spec: null,
    champion: null,
    triangles: 0,
    model: null,

    /** Shows the model of `champion`; the others are hidden and keep their motes out. */
    setChampion(champion) {
      const next = models.get(champion);
      if (!next) throw new Error(`No hero model for champion "${champion}"`);
      for (const model of models.values()) {
        const shown = model === next;
        model.body.visible = shown;
        model.motes.points.visible = shown;
        if (!shown) model.reset();
      }
      hero.model = next;
      hero.champion = champion;
      hero.size = next.look.size;
      hero.spec = next.look.spec;
      hero.triangles = next.triangles;
    },

    /** Poses the body for this frame. Call after placing `group` and `body`. */
    pose(view, time, dt) {
      hero.model.pose(body, view, time, dt);
    },

    /** Lets what the hero has shed fade out without shedding more: the hero is dead or hidden. */
    rest(dt) {
      hero.model.motes.update(dt, 0, null, hero.size);
    },

    /** Drops everything left over from the last match. */
    reset() {
      for (const model of models.values()) model.reset();
    },

    /**
     * A flat, glowing copy of the hero frozen in its pose of this moment.
     * Returns { object, fade(opacity), dispose() }; the object is a copy of `body`.
     */
    ghost(color) {
      const copy = hero.model.ghost(color);
      copy.object.rotation.copy(body.rotation);
      return copy;
    },
  };
  const first = HERO_MODELS[side === 'radiant' ? 0 : 1];
  hero.setChampion(models.has(first) ? first : champions[0]);
  return hero;
}
