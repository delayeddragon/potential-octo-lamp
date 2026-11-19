/**
 * RuneDeck — the Codex.
 *
 * The lobby's reference page: the relics a hero can buy, the River Runes, the
 * phases of a match and the controls. Every figure on it is read from the rules
 * the match itself runs on (shared.js), so the page cannot fall out of step with
 * the game.
 *
 * The controls are the one thing written out here. match.js binds them and lists
 * them in its header; a control changed there is to be changed here as well.
 */

import { iconArt } from './paint.js';
import { CHAMPIONS, CHAMPION_IDS, HERO, MATCH, RUNES, RUNE_KINDS } from './shared.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A painted icon as an <img>. */
function picture(src) {
  const node = el('img');
  node.src = src;
  node.alt = '';
  node.draggable = false;
  return node;
}

/** A key as a keycap. A key named by a word (Space, Wheel) is cut wider than one named by a letter. */
const keycap = (label) => el('kbd', label.length > 1 ? 'keycap wide' : 'keycap', label);

/** A small fact about something: its price, how long it lasts. `kind` colours it. */
const tag = (text, kind = '') => el('span', kind ? `codex-tag is-${kind}` : 'codex-tag', text);

const seconds = (ms) => `${Number((ms / 1000).toFixed(2))}s`;
const percent = (share) => `${Math.round(share * 100)}%`;
/** A stretch of the match clock, as the clock shows it: 60000 is 01:00. */
function clock(ms) {
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Relics                                                                     */
/* -------------------------------------------------------------------------- */

function relic(item) {
  const node = el('li', 'relic');
  const icon = el('span', 'codex-icon');
  icon.append(picture(iconArt(item.id)), keycap(item.key));

  const tags = el('span', 'codex-tags');
  tags.append(tag(item.cost ? `${item.cost}g` : 'Free', 'gold'));
  if (item.cooldownMs) tags.append(tag(`${seconds(item.cooldownMs)} cooldown`));
  if (item.passive) tags.append(tag('Passive'));
  if (item.range) tags.append(tag(`Range ${item.range}`));
  if (item.lifesteal) tags.append(tag(`${percent(item.lifesteal)} lifesteal`));
  if (item.holdsRune) tags.append(tag('Holds one rune'));

  let use = `Press ${item.key} to drink the rune it holds.`;
  if (item.cost) use = item.passive ? `Press ${item.key} to buy it. Always active once owned.` : `Press ${item.key} to buy it, then ${item.key} to use it.`;

  const body = el('div', 'codex-body');
  body.append(el('strong', 'codex-name', item.name), tags, el('p', 'codex-text', item.brief), el('p', 'codex-use', use));
  node.append(icon, body);
  return node;
}

/* -------------------------------------------------------------------------- */
/* River Runes and the phases of a match                                      */
/* -------------------------------------------------------------------------- */

/** What a rune gives, in figures. */
function boon(def) {
  if (def.damageMultiplier) return `×${def.damageMultiplier} Damage`;
  if (def.speedMultiplier) return `+${percent(def.speedMultiplier - 1)} Speed`;
  return `+${def.hpPerSecond} HP/s · +${def.manaPerSecond} Mana/s`;
}

function rune(kind) {
  const def = RUNES[kind];
  const node = el('li', 'rune');
  node.dataset.rune = kind;
  const icon = el('span', 'codex-icon');
  icon.append(picture(iconArt(`rune_bottle:${kind}`)));
  const body = el('div', 'codex-body');
  const head = el('div', 'rune-head');
  head.append(el('strong', 'codex-name', def.name), tag(seconds(def.durationMs)));
  body.append(head, el('p', 'rune-boon', boon(def)));
  node.append(icon, body);
  return node;
}

/** The match clock as a bar: the battle, its last stretch at Double Elixir, and the overtime that may follow. */
function timeline() {
  const parts = [
    { id: 'battle', ms: MATCH.durationMs - MATCH.doubleElixirAtMs, at: clock(MATCH.durationMs), name: 'Battle' },
    { id: 'double', ms: MATCH.doubleElixirAtMs, at: clock(MATCH.doubleElixirAtMs), name: `${MATCH.doubleElixirFactor}× Elixir` },
    { id: 'sudden', ms: MATCH.overtimeMs, at: clock(0), name: 'Sudden Death' },
  ];
  return parts.map(({ id, ms, at, name }) => {
    const node = el('li', `timeline-part is-${id}`);
    node.style.flexGrow = String(ms);
    node.append(el('i'), el('b', '', at), el('span', '', name));
    return node;
  });
}

function phase({ id, name, badge, text }) {
  const node = el('li', `phase is-${id}`);
  const head = el('div', 'phase-head');
  head.append(el('strong', 'codex-name', name), tag(badge, id));
  node.append(head, el('p', 'codex-text', text));
  return node;
}

function phases() {
  const twice = MATCH.doubleElixirFactor === 2 ? 'twice' : `${MATCH.doubleElixirFactor} times`;
  return [
    {
      id: 'double',
      name: 'Double Elixir',
      badge: `${MATCH.doubleElixirFactor}× at ${clock(MATCH.doubleElixirAtMs)}`,
      text: `Elixir flows ${twice} as fast for the last ${clock(MATCH.doubleElixirAtMs)} on the clock, and all through overtime.`,
    },
    {
      id: 'sudden',
      name: 'Sudden Death Overtime',
      badge: `Up to ${clock(MATCH.overtimeMs)}`,
      text: 'Both Thrones standing at 00:00? The first side to lose a Tower or its Throne loses. If time runs out again, the healthier structures win.',
    },
  ].map(phase);
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

/** Every champion's abilities sit on the same keys. */
const ABILITY_KEYS = CHAMPIONS[CHAMPION_IDS[0]].abilities.map((ability) => ability.key);
const RELIC_KEYS = HERO.items.map((item) => item.key);
const CARD_KEYS = Array.from({ length: MATCH.handSize }, (_, slot) => String(slot + 1));
const RUNE_KEY = HERO.items.find((item) => item.holdsRune).key;

const CONTROLS = [
  { keys: ['RMB'], name: 'Move & Attack', note: 'Right-click the ground or an enemy' },
  { keys: ABILITY_KEYS, name: 'Hero Skills', note: 'Cast towards the cursor' },
  { keys: CARD_KEYS, name: 'Arm & Deploy Cards', note: 'Then left-click the field' },
  { keys: RELIC_KEYS, name: 'Buy & Use Relics', note: `First press buys; ${RUNE_KEY} drinks the rune` },
];

/** W is an ability, so the camera pans on A, S and D and on the arrow keys: the up arrow where W would be. */
const CAMERA = [
  { keys: ['A', 'S', 'D', 'Arrows'], name: 'Pan', note: `${ABILITY_KEYS[1]} is a skill: pan up with ↑` },
  { keys: ['Edge'], name: 'Edge Pan', note: 'Cursor against a screen edge' },
  { keys: ['Wheel'], name: 'Zoom', note: 'Closer to the field, or farther' },
  { keys: ['Space'], name: 'Lock on Hero', note: 'Press again to free the camera' },
];

function control({ keys, name, note }) {
  const node = el('li', 'control');
  const caps = el('span', 'control-keys');
  caps.append(...keys.map(keycap));
  const body = el('div', 'control-body');
  body.append(el('strong', 'codex-name', name), el('span', 'codex-use', note));
  node.append(caps, body);
  return node;
}

/* -------------------------------------------------------------------------- */

/** Writes the Codex into the page. Nothing on it changes afterwards. */
export function renderCodex() {
  $('codex-relic-keys').append(...RELIC_KEYS.map(keycap));
  $('codex-relics').append(...HERO.items.map(relic));
  $('codex-gold').append(tag(`${HERO.startGold}g`, 'gold'), ` to start, +${HERO.goldPerSecond} a second, and a bounty for every kill.`);

  $('codex-cadence').append(
    tag(`First at ${seconds(MATCH.runeFirstSpawnMs)}`),
    tag(`Every ${seconds(MATCH.runeIntervalMs)}`),
    el('span', 'codex-use', `Walk onto the River pad to bottle one; ${RUNE_KEY} drinks it.`),
  );
  $('codex-runes').append(...RUNE_KINDS.map(rune));
  $('codex-timeline').append(...timeline());
  $('codex-phases').append(...phases());

  $('codex-controls').append(...CONTROLS.map(control));
  $('codex-camera').append(...CAMERA.map(control));
  $('codex-more').append(keycap('Esc'), ' puts an armed card back', keycap('M'), ' mutes', keycap('Drag'), ' moves the map');
}
