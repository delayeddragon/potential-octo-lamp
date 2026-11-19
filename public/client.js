/* ==========================================================================
   RuneDeck — lobby client
   The navigation bar and the four screens behind its tabs (Play, Heroes, Deck
   and Codex), the 3D stage they are laid over (lobby-stage.js), and matchmaking.
   The Codex's own page is written by codex.js.
   It also owns the sound engine, so that the first click anywhere on the page
   (Find Match, usually) is what allows the battle to be heard: it starts the
   lobby's music, gives the interface its ticks and clicks, and mounts the
   audio mixer in the navigation bar and in the match HUD.
   ========================================================================== */

import { renderCodex } from './codex.js';
import { bindMuteKey, createMixer } from './mixer.js';
import { cardArt, iconArt, portraitArt } from './paint.js';
import { CARDS, CHAMPIONS, CHAMPION_IDS, MATCH, UNITS, sanitizeLoadout } from './shared.js';
import { SoundEngine } from './sound.js';

const NICK_STORAGE_KEY = 'runedeck.nickname';
const LOADOUT_STORAGE_KEY = 'runedeck.loadout';
/** The build these scripts belong to: the server puts it in their URL. */
const BUILD = new URL(import.meta.url).pathname.match(/^\/build\/([^/]+)\//)?.[1] ?? null;
const RELOADED_FOR_KEY = 'runedeck.reloadedFor';
const NICK_MAX_LENGTH = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * 88;
/** How long the queue modal shows its result before the versus screen takes over. */
const RESOLVE_BEAT_MS = 900;
/** How often the search for an opponent is heard: a radar pulse. */
const QUEUE_PULSE_MS = 2_000;
/**
 * How long a search lasts before an AI bot takes the other side: one minute, a rule
 * of the game. The server times the search by the same figure, so everything the
 * lobby says and shows about it (01:00) comes from here and from nowhere else.
 */
const QUEUE_TIMEOUT_MS = MATCH.queueTimeoutMs;

/** The lobby's screens, in the order of their tabs. */
const TABS = ['play', 'heroes', 'deck', 'codex'];
const REALM_NAMES = { radiant: 'Radiant', dire: 'Dire' };

/**
 * Champions still to come. They stand in the roster as locked silhouettes and
 * exist nowhere else: `bust` and `mark` are the silhouette's outline and what it
 * carries, drawn in a 64 x 64 box.
 */
const TEASERS = [
  {
    id: 'sylva',
    name: 'Sylva',
    role: 'Frost Ranger',
    tint: '#8fe3ff',
    bust: 'M32 9c-8.5 0-14 7-14 16.5 0 5 1.6 9.3 4.4 12.3L11.5 42.5C7.5 44.3 5 48 5 52.5V64h54V52.5c0-4.5-2.5-8.2-6.5-10L41.6 37.8c2.8-3 4.4-7.3 4.4-12.3C46 16 40.5 9 32 9Z',
    mark: 'M12 6c9 9 11 30 1 45M12 6 13 51M50 5l5.5 15M55 4l4 14',
  },
  {
    id: 'vex',
    name: 'Vex',
    role: 'Void Weaver',
    tint: '#b79bff',
    bust: 'M32 4 21.5 19.5c-2.9 4.3-3.9 8.8-2.9 13.3.7 3.3 2.1 5.7 3.9 7.6L11.5 44.5C7.5 46.3 5 50 5 54.5V64h54v-9.5c0-4.5-2.5-8.2-6.5-10L41.5 40.4c1.8-1.9 3.2-4.3 3.9-7.6 1-4.5 0-9-2.9-13.3Z',
    mark: 'M52 9.5a4.5 4.5 0 1 0 .01 0ZM52 2.5v2.5M52 19v2.5M43.5 14H46M58 14h2.5M10 12l3 4.5-3 4.5-3-4.5Z',
  },
];

const QUEUE_MESSAGES = [
  'Scanning the realm for a worthy rival…',
  'Channeling the River Rune…',
  'Rallying footmen at the barracks…',
  "Sharpening your champion's blade…",
  'Listening for war horns across the river…',
];

/** Queue ring colour by progress: Radiant cyan, then gold, then Dire crimson. */
const RING_STOPS = [
  [0, [47, 211, 245]],
  [0.6, [246, 226, 160]],
  [1, [240, 65, 58]],
];

function ringColor(progress) {
  const next = RING_STOPS.findIndex(([at]) => at >= progress);
  if (next <= 0) return `rgb(${RING_STOPS[0][1].join(', ')})`;
  const [fromAt, from] = RING_STOPS[next - 1];
  const [toAt, to] = RING_STOPS[next];
  const mix = (progress - fromAt) / (toAt - fromAt);
  return `rgb(${from.map((channel, i) => Math.round(channel + (to[i] - channel) * mix)).join(', ')})`;
}

/** Small line drawings the lobby builds for itself: everything else is in the page or painted (paint.js). */
const GLYPHS = {
  mana: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c4 5 6.5 8.4 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 11.4 8 8 12 3Z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** One of `GLYPHS` in a span of its own. */
function glyph(name, className) {
  const node = el('span', className);
  node.innerHTML = GLYPHS[name];
  return node;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* -------------------------------------------------------------------------- */
/* State and DOM                                                              */
/* -------------------------------------------------------------------------- */

const dom = {
  app: $('app'),
  tabs: [...document.querySelectorAll('#tabs .tab')],
  screens: Object.fromEntries(TABS.map((tab) => [tab, $(`screen-${tab}`)])),
  /** The box each screen keeps clear for the champion on the stage. */
  spots: Object.fromEntries(TABS.map((tab) => [tab, $(`screen-${tab}`).querySelector('.hero-spot')])),
  nickname: $('nickname'),
  plateRealm: $('plate-realm'),
  plateName: $('plate-name'),
  plateTitle: $('plate-title'),
  loadoutPortrait: $('loadout-portrait'),
  loadoutName: $('loadout-name'),
  loadoutRole: $('loadout-role'),
  loadoutRealm: $('loadout-realm'),
  loadoutAvg: $('loadout-avg'),
  loadoutDeck: $('loadout-deck'),
  changeHeroBtn: $('btn-change-hero'),
  editDeckBtn: $('btn-edit-deck'),
  modeLimit: $('mode-limit'),
  roster: $('roster'),
  rosterCount: $('roster-count'),
  heroTurn: $('hero-turn'),
  sheet: $('sheet'),
  sheetRealm: $('sheet-realm'),
  sheetRole: $('sheet-role'),
  sheetName: $('sheet-name'),
  sheetLore: $('sheet-lore'),
  meters: [...$('sheet-meters').children],
  sheetKit: $('sheet-kit'),
  equipBtn: $('btn-equip'),
  equipLabel: $('equip-label'),
  battleDeck: $('battle-deck'),
  deck: $('deck'),
  deckCount: $('deck-count'),
  deckAvg: $('deck-avg'),
  deckMix: $('deck-mix'),
  swapBar: $('swap-bar'),
  swapText: $('swap-text'),
  cancelSwapBtn: $('btn-cancel-swap'),
  filters: $('filters'),
  collection: $('collection'),
  collectionCount: $('collection-count'),
  inspector: $('inspector'),
  inspectArt: $('inspect-art'),
  inspectType: $('inspect-type'),
  inspectZone: $('inspect-zone'),
  inspectName: $('inspect-name'),
  inspectTagline: $('inspect-tagline'),
  inspectCost: $('inspect-cost'),
  inspectTraits: $('inspect-traits'),
  inspectDesc: $('inspect-desc'),
  inspectStats: $('inspect-stats'),
  equipCardBtn: $('btn-equip-card'),
  equipCardLabel: $('equip-card-label'),
  findBtn: $('btn-find'),
  conn: $('conn'),
  connText: $('conn-text'),
  lobbyStats: $('lobby-stats'),
  queueModal: $('queue-modal'),
  queuePanel: $('queue-panel'),
  queueTitle: $('queue-title'),
  queueProgress: $('queue-progress'),
  queueTimer: $('queue-timer'),
  queueLimit: $('queue-limit'),
  queueStatus: $('queue-status'),
  queueHint: $('queue-hint'),
  cancelBtn: $('btn-cancel'),
  spawnBotBtn: $('btn-spawn-bot'),
  matchOverlay: $('match-overlay'),
  matchMode: $('match-mode'),
  matchStatusLabel: $('match-status-label'),
  matchCount: $('match-count'),
  matchNote: $('match-note'),
  matchLoad: $('match-load'),
  loadLabel: $('load-label'),
  loadPercent: $('load-percent'),
  loadTrack: $('load-track'),
  loadFill: $('load-fill'),
  leaveBtn: $('btn-leave'),
  toasts: $('toasts'),
  tooltip: $('tooltip'),
};

const state = {
  /** @type {'lobby' | 'queue' | 'match' | 'game'} */
  phase: 'lobby',
  /** @type {'play' | 'heroes' | 'deck' | 'codex'} The lobby screen on show. */
  tab: 'play',
  connected: false,
  config: null,
  queue: { startedAt: 0, running: false },
  match: null,
  /** The player's equipped champion and Battle Deck (`MATCH.deckSize` card ids); `reserve` holds the rest of the pool. */
  loadout: { hero: CHAMPION_IDS[0], deck: [], reserve: [] },
  /** The champion on show on the Heroes tab: looked over there, and taken into battle only once it is equipped. */
  inspect: CHAMPION_IDS[0],
  /** The card in the deck screen's inspector. */
  card: CARDS[0].id,
  /** Swap Mode: the Reserve card in the inspector is waiting for the Battle Deck card it replaces. */
  swapping: false,
  /** Which of the collection is shown: 'all', or one card type. */
  filter: 'all',
  resolveTimer: 0,
  countdownTimer: 0,
  pulseTimer: 0,
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const stage = createStage();
/** Every sound and all the music of the game. It wakes on the player's first click or key press. */
const sound = new SoundEngine();
sound.setMusic('lobby');
/** The same mixer twice: in the navigation bar, and beside Leave Match in the match HUD. */
const mixers = [createMixer($('lobby-mixer'), sound), createMixer($('hud-mixer'), sound)];
bindMuteKey(sound);
const socket = typeof window.io === 'function' ? window.io() : null;

function setPhase(phase) {
  state.phase = phase;
  document.body.dataset.phase = phase;
  // Keep keyboard focus inside whichever overlay is open.
  dom.app.inert = phase !== 'lobby';
  // The loadout is locked while queueing and playing; a half-made swap is dropped.
  if (phase !== 'lobby') setSwapping(false);
  for (const mixer of mixers) mixer.close();
  hideTooltip();
  // The battle has the whole machine: the stage draws nothing from the moment a match begins until the lobby is back.
  stage.setPaused(phase === 'game');
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function formatClock(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* The stage                                                                  */
/* -------------------------------------------------------------------------- */

/** The box on screen the champion stands in: each screen keeps one clear for it. */
function heroSpot() {
  return dom.spots[state.tab].getBoundingClientRect();
}

/**
 * The hall behind the lobby and the champion standing in it (lobby-stage.js).
 * Its scripts, Three.js among them, are fetched once the lobby is up and usable;
 * until they have run, and in a browser without WebGL 2, the sky the stylesheet
 * paints holds the page. What the lobby asks of the stage in the meantime is
 * kept here and handed over when it arrives.
 */
function createStage() {
  const want = { hero: CHAMPION_IDS[0], view: 'play', energy: 0, paused: false, busy: false };
  let live = null;

  return {
    async open() {
      document.body.dataset.stage = 'loading';
      try {
        const { createLobbyStage } = await import('./lobby-stage.js');
        const made = await createLobbyStage($('stage'), {
          spot: heroSpot,
          dragSurface: dom.heroTurn,
          hero: want.hero,
          view: want.view,
          // A machine that cannot keep the hall smooth is not asked to blur it behind every panel as well.
          onQuality: (quality) => document.body.classList.toggle('lite', quality < 1),
        });
        // Whatever was asked for while it was being built.
        made.setHero(want.hero);
        made.setView(want.view);
        made.setEnergy(want.energy);
        made.setBusy(want.busy);
        made.setPaused(want.paused);
        live = made;
        document.body.dataset.stage = 'live';
        // Console diagnostics: runedeck.lobby.stats() reports the stage's FPS, framing and champion.
        window.runedeck = { ...window.runedeck, lobby: { stats: made.stats, lockQuality: made.lockQuality } };
      } catch (error) {
        console.warn('The lobby stage could not start; the lobby goes on without it.', error);
        document.body.dataset.stage = 'off';
      }
    },
    /** Puts a champion on the pedestal; with `flourish` it salutes with its weapon. */
    setHero(id, options) {
      want.hero = id;
      live?.setHero(id, options);
    },
    /** Frames the champion for a tab. */
    setView(name) {
      want.view = name;
      live?.setView(name);
    },
    /** 0 in the quiet lobby, 1 while a search is on. */
    setEnergy(value) {
      want.energy = value;
      live?.setEnergy(value);
    },
    flash() {
      live?.flash();
    },
    /** Stops the stage drawing altogether, or starts it again. */
    setPaused(value) {
      want.paused = value;
      live?.setPaused(value);
    },
    /** The page is busy building the battlefield: slow frames are not the stage's doing. */
    setBusy(value) {
      want.busy = value;
      live?.setBusy(value);
    },
  };
}

/** The champion on the pedestal: whoever is being looked over on the Heroes tab, the equipped one everywhere else. */
function shownHero() {
  return state.tab === 'heroes' ? state.inspect : state.loadout.hero;
}

/** Puts the champion its screen calls for on the pedestal, and turns the lobby to that champion's realm. */
function presentHero({ flourish = false } = {}) {
  const champion = CHAMPIONS[shownHero()];
  document.body.dataset.realm = champion.faction;
  stage.setHero(champion.id, { flourish });
}

/* -------------------------------------------------------------------------- */
/* Interface sounds                                                           */
/* -------------------------------------------------------------------------- */

/** Buttons that say something of their own when pressed; the plain click would only muddy it. */
const OWN_VOICE = '#btn-find, #btn-equip, #btn-equip-card, #btn-cancel-swap, .roster-card, .deck-card, .pool-card, .hand-card, .skill, .mixer-mute';
/** The match's own controls are passed over many times a minute: they do not tick under the pointer. */
const NO_HOVER = '.hand-card, .skill';

/** A button that will not act: disabled outright, or only marked so to keep its place in the tab order. */
const isOff = (button) => button.disabled || button.getAttribute('aria-disabled') === 'true';

let hovered = null;
/** Where the mouse last was. A button that turns up under a mouse that has not moved was redrawn, not found. */
const mouseAt = { x: NaN, y: NaN };

// Every button on the page, the tabs among them, ticks as the mouse comes over it, and latches when it is pressed.
document.addEventListener('pointerover', (event) => {
  if (event.pointerType !== 'mouse') return;
  const button = event.target.closest?.('button') ?? null;
  if (button === hovered) return;
  hovered = button;
  const moved = event.clientX !== mouseAt.x || event.clientY !== mouseAt.y;
  if (moved && button && !isOff(button) && !button.matches(NO_HOVER)) sound.play('uiHover');
});
// The browser reports what the mouse has come over before it reports the move, so `mouseAt` is still where it was.
for (const type of ['pointermove', 'pointerdown', 'pointerup']) {
  document.addEventListener(
    type,
    (event) => {
      mouseAt.x = event.clientX;
      mouseAt.y = event.clientY;
    },
    { capture: true, passive: true },
  );
}
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('button');
  if (button && !isOff(button) && !button.matches(OWN_VOICE)) sound.play('uiClick');
});

/* -------------------------------------------------------------------------- */
/* Toasts and tooltips                                                        */
/* -------------------------------------------------------------------------- */

function toast(message, tone = 'info', duration = 4200) {
  const node = el('div', `toast toast-${tone}`, message);
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  dom.toasts.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 320);
  }, duration);
}

let tooltipOwner = null;

function showTooltip(owner, content) {
  const tip = dom.tooltip;
  tooltipOwner = owner;
  tip.replaceChildren(content);

  const rect = owner.getBoundingClientRect();
  const tipWidth = tip.offsetWidth;
  const tipHeight = tip.offsetHeight;
  const left = clamp(rect.left + rect.width / 2 - tipWidth / 2, 8, window.innerWidth - tipWidth - 8);
  const fitsBelow = rect.bottom + 14 + tipHeight <= window.innerHeight - 8;
  const above = !fitsBelow && rect.top - 14 - tipHeight >= 8;
  const top = above ? rect.top - 14 - tipHeight : rect.bottom + 14;

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.style.setProperty('--arrow-x', `${Math.round(clamp(rect.left + rect.width / 2 - left, 16, tipWidth - 16))}px`);
  tip.classList.toggle('above', above);
  tip.classList.add('visible');
}

function hideTooltip(owner) {
  if (owner && owner !== tooltipOwner) return;
  tooltipOwner = null;
  dom.tooltip.classList.remove('visible');
}

function bindTooltip(owner, build) {
  const show = () => showTooltip(owner, build());
  const hide = () => hideTooltip(owner);
  owner.addEventListener('pointerenter', show);
  owner.addEventListener('pointerleave', hide);
  owner.addEventListener('focus', show);
  owner.addEventListener('blur', hide);
}

function buildTooltip({ name, cost, typeClass, typeLine, description, traits }) {
  const fragment = document.createDocumentFragment();
  const head = el('div', 'tip-head');
  head.append(el('span', 'tip-name', name));
  if (cost != null) {
    const costNode = el('span', 'tip-cost');
    costNode.append(el('i', 'elixir-drop'), el('span', '', `${cost} Elixir`));
    head.append(costNode);
  }
  const traitList = el('ul', 'tip-traits');
  traitList.append(...traits.map((trait) => el('li', '', trait)));
  fragment.append(head, el('div', `tip-type ${typeClass}`, typeLine), el('p', 'tip-desc', description), traitList);
  return fragment;
}

function cardTooltip(card) {
  return buildTooltip({
    name: card.name,
    cost: card.cost,
    typeClass: `type-${card.type.toLowerCase()}`,
    typeLine: `${card.type} · ${card.tagline}`,
    description: card.description,
    traits: card.traits,
  });
}

/* -------------------------------------------------------------------------- */
/* Navigation: tabs and nickname                                              */
/* -------------------------------------------------------------------------- */

/**
 * Opens one of the lobby's screens. The stage follows: the camera eases to the
 * framing that screen asks for. With `focus` the keyboard goes to the screen's
 * tab, for when what was pressed to get there is on the screen being left.
 */
function setTab(name, { focus = false } = {}) {
  if (!TABS.includes(name) || state.phase !== 'lobby') return;
  if (name !== state.tab) {
    // A swap left waiting for its slot is dropped when the deck screen is left.
    setSwapping(false);
    hideTooltip();
    state.tab = name;
    document.body.dataset.tab = name;
    for (const tab of dom.tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const tab of TABS) dom.screens[tab].hidden = tab !== name;
    // The Heroes tab always opens on the equipped champion: one only looked over steps down when the tab is left.
    state.inspect = state.loadout.hero;
    if (name === 'heroes') {
      markRoster();
      renderSheet({ replay: true });
    }
    // The inspector's bars fill as its screen comes into view.
    if (name === 'deck') renderInspector();
    stage.setView(name);
    presentHero();
  }
  if (focus) dom.tabs[TABS.indexOf(name)].focus();
}

/** The tab list's arrow keys: the arrows open the next screen, wrapping at both ends, and Home and End the first and last. */
function onTabKey(event) {
  const index = TABS.indexOf(state.tab);
  const to = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  sound.play('uiClick');
  setTab(TABS[(to + TABS.length) % TABS.length], { focus: true });
}

function initTabs() {
  for (const tab of dom.tabs) {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
    tab.addEventListener('keydown', onTabKey);
  }
  dom.changeHeroBtn.addEventListener('click', () => setTab('heroes', { focus: true }));
  dom.editDeckBtn.addEventListener('click', () => setTab('deck', { focus: true }));
}

function cleanNickname(value) {
  const cleaned = value.replace(/[^\p{L}\p{N} _\-.']/gu, '').replace(/\s+/g, ' ');
  return [...cleaned].slice(0, NICK_MAX_LENGTH).join('');
}

/** Returns the nickname to queue with, generating one if the field is empty. */
function commitNickname() {
  let nickname = cleanNickname(dom.nickname.value).trim();
  if (!nickname) nickname = `Knight-${1000 + Math.floor(Math.random() * 9000)}`;
  dom.nickname.value = nickname;
  storeNickname(nickname);
  return nickname;
}

function storeNickname(nickname) {
  try {
    localStorage.setItem(NICK_STORAGE_KEY, nickname);
  } catch {
    // Storage can be unavailable (private mode); the nickname just won't persist.
  }
}

function initNickname() {
  try {
    dom.nickname.value = cleanNickname(localStorage.getItem(NICK_STORAGE_KEY) ?? '');
  } catch {
    dom.nickname.value = '';
  }
  // Kept as it is typed, so a name is not lost to a page closed with the field still open.
  dom.nickname.addEventListener('input', () => {
    const cleaned = cleanNickname(dom.nickname.value);
    if (cleaned !== dom.nickname.value) dom.nickname.value = cleaned;
    storeNickname(cleaned.trim());
  });
  dom.nickname.addEventListener('change', () => {
    dom.nickname.value = dom.nickname.value.trim();
    storeNickname(dom.nickname.value);
  });
  dom.nickname.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'Escape') dom.nickname.blur();
  });
}

/* -------------------------------------------------------------------------- */
/* Loadout: the equipped champion and the Battle Deck                         */
/* -------------------------------------------------------------------------- */

/** A painted illustration as an <img>. */
function painting(src) {
  const node = el('img');
  node.src = src;
  node.alt = '';
  node.draggable = false;
  return node;
}

const CARDS_BY_ID = Object.fromEntries(CARDS.map((card) => [card.id, card]));

/** Where a deck-builder card sits: the Battle Deck or the Reserve. */
function zoneOf(cardId) {
  return state.loadout.deck.includes(cardId) ? 'deck' : 'reserve';
}

function averageCost(deck) {
  return deck.reduce((sum, id) => sum + CARDS_BY_ID[id].cost, 0) / deck.length;
}

function storeLoadout() {
  try {
    localStorage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify({ hero: state.loadout.hero, deck: state.loadout.deck }));
  } catch {
    // Storage can be unavailable (private mode); the loadout just won't persist.
  }
}

/** Applies a champion and deck, filling the Reserve with the pool cards the deck leaves out. */
function setLoadout(raw) {
  const { hero, deck } = sanitizeLoadout(raw);
  state.loadout = { hero, deck, reserve: CARDS.map((card) => card.id).filter((id) => !deck.includes(id)) };
}

function initLoadout() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LOADOUT_STORAGE_KEY));
  } catch {
    // Unreadable or missing: start from the defaults.
  }
  setLoadout(saved);
  state.inspect = state.loadout.hero;
  renderRoster();
  renderSheet();
  renderChampion();
  renderLoadoutDeck();
  state.card = state.loadout.deck[0];
  renderFilters();
  renderDeckBuilder({ intro: true });
  renderInspector();
  showSwapBar();
  presentHero();
}

function showRealm(node, realm) {
  node.dataset.realm = realm;
  setText(node, REALM_NAMES[realm]);
}

/** The equipped champion, wherever the Play screen names it: on the nameplate beside the pedestal and in the Battle Loadout. */
function renderChampion() {
  const champion = CHAMPIONS[state.loadout.hero];
  showRealm(dom.plateRealm, champion.faction);
  setText(dom.plateName, champion.name);
  setText(dom.plateTitle, champion.title);
  dom.loadoutPortrait.replaceChildren(painting(portraitArt(champion.id)));
  setText(dom.loadoutName, champion.name);
  setText(dom.loadoutRole, champion.role);
  showRealm(dom.loadoutRealm, champion.faction);
}

/** The Battle Deck in small, on the Play screen, with what it costs on average. */
function renderLoadoutDeck() {
  const { deck } = state.loadout;
  dom.loadoutDeck.replaceChildren(
    ...deck.map((id) => {
      const card = CARDS_BY_ID[id];
      const item = el('li', `mini-card type-${card.type.toLowerCase()}`);
      item.setAttribute('aria-label', `${card.name}, ${card.cost} Elixir`);
      const cost = el('span', 'card-cost');
      cost.append(el('span', '', String(card.cost)));
      const art = el('span', 'card-art');
      art.append(painting(cardArt(card.id)));
      item.append(cost, art);
      bindTooltip(item, () => cardTooltip(card));
      return item;
    }),
  );
  dom.loadoutAvg.textContent = averageCost(deck).toFixed(1);
}

/* -------------------------------------------------------------------------- */
/* Heroes: the roster and the champion sheet                                  */
/* -------------------------------------------------------------------------- */

/** The roster: a radio group, one card per champion, and the champions still to come standing locked at its foot. */
function renderRoster() {
  const cards = CHAMPION_IDS.map((id) => {
    const champion = CHAMPIONS[id];
    const card = el('button', 'roster-card');
    card.type = 'button';
    card.dataset.champion = id;
    card.dataset.realm = champion.faction;
    card.setAttribute('role', 'radio');

    const portrait = el('span', 'roster-portrait');
    portrait.append(painting(portraitArt(id)));
    const text = el('span', 'roster-text');
    text.append(el('span', 'roster-name', champion.name), el('span', 'roster-role', champion.role));
    card.append(portrait, text, el('span', 'roster-flag', 'Equipped'));

    card.addEventListener('click', () => inspectChampion(id));
    card.addEventListener('keydown', onRosterKey);
    return card;
  });

  const locked = TEASERS.map((teaser) => {
    const card = el('button', 'roster-card is-locked');
    card.type = 'button';
    card.style.setProperty('--card', teaser.tint);
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', 'false');
    card.setAttribute('aria-disabled', 'true');
    card.tabIndex = -1;

    const portrait = el('span', 'roster-portrait');
    portrait.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true"><path class="bust" d="${teaser.bust}"/><path class="mark" d="${teaser.mark}"/></svg>`;
    portrait.append(glyph('lock', 'roster-lock'));
    const text = el('span', 'roster-text');
    text.append(el('span', 'roster-name', teaser.name), el('span', 'roster-role', teaser.role));
    card.append(portrait, text, el('span', 'soon-tag', 'Coming Soon'));

    // A locked champion cannot be chosen: it says so, and shakes its head.
    card.addEventListener('click', () => {
      sound.play('deny');
      card.classList.remove('is-denied');
      void card.offsetWidth;
      card.classList.add('is-denied');
    });
    return card;
  });

  dom.roster.replaceChildren(
    ...[...cards, ...locked].map((card) => {
      const item = el('li');
      item.setAttribute('role', 'none');
      item.append(card);
      return item;
    }),
  );
  setText(dom.rosterCount, `${cards.length} / ${cards.length + locked.length}`);
  markRoster();
}

/** Radio-group arrow keys: the arrows move the choice among the champions that can be chosen, wrapping at both ends. */
function onRosterKey(event) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const index = CHAMPION_IDS.indexOf(state.inspect);
  inspectChampion(CHAMPION_IDS[(index + step + CHAMPION_IDS.length) % CHAMPION_IDS.length], true);
}

/**
 * Brings a champion onto the pedestal to be looked over. It answers with a
 * flourish of its weapon and its own fanfare; it is not taken into battle until
 * Equip Champion is pressed.
 */
function inspectChampion(id, moveFocus = false) {
  if (state.phase !== 'lobby') return;
  if (id !== state.inspect) {
    // Each champion answers in its own voice, and before the page is redrawn: sound does not wait for pictures.
    sound.play('heroSelect', { hero: id });
    state.inspect = id;
    markRoster();
    renderSheet();
  } else {
    sound.play('uiClick');
  }
  // Even the champion already standing there salutes when it is picked again.
  presentHero({ flourish: true });
  if (moveFocus) dom.roster.querySelector(`[data-champion="${id}"]`).focus();
}

/** Radio state: the champion on show is checked and the only tab stop; the equipped one wears its flag. */
function markRoster() {
  for (const card of dom.roster.querySelectorAll('[data-champion]')) {
    const id = card.dataset.champion;
    const chosen = id === state.inspect;
    card.setAttribute('aria-checked', String(chosen));
    card.tabIndex = chosen ? 0 : -1;
    card.querySelector('.roster-flag').hidden = id !== state.loadout.hero;
  }
}

const counting = new WeakMap();

/** Counts a figure on screen from `from` up or down to `to`. */
function countTo(node, to, from) {
  cancelAnimationFrame(counting.get(node));
  if (reducedMotion.matches || from === to) {
    node.textContent = String(to);
    return;
  }
  const startedAt = performance.now();
  const step = (now) => {
    const t = clamp((now - startedAt) / 800, 0, 1);
    node.textContent = String(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    if (t < 1) counting.set(node, requestAnimationFrame(step));
  };
  step(startedAt);
}

/**
 * The sheet of the champion on show: its realm and role, the four stat bars,
 * its abilities and the button that equips it. With `replay` the bars fill from
 * empty, as they do when the sheet comes into view; otherwise they slide from
 * the last champion's figures to this one's.
 */
function renderSheet({ replay = false } = {}) {
  const champion = CHAMPIONS[state.inspect];
  dom.sheet.dataset.realm = champion.faction;
  showRealm(dom.sheetRealm, champion.faction);
  setText(dom.sheetRole, champion.role);
  setText(dom.sheetName, champion.name);
  setText(dom.sheetLore, champion.description);

  for (const meter of dom.meters) {
    const rating = champion.ratings[meter.dataset.stat] ?? 0;
    const readout = meter.querySelector('.meter-value');
    if (replay) {
      // Emptied without the slide, so that the fill which follows is seen from nothing.
      meter.classList.add('is-reset');
      meter.style.setProperty('--value', '0');
      void meter.offsetWidth;
      meter.classList.remove('is-reset');
    }
    meter.style.setProperty('--value', String(rating / 100));
    countTo(readout, rating, replay ? 0 : Number(readout.textContent) || 0);
  }

  hideTooltip();
  dom.sheetKit.setAttribute('aria-label', `${champion.name} abilities`);
  dom.sheetKit.replaceChildren(
    ...champion.abilities.map((ability, index) => {
      const seconds = ability.cooldownMs / 1000;
      const item = el('li', ability.ultimate ? 'kit-card is-ultimate' : 'kit-card');
      item.tabIndex = 0;
      item.style.setProperty('--i', index);
      item.setAttribute('aria-label', `${ability.key}: ${ability.name}. ${ability.manaCost} mana, ${seconds} second cooldown. ${ability.description}`);

      const icon = el('span', 'kit-icon');
      icon.append(painting(iconArt(ability.id)), el('kbd', '', ability.key));
      const mana = el('span', 'kit-stat kit-mana', String(ability.manaCost));
      mana.prepend(glyph('mana'));
      mana.title = 'Mana cost';
      const cooldown = el('span', 'kit-stat kit-cooldown', `${seconds}s`);
      cooldown.prepend(glyph('clock'));
      cooldown.title = 'Cooldown';
      const head = el('div', 'kit-head');
      head.append(el('strong', 'kit-name', ability.name), mana, cooldown);
      const body = el('div', 'kit-body');
      body.append(head, el('p', 'kit-brief', ability.brief));
      item.append(icon, body);

      bindTooltip(item, () =>
        buildTooltip({
          name: ability.name,
          typeClass: 'type-hero',
          typeLine: `${ability.ultimate ? 'Ultimate' : 'Ability'} ${ability.key} · ${champion.name}`,
          description: ability.description,
          traits: [`${ability.manaCost} Mana`, `${seconds}s Cooldown`],
        }),
      );
      return item;
    }),
  );
  markEquip();
}

/** The button under the sheet: an invitation to equip the champion on show, or the word that it is the one equipped. */
function markEquip() {
  const equipped = state.inspect === state.loadout.hero;
  dom.equipBtn.classList.toggle('is-equipped', equipped);
  // Marked rather than disabled, so that the keyboard stays on the button it has just pressed.
  dom.equipBtn.setAttribute('aria-disabled', String(equipped));
  setText(dom.equipLabel, equipped ? 'Equipped' : 'Equip Champion');
}

/** Takes the champion on show into battle: it becomes the equipped one, here and on the Play screen, and is remembered. */
function equipChampion() {
  if (state.phase !== 'lobby' || state.inspect === state.loadout.hero) return;
  state.loadout.hero = state.inspect;
  storeLoadout();
  sound.play('cardEquip');
  stage.flash();
  markRoster();
  markEquip();
  renderChampion();
}

/* -------------------------------------------------------------------------- */
/* Deck: the Battle Deck, the collection and the card inspector               */
/* -------------------------------------------------------------------------- */

/** The collection's filters: every card, or the cards of one type. */
const FILTERS = [
  { id: 'all', label: `All (${CARDS.length})` },
  { id: 'Troop', label: 'Troops' },
  { id: 'Spell', label: 'Spells' },
  { id: 'Building', label: 'Buildings' },
];
/** A card type, counted: one of it, and several. */
const TYPE_NAMES = { Troop: ['Troop', 'Troops'], Spell: ['Spell', 'Spells'], Building: ['Building', 'Buildings'] };
const DECK_HINT = 'Select any card to inspect it. A Reserve card can be equipped in place of one in the deck.';

/** The unit a card puts on the field, if it puts one there. */
const unitOf = (card) => (card.spawns ? UNITS[card.spawns] : null);

/**
 * What a full stat bar stands for: the largest figure of its kind in the whole
 * card pool, so that one card's bars can be measured against another's.
 */
const STAT_SCALE = {
  hp: Math.max(...CARDS.map((card) => unitOf(card)?.hp ?? 0)),
  damage: Math.max(...CARDS.map((card) => unitOf(card)?.damage ?? card.damage ?? card.heal ?? 0)),
  count: Math.max(...CARDS.map((card) => card.count ?? 0)),
  reach: Math.max(...CARDS.map((card) => unitOf(card)?.range ?? card.radius)),
};

const figure = (value) => value.toLocaleString('en-US');
const secondsOf = (ms) => `${Number((ms / 1000).toFixed(2))}s`;

/** Who a card's blows, or its mending, fall on: as the simulation decides it (game.js). */
function cardTargets(card, unit) {
  if (card.heal) return ['Your Hero', 'Allied Troops'];
  if (unit?.buildingsOnly) return ['Buildings only'];
  const targets = ['Troops', 'Heroes'];
  // A unit's blow is worth `siege` of itself against a building; a spell has its own figure for buildings.
  // What stands still (a Frost Tower) never comes within reach of one.
  if (!unit) targets.push(`Buildings · ${figure(card.structureDamage)} dmg`);
  else if (unit.speed) targets.push(unit.siege < 1 ? `Buildings · ${Math.round(unit.siege * 100)}% dmg` : 'Buildings');
  if (unit?.spin) targets.push(`All within ${unit.spin}`);
  if (unit?.slow) targets.push(`Slows ${Math.round(unit.slow * 100)}%`);
  return targets;
}

/**
 * A card's figures for the inspector, read from the rules the match runs on
 * (`CARDS` and `UNITS`): none of them is written down a second time here. A row
 * with `fill` (0..1) is drawn as a bar, and one with `badges` as a row of them.
 */
function cardStats(card) {
  const unit = unitOf(card);
  const rows = [];
  if (unit) {
    rows.push({ stat: 'hp', label: 'HP', value: figure(unit.hp), note: card.count > 1 ? 'each' : '', fill: unit.hp / STAT_SCALE.hp });
    rows.push({ stat: 'damage', label: 'Damage', value: figure(unit.damage), note: `every ${secondsOf(unit.attackMs)}`, fill: unit.damage / STAT_SCALE.damage });
    if (unit.lifetimeMs) rows.push({ stat: 'time', label: 'Duration', badges: [`${secondsOf(unit.lifetimeMs)} on the field`] });
    else rows.push({ stat: 'count', label: 'Units', value: `×${card.count}`, note: '', fill: card.count / STAT_SCALE.count });
    rows.push({ stat: 'reach', label: 'Range', value: String(unit.range), note: unit.shot || unit.beam ? 'Ranged' : 'Melee', fill: unit.range / STAT_SCALE.reach });
  } else {
    const amount = card.heal ?? card.damage;
    rows.push({
      stat: card.heal ? 'heal' : 'damage',
      label: card.heal ? 'Healing' : 'Damage',
      value: figure(amount),
      note: card.heal ? 'to each ally' : 'to each enemy',
      fill: amount / STAT_SCALE.damage,
    });
    rows.push({ stat: 'time', label: 'Effect', badges: [card.travelMs ? `Lands after ${secondsOf(card.travelMs)}` : 'Instant', ...(card.stunMs ? [`Stuns ${secondsOf(card.stunMs)}`] : [])] });
    rows.push({ stat: 'reach', label: 'Radius', value: String(card.radius), note: 'Area', fill: card.radius / STAT_SCALE.reach });
  }
  rows.push({ stat: 'targets', label: 'Targets', badges: cardTargets(card, unit) });
  rows.push({ stat: 'zone', label: 'Deploy', badges: [card.zone === 'own' ? 'Your side of the River' : 'Anywhere on the field'] });
  return rows;
}

function statRow(row, index) {
  const node = el('div', 'cstat');
  node.dataset.stat = row.stat;
  node.style.setProperty('--i', index);
  const data = el('dd');
  if (row.badges) {
    data.classList.add('cstat-badges');
    data.append(...row.badges.map((text) => el('span', 'cstat-badge', text)));
  } else {
    const track = el('span', 'meter-track');
    track.append(el('i', 'meter-fill'));
    data.append(track, el('b', 'cstat-value', row.value), el('span', 'cstat-note', row.note));
  }
  node.append(el('dt', '', row.label), data);
  return node;
}

/** A card's Elixir cost in its orb, and its painted illustration. */
function cardFace(card) {
  const cost = el('span', 'card-cost');
  cost.append(el('span', '', String(card.cost)));
  const art = el('span', 'card-art');
  art.append(painting(cardArt(card.id)));
  return [cost, art];
}

/** One of the six slots of the Battle Deck. */
function deckSlot(card, index, { swapped, intro }) {
  const item = el('li');
  const button = el('button', `deck-card type-${card.type.toLowerCase()}`);
  button.type = 'button';
  button.dataset.card = card.id;
  button.style.setProperty('--i', index);
  button.classList.toggle('just-swapped', swapped);
  button.classList.toggle('dealt', intro);
  button.append(...cardFace(card), el('span', 'card-name', card.name));
  button.addEventListener('click', () => onDeckSlot(card.id));
  item.append(button);
  return item;
}

/** A card of the collection: every card in the pool has one, whether it is in the deck or in the Reserve. */
function poolCard(card, index, { swapped, deal }) {
  const inDeck = zoneOf(card.id) === 'deck';
  const item = el('li');
  const button = el('button', `pool-card type-${card.type.toLowerCase()} ${inDeck ? 'in-deck' : 'in-reserve'}`);
  button.type = 'button';
  button.dataset.card = card.id;
  button.style.setProperty('--i', index);
  button.classList.toggle('just-swapped', swapped);
  button.classList.toggle('dealt', deal);

  const thumb = el('span', 'pool-thumb');
  thumb.append(...cardFace(card));
  const text = el('span', 'pool-text');
  text.append(el('span', 'pool-name', card.name), el('span', 'pool-type', card.type), el('span', inDeck ? 'zone-badge is-deck' : 'zone-badge', inDeck ? 'In Deck' : 'Reserve'));
  button.append(thumb, text);
  button.addEventListener('click', () => inspectCard(card.id));
  item.append(button);
  return item;
}

/** What is selected, and what a press would do, on every card of the deck screen. Nothing is redrawn. */
function markCards() {
  const incoming = CARDS_BY_ID[state.card];
  for (const button of dom.screens.deck.querySelectorAll('[data-card]')) {
    const card = CARDS_BY_ID[button.dataset.card];
    const target = state.swapping && button.classList.contains('deck-card');
    const inspected = card.id === state.card;
    button.classList.toggle('is-inspected', inspected);
    button.classList.toggle('is-target', target);
    button.setAttribute('aria-pressed', String(inspected));
    const where = zoneOf(card.id) === 'deck' ? 'In your Battle Deck' : 'In your Reserve';
    const action = target ? `Replace it with ${incoming.name}` : inspected ? 'In the inspector' : 'Inspect it';
    button.setAttribute('aria-label', `${card.name}: ${card.cost} Elixir, ${card.type}. ${where}. ${action}.`);
  }
}

/** The Battle Deck's header: how many cards, what they cost on average, and how many of each type. */
function renderDeckHead() {
  const { deck } = state.loadout;
  setText(dom.deckCount, `${deck.length} / ${MATCH.deckSize}`);
  setText(dom.deckAvg, averageCost(deck).toFixed(1));
  dom.deckMix.replaceChildren(
    ...Object.entries(TYPE_NAMES).map(([type, [one, many]]) => {
      const count = deck.filter((id) => CARDS_BY_ID[id].type === type).length;
      const pill = el('li', `mix-pill type-${type.toLowerCase()}`);
      pill.classList.toggle('is-none', count === 0);
      pill.append(el('b', '', String(count)), ` ${count === 1 ? one : many}`);
      return pill;
    }),
  );
}

/** The cards the filter lets through. `flash` cards have just changed places; with `deal` they are dealt in. */
function renderCollection({ flash = [], deal = false } = {}) {
  const shown = CARDS.filter((card) => state.filter === 'all' || card.type === state.filter);
  dom.collection.replaceChildren(...shown.map((card, index) => poolCard(card, index, { swapped: flash.includes(card.id), deal })));
  setText(dom.collectionCount, shown.length === CARDS.length ? `${CARDS.length} Cards` : `${shown.length} of ${CARDS.length}`);
  markCards();
}

function renderFilters() {
  dom.filters.replaceChildren(
    ...FILTERS.map(({ id, label }) => {
      const button = el('button', 'filter', label);
      button.type = 'button';
      button.dataset.filter = id;
      button.setAttribute('aria-pressed', String(id === state.filter));
      button.addEventListener('click', () => setFilter(id));
      return button;
    }),
  );
}

/** Shows the whole collection ('all') or the cards of one type. The click is heard as every button's is. */
function setFilter(id) {
  if (id === state.filter || state.phase !== 'lobby') return;
  state.filter = id;
  for (const button of dom.filters.children) button.setAttribute('aria-pressed', String(button.dataset.filter === id));
  renderCollection({ deal: true });
}

/**
 * Draws the Battle Deck and the collection. Cards in `flash` have just changed
 * places; with `intro` the deck is dealt in. Keyboard focus that was on a card
 * moves to `focusId`, because the buttons are replaced.
 */
function renderDeckBuilder({ flash = [], intro = false, focusId = null } = {}) {
  const hadFocus = dom.screens.deck.contains(document.activeElement);
  dom.deck.replaceChildren(...state.loadout.deck.map((id, index) => deckSlot(CARDS_BY_ID[id], index, { swapped: flash.includes(id), intro })));
  renderDeckHead();
  renderCollection({ flash, deal: intro });
  markInspector();
  if (hadFocus && focusId) dom.deck.querySelector(`[data-card="${focusId}"]`)?.focus();
}

/** The inspector, for the card on show: its art, what kind of card it is, and its figures. */
function renderInspector() {
  const card = CARDS_BY_ID[state.card];
  dom.inspector.dataset.type = card.type.toLowerCase();
  dom.inspectArt.replaceChildren(painting(cardArt(card.id)));
  setText(dom.inspectType, card.type);
  setText(dom.inspectName, card.name);
  setText(dom.inspectTagline, card.tagline);
  setText(dom.inspectCost, String(card.cost));
  dom.inspectTraits.replaceChildren(...card.traits.map((trait) => el('li', '', trait)));
  setText(dom.inspectDesc, card.description);

  const stats = cardStats(card);
  const rows = stats.map(statRow);
  dom.inspectStats.replaceChildren(...rows);
  // The bars are drawn empty and filled a moment later, so that each is seen to grow to its figure.
  void dom.inspectStats.offsetWidth;
  stats.forEach((row, i) => {
    if (row.fill != null) rows[i].style.setProperty('--value', String(Math.min(1, row.fill)));
  });
  markInspector();
}

/** Where the card on show is kept, and what the button under it offers: to equip it, or the news that it is in the deck. */
function markInspector() {
  const inDeck = zoneOf(state.card) === 'deck';
  setText(dom.inspectZone, inDeck ? 'In Deck' : 'Reserve');
  dom.inspectZone.classList.toggle('is-deck', inDeck);
  dom.equipCardBtn.classList.toggle('is-equipped', inDeck);
  dom.equipCardBtn.classList.toggle('is-arming', state.swapping);
  // Marked rather than disabled, as Equip Champion is: the keyboard stays where it was.
  dom.equipCardBtn.setAttribute('aria-disabled', String(inDeck));
  dom.equipCardBtn.setAttribute('aria-pressed', String(state.swapping));
  setText(dom.equipCardLabel, inDeck ? 'In Battle Deck' : state.swapping ? 'Choose a Deck Slot' : 'Equip into Deck');
}

/** The line over the Battle Deck: the swap's prompt while one is being made, otherwise `message` or the standing hint. */
function showSwapBar(message = DECK_HINT) {
  dom.swapBar.classList.toggle('is-swapping', state.swapping);
  dom.swapBar.classList.toggle('is-news', !state.swapping && message !== DECK_HINT);
  dom.cancelSwapBtn.hidden = !state.swapping;
  if (state.swapping) dom.swapText.replaceChildren('Click a card in your Battle Deck to replace with ', el('strong', '', CARDS_BY_ID[state.card].name));
  else setText(dom.swapText, message);
}

/**
 * Swap Mode: the Reserve card on show is waiting for the Battle Deck card it
 * replaces, and the six slots say so. Returns whether anything changed.
 */
function setSwapping(next) {
  if (state.swapping === next) return false;
  state.swapping = next;
  dom.battleDeck.classList.toggle('is-swapping', next);
  markCards();
  markInspector();
  showSwapBar();
  return true;
}

/** Calls a swap off. Returns whether there was one. */
function cancelSwap() {
  if (!setSwapping(false)) return false;
  sound.play('cardCancel');
  return true;
}

/** Puts a card in the inspector. A swap that was waiting for its slot is dropped: the player has looked elsewhere. */
function inspectCard(id) {
  if (state.phase !== 'lobby') return;
  sound.play('cardPick');
  setSwapping(false);
  if (id !== state.card) {
    state.card = id;
    renderInspector();
  }
  markCards();
  showSwapBar();
}

/** A slot of the Battle Deck was pressed: in Swap Mode it is the card to replace, otherwise it is looked at. */
function onDeckSlot(id) {
  if (state.phase !== 'lobby') return;
  if (state.swapping) swapCards(state.card, id);
  else inspectCard(id);
}

/** Equip into Deck: starts the swap for the Reserve card on show. Pressed again, it calls the swap off. */
function onEquipCard() {
  if (state.phase !== 'lobby' || zoneOf(state.card) === 'deck') return;
  if (cancelSwap()) return;
  sound.play('cardArm');
  setSwapping(true);
}

/** The Reserve card takes the deck card's slot and the deck card its place in the Reserve: the deck keeps its size and its different cards. */
function swapCards(incoming, outgoing) {
  // One card snaps into the deck, and the one it replaced lands in the Reserve a moment later.
  sound.play('cardEquip');
  sound.play('cardRemove', { delay: 0.13, gain: 0.8 });
  const { deck, reserve } = state.loadout;
  deck[deck.indexOf(outgoing)] = incoming;
  reserve[reserve.indexOf(incoming)] = outgoing;
  storeLoadout();
  state.swapping = false;
  dom.battleDeck.classList.remove('is-swapping');
  renderDeckBuilder({ flash: [incoming, outgoing], focusId: incoming });
  showSwapBar(`${CARDS_BY_ID[incoming].name} joins the Battle Deck in place of ${CARDS_BY_ID[outgoing].name}.`);
  renderLoadoutDeck();
}

/**
 * A Battle Deck is exactly `MATCH.deckSize` different cards from the pool, and
 * a swap cannot make it anything else. Should it ever be, it is put right
 * before a search rather than sent to the server. Returns whether it was sound.
 */
function ensureDeck() {
  const { hero, deck } = state.loadout;
  if (deck.length === MATCH.deckSize && new Set(deck).size === MATCH.deckSize && deck.every((id) => id in CARDS_BY_ID)) return true;
  setLoadout({ hero, deck });
  storeLoadout();
  state.card = state.loadout.deck[0];
  renderDeckBuilder();
  renderInspector();
  renderLoadoutDeck();
  toast(`A Battle Deck is ${MATCH.deckSize} different cards. Yours was not, and has been reset to the starter deck.`, 'warn', 7_000);
  return false;
}

/* -------------------------------------------------------------------------- */
/* Game data                                                                  */
/* -------------------------------------------------------------------------- */

/** Wherever the lobby says how long a search lasts, it says `QUEUE_TIMEOUT_MS`: 01:00. */
function showQueueLimit() {
  const limit = formatClock(QUEUE_TIMEOUT_MS);
  setText(dom.modeLimit, limit);
  setText(dom.queueLimit, `/ ${limit}`);
  dom.queueHint.replaceChildren('If no challenger answers by ', el('strong', '', limit), ', an AI opponent takes the field.');
}

async function loadConfig(attempt = 0) {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.config = await response.json();
  } catch {
    if (attempt < 5) setTimeout(() => loadConfig(attempt + 1), 1000 * (attempt + 1));
    else toast('Could not load game data. Refresh the page to try again.', 'error', 12_000);
    return;
  }
  refreshFindButton();
}

function refreshFindButton() {
  dom.findBtn.disabled = !(state.connected && state.config && state.phase === 'lobby');
}

/* -------------------------------------------------------------------------- */
/* Matchmaking queue                                                          */
/* -------------------------------------------------------------------------- */

function findMatch() {
  if (state.phase !== 'lobby' || !state.connected || !state.config) return;
  if (!ensureDeck()) return;
  const nickname = commitNickname();

  setPhase('queue');
  refreshFindButton();
  stage.setEnergy(1);

  state.queue.running = false;
  dom.queuePanel.classList.remove('resolved');
  dom.queueTitle.textContent = 'Searching for Opponent';
  dom.queueTimer.textContent = formatClock(0);
  dom.queueProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  dom.queueProgress.style.color = ringColor(0);
  dom.queueStatus.textContent = 'Entering the matchmaking queue…';
  dom.cancelBtn.disabled = false;
  dom.spawnBotBtn.disabled = false;
  dom.queueModal.hidden = false;
  dom.cancelBtn.focus();

  // The great door shuts behind the player, and the search is heard for as long as it runs.
  sound.play('findMatch');
  clearInterval(state.pulseTimer);
  state.pulseTimer = setInterval(() => sound.play('queuePulse'), QUEUE_PULSE_MS);

  socket.emit('queue:join', { nickname, hero: state.loadout.hero, deck: state.loadout.deck });
  // Start on the battlefield while the search runs; it is often ready before an opponent is found.
  loadGameView().catch(() => {});
}

function onQueueJoined({ nickname, elapsedMs }) {
  if (state.phase !== 'queue') return;
  dom.nickname.value = nickname;
  state.queue.startedAt = performance.now() - elapsedMs;
  if (!state.queue.running) {
    state.queue.running = true;
    requestAnimationFrame(tickQueue);
  }
}

function tickQueue() {
  if (!state.queue.running) return;
  const elapsed = Math.min(performance.now() - state.queue.startedAt, QUEUE_TIMEOUT_MS);

  setText(dom.queueTimer, formatClock(elapsed));
  dom.queueProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - elapsed / QUEUE_TIMEOUT_MS));
  dom.queueProgress.style.color = ringColor(elapsed / QUEUE_TIMEOUT_MS);

  let status = QUEUE_MESSAGES[Math.floor(elapsed / 5000) % QUEUE_MESSAGES.length];
  if (elapsed >= QUEUE_TIMEOUT_MS) status = 'No opponent found — summoning an AI challenger…';
  else if (QUEUE_TIMEOUT_MS - elapsed <= 10_000) status = 'No rival yet — an AI challenger is arming up…';
  setText(dom.queueStatus, status);

  requestAnimationFrame(tickQueue);
}

function cancelQueue() {
  if (state.phase !== 'queue' || state.match) return false;
  socket.emit('queue:cancel');
  returnToLobby();
  return true;
}

function onMatchFound(found) {
  // The player cancelled just as the server paired them: release the opponent.
  if (state.phase !== 'queue') {
    socket.emit('match:leave');
    return;
  }

  const receivedAt = performance.now();
  state.queue.running = false;
  clearInterval(state.pulseTimer);
  sound.play('matchFound');
  state.match = { ...found, live: false, ready: { radiant: false, dire: false } };
  for (const side of ['radiant', 'dire']) state.match.ready[side] = found.players[side].isBot;
  announceReady(state.match);

  if (found.reason === 'timeout') {
    dom.queueTimer.textContent = formatClock(QUEUE_TIMEOUT_MS);
    dom.queueProgress.style.strokeDashoffset = '0';
  }
  dom.queueTitle.textContent = found.vsBot ? 'AI Challenger Summoned' : 'Opponent Found';
  // Hand the ring colour back to the stylesheet, which turns it gold.
  dom.queueProgress.style.color = '';
  dom.queueStatus.textContent =
    found.reason === 'timeout'
      ? 'No opponent found — an AI challenger takes the field.'
      : found.reason === 'dev'
        ? 'AI bot spawned on request.'
        : `${found.players[found.side === 'radiant' ? 'dire' : 'radiant'].nickname} accepts your challenge!`;
  dom.queuePanel.classList.add('resolved');
  dom.cancelBtn.disabled = true;
  dom.spawnBotBtn.disabled = true;

  const beat = Math.min(RESOLVE_BEAT_MS, found.countdownMs / 2);
  state.resolveTimer = setTimeout(() => showMatch(receivedAt), found.reason === 'dev' ? beat / 2 : beat);
}

/* -------------------------------------------------------------------------- */
/* Match found                                                                */
/* -------------------------------------------------------------------------- */

function showMatch(receivedAt) {
  const match = state.match;
  if (!match) return;

  for (const side of ['radiant', 'dire']) {
    const info = match.players[side];
    const isYou = side === match.side;
    $(`name-${side}`).textContent = info.nickname;
    $(`side-${side}`).classList.toggle('is-you', isYou);
    const champion = CHAMPIONS[info.hero] ?? CHAMPIONS[CHAMPION_IDS[0]];
    $(`sigil-${side}`).replaceChildren(painting(portraitArt(champion.id)));
    setText($(`hero-${side}`), `${champion.name} · ${champion.title}`);
  }
  showReady(match);
  showLoad();
  dom.matchMode.textContent = match.vsBot ? '1v1 · Versus AI Bot' : '1v1 · Player versus Player';
  dom.matchNote.textContent = `You fight for the ${match.side === 'radiant' ? 'Radiant, on the left' : 'Dire, on the right'}.`;

  dom.queueModal.hidden = true;
  dom.matchOverlay.hidden = false;
  setPhase('match');
  stage.setEnergy(0.4);
  stage.flash();
  dom.leaveBtn.focus();

  const startsAt = receivedAt + match.countdownMs;
  const tick = () => {
    if (match.live) return;
    const remaining = startsAt - performance.now();
    if (remaining > 0) {
      setText(dom.matchStatusLabel, 'Battle begins in');
      setText(dom.matchCount, String(Math.ceil(remaining / 1000)));
      return;
    }
    // The server holds the match until both players have the battlefield loaded.
    const rival = match.side === 'radiant' ? 'dire' : 'radiant';
    let label = 'Entering the battlefield…';
    if (!match.ready[match.side]) label = 'Preparing the battlefield…';
    else if (!match.ready[rival]) label = `Waiting for ${match.players[rival].nickname}…`;
    setText(dom.matchStatusLabel, label);
    setText(dom.matchCount, '');
  };
  tick();
  state.countdownTimer = setInterval(tick, 100);
}

/** Marks on the versus screen which players have the battlefield loaded. */
function showReady(match) {
  for (const side of ['radiant', 'dire']) {
    const who = side === match.side ? 'You' : match.players[side].isBot ? 'AI Bot' : 'Opponent';
    setText($(`tag-${side}`), match.ready[side] && !match.players[side].isBot ? `${who} · Ready` : who);
  }
}

function onMatchReady({ matchId, side }) {
  const match = state.match;
  if (!match || match.matchId !== matchId || !(side in match.ready)) return;
  match.ready[side] = true;
  showReady(match);
}

/**
 * Tells the server this player's battlefield is loaded, which is what lets the
 * match begin. A battlefield that cannot be built ends the match at once
 * rather than leaving the opponent to wait.
 */
function announceReady(match) {
  loadGameView().then(
    () => {
      if (state.match === match && !match.live) socket.emit('match:ready', { matchId: match.matchId });
    },
    (error) => {
      if (state.match !== match || match.live) return;
      console.error(error);
      leaveMatch();
      toast(LOAD_FAILED, 'error', 9_000);
    },
  );
}

/* -------------------------------------------------------------------------- */
/* In-game                                                                    */
/* -------------------------------------------------------------------------- */

const LOAD_FAILED = 'The battlefield could not start. This browser may not support WebGL 2.';
/** Share of the loading bar given to downloading the scripts; building the battlefield takes the rest. */
const DOWNLOAD_SHARE = 0.15;

let gameView = null;
let gameViewLoading = null;
/** How far the battlefield has loaded: a fraction that only grows, and what is being done. */
const load = { fraction: 0, label: '' };

function setLoad(fraction, label) {
  load.fraction = Math.max(load.fraction, Math.min(fraction, 1));
  load.label = label;
  showLoad();
}

function showLoad() {
  const percent = Math.floor(load.fraction * 100);
  const done = load.fraction >= 1;
  dom.matchLoad.classList.toggle('done', done);
  setText(dom.loadLabel, done ? 'Battlefield ready' : load.label || 'Preparing the battlefield');
  setText(dom.loadPercent, `${percent}%`);
  dom.loadFill.style.transform = `scaleX(${load.fraction})`;
  if (dom.loadTrack.getAttribute('aria-valuenow') !== String(percent)) dom.loadTrack.setAttribute('aria-valuenow', String(percent));
}

/**
 * The renderer and HUD load on demand and are reused for every later match.
 * Loading downloads the scripts, builds the battlefield, compiles its shaders
 * and rehearses a battle, so nothing is left to stall the match itself.
 */
function loadGameView() {
  if (gameViewLoading) return gameViewLoading;
  // The stage is still on screen behind the search: frames that run long while this goes on are no fault of its own.
  stage.setBusy(true);
  gameViewLoading = import('./preload.js')
    .then(({ preloadModules }) => preloadModules('./match.js', (k) => setLoad(k * DOWNLOAD_SHARE, 'Downloading the battlefield')))
    .then(() => import('./match.js'))
    .then(({ createMatchView }) =>
      createMatchView({
        socket,
        sound,
        onExit: leaveMatch,
        onPlayAgain: playAgain,
        // The bar fills completely only once the view exists, below.
        onProgress: (k, label) => setLoad(DOWNLOAD_SHARE + k * (1 - DOWNLOAD_SHARE) * 0.99, label),
      }),
    )
    .then((view) => {
      gameView = view;
      setLoad(1, '');
      // Console diagnostics: runedeck.stats() reports FPS, draw calls and triangles.
      window.runedeck = {
        ...window.runedeck,
        stats: gameView.stats,
        project: gameView.project,
        lockQuality: gameView.lockQuality,
        fx: gameView.fx,
        heroView: gameView.heroView,
        camera: gameView.camera,
        announce: gameView.announce,
        float: gameView.float,
        sound,
      };
      return gameView;
    })
    .catch((error) => {
      gameViewLoading = null;
      // A later attempt starts the bar again from empty.
      load.fraction = 0;
      load.label = '';
      throw error;
    })
    .finally(() => stage.setBusy(false));
  return gameViewLoading;
}

async function onMatchStart(start) {
  const match = state.match;
  if (!match || match.matchId !== start.matchId) return;
  match.live = true;

  let view;
  try {
    view = await loadGameView();
  } catch (error) {
    console.error(error);
    if (state.match !== match) return;
    leaveMatch();
    toast(LOAD_FAILED, 'error', 9_000);
    return;
  }
  // The player may have left while the battlefield was loading.
  if (state.match !== match) return;

  clearTimeout(state.resolveTimer);
  clearInterval(state.countdownTimer);
  dom.queueModal.hidden = true;
  dom.matchOverlay.hidden = true;
  // From here the battlefield is all there is on screen: `setPhase` stops the lobby's stage with it.
  setPhase('game');
  view.start(start);
}

function leaveMatch() {
  if (!state.match) return;
  socket.emit('match:leave');
  returnToLobby();
}

/** Leaves the finished match and joins the queue again at once with the same nickname, champion and deck. */
function playAgain() {
  leaveMatch();
  findMatch();
}

function onMatchEnded({ reason }) {
  if (!state.match) return;
  returnToLobby();
  toast(
    reason === 'opponent_disconnected' ? 'Your opponent disconnected. The match was closed.' : 'Your opponent left the match.',
    'warn',
  );
}

function returnToLobby() {
  clearTimeout(state.resolveTimer);
  clearInterval(state.countdownTimer);
  clearInterval(state.pulseTimer);
  state.queue.running = false;
  state.match = null;
  dom.queueModal.hidden = true;
  dom.matchOverlay.hidden = true;
  gameView?.stop();
  sound.setMusic('lobby');
  // Back in the lobby the stage picks up where it stopped.
  setPhase('lobby');
  stage.setEnergy(0);
  refreshFindButton();
  if (!dom.findBtn.disabled) dom.findBtn.focus();
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The server runs a different build from this page: it was updated while the
 * page stayed open. Old scripts would draw the new battle wrongly, so load the
 * new ones. One reload per build; if that does not help, say so instead of looping.
 */
function onServerHello({ build }) {
  if (!BUILD || !build || build === BUILD) return;
  let tried = null;
  try {
    tried = sessionStorage.getItem(RELOADED_FOR_KEY);
    sessionStorage.setItem(RELOADED_FOR_KEY, build);
  } catch {
    // Without storage there is no way to tell a second reload from the first, so do not risk a loop.
    tried = build;
  }
  if (tried === build) {
    toast('The game was updated, but this page is still an old version. Press Ctrl+Shift+R to reload it.', 'error', 60_000);
    return;
  }
  window.location.reload();
}

function setConnection(status, text) {
  dom.conn.dataset.state = status;
  dom.connText.textContent = text;
}

/** The status bar's live figures: players online, players searching, matches being fought. */
function showStats({ online, searching, matches }) {
  const figures = [
    [online, 'Online'],
    [searching, 'Searching'],
    [matches, matches === 1 ? 'Match Live' : 'Matches Live'],
  ];
  const text = figures.map(([count, label]) => `${count} ${label}`).join(' • ');
  if (dom.lobbyStats.dataset.shown === text) return;
  dom.lobbyStats.dataset.shown = text;
  dom.lobbyStats.replaceChildren(
    ...figures.flatMap(([count, label], i) => {
      const figure = el('span', 'tally');
      figure.append(el('b', '', String(count)), ` ${label}`);
      if (i === 0) return [figure];
      const dot = el('i', 'tally-dot', '•');
      dot.setAttribute('aria-hidden', 'true');
      return [dot, figure];
    }),
  );
}

function initSocket() {
  if (!socket) {
    setConnection('offline', 'Realtime client failed to load');
    toast('Could not load the realtime client. Refresh the page to try again.', 'error', 12_000);
    return;
  }

  socket.on('connect', () => {
    state.connected = true;
    setConnection('online', 'Connected to realm server');
    refreshFindButton();
  });

  socket.on('disconnect', () => {
    state.connected = false;
    setConnection('offline', 'Connection lost — reconnecting…');
    delete dom.lobbyStats.dataset.shown;
    dom.lobbyStats.textContent = '';
    // The server drops queue and match state with the socket, so mirror that here.
    if (state.phase !== 'lobby') {
      returnToLobby();
      toast('Connection lost. You were returned to the lobby.', 'error');
    }
    refreshFindButton();
  });

  socket.on('server:hello', onServerHello);
  socket.on('lobby:stats', showStats);
  socket.on('lobby:error', ({ message }) => toast(message, 'error'));
  socket.on('queue:joined', onQueueJoined);
  socket.on('match:found', onMatchFound);
  socket.on('match:ready', onMatchReady);
  socket.on('match:start', onMatchStart);
  socket.on('match:ended', onMatchEnded);
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

dom.findBtn.addEventListener('click', findMatch);
dom.equipBtn.addEventListener('click', equipChampion);
dom.equipCardBtn.addEventListener('click', onEquipCard);
dom.cancelSwapBtn.addEventListener('click', cancelSwap);
dom.cancelBtn.addEventListener('click', cancelQueue);
dom.spawnBotBtn.addEventListener('click', () => {
  if (state.phase === 'queue' && !state.match) socket.emit('queue:spawnBot');
});
dom.leaveBtn.addEventListener('click', leaveMatch);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  hideTooltip();
  // Calling off a swap and calling off the search are heard, as their buttons are.
  cancelSwap();
  if (cancelQueue()) sound.play('uiClick');
});
window.addEventListener('resize', () => hideTooltip());
window.addEventListener('scroll', () => hideTooltip(), { passive: true });

initTabs();
initNickname();
initLoadout();
renderCodex();
showQueueLimit();
initSocket();
loadConfig();
// Last, and not waited for: the lobby is in use while the stage is fetched and built.
stage.open();
