/**
 * RuneDeck — data and rules shared by the server simulation and the browser.
 * Plain ES module: no DOM and no Node APIs, so both sides can import it.
 */

export const SIDES = ['radiant', 'dire'];

export const opposite = (side) => (side === 'radiant' ? 'dire' : 'radiant');

/**
 * Battlefield layout in world units. Radiant holds -X (screen left) and Dire +X.
 * The top lane runs along -Z, the bottom lane along +Z, and the River follows X ≈ 0.
 */
export const MAP = {
  halfWidth: 44,
  halfDepth: 24,
  laneZ: 13,
  towerX: 20,
  throneX: 37,
  heroX: 30,
  bridgeHalfLength: 6.6,
  /** Half the walkable width of a bridge deck, and of the stairs that descend to the rune pad. */
  bridgeHalfWidth: 1.9,
  stairsHalfWidth: 1.5,
  /** Where those stairs meet each bank, and the radius of the pad they lead to. */
  stairsEndX: 8.4,
  padRadius: 3.4,
  /** The Guardian's cavern in the Radiant jungle: a ring of mountain that nothing can cross. `mouth` is the bearing of its opening. */
  cavern: { x: -36.5, z: -18.2, radius: 7.4, pit: 4.8, mouth: 1.0 },
  /** River shape. The renderer injects these same numbers into its shaders. */
  river: {
    amp1: 0.9,
    freq1: 0.21,
    amp2: 0.24,
    freq2: 0.55,
    phase2: 1.7,
    halfWidth: 4,
    wobble: 0.5,
    wobbleFreq: 0.4,
    wobblePhase: 0.5,
    poolRadius: 6.8,
    blend: 2.4,
  },
};

/**
 * Elevation of each tier, in world units. The simulation is flat (x, z); these
 * only shape the terrain and the height at which units are drawn on it.
 */
export const LEVEL = { bed: -3.3, water: -2.5, pad: -2.1, bridge: -0.9, bank: 0, terrace: 0.75, base: 1.5 };

export const MATCH = {
  durationMs: 210_000,
  /** The cinematic flyover before the battle: no clock runs and no orders are taken until it ends. */
  introMs: 5_000,
  tickMs: 50,
  snapshotMs: 100,
  handSize: 4,
  elixirMax: 10,
  elixirStart: 5,
  elixirIntervalMs: 2_500,
  runeFirstSpawnMs: 30_000,
  runeIntervalMs: 60_000,
  waveFirstMs: 1_500,
  waveIntervalMs: 20_000,
  heroRespawnMs: 8_000,
  /** Gold paid, on top of the bounty, for the first hero a player fells in a match. */
  firstBloodGold: 150,
  /** A hero that falls to a lane creep or a Tower is still the other player's kill if they wounded it this recently. */
  killCreditMs: 10_000,
  /** Elixir flows `doubleElixirFactor` times as fast once this much of the clock is left, and through overtime. */
  doubleElixirAtMs: 60_000,
  doubleElixirFactor: 2,
  /** Sudden death: played when the clock runs out with both Thrones standing. */
  overtimeMs: 120_000,
  /** Cards a player takes into battle, out of the whole pool (`CARDS`). */
  deckSize: 6,
  /** Each side stops receiving lane waves above this many living units. */
  unitCap: 44,
  /**
   * How long a player searches for a human rival before an AI bot takes the other
   * side. A rule of the game and not a setting: the server times the search by it
   * and the lobby shows it (01:00), so the two cannot disagree.
   */
  queueTimeoutMs: 60_000,
};

/**
 * The champions a player may take into battle. Each has its own four abilities
 * on Q, W, E and R; everything else about a hero (health, mana, relics) is shared
 * and lives in `HERO`, so a duel between different champions stays even.
 *
 * `kind` is how the simulation resolves an ability:
 *   dash    a dash towards the cursor that cuts everything in its path
 *   shield  absorbs damage for a while; with `auraDamage` it also burns enemies close by
 *   strike  an instant blast at the cursor
 *   pillar  an area at the cursor that burns for `durationMs`
 *   cleave  a cone in front of the hero; `burn` keeps hurting what it hit
 *   spikes  a line from the hero towards the cursor
 *   meteor  lands at the cursor after `delayMs`; `burn` scorches the ground afterwards
 *
 * `faction` is the realm a champion hails from. It colours the lobby around it and
 * nothing else: in a match a champion fights for whichever side its player is on.
 *
 * `ratings` and each ability's `brief` are for the lobby's champion sheet alone.
 * The ratings sum the kit up, each out of 100, for a player choosing between
 * champions; the battle never reads them, and every hero has the same base
 * figures (`HERO`, `UNITS.hero`). A `brief` is the ability in one line.
 */
export const CHAMPIONS = {
  aether_knight: {
    id: 'aether_knight',
    name: 'Aether Knight',
    title: 'Rift-forged Vanguard',
    role: 'Melee Vanguard',
    faction: 'radiant',
    ratings: { health: 85, mana: 60, attack: 70, mobility: 90 },
    description:
      'A rift-forged champion who leads every charge: he dashes through the line, shrugs off a burst behind his shield and calls lightning and holy fire onto the field.',
    abilities: [
      {
        key: 'Q',
        id: 'slash_dash',
        kind: 'dash',
        name: 'Slash Dash',
        manaCost: 45,
        cooldownMs: 6_000,
        range: 6,
        width: 1.6,
        damage: 130,
        brief: 'Dash through the line, cutting every enemy in the path.',
        description: 'Dash towards the cursor, leaving an afterimage and slashing every enemy in the path.',
      },
      {
        key: 'W',
        id: 'aegis_shield',
        kind: 'shield',
        name: 'Aegis Shield',
        manaCost: 60,
        cooldownMs: 14_000,
        shield: 350,
        durationMs: 5_000,
        brief: 'A golden sphere absorbs 350 damage for 5 seconds.',
        description: 'Surround the hero with a sphere of golden energy that absorbs 350 damage for 5 seconds.',
      },
      {
        key: 'E',
        id: 'thunder_strike',
        kind: 'strike',
        name: 'Thunder Strike',
        manaCost: 80,
        cooldownMs: 10_000,
        range: 8,
        radius: 2.6,
        damage: 170,
        stunMs: 1_500,
        brief: 'Lightning strikes an area and stuns for 1.5 seconds.',
        description: 'Call down a lightning bolt at the cursor that damages enemies in the area and stuns them for 1.5 seconds.',
      },
      {
        key: 'R',
        id: 'divine_judgment',
        kind: 'pillar',
        name: 'Divine Judgment',
        manaCost: 150,
        cooldownMs: 60_000,
        range: 10,
        radius: 4.2,
        /** Total damage, dealt in equal ticks over `durationMs` once the pillar lands. */
        damage: 420,
        delayMs: 400,
        durationMs: 3_000,
        tickMs: 500,
        ultimate: true,
        brief: 'A pillar of light burns a wide area for 3 seconds.',
        description: 'Ultimate. A pillar of golden light descends at the cursor and burns every enemy inside it for 3 seconds.',
      },
    ],
  },
  morgath: {
    id: 'morgath',
    name: 'Morgath',
    title: 'Ember Tyrant',
    role: 'Ember Tyrant',
    faction: 'dire',
    ratings: { health: 75, mana: 60, attack: 90, mobility: 45 },
    description:
      'A molten warlord who stands his ground: his cleave sets the line alight, his cloak burns whoever dares come close, and stone and sky answer his call.',
    abilities: [
      {
        key: 'Q',
        id: 'magma_cleave',
        kind: 'cleave',
        name: 'Magma Cleave',
        manaCost: 45,
        cooldownMs: 6_000,
        range: 4.4,
        /** Full angle of the cone, in degrees. */
        arc: 120,
        damage: 110,
        /** Damage over time on everything the cleave hits, dealt in ticks of `tickMs`. */
        burn: { damage: 60, durationMs: 3_000, tickMs: 500 },
        brief: 'A wide molten sweep that leaves enemies burning.',
        description: 'Sweep a molten blade through a wide arc towards the cursor. Enemies it hits keep burning for 3 seconds.',
      },
      {
        key: 'W',
        id: 'flame_cloak',
        kind: 'shield',
        name: 'Flame Cloak',
        manaCost: 60,
        cooldownMs: 14_000,
        shield: 220,
        durationMs: 5_000,
        /** While the cloak holds, enemies within `auraRadius` take `auraDamage` every `tickMs`. Breaking the shield puts the fire out. */
        auraRadius: 3,
        auraDamage: 14,
        tickMs: 500,
        brief: 'Absorbs 220 damage and scorches enemies close by.',
        description: 'Wrap the hero in living fire that absorbs 220 damage. While it holds, for up to 5 seconds, it scorches every enemy close by.',
      },
      {
        key: 'E',
        id: 'obsidian_spike',
        kind: 'spikes',
        name: 'Obsidian Spike',
        manaCost: 80,
        cooldownMs: 10_000,
        range: 9,
        width: 2,
        damage: 150,
        stunMs: 1_200,
        brief: 'A row of spikes impales and stuns for 1.2 seconds.',
        description: 'A row of obsidian spikes erupts from the ground towards the cursor, impaling and stunning enemies for 1.2 seconds.',
      },
      {
        key: 'R',
        id: 'cataclysmic_meteor',
        kind: 'meteor',
        name: 'Cataclysmic Meteor',
        manaCost: 150,
        cooldownMs: 60_000,
        range: 11,
        radius: 4.4,
        damage: 300,
        delayMs: 1_200,
        stunMs: 800,
        /** The crater keeps burning: damage dealt in ticks of `tickMs` to whatever stands in it. */
        burn: { damage: 120, durationMs: 3_000, tickMs: 500 },
        ultimate: true,
        brief: 'A meteor stuns where it lands and leaves a burning crater.',
        description: 'Ultimate. Call a meteor down at the cursor. It lands after 1.2 seconds, stuns what it hits and leaves a burning crater for 3 seconds.',
      },
    ],
  },
};

/** Fixed order: the first is the default choice. */
export const CHAMPION_IDS = Object.keys(CHAMPIONS);

/** What every champion shares, whichever one a player picks: health, mana, growth and the relics. */
export const HERO = {
  maxHp: 1200,
  maxMana: 400,
  hpRegen: 3,
  manaRegen: 5,
  /** Regeneration per second while standing beside the hero's own Throne. */
  fountainRadius: 12,
  fountainHp: 70,
  fountainMana: 30,
  startGold: 600,
  goldPerSecond: 2,
  /**
   * A hero gains experience over time and from enemies that fall, and each
   * level above the first adds `levelPower` to all the damage it deals.
   */
  maxLevel: 10,
  levelPower: 0.05,
  xpPerSecond: 3,
  xpRadius: 14,
  /** Experience by what fell. A troop counts only if it falls within `xpRadius` of the hero, or to the hero's own hand. */
  xp: { unit: 12, hero: 120, tower: 150 },
  /** Experience needed to leave level `n`: `xpBase + xpStep * n`. */
  xpBase: 60,
  xpStep: 40,
  items: [
    {
      key: 'Z',
      id: 'blink_boots',
      name: 'Blink Boots',
      cost: 500,
      cooldownMs: 12_000,
      range: 7,
      description: 'Costs 500 gold to unlock. Then: teleport instantly towards the cursor.',
    },
    {
      key: 'X',
      id: 'lifesteal_blade',
      name: 'Lifesteal Blade',
      cost: 750,
      passive: true,
      lifesteal: 0.4,
      description: 'Costs 750 gold to unlock. Then: a crimson aura heals the hero for 40% of the damage it deals.',
    },
    {
      key: 'C',
      id: 'rune_bottle',
      name: 'River Rune Bottle',
      holdsRune: true,
      description: 'Walk onto the River pad to bottle its rune, then press C to drink it: Double Damage, Haste or Arcane Regen.',
    },
  ],
};

/**
 * River Runes. One of these appears on the centre pad at a time; a hero who
 * walks over it bottles it and may drink it later.
 */
export const RUNES = {
  damage: { name: 'Double Damage', durationMs: 12_000, damageMultiplier: 2, description: 'Double damage for 12 seconds.' },
  haste: { name: 'Haste', durationMs: 12_000, speedMultiplier: 1.6, description: '60% faster movement for 12 seconds.' },
  regen: { name: 'Arcane Regen', durationMs: 8_000, hpPerSecond: 60, manaPerSecond: 30, description: 'Rapidly restores health and mana for 8 seconds.' },
};

/** Fixed order, so a rune kind can be drawn by index. */
export const RUNE_KINDS = Object.keys(RUNES);

/** Share of ability damage that structures take. */
export const ABILITY_STRUCTURE_FACTOR = 0.4;

/**
 * Everything that walks or is built during a match. `range` is measured from
 * the unit's centre to the target's edge; `aggro` is how far it looks for a fight.
 * `shot` units fire a projectile, `beam` units hit instantly, the rest swing in melee.
 * `siege` is the share of their damage that Towers and Thrones take.
 * `height` and `scale` only matter to the renderer: how tall the unit stands and how large its model is drawn.
 * `spin` units hit every enemy within that distance of themselves with each attack.
 * `bounty` is the gold a hero earns for landing the killing blow (Towers and heroes pay it whoever does).
 */
export const UNITS = {
  hero: { name: 'Hero', hp: HERO.maxHp, damage: 62, siege: 0.3, range: 1.5, attackMs: 850, speed: 6.6, radius: 0.6, aggro: 4.5, bounty: 150, height: 2.3 },
  melee: { name: 'Melee Creep', hp: 300, damage: 21, siege: 0.3, range: 1.1, attackMs: 1_000, speed: 4.1, radius: 0.42, aggro: 5.5, bounty: 25, height: 1.7, scale: 1.4 },
  ranged: { name: 'Ranged Creep', hp: 190, damage: 30, siege: 0.3, range: 5.2, attackMs: 1_300, speed: 4.1, radius: 0.4, aggro: 6.5, bounty: 25, height: 1.8, scale: 1.4, shot: 'bolt', shotSpeed: 15 },
  footman: { name: 'Footman', hp: 460, damage: 40, siege: 0.3, range: 1.2, attackMs: 1_000, speed: 4.3, radius: 0.46, aggro: 5.5, bounty: 12, height: 2.3, scale: 1.45 },
  archer: { name: 'Arcane Archer', hp: 250, damage: 58, siege: 0.3, range: 6.2, attackMs: 1_150, speed: 4.1, radius: 0.42, aggro: 7, bounty: 14, height: 2.3, scale: 1.45, shot: 'arcane', shotSpeed: 17 },
  golem: { name: 'Siege Golem', hp: 2200, damage: 110, siege: 1, range: 1.5, attackMs: 1_800, speed: 2.4, radius: 1.05, aggro: 9, bounty: 60, height: 3.6, scale: 2.5, buildingsOnly: true, slam: true },
  frost_tower: { name: 'Frost Tower', hp: 900, damage: 32, siege: 1, range: 6.5, attackMs: 900, speed: 0, radius: 0.9, aggro: 6.5, bounty: 30, height: 3.6, scale: 1.25, building: true, beam: true, slow: 0.45, slowMs: 1_600, lifetimeMs: 30_000 },
  valkyrie: { name: 'Valkyrie Spinner', hp: 880, damage: 64, siege: 0.3, range: 1.3, attackMs: 1_400, speed: 4.3, radius: 0.55, aggro: 5.5, bounty: 30, height: 2.5, scale: 1.5, spin: 2.1 },
};

/** Fixed order: snapshots send a unit's type as an index into this list. */
export const UNIT_TYPES = Object.keys(UNITS);

/** Bit flags in a unit's snapshot entry. */
export const FLAG = { slowed: 1, stunned: 2, shielded: 4, dead: 8, empowered: 16, hasted: 32, regen: 64, lifesteal: 128, burning: 256 };

/**
 * Bit flags on a damage entry in a snapshot (`hits`): what kind of blow it was.
 * `spell` is an ability or a card, `hero` anything a hero dealt, `burn` damage over time.
 */
export const HIT = { spell: 1, hero: 2, burn: 4 };

/**
 * The whole card pool. A player takes `MATCH.deckSize` of these into battle.
 *
 * `zone` is where a card may be played: 'own' is the player's bank of the River,
 * 'any' is the whole field. `radius` is the footprint or area of effect.
 */
export const CARDS = [
  {
    id: 'footmen_squad',
    name: 'Footmen Squad',
    cost: 3,
    type: 'Troop',
    tagline: 'Melee trio',
    description: 'Deploys three armored footmen who march down the lane and hold the front line.',
    traits: ['3 Units', 'Melee', 'Frontline'],
    zone: 'own',
    radius: 1.3,
    spawns: 'footman',
    count: 3,
  },
  {
    id: 'arcane_archer',
    name: 'Arcane Archer',
    cost: 3,
    type: 'Troop',
    tagline: 'Ranged DPS',
    description: 'Two hooded marksmen who loose arcane bolts from safely behind the front line.',
    traits: ['2 Units', 'Ranged', 'High Damage'],
    zone: 'own',
    radius: 1,
    spawns: 'archer',
    count: 2,
  },
  {
    id: 'siege_golem',
    name: 'Siege Golem',
    cost: 5,
    type: 'Troop',
    tagline: 'High-HP tower tank',
    description: 'A lumbering stone colossus that ignores troops, marches on enemy buildings and smashes them with ground slams.',
    traits: ['1 Unit', 'Very High HP', 'Targets Buildings'],
    zone: 'own',
    radius: 1.5,
    spawns: 'golem',
    count: 1,
  },
  {
    id: 'fireball',
    name: 'Fireball',
    cost: 4,
    type: 'Spell',
    tagline: 'AoE spell',
    description: 'Hurls a blazing meteor from your Throne that explodes on impact, scorching every enemy in its radius.',
    traits: ['Area Damage', 'Hits Buildings'],
    zone: 'any',
    radius: 2.6,
    travelMs: 900,
    damage: 260,
    structureDamage: 160,
  },
  {
    id: 'frost_tower',
    name: 'Frost Tower',
    cost: 4,
    type: 'Building',
    tagline: 'Defensive slowing building',
    description: 'A crystalline turret that fires icy beams, damaging and slowing enemies in range. Lasts 30 seconds.',
    traits: ['Structure', 'Slows Enemies', '30 Seconds'],
    zone: 'own',
    radius: 1.6,
    spawns: 'frost_tower',
    count: 1,
  },
  {
    id: 'healing_wave',
    name: 'Healing Wave',
    cost: 2,
    type: 'Spell',
    tagline: 'Ally & Hero heal spell',
    description: 'A surge of restorative light that mends your Hero and every allied unit in the target area.',
    traits: ['Instant', 'Area Heal', 'Heals Hero'],
    zone: 'any',
    radius: 3.2,
    heal: 300,
  },
  {
    id: 'lightning_bolt',
    name: 'Lightning Bolt',
    cost: 2,
    type: 'Spell',
    tagline: 'Instant zap stun',
    description: 'A bolt from a clear sky. It strikes at once, shocking every enemy in a small area and stunning them for a second.',
    traits: ['Instant', 'Stuns 1s', 'Small Area'],
    zone: 'any',
    radius: 1.9,
    damage: 90,
    structureDamage: 45,
    stunMs: 1_000,
  },
  {
    id: 'valkyrie_spinner',
    name: 'Valkyrie Spinner',
    cost: 4,
    type: 'Troop',
    tagline: 'AoE axe warrior',
    description: 'A shield-maiden who wades into the thick of it and spins her great axe, cutting every enemy around her at once.',
    traits: ['1 Unit', 'Area Melee', 'Sturdy'],
    zone: 'own',
    radius: 1.2,
    spawns: 'valkyrie',
    count: 1,
  },
];

export const CARD_IDS = CARDS.map((card) => card.id);

/** The six cards a new player starts with: the original deck. */
export const DEFAULT_DECK = CARD_IDS.slice(0, MATCH.deckSize);

/**
 * A player's choice of champion and battle deck, made safe: an unknown champion
 * becomes the default one, and a deck that is not `MATCH.deckSize` different
 * cards from the pool becomes the default deck. Server and lobby share it.
 */
export function sanitizeLoadout(raw) {
  const hero = CHAMPION_IDS.includes(raw?.hero) ? raw.hero : CHAMPION_IDS[0];
  const picked = Array.isArray(raw?.deck) ? raw.deck.filter((id) => CARD_IDS.includes(id)) : [];
  const deck = picked.length === MATCH.deckSize && new Set(picked).size === MATCH.deckSize ? picked : [...DEFAULT_DECK];
  return { hero, deck };
}

function structure(side, kind, lane = null) {
  const sign = side === 'radiant' ? -1 : 1;
  const throne = kind === 'throne';
  return {
    id: throne ? `${side}_throne` : `${side}_${lane}`,
    side,
    kind,
    lane,
    label: throne ? 'Ancient Throne' : `${lane === 'top' ? 'Top' : 'Bottom'} Tower`,
    x: sign * (throne ? MAP.throneX : MAP.towerX),
    z: throne ? 0 : lane === 'top' ? -MAP.laneZ : MAP.laneZ,
    maxHp: throne ? 4000 : 2500,
    radius: throne ? 3 : 1.6,
    height: throne ? 6.4 : 5.4,
    /** Height the structure fires from. */
    muzzle: throne ? 5 : 4.6,
    damage: throne ? 140 : 100,
    range: throne ? 8 : 7.5,
    attackMs: throne ? 900 : 1_000,
    shotSpeed: 17,
    bounty: throne ? 0 : 200,
  };
}

/** Fixed order: snapshots send structure state as an array in this order. */
export const STRUCTURES = [
  structure('radiant', 'throne'),
  structure('radiant', 'tower', 'top'),
  structure('radiant', 'tower', 'bottom'),
  structure('dire', 'throne'),
  structure('dire', 'tower', 'top'),
  structure('dire', 'tower', 'bottom'),
];

/** A smooth curve through `points`, resampled about every `spacing` units. */
function spline(points, spacing) {
  const last = points.length - 1;
  // Each tangent follows the chord between a point's neighbours.
  const tangent = (i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(last, i + 1)];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(b[0] - a[0]) / span, (b[1] - a[1]) / span];
  };
  const out = [];
  for (let i = 0; i < last; i++) {
    const from = points[i];
    const to = points[i + 1];
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const m0 = tangent(i);
    const m1 = tangent(i + 1);
    const steps = Math.max(1, Math.round(length / spacing));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
      const h10 = t ** 3 - 2 * t ** 2 + t;
      const h01 = -2 * t ** 3 + 3 * t ** 2;
      const h11 = t ** 3 - t ** 2;
      out.push([0, 1].map((axis) => h00 * from[axis] + h10 * length * m0[axis] + h01 * to[axis] + h11 * length * m1[axis]));
    }
  }
  out.push(points[last]);
  return out;
}

/**
 * Lane routes from the Radiant Throne gate to the Dire one. Radiant units walk
 * them forwards and Dire units backwards. Each route winds down off the base
 * plateau, swings round the inner side of both towers and crosses the River on
 * its bridge. These are the bottom lane's control points on the Radiant bank;
 * the Dire half and the top lane are mirror images. X always increases along a
 * route, which is how a unit finds the waypoint ahead of it.
 */
const LANE_HALF = [[-33.2, 4.2], [-31.6, 8.4], [-28.4, 11.4], [-24.4, 11.7], [-20.2, 9.1], [-16.2, 10.9], [-12.4, 12.7], [-9.6, 13], [-7.4, 13]];
const LANE_SHAPE = spline([...LANE_HALF, ...LANE_HALF.map(([x, z]) => [-x, z]).reverse()], 2.2);

export const LANES = {
  top: LANE_SHAPE.map(([x, z]) => ({ x, z: -z })),
  bottom: LANE_SHAPE.map(([x, z]) => ({ x, z })),
};

/** The dirt trail from a hero's pad down the middle to the rune stairs, as [x, z] on the Dire bank; Radiant's mirrors it. */
export const TRAIL = spline([[30, 0], [26, 0.5], [22, -0.8], [18, 0.7], [14, -0.5], [11, 0], [9.6, 0]], 1.6);

export function heroSpawn(side) {
  return { x: side === 'radiant' ? -MAP.heroX : MAP.heroX, z: 0 };
}

/** X of the River's centre line at depth `z`. */
export function riverCenter(z) {
  const r = MAP.river;
  return Math.sin(z * r.freq1) * r.amp1 + Math.sin(z * r.freq2 + r.phase2) * r.amp2;
}

/** Signed distance to the water's edge: negative in the River or the rune pool. */
export function riverDistance(x, z) {
  const r = MAP.river;
  const channel = Math.abs(x - riverCenter(z)) - (r.halfWidth + r.wobble * Math.sin(z * r.wobbleFreq + r.wobblePhase));
  const pool = Math.hypot(x, z) - r.poolRadius;
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (pool - channel)) / r.blend));
  return pool + (channel - pool) * h - r.blend * h * (1 - h);
}

const onBridge = (x, z) => Math.abs(x) < MAP.bridgeHalfLength + 0.8 && Math.abs(Math.abs(z) - MAP.laneZ) < MAP.bridgeHalfWidth;

/** Whether a point lies inside the Guardian's cavern, widened by `margin`. */
export const inCavern = (x, z, margin = 0) => Math.hypot(x - MAP.cavern.x, z - MAP.cavern.z) < MAP.cavern.radius + margin;

/** Whether a unit may stand at a point: dry land, a bridge, or the rune pad and the stairs down to it. */
export function walkable(x, z) {
  if (Math.abs(x) > MAP.halfWidth || Math.abs(z) > MAP.halfDepth) return false;
  if (inCavern(x, z)) return false;
  if (riverDistance(x, z) > 0.25) return true;
  if (onBridge(x, z)) return true;
  return Math.hypot(x, z) < MAP.padRadius || (Math.abs(z) < MAP.stairsHalfWidth && Math.abs(x) < MAP.stairsEndX);
}

/* -------------------------------------------------------------------------- */
/* Terrain relief                                                             */
/* -------------------------------------------------------------------------- */

const smooth = (t) => {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return k * k * (3 - 2 * k);
};

/** Centre of each base plateau along |x|, and the radius of its flat top. */
const BASE = { x: 40, radius: 12.5 };
/**
 * Where a lane or the centre trail crosses the edge of a tier, the steep bank
 * relaxes into a ramp: [|x|, |z|, radius] of each crossing.
 */
const TERRACE_RAMPS = [[12.6, 12.2, 5], [15.4, 0, 4.6]];
const BASE_RAMPS = [[29.6, 10.4, 5], [25.4, 0, 4.6]];
/** The stairs to the rune pad run from the pad's rim up to the top of each bank. */
export const STAIRS = { foot: 3.6, top: 9.6 };

function rampAt(ax, az, ramps) {
  let k = 0;
  for (const [x, z, radius] of ramps) k = Math.max(k, smooth((radius - Math.hypot(ax - x, az - z)) / (radius * 0.45)));
  return k;
}

/** Walking height of the stairs at a distance |x| from the rune pad's centre. */
export function stairHeight(ax) {
  const k = Math.min(1, Math.max(0, (ax - STAIRS.foot) / (STAIRS.top - STAIRS.foot)));
  return LEVEL.pad + (LEVEL.bank - LEVEL.pad) * k;
}

/** Deck height of the bridge on the lane at depth `z`: the top bridge is timber, the bottom one stone. */
export function bridgeDeck(x, z) {
  const half = MAP.bridgeHalfLength;
  const arch = Math.cos((Math.min(Math.abs(x), half) / half) * (Math.PI / 2));
  return LEVEL.bridge + (z < 0 ? 0.16 + 0.42 * arch : 0.1 + 0.55 * arch);
}

/** Hills of the Radiant rim, `out` units beyond the edge of the field. */
const hills = (out, jag) => 4.2 * smooth((out - 0.4) / 5.5) * (0.72 + 0.28 * jag);

/** The Dire rim climbs in three obsidian ledges. */
function cliffs(out, jag) {
  const o = out + 0.9 * (jag - 0.5);
  return 2.4 * smooth((o - 0.3) / 1.1) + 2.3 * smooth((o - 3.4) / 1.1) + 2.6 * smooth((o - 6.8) / 1.3);
}

/** Height of the dry land, before the River is cut into it. */
function landHeight(x, z) {
  const ax = Math.abs(x);
  const az = Math.abs(z);

  // Tower terrace. Its edge wanders, bulging towards the River in front of each tower.
  const edge = 15.8 + 1.2 * Math.cos((z * Math.PI) / MAP.laneZ) + 0.35 * Math.cos(z * 0.83);
  const terraceSlope = 1.3 + 2.5 * rampAt(ax, az, TERRACE_RAMPS);
  let height = LEVEL.terrace * smooth((ax - edge + terraceSlope) / terraceSlope);

  // Base plateau: a rounded rise about each Throne.
  const fromBase = Math.hypot(ax - BASE.x, z * 0.92) + 0.5 * Math.cos(z * 0.6);
  const baseSlope = 1.4 + 3.4 * rampAt(ax, az, BASE_RAMPS);
  height += (LEVEL.base - LEVEL.terrace) * smooth((BASE.radius + baseSlope - fromBase) / baseSlope);

  // Beyond the field the ground climbs: wooded hills behind Radiant, obsidian ledges behind Dire,
  // and only a low lip along the edge nearest the camera, which must not hide the field.
  let rim = 0;
  const outX = ax - MAP.halfWidth;
  const outZ = az - MAP.halfDepth;
  if (outX > 0 || outZ > 0) {
    const jag = 0.5 + 0.5 * Math.sin(x * 0.71 + z * 0.37) * Math.sin(z * 0.53 - x * 0.29);
    const dire = smooth((x + 6) / 12);
    const far = outZ > 0 && z < 0 ? hills(outZ, jag) * (1 - dire) + cliffs(outZ, jag) * dire : 0;
    const near = outZ > 0 && z > 0 ? 0.9 * smooth((outZ - 0.4) / 3) : 0;
    const side = outX > 0 ? (x < 0 ? hills(outX, jag) : cliffs(outX, jag)) * (1 - 0.75 * smooth((z - 12) / 14)) : 0;
    rim = Math.max(far, near, side);
  }

  // The Guardian's cavern: a horseshoe of crags around a sunken pit, open towards the lanes.
  const { cavern } = MAP;
  const fromPit = Math.hypot(x - cavern.x, z - cavern.z);
  if (fromPit < cavern.radius + 0.5) {
    const angle = Math.atan2(z - cavern.z, x - cavern.x);
    const mouth = smooth((Math.cos(angle - cavern.mouth) - 0.42) / 0.3);
    // The crags stand wholly inside the circle that blocks movement, so nothing ever climbs them.
    const ring = smooth((cavern.radius + 0.3 - fromPit) / 1.9) * smooth((fromPit - cavern.pit + 0.2) / 1.7);
    const crag = 0.78 + 0.22 * Math.sin(angle * 6 + 1.3);
    rim = Math.max(rim, 4.4 * ring * (1 - mouth) * crag);
    height -= 1.5 * smooth((cavern.pit + 0.6 - fromPit) / 1.4);
  }
  return height + rim;
}

/** Height of the terrain itself at a point: plateaus, ramps, the cavern and the River's canyon. */
export function terrainHeight(x, z) {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  let bank = landHeight(x, z);
  // Each lane dips down a ramp to meet its bridge...
  const approach = smooth((11.8 - ax) / 4.2) * smooth((3.9 - Math.abs(az - MAP.laneZ)) / 1.5);
  bank += (LEVEL.bridge - bank) * approach;
  // ...and a stair is cut into each bank, down to the rune pad.
  if (az < 2.8 && ax < STAIRS.top + 0.6) bank = Math.min(bank, bank + (stairHeight(ax) - 0.12 - bank) * smooth((2.7 - az) / 0.9));

  const shore = riverDistance(x, z);
  if (shore >= 0.2) return bank;
  // The canyon wall drops from the rim to the riverbed in little more than a stride.
  return LEVEL.bed + (bank - LEVEL.bed) * smooth((shore + 1.15) / 1.35);
}

/** Height of the walking surface: the terrain, or a bridge deck, the rune pad or its stairs standing over it. */
export function groundHeight(x, z) {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const half = MAP.bridgeHalfLength;
  if (ax < half + 1 && Math.abs(az - MAP.laneZ) < MAP.bridgeHalfWidth + 0.75) {
    const deck = bridgeDeck(x, z);
    // Past the end of the deck a short lip blends onto the ramp.
    return ax <= half ? deck : deck + (terrainHeight(x, z) - deck) * (ax - half);
  }
  if (Math.hypot(x, z) < MAP.padRadius + 0.25) return LEVEL.pad;
  if (az < MAP.stairsHalfWidth + 0.45 && ax < STAIRS.top) return Math.max(terrainHeight(x, z), stairHeight(ax));
  return terrainHeight(x, z);
}

/** Whether `side` may play `card` at a point. The server enforces this; the client previews it. */
export function canDeploy(card, side, x, z) {
  if (Math.abs(x) > MAP.halfWidth - 0.5 || Math.abs(z) > MAP.halfDepth - 0.5) {
    return { ok: false, reason: 'That is outside the battlefield' };
  }
  if (card.zone === 'any') return { ok: true };

  const plural = `${card.type}s`;
  if (riverDistance(x, z) < 0.5) return { ok: false, reason: `${plural} cannot be placed in the River` };
  if (inCavern(x, z, 1)) return { ok: false, reason: `${plural} cannot be placed in the Guardian's cavern` };
  if (side === 'radiant' ? x > 0 : x < 0) {
    return { ok: false, reason: `${plural} must be placed on your side of the River` };
  }
  if (STRUCTURES.some((s) => Math.hypot(x - s.x, z - s.z) < s.radius + 0.5)) {
    return { ok: false, reason: 'Too close to a structure' };
  }
  return { ok: true };
}
