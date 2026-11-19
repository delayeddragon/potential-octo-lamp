/**
 * RuneDeck — authoritative match simulation.
 *
 * The server owns every unit: lane creeps, card troops, Frost Towers, both
 * heroes, and the projectiles that towers and ranged units fire. All damage
 * comes from one of those attacks or from a spell landing; nothing is scripted.
 *
 * Sent to each player
 *   game:state    snapshot ten times a second: the clock, structures, units, and the player's private state
 *                 (`introLeftMs` counts down the pre-game flyover, during which nothing moves).
 *                 `hits` and `heals` total the damage and healing since the snapshot before, by target:
 *                 [[id, amount, HIT flags]] and [[id, amount]]. The client floats them as numbers.
 *   game:events   [{ type: 'card' | 'cast' | 'item' | 'rune' | 'runeTaken' | 'bounty' | 'heroDown' | 'level' |
 *                    'doubleElixir' | 'overtime' | 'reject', ... }]
 *   game:over     { winner, reason, focus, durationMs, overtime, totals, stats }
 *
 * `heroDown` says who fell (`side`) and, when the other player's hero or card troops
 * struck the blow or had wounded it just before, to whom (`by`), that player's run of
 * kills without falling (`streak`) and whether it was the match's first (`firstBlood`,
 * with its `bonus` gold).
 *
 * A match runs its regular time, the last minute of it at double Elixir. No
 * match ends on the clock alone: when it runs out, sudden death begins, and
 * the first side to lose a Tower or its Throne loses. If overtime runs out too,
 * the side whose structures have less health left loses.
 *
 * Attacks are not events. Every unit and structure carries an attack counter and
 * its target's id in the snapshot; the client plays a swing or fires a
 * projectile whenever the counter changes.
 */

import {
  ABILITY_STRUCTURE_FACTOR,
  CARDS as CARD_POOL,
  CHAMPIONS,
  FLAG,
  HERO,
  HIT,
  LANES,
  MAP,
  MATCH,
  RUNES,
  RUNE_KINDS,
  SIDES,
  STRUCTURES,
  UNITS,
  UNIT_TYPES,
  canDeploy,
  heroSpawn,
  opposite,
  walkable,
} from './public/shared.js';
import { createBot } from './bot.js';

const CARDS = new Map(CARD_POOL.map((card) => [card.id, card]));
const ITEMS = new Map(HERO.items.map((item) => [item.key, item]));
const TYPE_INDEX = new Map(UNIT_TYPES.map((type, index) => [type, index]));
const LIFESTEAL = HERO.items.find((item) => item.lifesteal).lifesteal;
/** The hero field that holds each rune effect's end time. */
const RUNE_TIMER = { damage: 'empowerUntil', haste: 'hasteUntil', regen: 'regenUntil' };
const RUNE_PICKUP_RADIUS = 2.4;
/** Where a hero steps on and off a bridge, and onto the rune pad's stepping stones. */
const BRIDGE_END_X = 7.4;
const STAIRS_END_X = 8.2;
/** |x| inside which a point is over the River rather than on a bank. */
const RIVER_SPAN_X = 6.1;
/** Spawn offsets by squad size: [forward, sideways]. */
const FORMATIONS = { 1: [[0, 0]], 2: [[0, 0.55], [0, -0.55]], 3: [[0.6, 0], [-0.3, 0.6], [-0.3, -0.6]] };

/** Experience a hero needs to leave `level`. */
const xpToLeave = (level) => HERO.xpBase + HERO.xpStep * level;

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const round = (value) => Math.round(value * 100) / 100;
const alive = (target) => Boolean(target) && target.hp > 0 && !target.dead;

/** Distance from point `p` to the segment a-b. */
function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  const t = length2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/** -1 on Radiant's bank, 1 on Dire's, 0 over the River (a bridge or the rune pad). */
const bankOf = (x) => (x < -RIVER_SPAN_X ? -1 : x > RIVER_SPAN_X ? 1 : 0);

/**
 * Waypoints for a hero walking from `from` to `to`. The River can only be
 * crossed on a bridge, so a trip to the far bank goes by the nearer one.
 */
function route(from, to) {
  const a = bankOf(from.x);
  const b = bankOf(to.x);
  const path = [];
  if (a !== b && a !== 0 && b !== 0) {
    const cost = (z) => Math.hypot(from.x - a * BRIDGE_END_X, from.z - z) + Math.hypot(to.x - b * BRIDGE_END_X, to.z - z);
    const z = cost(-MAP.laneZ) < cost(MAP.laneZ) ? -MAP.laneZ : MAP.laneZ;
    path.push({ x: a * BRIDGE_END_X, z }, { x: b * BRIDGE_END_X, z });
  } else if (a !== b) {
    // One end is on a bridge or the rune pad: line up with it on the bank first.
    const over = a === 0 ? from : to;
    const onBridge = Math.abs(over.z) > MAP.laneZ / 2;
    path.push({ x: (a || b) * (onBridge ? BRIDGE_END_X : STAIRS_END_X), z: onBridge ? Math.sign(over.z) * MAP.laneZ : 0 });
  }
  path.push({ x: to.x, z: to.z });
  // A waypoint the hero is already standing on would hold it there.
  while (path.length > 1 && Math.hypot(path[0].x - from.x, path[0].z - from.z) < 0.3) path.shift();
  return path;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * @param {{
 *   players: Record<'radiant' | 'dire', { nickname: string, isBot: boolean, hero: string, deck: string[] }>,
 *   emit: (side: string, event: string, payload: object) => void,
 *   onOver: () => void,
 *   rules?: { durationMs?: number, overtimeMs?: number, structureHp?: number },
 * }} options
 *   `players[side].hero` is a champion id and `deck` the card ids that side takes into battle.
 *   `rules` shortens a match for testing: the regular time, the overtime, and the
 *   share of their health that Towers and Thrones start with.
 */
export function createGame({ players, emit, onOver, rules = {} }) {
  const durationMs = rules.durationMs ?? MATCH.durationMs;
  const overtimeMs = rules.overtimeMs ?? MATCH.overtimeMs;
  /** Towers and Thrones carry the same target fields as units, so combat code treats them alike. */
  const structures = STRUCTURES.map((def, index) => ({
    def,
    id: -(index + 1),
    side: def.side,
    x: def.x,
    z: def.z,
    radius: def.radius,
    hp: def.maxHp * (rules.structureHp ?? 1),
    maxHp: def.maxHp,
    building: true,
    isStructure: true,
    target: null,
    cooldown: 0,
    atk: 0,
    atkTarget: 0,
  }));
  /** Every unit, Frost Tower and hero in play. A dead hero stays listed until it respawns. */
  const units = [];
  const projectiles = [];
  /** Delayed effects such as a Fireball in flight, ordered by due time. */
  const pending = [];
  const outbox = { radiant: [], dire: [] };
  /** Damage since the last broadcast snapshot: target id -> [amount, HIT flags]. */
  const struck = new Map();
  /** Healing waiting to be reported: target id -> { amount, burst, since }. */
  const mended = new Map();

  let nextId = 1;
  let elapsedMs = 0;
  /** Time left of the cinematic flyover. Until it ends no clock runs and no orders are taken. */
  let introLeftMs = MATCH.introMs;
  let nextWaveMs = MATCH.waveFirstMs;
  let nextRuneMs = MATCH.runeFirstSpawnMs;
  /** Kind of the rune waiting on the River pad, or null. */
  let padRune = null;
  /** Elixir flows faster from the last minute of regular time to the end of the match. */
  let elixirFactor = 1;
  /** Sudden death: the regular time ran out with both Thrones standing. */
  let overtime = false;
  /** Whether a player has felled the other's hero yet. */
  let firstBlood = false;
  let over = false;
  let lastTick = performance.now();
  let sinceSnapshot = 0;

  const teams = { radiant: createTeam('radiant'), dire: createTeam('dire') };
  const bots = SIDES.filter((side) => players[side].isBot).map((side) =>
    createBot({
      side,
      team: teams[side],
      units,
      structures,
      rune: () => ({ kind: padRune, nextInMs: nextRuneMs - elapsedMs }),
      intents: { playCard, cast, useItem, heroMove, heroAttack },
    }),
  );
  const timer = setInterval(tick, MATCH.tickMs);

  /* ---------------------------------------------------------------- Setup */

  function createTeam(side) {
    const deck = shuffle([...players[side].deck]);
    const spawnPoint = heroSpawn(side);
    const hero = spawn('hero', side, spawnPoint.x, spawnPoint.z);
    Object.assign(hero, {
      mana: HERO.maxMana,
      level: 1,
      /** Experience gathered towards the next level. */
      xp: 0,
      gold: HERO.startGold,
      readyAt: {},
      order: null,
      dead: false,
      respawnAt: 0,
      shield: 0,
      shieldUntil: 0,
      /** When the other player's hero or card troops last struck this hero. */
      taggedAt: -Infinity,
      /** Kind of the rune in the bottle, or null. */
      rune: null,
      /** Relics bought so far, by key. */
      owned: {},
      empowerUntil: 0,
      hasteUntil: 0,
      regenUntil: 0,
    });
    return {
      side,
      elixir: MATCH.elixirStart,
      hand: deck.slice(0, MATCH.handSize),
      queue: deck.slice(MATCH.handSize),
      hero,
      /** Enemy heroes felled since this side's own hero last fell. */
      streak: 0,
      /** The champion's four abilities, by key. */
      abilities: new Map(CHAMPIONS[players[side].hero].abilities.map((ability) => [ability.key, ability])),
      /** What the post-match summary reports. `gold` is everything earned during the match. */
      stats: { kills: 0, deaths: 0, gold: 0, heroDamage: 0, buildingDamage: 0, cards: 0 },
    };
  }

  function spawn(type, side, x, z, lane = null) {
    const def = UNITS[type];
    const unit = {
      id: nextId++,
      type,
      def,
      side,
      x,
      z,
      radius: def.radius,
      hp: def.hp,
      maxHp: def.hp,
      building: Boolean(def.building),
      isHero: type === 'hero',
      /** Played from a card, so what it does counts for its player in the post-match summary. */
      fromCard: false,
      lane,
      wp: 0,
      // Sideways offset from the lane's centre line, so a wave does not march in single file.
      drift: (Math.random() - 0.5) * 0.9,
      target: null,
      scanAt: 0,
      cooldown: 300 + Math.random() * 400,
      atk: 0,
      atkTarget: 0,
      slowUntil: 0,
      stunUntil: 0,
      burnUntil: 0,
      blockedMs: 0,
      ignore: null,
      ignoreUntil: 0,
      expiresAt: def.lifetimeMs ? elapsedMs + def.lifetimeMs : Infinity,
    };
    if (lane) unit.wp = firstWaypoint(unit);
    units.push(unit);
    return unit;
  }

  /** The first point of the unit's lane that still lies ahead of it. */
  function firstWaypoint(unit) {
    const path = LANES[unit.lane];
    if (unit.side === 'radiant') {
      const index = path.findIndex((point) => point.x > unit.x + 0.3);
      return index === -1 ? path.length - 1 : index;
    }
    const index = path.findLastIndex((point) => point.x < unit.x - 0.3);
    return index === -1 ? 0 : index;
  }

  /** Three melee creeps and a ranged creep leave each Throne for each lane. */
  function spawnWave() {
    for (const side of SIDES) {
      if (units.filter((unit) => unit.side === side).length >= MATCH.unitCap) continue;
      const forward = side === 'radiant' ? 1 : -1;
      for (const lane of ['top', 'bottom']) {
        const path = LANES[lane];
        const gate = side === 'radiant' ? path[0] : path[path.length - 1];
        for (const [ahead, across] of FORMATIONS[3]) spawn('melee', side, gate.x + ahead * forward, gate.z + across, lane);
        spawn('ranged', side, gate.x - 0.8 * forward, gate.z, lane);
      }
    }
  }

  /* ---------------------------------------------------------------- Messaging */

  function broadcast(event) {
    for (const side of SIDES) outbox[side].push(event);
  }

  function reject(side, reason) {
    outbox[side].push({ type: 'reject', reason });
  }

  function flush() {
    for (const side of SIDES) {
      if (outbox[side].length) emit(side, 'game:events', outbox[side].splice(0));
    }
  }

  function schedule(delayMs, run) {
    const at = elapsedMs + delayMs;
    let index = pending.length;
    while (index > 0 && pending[index - 1].at > at) index--;
    pending.splice(index, 0, { at, run });
  }

  function flagsOf(unit) {
    return (
      (unit.slowUntil > elapsedMs ? FLAG.slowed : 0) |
      (unit.stunUntil > elapsedMs ? FLAG.stunned : 0) |
      (unit.shieldUntil > elapsedMs && unit.shield > 0 ? FLAG.shielded : 0) |
      (unit.dead ? FLAG.dead : 0) |
      (unit.empowerUntil > elapsedMs ? FLAG.empowered : 0) |
      (unit.hasteUntil > elapsedMs ? FLAG.hasted : 0) |
      (unit.regenUntil > elapsedMs ? FLAG.regen : 0) |
      (unit.owned?.X ? FLAG.lifesteal : 0) |
      (unit.burnUntil > elapsedMs ? FLAG.burning : 0)
    );
  }

  /** What the match clock shows: the regular time left, then the overtime left. */
  const clockLeftMs = () => Math.max(0, durationMs + (overtime ? overtimeMs : 0) - elapsedMs);

  /** A trickle of healing (a fountain, a rune) is reported as one number each time this much time has passed. */
  const MEND_EVERY_MS = 1_000;

  /** The healing ready to be shown: bursts at once, trickles once they have run for `MEND_EVERY_MS`. */
  function takeHeals() {
    const heals = [];
    for (const [id, entry] of mended) {
      if (!entry.burst && elapsedMs - entry.since < MEND_EVERY_MS) continue;
      mended.delete(id);
      if (entry.amount >= 1) heals.push([id, Math.round(entry.amount)]);
    }
    return heals;
  }

  function takeHits() {
    const hits = [];
    for (const [id, [amount, flags]] of struck) {
      if (amount >= 0.5) hits.push([id, Math.round(amount), flags]);
    }
    struck.clear();
    return hits;
  }

  /**
   * The part of a snapshot both players share. `hits` and `heals` belong to the
   * broadcast snapshots only: one sent to a single player carries none, so
   * neither player misses a number.
   */
  function worldState(hits = [], heals = []) {
    return {
      introLeftMs: Math.max(0, Math.round(introLeftMs)),
      timeLeftMs: clockLeftMs(),
      overtime,
      elixirFactor,
      rune: { kind: padRune, nextInMs: Math.max(0, nextRuneMs - elapsedMs) },
      structures: structures.map((s) => [Math.ceil(s.hp), s.atk, s.atkTarget]),
      units: units.map((u) => [
        u.id,
        TYPE_INDEX.get(u.type),
        u.side === 'radiant' ? 0 : 1,
        round(u.x),
        round(u.z),
        Math.ceil(u.hp),
        u.atk,
        u.atkTarget,
        flagsOf(u),
      ]),
      hits,
      heals,
    };
  }

  function privateState(side) {
    const team = teams[side];
    const { hero } = team;
    const cooldowns = {};
    for (const key of [...team.abilities.keys(), ...ITEMS.keys()]) {
      cooldowns[key] = Math.max(0, (hero.readyAt[key] ?? 0) - elapsedMs);
    }
    // Rune effects still running, as { kind: ms left }.
    const buffs = {};
    for (const kind of RUNE_KINDS) {
      const left = hero[RUNE_TIMER[kind]] - elapsedMs;
      if (left > 0) buffs[kind] = Math.round(left);
    }
    return {
      elixir: team.elixir,
      hand: team.hand,
      next: team.queue[0],
      hero: {
        id: hero.id,
        hp: hero.hp,
        mana: hero.mana,
        level: hero.level,
        /** Progress towards the next level, 0 to 1. */
        xp: hero.level < HERO.maxLevel ? round(hero.xp / xpToLeave(hero.level)) : 1,
        gold: Math.floor(hero.gold),
        rune: hero.rune,
        owned: hero.owned,
        buffs,
        respawnMs: hero.dead ? Math.max(0, hero.respawnAt - elapsedMs) : 0,
      },
      cooldowns,
    };
  }

  const snapshot = (side) => ({ ...worldState(), you: privateState(side) });

  function sendSnapshots() {
    const world = worldState(takeHits(), takeHeals());
    for (const side of SIDES) emit(side, 'game:state', { ...world, you: privateState(side) });
  }

  /* ---------------------------------------------------------------- Movement */

  /** Moves by (dx, dz), sliding along whichever axis stays on walkable ground. */
  function tryMove(unit, dx, dz) {
    if (walkable(unit.x + dx, unit.z + dz)) {
      unit.x += dx;
      unit.z += dz;
    } else if (dx && walkable(unit.x + dx, unit.z)) {
      unit.x += dx;
    } else if (dz && walkable(unit.x, unit.z + dz)) {
      unit.z += dz;
    }
  }

  /** One tick of walking towards a point. `blockedMs` grows while no real progress is made. */
  function stepToward(unit, x, z, dt) {
    const before = Math.hypot(x - unit.x, z - unit.z);
    if (before < 0.01) return;
    const slowed = unit.slowUntil > elapsedMs ? 1 - UNITS.frost_tower.slow : 1;
    const hasted = unit.hasteUntil > elapsedMs ? RUNES.haste.speedMultiplier : 1;
    const step = Math.min(before, (unit.def.speed * slowed * hasted * dt) / 1000);
    tryMove(unit, ((x - unit.x) / before) * step, ((z - unit.z) / before) * step);
    const gained = before - Math.hypot(x - unit.x, z - unit.z);
    unit.blockedMs = gained > step * 0.3 ? 0 : unit.blockedMs + dt;
  }

  function followLane(unit, dt) {
    const path = LANES[unit.lane];
    const forward = unit.side === 'radiant' ? 1 : -1;
    const last = forward > 0 ? path.length - 1 : 0;
    const point = path[unit.wp];
    // The bridges are too narrow for the full sideways drift.
    const z = point.z + (Math.abs(point.x) < BRIDGE_END_X + 0.6 ? unit.drift * 0.5 : unit.drift);
    if (Math.hypot(point.x - unit.x, z - unit.z) < 0.7 || unit.blockedMs > 1_200) {
      unit.blockedMs = 0;
      if (unit.wp === last) return;
      unit.wp += forward;
    }
    stepToward(unit, point.x, z, dt);
  }

  /** Keeps units from stacking on each other and from walking through buildings. */
  function separate() {
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (!alive(a)) continue;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j];
        if (!alive(b) || (a.building && b.building)) continue;
        const min = a.radius + b.radius;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        let d = Math.sqrt(d2);
        if (d < 0.001) {
          // Exactly stacked: pick a direction that differs per pair.
          dx = Math.cos(a.id * 7 + b.id);
          dz = Math.sin(a.id * 7 + b.id);
          d = 1;
        }
        // Heavier units give way less; buildings not at all.
        const massA = a.building ? Infinity : a.radius ** 2;
        const massB = b.building ? Infinity : b.radius ** 2;
        const overlap = (min - d) / d;
        const shareA = massB === Infinity ? 1 : massA === Infinity ? 0 : massB / (massA + massB);
        if (shareA > 0) tryMove(a, -dx * overlap * shareA, -dz * overlap * shareA);
        if (shareA < 1) tryMove(b, dx * overlap * (1 - shareA), dz * overlap * (1 - shareA));
      }
      if (a.building) continue;
      for (const s of structures) {
        if (s.hp <= 0) continue;
        const min = s.radius + a.radius;
        const dx = a.x - s.x;
        const dz = a.z - s.z;
        const d = Math.hypot(dx, dz);
        if (d < min && d > 0.001) tryMove(a, (dx / d) * (min - d), (dz / d) * (min - d));
      }
    }
  }

  /* ---------------------------------------------------------------- Combat */

  /** Multiplier on everything a unit deals: the Double Damage rune, and a hero's levels. */
  const powerOf = (unit) =>
    (unit.empowerUntil > elapsedMs ? RUNES.damage.damageMultiplier : 1) * (unit.isHero ? 1 + HERO.levelPower * (unit.level - 1) : 1);

  function pay(side, gold) {
    teams[side].hero.gold += gold;
    teams[side].stats.gold += gold;
  }

  function gainXp(hero, amount) {
    if (hero.level >= HERO.maxLevel) return;
    hero.xp += amount;
    while (hero.level < HERO.maxLevel && hero.xp >= xpToLeave(hero.level)) {
      hero.xp -= xpToLeave(hero.level);
      hero.level++;
      broadcast({ type: 'level', side: hero.side, level: hero.level });
    }
  }

  /**
   * The summary a blow counts towards: a hero's own blows and spells and the
   * troops played from cards belong to that side's player. Lane creeps, Towers
   * and Thrones fight for nobody.
   */
  const creditOf = (source) => (source?.isHero || source?.fromCard ? teams[source.side].stats : null);

  /**
   * Restores health and returns how much. A `burst` (a heal spell, a blow that
   * steals life) is reported with the next snapshot; a trickle is totalled first.
   */
  function mend(unit, amount, burst = true) {
    const gained = Math.min(unit.maxHp - unit.hp, amount);
    if (gained <= 0) return 0;
    unit.hp += gained;
    const entry = mended.get(unit.id);
    if (entry) {
      entry.amount += gained;
      entry.burst ||= burst;
    } else {
      mended.set(unit.id, { amount: gained, burst, since: elapsedMs });
    }
    return gained;
  }

  /** The Lifesteal Blade returns a share of the damage its owner deals: at once for a blow, as a trickle for a burn. */
  function drain(hero, dealt, burst = true) {
    if (hero.owned.X && dealt > 0 && alive(hero)) mend(hero, dealt * LIFESTEAL, burst);
  }

  /** The closest enemy this unit is allowed to fight and can see. */
  function acquire(unit) {
    const sight = unit.def.speed ? unit.def.aggro : unit.def.range;
    let best = null;
    let bestGap = Infinity;
    const consider = (target) => {
      if (target.side === unit.side || !alive(target)) return;
      if (unit.def.buildingsOnly && !target.building) return;
      if (target === unit.ignore && unit.ignoreUntil > elapsedMs) return;
      const gap = distance(unit, target) - target.radius;
      if (gap <= sight && gap < bestGap) {
        best = target;
        bestGap = gap;
      }
    };
    for (const other of units) consider(other);
    for (const s of structures) consider(s);
    return best;
  }

  function strike(unit, target) {
    const { def } = unit;
    unit.cooldown = def.attackMs;
    unit.atk = (unit.atk + 1) % 64;
    unit.atkTarget = target.id;
    if (def.spin) {
      // One swing cuts everything around the unit, not only what it was aiming at.
      const reaches = (other) => other.side !== unit.side && alive(other) && distance(unit, other) <= def.spin + other.radius;
      for (const other of units) if (reaches(other)) hurt(other, def.damage, unit);
      for (const s of structures) if (reaches(s)) hurt(s, def.damage * def.siege, unit);
      return;
    }
    const damage = def.damage * powerOf(unit) * (target.isStructure ? def.siege : 1);
    if (def.shot) {
      projectiles.push({ x: unit.x, z: unit.z, tx: target.x, tz: target.z, target, speed: def.shotSpeed, damage, source: unit });
      return;
    }
    const dealt = hurt(target, damage, unit);
    if (def.slowMs && !target.isStructure) target.slowUntil = elapsedMs + def.slowMs;
    if (unit.isHero) drain(unit, dealt);
  }

  /** Attacks `target` if it is in reach, otherwise closes the distance. */
  function engage(unit, target, dt) {
    if (distance(unit, target) <= unit.def.range + target.radius) {
      unit.blockedMs = 0;
      if (unit.cooldown <= 0) strike(unit, target);
      return;
    }
    if (!unit.def.speed) return;
    if (unit.isHero) {
      const [next] = route(unit, target);
      stepToward(unit, next.x, next.z, dt);
      return;
    }
    stepToward(unit, target.x, target.z, dt);
    // A target across the water cannot be reached directly: forget it for a while and walk on.
    if (unit.blockedMs > 700) {
      unit.ignore = target;
      unit.ignoreUntil = elapsedMs + 2_500;
      unit.target = null;
      unit.blockedMs = 0;
    }
  }

  function think(unit, dt) {
    unit.cooldown -= dt;
    const { def } = unit;
    const leash = def.speed ? def.aggro + 2.5 : def.range;
    if (unit.target && (!alive(unit.target) || distance(unit, unit.target) > leash + unit.target.radius)) unit.target = null;
    if (!unit.target && unit.scanAt <= elapsedMs) {
      unit.scanAt = elapsedMs + 150 + Math.random() * 100;
      unit.target = acquire(unit);
    }
    if (unit.target) engage(unit, unit.target, dt);
    else if (unit.lane) followLane(unit, dt);
  }

  function thinkHero(hero, dt) {
    hero.cooldown -= dt;
    const { order } = hero;
    if (order?.target) {
      if (alive(order.target)) {
        hero.target = order.target;
        engage(hero, order.target, dt);
        return;
      }
      hero.order = null;
    } else if (order) {
      const point = order.path[0];
      if (distance(hero, point) < 0.2 || hero.blockedMs > 500) {
        hero.blockedMs = 0;
        order.path.shift();
        if (!order.path.length) hero.order = null;
      } else {
        stepToward(hero, point.x, point.z, dt);
      }
      hero.target = null;
      return;
    }
    // No orders: fight whatever comes close.
    if (!alive(hero.target) || distance(hero, hero.target) > hero.def.aggro + hero.target.radius + 2) hero.target = acquire(hero);
    if (hero.target) engage(hero, hero.target, dt);
  }

  /** Towers and Thrones fire at the closest enemy unit or hero inside their range. */
  function defend(s, dt) {
    s.cooldown -= dt;
    if (!alive(s.target) || distance(s, s.target) > s.def.range + s.target.radius) {
      s.target = null;
      let bestGap = s.def.range;
      for (const unit of units) {
        if (unit.side === s.side || !alive(unit)) continue;
        const gap = distance(s, unit) - unit.radius;
        if (gap <= bestGap) {
          s.target = unit;
          bestGap = gap;
        }
      }
    }
    if (!s.target || s.cooldown > 0) return;
    s.cooldown = s.def.attackMs;
    s.atk = (s.atk + 1) % 64;
    s.atkTarget = s.target.id;
    projectiles.push({ x: s.x, z: s.z, tx: s.target.x, tz: s.target.z, target: s.target, speed: s.def.shotSpeed, damage: s.def.damage, source: s });
  }

  /** Projectiles home on their target and deal their damage on arrival. */
  function moveProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      const live = alive(p.target);
      if (live) {
        p.tx = p.target.x;
        p.tz = p.target.z;
      }
      const gap = Math.hypot(p.tx - p.x, p.tz - p.z);
      const step = (p.speed * dt) / 1000;
      if (gap <= step + (live ? p.target.radius * 0.5 : 0)) {
        if (live) hurt(p.target, p.damage, p.source);
        projectiles.splice(i, 1);
      } else {
        p.x += ((p.tx - p.x) / gap) * step;
        p.z += ((p.tz - p.z) / gap) * step;
      }
    }
  }

  /**
   * Applies damage and returns how much health it actually removed. `kind` says
   * what the blow was (`HIT.spell`, `HIT.burn`, or 0 for an attack), for the floating numbers.
   */
  function hurt(target, amount, source, kind = 0) {
    if (over || !alive(target)) return 0;
    if (target.shieldUntil > elapsedMs && target.shield > 0) {
      const absorbed = Math.min(target.shield, amount);
      target.shield -= absorbed;
      amount -= absorbed;
    }
    const dealt = Math.min(target.hp, amount);
    target.hp -= dealt;
    if (dealt > 0) {
      const flags = kind | (source?.isHero ? HIT.hero : 0);
      const entry = struck.get(target.id);
      if (entry) {
        entry[0] += dealt;
        entry[1] |= flags;
      } else {
        struck.set(target.id, [dealt, flags]);
      }
    }
    const credit = creditOf(source);
    if (credit && target.isHero) {
      credit.heroDamage += dealt;
      target.taggedAt = elapsedMs;
    } else if (credit && target.building) {
      credit.buildingDamage += dealt;
    }
    if (target.hp > 0) return dealt;

    const foe = opposite(target.side);
    // Troops pay only the hero who lands the killing blow; Towers and heroes pay whoever fells them.
    const { bounty } = target.def;
    if (bounty && (target.isStructure || target.isHero || source?.isHero)) {
      pay(foe, bounty);
      outbox[foe].push({ type: 'bounty', gold: bounty, id: target.id, x: round(target.x), z: round(target.z) });
    }
    // Troops teach only a hero who is there to see them fall, or who felled them from afar.
    const rival = teams[foe].hero;
    if (target.isStructure || target.isHero || source === rival || (alive(rival) && distance(rival, target) <= HERO.xpRadius)) {
      gainXp(rival, target.isStructure ? HERO.xp.tower : target.isHero ? HERO.xp.hero : HERO.xp.unit);
    }
    if (target.isStructure) {
      // In sudden death the first structure to fall decides the match, whichever it is.
      if (target.def.kind === 'throne') finish('throne', foe, target.def.id);
      else if (overtime) finish('sudden_death', foe, target.def.id);
    } else if (target.isHero) {
      target.dead = true;
      target.respawnAt = elapsedMs + MATCH.heroRespawnMs;
      target.order = null;
      target.target = null;
      target.burnUntil = 0;
      teams[target.side].stats.deaths++;
      teams[target.side].streak = 0;
      const event = { type: 'heroDown', side: target.side, respawnMs: MATCH.heroRespawnMs, by: null, streak: 0 };
      // The kill is the other player's if their hero or card troops struck the blow, or had wounded this hero
      // a moment before. A hero that simply falls to lane creeps or a Tower is nobody's kill.
      const slayer = credit ?? (elapsedMs - target.taggedAt <= MATCH.killCreditMs ? teams[foe].stats : null);
      if (slayer) {
        slayer.kills++;
        event.by = foe;
        event.streak = ++teams[foe].streak;
        if (!firstBlood) {
          firstBlood = true;
          event.firstBlood = true;
          event.bonus = MATCH.firstBloodGold;
          pay(foe, MATCH.firstBloodGold);
          outbox[foe].push({ type: 'bounty', gold: MATCH.firstBloodGold, bonus: true, id: target.id, x: round(target.x), z: round(target.z) });
        }
      }
      broadcast(event);
    }
    return dealt;
  }

  /**
   * Damages every enemy of `side` that `hits` accepts and returns the total dealt.
   * Structures take a reduced share, and are never stunned or set alight.
   */
  function blast(side, source, damage, hits, { stunMs = 0, burn = null, kind = HIT.spell } = {}) {
    let dealt = 0;
    for (const unit of units) {
      if (unit.side === side || !alive(unit) || !hits(unit)) continue;
      dealt += hurt(unit, damage, source, kind);
      if (stunMs && !unit.building) unit.stunUntil = elapsedMs + stunMs;
      if (burn && !unit.building) ignite(unit, source, burn);
    }
    for (const s of structures) {
      if (s.side !== side && alive(s) && hits(s)) dealt += hurt(s, damage * ABILITY_STRUCTURE_FACTOR, source, kind);
    }
    return dealt;
  }

  /** Sets a unit alight: `burn.damage` in equal ticks over `burn.durationMs`, credited to `source`. */
  function ignite(unit, source, burn) {
    if (!alive(unit)) return;
    const ticks = Math.round(burn.durationMs / burn.tickMs);
    const damage = (burn.damage * powerOf(source)) / ticks;
    unit.burnUntil = elapsedMs + burn.durationMs;
    for (let i = 1; i <= ticks; i++) {
      schedule(i * burn.tickMs, () => {
        // A hero who fell and came back is no longer burning.
        if (unit.burnUntil > elapsedMs - burn.tickMs) drain(source, hurt(unit, damage, source, HIT.burn), false);
      });
    }
  }

  /** Removes the fallen and any Frost Tower whose time is up. Heroes stay and respawn. */
  function sweep() {
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i];
      if (unit.isHero) continue;
      if (elapsedMs >= unit.expiresAt) unit.hp = 0;
      if (unit.hp <= 0) units.splice(i, 1);
    }
  }

  /* ---------------------------------------------------------------- Tick */

  function tick() {
    const now = performance.now();
    const dt = Math.min(now - lastTick, 250);
    lastTick = now;
    if (introLeftMs > 0) {
      introLeftMs -= dt;
      sinceSnapshot += dt;
      // Both armies stand ready; a snapshot goes out as the flyover ends so every client starts together.
      if (introLeftMs <= 0 || sinceSnapshot >= 500) {
        sinceSnapshot = 0;
        sendSnapshots();
      }
      return;
    }
    elapsedMs += dt;

    for (const side of SIDES) {
      const team = teams[side];
      const { hero } = team;
      team.elixir = Math.min(MATCH.elixirMax, team.elixir + (dt * elixirFactor) / MATCH.elixirIntervalMs);
      pay(side, (HERO.goldPerSecond * dt) / 1000);
      gainXp(hero, (HERO.xpPerSecond * dt) / 1000);
      if (hero.dead) {
        if (elapsedMs >= hero.respawnAt) revive(hero);
        continue;
      }
      const home = structures[side === 'radiant' ? 0 : 3];
      const resting = distance(hero, home) < home.radius + HERO.fountainRadius;
      // A hero's own slow regeneration goes unremarked; the fountain's and a rune's show as numbers.
      if (resting) mend(hero, (HERO.fountainHp * dt) / 1000, false);
      else hero.hp = Math.min(hero.maxHp, hero.hp + (HERO.hpRegen * dt) / 1000);
      hero.mana = Math.min(HERO.maxMana, hero.mana + ((resting ? HERO.fountainMana : HERO.manaRegen) * dt) / 1000);
      if (hero.regenUntil > elapsedMs) {
        mend(hero, (RUNES.regen.hpPerSecond * dt) / 1000, false);
        hero.mana = Math.min(HERO.maxMana, hero.mana + (RUNES.regen.manaPerSecond * dt) / 1000);
      }
      // Walking over the pad bottles its rune, replacing whatever the bottle held.
      if (padRune && Math.hypot(hero.x, hero.z) < RUNE_PICKUP_RADIUS) {
        hero.rune = padRune;
        broadcast({ type: 'runeTaken', side, kind: padRune });
        padRune = null;
      }
    }

    if (elixirFactor === 1 && clockLeftMs() <= MATCH.doubleElixirAtMs) {
      elixirFactor = MATCH.doubleElixirFactor;
      broadcast({ type: 'doubleElixir', factor: elixirFactor });
    }
    if (elapsedMs >= nextWaveMs) {
      nextWaveMs += MATCH.waveIntervalMs;
      spawnWave();
    }
    // An unclaimed rune is simply replaced by the next one.
    if (elapsedMs >= nextRuneMs) {
      nextRuneMs += MATCH.runeIntervalMs;
      padRune = RUNE_KINDS[Math.floor(Math.random() * RUNE_KINDS.length)];
      broadcast({ type: 'rune', kind: padRune });
    }
    while (!over && pending.length && pending[0].at <= elapsedMs) pending.shift().run();

    for (const unit of units) {
      if (over) break;
      if (!alive(unit) || unit.stunUntil > elapsedMs) continue;
      if (unit.isHero) thinkHero(unit, dt);
      else think(unit, dt);
    }
    for (const s of structures) {
      if (!over && s.hp > 0) defend(s, dt);
    }
    if (!over) moveProjectiles(dt);
    if (!over) {
      separate();
      sweep();
      for (const bot of bots) bot.think(elapsedMs);
    }
    // finish() has already sent the final state.
    if (over) return;
    if (overtime && elapsedMs >= durationMs + overtimeMs) {
      finish('time');
      return;
    }
    // A Throne falling ends the match on the spot, so at this point both still stand.
    if (!overtime && elapsedMs >= durationMs) {
      overtime = true;
      broadcast({ type: 'overtime', ms: overtimeMs });
    }

    sinceSnapshot += dt;
    if (sinceSnapshot >= MATCH.snapshotMs) {
      sinceSnapshot = 0;
      sendSnapshots();
    }
    flush();
  }

  function revive(hero) {
    const point = heroSpawn(hero.side);
    Object.assign(hero, {
      x: point.x,
      z: point.z,
      hp: hero.maxHp,
      mana: HERO.maxMana,
      dead: false,
      slowUntil: 0,
      stunUntil: 0,
      burnUntil: 0,
      shield: 0,
      blockedMs: 0,
      taggedAt: -Infinity,
    });
  }

  function totals() {
    const sum = { radiant: { hp: 0, maxHp: 0 }, dire: { hp: 0, maxHp: 0 } };
    for (const s of structures) {
      sum[s.side].hp += Math.ceil(s.hp);
      sum[s.side].maxHp += s.maxHp;
    }
    return sum;
  }

  /**
   * Ends the match. `reason` is 'throne' (a Throne fell), 'sudden_death' (a Tower
   * fell during overtime) or 'time' (overtime ran out: the side whose structures
   * have less health left loses, and equal health is a draw). `focus` is the id
   * of the structure whose fall decided it, for the client's closing shot.
   */
  function finish(reason, winner = null, focus = null) {
    if (over) return;
    over = true;
    clearInterval(timer);
    const sum = totals();
    if (reason === 'time') {
      const radiant = sum.radiant.hp / sum.radiant.maxHp;
      const dire = sum.dire.hp / sum.dire.maxHp;
      winner = radiant === dire ? null : radiant > dire ? 'radiant' : 'dire';
    }
    const stats = {};
    for (const side of SIDES) {
      const { hero, stats: s } = teams[side];
      stats[side] = {
        kills: s.kills,
        deaths: s.deaths,
        level: hero.level,
        gold: Math.floor(s.gold),
        heroDamage: Math.round(s.heroDamage),
        buildingDamage: Math.round(s.buildingDamage),
        cards: s.cards,
      };
    }
    flush();
    sendSnapshots();
    for (const side of SIDES) {
      emit(side, 'game:over', { winner, reason, focus, durationMs: Math.round(elapsedMs), overtime, totals: sum, stats });
    }
    onOver();
  }

  /* ---------------------------------------------------------------- Intents */

  /** No orders are taken once the match is decided, or before the flyover has ended. */
  const locked = () => over || introLeftMs > 0;

  function playCard(side, slot, x, z) {
    if (locked() || !Number.isInteger(slot) || slot < 0 || slot >= MATCH.handSize) return;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const team = teams[side];
    const card = CARDS.get(team.hand[slot]);
    if (team.elixir < card.cost) return reject(side, 'Not enough Elixir');
    const placement = canDeploy(card, side, x, z);
    if (!placement.ok) return reject(side, placement.reason);

    team.elixir -= card.cost;
    team.queue.push(card.id);
    team.hand[slot] = team.queue.shift();
    team.stats.cards++;
    broadcast({ type: 'card', side, card: card.id, x: round(x), z: round(z) });

    const at = { x, z };
    if (card.spawns) {
      const forward = side === 'radiant' ? 1 : -1;
      const lane = UNITS[card.spawns].building ? null : z < 0 ? 'top' : 'bottom';
      for (const [ahead, across] of FORMATIONS[card.count]) {
        const px = x + ahead * forward;
        const pz = z + across;
        const fits = walkable(px, pz);
        spawn(card.spawns, side, fits ? px : x, fits ? pz : z, lane).fromCard = true;
      }
    } else if (card.damage) {
      const land = () => {
        const hits = (target) => distance(target, at) <= card.radius + target.radius;
        for (const unit of units) {
          if (unit.side === side || !alive(unit) || !hits(unit)) continue;
          hurt(unit, card.damage, team.hero, HIT.spell);
          if (card.stunMs && !unit.building) unit.stunUntil = elapsedMs + card.stunMs;
        }
        for (const s of structures) {
          if (s.side !== side && alive(s) && hits(s)) hurt(s, card.structureDamage, team.hero, HIT.spell);
        }
      };
      // A Fireball is in the air for `travelMs` and hurts nothing until it lands; a Lightning Bolt strikes at once.
      if (card.travelMs) schedule(card.travelMs, land);
      else land();
    } else if (card.heal) {
      for (const unit of units) {
        if (unit.side !== side || !alive(unit) || unit.building) continue;
        if (distance(unit, at) <= card.radius + unit.radius) mend(unit, card.heal);
      }
    }
    emit(side, 'game:state', snapshot(side));
  }

  /** The point an ability lands on: the cursor, pulled in to `range`. Without a cursor it aims straight ahead. */
  function aimPoint(hero, x, z, range) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      x = hero.x + (hero.side === 'radiant' ? range : -range);
      z = hero.z;
    }
    const gap = Math.hypot(x - hero.x, z - hero.z);
    if (gap <= range) return { x, z };
    return { x: hero.x + ((x - hero.x) / gap) * range, z: hero.z + ((z - hero.z) / gap) * range };
  }

  /**
   * Moves the hero in a straight line towards `aim`. A dash stops at the first
   * obstacle; a blink lands on the farthest free spot along the line.
   */
  function travel(hero, aim, blink) {
    const dx = aim.x - hero.x;
    const dz = aim.z - hero.z;
    const steps = Math.ceil(Math.hypot(dx, dz) / 0.3);
    const free = (x, z) => walkable(x, z) && structures.every((s) => s.hp <= 0 || Math.hypot(x - s.x, z - s.z) >= s.radius + hero.radius);
    let landing = null;
    for (let i = 1; i <= steps; i++) {
      const x = hero.x + (dx * i) / steps;
      const z = hero.z + (dz * i) / steps;
      if (free(x, z)) landing = { x, z };
      else if (!blink) break;
    }
    if (landing) Object.assign(hero, landing);
    hero.order = null;
  }

  /** The hero that may act for `side`, or null after telling the player why not. */
  function actingHero(side) {
    const { hero } = teams[side];
    if (hero.dead) reject(side, 'Your hero is respawning');
    else if (hero.stunUntil > elapsedMs) reject(side, 'Your hero is stunned');
    else return hero;
    return null;
  }

  /** The point `reach` away from the hero in the direction of the cursor, however near or far the cursor is. */
  function aimAlong(hero, x, z, reach) {
    const aim = aimPoint(hero, x, z, reach);
    const gap = Math.hypot(aim.x - hero.x, aim.z - hero.z);
    if (gap < 0.01) return { x: hero.x + (hero.side === 'radiant' ? reach : -reach), z: hero.z };
    return { x: hero.x + ((aim.x - hero.x) / gap) * reach, z: hero.z + ((aim.z - hero.z) / gap) * reach };
  }

  /**
   * What each kind of ability does (see `CHAMPIONS`). Each returns the point the
   * cast event reports as (tx, tz), or nothing when the ability has no direction.
   */
  const CASTS = {
    dash(side, hero, ability, damage, x, z) {
      const from = { x: hero.x, z: hero.z };
      travel(hero, aimPoint(hero, x, z, ability.range), false);
      drain(hero, blast(side, hero, damage, (target) => segmentDistance(target, from, hero) <= ability.width / 2 + target.radius));
      return hero;
    },
    shield(side, hero, ability) {
      hero.shield = ability.shield;
      hero.shieldUntil = elapsedMs + ability.durationMs;
      if (!ability.auraDamage) return null;
      // The fire lasts only as long as the cloak does: breaking the shield puts it out.
      const until = hero.shieldUntil;
      const close = (target) => distance(target, hero) <= ability.auraRadius + target.radius;
      for (let at = ability.tickMs; at <= ability.durationMs; at += ability.tickMs) {
        schedule(at, () => {
          if (alive(hero) && hero.shield > 0 && hero.shieldUntil === until) {
            drain(hero, blast(side, hero, ability.auraDamage * powerOf(hero), close, { kind: HIT.burn }), false);
          }
        });
      }
      return null;
    },
    strike(side, hero, ability, damage, x, z) {
      const aim = aimPoint(hero, x, z, ability.range);
      drain(hero, blast(side, hero, damage, (target) => distance(target, aim) <= ability.radius + target.radius, { stunMs: ability.stunMs }));
      return aim;
    },
    pillar(side, hero, ability, damage, x, z) {
      const aim = aimPoint(hero, x, z, ability.range);
      const inArea = (target) => distance(target, aim) <= ability.radius + target.radius;
      // The pillar burns for its whole duration: the damage is split over evenly spaced ticks.
      const ticks = Math.round(ability.durationMs / ability.tickMs);
      for (let i = 0; i < ticks; i++) {
        schedule(ability.delayMs + i * ability.tickMs, () => drain(hero, blast(side, hero, damage / ticks, inArea)));
      }
      return aim;
    },
    cleave(side, hero, ability, damage, x, z) {
      const aim = aimAlong(hero, x, z, ability.range);
      const facing = Math.atan2(aim.z - hero.z, aim.x - hero.x);
      const half = (ability.arc * Math.PI) / 360;
      const inCone = (target) => {
        const gap = distance(target, hero);
        if (gap > ability.range + target.radius) return false;
        if (gap <= target.radius) return true;
        const bearing = Math.atan2(target.z - hero.z, target.x - hero.x) - facing;
        const off = Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing)));
        // A wide target is hit when any part of it is inside the cone.
        return off <= half + Math.asin(target.radius / gap);
      };
      drain(hero, blast(side, hero, damage, inCone, { burn: ability.burn }));
      return aim;
    },
    spikes(side, hero, ability, damage, x, z) {
      const end = aimAlong(hero, x, z, ability.range);
      const from = { x: hero.x, z: hero.z };
      drain(hero, blast(side, hero, damage, (target) => segmentDistance(target, from, end) <= ability.width / 2 + target.radius, { stunMs: ability.stunMs }));
      return end;
    },
    meteor(side, hero, ability, damage, x, z) {
      const aim = aimPoint(hero, x, z, ability.range);
      const inArea = (target) => distance(target, aim) <= ability.radius + target.radius;
      schedule(ability.delayMs, () => drain(hero, blast(side, hero, damage, inArea, { stunMs: ability.stunMs })));
      // The crater scorches whatever stands in it, tick by tick, and lets go of whatever walks out.
      const { burn } = ability;
      const ticks = Math.round(burn.durationMs / burn.tickMs);
      const scorch = (burn.damage * powerOf(hero)) / ticks;
      for (let i = 1; i <= ticks; i++) {
        schedule(ability.delayMs + i * burn.tickMs, () => {
          for (const unit of units) {
            if (unit.side !== side && alive(unit) && !unit.building && inArea(unit)) unit.burnUntil = Math.max(unit.burnUntil, elapsedMs + burn.tickMs);
          }
          drain(hero, blast(side, hero, scorch, inArea, { kind: HIT.burn }), false);
        });
      }
      return aim;
    },
  };

  function cast(side, key, x, z) {
    const ability = teams[side].abilities.get(key);
    if (locked() || !ability) return;
    const hero = actingHero(side);
    if (!hero) return;
    if ((hero.readyAt[key] ?? 0) > elapsedMs) return reject(side, `${ability.name} is on cooldown`);
    if (hero.mana < ability.manaCost) return reject(side, 'Not enough mana');

    hero.mana -= ability.manaCost;
    hero.readyAt[key] = elapsedMs + ability.cooldownMs;
    const event = { type: 'cast', side, key, ability: ability.id, x: round(hero.x), z: round(hero.z) };
    const target = CASTS[ability.kind](side, hero, ability, (ability.damage ?? 0) * powerOf(hero), x, z);
    if (target) Object.assign(event, { tx: round(target.x), tz: round(target.z) });
    broadcast(event);
    emit(side, 'game:state', snapshot(side));
  }

  function useItem(side, key, x, z) {
    const item = ITEMS.get(key);
    if (locked() || !item) return;
    const { hero } = teams[side];
    // The first press of a relic's key buys it. A hero may shop while respawning.
    if (item.cost && !hero.owned[key]) {
      if (hero.gold < item.cost) return reject(side, `${item.name} costs ${item.cost} gold`);
      hero.gold -= item.cost;
      hero.owned[key] = true;
      broadcast({ type: 'item', side, key, bought: true, x: round(hero.x), z: round(hero.z) });
      emit(side, 'game:state', snapshot(side));
      return;
    }
    if (item.passive) return reject(side, `${item.name} is always active`);
    if (!actingHero(side)) return;
    const event = { type: 'item', side, key, x: round(hero.x), z: round(hero.z) };

    if (item.holdsRune) {
      if (!hero.rune) return reject(side, 'The Rune Bottle is empty');
      event.rune = hero.rune;
      hero[RUNE_TIMER[hero.rune]] = elapsedMs + RUNES[hero.rune].durationMs;
      hero.rune = null;
    } else {
      if ((hero.readyAt[key] ?? 0) > elapsedMs) return reject(side, `${item.name} is on cooldown`);
      hero.readyAt[key] = elapsedMs + item.cooldownMs;
      travel(hero, aimPoint(hero, x, z, item.range), true);
      Object.assign(event, { tx: round(hero.x), tz: round(hero.z) });
    }
    broadcast(event);
    emit(side, 'game:state', snapshot(side));
  }

  function heroMove(side, x, z) {
    if (locked() || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const { hero } = teams[side];
    if (hero.dead) return;
    const limit = (value, max) => Math.min(max, Math.max(-max, value));
    hero.order = { path: route(hero, { x: limit(x, MAP.halfWidth - 0.3), z: limit(z, MAP.halfDepth - 0.3) }) };
    hero.blockedMs = 0;
  }

  function heroAttack(side, id) {
    if (locked() || !Number.isInteger(id)) return;
    const { hero } = teams[side];
    const target = id < 0 ? structures[-id - 1] : units.find((unit) => unit.id === id);
    if (hero.dead || !alive(target) || target.side === side) return;
    hero.order = { target };
    hero.blockedMs = 0;
  }

  return {
    snapshot,
    playCard,
    cast,
    useItem,
    heroMove,
    heroAttack,
    stop() {
      over = true;
      clearInterval(timer);
    },
  };
}
