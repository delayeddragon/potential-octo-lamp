/**
 * RuneDeck — Lane Towers and Ancient Thrones.
 *
 * Every structure is an arcane spire built with the sculpting kit and split into
 * a few meshes, so it can move where it should:
 *
 *  - the body: a stepped footing, a tier of carved arches round a glowing core,
 *    a tapering shaft with bands and fins, and a crown of claws round the summit;
 *    one static mesh whose geometry is shared by every structure of a kind;
 *  - three runed rings that float free of the shaft, counter-rotating and wobbling;
 *  - the orb that levitates over the crown (a crystal for the Radiant, a ball of
 *    magma for the Dire) with shards circling it, which recoils and pulses when
 *    the structure fires.
 *
 * Radiant: pale carved stone, gold trim and blue light. Dire: black obsidian,
 * dark iron and jagged spikes, split by molten seams.
 */

import * as THREE from 'three';

import { TAU, canvasTexture } from './geometry.js';
import { FINISH, Sculpt, paint, surfaceMaterial } from './sculpt.js';

const TEAM = { radiant: 0x4fc3ff, dire: 0xff5a36 };

/** Paints. `rune` glows (it blooms), `heart` is the hottest part of a light, `spike` is the sharp dark stone. */
const INKS = {
  radiant: {
    stone: paint(0x6d7a95, 0xbdc8dd, FINISH.stone),
    carved: paint(0x505d78, 0x98a5bd, [0.04, 0.72, 0]),
    deep: paint(0x262f47, 0x62708c, FINISH.stone),
    trim: paint(0x9a6a1a, 0xf0cc72, FINISH.gold),
    crystal: paint(0x1556c4, 0x8fdcff, [0.1, 0.12, 0.6]),
    rune: paint(0x2a9cf0, 0xa8e8ff, [0, 0.5, 0.85]),
    heart: paint(0x3aa8f0, 0xb0e8ff, [0, 0.5, 1.0]),
    spike: paint(0x66738e, 0xb2bed4, FINISH.stone),
  },
  dire: {
    stone: paint(0x120e17, 0x4b3d5a, FINISH.obsidian),
    carved: paint(0x0b080f, 0x2c2336, FINISH.iron),
    deep: paint(0x050308, 0x1b1422, FINISH.obsidian),
    trim: paint(0x2a2130, 0x86759a, FINISH.iron),
    crystal: paint(0xc42f05, 0xff9a2e, [0, 0.55, 1.6]),
    rune: paint(0xff4f0c, 0xffc062, FINISH.glow),
    heart: paint(0xff8a24, 0xfff2a8, FINISH.ember),
    spike: paint(0x0a070d, 0x6f5a86, FINISH.obsidian),
  },
};

/** Measurements of the two kinds, in world units. */
const DIMS = {
  tower: {
    // Footing: [radius, top] of each step.
    steps: [[1.58, 0.2], [1.38, 0.36], [1.16, 0.52]],
    base: 0.52,
    // Arch tier: pillars on a circle, an arch between each pair, a cornice on top.
    n: 6, ring: 0.98, pillar: 0.12, spring: 1.1, wall: 0.24, band: 0.13, cornice: 1.72, rc: 1.08,
    // Shaft, collar and crown.
    shaft: [2.3, 3.78], shaftR: [0.62, 0.42], fins: 4, claws: 5, orbR: 0.38,
    // Floating rings: [y, radius, tilt, spin speed].
    rings: [[1.2, 1.42, 0.05, 0.55], [2.78, 1.04, -0.09, -0.85], [3.5, 0.9, 0.14, 1.2]],
    glyph: 0.085, k: 1,
  },
  throne: {
    steps: [[3.0, 0.36], [2.62, 0.66], [2.2, 0.92]],
    base: 0.92,
    n: 8, ring: 1.78, pillar: 0.2, spring: 1.78, wall: 0.4, band: 0.2, cornice: 2.34, rc: 1.98,
    shaft: [3.12, 3.85], shaftR: [1.1, 0.78], fins: 4, claws: 6, orbR: 0.62, drums: 3,
    rings: [[1.65, 2.38, 0.05, 0.4], [2.95, 1.72, -0.08, -0.65], [5.0, 1.62, 0.2, 0.9]],
    glyph: 0.13, k: 1.6,
  },
};

/** A few rune glyphs: outlines in a [-1, 1] square. */
const GLYPHS = [
  [[-0.6, -1], [-0.6, 1], [0.6, 1], [0.6, 0.55], [-0.15, 0.55], [-0.15, 0.2], [0.45, 0.2], [0.45, -0.2], [-0.15, -0.2], [-0.15, -1]],
  [[0, 1], [0.8, -1], [0.35, -1], [0, 0], [-0.35, -1], [-0.8, -1]],
  [[-0.2, 1], [0.2, 1], [0.2, 0.25], [0.75, 0.25], [0.75, -0.15], [0.2, -0.15], [0.2, -1], [-0.2, -1], [-0.2, -0.15], [-0.75, -0.15], [-0.75, 0.25], [-0.2, 0.25]],
  [[-0.7, 1], [0.7, 1], [0.7, 0.6], [0.25, 0.6], [0.25, -1], [-0.25, -1], [-0.25, 0.6], [-0.7, 0.6]],
  [[0.7, 1], [-0.7, 0], [0.7, -1], [0.7, -0.5], [0.15, 0], [0.7, 0.5]],
];

const UP = new THREE.Vector3(0, 1, 0);
const AIM = new THREE.Quaternion();
const TURN = new THREE.Euler();
const DIRECTION = new THREE.Vector3();

/** [x, y, z] at `angle` and `radius` round the vertical. */
const at = (angle, radius, y) => [Math.cos(angle) * radius, y, Math.sin(angle) * radius];

/** Placement options that stand a shape on `angle` of a circle with its +Z facing out. */
const outward = (angle, o = {}) => ({ ry: Math.PI / 2 - angle, ...o });

/** Placement options that stand a shape's local Y along `direction`. */
function along(direction, o = {}) {
  AIM.setFromUnitVectors(UP, DIRECTION.set(...direction).normalize());
  TURN.setFromQuaternion(AIM, 'XYZ');
  return { rx: TURN.x, ry: TURN.y, rz: TURN.z, ...o };
}

/** A lathe profile for stacked, chamfered steps: [[radius, top], ...] from the widest down. */
function stairs(list) {
  const profile = [[0, 0]];
  let low = 0;
  for (const [radius, top] of list) {
    profile.push([radius, low], [radius, top - 0.05], [radius - 0.06, top]);
    low = top;
  }
  profile.push([0, low]);
  return profile;
}

/**
 * An arch of carved stone standing on its springline in the XY plane: a band
 * of `inner` to `outer` half-width, wall `depth` thick. `pointed` makes it a gothic arch.
 */
function archBand(inner, outer, depth, pointed, bevel) {
  const shape = new THREE.Shape();
  shape.moveTo(-outer, 0);
  shape.lineTo(-inner, 0);
  if (pointed) {
    shape.absarc(inner, 0, inner * 2, Math.PI, (Math.PI * 2) / 3, true);
    shape.absarc(-inner, 0, inner * 2, Math.PI / 3, 0, true);
  } else {
    shape.absarc(0, 0, inner, Math.PI, 0, true);
  }
  shape.lineTo(inner, 0);
  shape.lineTo(outer, 0);
  if (pointed) {
    shape.absarc(-outer, 0, outer * 2, 0, Math.PI / 3, false);
    shape.absarc(outer, 0, outer * 2, (Math.PI * 2) / 3, Math.PI, false);
  } else {
    shape.absarc(0, 0, outer, 0, Math.PI, false);
  }
  return new THREE.ExtrudeGeometry(shape, { depth, curveSegments: pointed ? 3 : 4, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1 }).translate(0, 0, -depth / 2);
}

/** A rune glyph plate standing at (x, y, z), `size` tall, facing `angle` outwards. */
function glyph(s, ink, index, x, y, z, size, angle, depth = size * 0.22) {
  const outline = GLYPHS[index % GLYPHS.length].map(([px, py]) => [px * size * 0.5, py * size]);
  return s.extrude(ink, x, y, z, outline, depth, outward(angle));
}

/* -------------------------------------------------------------------------- */
/* Body                                                                       */
/* -------------------------------------------------------------------------- */

/** Everything that stands still: footing, arches, shaft, crown. */
function buildBody(side, kind) {
  const d = DIMS[kind];
  const ink = INKS[side];
  const radiant = side === 'radiant';
  const throne = kind === 'throne';
  const k = d.k;
  const s = new Sculpt();
  const seg = radiant ? 20 : 7;

  /* Footing: broad steps with an inlaid band, rune plates and, for the Dire, teeth. */
  s.lathe(ink.stone, 0, 0, 0, stairs(d.steps), { seg: radiant ? 22 : 7, facet: true });
  const [top, mid] = [d.steps[d.steps.length - 1], d.steps[1]];
  s.torus(ink.trim, 0, mid[1] + 0.012, 0, mid[0] - 0.12, 0.035 * k, { sides: 4, seg: radiant ? 36 : 7, facet: true });
  const plates = throne ? (radiant ? 16 : 12) : 10;
  for (let i = 0; i < plates; i++) {
    const a = (i / plates) * TAU + (radiant ? 0 : 0.2);
    const [x, , z] = at(a, mid[0] - 0.32 * k, mid[1]);
    if (radiant) {
      s.box(ink.carved, x, mid[1], z, 0.3 * k, 0.05 * k, 0.2 * k, { ry: -a + Math.PI / 2 });
      glyph(s, ink.rune, i, ...at(a, mid[0] - 0.32 * k, mid[1] + 0.055 * k), 0.07 * k, a, 0.02);
    } else {
      s.cone(ink.spike, ...at(a, d.steps[0][0] - 0.05, 0), 0.17 * k, (0.55 + (i % 3) * 0.25) * k, { seg: 4, ...along([Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55]) });
    }
  }
  if (!radiant) {
    for (let i = 0; i < plates; i++) {
      const a = ((i + 0.5) / plates) * TAU + 0.2;
      s.gem(ink.rune, ...at(a, mid[0] - 0.3 * k, mid[1] + 0.03), 0.07 * k, 0.12 * k, { ry: -a });
    }
    s.lathe(ink.rune, 0, 0, 0, [[mid[0] + 0.02, mid[1] - 0.2], [mid[0] + 0.02, mid[1] - 0.1], [mid[0] - 0.03, mid[1] - 0.1]], { seg: 7, facet: true });
  }

  /* Arch tier: pillars, arches between them and a glowing core behind. */
  const { n, ring, pillar: pr, spring, wall, band, cornice } = d;
  const hc = ring * Math.sin(Math.PI / n);
  const mid2 = ring * Math.cos(Math.PI / n);
  const offset = TAU / (n * 2) * 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + offset;
    const c = pr;
    const h = cornice - d.base;
    s.lathe(ink.stone, ...at(a, ring, d.base), [[0, 0], [pr * 1.7, 0], [pr * 1.7, h * 0.05], [pr * 1.3, h * 0.08], [pr * 1.0, h * 0.14], [c * 0.92, h * 0.5], [c * 1.02, h * 0.86], [pr * 1.45, h * 0.89], [pr * 1.6, h * 0.94], [pr * 1.6, h], [0, h]], { seg: radiant ? 8 : 6, facet: true });
    // A band of metal where each arch springs from the pillar.
    s.torus(ink.trim, ...at(a, ring, spring - 0.04 * k), pr * 1.12, 0.03 * k, { sides: 4, seg: radiant ? 8 : 6, facet: true });
    if (!radiant) s.cone(ink.spike, ...at(a, ring + pr * 1.5, cornice - 0.15), pr * 0.5, 0.75 * k, { seg: 4, ...along([Math.cos(a) * 0.75, 1, Math.sin(a) * 0.75]) });
    const m = a + TAU / (n * 2);
    const outer = hc + pr * 0.4;
    s.add(archBand(outer - band, outer, wall, !radiant, 0.025 * k), ink.stone, ...at(m, mid2, spring), { ry: -m - Math.PI / 2 });
    const apex = spring + (radiant ? outer : (outer - band) * 1.732 + band * 0.6);
    // The keystone: a gem on a gold boss on a radiant arch, a magma-filled spike on a dire one.
    if (radiant) {
      s.gem(ink.rune, ...at(m, mid2 + wall / 2 + 0.02, apex - band * 0.45), 0.055 * k, 0.17 * k, { ry: -m });
    } else {
      s.gem(ink.rune, ...at(m, mid2 + wall / 2 + 0.01, apex - band * 0.9), 0.05 * k, 0.26 * k, { ry: -m });
      s.cone(ink.spike, ...at(m, mid2, apex - band * 0.5), 0.06 * k, 0.42 * k, { seg: 4 });
    }
    // A second, smaller gem on the inner face keeps the core lit.
    s.box(ink.carved, ...at(m, mid2, d.base), hc * 1.6, 0.06 * k, wall * 1.02, { ry: -m - Math.PI / 2 });
  }
  // Floor of the tier and the core it shows through the arches.
  s.cyl(ink.deep, 0, d.base - 0.01, 0, ring - 0.06, ring - 0.06, 0.05 * k, { seg: radiant ? 14 : 7 });
  if (radiant) {
    s.crystal(ink.crystal, 0, d.base, 0, 0.3 * k, (cornice - d.base) * 0.92, { seg: 6 });
    for (let i = 0; i < (throne ? 7 : 5); i++) {
      const a = (i / (throne ? 7 : 5)) * TAU + 0.3;
      s.crystal(ink.crystal, ...at(a, 0.26 * k, d.base), 0.1 * k * (1 + (i % 2) * 0.4), (cornice - d.base) * (0.42 + (i % 3) * 0.12), along([Math.cos(a) * 0.35, 1, Math.sin(a) * 0.35]));
    }
    s.lathe(ink.trim, 0, d.base, 0, [[0, 0], [0.34 * k, 0], [0.34 * k, 0.05 * k], [0.26 * k, 0.1 * k], [0, 0.1 * k]], { seg: 12, facet: true });
  } else {
    s.lathe(ink.crystal, 0, d.base, 0, [[0, 0], [0.34 * k, 0], [0.26 * k, (cornice - d.base) * 0.5], [0.3 * k, (cornice - d.base) * 0.92], [0, (cornice - d.base) * 0.92]], { seg: 7, facet: true });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.5;
      s.tube(ink.spike, [at(a, 0.4 * k, d.base), at(a, 0.58 * k, d.base + (cornice - d.base) * 0.4), at(a, 0.34 * k, cornice - 0.1)], [0.12 * k, 0.09 * k, 0.015], { sides: 5, facet: true });
    }
  }

  /* Cornice: a carved entablature that caps the arches, with rune plates. */
  const rc = d.rc;
  const c0 = cornice;
  const ch = 0.54 * k;
  s.lathe(ink.stone, 0, c0, 0, [[0, 0], [rc - 0.04, 0], [rc, 0.04 * k], [rc, 0.18 * k], [rc + 0.08 * k, 0.24 * k], [rc + 0.08 * k, 0.34 * k], [rc - 0.05, 0.4 * k], [rc * 0.62, 0.5 * k], [d.shaftR[0] + 0.1 * k, ch], [0, ch]], { seg: radiant ? 24 : 7, facet: true });
  s.torus(ink.trim, 0, c0 + 0.29 * k, 0, rc + 0.075 * k, 0.03 * k, { sides: 4, seg: radiant ? 28 : 7, facet: true });
  const slabs = throne ? 12 : 8;
  for (let i = 0; i < slabs; i++) {
    const a = (i / slabs) * TAU + 0.1;
    if (radiant) glyph(s, ink.rune, i + 2, ...at(a, rc + 0.05, c0 + 0.19 * k), 0.085 * k, a, 0.04);
    else if (i % 2 === 0) s.cone(ink.spike, ...at(a, rc + 0.05, c0 + 0.34 * k), 0.07 * k, 0.4 * k, { seg: 4, ...along([Math.cos(a) * 1.2, 1, Math.sin(a) * 1.2]) });
    else glyph(s, ink.rune, i, ...at(a, rc + 0.06, c0 + 0.19 * k), 0.09 * k, a, 0.04);
  }

  /* Shaft: drums that taper, banded with metal, with fins and glowing slits. */
  const [s0, s1] = d.shaft;
  const [r0, r1] = d.shaftR;
  const drums = d.drums ?? 3;
  const run = (s1 - s0) / drums;
  for (let j = 0; j < drums; j++) {
    const ya = s0 + j * run;
    const ra = r0 + (r1 - r0) * (j / drums);
    const rb = r0 + (r1 - r0) * ((j + 1) / drums);
    const twist = radiant ? 0 : j * 0.45;
    s.lathe(ink.stone, 0, ya, 0, [[0, 0], [ra + 0.04 * k, 0], [ra + 0.1 * k, 0.05 * k], [ra + 0.06 * k, 0.1 * k], [ra, 0.14 * k], [rb + 0.01, run - 0.12 * k], [rb + 0.07 * k, run - 0.06 * k], [rb + 0.1 * k, run], [0, run]], { seg: radiant ? 14 : 6, facet: true, ry: twist });
    if (radiant) s.torus(ink.trim, 0, ya + run - 0.02, 0, rb + 0.085 * k, 0.026 * k, { sides: 4, seg: 16, facet: true });
    else s.lathe(ink.rune, 0, ya + run - 0.05 * k, 0, [[rb + 0.105 * k, 0], [rb + 0.105 * k, 0.05 * k], [rb + 0.05 * k, 0.05 * k]], { seg: 6, facet: true, ry: twist + 0.45 });
    // Glowing slits in the stone, between the fins.
    const slits = throne ? 6 : 4;
    for (let i = 0; i < slits; i++) {
      const a = (i / slits) * TAU + TAU / (slits * 2) + (radiant ? 0 : twist);
      const rr = (ra + rb) / 2 + 0.03 * k;
      if (radiant) s.gem(ink.rune, ...at(a, rr, ya + run / 2), 0.045 * k, 0.4 * k, { ry: -a, sz: 0.5 });
      else s.gem(ink.rune, ...at(a, rr + 0.03 * k, ya + run / 2), 0.04 * k, 0.46 * k, { ry: -a, sz: 0.5 });
    }
  }
  const fins = d.fins;
  for (let i = 0; i < fins; i++) {
    const a = (i / fins) * TAU;
    if (radiant) {
      s.limb(ink.stone, at(a, r0 + 0.02, s0 + 0.12), at(a, r1 + 0.1 * k, s1 - 0.05), 0.1 * k, 0.05 * k, { seg: 8, cap: 3 });
      s.gem(ink.trim, ...at(a, r1 + 0.12 * k, s1 - 0.02), 0.07 * k, 0.2 * k);
    } else {
      s.tube(ink.spike, [at(a, r0 - 0.06 * k, s0 + 0.1), at(a, r0 + 0.3 * k, s0 + (s1 - s0) * 0.35), at(a, r1 + 0.36 * k, s0 + (s1 - s0) * 0.78), at(a, r1 + 0.22 * k, s1 + 0.3 * k)], [0.13 * k, 0.1 * k, 0.065 * k, 0.005], { sides: 5, facet: true });
      s.tube(ink.rune, [at(a, r0 + 0.16 * k, s0 + 0.3), at(a, r0 + 0.38 * k, s0 + (s1 - s0) * 0.35), at(a, r1 + 0.44 * k, s0 + (s1 - s0) * 0.76)], [0.03 * k, 0.03 * k, 0.005], { sides: 4, facet: true, tint: () => 0.2 });
    }
  }

  /* Collar: a dish that holds the orb's light, and the claws of the crown. */
  const orbY = throne ? 5 : 4.6;
  const rb = r1 + 0.1 * k;
  s.lathe(ink.stone, 0, s1, 0, [[0, 0], [rb, 0], [rb + 0.14 * k, 0.07 * k], [rb + 0.16 * k, 0.17 * k], [rb + 0.02 * k, 0.26 * k], [rb * 0.7, 0.3 * k], [rb * 0.45, 0.24 * k], [0, 0.2 * k]], { seg: radiant ? 18 : 6, facet: true });
  s.torus(ink.trim, 0, s1 + 0.2 * k, 0, rb + 0.14 * k, 0.03 * k, { sides: 4, seg: radiant ? 16 : 6, facet: true });
  s.torus(ink.rune, 0, s1 + 0.27 * k, 0, rb * 0.62, 0.02 * k, { sides: 4, seg: radiant ? 16 : 6, facet: true });
  s.cone(ink.trim, 0, s1 + 0.15 * k, 0, 0.16 * k, Math.max(0.2, orbY - d.orbR * 1.5 - s1 - 0.1 * k), { seg: radiant ? 10 : 5 });
  const claws = d.claws;
  const kc = throne ? 1.15 : 1;
  const oR = d.orbR;
  for (let i = 0; i < claws; i++) {
    const a = (i / claws) * TAU + 0.2;
    const lift = orbY - oR * 0.1;
    const points = radiant
      ? [at(a, rb * 0.8, s1 + 0.2 * k), at(a, oR * 1.7, orbY - oR * 1.1), at(a, oR * 1.95, lift), at(a, oR * 1.5, orbY + oR * 1.35), at(a, oR * 0.75, orbY + oR * 2.05)]
      : [at(a, rb * 0.8, s1 + 0.2 * k), at(a, oR * 1.9, orbY - oR * 1.1), at(a, oR * 2.45, lift + oR * 0.3), at(a, oR * 1.9, orbY + oR * 1.8), at(a, oR * 0.9, orbY + oR * 2.6)];
    s.tube(radiant ? ink.stone : ink.spike, points, radiant ? [0.1 * kc, 0.075 * kc, 0.07 * kc, 0.05 * kc, 0.012 * kc] : [0.13 * kc, 0.1 * kc, 0.085 * kc, 0.05 * kc, 0.005], { sides: radiant ? 6 : 5, steps: 12, facet: true });
    if (radiant) {
      s.gem(ink.trim, ...at(a, oR * 1.95, lift), 0.06 * k, 0.15 * k);
      s.gem(ink.rune, ...at(a, oR * 0.75, orbY + oR * 2.05), 0.045 * k, 0.24 * k, { rz: 0 });
    } else {
      s.tube(ink.rune, [at(a, rb * 0.8 + 0.06 * k, s1 + 0.3 * k), at(a, oR * 1.9 + 0.08 * k, orbY - oR * 1.0), at(a, oR * 2.5 + 0.07 * k, lift + oR * 0.3)], [0.028 * k, 0.026 * k, 0.005], { sides: 4, facet: true, tint: () => 0.2 });
    }
  }

  if (throne) spires(s, side, d, ink);
  return s.geometry();
}

/** The Ancient Throne's rim of spires: tall and short, standing on the outer step. */
function spires(s, side, d, ink) {
  const radiant = side === 'radiant';
  const k = d.k;
  const rim = 2.76;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    const tall = i % 2 === 0;
    const top = tall ? (radiant ? 6.1 : 6.4) : 3.9;
    const y0 = d.steps[0][1] - 0.03;
    if (radiant) {
      const h = top - y0;
      s.lathe(ink.stone, ...at(a, rim, y0), [[0, 0], [0.4, 0], [0.4, 0.28], [0.32, 0.42], [0.27, h * 0.5], [0.23, h * 0.5 + 0.12], [0.26, h * 0.5 + 0.18], [0.2, h * 0.86], [0.26, h * 0.86 + 0.06], [0.26, h * 0.86 + 0.16], [0.14, h * 0.92], [0, h * 0.92]], { seg: 10, facet: true });
      s.torus(ink.trim, ...at(a, rim, y0 + 0.4), 0.33, 0.035, { sides: 5, seg: 10, facet: true });
      s.torus(ink.trim, ...at(a, rim, y0 + h * 0.5 + 0.15), 0.25, 0.035, { sides: 5, seg: 10, facet: true });
      s.cone(ink.stone, ...at(a, rim, y0 + h * 0.92 - 0.02), 0.25, tall ? 0.9 : 0.6, { seg: 8, facet: true });
      s.torus(ink.trim, ...at(a, rim, y0 + h * 0.92), 0.25, 0.035, { sides: 5, seg: 10, facet: true });
      s.ball(ink.trim, ...at(a, rim, y0 + h * 0.92 + (tall ? 0.92 : 0.62)), 0.07, { seg: 8, rings: 6 });
      s.gem(ink.rune, ...at(a, rim, y0 + h * 0.92 + (tall ? 1.15 : 0.85)), 0.06, 0.26);
      for (let g = 0; g < (tall ? 3 : 1); g++) glyph(s, ink.rune, i + g, ...at(a, rim - 0.28, y0 + 0.9 + g * 1.3), 0.17, a + Math.PI, 0.03);
      if (tall) s.gem(ink.rune, ...at(a, rim, y0 + h * 0.5 + 0.55), 0.06, 0.5, { ry: -a, sz: 0.5 });
    } else {
      const lean = tall ? 0.45 : 0.28;
      const out = (r) => rim + r;
      s.tube(ink.spike, [at(a, rim + 0.05, y0 - 0.1), at(a, out(0.18), y0 + (top - y0) * 0.35), at(a, out(0.1), y0 + (top - y0) * 0.7), at(a, out(-lean), top)], [0.36, 0.28, 0.16, 0.004], { sides: 5, facet: true, steps: 18 });
      s.tube(ink.rune, [at(a, rim + 0.4, y0 + 0.2), at(a, out(0.44), y0 + (top - y0) * 0.35), at(a, out(0.26), y0 + (top - y0) * 0.68)], [0.05, 0.045, 0.005], { sides: 4, facet: true, tint: () => 0.2 });
      s.gem(ink.rune, ...at(a, out(0.24), y0 + 0.9), 0.07, 0.34, { ry: -a });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Rings and orb                                                              */
/* -------------------------------------------------------------------------- */

/** One floating ring: an octagonal band studded with rune plates and gems (or, for the Dire, thorns). */
function buildRing(side, radius, index, k, size) {
  const ink = INKS[side];
  const radiant = side === 'radiant';
  const s = new Sculpt();
  const h = 0.055 * k;
  const t = 0.04 * k;
  const profile = [[radius + t * 0.6, -h], [radius + t, -h * 0.4], [radius + t, h * 0.4], [radius + t * 0.6, h], [radius - t * 0.6, h], [radius - t, h * 0.4], [radius - t, -h * 0.4], [radius - t * 0.6, -h], [radius + t * 0.6, -h]];
  const seg = Math.max(24, Math.round(radius * 18));
  s.lathe(radiant ? ink.trim : ink.trim, 0, 0, 0, profile, { seg, facet: true });
  s.torus(ink.rune, 0, h + 0.002, 0, radius, 0.014 * k, { sides: 4, seg });
  s.torus(ink.rune, 0, -h - 0.002, 0, radius, 0.014 * k, { sides: 4, seg });
  const count = Math.round(radius * (radiant ? 9 : 8) / k * 1.2);
  const g = size * (0.9 + (index % 2) * 0.2);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    const [x, , z] = at(a, radius + t, 0);
    if (i % 4 === 2) {
      if (radiant) s.gem(ink.crystal, ...at(a, radius + t * 0.5, 0), 0.05 * k, 0.2 * k, { ry: -a, rz: 0, sx: 1.1 });
      else s.cone(ink.spike, x, 0, z, 0.06 * k, 0.34 * k, { seg: 4, ...along([Math.cos(a), 0.15, Math.sin(a)]) });
    } else {
      glyph(s, ink.rune, i + index, x, 0, z, g, a, g * 0.18);
    }
  }
  // A few tall wings or thorns lift the silhouette of the ring.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + index;
    if (radiant) s.gem(ink.trim, ...at(a, radius + t * 0.4, h + 0.05 * k), 0.06 * k, 0.28 * k, { ry: -a });
    else s.cone(ink.spike, ...at(a, radius, h * 0.5), 0.05 * k, 0.42 * k, { seg: 4, rz: 0, ...along([0, 1, 0]) });
  }
  return s.geometry();
}

/** The levitating orb with its shards, modelled about its own centre. */
function buildOrb(side, radius) {
  const ink = INKS[side];
  const s = new Sculpt();
  if (side === 'radiant') {
    // A brilliant-cut crystal round a hot heart, cinched by a golden belt, with shards in orbit.
    const r = radius;
    s.lathe(ink.crystal, 0, 0, 0, [[0, -r * 1.22], [r * 0.52, -r * 0.55], [r * 0.95, 0], [r * 0.66, r * 0.58], [0, r * 1.22]], { seg: 8, facet: true });
    s.lathe(ink.crystal, 0, 0, 0, [[0, -r * 1.0], [r * 0.5, -r * 0.1], [r * 0.4, r * 0.7], [0, r * 1.5]], { seg: 4, facet: true, ry: 0.4, rz: 0.5, sx: 0.7, sz: 0.7 });
    s.ball(ink.heart, 0, 0, 0, r * 0.36, { seg: 12, rings: 8 });
    s.torus(ink.trim, 0, 0, 0, r * 1.02, r * 0.035, { sides: 5, seg: 32, facet: true });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const rise = Math.sin(a * 2 + 1) * r * 0.4;
      s.gem(ink.crystal, ...at(a, r * 1.75, rise), r * 0.13, r * 0.5, { ry: -a, rz: 0.4, facet: true });
    }
  } else {
    // A ball of magma in a cracked crust of black plates, with obsidian shards in orbit.
    const r = radius;
    s.ball(ink.crystal, 0, 0, 0, r * 0.96, { seg: 14, rings: 9 });
    s.ball(ink.heart, 0, 0, 0, r * 0.72, { seg: 8, rings: 5 });
    const plates = 11;
    for (let i = 0; i < plates; i++) {
      const y = 1 - (i + 0.5) * (2 / plates);
      const ring = Math.sqrt(1 - y * y);
      const a = i * 2.39996;
      const dir = [Math.cos(a) * ring, y, Math.sin(a) * ring];
      s.rock(ink.stone, dir[0] * r * 0.88, dir[1] * r * 0.88, dir[2] * r * 0.88, r * 0.5, { seed: 10 + i, rough: 0.12, detail: 1, sy: 0.55, ...along(dir) });
    }
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const rise = Math.sin(a * 2 + 1) * r * 0.4;
      s.crystal(ink.spike, ...at(a, r * 1.75, rise), r * 0.12, r * 0.52, along([Math.cos(a), 0.5 + rise, Math.sin(a)]));
      s.gem(ink.rune, ...at(a, r * 1.72, rise), r * 0.05, r * 0.2, { ry: -a, tint: () => 0.15 });
    }
  }
  return s.geometry();
}

/* -------------------------------------------------------------------------- */
/* Structures                                                                 */
/* -------------------------------------------------------------------------- */

const cache = new Map();
let haloTexture = null;

/** Geometry shared by every structure of a side and kind. */
function geometries(side, kind) {
  const key = `${side}:${kind}`;
  if (!cache.has(key)) {
    const d = DIMS[kind];
    const geometry = {
      body: buildBody(side, kind),
      rings: d.rings.map(([, radius], i) => buildRing(side, radius, i, d.k, d.glyph)),
      orb: buildOrb(side, d.orbR),
    };
    geometry.parts = [geometry.body, ...geometry.rings, geometry.orb].map((g) => g.index.count / 3);
    geometry.triangles = [geometry.body, ...geometry.rings, geometry.orb].reduce((sum, g) => sum + g.index.count / 3, 0);
    cache.set(key, geometry);
  }
  return cache.get(key);
}

/** Triangles of a side's kind of structure, for the budget. */
export function structureTriangles(side, kind) {
  return geometries(side, kind).triangles;
}

/** Triangles of each mesh of a structure: body, rings, orb. */
export function structureParts({ side, kind }) {
  return geometries(side, kind).parts;
}

function halo() {
  haloTexture ??= canvasTexture(128, 128, (g, w) => {
    const gradient = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.2, 'rgba(255, 255, 255, 0.4)');
    gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.08)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = gradient;
    g.fillRect(0, 0, w, w);
  });
  return haloTexture;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * Builds a structure's model.
 * `update(time, dt, fire)` runs every frame; `fire` is 1 right after a shot and
 * falls to 0 over about half a second. The orb rests at `def.muzzle`.
 */
export function buildStructure(def, { envMap }) {
  const side = def.side;
  const kind = def.kind;
  const d = DIMS[kind];
  const radiant = side === 'radiant';
  const geometry = geometries(side, kind);
  const options = { envMap, envIntensity: radiant ? 0.7 : 0.5, rim: TEAM[side], rimStrength: 0.45 };
  const bodyMaterial = surfaceMaterial(options);
  const ringMaterial = surfaceMaterial(options);
  const orbMaterial = surfaceMaterial(radiant ? { ...options, envIntensity: 1.1, physical: { clearcoat: 1, clearcoatRoughness: 0.08 } } : options);
  const haloMaterial = new THREE.SpriteMaterial({ map: halo(), color: radiant ? 0x59d2ff : 0xff6a14, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });

  const group = new THREE.Group();
  group.name = `${side}_${kind}`;
  const body = new THREE.Mesh(geometry.body, bodyMaterial);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const rings = d.rings.map(([y, , tilt], i) => {
    const mesh = new THREE.Mesh(geometry.rings[i], ringMaterial);
    mesh.position.y = y;
    mesh.rotation.order = 'ZXY';
    mesh.castShadow = i === 0;
    mesh.receiveShadow = false;
    group.add(mesh);
    return { mesh, tilt, angle: i * 2.1, speed: d.rings[i][3] };
  });

  const orb = new THREE.Group();
  orb.name = 'orb';
  orb.position.y = def.muzzle;
  const orbMesh = new THREE.Mesh(geometry.orb, orbMaterial);
  orbMesh.castShadow = false;
  orb.add(orbMesh);
  const glow = new THREE.Sprite(haloMaterial);
  glow.scale.setScalar(d.orbR * 7.5);
  orb.add(glow);
  group.add(orb);

  const seed = ((def.x ?? 0) * 0.37 + (def.z ?? 0) * 0.71) % TAU;
  const bodyPulse = bodyMaterial.userData.uniforms.uPulse;
  const ringPulse = ringMaterial.userData.uniforms.uPulse;
  const orbPulse = orbMaterial.userData.uniforms.uPulse;
  let spin = seed;

  return {
    group,
    orb,
    update(time, dt, fire = 0) {
      const f = clamp01(fire);
      const t = time + seed;
      // Rings turn faster for a moment after a shot and flash with the orb.
      for (const ring of rings) {
        ring.angle += dt * ring.speed * (1 + f * 5);
        const { mesh } = ring;
        mesh.rotation.y = ring.angle;
        mesh.rotation.x = Math.sin(t * 0.7 + ring.speed * 3) * 0.06;
        mesh.rotation.z = ring.tilt + Math.cos(t * 0.9 + ring.speed * 2) * 0.05;
        mesh.scale.setScalar(1 + f * f * 0.06);
      }
      // The orb bobs and turns; a shot kicks it down, swells it and springs it back.
      spin += dt * (0.9 + f * 6);
      const recoil = f * f * Math.cos((1 - f) * Math.PI * 1.5);
      orb.position.y = def.muzzle + Math.sin(t * 1.9) * 0.12 - recoil * d.orbR * 0.5;
      orb.position.x = Math.sin(time * 90) * 0.02 * f * f;
      orb.rotation.y = spin;
      orb.rotation.z = Math.sin(t * 1.3) * 0.08 + recoil * 0.18;
      orb.scale.setScalar(1 + Math.sin(t * 3.3) * 0.03 + f * f * 0.34);
      orbPulse.value = f * (radiant ? 0.7 : 1.2) + 0.12 * Math.sin(t * 3.3);
      ringPulse.value = f * 0.8;
      bodyPulse.value = f * 0.5;
      haloMaterial.opacity = (radiant ? 0.14 : 0.26) + f * 0.25 + 0.04 * Math.sin(t * 3.3);
      glow.scale.setScalar(d.orbR * (7.2 + f * 4));
    },
  };
}
