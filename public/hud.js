/**
 * RuneDeck — in-game HUD (DOM overlay over the battlefield canvas).
 *
 * Top bar (team health, clock, rune timer), hero panel (portrait, bars,
 * abilities, relics and their gold locks, the rune bottle, running buffs),
 * card dock (hand, next card, Elixir), combat feed, minimap with the camera's
 * footprint, the health bars that float above structures and heroes, the
 * numbers that float up from the field (damage, healing, gold), the cinematic
 * banner of the opening flyover, the announcer's banners (First Blood, a Tower
 * destroyed, Double Elixir, Sudden Death…), the letterboxed closing shot of a
 * fallen Throne and the post-match summary. The audio mixer beside Leave Match
 * is its own module (mixer.js).
 *
 * `render(view, now)` runs every frame, so it only touches the DOM when a
 * displayed value actually changes.
 */

import { SIGILS, svgUrl } from './art.js';
import { cardArt, iconArt, portraitArt } from './paint.js';
import { CARDS, CHAMPIONS, FLAG, HERO, LANES, MAP, MATCH, RUNES, SIDES, STRUCTURES, STAIRS, UNIT_TYPES, groundHeight, riverCenter } from './shared.js';

const CARD_BY_ID = new Map(CARDS.map((card) => [card.id, card]));
const HERO_TYPE = UNIT_TYPES.indexOf('hero');
const GOLEM_TYPE = UNIT_TYPES.indexOf('golem');
const FROST_TYPE = UNIT_TYPES.indexOf('frost_tower');
const FEED_LIMIT = 5;
const FEED_LIFETIME_MS = 7_000;
/** World area shown by the minimap. */
const MINIMAP_W = (MAP.halfWidth + 1) * 2;
const MINIMAP_D = (MAP.halfDepth + 0.8) * 2;
const TEAM_CSS = { radiant: '#4fc3ff', dire: '#ff5a36' };
const RUNE_CSS = { damage: '#ffa41a', haste: '#5dffb0', regen: '#b48cff' };
/**
 * What floats up from the field, by kind: its CSS class, how long it stays in the air (ms), how far
 * it climbs (world units), how hard it pops as it appears, and whether it matters enough to be shown
 * when the air is already crowded. Troops trading blows do not; anything about a hero, a spell or gold does.
 */
const FLOAT_KINDS = {
  bounty: { css: 'bounty', life: 1_250, rise: 1.7, pop: 0.35, vital: true },
  heal: { css: 'heal', life: 1_050, rise: 1.5, pop: 0.3, vital: true },
  taken: { css: 'dmg taken', life: 950, rise: 1.4, pop: 0.5, vital: true },
  spell: { css: 'dmg spell', life: 950, rise: 1.6, pop: 0.6, vital: true },
  hero: { css: 'dmg hero', life: 800, rise: 1.3, pop: 0.4, vital: true },
  burn: { css: 'dmg burn', life: 600, rise: 0.9, pop: 0.2, vital: false },
  hit: { css: 'dmg', life: 600, rise: 0.9, pop: 0.2, vital: false },
};
/** How many numbers may float at once, and how many of those may be the ones that do not matter. */
const FLOAT_LIMIT = 40;
const FLOAT_LESSER_LIMIT = 26;
/** A number born this far outside the screen (CSS pixels) is not shown at all. */
const FLOAT_MARGIN_PX = 60;
const TAU = Math.PI * 2;
/**
 * How long an announcer banner stays up when nothing is waiting behind it, how soon it makes way
 * when something is, and how long it takes to leave (the `banner-out` animation in hud.css).
 */
const BANNER_MS = 3_400;
const BANNER_BRIEF_MS = 1_700;
const BANNER_OUT_MS = 450;
/** Banners that may wait their turn; an older one is dropped for a newer. */
const BANNER_QUEUE = 4;
/** The rows of the post-match summary: [snapshot field, label]. */
const SUMMARY_GROUPS = [
  ['Hero Stats', [['kills', 'Kills'], ['deaths', 'Deaths'], ['level', 'Level Reached'], ['gold', 'Gold Earned']]],
  ['Combat Stats', [['heroDamage', 'Hero Damage Dealt'], ['buildingDamage', 'Building Damage Dealt'], ['cards', 'Cards Deployed']]],
];

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function image(src, alt = '') {
  const node = el('img');
  node.src = src;
  node.alt = alt;
  node.draggable = false;
  return node;
}

/** Restarts a CSS animation class. Forces a reflow, so keep it to one-off events. */
function replay(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

export const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const count = (value) => Math.round(value ?? 0).toLocaleString('en-US');

/** `sound` is the game's SoundEngine: the HUD plays the chord a banner lands on and the buzz of a refusal. */
export function createHud({ sound = null } = {}) {
  const els = {
    top: $('hud-top'),
    timer: $('hud-timer'),
    clockMode: $('hud-clock-mode'),
    rune: $('hud-rune'),
    runeText: $('hud-rune-text'),
    leave: $('btn-leave-match'),
    respawn: $('hud-respawn'),
    feed: $('feed'),
    hint: $('hint'),
    heroPanel: $('hero-panel'),
    level: $('hud-level'),
    gold: $('hud-gold'),
    portrait: $('hud-portrait'),
    heroName: $('hud-hero-name'),
    buffs: $('hud-buffs'),
    playerName: $('hud-player-name'),
    minimap: $('minimap'),
    cameraLock: $('btn-camera-lock'),
    cinema: $('cinema'),
    finaleCaption: $('cinema-finale'),
    dock: $('dock'),
    hand: $('hand'),
    nextCard: $('next-card'),
    elixir: $('elixir'),
    elixirBoost: $('elixir-boost'),
    announce: $('announce'),
    announceText: $('announce-text'),
    announceSub: $('announce-sub'),
    abilities: $('abilities'),
    elixirCount: $('elixir-count'),
    elixirTrack: $('elixir-track'),
    ghost: $('card-ghost'),
    world: $('world-layer'),
    result: $('result'),
    resultTitle: $('result-title'),
    resultDetail: $('result-detail'),
    resultButton: $('btn-result'),
    playAgain: $('btn-play-again'),
    summaryDuration: $('summary-duration'),
    summaryWinner: $('summary-winner'),
    summaryStats: $('summary-stats'),
  };

  let me = 'radiant';
  let last = {};

  /* ---------------------------------------------------------------- Top bar */

  const teams = {};
  for (const side of SIDES) {
    const root = $(`team-${side}`);
    root.querySelector('.team-crest').replaceChildren(image(svgUrl(SIGILS[side])));
    teams[side] = {
      root,
      name: root.querySelector('.team-player'),
      fill: root.querySelector('.bar-fill'),
      ghost: root.querySelector('.bar-ghost'),
      text: root.querySelector('.bar-text'),
      indexes: STRUCTURES.flatMap((s, i) => (s.side === side ? [i] : [])),
      maxHp: STRUCTURES.reduce((sum, s) => sum + (s.side === side ? s.maxHp : 0), 0),
    };
  }

  /* ---------------------------------------------------------------- Hero panel */

  const hpBar = { fill: $('stat-hp').querySelector('.stat-fill'), ghost: $('stat-hp').querySelector('.stat-ghost'), text: $('stat-hp').querySelector('b') };
  const manaBar = { fill: $('stat-mana').querySelector('.stat-fill'), text: $('stat-mana').querySelector('b') };

  function buildSlot(def, icon, className) {
    const button = el('button', `skill ${className}`);
    button.type = 'button';
    button.dataset.key = def.key;
    const title = `${def.name} [${def.key}]${def.manaCost ? ` · ${def.manaCost} mana` : ''}\n${def.description}`;
    button.title = title;
    const art = image(icon, def.name);
    const cd = el('i', 'skill-cd');
    const cdText = el('b', 'skill-cd-text');
    button.append(art, cd, cdText, el('kbd', '', def.key));
    if (def.manaCost) button.append(el('span', 'skill-cost', String(def.manaCost)));
    if (def.cost) {
      // A relic stays under its price tag until it is bought.
      const lock = el('span', 'skill-lock');
      lock.append(el('i', 'coin'), el('b', '', String(def.cost)));
      button.append(lock);
    }
    return { def, button, art, title, cd, cdText, cooling: false, lowMana: false, shown: '', locked: null, affordable: null };
  }

  const slots = new Map();
  let abilitySlots = [];

  /** The ability bar shows the four abilities of the champion the player chose. */
  function setAbilities(champion) {
    for (const slot of abilitySlots) slots.delete(slot.def.key);
    abilitySlots = champion.abilities.map((ability) => buildSlot(ability, iconArt(ability.id), ability.ultimate ? 'ability ultimate' : 'ability'));
    for (const slot of abilitySlots) slots.set(slot.def.key, slot);
    els.abilities.replaceChildren(...abilitySlots.map((slot) => slot.button));
  }
  for (const item of HERO.items) {
    const slot = buildSlot(item, iconArt(item.id), item.holdsRune ? 'item empty' : 'item');
    slots.set(item.key, slot);
    $('items').append(slot.button);
  }
  const runeSlot = slots.get(HERO.items.find((item) => item.holdsRune).key);
  // Paint ahead everything the HUD shows later, so no icon is painted in the middle of a match.
  for (const kind of Object.keys(RUNES)) iconArt(`rune_bottle:${kind}`);
  for (const card of CARDS) cardArt(card.id);
  for (const champion of Object.values(CHAMPIONS)) {
    portraitArt(champion.id);
    for (const ability of champion.abilities) iconArt(ability.id);
  }
  const relicSlots = [...slots.values()].filter((slot) => slot.def.cost);

  /* ---------------------------------------------------------------- Card dock */

  function buildCard(className, key) {
    const root = el(key ? 'button' : 'div', className);
    if (key) root.type = 'button';
    const cost = el('span', 'hc-cost');
    const costText = el('b');
    cost.append(costText);
    const art = el('img', 'hc-art');
    art.alt = '';
    art.draggable = false;
    const name = el('span', 'hc-name');
    root.append(art, name, cost);
    if (key) root.append(el('kbd', '', key), el('i', 'hc-charge'));
    return { root, art, name, costText, lack: -1 };
  }

  function fillCard(view, card) {
    view.root.className = view.root.className.replace(/\btype-\w+/g, '').trim();
    view.root.classList.add(`type-${card.type.toLowerCase()}`);
    view.art.src = cardArt(card.id);
    view.name.textContent = card.name;
    view.costText.textContent = String(card.cost);
    view.root.title = `${card.name} · ${card.cost} Elixir · ${card.type}\n${card.description}`;
  }

  const hand = Array.from({ length: MATCH.handSize }, (_, slot) => {
    const view = buildCard('hand-card', String(slot + 1));
    view.root.dataset.slot = String(slot);
    els.hand.append(view.root);
    return view;
  });
  const next = buildCard('hand-card mini');
  els.nextCard.append(next.root);
  const ghost = buildCard('hand-card');
  els.ghost.append(ghost.root);

  // Ten segments: each whole point of Elixir lights one, and the next fills as it charges.
  const elixirSegments = Array.from({ length: MATCH.elixirMax }, () => {
    const segment = el('span', 'elixir-seg');
    const fill = el('i');
    segment.append(fill);
    els.elixirTrack.append(segment);
    return { segment, fill, shown: -1 };
  });

  /* ---------------------------------------------------------------- World health bars */

  function worldBar(className, x, y, z, units, named) {
    const root = el('div', `wbar ${className}`);
    const barGhost = el('i', 'wb-ghost');
    const fill = el('i', 'wb-fill');
    const name = named ? el('span', 'wb-name') : null;
    root.append(barGhost, fill);
    if (name) root.append(name);
    els.world.append(root);
    return { root, ghost: barGhost, fill, name, x, y, z, units, flashedAt: 0 };
  }

  const structureBars = STRUCTURES.map((s) =>
    worldBar(`${s.side} ${s.kind}`, s.x, groundHeight(s.x, s.z) + s.height + 0.75, s.z, s.kind === 'throne' ? 4.6 : 3, false),
  );
  // Hero bars follow their heroes; the match controller places them every frame.
  const heroBars = {};
  for (const side of SIDES) heroBars[side] = worldBar(`${side} hero`, 0, 0, 0, 2.3, true);
  const worldBars = [...structureBars, ...Object.values(heroBars)];

  function setBar(bar, fraction) {
    const scale = `scaleX(${Math.max(0, Math.min(1, fraction)).toFixed(4)})`;
    bar.fill.style.transform = scale;
    if (bar.ghost) bar.ghost.style.transform = scale;
  }

  /* ---------------------------------------------------------------- Floating text */

  /** World to CSS pixels; the match controller supplies it with every layout. */
  let projectWorld = null;
  /** Numbers in the air, oldest first, and the nodes of those that have gone, kept to be used again. */
  const floats = [];
  const spareFloats = [];

  function dropFloat(index) {
    const [item] = floats.splice(index, 1);
    item.node.hidden = true;
    spareFloats.push(item.node);
  }

  /** Puts `text` in the air over a world point. Returns false if it was not worth showing. */
  function float(text, x, y, z, kind = 'bounty', { own = false, big = false } = {}) {
    const spec = FLOAT_KINDS[kind];
    if (!projectWorld || !spec) return false;
    const at = projectWorld(x, y, z);
    if (at.x < -FLOAT_MARGIN_PX || at.x > window.innerWidth + FLOAT_MARGIN_PX || at.y < -FLOAT_MARGIN_PX || at.y > window.innerHeight + FLOAT_MARGIN_PX) return false;
    if (!spec.vital && floats.length >= FLOAT_LESSER_LIMIT) return false;
    if (floats.length >= FLOAT_LIMIT) {
      // The air is full: a number that matters takes the place of the oldest that does not, or of the oldest.
      const lesser = floats.findIndex((item) => !item.spec.vital);
      dropFloat(lesser === -1 ? 0 : lesser);
    }
    const node = spareFloats.pop() ?? els.world.appendChild(el('span'));
    node.className = `float-text ${spec.css}${own ? ' own' : ''}${big ? ' big' : ''}`;
    node.textContent = text;
    node.style.opacity = '0';
    node.hidden = false;
    // Numbers over the same head fan out a little rather than stack.
    floats.push({ node, spec, x: x + (Math.random() - 0.5) * 0.7, y, z, drift: (Math.random() - 0.5) * 0.9, at: performance.now() });
    return true;
  }

  function drawFloats(now) {
    for (let i = floats.length - 1; i >= 0; i--) {
      const item = floats[i];
      const { spec } = item;
      const k = Math.max(0, (now - item.at) / spec.life);
      if (k >= 1 || !projectWorld) {
        dropFloat(i);
        continue;
      }
      // Pops, climbs fast and slows, then fades.
      const point = projectWorld(item.x + item.drift * k, item.y + spec.rise * (1 - (1 - k) ** 2), item.z);
      const pop = 1 + spec.pop * Math.sin(Math.min(1, k * 5) * Math.PI);
      item.node.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
      item.node.style.opacity = k < 0.6 ? '1' : (1 - (k - 0.6) / 0.4).toFixed(2);
    }
  }

  /* ---------------------------------------------------------------- Announcer */

  /** Banners waiting their turn, and when the one on screen appeared (0 when none is). */
  const banners = [];
  let bannerShownAt = 0;
  let bannerTimer = 0;

  /** One piece of a banner's second line: plain text, a player's name in their side's colour, or a gold tag. */
  function bannerPart(part) {
    if (typeof part === 'string') return part;
    if (part.gold) return el('span', 'banner-gold', part.text);
    const name = el('b', '', part.text);
    name.dataset.side = part.side;
    return name;
  }

  function showBanner() {
    clearTimeout(bannerTimer);
    const next = banners.shift();
    if (!next) {
      bannerShownAt = 0;
      els.announce.classList.remove('show', 'out');
      return;
    }
    bannerShownAt = performance.now();
    els.announce.dataset.tone = next.tone;
    els.announceText.textContent = next.title;
    els.announceSub.replaceChildren(...(next.sub ?? []).map(bannerPart));
    els.announce.classList.remove('out');
    replay(els.announce, 'show');
    // The chord lands with the banner, not when it was asked for: a banner may have waited its turn.
    sound?.play('banner', { tone: next.tone });
    bannerTimer = setTimeout(hideBanner, banners.length ? BANNER_BRIEF_MS : BANNER_MS);
  }

  function hideBanner() {
    els.announce.classList.add('out');
    bannerTimer = setTimeout(showBanner, BANNER_OUT_MS);
  }

  function clearAnnouncer() {
    clearTimeout(bannerTimer);
    banners.length = 0;
    bannerShownAt = 0;
    els.announce.classList.remove('show', 'out');
  }

  /* ---------------------------------------------------------------- Minimap */

  const mapContext = els.minimap.getContext('2d');
  const mapBase = document.createElement('canvas');
  const pings = [];
  const struckAt = STRUCTURES.map(() => 0);

  function paintMinimapBase() {
    const { width: w, height: h } = mapBase;
    const g = mapBase.getContext('2d');
    const sx = w / MINIMAP_W;
    const sz = h / MINIMAP_D;
    const X = (x) => (x + MINIMAP_W / 2) * sx;
    const Z = (z) => (z + MINIMAP_D / 2) * sz;

    const ground = g.createLinearGradient(0, 0, w, 0);
    ground.addColorStop(0, '#0d4126');
    ground.addColorStop(0.46, '#17663a');
    ground.addColorStop(0.54, '#2c1318');
    ground.addColorStop(1, '#170a0e');
    g.fillStyle = ground;
    g.fillRect(0, 0, w, h);

    // High ground on each bank: the tower terrace, and the base plateau about its Throne.
    for (const sign of [-1, 1]) {
      g.fillStyle = sign < 0 ? 'rgba(150, 235, 170, 0.09)' : 'rgba(255, 130, 100, 0.08)';
      g.fillRect(sign < 0 ? 0 : X(15.8), 0, sign < 0 ? X(-15.8) : w - X(15.8), h);
      g.beginPath();
      g.ellipse(X(sign * 40), Z(0), 12.5 * sx, 13.6 * sz, 0, 0, TAU);
      g.fill();
    }

    // Roads: each lane from Throne to Throne, and the trail down the middle to the rune stairs.
    g.strokeStyle = 'rgba(232, 238, 250, 0.3)';
    g.lineJoin = g.lineCap = 'round';
    g.lineWidth = 2.6 * sx;
    for (const lane of [LANES.top, LANES.bottom]) {
      g.beginPath();
      g.moveTo(X(-MAP.throneX), Z(0));
      for (const point of lane) g.lineTo(X(point.x), Z(point.z));
      g.lineTo(X(MAP.throneX), Z(0));
      g.stroke();
    }
    g.lineWidth = 1.5 * sx;
    g.beginPath();
    g.moveTo(X(-MAP.heroX), Z(0));
    g.lineTo(X(MAP.heroX), Z(0));
    g.stroke();

    g.strokeStyle = '#2fd3f5';
    g.lineCap = 'butt';
    g.lineWidth = MAP.river.halfWidth * 2 * sx;
    g.beginPath();
    for (let z = -MINIMAP_D / 2; z <= MINIMAP_D / 2; z += 0.5) g.lineTo(X(riverCenter(z)), Z(z));
    g.stroke();
    g.fillStyle = '#2fd3f5';
    g.beginPath();
    g.arc(X(0), Z(0), MAP.river.poolRadius * sx, 0, TAU);
    g.fill();

    const half = MAP.bridgeHalfLength;
    g.fillStyle = '#b88a55';
    g.fillRect(X(-half), Z(-MAP.laneZ - 2.4), half * 2 * sx, 4.8 * sz);
    g.fillStyle = '#b4bdcb';
    g.fillRect(X(-half), Z(MAP.laneZ - 2.4), half * 2 * sx, 4.8 * sz);
    // The stairs down to the rune pad.
    g.fillStyle = '#8496aa';
    g.fillRect(X(-STAIRS.top), Z(-MAP.stairsHalfWidth), STAIRS.top * 2 * sx, MAP.stairsHalfWidth * 2 * sz);

    // The Guardian's cavern: ground nobody can cross.
    const { cavern } = MAP;
    g.fillStyle = '#18222e';
    g.beginPath();
    g.arc(X(cavern.x), Z(cavern.z), cavern.radius * sx, 0, TAU);
    g.fill();
    g.strokeStyle = '#3fe8ff';
    g.lineWidth = 0.5 * sx;
    g.stroke();
    g.fillStyle = '#3fe8ff';
    g.beginPath();
    g.arc(X(cavern.x), Z(cavern.z), 1.3 * sx, 0, TAU);
    g.fill();
  }

  function drawMinimap(view, now) {
    const { width: w, height: h } = els.minimap;
    if (!mapBase.width) return;
    const g = mapContext;
    const sx = w / MINIMAP_W;
    const sz = h / MINIMAP_D;
    const X = (x) => (x + MINIMAP_W / 2) * sx;
    const Z = (z) => (z + MINIMAP_D / 2) * sz;
    const diamond = (x, z, r) => {
      g.beginPath();
      g.moveTo(X(x), Z(z) - r);
      g.lineTo(X(x) + r, Z(z));
      g.lineTo(X(x), Z(z) + r);
      g.lineTo(X(x) - r, Z(z));
      g.closePath();
    };

    g.drawImage(mapBase, 0, 0);

    // Rune pad: lit in the rune's colour and pulsing while one waits on it.
    diamond(0, 0, (view.rune ? 3.5 + 0.6 * Math.sin(now / 180) : 3) * sx);
    g.fillStyle = view.rune ? RUNE_CSS[view.rune] : '#0b3a52';
    g.fill();
    g.lineWidth = 0.5 * sx;
    g.strokeStyle = view.rune ? '#ffffff' : '#9ff7ff';
    g.stroke();

    STRUCTURES.forEach((s, i) => {
      const alive = view.hp[i] > 0;
      const struck = now - struckAt[i] < 900 && Math.floor(now / 120) % 2 === 0;
      g.fillStyle = !alive ? 'rgba(120, 124, 140, 0.55)' : struck ? '#ffffff' : TEAM_CSS[s.side];
      g.strokeStyle = 'rgba(4, 6, 12, 0.9)';
      g.lineWidth = 0.5 * sx;
      if (s.kind === 'throne') {
        diamond(s.x, s.z, 3.5 * sx);
      } else {
        g.beginPath();
        g.rect(X(s.x) - 1.7 * sx, Z(s.z) - 1.7 * sx, 3.4 * sx, 3.4 * sx);
      }
      g.fill();
      g.stroke();
    });

    // Troops are dots and Frost Towers squares; heroes are drawn last, the player's own ringed in white.
    for (const [, type, sideIndex, x, z, , , , flags] of view.units) {
      if (type === HERO_TYPE || flags & FLAG.dead) continue;
      const r = (type === GOLEM_TYPE ? 1.4 : type === FROST_TYPE ? 1.1 : 0.8) * sx;
      g.fillStyle = TEAM_CSS[SIDES[sideIndex]];
      if (type === FROST_TYPE) {
        g.fillRect(X(x) - r, Z(z) - r, r * 2, r * 2);
      } else {
        g.beginPath();
        g.arc(X(x), Z(z), r, 0, TAU);
        g.fill();
      }
    }
    for (const [, type, sideIndex, x, z, , , , flags] of view.units) {
      if (type !== HERO_TYPE || flags & FLAG.dead) continue;
      const side = SIDES[sideIndex];
      g.beginPath();
      g.arc(X(x), Z(z), 1.8 * sx, 0, TAU);
      g.fillStyle = TEAM_CSS[side];
      g.fill();
      g.lineWidth = (side === me ? 0.8 : 0.5) * sx;
      g.strokeStyle = side === me ? '#ffffff' : 'rgba(4, 6, 12, 0.9)';
      g.stroke();
    }

    for (let i = pings.length - 1; i >= 0; i--) {
      const k = (now - pings[i].at) / 1400;
      if (k >= 1) {
        pings.splice(i, 1);
        continue;
      }
      g.lineWidth = 0.6 * sx;
      for (const lag of [0, 0.25]) {
        const ring = (k + lag) % 1;
        g.strokeStyle = `rgba(255, 224, 138, ${1 - ring})`;
        g.beginPath();
        g.arc(X(pings[i].x), Z(pings[i].z), (1 + ring * 6) * sx, 0, TAU);
        g.stroke();
      }
    }

    // The camera's footprint: the patch of ground now on screen, wider at its far edge.
    if (view.footprint) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = Math.max(1.5, 0.4 * sx);
      g.lineJoin = 'miter';
      g.beginPath();
      view.footprint.forEach((corner, i) => {
        if (i) g.lineTo(X(corner.x), Z(corner.z));
        else g.moveTo(X(corner.x), Z(corner.z));
      });
      g.closePath();
      g.stroke();
    }
  }

  /* ---------------------------------------------------------------- Frame render */

  function render(view, now) {
    const seconds = Math.ceil(view.timeLeftMs / 1000);
    if (seconds !== last.seconds) {
      last.seconds = seconds;
      els.timer.textContent = clock(seconds);
      els.timer.classList.toggle('urgent', seconds <= 30);
    }
    if (view.overtime !== last.overtime) {
      last.overtime = view.overtime;
      els.timer.classList.toggle('overtime', view.overtime);
      els.timer.setAttribute('aria-label', view.overtime ? 'Sudden death overtime remaining' : 'Match time remaining');
      els.clockMode.hidden = !view.overtime;
    }
    const runeSeconds = Math.ceil(view.runeInMs / 1000);
    if (runeSeconds !== last.runeSeconds || view.rune !== last.padRune) {
      last.runeSeconds = runeSeconds;
      last.padRune = view.rune;
      els.runeText.textContent = view.rune
        ? `${RUNES[view.rune].name} is up`
        : `Rune ${Math.floor(runeSeconds / 60)}:${String(runeSeconds % 60).padStart(2, '0')}`;
      els.rune.classList.toggle('up', Boolean(view.rune));
      els.rune.style.setProperty('--rune', view.rune ? RUNE_CSS[view.rune] : '');
    }

    // Structure bars and the team totals they add up to.
    view.hp.forEach((hp, i) => {
      if (hp === last.hp[i]) return;
      // Under steady fire the bar flashes at most twice a second.
      if (last.hp[i] !== undefined && hp < last.hp[i] && now - structureBars[i].flashedAt > 500) {
        structureBars[i].flashedAt = now;
        replay(structureBars[i].root, 'hit');
      }
      last.hp[i] = hp;
      setBar(structureBars[i], hp / STRUCTURES[i].maxHp);
      structureBars[i].root.classList.toggle('dead', hp <= 0);
    });
    for (const side of SIDES) {
      const team = teams[side];
      const total = team.indexes.reduce((sum, i) => sum + view.hp[i], 0);
      if (total === last.totals[side]) continue;
      last.totals[side] = total;
      setBar(team, total / team.maxHp);
      team.text.textContent = `${Math.ceil(total)} / ${team.maxHp}`;
    }

    // Hero.
    const hp = Math.ceil(view.hero.hp);
    if (hp !== last.heroHp) {
      last.heroHp = hp;
      setBar(hpBar, hp / HERO.maxHp);
      setBar(heroBars[me], hp / HERO.maxHp);
      hpBar.text.textContent = `${hp} / ${HERO.maxHp}`;
    }
    const foeHp = Math.ceil(view.foeHp);
    if (foeHp !== last.foeHp) {
      last.foeHp = foeHp;
      setBar(heroBars[me === 'radiant' ? 'dire' : 'radiant'], foeHp / HERO.maxHp);
    }
    // The bottle fills with the colour of the rune it holds.
    if (view.hero.rune !== last.rune) {
      const kind = view.hero.rune;
      last.rune = kind;
      runeSlot.art.src = iconArt(kind ? `rune_bottle:${kind}` : 'rune_bottle');
      runeSlot.button.classList.toggle('empty', !kind);
      runeSlot.button.classList.toggle('charged', Boolean(kind));
      runeSlot.button.style.setProperty('--rune', kind ? RUNE_CSS[kind] : '');
      runeSlot.button.title = kind ? `${runeSlot.def.name} [${runeSlot.def.key}] · holds ${RUNES[kind].name}\n${RUNES[kind].description}` : runeSlot.title;
    }
    // Relics wear a price tag until bought; the tag lights up once the gold is there.
    for (const slot of relicSlots) {
      const locked = !view.hero.owned?.[slot.def.key];
      const affordable = locked && view.hero.gold >= slot.def.cost;
      if (locked !== slot.locked) {
        const bought = slot.locked === true && !locked;
        slot.locked = locked;
        slot.button.classList.toggle('locked', locked);
        slot.button.classList.toggle('active', !locked && Boolean(slot.def.passive));
        if (bought) replay(slot.button, 'ready');
      }
      if (affordable !== slot.affordable) {
        slot.affordable = affordable;
        slot.button.classList.toggle('affordable', affordable);
      }
    }
    // Rune effects still running, each with its seconds left.
    let buffs = '';
    for (const kind in view.hero.buffs) {
      const seconds = Math.ceil((view.hero.buffs[kind] - view.hero.buffAge) / 1000);
      if (seconds > 0) buffs += `${kind}:${seconds} `;
    }
    if (buffs !== last.buffs) {
      last.buffs = buffs;
      els.buffs.replaceChildren(
        ...buffs
          .trim()
          .split(' ')
          .filter(Boolean)
          .map((entry) => {
            const [kind, seconds] = entry.split(':');
            const chip = el('span', 'buff', `${RUNES[kind].name} ${seconds}s`);
            chip.style.setProperty('--rune', RUNE_CSS[kind]);
            chip.title = RUNES[kind].description;
            return chip;
          }),
      );
    }
    const respawn = Math.ceil(view.hero.respawnMs / 1000);
    if (respawn !== last.respawn) {
      last.respawn = respawn;
      els.heroPanel.classList.toggle('dead', respawn > 0);
      els.respawn.textContent = respawn > 0 ? String(respawn) : '';
    }
    const mana = Math.floor(view.hero.mana);
    if (mana !== last.mana) {
      last.mana = mana;
      setBar(manaBar, mana / HERO.maxMana);
      manaBar.text.textContent = `${mana} / ${HERO.maxMana}`;
    }
    if (view.hero.gold !== last.gold) {
      last.gold = view.hero.gold;
      els.gold.textContent = String(view.hero.gold);
    }
    // The badge wears a ring that fills as the next level draws near; at the top level it stays full.
    const xp = view.hero.level >= HERO.maxLevel ? 100 : Math.round((view.hero.xp ?? 0) * 100);
    if (view.hero.level !== last.level || xp !== last.xp) {
      last.level = view.hero.level;
      last.xp = xp;
      els.level.textContent = String(view.hero.level);
      els.level.style.setProperty('--xp', String(xp / 100));
      els.level.title = view.hero.level >= HERO.maxLevel ? `Level ${view.hero.level} (maximum)` : `Level ${view.hero.level} · ${xp}% to level ${view.hero.level + 1}`;
    }

    // Cooldown sweeps.
    for (const slot of slots.values()) {
      const remaining = view.cooldowns[slot.def.key] ?? 0;
      const cooling = remaining > 0;
      if (cooling) {
        slot.cd.style.setProperty('--p', (remaining / slot.def.cooldownMs).toFixed(3));
        const text = remaining >= 1000 ? String(Math.ceil(remaining / 1000)) : (remaining / 1000).toFixed(1);
        if (text !== slot.shown) {
          slot.shown = text;
          slot.cdText.textContent = text;
        }
      }
      if (cooling !== slot.cooling) {
        slot.cooling = cooling;
        slot.button.classList.toggle('cooling', cooling);
        if (!cooling) {
          slot.shown = '';
          slot.cdText.textContent = '';
          replay(slot.button, 'ready');
        }
      }
      const lowMana = Boolean(slot.def.manaCost) && view.hero.mana < slot.def.manaCost;
      if (lowMana !== slot.lowMana) {
        slot.lowMana = lowMana;
        slot.button.classList.toggle('low-mana', lowMana);
      }
    }

    // Elixir: a full segment glows; the one being charged fills smoothly from the left.
    elixirSegments.forEach((item, index) => {
      const amount = Math.round(Math.min(1, Math.max(0, view.elixir - index + 1e-6)) * 200) / 200;
      if (amount === item.shown) return;
      item.shown = amount;
      item.fill.style.transform = `scaleX(${amount})`;
      item.segment.classList.toggle('full', amount === 1);
    });
    const whole = Math.floor(view.elixir + 1e-6);
    if (whole !== last.whole) {
      last.whole = whole;
      els.elixirCount.textContent = String(whole);
      els.elixirTrack.classList.toggle('maxed', whole >= MATCH.elixirMax);
    }

    // Hand.
    view.hand.forEach((id, slot) => {
      const card = CARD_BY_ID.get(id);
      const cardView = hand[slot];
      if (id !== last.hand[slot]) {
        const drawn = last.hand[slot] !== undefined;
        last.hand[slot] = id;
        fillCard(cardView, card);
        if (drawn) replay(cardView.root, 'drawn');
      }
      const lack = Math.round(Math.max(0, 1 - view.elixir / card.cost) * 100);
      if (lack !== cardView.lack) {
        cardView.lack = lack;
        cardView.root.style.setProperty('--lack', String(lack / 100));
        cardView.root.classList.toggle('unaffordable', lack > 0);
      }
      const armed = view.armed === slot;
      if (armed !== last.armed[slot]) {
        last.armed[slot] = armed;
        cardView.root.classList.toggle('armed', armed);
      }
    });
    if (view.next !== last.next) {
      last.next = view.next;
      fillCard(next, CARD_BY_ID.get(view.next));
    }

    drawMinimap(view, now);
    drawFloats(now);
  }

  /* ---------------------------------------------------------------- Public API */

  let hintTimer = 0;

  /** Marks the Elixir bar as running at double speed for the rest of the match; `surge` also plays the neon flash. */
  function setDoubleElixir(on, surge = false) {
    els.elixir.classList.toggle('double', on);
    els.elixirBoost.hidden = !on;
    els.elixir.classList.remove('surge');
    if (on && surge) replay(els.elixir, 'surge');
  }

  /** Tab stays inside the summary: it is a modal dialog, and the game behind it is over. */
  els.result.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const buttons = [els.playAgain, els.resultButton];
    const at = buttons.indexOf(document.activeElement);
    const next = buttons[(at + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length];
    event.preventDefault();
    next.focus();
  });

  return {
    els,
    render,

    /** Resets the HUD for a new match. `players` maps each side to { nickname, isBot, hero }, `hero` being a champion id. */
    setup({ side, players }) {
      me = side;
      last = { hp: [], totals: {}, hand: [], armed: [] };
      for (const item of elixirSegments) item.shown = -1;
      for (const name of SIDES) {
        const champion = CHAMPIONS[players[name].hero];
        teams[name].name.textContent = players[name].nickname;
        teams[name].root.title = `${players[name].nickname} · ${champion.name}`;
        teams[name].root.classList.toggle('you', name === side);
        // A bot's champion goes by its own name: the enemy on the field is Morgath, not a nickname.
        heroBars[name].name.textContent = players[name].isBot ? champion.name : players[name].nickname;
        heroBars[name].root.classList.toggle('you', name === side);
      }
      const champion = CHAMPIONS[players[side].hero];
      setAbilities(champion);
      els.portrait.src = portraitArt(champion.id);
      els.portrait.alt = champion.name;
      els.heroName.textContent = champion.name;
      els.heroPanel.dataset.side = side;
      els.heroPanel.dataset.hero = champion.id;
      setDoubleElixir(false);
      clearAnnouncer();
      els.buffs.replaceChildren();
      while (floats.length) dropFloat(0);
      els.playerName.textContent = players[side].nickname;
      els.feed.replaceChildren();
      els.hint.classList.remove('show');
      els.result.hidden = true;
      els.ghost.hidden = true;
      for (const bar of worldBars) bar.root.classList.remove('dead', 'hit');
      for (const slot of slots.values()) {
        slot.cooling = slot.lowMana = false;
        slot.locked = slot.affordable = null;
        slot.shown = '';
        slot.cdText.textContent = '';
        slot.button.classList.remove('cooling', 'low-mana', 'ready', 'deny', 'locked', 'affordable', 'active');
      }
      for (const cardView of hand) cardView.lack = -1;
      pings.length = 0;
      struckAt.fill(0);
    },

    /** Sizes the floating bars and the minimap. `project` maps world to CSS pixels. */
    layout(project, pixelsPerUnit) {
      projectWorld = project;
      for (const bar of worldBars) bar.root.style.width = `${(bar.units * pixelsPerUnit).toFixed(1)}px`;
      for (const bar of structureBars) bar.at = '';
      const rect = els.minimap.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * ratio));
      const h = Math.max(1, Math.round(rect.height * ratio));
      if (w !== els.minimap.width || h !== els.minimap.height) {
        els.minimap.width = mapBase.width = w;
        els.minimap.height = mapBase.height = h;
        paintMinimapBase();
      }
    },

    /** Keeps each structure's health bar over its structure as the camera moves. Runs every frame. */
    track() {
      if (!projectWorld) return;
      for (const bar of structureBars) {
        const point = projectWorld(bar.x, bar.y, bar.z);
        const at = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px) translateX(-50%)`;
        if (at === bar.at) continue;
        bar.at = at;
        bar.root.style.transform = at;
      }
    },

    /** Moves a hero's floating bar to a screen point, or hides it while the hero is dead. */
    placeHero(side, x, y, visible) {
      const bar = heroBars[side];
      if (visible !== bar.shown) {
        bar.shown = visible;
        bar.root.style.display = visible ? '' : 'none';
      }
      if (visible) bar.root.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translateX(-50%)`;
    },

    feed(text, tone = 'info') {
      const item = el('li', `feed-item ${tone}`, text);
      els.feed.append(item);
      while (els.feed.children.length > FEED_LIMIT) els.feed.firstElementChild.remove();
      setTimeout(() => {
        item.classList.add('leaving');
        setTimeout(() => item.remove(), 400);
      }, FEED_LIFETIME_MS);
    },

    /**
     * Text that pops out of a world point and floats up: a damage number, a heal, the gold for a kill.
     * `kind` is one of `FLOAT_KINDS`; `own` marks damage to the player's own troops and `big` a heavy blow.
     */
    float,

    /** Brief message near the bottom centre, for rejected actions. */
    hint(text) {
      sound?.play('deny');
      els.hint.textContent = text;
      els.hint.classList.add('show');
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => els.hint.classList.remove('show'), 1_700);
    },

    pressSlot: (key) => replay(slots.get(key).button, 'pressed'),
    denySlot: (key) => replay(slots.get(key).button, 'deny'),
    denyCard: (slot) => replay(hand[slot].root, 'deny'),

    showGhost(cardId, x, y) {
      fillCard(ghost, CARD_BY_ID.get(cardId));
      els.ghost.hidden = false;
      els.ghost.style.transform = `translate(${x}px, ${y}px)`;
    },
    moveGhost(x, y) {
      els.ghost.style.transform = `translate(${x}px, ${y}px)`;
    },
    hideGhost() {
      els.ghost.hidden = true;
    },

    /** World point under a client position on the minimap: null if outside it, or with `clamp` the nearest point on it. */
    minimapToWorld(clientX, clientY, clamp = false) {
      const rect = els.minimap.getBoundingClientRect();
      let u = (clientX - rect.left) / rect.width;
      let v = (clientY - rect.top) / rect.height;
      if (clamp) {
        u = Math.min(1, Math.max(0, u));
        v = Math.min(1, Math.max(0, v));
      } else if (u < 0 || u > 1 || v < 0 || v > 1) {
        return null;
      }
      return { x: (u - 0.5) * MINIMAP_W, z: (v - 0.5) * MINIMAP_D };
    },

    /** Shows whether the camera is locked on the hero. */
    setCameraLocked(locked) {
      els.cameraLock.classList.toggle('on', locked);
      els.cameraLock.setAttribute('aria-pressed', String(locked));
      els.cameraLock.title = locked ? 'Camera locked on your hero. Press Space to free it.' : 'Free camera. Press Space to lock it on your hero.';
    },

    /** The cinematic layer: 'overview' during the flyover, 'fight' as it lands, 'finale' for the closing shot, 'off' otherwise. */
    cinema(phase) {
      els.cinema.dataset.phase = phase;
      if (phase !== 'finale') els.finaleCaption.classList.remove('show');
    },
    /**
     * The closing shot's caption, shown as the structure goes up: "The Dire Ancient Throne — Has Fallen".
     * `side` is whose structure it was, and `outcome` ('victory' or 'defeat') colours the verdict.
     */
    caption(subject, verdict, side, outcome) {
      const [first, , last] = els.finaleCaption.children;
      first.textContent = subject;
      last.textContent = verdict;
      els.finaleCaption.dataset.side = side;
      els.finaleCaption.dataset.outcome = outcome;
      els.finaleCaption.classList.add('show');
    },
    ping(x, z) {
      pings.push({ x, z, at: performance.now() });
    },
    markStruck(index) {
      struckAt[index] = performance.now();
    },

    /**
     * An announcer banner under the scoreboard: a `title`, and a second line `sub` made of strings,
     * player names ({ text, side }) and gold tags ({ text, gold: true }). `tone` picks its colours and
     * its chord: 'blood', 'kill', 'streak', 'rampage', 'radiant', 'dire', 'elixir' or 'overtime'.
     * Banners that arrive together are shown one after another, each a little shorter.
     */
    announce({ title, tone, sub }) {
      if (banners.length >= BANNER_QUEUE) banners.shift();
      banners.push({ title, tone, sub });
      if (!bannerShownAt) {
        showBanner();
      } else if (!els.announce.classList.contains('out')) {
        // The banner on screen makes way sooner.
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(hideBanner, Math.max(0, BANNER_BRIEF_MS - (performance.now() - bannerShownAt)));
      }
    },

    /** Takes down the banner on screen and forgets those waiting: the match is over. */
    clearAnnouncer,

    /** Puts the banners `top` CSS pixels down the screen: just under the scoreboard. */
    placeAnnouncer(top) {
      els.announce.style.setProperty('--announce-top', `${Math.round(top)}px`);
    },

    setDoubleElixir,

    /**
     * The post-match summary. `columns` lists the two players, the player's own first:
     * { side, name, hero, you, stats }; `winner` is a side or null. Focus moves to the Play Again button.
     */
    showSummary({ outcome, title, detail, durationMs, overtime, winner, columns }) {
      const winning = columns.find((column) => column.side === winner);
      els.result.dataset.outcome = outcome;
      els.resultTitle.textContent = title;
      els.resultDetail.textContent = detail;
      els.summaryDuration.textContent = overtime ? `${clock(Math.round(durationMs / 1000))} (overtime)` : clock(Math.round(durationMs / 1000));
      els.summaryWinner.textContent = winning ? winning.name : 'None: a draw';
      els.summaryWinner.dataset.side = winning?.side ?? '';

      const table = el('table', 'summary-table');
      table.append(el('caption', 'summary-caption', 'Match statistics'));
      const head = el('tr');
      head.append(el('td'));
      for (const column of columns) {
        const cell = el('th');
        cell.scope = 'col';
        cell.dataset.side = column.side;
        cell.classList.toggle('you', column.you);
        const who = el('span', 'st-name');
        who.append(el('b', '', column.name));
        who.title = column.name;
        cell.append(el('span', 'st-tag', column.you ? 'You' : 'Enemy'), who, el('i', '', column.hero));
        head.append(cell);
      }
      const thead = el('thead');
      thead.append(head);
      table.append(thead);
      for (const [group, rows] of SUMMARY_GROUPS) {
        const body = el('tbody');
        const heading = el('tr', 'st-group');
        const label = el('th', '', group);
        label.colSpan = 3;
        label.scope = 'colgroup';
        heading.append(label);
        body.append(heading);
        for (const [field, name] of rows) {
          const row = el('tr');
          const th = el('th', '', name);
          th.scope = 'row';
          row.append(th);
          for (const column of columns) row.append(el('td', column.you ? 'you' : '', count(column.stats?.[field])));
          body.append(row);
        }
        table.append(body);
      }
      els.summaryStats.replaceChildren(table);
      els.result.hidden = false;
      els.result.scrollTop = 0;
      els.playAgain.focus();
    },
  };
}
