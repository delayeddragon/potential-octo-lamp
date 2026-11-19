/**
 * RuneDeck — match controller.
 *
 * Joins the battlefield renderer and the HUD to the server: it keeps the latest
 * snapshot, extrapolates timers between snapshots for smooth bars, turns input
 * into intents and turns server events into effects, sounds, announcer banners
 * and feed lines. The server stays authoritative; local checks only give instant feedback.
 *
 * Every snapshot lists the damage and healing since the one before; they float up
 * as numbers over whoever took them, in step with the blow that is drawn and heard.
 *
 * Both players pick a champion: the ability bar, the casts and the effects follow
 * each side's own champion. When a Throne falls (or a Tower, in sudden death) every
 * unit freezes, the HUD stands aside and the battlefield plays the finale; only
 * then does the post-match summary open.
 *
 * Every match opens with a cinematic flyover from the enemy Throne to the
 * player's hero; the server holds the battle, and this module holds the
 * controls, until it lands.
 *
 * Controls
 *   Mouse at a screen edge, arrow keys, A S D         pan the camera (W stays Aegis Shield; use the up arrow)
 *   Hold any mouse button and drag                    drag the battlefield under the cursor
 *   Mouse wheel                                       move the camera a little closer or farther
 *   Space, or the Lock button on the minimap          lock the camera on the hero, or free it again
 *   Click or drag on the minimap                      move the camera there (Alt-click drops a ping)
 *   Right-click (or left-click with no card armed)   move the hero, or attack the enemy unit, hero or Tower under the cursor
 *                                                     (a click acts on release, and only if the cursor has not dragged the map)
 *   Q W E R                                          abilities, aimed at the cursor
 *   Z X                                              buy the relic (first press), then Z blinks to the cursor
 *   C                                                drink the rune bottled on the River pad
 *   1 2 3 4 or click a card                          arm a card, then left-click the battlefield to play it
 *   Drag a card onto the battlefield or minimap      play it where it is dropped
 *   Esc or right-click                               put an armed card back
 *   M, or the speaker beside Leave Match             mute all sound; the button next to it opens the Music and SFX volumes
 *
 * Sound
 *   The battle theme takes over from the lobby's as the flyover begins, and drives harder as the
 *   stakes rise: Double Elixir or a Throne under 40% health, then sudden death (or both of the
 *   former at once). It falls silent for the closing shot; the lobby's theme returns under the summary.
 */

import { breathe, createBattlefield } from './battlefield.js';
import { clock, createHud } from './hud.js';
import { CARDS, CHAMPIONS, HERO, HIT, MATCH, RUNES, STRUCTURES, UNITS, UNIT_TYPES, canDeploy, groundHeight, heroSpawn, opposite } from './shared.js';

const CARD_BY_ID = new Map(CARDS.map((card) => [card.id, card]));
const ITEMS = new Map(HERO.items.map((item) => [item.key, item]));
const HERO_TYPE = UNIT_TYPES.indexOf('hero');

/** Physical key positions, so the bindings survive non-Latin keyboard layouts. */
const CARD_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
const ACTION_KEYS = { KeyQ: 'Q', KeyW: 'W', KeyE: 'E', KeyR: 'R', KeyZ: 'Z', KeyX: 'X', KeyC: 'C' };
/** Keys that pan the camera, as [screen-right, up-screen]. W is an ability, so only the arrow pans up. */
const PAN_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1], KeyA: [-1, 0], KeyD: [1, 0], KeyS: [0, -1] };
/** Camera pan speed at full tilt, in world units per second. */
const PAN_SPEED = 32;
/** How close to a screen edge the cursor pans the camera: over the battlefield, and over the HUD. */
const EDGE_PX = { field: 22, hud: 3 };
/** How long the flyover holds over the enemy Throne before it sets off, and how far its path bows towards the camera. */
const INTRO = { holdS: 0.8, arc: 5, fightMs: 1_500 };
const DRAG_THRESHOLD_PX = 8;
/** What one notch of a mouse wheel reports, in pixels; a trackpad sends many smaller steps. */
const WHEEL_NOTCH_PX = 100;
/** Minimum gap between "under attack" notices for one structure: the player's own, and the enemy's. */
const OWN_NOTICE_MS = 12_000;
const ENEMY_NOTICE_MS = 25_000;
/** A single hit this large makes the structure flash as well as shudder. */
const HEAVY_HIT = 100;
/** Damage in one blow from which its floating number is drawn large. */
const BIG_NUMBER = 200;
/** The sound of each ability, by its id. */
const CAST_CUES = {
  slash_dash: 'dash',
  aegis_shield: 'shield',
  thunder_strike: 'thunder',
  divine_judgment: 'judgment',
  magma_cleave: 'cleave',
  flame_cloak: 'cloak',
  obsidian_spike: 'spikes',
  cataclysmic_meteor: 'meteor',
};
/** The sound of each card as it is played; a card not listed here has the plain deploy sound. */
const CARD_CUES = {
  footmen_squad: 'deployFootmen',
  arcane_archer: 'deployArcher',
  siege_golem: 'deployGolem',
  frost_tower: 'deployFrost',
  fireball: 'fireball',
  healing_wave: 'healWave',
  lightning_bolt: 'lightning',
  valkyrie_spinner: 'deployValkyrie',
};
/** How loud the player's own card is when it is played (from the minimap) too far off screen to be heard from where it lands. */
const FAR_CARD_GAIN = 0.4;
/** Below this share of its health the player's hero is heard to be dying: a heartbeat, quicker the lower it falls. */
const LOW_HEALTH = 0.25;
/** A Throne below this share of its health raises the music. */
const THRONE_DANGER = 0.4;
/** How long the fanfare of a finished match has to itself before the lobby's theme comes in under the summary. */
const FANFARE_MS = 4_500;
const SIDE_NAME = { radiant: 'Radiant', dire: 'Dire' };

/**
 * Builds the battlefield and the HUD. `onProgress(fraction, label)` follows the
 * build; the promise resolves when the match can open without a hitch.
 * `sound` is the page's SoundEngine (sound.js).
 */
export async function createMatchView({ socket, sound, onExit, onPlayAgain, onProgress }) {
  const root = document.getElementById('game');
  const canvas = document.getElementById('battlefield');
  // The battlefield is nearly all of the work; the HUD's painted icons are the rest.
  const FIELD_SHARE = 0.95;
  const field = await createBattlefield(canvas, (k, label) => onProgress?.(k * FIELD_SHARE, label));
  onProgress?.(FIELD_SHARE, 'Painting the interface');
  await breathe();
  const hud = createHud({ sound });
  onProgress?.(1, 'Battlefield ready');

  let active = false;
  let finished = false;
  let side = 'radiant';
  /** The server's match:start roster: { nickname, isBot, hero } for each side. */
  let players = null;
  /** The player's own abilities by key. */
  let abilities = new Map();
  /** Counts matches and exits, so that work that outlives its match (the finale) knows to stop. */
  let session = 0;
  /** Whether Double Elixir and sudden death have been announced in this match. */
  let doubleElixir = false;
  let overtime = false;
  /** Whether either Throne is close to falling: with the two above, what the music's intensity follows. */
  let throneInDanger = false;
  let fanfareTimer = 0;
  let snapshot = null;
  let snapshotAt = 0;
  /** Whole points of Elixir at the last frame, so that each one gained can be heard; null before the first. */
  let elixirWhole = null;
  /** Hand slot waiting for a target, or null. */
  let armed = null;
  let drag = null;
  /** Last known cursor position in client coordinates. */
  let pointer = null;
  let foeHp = HERO.maxHp;
  let leaveTimer = 0;
  /** Where the hero was last told to walk, marked on the ground until it gets there. */
  let waypoint = null;
  const noticedAt = new Map();
  /** True while the opening flyover plays: the camera is on rails and no orders are sent. */
  let intro = false;
  let cinemaTimer = 0;
  /** Whether the camera follows the player's hero. Panning by hand frees it. */
  let locked = true;
  /** Pan keys held down, the cursor's place for edge panning, and the camera's smoothed pan velocity. */
  const panKeys = new Set();
  let cursor = null;
  const panning = { x: 0, y: 0 };
  /**
   * A mouse button held down on the battlefield: { id, button, x, y, dragging }, or null.
   * Once `dragging`, the cursor moves the map instead of clicking it.
   */
  let grab = null;
  /** Pixels per world unit that the floating health bars were last sized for. */
  let barScale = 0;
  const { camera } = field;

  /* ---------------------------------------------------------------- Live values */

  /** Time the battle has run since the latest snapshot: none until the flyover it reports has ended. */
  const age = () => Math.max(0, performance.now() - snapshotAt - (snapshot.introLeftMs ?? 0));
  const elixirNow = () => Math.min(MATCH.elixirMax, snapshot.you.elixir + (age() * snapshot.elixirFactor) / MATCH.elixirIntervalMs);
  const cooldownNow = (key) => Math.max(0, (snapshot.you.cooldowns[key] ?? 0) - age());
  const armedCard = () => (armed === null ? null : CARD_BY_ID.get(snapshot.you.hand[armed]));
  const ownerOf = (def) => (def.side === side ? 'Your' : 'Enemy');
  const champion = (name) => CHAMPIONS[players[name].hero];
  const heroName = (name) => champion(name).name;
  /** "a Haste rune", "an Arcane Regen rune". */
  const aRune = (kind) => `${/^[aeiou]/i.test(RUNES[kind].name) ? 'an' : 'a'} ${RUNES[kind].name} rune`;

  function setWaypoint(point) {
    waypoint = point;
    field.setWaypoint(point);
  }

  const view = { hp: [], hand: [], hero: {}, cooldowns: {}, units: [] };

  field.onFrame = (dt, now) => {
    if (!snapshot) return;
    steerCamera(dt);
    // Zooming changes how large a world unit is on screen: the floating health bars are resized to match.
    if (field.pixelsPerUnit !== barScale) {
      barScale = field.pixelsPerUnit;
      hud.layout(field.project, barScale);
    }
    // A frame timestamp can predate the snapshot that arrived during it.
    const elapsed = finished ? 0 : Math.max(0, now - snapshotAt - (snapshot.introLeftMs ?? 0));
    const { hero } = snapshot.you;
    view.timeLeftMs = Math.max(0, snapshot.timeLeftMs - elapsed);
    view.rune = snapshot.rune.kind;
    view.runeInMs = Math.max(0, snapshot.rune.nextInMs - elapsed);
    view.units = snapshot.units;
    view.elixir = Math.min(MATCH.elixirMax, snapshot.you.elixir + (elapsed * snapshot.elixirFactor) / MATCH.elixirIntervalMs);
    // The battlefield is heard from where the camera looks.
    sound.listen(camera.focus.x, camera.focus.z);
    // Each point of Elixir gained ticks, and the bar filling up chimes.
    const whole = Math.floor(view.elixir + 1e-6);
    if (elixirWhole !== null && whole > elixirWhole && !intro && !finished) sound.play(whole >= MATCH.elixirMax ? 'elixirFull' : 'elixir');
    elixirWhole = whole;
    view.overtime = overtime;
    view.hand = snapshot.you.hand;
    view.next = snapshot.you.next;
    view.armed = armed;
    view.hero.hp = hero.hp;
    view.hero.mana = hero.mana;
    view.hero.level = hero.level;
    view.hero.xp = hero.xp;
    view.hero.gold = hero.gold;
    view.hero.rune = hero.rune;
    view.hero.owned = hero.owned;
    view.hero.buffs = hero.buffs;
    view.hero.buffAge = elapsed;
    view.hero.respawnMs = Math.max(0, hero.respawnMs - elapsed);
    view.foeHp = foeHp;
    view.footprint = camera.footprint();
    for (const key in snapshot.you.cooldowns) view.cooldowns[key] = Math.max(0, snapshot.you.cooldowns[key] - elapsed);
    hud.render(view, now);
    hud.track();

    // The heroes' name plates follow them across the field.
    for (const name of ['radiant', 'dire']) {
      const at = field.heroView(name);
      if (!at) continue;
      const screen = field.project(at.x, at.y + 3.7, at.z);
      hud.placeHero(name, screen.x, screen.y, !at.dead);
      // The walk marker goes once the hero arrives, or falls on the way.
      if (name === side && waypoint && (at.dead || Math.hypot(at.x - waypoint.x, at.z - waypoint.z) < 0.5)) setWaypoint(null);
    }
  };

  /** A player's name for a banner, in the colour of their side. */
  const who = (name) => ({ text: players[name].nickname, side: name });

  /**
   * Floats the damage and healing a snapshot reports over whoever took it. It runs before the
   * snapshot is applied, while a unit that has just fallen still has its place on the field.
   */
  function popNumbers({ hits = [], heals = [] }) {
    for (const [id, amount, flags] of hits) {
      const at = field.locate(id);
      if (!at) continue;
      const own = at.side === side;
      let kind = 'hit';
      if (at.hero && own) kind = 'taken';
      else if (flags & HIT.spell) kind = 'spell';
      else if (flags & HIT.burn) kind = 'burn';
      else if (at.hero || flags & HIT.hero) kind = 'hero';
      hud.float(kind === 'taken' ? `-${amount}` : String(amount), at.x, at.y + 0.3, at.z, kind, { own: own && !at.hero, big: amount >= BIG_NUMBER });
      // A blow struck by a hero, or landing on one, is heard as well as seen; a spell has its own sound.
      if (!(flags & (HIT.spell | HIT.burn)) && (at.hero || flags & HIT.hero)) sound.play('hit', { x: at.x, z: at.z });
    }
    for (const [id, amount] of heals) {
      const at = field.locate(id);
      if (at) hud.float(`+${amount}`, at.x, at.y + 0.5, at.z, 'heal');
    }
  }

  /** A Tower has fallen in regular time: the announcer says whose, and who is paid for it. */
  function announceTower(def) {
    sound.play('collapse', { x: def.x, z: def.z });
    hud.announce({
      title: `${SIDE_NAME[def.side].toUpperCase()} TOWER DESTROYED!`,
      tone: def.side,
      sub: [`${def.label} falls to `, who(opposite(def.side)), { text: `+${def.bounty} gold`, gold: true }],
    });
  }

  /** A hero has fallen: First Blood, a streak, or simply slain. */
  function announceKill(event) {
    const victim = who(event.side);
    if (!event.by) {
      hud.announce({ title: 'HERO SLAIN!', tone: 'kill', sub: [victim, ` fell to the ${SIDE_NAME[opposite(event.side)]} lines`] });
      return;
    }
    const killer = who(event.by);
    if (event.firstBlood) {
      hud.announce({ title: 'FIRST BLOOD!', tone: 'blood', sub: [killer, ' drew first blood on ', victim, { text: `+${event.bonus} bonus gold`, gold: true }] });
    } else if (event.streak >= 3) {
      hud.announce({ title: 'RAMPAGE!', tone: 'rampage', sub: [killer, ` is unstoppable: ${event.streak} kills without falling`] });
    } else if (event.streak === 2) {
      hud.announce({ title: 'DOUBLE KILL!', tone: 'streak', sub: [killer, ' slew ', victim, ' again'] });
    } else {
      hud.announce({ title: 'HERO SLAIN!', tone: 'kill', sub: [killer, ' slew ', victim, { text: `+${UNITS.hero.bounty} gold`, gold: true }] });
    }
  }

  function applySnapshot(next) {
    const previous = snapshot;
    snapshot = next;
    snapshotAt = performance.now();
    // The server's clock decides when the flyover lands.
    if (intro) camera.retime((next.introLeftMs ?? 0) / 1000);
    field.setRune(next.rune.kind);
    popNumbers(next);
    field.sync(next);
    // A match joined late opens already in Double Elixir or in sudden death; its clock then shows how much overtime is left.
    if (next.elixirFactor > 1) enterDoubleElixir();
    if (next.overtime) enterOvertime(next.timeLeftMs);
    for (const unit of next.units) {
      if (unit[1] === HERO_TYPE && unit[0] !== next.you.hero.id) foeHp = unit[5];
    }

    // Structure damage is read off the snapshot: no event says a Tower was hit.
    next.structures.forEach(([hp], index) => {
      view.hp[index] = hp;
      const before = previous ? previous.structures[index][0] : hp;
      if (hp >= before) return;
      const def = STRUCTURES[index];
      const own = def.side === side;
      if (hp <= 0) {
        field.fx.destroyed(def.id);
        hud.feed(`${ownerOf(def)} ${def.label} has been destroyed!`, own ? 'danger' : 'good');
        // A Throne, or anything at all in sudden death, ends the match: the finale shows and sounds that fall itself.
        if (def.kind !== 'throne' && !next.overtime) announceTower(def);
        return;
      }
      field.fx.hit(def.id, before - hp >= HEAVY_HIT);
      if (before - hp >= HEAVY_HIT) sound.play('thud', { x: def.x, z: def.z });
      // A warning bell for the player's own structures; the cue rings no more than once in ten seconds.
      if (own) sound.playWorldSfx('alarm', def.x, def.z);
      hud.markStruck(index);
      const now = performance.now();
      if (now - (noticedAt.get(def.id) ?? -Infinity) > (own ? OWN_NOTICE_MS : ENEMY_NOTICE_MS)) {
        noticedAt.set(def.id, now);
        hud.feed(`${ownerOf(def)} ${def.label} is under attack!`, own ? 'danger' : 'good');
      }
    });

    // A Throne that has fallen ends the match, and the music does not relax for it.
    throneInDanger = next.structures.some(([hp], index) => STRUCTURES[index].kind === 'throne' && hp < STRUCTURES[index].maxHp * THRONE_DANGER);
    scoreMusic();
    // The hero's own heart is heard once it is close to death, and faster the closer it comes.
    const { hp, respawnMs } = next.you.hero;
    const health = hp / HERO.maxHp;
    sound.setHeartbeat(!finished && hp > 0 && respawnMs <= 0 && health < LOW_HEALTH ? Math.max(0.01, 1 - health / LOW_HEALTH) : 0);
  }

  /** The battle theme drives harder as the stakes rise: Double Elixir or a Throne in danger, then sudden death, or both of the former at once. */
  function scoreMusic() {
    sound.setIntensity(overtime || (doubleElixir && throneInDanger) ? 2 : doubleElixir || throneInDanger ? 1 : 0);
  }

  /* ---------------------------------------------------------------- Layout */

  function layout() {
    if (!active) return;
    const top = hud.els.top.getBoundingClientRect().bottom + 4;
    const panels = Math.min(hud.els.heroPanel.getBoundingClientRect().top, hud.els.dock.getBoundingClientRect().top);
    field.resize(window.innerWidth, window.innerHeight, { top, bottom: window.innerHeight - panels + 4 });
    barScale = field.pixelsPerUnit;
    hud.layout(field.project, barScale);
    hud.placeAnnouncer(top);
  }

  /* ---------------------------------------------------------------- Camera */

  const ownHero = () => {
    const at = field.heroView(side);
    return at && !at.dead ? at : null;
  };

  function setLocked(next) {
    locked = next;
    camera.setFollow(next ? ownHero : null);
    // A freed camera stays where it is rather than gliding on to wherever it was heading.
    if (!next) camera.lookAt(camera.focus.x, camera.focus.z);
    hud.setCameraLocked(next);
  }

  /** Pans the camera from the keys held and from the cursor resting against a screen edge. */
  function steerCamera(dt) {
    let x = 0;
    let y = 0;
    if (!intro && !finished) {
      for (const code of panKeys) {
        x += PAN_KEYS[code][0];
        y += PAN_KEYS[code][1];
      }
      if (cursor && !grab) {
        const band = cursor.overField ? EDGE_PX.field : EDGE_PX.hud;
        if (cursor.x <= band) x -= 1;
        else if (cursor.x >= window.innerWidth - 1 - band) x += 1;
        if (cursor.y <= band) y += 1;
        else if (cursor.y >= window.innerHeight - 1 - band) y -= 1;
      }
    }
    if ((x || y) && locked) setLocked(false);
    // The pan eases in and out rather than starting and stopping dead.
    const ease = 1 - Math.exp(-dt * 12);
    panning.x += (Math.sign(x) * PAN_SPEED - panning.x) * ease;
    panning.y += (Math.sign(y) * PAN_SPEED - panning.y) * ease;
    if (!locked && Math.abs(panning.x) + Math.abs(panning.y) > 0.05) camera.pan(panning.x * dt, panning.y * dt);
  }

  /** The opening flyover: from the enemy Throne, across the River, to land on the player's hero. */
  function beginIntro(ms) {
    const home = heroSpawn(side);
    clearTimeout(cinemaTimer);
    if (ms < 1_000) {
      // Too little of it left to fly: open on the hero.
      intro = false;
      camera.land();
      camera.lookAt(home.x, home.z, true);
      hud.cinema('off');
      setLocked(true);
      return;
    }
    const throne = STRUCTURES.find((s) => s.side === opposite(side) && s.kind === 'throne');
    intro = true;
    root.classList.add('intro');
    hud.cinema('overview');
    // A war horn carries over the field as the flyover sets off, and the wind is heard for as long as the camera flies.
    sound.play('horn');
    sound.play('wind', { seconds: ms / 1000 });
    camera.setFollow(null);
    camera.fly({
      from: { x: throne.x, z: throne.z },
      to: () => ownHero() ?? home,
      seconds: ms / 1000,
      hold: INTRO.holdS,
      arc: INTRO.arc,
      onArrive: endIntro,
    });
  }

  function endIntro() {
    intro = false;
    root.classList.remove('intro');
    hud.cinema('fight');
    cinemaTimer = setTimeout(() => hud.cinema('off'), INTRO.fightMs);
    // The battle begins: the horn calls twice.
    sound.play('horn', { calls: 2 });
    setLocked(true);
    hud.feed(`The battle begins! You command ${heroName(side)} against ${heroName(opposite(side))}.`, 'gold');
    hud.feed('Right-click to move and attack. Q W E R cast, Z X buy relics, 1-4 arm a card.', 'info');
    hud.feed('Camera: hold a mouse button and drag the map, push the mouse to a screen edge, or use the arrow keys or A S D. The wheel zooms; Space locks it on your hero.', 'info');
  }

  /* ---------------------------------------------------------------- Cursor */

  /** The ground point under a client position, whether over the battlefield or the minimap. */
  function worldAt(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    if (target === canvas) return field.pick(clientX, clientY);
    if (target === hud.els.minimap) return hud.minimapToWorld(clientX, clientY);
    return null;
  }

  const aim = () => (pointer ? worldAt(pointer.x, pointer.y) : null);

  /* ---------------------------------------------------------------- Cards */

  function setArmed(slot) {
    armed = slot;
    root.classList.toggle('arming', slot !== null);
    refreshPreview(slot === null ? null : aim());
  }

  /** The player takes a card up out of the hand, or with null puts the armed one back: either is heard. */
  function chooseCard(slot) {
    if (slot === armed) return;
    sound.play(slot === null ? 'cardCancel' : 'cardArm');
    setArmed(slot);
  }

  /** Draws the placement circle at `point`: green where the armed card may land, red where it may not. */
  function refreshPreview(point) {
    const card = armedCard();
    if (!card || !point) {
      field.setPreview(null);
      return;
    }
    field.setPreview({
      x: point.x,
      z: point.z,
      radius: card.radius,
      side,
      restricted: card.zone === 'own',
      valid: canDeploy(card, side, point.x, point.z).ok && elixirNow() >= card.cost,
    });
  }

  function deploy(point) {
    const card = armedCard();
    if (!card || !point || finished || intro) return;
    if (elixirNow() < card.cost) {
      hud.hint('Not enough Elixir');
      hud.denyCard(armed);
      return;
    }
    const placement = canDeploy(card, side, point.x, point.z);
    if (!placement.ok) {
      hud.hint(placement.reason);
      return;
    }
    socket.emit('game:playCard', { slot: armed, x: point.x, z: point.z });
    setArmed(null);
  }

  /* ---------------------------------------------------------------- Hero */

  /** Sends the hero to a ground point, or at the enemy standing on it. */
  function orderHero(point) {
    if (!point || finished || intro) return;
    if (snapshot.you.hero.respawnMs > 0) {
      hud.hint('Your hero is respawning');
      return;
    }
    const target = field.pickTarget(point.x, point.z, side);
    if (target) socket.emit('game:attack', { id: target });
    else socket.emit('game:move', { x: point.x, z: point.z });
    // The order is felt under the cursor: a click in the ground, harder when it is an attack.
    sound.play(target ? 'attackClick' : 'moveClick');
    field.fx.marker(point.x, point.z, Boolean(target));
    setWaypoint(target ? null : { x: point.x, z: point.z });
  }

  function cast(key) {
    if (finished || intro) return;
    const ability = abilities.get(key);
    if (snapshot.you.hero.respawnMs > 0) {
      hud.hint('Your hero is respawning');
      hud.denySlot(key);
    } else if (cooldownNow(key) > 0) {
      hud.hint(`${ability.name} is on cooldown`);
      hud.denySlot(key);
    } else if (snapshot.you.hero.mana < ability.manaCost) {
      hud.hint('Not enough mana');
      hud.denySlot(key);
    } else {
      hud.pressSlot(key);
      socket.emit('game:cast', { key, ...aim() });
    }
  }

  function useItem(key) {
    if (finished || intro) return;
    const item = ITEMS.get(key);
    const { hero } = snapshot.you;
    if (item.cost && !hero.owned[key]) {
      // The first press buys the relic.
      if (hero.gold < item.cost) {
        hud.hint(`${item.name} costs ${item.cost} gold`);
        hud.denySlot(key);
      } else {
        hud.pressSlot(key);
        socket.emit('game:useItem', { key });
      }
    } else if (item.passive) {
      hud.hint(`${item.name} is always active`);
    } else if (hero.respawnMs > 0) {
      hud.hint('Your hero is respawning');
      hud.denySlot(key);
    } else if (item.holdsRune && !hero.rune) {
      hud.hint('The Rune Bottle is empty. Walk onto the River pad when a rune appears');
      hud.denySlot(key);
    } else if (cooldownNow(key) > 0) {
      hud.hint(`${item.name} is on cooldown`);
      hud.denySlot(key);
    } else {
      hud.pressSlot(key);
      socket.emit('game:useItem', { key, ...aim() });
    }
  }

  /* ---------------------------------------------------------------- Input */

  function onKeyDown(event) {
    if (!active || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code in PAN_KEYS) {
      panKeys.add(event.code);
      event.preventDefault();
      return;
    }
    if (event.repeat) return;
    if (event.code === 'Escape') {
      chooseCard(null);
    } else if (finished || intro) {
      return;
    } else if (event.code === 'Space') {
      // Space on a focused button would also press it.
      if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
      setLocked(!locked);
    } else if (event.code in CARD_KEYS) {
      const slot = CARD_KEYS[event.code];
      chooseCard(armed === slot ? null : slot);
    } else if (event.code in ACTION_KEYS) {
      const key = ACTION_KEYS[event.code];
      if (abilities.has(key)) cast(key);
      else useItem(key);
    } else {
      return;
    }
    event.preventDefault();
  }

  function onKeyUp(event) {
    panKeys.delete(event.code);
  }

  /** The window lost the keyboard or the mouse: nothing is held any more. */
  function onBlur() {
    panKeys.clear();
    cursor = null;
  }

  // The placement circle follows the cursor wherever it goes; off the map it hides.
  function onPointerMove(event) {
    pointer = { x: event.clientX, y: event.clientY };
    cursor = { x: event.clientX, y: event.clientY, overField: event.target === canvas };
    if (armed !== null && !drag) refreshPreview(aim());
  }

  /** What a click on the battlefield does: play the armed card, put it back, or order the hero. */
  function clickField(button, clientX, clientY) {
    const point = field.pick(clientX, clientY);
    if (button === 0 && armed !== null) deploy(point);
    else if (button === 2 && armed !== null) chooseCard(null);
    else orderHero(point);
  }

  function startDragging() {
    grab.dragging = true;
    root.classList.add('grabbing');
    if (locked) setLocked(false);
  }

  // Any mouse button takes hold of the ground. The middle button drags it at once. The left and right buttons
  // start dragging once the cursor has moved a little, so a plain click still gives its order, on release.
  canvas.addEventListener('pointerdown', (event) => {
    if (grab || event.button > 2) return;
    if (event.button === 1) event.preventDefault();
    if (intro || finished) return;
    grab = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, dragging: false };
    canvas.setPointerCapture(event.pointerId);
    if (event.button === 1) startDragging();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!grab || event.pointerId !== grab.id) return;
    const dx = event.clientX - grab.x;
    const dy = event.clientY - grab.y;
    if (!grab.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      startDragging();
    }
    camera.drag(dx, dy);
    grab.x = event.clientX;
    grab.y = event.clientY;
  });
  for (const type of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(type, (event) => {
      if (!grab || event.pointerId !== grab.id) return;
      const { button, dragging } = grab;
      grab = null;
      root.classList.remove('grabbing');
      if (!dragging && type === 'pointerup') clickField(button, event.clientX, event.clientY);
    });
  }
  // Without this a middle click starts the browser's own auto-scroll.
  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  // A right-button drag can end anywhere, and the browser's menu has no place in the game.
  root.addEventListener('contextmenu', (event) => event.preventDefault());
  // The wheel moves the camera a little closer (up) or farther (down); the page itself never scrolls or zooms.
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (intro || finished) return;
      // Some mice report lines or pages rather than pixels.
      const pixels = event.deltaY * (event.deltaMode === 1 ? WHEEL_NOTCH_PX / 3 : event.deltaMode === 2 ? WHEEL_NOTCH_PX : 1);
      camera.zoomBy(Math.max(-1, Math.min(1, pixels / WHEEL_NOTCH_PX)));
    },
    { passive: false },
  );

  // Cards: click to arm, or drag onto the battlefield or minimap to deploy.
  hud.els.hand.addEventListener('pointerdown', (event) => {
    const card = event.target.closest('.hand-card');
    if (!card || event.button !== 0 || finished) return;
    drag = { slot: Number(card.dataset.slot), x: event.clientX, y: event.clientY, moved: false };
    card.setPointerCapture(event.pointerId);
  });
  hud.els.hand.addEventListener('pointermove', (event) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      chooseCard(drag.slot);
      hud.showGhost(snapshot.you.hand[drag.slot], event.clientX, event.clientY);
    }
    hud.moveGhost(event.clientX, event.clientY);
    refreshPreview(worldAt(event.clientX, event.clientY));
  });
  hud.els.hand.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const { slot, moved } = drag;
    drag = null;
    hud.hideGhost();
    if (!moved) {
      chooseCard(armed === slot ? null : slot);
      return;
    }
    const point = worldAt(event.clientX, event.clientY);
    if (point) deploy(point);
    // A drag that ends anywhere else, or on an invalid spot, puts the card back.
    chooseCard(null);
  });
  hud.els.hand.addEventListener('pointercancel', () => {
    drag = null;
    hud.hideGhost();
    chooseCard(null);
  });

  // Minimap: left-click or drag moves the camera there (or deploys the armed card); Alt-click drops a ping;
  // right-click sends the hero.
  let scouting = false;
  hud.els.minimap.addEventListener('pointerdown', (event) => {
    const point = hud.minimapToWorld(event.clientX, event.clientY);
    if (!point || intro || finished) return;
    if (event.button === 2) {
      if (armed !== null) chooseCard(null);
      else orderHero(point);
    } else if (event.button === 0 && armed !== null) {
      deploy(point);
    } else if (event.button === 0 && event.altKey) {
      hud.ping(point.x, point.z);
      field.fx.ping(point.x, point.z);
    } else if (event.button === 0) {
      scouting = true;
      hud.els.minimap.setPointerCapture(event.pointerId);
      if (locked) setLocked(false);
      camera.lookAt(point.x, point.z);
    }
  });
  hud.els.minimap.addEventListener('pointermove', (event) => {
    if (!scouting) return;
    // A drag may leave the minimap: the camera goes to the nearest point still on it.
    const point = hud.minimapToWorld(event.clientX, event.clientY, true);
    camera.lookAt(point.x, point.z);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    hud.els.minimap.addEventListener(type, () => {
      scouting = false;
    });
  }
  hud.els.minimap.addEventListener('contextmenu', (event) => event.preventDefault());
  hud.els.cameraLock.addEventListener('click', () => {
    if (!intro && !finished) setLocked(!locked);
    hud.els.cameraLock.blur();
  });

  for (const container of [document.getElementById('abilities'), document.getElementById('items')]) {
    container.addEventListener('click', (event) => {
      const key = event.target.closest('.skill')?.dataset.key;
      if (!key) return;
      if (abilities.has(key)) cast(key);
      else useItem(key);
    });
  }

  // Leaving takes two clicks so a stray one cannot forfeit the match.
  hud.els.leave.addEventListener('click', () => {
    if (hud.els.leave.classList.contains('confirm')) {
      onExit();
      return;
    }
    hud.els.leave.classList.add('confirm');
    hud.els.leave.textContent = 'Confirm Leave';
    leaveTimer = setTimeout(resetLeaveButton, 3_000);
  });
  // What the field itself reports: attacks, troops falling, the finale. Each is heard from where it happened.
  field.onCue = (name, x, z, detail) => sound.playWorldSfx(name, x, z, detail);
  hud.els.resultButton.addEventListener('click', () => onExit());
  hud.els.playAgain.addEventListener('click', () => onPlayAgain());

  function resetLeaveButton() {
    clearTimeout(leaveTimer);
    hud.els.leave.classList.remove('confirm');
    hud.els.leave.textContent = 'Leave Match';
  }

  /* ---------------------------------------------------------------- Server events */

  /** Elixir runs twice as fast from now to the end of the match. Announced once, whether the event or a snapshot says so first. */
  function enterDoubleElixir() {
    if (doubleElixir) return;
    doubleElixir = true;
    scoreMusic();
    hud.setDoubleElixir(true, true);
    hud.announce({ title: 'DOUBLE ELIXIR (2X)!', tone: 'elixir', sub: ['Elixir flows twice as fast'] });
    hud.feed('Double Elixir! Elixir now flows twice as fast.', 'gold');
  }

  /** The clock has run out with both Thrones standing: `ms` is the length of the overtime. */
  function enterOvertime(ms) {
    if (overtime) return;
    overtime = true;
    scoreMusic();
    const seconds = Math.round(ms / 1000);
    hud.announce({ title: 'SUDDEN DEATH OVERTIME!', tone: 'overtime', sub: [{ text: `+${clock(seconds)}`, gold: true }, ' The first Tower or Throne to fall loses'] });
    hud.feed('Sudden death! The first Tower or Throne to fall loses the match.', 'danger');
  }

  socket.on('game:state', (next) => {
    if (active) applySnapshot(next);
  });

  function onEvent(event) {
    const mine = event.side === side;
    switch (event.type) {
      case 'card': {
        const card = CARD_BY_ID.get(event.card);
        if (!card) break;
        field.fx.card(card, event.side, event.x, event.z);
        // Every card has a sound of its own, heard from where it lands; the Fireball's lasts as long as its flight.
        // The player's own card is still heard, faintly, when it lands too far off screen to carry.
        const cue = CARD_CUES[card.id] ?? 'deploy';
        const detail = card.travelMs ? { travel: card.travelMs / 1000 } : { building: card.type === 'Building' };
        if (!sound.playWorldSfx(cue, event.x, event.z, detail) && mine) sound.play(cue, { ...detail, gain: FAR_CARD_GAIN });
        if (!mine) hud.feed(`Enemy ${card.type === 'Spell' ? 'cast' : 'deployed'} ${card.name}`, 'info');
        break;
      }
      case 'cast': {
        // Either side's casts follow that side's own champion.
        const ability = champion(event.side).abilities.find((candidate) => candidate.id === event.ability);
        if (!ability) break;
        field.fx.cast(event, ability);
        // Heard where it lands; a spell that takes its time builds up to the moment it does.
        sound.play(CAST_CUES[ability.id], {
          x: event.tx ?? event.x,
          z: event.tz ?? event.z,
          gather: (ability.delayMs ?? 0) / 1000,
          fall: (ability.delayMs ?? 0) / 1000,
          duration: (ability.durationMs ?? 0) / 1000,
          tick: (ability.tickMs ?? 500) / 1000,
        });
        if (!mine && ability.ultimate) hud.feed(`${heroName(event.side)} unleashed ${ability.name}!`, 'danger');
        break;
      }
      case 'level':
        field.fx.levelUp(event.side);
        sound.play('levelUp', { ...field.heroView(event.side), gain: mine ? 1 : 0.5 });
        hud.feed(mine ? `${heroName(side)} reached level ${event.level}!` : `Enemy ${heroName(event.side)} reached level ${event.level}`, mine ? 'gold' : 'info');
        break;
      case 'doubleElixir':
        enterDoubleElixir();
        break;
      case 'overtime':
        enterOvertime(event.ms);
        break;
      case 'item': {
        const item = ITEMS.get(event.key);
        if (!item) break;
        // A relic bought while respawning has no hero to light up.
        if (!event.bought || !field.heroView(event.side)?.dead) field.fx.item(event);
        if (event.bought) {
          // The purse, and then the relic itself: light boots, or a blade drawn.
          if (mine) sound.play('buy', { item: event.key });
          hud.feed(mine ? `${item.name} unlocked!` : `${heroName(event.side)} bought ${item.name}`, mine ? 'gold' : 'danger');
        } else if (event.rune) {
          const rune = RUNES[event.rune];
          sound.play('drink', { x: event.x, z: event.z, rune: event.rune });
          hud.feed(mine ? `${rune.name}! ${rune.description}` : `${heroName(event.side)} drank ${aRune(event.rune)}!`, mine ? 'gold' : 'danger');
        } else {
          sound.play('blink', { x: event.tx, z: event.tz });
        }
        break;
      }
      case 'rune':
        if (!RUNES[event.kind]) break;
        field.fx.rune(event.kind);
        field.setRune(event.kind);
        // Heard wherever the camera is: a rune is worth crossing the field for.
        sound.play('runeSpawn');
        hud.feed(`${aRune(event.kind).replace(/^a/, 'A')} has appeared on the River!`, 'gold');
        break;
      case 'runeTaken':
        if (!RUNES[event.kind]) break;
        field.fx.runeTaken(event.kind);
        field.setRune(null);
        // The player's own pick-up chimes in their ears; the enemy's is heard from the pad.
        sound.play('rune', mine ? {} : { x: 0, z: 0 });
        hud.feed(
          mine ? `${RUNES[event.kind].name} bottled! Press C to drink it.` : `${heroName(event.side)} bottled the ${RUNES[event.kind].name} rune!`,
          mine ? 'gold' : 'danger',
        );
        break;
      case 'bounty': {
        // Gold for a kill: coins burst where it fell and the amount floats up from it.
        const height = groundHeight(event.x, event.z) + (event.id < 0 ? STRUCTURES[-event.id - 1].height * 0.7 : 1.9);
        field.fx.gold(event.x, height, event.z);
        // The First Blood bonus floats above the bounty it comes with.
        if (event.bonus) hud.float(`+${event.gold}g First Blood`, event.x, height + 1.5, event.z, 'bounty');
        else hud.float(`+${event.gold}g`, event.x, height + 0.5, event.z, 'bounty');
        sound.play('gold');
        break;
      }
      case 'heroDown': {
        const seconds = Math.round(event.respawnMs / 1000);
        sound.play('heroDown', { ...field.heroView(event.side) });
        announceKill(event);
        hud.feed(
          mine ? `${heroName(side)} has fallen! Respawning in ${seconds}s.` : `${heroName(event.side)} has been slain!`,
          mine ? 'danger' : 'good',
        );
        break;
      }
      case 'reject':
        hud.hint(event.reason);
        break;
      default:
        break;
    }
  }

  socket.on('game:events', (events) => {
    if (active) events.forEach(onEvent);
  });

  /** One line on why the match ended. */
  function overReason({ reason, winner, focus, totals }) {
    if (reason === 'throne') return `The ${winner === 'radiant' ? 'Dire' : 'Radiant'} Ancient Throne has fallen.`;
    if (reason === 'sudden_death') {
      const fallen = STRUCTURES.find((def) => def.id === focus);
      return fallen
        ? `Sudden death: the ${fallen.side === 'radiant' ? 'Radiant' : 'Dire'} ${fallen.label} fell first.`
        : 'Sudden death: a structure fell first.';
    }
    const standing = (name) => `${name === 'radiant' ? 'Radiant' : 'Dire'} ${Math.ceil(totals[name].hp).toLocaleString('en-US')} HP (${Math.round((totals[name].hp / totals[name].maxHp) * 100)}%)`;
    return `Overtime ended. Structures standing: ${standing('radiant')}, ${standing('dire')}.`;
  }

  socket.on('game:over', async (over) => {
    if (!active || finished) return;
    finished = true;
    const mine = session;
    // The music and the hero's heart fall silent: the closing shot is heard on its own.
    sound.setMusic(null);
    sound.setHeartbeat(0);
    // The match is decided: nothing the player held or armed may still act.
    setArmed(null);
    drag = null;
    grab = null;
    scouting = false;
    panKeys.clear();
    hud.hideGhost();
    root.classList.remove('grabbing');
    hud.clearAnnouncer();
    const outcome = over.winner === null ? 'draw' : over.winner === side ? 'victory' : 'defeat';
    const fallen = STRUCTURES.find((def) => def.id === over.focus);
    // The closing shot: the HUD stands aside, the picture is letterboxed, and the caption comes up with the blast.
    clearTimeout(cinemaTimer);
    root.classList.add('finale');
    hud.cinema('finale');
    await field.finale({
      focus: over.focus,
      onBlast: () => hud.caption(`The ${fallen.side === 'radiant' ? 'Radiant' : 'Dire'} ${fallen.label}`, 'Has Fallen', fallen.side, outcome),
    });
    // The player may have left during the finale, or the opponent has; there is no summary to show then.
    if (mine !== session) return;
    hud.cinema('off');
    sound.play(outcome);
    // The fanfare has the stage to itself; then the lobby's theme comes in under the summary.
    fanfareTimer = setTimeout(() => sound.setMusic('lobby'), FANFARE_MS);
    hud.showSummary({
      outcome,
      title: { draw: 'Draw', victory: 'Victory', defeat: 'Defeat' }[outcome],
      detail: overReason(over),
      durationMs: over.durationMs,
      overtime: over.overtime,
      winner: over.winner,
      columns: [side, opposite(side)].map((name) => ({
        side: name,
        name: players[name].nickname,
        hero: heroName(name),
        you: name === side,
        stats: over.stats[name],
      })),
    });
  });

  /* ---------------------------------------------------------------- Lifecycle */

  return {
    /** `start` is the server's match:start payload: { side, players, state }. */
    start(start) {
      active = true;
      finished = false;
      session++;
      doubleElixir = false;
      overtime = false;
      throneInDanger = false;
      clearTimeout(fanfareTimer);
      // The battle theme takes over from the lobby's; the first snapshot says how hard it drives.
      sound.setMusic('battle');
      side = start.side;
      players = start.players;
      abilities = new Map(champion(side).abilities.map((ability) => [ability.key, ability]));
      snapshot = null;
      elixirWhole = null;
      armed = null;
      drag = null;
      waypoint = null;
      foeHp = HERO.maxHp;
      noticedAt.clear();
      panKeys.clear();
      cursor = null;
      grab = null;
      panning.x = panning.y = 0;
      resetLeaveButton();
      root.hidden = false;
      root.classList.remove('arming', 'intro', 'grabbing', 'finale');

      field.reset();
      field.setHeroes({ radiant: players.radiant.hero, dire: players.dire.hero });
      hud.setup(start);
      applySnapshot(start.state);
      layout();
      beginIntro(start.state.introLeftMs ?? 0);
      if (!intro) endIntro();
      field.start();
      window.addEventListener('resize', layout);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
      window.addEventListener('pointermove', onPointerMove);
      document.documentElement.addEventListener('pointerleave', onBlur);
      // Web fonts can change the HUD's size after the first layout.
      document.fonts?.ready.then(layout);
    },

    stop() {
      if (!active) return;
      active = false;
      session++;
      intro = false;
      clearTimeout(cinemaTimer);
      clearTimeout(fanfareTimer);
      sound.setHeartbeat(0);
      sound.setIntensity(0);
      camera.land();
      hud.cinema('off');
      field.stop();
      window.removeEventListener('resize', layout);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('pointerleave', onBlur);
      root.classList.remove('intro', 'finale');
      root.hidden = true;
    },

    /** Renderer counters, for diagnostics from the browser console. */
    stats: () => field.stats(),
    /** More console diagnostics: world-to-screen projection, a switch that pins render quality, and the effect table. */
    project: (x, y, z) => field.project(x, y, z),
    lockQuality: (locked) => field.lockQuality(locked),
    fx: field.fx,
    heroView: (name) => field.heroView(name),
    camera,
    /** And for the announcer and the floating numbers: announce({ title, tone, sub }) and float(text, x, y, z, kind). */
    announce: (banner) => hud.announce(banner),
    float: (...args) => hud.float(...args),
  };
}
