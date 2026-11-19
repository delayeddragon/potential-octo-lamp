/**
 * RuneDeck — scenery: everything that stands on the terrain without taking part in the fight.
 *
 * Bridges and the rune pad with its stairs, the canyon's rock walls, forests
 * that sway in the wind, kerbs and wildflowers along the roads, the Guardian's
 * cavern (the dragon itself is in dragon.js), the obsidian cliffs and their
 * lava falls, and the motes that drift through the air. All of it is merged
 * into a few static meshes; only the wind and the lava move.
 */

import * as THREE from 'three';

import { Batch, TAU, lean, pen, seededRandom } from './geometry.js';
import { LANES, LEVEL, MAP, STAIRS, STRUCTURES, TRAIL, bridgeDeck, inCavern, riverCenter, riverDistance, stairHeight, terrainHeight } from './shared.js';
import { LAVA_FALLS, PATH, pathDistance } from './terrain.js';
import { GLSL_TO_LINEAR } from './units.js';

const TORCH = { radiant: 0x59d2ff, dire: 0xff8a3a, warm: 0xffb347 };
const CYAN = { low: 0x0f9fc0, high: 0xcffcff, halo: 0x3fe8ff };
/** How far beyond the edge of the field props may stand: past this the ground has faded into the void. */
const RIM = 8.5;
/** The canyon's rockwork runs this far up and down the River, past both ends of the field. */
const GORGE = 32;

/** Whether a point lies in the course of a lava fall or its pool, widened by `pad`. */
function inLava(x, z, pad) {
  return LAVA_FALLS.some((fall) => {
    const along = (x - fall.x) * fall.dx + (z - fall.z) * fall.dz;
    const across = Math.abs((x - fall.x) * fall.dz - (z - fall.z) * fall.dx);
    return along > -1 && along < fall.length + 2 + pad && across < fall.width + pad;
  });
}

/* -------------------------------------------------------------------------- */
/* Bridges, rune pad and stairs                                               */
/* -------------------------------------------------------------------------- */

/** Slope of a bridge deck at `x`, as the angle its planks tilt by. */
function deckSlope(x, z0) {
  const e = 0.05;
  return Math.atan((bridgeDeck(x + e, z0) - bridgeDeck(x - e, z0)) / (2 * e));
}

/** The top lane's bridge: planks on trestles, with a lantern post at each corner. */
function woodenBridge(p, z0, kit) {
  const half = MAP.bridgeHalfLength;
  const deck = (x) => bridgeDeck(x, z0);
  const planks = [0x6b4526, 0x7a5230, 0x5d3b20];
  const count = 30;
  for (let i = 0; i < count; i++) {
    const x = -half + ((i + 0.5) * 2 * half) / count;
    p.box(planks[i % 3], x, deck(x) - 0.11, z0, (2 * half) / count - 0.05, 0.11, 4.9 + ((i * 5) % 3) * 0.08, {
      top: 0xa87a48,
      rz: deckSlope(x, z0),
      ry: ((i * 7) % 5) * 0.012 - 0.024,
    });
  }
  const posts = [-6.2, -4.1, -2.05, 0, 2.05, 4.1, 6.2];
  for (const side of [-1, 1]) {
    const z = z0 + side * 2.32;
    // Stringers under the deck.
    for (let i = 0; i < 10; i++) {
      const x = -half + ((i + 0.5) * 2 * half) / 10;
      p.box(0x432a16, x, deck(x) - 0.36, z, (2 * half) / 10 + 0.05, 0.25, 0.26, { top: 0x6b4526, rz: deckSlope(x, z0) });
    }
    posts.forEach((x, i) => {
      p.box(0x52351c, x, deck(x) - 0.25, z, 0.2, 1.3, 0.2, { top: 0x94683a });
      p.box(0x3a2412, x, deck(x) + 1.03, z, 0.3, 0.09, 0.3, { top: 0x6b4526 });
      if (i === 0) return;
      const from = posts[i - 1];
      const rise = deck(x) - deck(from);
      for (const up of [0.42, 0.82]) {
        p.box(0x6b4526, (from + x) / 2, (deck(x) + deck(from)) / 2 + up, z, Math.hypot(x - from, rise), 0.1, 0.1, {
          top: 0xa87a48,
          rz: Math.atan2(rise, x - from),
        });
      }
    });
    // Trestles stand in the current.
    for (const x of [-2.6, 2.6]) {
      const pile = z0 + side * 1.9;
      p.cyl(0x33200f, x, LEVEL.bed, pile, 0.19, 0.26, deck(x) - LEVEL.bed - 0.1, 6, { top: 0x52351c });
      p.box(0x3a2412, x, LEVEL.water + 0.75, z0 + side * 0.95, 0.14, 0.14, 2.2, { top: 0x6b4526, rx: side * 0.5 });
      kit.rocks.push({ x, z: pile, radius: 0.3 });
    }
    // A lantern post at each corner.
    for (const end of [-1, 1]) {
      const x = end * (half + 0.25);
      const corner = z0 + side * 2.6;
      p.cyl(0x3a2412, x, LEVEL.bridge - 0.1, corner, 0.14, 0.2, 2.3, 6, { top: 0x7a5230 });
      p.box(0x2b1a0e, x, LEVEL.bridge + 2.15, corner, 0.42, 0.1, 0.42, { top: 0x52351c });
      p.cyl(0x1c1410, x, LEVEL.bridge + 2.25, corner, 0.2, 0.13, 0.2, 6, { top: 0x3a2a20 });
      kit.addTorch(x, LEVEL.bridge + 2.62, corner, TORCH.warm, 1);
    }
  }
}

/** The bottom lane's bridge: a stone arch on two piers, with a brazier pillar at each corner. */
function stoneBridge(p, z0, kit) {
  const half = MAP.bridgeHalfLength;
  const deck = (x) => bridgeDeck(x, z0);
  const count = 16;
  const length = (2 * half) / count;
  for (let i = 0; i < count; i++) {
    const x = -half + (i + 0.5) * length;
    const stone = i % 2 ? 0x76818f : 0x6a7483;
    p.box(stone, x, deck(x) - 0.55, z0, length + 0.04, 0.55, 5.2, { top: i % 2 ? 0xb9c2ce : 0xa9b3c0, rz: deckSlope(x, z0) });
    for (const side of [-1, 1]) {
      p.box(0x7d8796, x, deck(x) - 0.05, z0 + side * 2.5, length + 0.04, 0.6, 0.34, { top: 0xcfd6df, rz: deckSlope(x, z0) });
      // Merlons on every other stone.
      if (i % 2) p.box(0x8d97a8, x, deck(x) + 0.52, z0 + side * 2.5, length * 0.6, 0.2, 0.4, { top: 0xdfe5ec, rz: deckSlope(x, z0) });
    }
  }
  for (const x of [-2.5, 2.5]) {
    p.box(0x525c6b, x, LEVEL.bed, z0, 1.2, deck(x) - 0.5 - LEVEL.bed, 4.6, { top: 0x7d8796 });
    // Cutwaters split the current on both faces of each pier.
    for (const side of [-1, 1]) {
      p.cyl(0x4a5362, x, LEVEL.bed, z0 + side * 2.5, 0.2, 0.75, 2.1, 4, { top: 0x7d8796, ry: Math.PI / 4 });
      kit.rocks.push({ x, z: z0 + side * 1.7, radius: 0.8 });
    }
    kit.rocks.push({ x, z: z0, radius: 0.8 });
  }
  for (const end of [-1, 1]) {
    for (const side of [-1, 1]) {
      const x = end * (half + 0.3);
      const z = z0 + side * 2.62;
      const flame = end < 0 ? TORCH.radiant : TORCH.dire;
      p.box(0x687282, x, LEVEL.bridge - 0.15, z, 0.72, 1.95, 0.72, { top: 0xb5bfcd });
      p.box(0x8d97a8, x, LEVEL.bridge + 1.8, z, 0.94, 0.16, 0.94, { top: 0xdfe5ec });
      p.cyl(0x2a303c, x, LEVEL.bridge + 1.96, z, 0.36, 0.22, 0.24, 8, { top: 0x596273 });
      kit.addTorch(x, LEVEL.bridge + 2.42, z, flame, 1.25);
    }
  }
}

/** The rune pad stands in the pool on a drum of masonry; a flight of stairs descends to it from each bank. */
function runePad(p, kit) {
  const top = LEVEL.pad;
  p.cyl(0x4d5d72, 0, LEVEL.bed, 0, 3.55, 4.2, top - LEVEL.bed, 10, { top: 0x9fb0c4 });
  // Four-sided cylinders read as diamonds from above.
  p.cyl(0x38445a, 0, top, 0, 2.84, 3.0, 0.05, 4, { top: 0x6f8196 });
  p.cyl(0x39d8f2, 0, top + 0.05, 0, 2.4, 2.4, 0.03, 4, { glow: true, top: 0x9ff7ff });
  p.cyl(0x2a3446, 0, top + 0.05, 0, 2.12, 2.12, 0.04, 4, { top: 0x46546a });
  p.cyl(0x7af3ff, 0, top + 0.09, 0, 0.8, 0.8, 0.025, 4, { glow: true, top: 0xe6ffff });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + TAU / 8;
    const x = Math.cos(a) * 3.2;
    const z = Math.sin(a) * 3.2;
    p.cone(0x5e7088, x, top, z, 0.3, 1.5, 4, { top: 0xcfe0ee });
    p.gem(0x7af3ff, x, top + 1.5, z, 0.14, 0.42, { glow: true, top: 0xffffff });
    kit.addHalo(x, top + 1.7, z, 1.8, 0x7af3ff, 0.4);
  }
  kit.rocks.push({ x: 0, z: 0, radius: 3.9 });

  const steps = 12;
  const depth = (STAIRS.top - STAIRS.foot) / steps;
  for (const side of [-1, 1]) {
    for (let i = 0; i < steps; i++) {
      const near = STAIRS.foot + i * depth;
      const y = stairHeight(near + depth);
      const stone = i % 2 ? 0x66758a : 0x5b6a80;
      p.box(stone, side * (near + depth / 2), LEVEL.bed, 0, depth + 0.02, y - LEVEL.bed, 3.5, { top: i % 2 ? 0xb4c2d0 : 0xa3b2c2 });
      // A low wall on each flank, stepping down with the treads.
      for (const flank of [-1, 1]) {
        p.box(0x4f5d70, side * (near + depth / 2), y - 0.3, flank * 1.86, depth + 0.02, 0.62, 0.3, { top: 0x93a3b6 });
      }
    }
    kit.rocks.push({ x: side * 5.3, z: 0, radius: 1.75 });
    // Newel posts at the head of the stairs carry the pool's own cold flame.
    for (const flank of [-1, 1]) {
      const x = side * (STAIRS.top + 0.25);
      const z = flank * 2.0;
      const y = terrainHeight(x, z);
      p.box(0x5e6c80, x, y - 0.2, z, 0.5, 1.6, 0.5, { top: 0xb9c7d6 });
      p.box(0x8796aa, x, y + 1.4, z, 0.66, 0.12, 0.66, { top: 0xdce6ef });
      kit.addTorch(x, y + 1.9, z, TORCH.radiant, 0.9);
    }
  }
}

/** Boulders in the current: the water shader wraps each in foam and ripples. */
function riverRocks(p, kit, random) {
  let made = 0;
  for (let tries = 0; tries < 400 && made < 9; tries++) {
    const z = (random() * 2 - 1) * 23;
    // Clear of the bridges and of the rune pool.
    if (Math.abs(Math.abs(z) - MAP.laneZ) < 4.4 || Math.abs(z) < 8.8) continue;
    const x = riverCenter(z) + (random() - 0.5) * 4.6;
    if (riverDistance(x, z) > -1.5 || kit.rocks.some((rock) => Math.hypot(rock.x - x, rock.z - z) < rock.radius + 2.2)) continue;
    const r = 0.5 + random() * 0.55;
    const dire = x > riverCenter(z);
    p.rock(dire ? 0x1a161f : 0x4d5868, x, LEVEL.water + r * 0.12, z, r, { top: dire ? 0x5a4a66 : 0xaab6c5, sy: 0.7 + random() * 0.3, ry: random() * TAU });
    if (random() < 0.6) p.rock(dire ? 0x15121a : 0x445061, x + r * 0.8, LEVEL.water, z + r * 0.5, r * 0.5, { top: dire ? 0x4a3d58 : 0x97a4b4, ry: random() * TAU });
    kit.rocks.push({ x, z, radius: r * 0.92 });
    made++;
  }
  // Two more break the surface of the rune pool, clear of the stairs.
  for (const angle of [1.15, 4.4]) {
    const x = Math.cos(angle) * 5.4;
    const z = Math.sin(angle) * 5.4;
    p.rock(0x4d5868, x, LEVEL.water + 0.08, z, 0.62, { top: 0xaab6c5, sy: 0.75, ry: angle });
    kit.rocks.push({ x, z, radius: 0.58 });
  }
}

/* -------------------------------------------------------------------------- */
/* Canyon walls                                                               */
/* -------------------------------------------------------------------------- */

/** X of the point on one bank (`side` -1 or 1) at depth `z` where the signed distance to the water is `shore`. */
function bankX(z, side, shore) {
  let inner = riverCenter(z);
  let outer = inner + side * 14;
  for (let i = 0; i < 22; i++) {
    const mid = (inner + outer) / 2;
    if (riverDistance(mid, z) < shore) inner = mid;
    else outer = mid;
  }
  return (inner + outer) / 2;
}

/**
 * Rock sculpted onto both banks of the River: boulders perched on the lip,
 * buttresses leaning on the wall and scree at the waterline, so the gorge
 * reads as carved stone rather than a smooth slope.
 */
function canyonWalls(p, random) {
  for (let z = -GORGE; z <= GORGE; z += 1.15 + random() * 0.5) {
    // The bridges and the stairs have their own stonework.
    if (Math.abs(Math.abs(z) - MAP.laneZ) < 3.3 || Math.abs(z) < 3.1) continue;
    for (const side of [-1, 1]) {
      const dire = side > 0;
      const dark = dire ? 0x120f16 : 0x424d5d;
      const pale = dire ? 0x54445f : 0xa3afbf;
      const lip = bankX(z, side, 0.08);
      const rim = terrainHeight(lip + side * 0.6, z);
      if (random() < 0.8) {
        const r = 0.34 + random() * 0.4;
        p.rock(dark, lip, rim + r * 0.15, z, r, { top: pale, sy: 0.7 + random() * 0.5, ry: random() * TAU });
        if (!dire && random() < 0.4) p.rock(0x17703f, lip + side * 0.2, rim + r * 0.75, z + 0.1, r * 0.5, { top: 0x62cf83, sy: 0.6 });
      }
      // A buttress: a tall slab leaning back against the wall.
      if (random() < 0.7) {
        const r = 0.5 + random() * 0.45;
        const x = bankX(z + 0.4, side, -0.5);
        p.rock(dark, x, rim - 1.25 - random() * 0.5, z + 0.4, r, {
          top: pale,
          sx: 0.8,
          sy: 1.7 + random() * 0.9,
          sz: 1.2 + random() * 0.6,
          ry: random() * 0.6,
          rz: side * (0.2 + random() * 0.15),
        });
      }
      if (random() < 0.6) {
        const r = 0.3 + random() * 0.35;
        p.rock(dark, bankX(z - 0.3, side, -0.95), LEVEL.water + r * 0.1, z - 0.3, r, { top: pale, sy: 0.7, ry: random() * TAU });
      }
      // Here and there a spur of harder rock stands proud of the wall as a pinnacle.
      if (random() < 0.13) {
        const x = bankX(z, side, -0.35);
        p.cone(dark, x, LEVEL.water - 0.3, z, 0.55 + random() * 0.3, rim - LEVEL.water + 0.5 + random() * 0.7, 5, { top: pale, ...lean(random() * TAU, 0.08) });
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Forests, rocks and crystals                                                */
/* -------------------------------------------------------------------------- */

/** Trees, crystals, rocks and the rim that frames the arena. `tree` draws into the wind-swayed batch. */
function scatterScenery(p, tree, kit, random) {
  const taken = [];
  const free = (x, z, gap) => taken.every(([tx, tz, tg]) => Math.hypot(x - tx, z - tz) > gap + tg);
  const clear = (x, z, pad) =>
    pathDistance(x, z) > pad &&
    riverDistance(x, z) > pad + 0.4 &&
    !inCavern(x, z, 0.8 + pad) &&
    STRUCTURES.every((s) => Math.hypot(x - s.x, z - s.z) > s.radius + pad + 1) &&
    !inLava(x, z, pad);
  const inside = (x, z) => Math.abs(x) < MAP.halfWidth + 0.4 && Math.abs(z) < MAP.halfDepth + 0.4;
  // Nothing tall may stand along the near edge, where it would hide the field from the camera.
  const hides = (z) => z > MAP.halfDepth - 1;

  /**
   * `openField` is the chance a prop may stand inside the playable area, which
   * stays mostly clear. `tall` props keep off the near edge and off slopes too steep to root in.
   */
  const scatter = (count, sign, gap, pad, openField, tall, build) => {
    let made = 0;
    for (let tries = 0; tries < count * 60 && made < count; tries++) {
      const x = sign * (6.4 + random() * (MAP.halfWidth + RIM - 6.4));
      const z = (random() * 2 - 1) * (MAP.halfDepth + RIM);
      if (!clear(x, z, pad) || !free(x, z, gap)) continue;
      if (inside(x, z) && random() > openField) continue;
      const y = terrainHeight(x, z);
      if (tall && (hides(z) || Math.abs(terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z)) + Math.abs(terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5)) > 1.5)) continue;
      // A builder may turn the spot down by returning false.
      if (build(x, y, z) === false) continue;
      taken.push([x, z, gap]);
      made++;
    }
  };

  // --- Radiant: forest, bushes, boulders and blue crystal outcrops.
  scatter(26, -1, 0.7, 1.3, 0.7, false, (x, y, z) => {
    const s = 0.8 + random() * 0.6;
    const count = 3 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const a = random() * TAU;
      const d = i === 0 ? 0 : (0.25 + random() * 0.25) * s;
      const h = (i === 0 ? 1.6 : 0.6 + random() * 0.7) * s;
      p.crystal(0x1a68cc, x + Math.cos(a) * d, y - 0.05, z + Math.sin(a) * d, (i === 0 ? 0.2 : 0.14) * s, h, {
        glow: true,
        top: 0xb9f4ff,
        ...lean(a, i === 0 ? 0.08 : 0.3 + random() * 0.3),
      });
    }
    kit.addHalo(x, y + 0.9 * s, z, 3.4 * s, 0x3fb8ff, 0.42);
  });
  scatter(215, -1, 0.75, 1.7, 0.045, true, (x, y, z) => {
    const s = 0.85 + random() * 0.85;
    const ry = random() * TAU;
    const dark = [0x0f5a34, 0x147046, 0x0d6b4f][Math.floor(random() * 3)];
    tree.sway(y);
    tree.pen.cyl(0x4a3020, x, y - 0.1, z, 0.1 * s, 0.16 * s, 0.7 * s, 5, { top: 0x6b4830 });
    if (random() < 0.74) {
      // A pine: four tiers of boughs, each a little smaller and lighter than the one below.
      tree.pen.cone(dark, x, y + 0.4 * s, z, 0.86 * s, 1.15 * s, 7, { top: 0x2f9c5c, ry });
      tree.pen.cone(dark, x, y + 1.0 * s, z, 0.7 * s, 1.05 * s, 7, { top: 0x3aab64, ry: ry + 0.4 });
      tree.pen.cone(dark, x, y + 1.6 * s, z, 0.52 * s, 0.95 * s, 7, { top: 0x45b96e, ry: ry + 0.8 });
      tree.pen.cone(dark, x, y + 2.15 * s, z, 0.34 * s, 0.9 * s, 6, { top: 0x7fe0a0, ry: ry + 1.2 });
    } else {
      tree.pen.rock(dark, x, y + 1.25 * s, z, 0.9 * s, { top: 0x6fd690, ry, sy: 0.9 });
      tree.pen.rock(dark, x + 0.42 * s, y + 0.95 * s, z + 0.2 * s, 0.52 * s, { top: 0x55c47c, ry });
    }
  });
  scatter(70, -1, 0.4, 1.0, 0.5, false, (x, y, z) => {
    const r = 0.26 + random() * 0.26;
    p.rock(0x17703f, x, y + r * 0.5, z, r, { top: 0x62cf83, sy: 0.75, ry: random() * TAU });
  });
  scatter(46, -1, 0.5, 1.0, 0.4, false, (x, y, z) => {
    const r = 0.3 + random() * 0.4;
    p.rock(0x5d687b, x, y + r * 0.35, z, r, { top: 0xb7c1d0, sy: 0.7, ry: random() * TAU });
  });
  // Ferns and long grass, low enough to walk through.
  scatter(170, -1, 0.3, 0.5, 1, false, (x, y, z) => {
    const s = 0.7 + random() * 0.6;
    for (let i = 0; i < 4; i++) {
      const a = random() * TAU;
      p.cone(0x0d5a2c, x + Math.cos(a) * 0.12 * s, y - 0.04, z + Math.sin(a) * 0.12 * s, 0.07 * s, (0.3 + random() * 0.25) * s, 3, {
        top: 0x6fd27c,
        ...lean(a, 0.35 + random() * 0.4),
      });
    }
  });

  // --- Dire: obsidian shards, molten crystals, charred trees and slag.
  scatter(24, 1, 0.7, 1.3, 0.7, false, (x, y, z) => {
    const s = 0.8 + random() * 0.6;
    const count = 3 + Math.floor(random() * 2);
    for (let i = 0; i < count; i++) {
      const a = random() * TAU;
      const d = i === 0 ? 0 : (0.25 + random() * 0.25) * s;
      const h = (i === 0 ? 1.3 : 0.5 + random() * 0.6) * s;
      p.crystal(0xd8320e, x + Math.cos(a) * d, y - 0.05, z + Math.sin(a) * d, (i === 0 ? 0.2 : 0.14) * s, h, {
        glow: true,
        top: 0xffd27a,
        ...lean(a, i === 0 ? 0.1 : 0.3 + random() * 0.3),
      });
    }
    kit.addHalo(x, y + 0.8 * s, z, 3.4 * s, 0xff5a1a, 0.42);
  });
  scatter(150, 1, 0.6, 1.5, 0.07, true, (x, y, z) => {
    const s = 0.7 + random() * 0.9;
    const a = random() * TAU;
    p.cone(0x0f0c13, x, y - 0.1, z, 0.34 * s, 2.0 * s, 4, { top: 0x6a5880, ...lean(a, random() * 0.3) });
    if (random() < 0.6) {
      p.cone(0x120f16, x + Math.cos(a) * 0.45 * s, y - 0.1, z + Math.sin(a) * 0.45 * s, 0.24 * s, 1.1 * s, 4, {
        top: 0x57466a,
        ...lean(a, 0.35 + random() * 0.2),
      });
    }
  });
  scatter(30, 1, 0.7, 1.5, 0.25, true, (x, y, z) => {
    const s = 0.9 + random() * 0.5;
    p.cyl(0x1a1216, x, y, z, 0.07 * s, 0.17 * s, 1.9 * s, 5, { top: 0x45343a, rz: (random() - 0.5) * 0.2 });
    for (let i = 0; i < 3; i++) {
      const a = random() * TAU;
      p.cyl(0x1a1216, x, y + (0.9 + i * 0.35) * s, z, 0.03 * s, 0.06 * s, 0.8 * s, 4, { top: 0x45343a, ...lean(a, 0.9) });
    }
  });
  scatter(64, 1, 0.5, 1.0, 0.4, false, (x, y, z) => {
    const r = 0.3 + random() * 0.45;
    p.rock(0x15121a, x, y + r * 0.35, z, r, { top: 0x4a3d58, sy: 0.7, ry: random() * TAU });
  });
  // Cinder cones and splinters of glass, low enough to walk through; a few still glow.
  scatter(150, 1, 0.3, 0.5, 1, false, (x, y, z) => {
    const s = 0.7 + random() * 0.6;
    const hot = random() < 0.16;
    for (let i = 0; i < 3; i++) {
      const a = random() * TAU;
      p.cone(hot && i === 0 ? 0xc8300c : 0x0f0c13, x + Math.cos(a) * 0.14 * s, y - 0.04, z + Math.sin(a) * 0.14 * s, 0.08 * s, (0.22 + random() * 0.25) * s, 4, {
        glow: hot && i === 0,
        top: hot && i === 0 ? 0xffc86a : 0x5a4a6e,
        ...lean(a, 0.3 + random() * 0.4),
      });
    }
  });
  // Spires crown the upper ledges of the cliffs.
  scatter(70, 1, 0.9, 0.6, 0, true, (x, y, z) => {
    if (y < 4) return false;
    const s = 1.1 + random() * 1.3;
    const a = random() * TAU;
    p.cone(0x0d0a11, x, y - 0.3, z, 0.5 * s, 2.6 * s, 4, { top: 0x6a5880, ...lean(a, random() * 0.22) });
    p.cone(0x120f16, x + Math.cos(a) * 0.6 * s, y - 0.3, z + Math.sin(a) * 0.6 * s, 0.34 * s, 1.5 * s, 4, { top: 0x57466a, ...lean(a, 0.3) });
    if (random() < 0.3) p.crystal(0xd8320e, x - Math.cos(a) * 0.5 * s, y - 0.1, z - Math.sin(a) * 0.5 * s, 0.16 * s, 1.0 * s, { glow: true, top: 0xffd27a, ...lean(a + Math.PI, 0.3) });
  });

  // --- Rim: a broken wall of rock around the playable field.
  const edgeX = MAP.halfWidth + 0.8;
  const edgeZ = MAP.halfDepth + 0.8;
  const rim = (x, z) => {
    if (riverDistance(x, z) < 1.4 || inCavern(x, z, 0.6) || inLava(x, z, 0.6)) return;
    const dire = x > riverCenter(z);
    const r = 0.45 + random() * 0.5;
    const jx = x + (random() - 0.5) * 0.5;
    const jz = z + (random() - 0.5) * 0.5;
    const y = terrainHeight(jx, jz);
    p.rock(dire ? 0x110e15 : 0x4f5a6c, jx, y + r * 0.3, jz, r, { top: dire ? 0x54445f : 0xaab5c4, sy: 0.8 + random() * 0.5, ry: random() * TAU });
    if (dire && !hides(z) && random() < 0.4) p.cone(0x0f0c13, jx, y, jz, 0.26, 1.2 + random(), 4, { top: 0x6a5880, ...lean(random() * TAU, 0.2) });
    if (!dire && random() < 0.3) p.rock(0x17703f, jx + 0.3, y + r * 0.9, jz, r * 0.45, { top: 0x62cf83 });
  };
  for (let x = -edgeX; x <= edgeX; x += 1.25) {
    rim(x, -edgeZ);
    rim(x, edgeZ);
  }
  for (let z = -edgeZ + 1.25; z < edgeZ; z += 1.25) {
    rim(-edgeX, z);
    rim(edgeX, z);
  }
}

/**
 * The verges of every road. Radiant's are held by mossy curbstones with grass
 * and wildflowers pressing in behind them; Dire's are a litter of slag and
 * glass, with here and there an ember still alight.
 */
function roadVerges(p, random) {
  const PETALS = [0xbff2ff, 0xffe680, 0xff9ec6, 0xffffff];
  const edge = (points, halfWidth) => {
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1];
      const [bx, bz] = points[i];
      const length = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / length;
      const dz = (bz - az) / length;
      for (let along = random() * 0.6; along < length; along += 0.75 + random() * 0.5) {
        for (const side of [-1, 1]) {
          if (random() < 0.3) continue;
          const out = halfWidth + 0.05 + random() * 0.3;
          const x = ax + dx * along - dz * side * out;
          const z = az + dz * along + dx * side * out;
          // Not on the bridges, the stairs or the ramps down to them, nor where another road or a plaza takes over.
          if (Math.abs(x) < 12 || Math.abs(x) > MAP.halfWidth - 1 || pathDistance(x, z) < -0.25 || riverDistance(x, z) < 1) continue;
          const y = terrainHeight(x, z);
          const turn = Math.atan2(-dz, dx) + (random() - 0.5) * 0.5;
          if (x < 0) {
            const mossy = random() < 0.45;
            p.box(mossy ? 0x3f5a44 : 0x5b6470, x, y - 0.08, z, 0.45 + random() * 0.4, 0.2 + random() * 0.12, 0.28 + random() * 0.14, {
              top: mossy ? 0x6fae6a : 0xb4bcc6,
              ry: turn,
              rz: (random() - 0.5) * 0.25,
              rx: (random() - 0.5) * 0.2,
            });
            if (random() < 0.5) {
              // Grass and a flower or two behind the stone.
              const gx = x - dz * side * (0.4 + random() * 0.5);
              const gz = z + dx * side * (0.4 + random() * 0.5);
              const gy = terrainHeight(gx, gz);
              for (let blade = 0; blade < 3; blade++) {
                const a = random() * TAU;
                p.cone(0x0d5a2c, gx + Math.cos(a) * 0.1, gy - 0.03, gz + Math.sin(a) * 0.1, 0.06, 0.28 + random() * 0.2, 3, { top: 0x7fdc86, ...lean(a, 0.4) });
              }
              if (random() < 0.55) {
                p.cyl(0x2f8a45, gx, gy, gz, 0.015, 0.02, 0.3, 3);
                p.gem(PETALS[Math.floor(random() * PETALS.length)], gx, gy + 0.27, gz, 0.085, 0.11, { sy: 0.9 });
              }
            }
          } else {
            const a = random() * TAU;
            const hot = random() < 0.12;
            p.cone(0x0f0c13, x, y - 0.06, z, 0.16 + random() * 0.12, 0.3 + random() * 0.3, 4, { top: 0x5a4a6e, ry: turn, ...lean(a, 0.3 + random() * 0.3) });
            if (hot) p.rock(0xd8320e, x - dz * side * 0.3, y + 0.05, z + dx * side * 0.3, 0.11, { glow: true, top: 0xffc86a });
            else if (random() < 0.4) p.rock(0x15121a, x - dz * side * 0.35, y + 0.05, z + dx * side * 0.35, 0.16, { top: 0x4a3d58, sy: 0.6 });
          }
        }
      }
    }
  };
  for (const lane of [LANES.top, LANES.bottom]) edge(lane.map((point) => [point.x, point.z]), PATH.lane);
  edge(TRAIL, PATH.trail);
  edge(TRAIL.map(([x, z]) => [-x, z]), PATH.trail);
}

/* -------------------------------------------------------------------------- */
/* The Guardian's cavern                                                      */
/* -------------------------------------------------------------------------- */

/** Crags, giant crystals and a fence of stone teeth around the pit; the dragon itself is built separately. */
function cavern(p, kit, random) {
  const { x: cx, z: cz, radius, pit, mouth } = MAP.cavern;
  const at = (angle, r) => [cx + Math.cos(angle) * r, cz + Math.sin(angle) * r];
  /** How far a bearing is from the middle of the mouth, 0..π. */
  const offMouth = (angle) => Math.abs(((angle - mouth + Math.PI * 3) % TAU) - Math.PI);

  // Crags heaped along the crest of the horseshoe, and boulders spilled down its flanks.
  for (let angle = 0; angle < TAU; angle += 0.21) {
    if (offMouth(angle) < 1.02) continue;
    const [x, z] = at(angle + (random() - 0.5) * 0.1, radius - 1.5 + (random() - 0.5) * 0.9);
    const y = terrainHeight(x, z);
    const r = 0.9 + random() * 0.8;
    p.rock(0x3b4553, x, y + r * 0.1, z, r, { top: 0xa9b6c6, sy: 1.1 + random() * 0.9, ry: random() * TAU, ...lean(angle, 0.1) });
    if (random() < 0.6) {
      const [sx, sz] = at(angle + 0.1, radius - 0.2 + random() * 0.5);
      const s = 0.5 + random() * 0.5;
      p.rock(0x3f4a59, sx, terrainHeight(sx, sz) + s * 0.2, sz, s, { top: 0x97a5b6, sy: 0.8, ry: random() * TAU });
    }
    if (random() < 0.35) p.rock(0x17703f, x, y + r * 1.1, z, r * 0.4, { top: 0x62cf83, sy: 0.6 });
  }

  // Giant crystals: on the crest, flanking the mouth, and rooted in the back of the pit.
  const cluster = (angle, r, size) => {
    const [x, z] = at(angle, r);
    const y = terrainHeight(x, z) - 0.3;
    p.crystal(CYAN.low, x, y, z, 0.55 * size, 4.4 * size, { glow: true, top: CYAN.high, ...lean(angle, 0.1 + random() * 0.12) });
    const spikes = 3 + Math.floor(random() * 3);
    for (let i = 0; i < spikes; i++) {
      const a = random() * TAU;
      const d = (0.5 + random() * 0.45) * size;
      p.crystal(CYAN.low, x + Math.cos(a) * d, y, z + Math.sin(a) * d, (0.22 + random() * 0.14) * size, (1.4 + random() * 1.6) * size, {
        glow: true,
        top: CYAN.high,
        ...lean(a, 0.3 + random() * 0.35),
      });
    }
    kit.addHalo(x, y + 2.6 * size, z, 9 * size, CYAN.halo, 0.5);
  };
  for (const [angle, r, size] of [
    [mouth + 1.2, radius - 0.5, 1.0],
    [mouth - 1.2, radius - 0.5, 1.1],
    [mouth + 2.0, radius - 1.4, 1.25],
    [mouth + 2.75, radius - 1.6, 0.95],
    [mouth - 2.75, radius - 1.5, 1.3],
    [mouth - 2.0, radius - 1.4, 1.0],
    [mouth + Math.PI, radius - 1.2, 1.15],
    [mouth + 2.5, pit - 0.5, 0.6],
    [mouth - 2.6, pit - 0.6, 0.7],
  ]) {
    cluster(angle, r, size);
  }

  // A fence of fangs across the mouth: nothing walks in, and nothing inside looks likely to walk out.
  for (let angle = mouth - 0.92; angle <= mouth + 0.92; angle += 0.155) {
    const [x, z] = at(angle, radius - 0.25 + (random() - 0.5) * 0.3);
    const y = terrainHeight(x, z);
    if (random() < 0.45) {
      p.crystal(CYAN.low, x, y - 0.1, z, 0.16, 0.9 + random() * 0.7, { glow: true, top: CYAN.high, ...lean(angle, 0.25) });
    } else {
      p.cone(0x47525f, x, y - 0.1, z, 0.3, 0.9 + random() * 0.6, 5, { top: 0xb7c3d0, ...lean(angle, 0.2 + random() * 0.2) });
    }
  }
  // Old bones on the slope into the pit.
  for (let i = 0; i < 6; i++) {
    const [x, z] = at(mouth + (random() - 0.5) * 1.1, pit + 0.6 + random() * 1.2);
    const y = terrainHeight(x, z);
    p.cone(0xb9b09a, x, y - 0.05, z, 0.07, 0.8 + random() * 0.6, 4, { top: 0xf0e8d2, ...lean(random() * TAU, 0.9 + random() * 0.4) });
  }
}

/* -------------------------------------------------------------------------- */
/* Lava falls                                                                 */
/* -------------------------------------------------------------------------- */

const LAVA_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LAVA_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec2 vUv;   // x: across the stream, y: distance travelled down it, in world units
${GLSL_TO_LINEAR}
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float flow(vec2 p) {
  return vnoise(p) * 0.6 + vnoise(p * 2.1 + 7.0) * 0.4;
}
void main() {
  float across = abs(vUv.x - 0.5) * 2.0;
  float sheet = flow(vec2(vUv.x * 3.0, vUv.y * 0.9 - uTime * 1.5));
  float braid = flow(vec2(vUv.x * 7.0 + sheet, vUv.y * 2.2 - uTime * 2.5));
  float heat = clamp(0.30 + 0.85 * braid - 0.30 * across, 0.0, 1.0);
  vec3 c = mix(vec3(0.78, 0.07, 0.01), vec3(1.0, 0.74, 0.22), heat);
  // Rafts of dark crust ride the flow.
  float crust = smoothstep(0.60, 0.74, flow(vec2(vUv.x * 4.0 + 9.0, vUv.y * 1.3 - uTime * 1.05)));
  c = mix(c, vec3(0.13, 0.03, 0.02), crust * 0.75);
  float edge = smoothstep(1.0, 0.50 + 0.35 * sheet, across);
  gl_FragColor = vec4(toLinear(c) * (1.0 + 1.3 * heat * (1.0 - crust)), edge);
  #include <colorspace_fragment>
}
`;

/** Ribbons of molten rock draped down the Dire cliffs. Returns their meshes and a per-frame `update(time)`. */
export function buildLavaFalls({ addHalo }) {
  const time = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: time },
    vertexShader: LAVA_VERTEX,
    fragmentShader: LAVA_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const meshes = LAVA_FALLS.map((fall) => {
    const stations = 44;
    const positions = [];
    const uvs = [];
    const index = [];
    let travelled = 0;
    let before = null;
    for (let i = 0; i <= stations; i++) {
      const along = (i / stations) * fall.length;
      const x = fall.x + fall.dx * along;
      const z = fall.z + fall.dz * along;
      const y = terrainHeight(x, z) + 0.12;
      if (before) travelled += Math.hypot(x - before.x, y - before.y, z - before.z);
      before = { x, y, z };
      // The stream spreads as it nears its pool.
      const half = (fall.width / 2) * (0.8 + 0.5 * (i / stations) ** 3);
      for (const side of [-1, 1]) {
        const vx = x - fall.dz * side * half;
        const vz = z + fall.dx * side * half;
        positions.push(vx, Math.max(y - 0.25, terrainHeight(vx, vz) + 0.12), vz);
        uvs.push(side * 0.5 + 0.5, travelled);
      }
      if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2 + 1, i * 2 - 2, i * 2 + 1, i * 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -1;

    // Each drop throws its own light, and the pool at the foot glows brightest.
    for (const share of [0.12, 0.5, 1]) {
      const x = fall.x + fall.dx * fall.length * share;
      const z = fall.z + fall.dz * fall.length * share;
      addHalo(x, terrainHeight(x, z) + 0.8, z, share === 1 ? 7.5 : 5.5, 0xff5a1a, share === 1 ? 0.6 : 0.4);
    }
    return mesh;
  });
  return {
    meshes,
    update(seconds) {
      time.value = seconds;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Builds every static prop into the given batches.
 * @param kit.solid, kit.glow   batches for lit and for glowing geometry
 * @param kit.foliage           batch for trees, drawn with the wind-swayed material
 * @param kit.addHalo           (x, y, z, size, color, opacity) => sprite
 * @param kit.addTorch          (x, y, z, color, size): a flickering flame
 * @returns {{ rocks: { x: number, z: number, radius: number }[] }} what stands in the River, for the water's foam
 */
export function buildScenery({ solid, glow, foliage, addHalo, addTorch }) {
  const random = seededRandom(20_261_118);
  const kit = { addHalo, addTorch, rocks: [] };
  const p = pen(solid, glow);
  const tree = {
    pen: pen(foliage, glow),
    /** Marks the ground the next tree stands on: everything above it sways. */
    sway(y) {
      foliage.swayBase = y;
    },
  };
  woodenBridge(p, -MAP.laneZ, kit);
  stoneBridge(p, MAP.laneZ, kit);
  runePad(p, kit);
  riverRocks(p, kit, random);
  canyonWalls(p, random);
  scatterScenery(p, tree, kit, random);
  roadVerges(p, random);
  cavern(p, kit, random);
  return { rocks: kit.rocks };
}

/* -------------------------------------------------------------------------- */
/* Motes in the air                                                           */
/* -------------------------------------------------------------------------- */

const PARTICLE_VERTEX = /* glsl */ `
attribute vec4 aSeed;   // x: cycles per second, y: sway, z: phase, w: size in world units
attribute vec3 aColor;
attribute float aRise;
uniform float uTime;
uniform float uPixels;  // device pixels that one world unit covers at a distance of one unit
varying vec3 vColor;
varying float vAlpha;
void main() {
  float life = fract(uTime * aSeed.x + aSeed.z);
  vec3 p = position;
  p.y += life * aRise;
  p.x += sin(uTime * (0.6 + aSeed.x * 3.0) + aSeed.z * 40.0) * aSeed.y;
  p.z += cos(uTime * (0.5 + aSeed.x * 2.0) + aSeed.z * 23.0) * aSeed.y * 0.6;
  vAlpha = sin(life * 3.14159) * (0.55 + 0.45 * sin(uTime * 4.0 + aSeed.z * 90.0));
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  // Nearer motes are drawn larger: this is what gives the air its depth.
  gl_PointSize = max(aSeed.w * uPixels / gl_Position.w, 1.5);
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
${GLSL_TO_LINEAR}
void main() {
  float falloff = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(toLinear(vColor) * 1.600, falloff * falloff * vAlpha);
  #include <colorspace_fragment>
}
`;

/**
 * Motes, embers, fireflies and spray. `sources` adds point emitters:
 * [{ x, y, z, spread, rise, color: [from, to], count, size }].
 */
export function buildParticles(sources = []) {
  const random = seededRandom(77);
  const ambient = 1500;
  const count = ambient + sources.reduce((sum, source) => sum + source.count, 0);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const rises = new Float32Array(count);
  const color = new THREE.Color();
  const tint = new THREE.Color();
  const mix = (from, to, t) => color.setHex(from, THREE.LinearSRGBColorSpace).lerp(tint.setHex(to, THREE.LinearSRGBColorSpace), t);
  const reachX = MAP.halfWidth + RIM - 6;
  const reachZ = MAP.halfDepth + RIM - 2;

  let i = 0;
  const put = (x, y, z, speed, sway, size, rise) => {
    positions.set([x, y, z], i * 3);
    seeds.set([speed, sway, random(), size], i * 4);
    colors.set([color.r, color.g, color.b], i * 3);
    rises[i] = rise;
    i++;
  };
  for (; i < ambient; ) {
    const z = (random() * 2 - 1) * reachZ;
    if (i < 300) {
      // Radiant motes: slow, drifting, blue-green.
      const x = -5.6 - random() * reachX;
      mix(0x8fe8ff, 0xcfffd8, random());
      put(x, terrainHeight(x, z) + 0.2 + random() * 1.4, z, 0.05 + random() * 0.07, 0.3 + random() * 0.5, 0.1 + random() * 0.12, 3 + random() * 2);
    } else if (i < 660) {
      // Dire embers: faster, hotter.
      const x = 5.6 + random() * reachX;
      mix(0xff5a1a, 0xffc04a, random());
      put(x, terrainHeight(x, z) + 0.2 + random() * 1.4, z, 0.12 + random() * 0.18, 0.15 + random() * 0.35, 0.07 + random() * 0.1, 4 + random() * 3);
    } else if (i < 960) {
      // Fireflies over the Radiant woods: they wander at head height and blink rather than rise.
      const x = -7 - random() * (reachX - 2);
      mix(0xd8ff7a, 0xfff2a0, random());
      put(x, terrainHeight(x, z) + 0.8 + random() * 3.6, z, 0.02 + random() * 0.03, 1.1 + random() * 1.6, 0.13 + random() * 0.12, (random() - 0.5) * 1.2);
    } else if (i < 1300) {
      // Embers carried high over the Dire wastes, well above the units.
      const x = 6 + random() * (reachX - 1);
      mix(0xff3a10, 0xffb040, random());
      put(x, terrainHeight(x, z) + 1 + random() * 3, z, 0.06 + random() * 0.1, 0.5 + random() * 0.9, 0.09 + random() * 0.14, 6 + random() * 6);
    } else {
      // River sparkles: low over the water.
      mix(0xa8fbff, 0xffffff, random() * 0.5);
      put(riverCenter(z) + (random() - 0.5) * 6.2, LEVEL.water + 0.1, z, 0.15 + random() * 0.2, 0.1, 0.08 + random() * 0.08, 0.8 + random() * 0.8);
    }
  }
  for (const source of sources) {
    for (let n = 0; n < source.count; n++) {
      mix(source.color[0], source.color[1], random());
      put(
        source.x + (random() - 0.5) * source.spread,
        source.y + random() * 0.3,
        source.z + (random() - 0.5) * source.spread,
        0.18 + random() * 0.3,
        0.05 + random() * 0.2,
        source.size * (0.7 + random() * 0.6),
        source.rise * (0.6 + random() * 0.8),
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aRise', new THREE.BufferAttribute(rises, 1));
  const uniforms = { uTime: { value: 0 }, uPixels: { value: 30 } };
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  // The vertex shader moves points outside the bounds Three.js would compute.
  points.frustumCulled = false;
  return { points, uniforms };
}
