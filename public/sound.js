/**
 * RuneDeck — sound engine.
 *
 * Every sound in the game is a *cue*, played by name:
 *
 *   sound.play('findMatch');                           in the player's ears
 *   sound.playWorldSfx('fireball', x, z, { travel });   somewhere on the battlefield
 *
 * A cue is built from layers. Where a verified recording exists (the CC0
 * samples in assets/sfx, fetched by scripts/fetch-sfx.mjs) it supplies the
 * texture a synthesiser is worst at: steel, stone, cards, coins. Everything
 * else, and the body under every sample, is synthesised here: a sub-bass
 * punch, filtered noise, detuned or frequency-modulated harmonics. A cue never
 * depends on its samples: if one is missing, fails to decode or turns out
 * silent, the cue plays a synthesised layer in its place.
 *
 * Signal path
 *   voices ─┬────────────────► SFX volume ─┐
 *           └► cavern reverb ─►            ├─► master (mute) ─► compressor ─► out
 *   music ──┬► duck ─────────► Music vol ──┘
 *           └► cavern reverb ─►
 *
 * On the battlefield a cue is heard from where the camera looks (`listen`):
 * panned left or right, quieter with distance and silent far off screen,
 * except the alerts everyone must hear (a Tower falling, a rune, an ultimate).
 * Sounds that fire many times a second are thinned out: each cue has a
 * cooldown, at most six combat sounds play at once, and when a seventh arrives
 * the least important one makes way for it, or it is dropped.
 *
 * Browsers only let a page make sound after the player has touched it, so the
 * engine starts on the first click or key press anywhere on the page (and the
 * sound of that touch itself is played the moment it has). Until then, and
 * while muted or in a hidden tab, `play` does nothing.
 */

import { createMusic } from './music.js';

const STORAGE_KEY = 'runedeck.audio';
/** Where the volume was kept before there was a mixer. */
const LEGACY_KEY = 'runedeck.sound';
const ASSETS = new URL('./assets/sfx/', import.meta.url);
/** A file this small cannot be a sound effect: more likely an error page. */
const MIN_SAMPLE_BYTES = 2048;

/** Distance at which a sound on the field is heard at half strength, in world units. */
const HALF_DISTANCE = 14;
/** How far to either side of the listener a sound is panned fully left or right. */
const PAN_REACH = 28;
/** A sound on the field weaker than this is too far off screen to be played at all. */
const AUDIBLE = 0.1;
/** An alert is never quieter than this share of its strength, wherever the camera is. */
const GLOBAL_FLOOR = 0.5;
/** How far the pitch of a repeating sound may wander, so that no two blows sound the same. */
const PITCH_SPREAD = [0.93, 1.07];
/** How important a cue is: when voices run out, the higher tier is the one that is heard. */
const TIER = { ambient: 0, combat: 1, hero: 2, spell: 3, alert: 4 };
/** How many voices of each group may sound at once. */
const GROUP_CAP = { combat: 6, spell: 8, ui: 8 };
const MAX_VOICES = 30;
/** A voice counts against its group's cap for at most this long: a long tail does not hold a place. */
const BUSY_MS = 600;
/** A cue asked for while the audio context is starting is still worth playing if it starts within this long. */
const WAKE_GRACE_MS = 400;

const midi = (note) => 440 * 2 ** ((note - 69) / 12);
const rand = (low, high) => low + Math.random() * (high - low);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/* -------------------------------------------------------------------------- */
/* Samples                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The recordings in assets/sfx, as the manifest lists them. Each is fetched,
 * checked and decoded once; one library serves every engine on the page.
 * `results` says what became of every file, for `SoundEngine.assets()`.
 */
export class SampleLibrary {
  /** group -> [{ buffer, level, file }] */
  #groups = new Map();
  #lastPick = new Map();
  #loading = null;
  /** 'idle', 'loading', 'ready', or 'unavailable' when there is no manifest to read. */
  state = 'idle';
  error = null;
  /** One entry per file: { group, file, ok, seconds, peak } or { group, file, ok: false, reason }. */
  results = [];

  /** Loads everything the manifest lists. Never rejects: a sample that cannot be used is simply not there. */
  load() {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load() {
    this.state = 'loading';
    try {
      const response = await fetch(new URL('manifest.json', ASSETS), { cache: 'no-cache' });
      if (!response.ok) throw new Error(`manifest: HTTP ${response.status}`);
      const manifest = await response.json();
      const Offline = window.OfflineAudioContext ?? window.webkitOfflineAudioContext;
      // Decoding needs a context but not a running one, so it can happen before the player's first click.
      const decoder = new Offline(1, 1, 44100);
      const jobs = Object.entries(manifest.sounds ?? {}).flatMap(([group, files]) => files.map(({ file }) => ({ group, file })));
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) this.results.push(await this.#one(decoder, jobs[next++]));
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      this.state = 'ready';
    } catch (error) {
      this.state = 'unavailable';
      this.error = String(error?.message ?? error);
    }
    return this;
  }

  /** Fetches and decodes one file. It is kept only if it really is audio: the right status, enough bytes, decodable, audible. */
  async #one(decoder, { group, file }) {
    try {
      const response = await fetch(new URL(file, ASSETS));
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      if (/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new Error('an HTML page, not audio');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength <= MIN_SAMPLE_BYTES) throw new Error(`only ${bytes.byteLength} bytes`);
      // The callback form: older Safari has no promise here.
      const buffer = await new Promise((resolve, reject) => decoder.decodeAudioData(bytes, resolve, () => reject(new Error('could not be decoded'))));
      let peak = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      }
      if (buffer.duration < 0.015) throw new Error('no length');
      if (peak < 0.02) throw new Error('silent');
      // Every sample plays as if it had been recorded at the same level.
      const list = this.#groups.get(group) ?? [];
      list.push({ buffer, level: Math.min(0.9 / peak, 16), file, reversed: null });
      this.#groups.set(group, list);
      return { group, file, ok: true, seconds: Number(buffer.duration.toFixed(3)), peak: Number(peak.toFixed(3)) };
    } catch (error) {
      return { group, file, ok: false, reason: String(error?.message ?? error) };
    }
  }

  has(group) {
    return this.#groups.has(group);
  }

  /** One recording of a group: the variant `index` (wrapping), or a random one that is not the one played last. */
  pick(group, index) {
    const list = this.#groups.get(group);
    if (!list) return null;
    if (index !== undefined) return list[index % list.length];
    let at = Math.floor(Math.random() * list.length);
    if (list.length > 1 && at === this.#lastPick.get(group)) at = (at + 1) % list.length;
    this.#lastPick.set(group, at);
    return list[at];
  }
}

/* -------------------------------------------------------------------------- */
/* Layers shared by many cues                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Each cue builds its sound from the engine's instruments (`s.tone`, `s.stack`,
 * `s.noise`, `s.fm`, `s.bell`, `s.chord`, `s.sample`) on a voice `v`, with
 * whatever `p` the caller passed. Times are in seconds from the start of the
 * cue. `s.sample` returns false when the recording is not available, and the
 * cue then synthesises that layer instead.
 */

/** The body of an impact: a sine that drops in pitch, felt more than heard. */
function sub(s, v, { f = 95, to = 36, at = 0, dur = 0.45, g = 0.7 } = {}) {
  s.tone(v, { f, to, at, dur, g });
}

/** A heavy blast: the body, the crack (recorded if possible), the roar and the debris. `size` scales its length and weight. */
function boom(s, v, at = 0, size = 1, crack = 'bang') {
  sub(s, v, { f: 125, to: 30, at, dur: 0.7 * size, g: 0.8 });
  if (!s.sample(v, crack, { at, g: 0.75 })) s.noise(v, { at, dur: 0.09, g: 0.5, hp: 1900 });
  s.noise(v, { at, dur: 1.1 * size, g: 0.5, lp: [2800, 110], q: 0.6 });
  s.noise(v, { at: at + 0.1, dur: 0.6 * size, a: 0.05, g: 0.1, bp: [3400, 900], q: 3 });
}

/** A rush of air: its pitch runs from `from` to `to`. A recorded swish rides in the middle of it. */
function swish(s, v, { at = 0, dur = 0.28, from = 320, to = 2600, g = 0.3, recorded = 'swish' } = {}) {
  s.noise(v, { at, dur, a: dur * 0.4, g, bp: [from, to], q: 1.4 });
  if (recorded) s.sample(v, recorded, { at: at + dur * 0.2, g: g * 1.7 });
}

/** Struck steel ringing on: inharmonic partials with a glint of frequency modulation. */
function ring(s, v, { at = 0, f = rand(1250, 1650), dur = 0.34, g = 0.16 } = {}) {
  s.bell(v, { f, ratios: [1, 2.32, 3.71, 5.43], at, dur, g });
  s.fm(v, { f: f * 0.5, ratio: 3.53, index: 3, indexTo: 0.2, at, dur: dur * 0.6, g: g * 0.35 });
}

/** A blade meeting something: the recorded bite if there is one, the ring, and the knock of the hilt. */
function steel(s, v, { at = 0, g = 1, pitch, recorded = 'blade' } = {}) {
  if (!s.sample(v, recorded, { at, g: 0.75 * g })) s.noise(v, { at, dur: 0.11, g: 0.34 * g, bp: [1800, 6500], q: 1.2 });
  ring(s, v, { at: at + 0.02, f: pitch, g: 0.15 * g });
  s.tone(v, { type: 'triangle', f: 230, to: 110, at: at + 0.02, dur: 0.07, g: 0.16 * g });
}

/** Sparks or embers: `count` tiny bursts scattered over `span` seconds. */
function crackle(s, v, { at = 0, span = 0.4, count = 6, g = 0.1, low = 1800, high = 4500 } = {}) {
  for (let i = 0; i < count; i++) s.noise(v, { at: at + rand(0, span), dur: 0.035, g, bp: rand(low, high), q: 3 });
}

/** A high, airy sparkle: magic settling. */
function shimmer(s, v, { at = 0, dur = 0.8, g = 0.05, f = 5200 } = {}) {
  s.noise(v, { at, dur, a: dur * 0.3, g, hp: f });
  for (let i = 0; i < 3; i++) s.tone(v, { f: rand(2600, 5200), at: at + rand(0, dur * 0.5), dur: dur * 0.5, a: 0.01, g: g * 0.5 });
}

/** A body of flame: the recorded whoosh if there is one, the roar under it and the embers after. */
function flame(s, v, { at = 0, dur = 0.6, g = 0.35 } = {}) {
  s.sample(v, 'fire', { at, g: g * 1.4, dur: dur + 0.3 });
  s.noise(v, { at, dur, a: dur * 0.25, g, bp: [380, 1700], q: 0.9 });
  s.noise(v, { at, dur: dur * 1.2, a: dur * 0.3, g: g * 0.7, lp: [220, 900], q: 0.7 });
  crackle(s, v, { at: at + dur * 0.3, span: dur * 0.9, count: 7, g: g * 0.28 });
}

/** A run of notes, `step` seconds apart. */
function arpeggio(s, v, notes, { at = 0, step = 0.06, dur = 0.4, g = 0.12, type = 'sine' } = {}) {
  notes.forEach((note, i) => s.tone(v, { type, f: midi(note), at: at + i * step, dur, g }));
}

/** A run of crystal chimes. */
function chimes(s, v, notes, { at = 0, step = 0.06, dur = 0.9, g = 0.09 } = {}) {
  notes.forEach((note, i) => s.bell(v, { f: midi(note), ratios: [1, 2, 3.01, 4.2], at: at + i * step, dur, g }));
}

/** The chord each announcer banner lands on, by the banner's tone: [notes, how bright, how long]. */
const BANNER_CHORDS = {
  blood: [[38, 50, 53, 57, 62], 2400, 2.4],
  kill: [[38, 45, 50, 57], 2800, 1.7],
  streak: [[43, 50, 55, 59, 62], 3200, 1.9],
  rampage: [[45, 52, 57, 61, 64, 69], 3800, 2.3],
  radiant: [[45, 52, 57, 61, 64], 3400, 1.9],
  dire: [[39, 46, 51, 54, 58], 2000, 2.1],
  elixir: [[52, 59, 64, 66, 68, 71], 4200, 1.8],
  overtime: [[36, 42, 48, 54], 1500, 2.6],
};

/** What a rune sounds like as it takes hold: [chord, waveform]. */
const RUNE_CHORDS = {
  damage: [[57, 64, 69, 73], 'sawtooth'],
  haste: [[64, 71, 76, 80], 'triangle'],
  regen: [[60, 67, 72, 76], 'sine'],
};

/* -------------------------------------------------------------------------- */
/* Cues                                                                       */
/* -------------------------------------------------------------------------- */

const RECIPES = {
  /* ------------------------------------------------------------ Lobby and queue */

  /** The pointer crosses something that can be pressed. */
  uiHover(s, v) {
    if (!s.sample(v, 'tick', { g: 0.5 })) s.noise(v, { dur: 0.02, g: 0.2, bp: 3200, q: 2 });
    s.tone(v, { f: 1900, to: 1500, dur: 0.035, g: 0.05 });
    s.tone(v, { type: 'triangle', f: 480, dur: 0.03, g: 0.03 });
  },
  /** A button pressed: a heavy latch of metal. */
  uiClick(s, v) {
    if (!s.sample(v, 'latch', { g: 0.8 })) {
      s.fm(v, { f: 620, ratio: 3.4, index: 5, indexTo: 0.3, dur: 0.09, g: 0.2 });
      s.noise(v, { dur: 0.03, g: 0.2, bp: 2400, q: 1.2 });
    }
    sub(s, v, { f: 150, to: 68, dur: 0.1, g: 0.32 });
    s.noise(v, { dur: 0.025, g: 0.08, hp: 4200 });
  },
  /** A champion chosen: the Aether Knight answers in bright steel, Morgath in fire and a low growl. */
  heroSelect(s, v, { hero = 'aether_knight' } = {}) {
    if (hero === 'morgath') {
      flame(s, v, { dur: 0.7, g: 0.3 });
      s.stack(v, { f: 58, to: 49, dur: 1.1, a: 0.04, hold: 0.4, g: 0.3, lp: [900, 260], drive: 0.6 });
      s.chord(v, [38, 45, 50, 53], { dur: 1.4, a: 0.03, hold: 0.3, g: 0.22, lp: [1700, 380] });
      sub(s, v, { f: 82, to: 34, dur: 0.9, g: 0.6 });
      return;
    }
    s.sample(v, 'knife', { g: 0.6 });
    steel(s, v, { at: 0.12, g: 0.8, pitch: 1480 });
    s.chord(v, [50, 57, 62, 66, 69], { type: 'triangle', at: 0.12, dur: 1.3, a: 0.02, hold: 0.3, g: 0.24, lp: [4200, 1200] });
    chimes(s, v, [81, 86, 90], { at: 0.2, step: 0.07, g: 0.06 });
    shimmer(s, v, { at: 0.15, dur: 0.9, g: 0.04 });
    sub(s, v, { f: 110, to: 55, at: 0.12, dur: 0.35, g: 0.3 });
  },
  /** A deck-builder card picked up. */
  cardPick(s, v) {
    if (!s.sample(v, 'cardSlide', { g: 0.8 })) swish(s, v, { dur: 0.16, from: 900, to: 3600, g: 0.16, recorded: null });
    s.tone(v, { f: 520, to: 700, dur: 0.07, g: 0.05 });
    s.tone(v, { type: 'triangle', f: 1040, at: 0.02, dur: 0.05, g: 0.02 });
  },
  /** A card snapped into the Battle Deck. */
  cardEquip(s, v) {
    if (!s.sample(v, 'cardPlace', { g: 0.9 })) s.noise(v, { dur: 0.05, g: 0.3, bp: [3000, 900], q: 1 });
    s.noise(v, { dur: 0.015, g: 0.14, hp: 3200 });
    sub(s, v, { f: 170, to: 90, dur: 0.07, g: 0.22 });
    s.tone(v, { type: 'triangle', f: 660, at: 0.03, dur: 0.09, g: 0.06 });
    s.tone(v, { type: 'triangle', f: 990, at: 0.08, dur: 0.14, g: 0.06 });
  },
  /** A card put back in the Reserve. */
  cardRemove(s, v) {
    if (!s.sample(v, 'cardShove', { g: 0.75 })) s.noise(v, { dur: 0.09, g: 0.22, bp: [2200, 600], q: 1 });
    s.tone(v, { type: 'triangle', f: 520, to: 390, dur: 0.11, g: 0.06 });
    sub(s, v, { f: 130, to: 70, dur: 0.06, g: 0.14 });
  },
  /** Find Match: a resonant thud, as of a great door. */
  findMatch(s, v) {
    sub(s, v, { f: 112, to: 31, dur: 1.0, g: 0.85 });
    s.sample(v, 'slam', { g: 0.6 });
    s.fm(v, { f: 98, ratio: 1.41, index: 3.5, indexTo: 0.3, dur: 1.7, g: 0.24 });
    s.noise(v, { dur: 0.7, g: 0.3, lp: [950, 80], q: 0.6 });
    s.chord(v, [38, 45, 50], { dur: 1.5, a: 0.01, hold: 0.2, g: 0.16, lp: [1300, 280] });
  },
  /** Searching: a radar pulse and its echoes. */
  queuePulse(s, v) {
    [[0, 1], [0.3, 0.42], [0.6, 0.18]].forEach(([at, level]) => {
      s.tone(v, { f: 880, to: 862, at, dur: 0.5, a: 0.004, g: 0.09 * level });
      s.bell(v, { f: 1760, ratios: [1, 2.01], at, dur: 0.6, g: 0.03 * level });
    });
    s.noise(v, { dur: 0.05, g: 0.02, bp: 2000, q: 2 });
    s.tone(v, { f: 110, dur: 0.6, a: 0.05, g: 0.04 });
  },
  /** Match Found: a gong, and brass climbing to a major chord. */
  matchFound(s, v) {
    if (!s.sample(v, 'gong', { g: 0.9 })) s.fm(v, { f: 110, ratio: 1.48, index: 6, indexTo: 0.5, dur: 2.6, g: 0.4 });
    sub(s, v, { f: 84, to: 30, dur: 1.5, g: 0.7 });
    for (const [at, notes, dur] of [[0, [50, 57, 62, 65], 0.34], [0.28, [53, 60, 65, 69], 0.34], [0.56, [50, 57, 62, 66, 69, 74], 2.1]]) {
      s.chord(v, notes, { at, dur, a: 0.015, hold: dur * 0.35, g: 0.3, lp: [3200, 900], drive: 0.35 });
    }
    s.noise(v, { at: 0.56, dur: 2.2, a: 0.01, g: 0.1, hp: 5200 });
    chimes(s, v, [86, 90, 93, 98], { at: 0.62, step: 0.09, g: 0.05 });
  },
  /** A deep war horn: one long call, or with `calls: 2` a short one answered by a long one. */
  horn(s, v, { calls = 1 } = {}) {
    const root = 98;
    let at = 0;
    for (let call = 0; call < calls; call++) {
      const long = call === calls - 1;
      const dur = long ? 2.6 : 0.85;
      // Brass: saws that scoop up into the note while the filter opens, a fifth and an octave above, a sine below.
      for (const [ratio, g, bright] of [[1, 0.34, 1250], [1.5, 0.12, 1000], [2.01, 0.09, 1400]]) {
        s.stack(v, { f: root * ratio * 0.93, to: root * ratio, glide: 0.22, at, dur, a: 0.17, hold: dur * 0.5, g, lp: [240, bright], sweep: 0.5, vib: [5.2, 1.1 * ratio], voices: 2, spread: 9, drive: 0.25 });
      }
      s.tone(v, { f: root / 2, at, dur, a: 0.12, hold: dur * 0.5, g: 0.38 });
      s.noise(v, { at, dur: dur * 0.7, a: 0.18, g: 0.03, bp: 620, q: 0.7 });
      at += long ? dur : 0.62;
    }
  },
  /** Wind over the field for `seconds`: what the camera hears as it flies. */
  wind(s, v, { seconds = 4.5 } = {}) {
    s.noise(v, { dur: seconds, a: seconds * 0.45, g: 0.26, bp: [260, 900], q: 0.8, sweep: seconds * 0.6 });
    s.noise(v, { at: seconds * 0.15, dur: seconds * 0.8, a: seconds * 0.4, g: 0.1, bp: [1100, 2600], q: 1.4, sweep: seconds * 0.5 });
    s.tone(v, { f: 58, dur: seconds, a: seconds * 0.5, g: 0.1 });
    s.tone(v, { f: 640, to: 900, dur: seconds * 0.7, at: seconds * 0.2, a: seconds * 0.3, g: 0.012, vib: [0.7, 40] });
  },

  /* ------------------------------------------------------------ Orders, gold and relics */

  /** The hero is sent somewhere: a soft click in the ground. */
  moveClick(s, v) {
    if (!s.sample(v, 'drop', { g: 0.5 })) s.noise(v, { dur: 0.03, g: 0.14, lp: 1400 });
    s.tone(v, { f: 300, to: 180, dur: 0.055, g: 0.11 });
    s.noise(v, { dur: 0.02, g: 0.05, bp: 1800, q: 1.5 });
  },
  /** The hero is sent at an enemy: harder, with an edge to it. */
  attackClick(s, v) {
    if (!s.sample(v, 'tick', { g: 0.5, rate: 0.8 })) s.noise(v, { dur: 0.02, g: 0.2, bp: 2600, q: 2 });
    s.fm(v, { f: 900, ratio: 2.4, index: 2.5, indexTo: 0.2, dur: 0.09, g: 0.08 });
    s.tone(v, { f: 240, to: 140, dur: 0.07, g: 0.13 });
  },
  /** Gold in the purse: coins, and two notes ringing over them. */
  gold(s, v) {
    if (!s.sample(v, 'coins', { g: 0.5 })) s.noise(v, { dur: 0.08, g: 0.1, bp: 6400, q: 3 });
    s.tone(v, { type: 'triangle', f: midi(91), dur: 0.16, g: 0.13 });
    s.tone(v, { type: 'triangle', f: midi(96), at: 0.065, dur: 0.24, g: 0.14 });
    s.bell(v, { f: midi(103), ratios: [1, 2.02], at: 0.065, dur: 0.3, g: 0.04 });
  },
  /** A relic bought: the purse, the clasp, and the relic itself: light boots, or a blade drawn. */
  buy(s, v, { item = 'Z' } = {}) {
    if (!s.sample(v, 'purse', { g: 0.6 })) RECIPES.gold(s, v);
    if (!s.sample(v, 'latch', { at: 0.14, g: 0.6 })) s.fm(v, { f: 700, ratio: 3.4, index: 4, indexTo: 0.3, at: 0.14, dur: 0.1, g: 0.18 });
    sub(s, v, { f: 150, to: 70, at: 0.14, dur: 0.1, g: 0.25 });
    if (item === 'X') {
      s.sample(v, 'knife', { at: 0.24, g: 0.7 });
      ring(s, v, { at: 0.34, f: 1100, dur: 0.7, g: 0.12 });
      s.chord(v, [45, 52, 57], { at: 0.3, dur: 1.0, a: 0.03, g: 0.14, lp: [1500, 400] });
      s.noise(v, { at: 0.34, dur: 0.5, a: 0.05, g: 0.06, bp: [3000, 900], q: 2 });
    } else {
      swish(s, v, { at: 0.24, dur: 0.2, from: 900, to: 4200, g: 0.14, recorded: 'whip' });
      chimes(s, v, [79, 84, 88], { at: 0.3, step: 0.06, dur: 0.6, g: 0.07 });
      s.chord(v, [67, 72, 76], { type: 'triangle', at: 0.3, dur: 0.8, a: 0.03, g: 0.1 });
    }
  },
  /** The hero is close to death: one beat of a heart. */
  heartbeat(s, v) {
    for (const [at, f, g] of [[0, 68, 0.75], [0.24, 60, 0.5]]) {
      sub(s, v, { f, to: f * 0.6, at, dur: 0.17, g });
      s.noise(v, { at, dur: 0.08, g: g * 0.3, lp: 170 });
      s.tone(v, { type: 'triangle', f: f * 2, to: f, at, dur: 0.06, g: g * 0.08 });
    }
  },
  /** One of the player's own structures is under attack: a warning bell, struck twice. */
  alarm(s, v) {
    for (const at of [0, 0.42]) {
      if (!s.sample(v, 'bell', { at, g: 0.6 })) s.bell(v, { f: 587, ratios: [1, 2.02, 2.76, 4.07], at, dur: 1.2, g: 0.2 });
      s.fm(v, { f: 587, ratio: 2.76, index: 3, indexTo: 0.4, at, dur: 1.1, g: 0.14 });
      s.tone(v, { type: 'triangle', f: 196, at, dur: 0.3, g: 0.1 });
      s.noise(v, { at, dur: 0.03, g: 0.1, bp: 2400, q: 1 });
    }
  },
  levelUp(s, v) {
    arpeggio(s, v, [72, 76, 79, 84, 88], { step: 0.055, dur: 0.45, g: 0.1, type: 'triangle' });
    s.bell(v, { f: midi(96), ratios: [1, 2, 3.01], at: 0.28, dur: 0.8, g: 0.07 });
    s.chord(v, [60, 67, 72], { type: 'sine', dur: 1.0, a: 0.05, g: 0.1 });
    shimmer(s, v, { at: 0.2, dur: 0.7, g: 0.03 });
  },

  /* ------------------------------------------------------------ Card dock and Elixir */

  /** A card armed: it slides up out of the hand, humming. */
  cardArm(s, v) {
    if (!s.sample(v, 'cardSlide', { g: 0.75, rate: 1.15 })) swish(s, v, { dur: 0.16, from: 800, to: 3800, g: 0.16, recorded: null });
    s.stack(v, { type: 'triangle', f: 220, to: 330, dur: 0.5, a: 0.1, g: 0.07, lp: 1500, voices: 3, spread: 16 });
    s.bell(v, { f: 1320, ratios: [1, 2.01, 3.02], at: 0.05, dur: 0.4, g: 0.025 });
    s.noise(v, { at: 0.03, dur: 0.4, a: 0.15, g: 0.02, hp: 5200 });
  },
  /** A card put back: the same slide run backwards, and a click as it settles. */
  cardCancel(s, v) {
    if (!s.sample(v, 'cardSlide', { g: 0.6, rate: 0.9, reverse: true })) s.noise(v, { dur: 0.16, a: 0.08, g: 0.16, bp: [2600, 500], q: 1.2 });
    s.tone(v, { type: 'triangle', f: 330, to: 220, dur: 0.14, g: 0.05 });
    if (!s.sample(v, 'tick', { at: 0.17, g: 0.3 })) s.noise(v, { at: 0.17, dur: 0.02, g: 0.12, bp: 2400, q: 2 });
    sub(s, v, { f: 120, to: 70, at: 0.17, dur: 0.05, g: 0.1 });
  },
  /** Something the player asked for cannot be done: a low, dull buzz. */
  deny(s, v) {
    for (const at of [0, 0.13]) {
      s.stack(v, { f: 92, at, dur: 0.11, a: 0.004, g: 0.24, lp: 520, voices: 2, spread: 28 });
      s.tone(v, { type: 'square', f: 69, at, dur: 0.11, g: 0.07, lp: 240 });
      s.noise(v, { at, dur: 0.04, g: 0.1, lp: 300 });
    }
  },
  /** Another point of Elixir: a droplet. */
  elixir(s, v) {
    s.tone(v, { f: 620, to: 930, dur: 0.09, g: 0.3 });
    s.tone(v, { type: 'triangle', f: 1240, at: 0.012, dur: 0.07, g: 0.07 });
    s.noise(v, { dur: 0.03, g: 0.05, bp: 3200, q: 2 });
  },
  /** The Elixir bar is full. */
  elixirFull(s, v) {
    chimes(s, v, [76, 81, 85, 88], { step: 0.07, dur: 0.6, g: 0.09 });
    s.chord(v, [64, 69, 73], { type: 'triangle', dur: 0.9, a: 0.05, g: 0.1 });
    shimmer(s, v, { at: 0.1, dur: 0.6, g: 0.025 });
  },

  /* ------------------------------------------------------------ Cards */

  /** Footmen Squad: an armoured march. */
  deployFootmen(s, v) {
    [0, 0.13, 0.26, 0.39].forEach((at, i) => {
      if (!s.sample(v, 'footstep', { at, g: i % 2 ? 0.45 : 0.6 })) s.noise(v, { at, dur: 0.08, g: 0.3, lp: [900, 200] });
      sub(s, v, { f: 105, to: 60, at, dur: 0.1, g: i % 2 ? 0.2 : 0.34 });
    });
    for (const at of [0.05, 0.3]) {
      if (!s.sample(v, 'belt', { at, g: 0.35 })) s.fm(v, { f: 1400, ratio: 2.9, index: 3, indexTo: 0.3, at, dur: 0.12, g: 0.05 });
    }
    s.sample(v, 'metal', { at: 0.4, g: 0.3 });
    s.noise(v, { dur: 0.3, a: 0.1, g: 0.06, bp: [600, 1800], q: 1 });
  },
  /** Arcane Archer: a bow drawn and loosed, and the shimmer of what it shoots. */
  deployArcher(s, v) {
    s.stack(v, { f: 180, to: 262, dur: 0.17, a: 0.02, g: 0.09, lp: 900, voices: 2, spread: 10 });
    s.sample(v, 'whip', { at: 0.18, g: 0.5 });
    s.tone(v, { type: 'triangle', f: 330, to: 150, at: 0.18, dur: 0.18, a: 0.002, g: 0.24 });
    s.noise(v, { at: 0.2, dur: 0.18, a: 0.03, g: 0.1, bp: [2600, 900], q: 2 });
    chimes(s, v, [88, 93, 95], { at: 0.22, step: 0.05, dur: 0.6, g: 0.05 });
    s.chord(v, [76, 83], { type: 'sine', at: 0.2, dur: 0.8, a: 0.05, g: 0.07 });
    shimmer(s, v, { at: 0.2, dur: 0.7, g: 0.035 });
  },
  /** Siege Golem: a boulder with legs comes down, twice. */
  deployGolem(s, v) {
    s.sample(v, 'rock', { g: 0.8 });
    s.sample(v, 'slam', { at: 0.02, g: 0.7 });
    sub(s, v, { f: 72, to: 26, dur: 0.85, g: 0.95 });
    s.noise(v, { dur: 0.7, g: 0.45, lp: [600, 80], q: 0.6 });
    crackle(s, v, { at: 0.12, span: 0.5, count: 6, g: 0.12, low: 500, high: 2200 });
    sub(s, v, { f: 62, to: 28, at: 0.34, dur: 0.5, g: 0.55 });
    s.sample(v, 'rockhit', { at: 0.34, g: 0.5 });
    s.noise(v, { at: 0.34, dur: 0.4, g: 0.25, lp: [500, 90] });
  },
  /** Frost Tower: crystal growing out of the ground. */
  deployFrost(s, v) {
    s.sample(v, 'glass', { g: 0.5 });
    chimes(s, v, [72, 76, 79, 84, 88, 91], { step: 0.05, dur: 0.7, g: 0.07 });
    s.noise(v, { dur: 0.7, a: 0.4, g: 0.07, hp: 6000 });
    s.chord(v, [84, 91], { type: 'sine', at: 0.1, dur: 0.9, a: 0.1, g: 0.06 });
    if (!s.sample(v, 'gem', { at: 0.3, g: 0.5 })) s.bell(v, { f: 2640, at: 0.3, dur: 0.5, g: 0.06 });
    sub(s, v, { f: 112, to: 50, at: 0.32, dur: 0.3, g: 0.4 });
  },
  /** Fireball: it whistles and roars through the air for `travel` seconds, and then goes off. */
  fireball(s, v, { travel = 0.9 } = {}) {
    s.tone(v, { f: 1400, to: 520, dur: travel, a: travel * 0.3, g: 0.05, vib: [9, 30] });
    s.sample(v, 'fire', { g: 0.5, dur: travel });
    s.noise(v, { dur: travel, a: travel * 0.7, g: 0.2, bp: [500, 1700], q: 0.9 });
    s.stack(v, { f: 90, to: 180, dur: travel, a: travel * 0.6, g: 0.1, lp: 600, voices: 2 });
    boom(s, v, travel, 1);
    crackle(s, v, { at: travel + 0.15, span: 0.6, count: 6, g: 0.07 });
  },
  explosion(s, v, { size = 1 } = {}) {
    boom(s, v, 0, size);
  },
  /** Healing Wave: a chord of voices opening upwards. */
  healWave(s, v) {
    s.chord(v, [60, 67, 72, 76, 79], { type: 'triangle', dur: 1.9, a: 0.25, hold: 0.6, g: 0.24, lp: 2400, detune: 9 });
    s.chord(v, [84, 88, 91], { type: 'sine', at: 0.1, dur: 1.7, a: 0.4, hold: 0.4, g: 0.09, detune: 12 });
    chimes(s, v, [84, 88, 91, 96], { at: 0.15, step: 0.09, dur: 0.9, g: 0.05 });
    s.noise(v, { dur: 1.2, a: 0.4, g: 0.035, hp: 4500 });
    s.tone(v, { f: midi(48), dur: 1.7, a: 0.2, hold: 0.5, g: 0.14 });
  },
  /** Lightning Bolt: a snap out of a clear sky and the zap of it earthing. Short and dry. */
  lightning(s, v) {
    if (!s.sample(v, 'crack', { g: 0.7 })) s.noise(v, { dur: 0.07, g: 0.7, hp: 1800 });
    s.noise(v, { dur: 0.035, g: 0.5, hp: 3000 });
    s.stack(v, { f: 3600, to: 180, dur: 0.15, g: 0.2, voices: 2, spread: 30 });
    s.fm(v, { f: 140, ratio: 7.3, index: 12, indexTo: 1, dur: 0.26, g: 0.2 });
    sub(s, v, { f: 90, to: 40, at: 0.01, dur: 0.3, g: 0.5 });
    crackle(s, v, { at: 0.08, span: 0.35, count: 5, g: 0.16, low: 2500, high: 6000 });
  },
  /** Valkyrie Spinner: an axe spun up to speed, and its ring as she lands. */
  deployValkyrie(s, v) {
    [[0, 0.16, 380, 1500, 0], [0.15, 0.13, 480, 2100, 1], [0.27, 0.11, 600, 2800, 2]].forEach(([at, dur, from, to, index]) => {
      s.noise(v, { at, dur, a: dur * 0.4, g: 0.26, bp: [from, to], q: 1.4 });
      s.sample(v, 'swish', { at, g: 0.5, rate: 0.9 + index * 0.12, index });
    });
    steel(s, v, { at: 0.36, g: 0.6, pitch: 1180 });
    sub(s, v, { f: 110, to: 50, at: 0.38, dur: 0.2, g: 0.4 });
  },
  /** A card this engine knows no particular sound for. */
  deploy(s, v, { building = false } = {}) {
    swish(s, v, { dur: 0.3, from: 300, to: 2600, g: 0.26 });
    s.tone(v, { f: 420, to: 840, at: 0.05, dur: 0.26, g: 0.09 });
    sub(s, v, { f: building ? 80 : 110, to: 45, at: 0.2, dur: building ? 0.4 : 0.22, g: building ? 0.6 : 0.35 });
    if (building) s.noise(v, { at: 0.2, dur: 0.3, g: 0.25, lp: [700, 150] });
  },

  /* ------------------------------------------------------------ The Aether Knight */

  /** Slash Dash: arcane steel. The blade leaves the scabbard, the rush, and the cut at the end of it. */
  dash(s, v) {
    s.sample(v, 'knife', { g: 0.5 });
    swish(s, v, { dur: 0.2, from: 500, to: 3400, g: 0.34 });
    steel(s, v, { at: 0.13 });
    s.fm(v, { f: 880, ratio: 1.5, index: 2, indexTo: 0.1, at: 0.05, dur: 0.4, g: 0.05 });
    shimmer(s, v, { at: 0.12, dur: 0.5, g: 0.03 });
  },
  /** Aegis Shield: crystal closing round the hero, and the note it holds. */
  shield(s, v) {
    s.sample(v, 'glass', { g: 0.35, rate: 1.3 });
    s.tone(v, { f: 330, to: 660, dur: 0.5, a: 0.06, g: 0.16 });
    s.tone(v, { f: 495, to: 990, dur: 0.5, a: 0.08, g: 0.08 });
    s.bell(v, { f: 1320, ratios: [1, 2, 3.01], at: 0.25, dur: 0.9, g: 0.1 });
    s.chord(v, [69, 76, 81], { type: 'sine', at: 0.2, dur: 1.2, a: 0.15, g: 0.12 });
    s.noise(v, { dur: 0.5, a: 0.2, g: 0.04, hp: 5000 });
    sub(s, v, { f: 130, to: 80, at: 0.25, dur: 0.25, g: 0.25 });
  },
  /** Thunder Strike: a thunderbolt. The crack, the bolt, and thunder rolling away after it. */
  thunder(s, v) {
    if (!s.sample(v, 'crack', { g: 0.8 })) s.noise(v, { dur: 0.07, g: 0.7, hp: 1800 });
    s.stack(v, { f: 3400, to: 160, dur: 0.16, g: 0.22, voices: 2, spread: 24 });
    s.fm(v, { f: 110, ratio: 5.1, index: 9, indexTo: 0.5, dur: 0.4, g: 0.16 });
    sub(s, v, { f: 78, to: 32, at: 0.02, dur: 0.75, g: 0.6 });
    s.noise(v, { at: 0.03, dur: 1.3, g: 0.45, lp: [950, 70], q: 0.6 });
    s.noise(v, { at: 0.5, dur: 0.9, a: 0.2, g: 0.16, lp: [300, 90] });
    crackle(s, v, { at: 0.1, span: 0.4, count: 4, g: 0.14, low: 2500, high: 6000 });
  },
  /** Divine Judgment: a beam from above. It gathers for `gather` seconds, lands, and burns for `duration`, pulsing every `tick`. */
  judgment(s, v, { gather = 0.4, duration = 3, tick = 0.5 } = {}) {
    s.chord(v, [57, 64, 69, 73], { type: 'sine', dur: gather + 0.4, a: gather, g: 0.2 });
    s.noise(v, { dur: gather + 0.05, a: gather, g: 0.16, bp: [800, 5200], q: 1.4 });
    s.tone(v, { f: 3200, to: 640, dur: gather, a: gather * 0.5, g: 0.05 });
    boom(s, v, gather, 1.15, 'cannon');
    s.chord(v, [45, 57, 64, 69, 76], { at: gather, dur: duration + 0.7, a: 0.03, hold: duration * 0.7, g: 0.2, lp: [3200, 900] });
    s.fm(v, { f: 110, ratio: 2, index: 3, indexTo: 1, at: gather, dur: duration + 0.3, a: 0.05, hold: duration * 0.8, g: 0.07 });
    for (let at = tick; at <= duration + 0.01; at += tick) {
      s.noise(v, { at: gather + at, dur: 0.2, g: 0.16, bp: 1800, q: 1.1 });
      s.bell(v, { f: midi(81), ratios: [1, 2, 3], at: gather + at, dur: 0.35, g: 0.05 });
    }
  },

  /* ------------------------------------------------------------ Morgath */

  /** Magma Cleave: a blade of fire through the air, and a growl under it. */
  cleave(s, v) {
    s.sample(v, 'swish', { g: 0.5, rate: 0.75 });
    flame(s, v, { dur: 0.36, g: 0.36 });
    s.stack(v, { f: 150, to: 68, dur: 0.34, g: 0.22, lp: [1400, 400], drive: 0.5 });
    sub(s, v, { f: 92, to: 44, at: 0.08, dur: 0.3, g: 0.4 });
  },
  /** Flame Cloak: fire catching all at once, and roaring. */
  cloak(s, v) {
    flame(s, v, { dur: 0.7, g: 0.34 });
    s.sample(v, 'fire', { at: 0.3, g: 0.35, rate: 0.8 });
    s.stack(v, { f: 78, to: 124, dur: 0.7, a: 0.1, g: 0.18, lp: 700, drive: 0.6 });
    s.noise(v, { dur: 1.0, a: 0.3, g: 0.22, lp: [200, 1000], q: 0.7 });
    sub(s, v, { f: 64, to: 52, dur: 0.6, g: 0.3 });
  },
  /** Obsidian Spike: stone breaking through the ground, one spike after another. */
  spikes(s, v) {
    sub(s, v, { f: 84, to: 34, dur: 0.5, g: 0.5 });
    for (let i = 0; i < 5; i++) {
      const at = i * 0.055;
      if (!s.sample(v, 'stone', { at, g: 0.5, rate: 1.1 - i * 0.05 })) s.noise(v, { at, dur: 0.13, g: 0.34, lp: [1500, 280], q: 1.2 });
      s.tone(v, { f: 190 - i * 14, to: 66, at, dur: 0.11, g: 0.24 });
    }
    s.sample(v, 'rockhit', { at: 0.24, g: 0.6 });
    s.noise(v, { at: 0.26, dur: 0.07, g: 0.26, hp: 2400 });
    crackle(s, v, { at: 0.2, span: 0.4, count: 5, g: 0.1, low: 600, high: 2400 });
  },
  /** Cataclysmic Meteor: it whistles down for `fall` seconds, and then the ground takes it. */
  meteor(s, v, { fall = 1.2 } = {}) {
    s.tone(v, { f: 1900, to: 250, dur: fall, a: fall * 0.25, g: 0.1 });
    s.noise(v, { dur: fall, a: fall * 0.8, g: 0.2, bp: [3200, 500], q: 1.2 });
    s.sample(v, 'fire', { at: fall * 0.3, g: 0.4, rate: 0.7, dur: fall * 0.7 });
    boom(s, v, fall, 1.5, 'cannon');
    sub(s, v, { f: 62, to: 24, at: fall, dur: 1.5, g: 0.7 });
    s.sample(v, 'rubble', { at: fall + 0.12, g: 0.6 });
    crackle(s, v, { at: fall + 0.2, span: 1.0, count: 9, g: 0.08 });
  },

  /* ------------------------------------------------------------ Relics and runes */

  /** Blink Boots: the air snaps shut where the hero was, and opens where it now is. */
  blink(s, v) {
    s.tone(v, { f: 500, to: 2600, dur: 0.1, g: 0.16 });
    s.noise(v, { dur: 0.12, a: 0.06, g: 0.2, bp: [1000, 6000], q: 1.4 });
    s.noise(v, { at: 0.11, dur: 0.02, g: 0.5, hp: 3000 });
    s.sample(v, 'whip', { at: 0.1, g: 0.5 });
    s.tone(v, { f: 2500, to: 700, at: 0.12, dur: 0.17, g: 0.13 });
    s.fm(v, { f: 1200, ratio: 2.01, index: 3, indexTo: 0.1, at: 0.12, dur: 0.3, g: 0.08 });
    sub(s, v, { f: 180, to: 80, at: 0.12, dur: 0.1, g: 0.3 });
  },
  /** The Lifesteal Blade drinks: a hiss of something drawn out, and a low moan under it. */
  drain(s, v) {
    s.noise(v, { dur: 0.45, a: 0.05, g: 0.3, bp: [3200, 900], q: 2 });
    s.noise(v, { dur: 0.3, a: 0.03, g: 0.1, hp: 5200 });
    s.tone(v, { f: 300, to: 180, dur: 0.42, a: 0.04, g: 0.12 });
    s.fm(v, { f: 220, ratio: 1.02, index: 2, indexTo: 0.5, dur: 0.42, a: 0.04, g: 0.09 });
  },
  /** The rune bottle: the cork, two swallows, and the rune's own chord as it takes hold. */
  drink(s, v, { rune = 'regen' } = {}) {
    if (!s.sample(v, 'pop', { g: 0.8 })) {
      s.tone(v, { f: 520, to: 1300, dur: 0.035, g: 0.3 });
      s.noise(v, { dur: 0.03, g: 0.2, bp: 1800, q: 1 });
    }
    s.tone(v, { f: 300, to: 170, at: 0.14, dur: 0.09, g: 0.2 });
    s.tone(v, { f: 330, to: 190, at: 0.27, dur: 0.09, g: 0.2 });
    const [notes, type] = RUNE_CHORDS[rune] ?? RUNE_CHORDS.regen;
    s.tone(v, { type: 'triangle', f: 330, to: 990, at: 0.38, dur: 0.55, a: 0.05, g: 0.12 });
    s.chord(v, notes, { type, at: 0.6, dur: 1.1, a: 0.04, hold: 0.2, g: type === 'sawtooth' ? 0.2 : 0.16, lp: [3600, 1200] });
    shimmer(s, v, { at: 0.6, dur: 0.8, g: 0.03 });
  },
  /** A rune appears on the River pad. */
  runeSpawn(s, v) {
    s.sample(v, 'gem', { g: 0.35 });
    s.bell(v, { f: midi(79), ratios: [1, 2, 3.01, 4.2], dur: 0.9, g: 0.09 });
    s.bell(v, { f: midi(86), ratios: [1, 2, 3.01, 4.2], at: 0.14, dur: 1.1, g: 0.09 });
    s.chord(v, [67, 74], { type: 'sine', dur: 1.2, a: 0.1, g: 0.08 });
    shimmer(s, v, { at: 0.1, dur: 0.9, g: 0.03 });
  },
  /** A rune bottled: a crystal chime. */
  rune(s, v) {
    s.sample(v, 'gem', { g: 0.5 });
    chimes(s, v, [84, 88, 91, 96], { dur: 0.95, g: 0.1 });
    s.noise(v, { dur: 0.35, a: 0.05, g: 0.035, hp: 6000 });
    sub(s, v, { f: 160, to: 90, dur: 0.12, g: 0.2 });
  },

  /* ------------------------------------------------------------ Attacks */

  /** A hero's sword. */
  sword(s, v) {
    s.sample(v, 'whip', { g: 0.3 });
    steel(s, v, { at: 0.03 });
  },
  /** A footman's or a creep's blade: the same steel, smaller. */
  clang(s, v) {
    if (!s.sample(v, 'metal', { g: 0.6 })) {
      s.noise(v, { dur: 0.05, g: 0.3, bp: [2200, 5200], q: 1.5 });
      s.bell(v, { f: rand(900, 1350), ratios: [1, 2.4, 3.9], at: 0.01, dur: 0.16, g: 0.16 });
    }
    s.tone(v, { type: 'triangle', f: 200, to: 100, dur: 0.05, g: 0.1 });
    s.fm(v, { f: 700, ratio: 3.7, index: 2, indexTo: 0.2, dur: 0.1, g: 0.04 });
  },
  /** An archer's bow: the string, the release, and the arrow in the air. */
  bow(s, v) {
    s.sample(v, 'whip', { at: 0.02, g: 0.4 });
    s.tone(v, { type: 'triangle', f: rand(300, 360), to: 150, dur: 0.17, a: 0.002, g: 0.3 });
    s.stack(v, { f: 640, to: 310, dur: 0.07, g: 0.08, lp: [2400, 800], voices: 2 });
    s.noise(v, { at: 0.02, dur: 0.17, a: 0.03, g: 0.13, bp: [2600, 900], q: 2 });
  },
  /** A ranged creep's staff: a bolt of something. */
  staff(s, v) {
    s.tone(v, { f: rand(820, 920), to: 1500, dur: 0.11, g: 0.22 });
    s.fm(v, { f: 600, ratio: 3, index: 2.5, indexTo: 0.1, dur: 0.12, g: 0.1 });
    s.noise(v, { dur: 0.1, a: 0.02, g: 0.1, bp: [1800, 4200], q: 2 });
    s.tone(v, { f: 210, to: 120, dur: 0.06, g: 0.1 });
  },
  /** A Tower's or a Throne's shot: a clean laser for Radiant, a spat gout of magma for Dire. */
  tower(s, v, { side = 'radiant' } = {}) {
    if (side === 'radiant') {
      s.stack(v, { f: 2300, to: 420, dur: 0.2, g: 0.26, bp: [2600, 700], q: 2.5, voices: 2, spread: 18 });
      s.tone(v, { f: 1150, to: 300, dur: 0.22, g: 0.28 });
      s.fm(v, { f: 1800, ratio: 0.5, index: 4, indexTo: 0.2, dur: 0.16, g: 0.08 });
    } else {
      s.stack(v, { f: 900, to: 130, dur: 0.24, g: 0.34, lp: [2200, 500], voices: 2, drive: 0.4 });
      s.noise(v, { dur: 0.2, g: 0.3, lp: [1800, 300], q: 1 });
      s.sample(v, 'fire', { g: 0.3, dur: 0.25 });
    }
    s.noise(v, { dur: 0.03, g: 0.2, hp: 3000 });
    sub(s, v, { f: 120, to: 55, dur: 0.12, g: 0.3 });
  },
  /** A Frost Tower's beam. */
  frost(s, v) {
    s.tone(v, { f: 2700, to: 1500, dur: 0.24, g: 0.15, vib: [38, 90] });
    s.noise(v, { dur: 0.2, a: 0.01, g: 0.12, hp: 5500 });
    s.bell(v, { f: 3100, ratios: [1, 1.5, 2.67], dur: 0.3, g: 0.08 });
    s.sample(v, 'glass', { g: 0.14, rate: 1.6, dur: 0.2 });
  },
  /** A Siege Golem's fists on the ground. */
  slam(s, v) {
    s.sample(v, 'slam', { g: 0.7 });
    sub(s, v, { f: 95, to: 36, dur: 0.5, g: 0.75 });
    s.noise(v, { dur: 0.4, g: 0.42, lp: [520, 90], q: 0.7 });
    if (!s.sample(v, 'rockhit', { at: 0.03, g: 0.4 })) s.noise(v, { dur: 0.06, g: 0.2, bp: 1500, q: 1 });
  },
  /** A Valkyrie's axe going all the way round. */
  spin(s, v) {
    swish(s, v, { dur: 0.3, from: 450, to: 2000, g: 0.26 });
    steel(s, v, { at: 0.12, g: 0.5, pitch: rand(950, 1150) });
  },
  /** A blow landing on, or dealt by, a hero. */
  hit(s, v) {
    if (!s.sample(v, 'impact', { g: 0.5 })) s.noise(v, { dur: 0.05, g: 0.3, bp: 1100, q: 0.9 });
    s.tone(v, { f: 170, to: 80, dur: 0.07, g: 0.3 });
    s.noise(v, { dur: 0.02, g: 0.08, hp: 3600 });
  },
  /** A troop falling. */
  fall(s, v) {
    if (!s.sample(v, 'bodyfall', { g: 0.5 })) s.noise(v, { dur: 0.14, g: 0.4, bp: [900, 260], q: 1.1 });
    s.tone(v, { f: 140, to: 70, dur: 0.09, g: 0.16 });
    s.noise(v, { dur: 0.1, g: 0.08, lp: 400 });
  },
  /** A hero falls. */
  heroDown(s, v) {
    s.stack(v, { f: 430, to: 68, dur: 0.75, g: 0.24, lp: [1900, 300], voices: 3, spread: 18 });
    sub(s, v, { f: 110, to: 34, at: 0.05, dur: 0.6, g: 0.5 });
    s.noise(v, { dur: 0.5, g: 0.2, lp: [1500, 150] });
    s.sample(v, 'bodyfall', { at: 0.3, g: 0.5 });
    s.fm(v, { f: 147, ratio: 2.76, index: 2.5, indexTo: 0.3, at: 0.1, dur: 1.6, g: 0.1 });
  },

  /* ------------------------------------------------------------ Structures and the end of a match */

  /** A heavy blow on a Tower or a Throne. */
  thud(s, v) {
    s.sample(v, 'rockhit', { g: 0.6 });
    sub(s, v, { f: 115, to: 48, dur: 0.3, g: 0.45 });
    s.noise(v, { dur: 0.22, g: 0.3, lp: [750, 150] });
  },
  /** A Tower crumbles: the break, the blocks coming down one after another, and the dust. */
  collapse(s, v) {
    s.sample(v, 'rubble', { g: 0.9 });
    s.sample(v, 'rock', { at: 0.28, g: 0.7 });
    s.sample(v, 'rock', { at: 0.75, g: 0.5, rate: 0.85 });
    boom(s, v, 0, 1.2, 'cannon');
    s.noise(v, { at: 0.2, dur: 1.9, a: 0.2, g: 0.5, lp: [520, 60], q: 0.6 });
    sub(s, v, { f: 62, to: 27, at: 0.15, dur: 1.7, g: 0.55 });
    crackle(s, v, { at: 0.3, span: 1.3, count: 9, g: 0.15, low: 500, high: 2400 });
  },
  /** The ground shakes for `seconds` as the camera closes on a doomed Throne. */
  rumble(s, v, { seconds = 3 } = {}) {
    s.noise(v, { dur: seconds + 0.3, a: seconds * 0.85, g: 0.34, lp: [90, 320], q: 0.7 });
    s.tone(v, { f: 36, to: 52, dur: seconds + 0.2, a: seconds * 0.8, g: 0.5, vib: [9, 3] });
    s.stack(v, { f: 110, to: 440, dur: seconds, a: seconds * 0.9, g: 0.05, lp: 1400, voices: 2 });
    s.sample(v, 'rock', { at: seconds * 0.55, g: 0.25 });
    s.sample(v, 'rockhit', { at: seconds * 0.8, g: 0.3 });
  },
  /** One of the three blasts that take a Throne apart: Radiant's shatters like crystal, Dire's erupts. */
  blast(s, v, { side = 'radiant', stage = 0 } = {}) {
    boom(s, v, 0, 1.3 + stage * 0.2, 'cannon');
    if (side === 'radiant') {
      s.sample(v, 'shatter', { at: 0.03, g: 0.8 });
      s.sample(v, 'glass', { at: 0.2, g: 0.4 });
      for (let i = 0; i < 12; i++) s.bell(v, { f: rand(2200, 5400), ratios: [1, 2.7, 4.3], at: rand(0, 0.55), dur: rand(0.3, 0.8), g: 0.05 });
      s.noise(v, { dur: 0.5, a: 0.02, g: 0.14, hp: 5200 });
    } else {
      flame(s, v, { at: 0.05, dur: 1.0, g: 0.3 });
      s.stack(v, { f: 85, to: 42, dur: 1.3, a: 0.05, g: 0.3, lp: [900, 220], drive: 0.5 });
      s.sample(v, 'rubble', { at: 0.2, g: 0.5 });
    }
  },
  victory(s, v) {
    for (const [at, notes, dur] of [[0, [60, 64, 67], 0.26], [0.2, [60, 64, 67], 0.26], [0.4, [65, 69, 72], 0.36], [0.68, [67, 71, 74, 79], 2.2]]) {
      s.chord(v, notes, { at, dur, a: 0.015, hold: dur * 0.4, g: 0.26, lp: [3600, 1500], drive: 0.3 });
    }
    s.tone(v, { f: midi(36), at: 0.68, dur: 2.2, a: 0.02, g: 0.4 });
    sub(s, v, { f: 90, to: 40, at: 0.68, dur: 0.5, g: 0.5 });
    s.noise(v, { at: 0.68, dur: 2.0, a: 0.01, g: 0.07, hp: 5200 });
    arpeggio(s, v, [84, 88, 91, 96], { at: 0.74, step: 0.09, dur: 1.2, g: 0.06 });
  },
  defeat(s, v) {
    for (const [at, notes, dur] of [[0, [57, 60, 64], 0.7], [0.6, [55, 58, 62], 0.7], [1.2, [50, 53, 57], 2.6]]) {
      s.chord(v, notes, { at, dur, a: 0.05, hold: dur * 0.3, g: 0.22, lp: [1800, 500] });
    }
    s.tone(v, { f: midi(26), at: 1.2, dur: 2.6, a: 0.1, g: 0.42 });
    s.fm(v, { f: 147, ratio: 2.76, index: 2.5, indexTo: 0.3, at: 1.2, dur: 2.4, g: 0.1 });
    s.noise(v, { at: 1.2, dur: 2.2, a: 0.4, g: 0.05, lp: [400, 120] });
  },
  draw(s, v) {
    s.chord(v, [50, 57, 62, 67], { dur: 2.4, a: 0.06, hold: 0.8, g: 0.22, lp: [2400, 700] });
    s.tone(v, { f: midi(38), dur: 2.2, a: 0.1, g: 0.25 });
    s.bell(v, { f: midi(74), ratios: [1, 2.02, 2.76], at: 0.1, dur: 1.8, g: 0.06 });
  },

  /**
   * The impact an announcer banner lands with: a drum hit under a chord in the
   * banner's `tone`, and whatever that tone adds of its own.
   */
  banner(s, v, { tone = 'kill' } = {}) {
    const [notes, bright, dur] = BANNER_CHORDS[tone] ?? BANNER_CHORDS.kill;
    let at = 0;
    // A streak climbs to its chord: one step for a double kill, two for a rampage.
    for (let step = tone === 'rampage' ? 2 : tone === 'streak' ? 1 : 0; step > 0; step--) {
      s.chord(v, notes.map((note) => note - step * 2), { at, dur: 0.24, a: 0.01, g: 0.2, lp: [bright, 900] });
      sub(s, v, { f: 100, to: 45, at, dur: 0.2, g: 0.4 });
      at += 0.17;
    }
    sub(s, v, { f: 98, to: 36, at, dur: 1, g: 0.75 });
    if (!s.sample(v, 'slam', { at, g: 0.5 })) s.noise(v, { at, dur: 0.05, g: 0.2, hp: 2500 });
    s.noise(v, { at, dur: 0.55, g: 0.34, lp: [1500, 100] });
    s.chord(v, notes, { type: tone === 'elixir' ? 'triangle' : 'sawtooth', at, dur, a: 0.012, hold: dur * 0.2, g: 0.3, lp: [bright, 420], drive: tone === 'elixir' ? 0 : 0.3 });

    if (tone === 'blood' || tone === 'overtime') {
      // A bell tolls under it: twice for sudden death.
      for (let toll = 0; toll < (tone === 'overtime' ? 2 : 1); toll++) {
        s.bell(v, { f: midi(tone === 'overtime' ? 48 : 50), ratios: [1, 2.02, 2.76, 4.07, 5.2], at: at + 0.04 + toll * 0.95, dur: 2.4, g: 0.16 });
      }
    }
    if (tone === 'elixir') {
      arpeggio(s, v, [76, 80, 83, 88, 92], { at: at + 0.05, step: 0.06, dur: 0.6, g: 0.07 });
      s.noise(v, { at, dur: 0.9, a: 0.25, g: 0.05, hp: 5500 });
    }
    if (tone === 'radiant' || tone === 'rampage') arpeggio(s, v, [81, 85, 88, 93], { at: at + 0.1, step: 0.08, dur: 0.9, g: 0.05 });
    if (tone === 'dire') s.stack(v, { f: 58, to: 39, at, dur: 1.8, a: 0.05, g: 0.22, lp: [700, 200], voices: 2, drive: 0.5 });
  },
};

/**
 * How each cue is mixed and rationed.
 *   tier      how important it is (`TIER`); the higher tier wins a voice when they run out
 *   group     which cap it counts against (`GROUP_CAP`)
 *   cooldown  least time between two of the same cue, in milliseconds
 *   vary      a repeating sound: its pitch wanders a little every time
 *   global    an alert: heard from anywhere on the field, never below `GLOBAL_FLOOR`
 *   wet       how much of it goes to the cavern reverb
 *   gain      its level in the mix
 *   duck      how far the music steps back for it (0 to 1)
 */
const cue = (tier, group, gain, options = {}) => ({ tier: TIER[tier], group, gain, cooldown: 0, vary: false, global: false, wet: 0, duck: 0, ...options });
const CUES = {
  uiHover: cue('alert', 'ui', 0.5, { cooldown: 45, vary: true }),
  uiClick: cue('alert', 'ui', 0.7, { cooldown: 40, vary: true, wet: 0.05 }),
  heroSelect: cue('alert', 'ui', 0.75, { cooldown: 150, wet: 0.35 }),
  cardPick: cue('alert', 'ui', 0.7, { cooldown: 40, vary: true, wet: 0.05 }),
  cardEquip: cue('alert', 'ui', 0.8, { cooldown: 40, vary: true, wet: 0.08 }),
  cardRemove: cue('alert', 'ui', 0.7, { cooldown: 40, vary: true, wet: 0.05 }),
  findMatch: cue('alert', null, 0.8, { wet: 0.45, duck: 0.4 }),
  queuePulse: cue('alert', 'ui', 0.7, { cooldown: 800, wet: 0.5 }),
  matchFound: cue('alert', null, 0.75, { wet: 0.5, duck: 0.6 }),
  horn: cue('alert', null, 0.9, { wet: 0.5, duck: 0.35 }),
  wind: cue('alert', null, 0.7, { wet: 0.3 }),

  moveClick: cue('alert', 'ui', 0.6, { cooldown: 60, vary: true }),
  attackClick: cue('alert', 'ui', 0.7, { cooldown: 60, vary: true }),
  gold: cue('alert', 'ui', 0.75, { cooldown: 90, vary: true, wet: 0.2 }),
  buy: cue('alert', null, 0.8, { wet: 0.3 }),
  heartbeat: cue('alert', null, 0.8, { cooldown: 400 }),
  alarm: cue('alert', null, 0.8, { cooldown: 10_000, global: true, wet: 0.4 }),
  levelUp: cue('spell', 'spell', 0.9, { cooldown: 200, wet: 0.4 }),

  cardArm: cue('alert', 'ui', 0.8, { cooldown: 50, vary: true, wet: 0.15 }),
  cardCancel: cue('alert', 'ui', 0.7, { cooldown: 50, vary: true, wet: 0.05 }),
  deny: cue('alert', 'ui', 0.9, { cooldown: 180 }),
  elixir: cue('alert', 'ui', 0.6, { cooldown: 60, vary: true, wet: 0.1 }),
  elixirFull: cue('alert', 'ui', 0.85, { cooldown: 500, wet: 0.3 }),

  deployFootmen: cue('spell', 'spell', 0.8, { cooldown: 60, vary: true, wet: 0.15 }),
  deployArcher: cue('spell', 'spell', 0.85, { cooldown: 60, vary: true, wet: 0.3 }),
  deployGolem: cue('spell', 'spell', 0.8, { cooldown: 60, vary: true, wet: 0.3 }),
  deployFrost: cue('spell', 'spell', 0.85, { cooldown: 60, vary: true, wet: 0.4 }),
  deployValkyrie: cue('spell', 'spell', 0.8, { cooldown: 60, vary: true, wet: 0.2 }),
  deploy: cue('spell', 'spell', 0.8, { cooldown: 60, vary: true, wet: 0.2 }),
  fireball: cue('spell', 'spell', 0.8, { wet: 0.4 }),
  explosion: cue('spell', 'spell', 0.8, { wet: 0.4 }),
  healWave: cue('spell', 'spell', 0.85, { wet: 0.5 }),
  lightning: cue('spell', 'spell', 0.8, { wet: 0.25 }),

  dash: cue('spell', 'spell', 0.8, { vary: true, wet: 0.15 }),
  shield: cue('spell', 'spell', 0.85, { wet: 0.4 }),
  thunder: cue('spell', 'spell', 0.8, { wet: 0.45 }),
  judgment: cue('alert', null, 0.75, { global: true, wet: 0.5, duck: 0.35 }),
  cleave: cue('spell', 'spell', 0.85, { vary: true, wet: 0.2 }),
  cloak: cue('spell', 'spell', 0.85, { wet: 0.25 }),
  spikes: cue('spell', 'spell', 0.8, { vary: true, wet: 0.2 }),
  meteor: cue('alert', null, 0.8, { global: true, wet: 0.45, duck: 0.35 }),

  blink: cue('spell', 'spell', 0.9, { vary: true, wet: 0.3 }),
  drain: cue('hero', 'combat', 0.8, { cooldown: 350, vary: true, wet: 0.15 }),
  drink: cue('spell', 'spell', 0.85, { wet: 0.4 }),
  runeSpawn: cue('alert', null, 0.9, { global: true, wet: 0.6 }),
  rune: cue('alert', null, 0.9, { global: true, wet: 0.6 }),

  sword: cue('hero', 'combat', 0.75, { cooldown: 70, vary: true, wet: 0.12 }),
  clang: cue('ambient', 'combat', 0.7, { cooldown: 120, vary: true, wet: 0.08 }),
  bow: cue('ambient', 'combat', 0.8, { cooldown: 110, vary: true, wet: 0.08 }),
  staff: cue('ambient', 'combat', 0.8, { cooldown: 110, vary: true, wet: 0.1 }),
  tower: cue('combat', 'combat', 0.8, { cooldown: 100, vary: true, wet: 0.2 }),
  frost: cue('combat', 'combat', 0.8, { cooldown: 110, vary: true, wet: 0.2 }),
  slam: cue('combat', 'combat', 0.8, { cooldown: 150, vary: true, wet: 0.25 }),
  spin: cue('combat', 'combat', 0.8, { cooldown: 200, vary: true, wet: 0.12 }),
  hit: cue('hero', 'combat', 0.75, { cooldown: 80, vary: true, wet: 0.05 }),
  fall: cue('ambient', 'combat', 0.7, { cooldown: 130, vary: true, wet: 0.05 }),
  thud: cue('combat', 'combat', 0.8, { cooldown: 200, vary: true, wet: 0.3 }),
  heroDown: cue('alert', null, 0.9, { global: true, wet: 0.4 }),

  collapse: cue('alert', null, 0.85, { global: true, wet: 0.5, duck: 0.4 }),
  rumble: cue('alert', null, 0.5, { global: true, wet: 0.3 }),
  blast: cue('alert', null, 0.9, { global: true, wet: 0.5 }),
  victory: cue('alert', null, 0.9, { wet: 0.5 }),
  defeat: cue('alert', null, 0.9, { wet: 0.55 }),
  draw: cue('alert', null, 0.9, { wet: 0.5 }),
  banner: cue('alert', null, 0.8, { wet: 0.45, duck: 0.55 }),
};

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

/** An impulse response for the reverb: a dark cavern, its tail duller the longer it rings, a little different in each ear. */
function cavern(ctx, seconds = 2.8) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // A low-pass that closes as the echo dies: stone swallows the treble first.
      low += (0.72 * (1 - t) ** 2 + 0.04) * (Math.random() * 2 - 1 - low);
      // A moment of silence first keeps the sound itself in front of its echo.
      data[i] = low * Math.min(1, i / (rate * 0.012)) * Math.exp(-5.2 * t);
    }
    // A few early reflections off the near walls.
    for (let bounce = 0; bounce < 7; bounce++) {
      const at = Math.floor(rate * (0.018 + 0.011 * bounce + Math.random() * 0.008));
      data[at] += (bounce % 2 ? -0.5 : 0.5) * 0.78 ** bounce;
    }
  }
  return impulse;
}

/** Soft-clipping curves by amount, for brass and for anything that growls. */
const DRIVES = new Map();
function driveCurve(amount) {
  if (!DRIVES.has(amount)) {
    const curve = new Float32Array(1024);
    const push = 1 + amount * 7;
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * push) / Math.tanh(push);
    DRIVES.set(amount, curve);
  }
  return DRIVES.get(amount);
}

/** One library of samples for the whole page. */
let sharedLibrary = null;

export class SoundEngine {
  /** Every cue `play` knows. */
  static CUES = Object.keys(RECIPES);

  #ctx = null;
  /** True for a context handed in by the caller (an OfflineAudioContext, to render cues to a buffer). */
  #given = false;
  #master = null;
  #sfx = null;
  #dry = null;
  #hall = null;
  #musicGain = null;
  #duck = null;
  #music = null;
  #noiseBuffer = null;
  #library = null;
  #persist = true;
  /** What the mixer shows: both volumes from 0 to 1, and the mute switch. */
  #settings = { music: 0.6, sfx: 0.8, muted: false };
  #listeners = new Set();
  /** When each cue was last played, and the voices now sounding. */
  #lastPlayed = new Map();
  #voices = [];
  /** Where the sounds of the field are heard from: the point the camera looks at. */
  #ear = { x: 0, z: 0 };
  /** What the music has been asked to be; it starts once the context does. */
  #theme = null;
  #intensity = 0;
  #heart = 0;
  #heartRate = 0;
  /** While the context is starting, the cues asked of it wait to be played once it has: { name, place, detail, at }. */
  #waking = false;
  #waiting = [];

  /**
   * @param {{ context?: BaseAudioContext, persist?: boolean, library?: SampleLibrary | null }} [options]
   *   `context` plays into a context of the caller's instead of one the engine makes after the
   *   first click or key press. `persist: false` keeps the mixer out of localStorage.
   *   `library` shares decoded samples between engines; null goes without samples altogether.
   */
  constructor({ context = null, persist = true, library } = {}) {
    this.#persist = persist && !context;
    if (this.#persist) this.#restore();
    this.#library = library === undefined ? (sharedLibrary ??= new SampleLibrary()) : library;
    this.#library?.load();
    if (context) {
      this.#given = true;
      this.#build(context);
      return;
    }
    // Browsers allow sound only once the player has interacted with the page.
    const unlock = () => this.unlock();
    for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, unlock, { capture: true, passive: true });
    // Music keeps to itself in a hidden tab, and picks up again when the player comes back.
    document.addEventListener('visibilitychange', () => this.#music?.hush(document.hidden));
  }

  #restore() {
    const level = (value, fallback) => (Number.isFinite(value) ? clamp(value, 0, 1) : fallback);
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved) {
        this.#settings = { music: level(saved.music, 0.6), sfx: level(saved.sfx, 0.8), muted: saved.muted === true };
        return;
      }
      // The single volume of the old speaker button becomes the SFX volume.
      const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
      if (old) this.#settings = { music: 0.6, sfx: level(old.volume, 0.8), muted: old.muted === true };
    } catch {
      // Unreadable or unavailable: start from the defaults.
    }
  }

  /* ---------------------------------------------------------------- State */

  /** Whether a cue played now would be heard (but for muting). */
  get ready() {
    return Boolean(this.#ctx) && (this.#given || this.#ctx.state === 'running');
  }

  get muted() {
    return this.#settings.muted;
  }

  /** The Music and SFX volumes, each from 0 to 1. */
  get musicVolume() {
    return this.#settings.music;
  }

  get sfxVolume() {
    return this.#settings.sfx;
  }

  /** Calls `listener(engine)` now and whenever a volume or the mute switch changes. Returns a function that stops it. */
  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Starts the audio context if the browser now allows it. Called for the player's
   * first click or key press; safe to call at any time.
   */
  unlock() {
    if (!this.#ctx) {
      const Context = window.AudioContext ?? window.webkitAudioContext;
      if (!Context) return false;
      try {
        this.#build(new Context({ latencyHint: 'interactive' }));
      } catch {
        return false;
      }
    }
    // A context can be suspended again, by the browser or the system: every later touch wakes it.
    if (!this.#given && this.#ctx.state !== 'running') {
      this.#waking = true;
      this.#ctx.resume?.().then(
        () => this.#woke(),
        () => {
          this.#waking = false;
        },
      );
    }
    return true;
  }

  /** The context has started: what was asked for in the moment it took is played now. */
  #woke() {
    this.#waking = false;
    const fresh = performance.now() - WAKE_GRACE_MS;
    for (const { name, place, detail, at } of this.#waiting.splice(0)) {
      if (at >= fresh) this.#start(name, place, detail);
    }
  }

  setMuted(muted) {
    this.#settings.muted = Boolean(muted);
    this.#changed();
  }

  toggleMute() {
    this.setMuted(!this.#settings.muted);
    return this.#settings.muted;
  }

  /** Sets the music volume, 0 to 1. Moving a volume is asking to hear it, so it also unmutes. */
  setMusicVolume(volume) {
    this.#settings.music = clamp(Number(volume) || 0, 0, 1);
    this.#settings.muted = false;
    this.#changed();
  }

  setSfxVolume(volume) {
    this.#settings.sfx = clamp(Number(volume) || 0, 0, 1);
    this.#settings.muted = false;
    this.#changed();
  }

  /** Moves the point the battlefield is heard from: where the camera is looking. */
  listen(x, z) {
    this.#ear.x = x;
    this.#ear.z = z;
  }

  #changed() {
    if (this.#master) {
      // Eased, so a change in the middle of a sound does not click. A slider is heard as its square: finer control low down.
      const now = this.#ctx.currentTime;
      this.#master.gain.setTargetAtTime(this.#settings.muted ? 0 : 1, now, 0.02);
      this.#sfx.gain.setTargetAtTime(this.#settings.sfx ** 2, now, 0.02);
      this.#musicGain.gain.setTargetAtTime(this.#settings.music ** 2, now, 0.05);
    }
    if (this.#persist) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#settings));
      } catch {
        // Storage can be unavailable (private mode); the mixer just won't persist.
      }
    }
    for (const listener of this.#listeners) listener(this);
  }

  /* ---------------------------------------------------------------- Music and loops */

  /** Chooses the music: 'lobby', 'battle', or null for none. Themes cross-fade into one another. */
  setMusic(theme) {
    this.#theme = theme;
    this.#music?.set(theme);
  }

  /**
   * How hard the battle theme drives: 0 for ordinary play, 1 once the stakes rise (Double Elixir,
   * a Throne in danger), 2 at its height (sudden death, or both at once).
   */
  setIntensity(level) {
    this.#intensity = clamp(Math.round(level), 0, 2);
    this.#music?.setIntensity(this.#intensity);
  }

  /** The hero's heartbeat, for when it is close to death: 0 stops it, anything up to 1 quickens it. */
  setHeartbeat(urgency) {
    this.#heartRate = clamp(urgency, 0, 1);
    if (!this.#heartRate) {
      clearTimeout(this.#heart);
      this.#heart = 0;
    } else if (!this.#heart) {
      const beat = () => {
        this.play('heartbeat');
        this.#heart = setTimeout(beat, 1150 - 400 * this.#heartRate);
      };
      beat();
    }
  }

  /* ---------------------------------------------------------------- Diagnostics */

  /**
   * What became of the samples: which loaded and which were refused, and so which
   * sample groups the cues are synthesising instead. Resolves once loading has finished.
   */
  async assets() {
    const library = this.#library;
    if (!library) return { state: 'off', loaded: 0, rejected: [], groups: [] };
    await library.load();
    const good = library.results.filter((item) => item.ok);
    return {
      state: library.state,
      error: library.error,
      loaded: good.length,
      seconds: Number(good.reduce((sum, item) => sum + item.seconds, 0).toFixed(1)),
      rejected: library.results.filter((item) => !item.ok),
      groups: [...new Set(good.map((item) => item.group))].sort(),
    };
  }

  /** The music director, for diagnostics (music.js). Null until the context exists. */
  get music() {
    return this.#music;
  }

  /* ---------------------------------------------------------------- Graph */

  #build(ctx) {
    this.#ctx = ctx;
    const gain = (value, to) => {
      const node = ctx.createGain();
      node.gain.value = value;
      if (to) node.connect(to);
      return node;
    };
    // Master gain, then a compressor as a limiter: many cues at once must not clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -13;
    limiter.knee.value = 9;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.22;
    limiter.connect(ctx.destination);
    this.#master = gain(this.#settings.muted ? 0 : 1, limiter);

    // Effects: dry, and in parallel through the cavern.
    const impulse = cavern(ctx);
    this.#sfx = gain(this.#settings.sfx ** 2, this.#master);
    this.#dry = gain(0.85, this.#sfx);
    this.#hall = ctx.createConvolver();
    this.#hall.buffer = impulse;
    this.#hall.connect(gain(0.6, this.#sfx));

    // Music: its own volume, its own share of the same cavern, and a gain that steps back for the big moments.
    this.#musicGain = gain(this.#settings.music ** 2, this.#master);
    this.#duck = gain(1, this.#musicGain);
    const musicHall = ctx.createConvolver();
    musicHall.buffer = impulse;
    musicHall.connect(gain(0.5, this.#duck));
    this.#music = createMusic(ctx, this.#duck, musicHall, { live: !this.#given });
    this.#music.setIntensity(this.#intensity);
    this.#music.set(this.#theme);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    this.#noiseBuffer = noise;
  }

  /** The music steps back by `amount` for about `seconds`, then returns. */
  #duckMusic(amount, seconds) {
    const now = this.#ctx.currentTime;
    const { gain } = this.#duck;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(1 - amount, now, 0.04);
    gain.setTargetAtTime(1, now + Math.min(seconds, 2.5) * 0.6, 0.5);
  }

  /* ---------------------------------------------------------------- Playing */

  /**
   * Plays a cue in the player's ears: an interface sound, an alert, a fanfare.
   * `delay` (seconds) holds it back; `gain` scales it; anything else is the cue's
   * own (a banner's `tone`, a meteor's `fall`…). Returns whether it was played.
   * Given `x` and `z` it is played on the battlefield, as `playWorldSfx` does.
   */
  play(name, { x, z, ...detail } = {}) {
    return this.#start(name, Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null, detail);
  }

  /**
   * Plays a cue at a point on the battlefield, as heard from where the camera looks:
   * panned left or right of it, quieter with distance, and not at all when it is far
   * off screen — unless the cue is an alert, which is heard everywhere.
   */
  playWorldSfx(name, worldX, worldZ, detail = {}) {
    return this.#start(name, { x: worldX, z: worldZ }, detail);
  }

  #start(name, place, { gain = 1, delay = 0, ...detail }) {
    const recipe = RECIPES[name];
    const mix = CUES[name];
    if (!recipe || !mix || this.#settings.muted || !this.#settings.sfx) return false;
    if (!this.ready) {
      // The context takes a moment to start after the touch that allowed it; that touch's own sound waits for it.
      if (this.#waking) {
        const now = performance.now();
        this.#waiting = this.#waiting.filter((cue) => now - cue.at < WAKE_GRACE_MS);
        this.#waiting.push({ name, place, detail: { gain, delay, ...detail }, at: now });
      }
      return false;
    }
    if (!this.#given && document.hidden) return false;
    const ctx = this.#ctx;
    // Rationing runs on the wall clock: on a machine that is struggling the audio clock falls behind it.
    const now = performance.now();
    if (mix.cooldown && now - (this.#lastPlayed.get(name) ?? -Infinity) < mix.cooldown) return false;

    let level = 1;
    let pan = 0;
    if (place) {
      const dx = place.x - this.#ear.x;
      // The screen is wider than it is deep, so depth counts for more.
      const far = Math.hypot(dx, (place.z - this.#ear.z) * 1.4) / HALF_DISTANCE;
      level = 1 / (1 + far * far);
      pan = clamp(dx / PAN_REACH, -0.9, 0.9);
      if (mix.global) level = Math.max(level, GLOBAL_FLOOR);
      else if (level < AUDIBLE) return false;
    }
    if (!this.#admit(mix, now)) return false;
    this.#lastPlayed.set(name, now);

    const out = ctx.createGain();
    out.gain.value = gain * mix.gain * level;
    let tail = out;
    if (pan && ctx.createStereoPanner) {
      tail = ctx.createStereoPanner();
      tail.pan.value = pan;
      out.connect(tail);
    }
    tail.connect(this.#dry);
    if (mix.wet) {
      const send = ctx.createGain();
      send.gain.value = mix.wet;
      tail.connect(send).connect(this.#hall);
    }

    const [low, high] = PITCH_SPREAD;
    const voice = { name, tier: mix.tier, group: mix.group, out, t: ctx.currentTime + 0.006 + delay, end: 0, pitch: mix.vary ? rand(low, high) : 1, began: now, busyUntil: 0, ends: 0 };
    recipe(this, voice, detail);
    const length = (delay + voice.end) * 1000;
    voice.busyUntil = now + Math.min(length, delay * 1000 + BUSY_MS);
    voice.ends = now + length + 200;
    this.#voices.push(voice);
    if (mix.duck && this.#theme) this.#duckMusic(mix.duck, voice.end);
    // Once the voice is over its nodes are let go, or the graph would only grow.
    if (!this.#given) {
      setTimeout(() => {
        out.disconnect();
        if (tail !== out) tail.disconnect();
      }, length + 400);
    }
    return true;
  }

  /** Whether there is a voice for this cue. A group that is full gives up its least important voice to a more important newcomer. */
  #admit(mix, now) {
    this.#voices = this.#voices.filter((voice) => voice.ends > now);
    const cap = GROUP_CAP[mix.group];
    if (cap) {
      const busy = this.#voices.filter((voice) => voice.group === mix.group && voice.busyUntil > now);
      if (busy.length >= cap) {
        let victim = null;
        for (const voice of busy) {
          if (voice.tier < mix.tier && (!victim || voice.tier < victim.tier || (voice.tier === victim.tier && voice.began < victim.began))) victim = voice;
        }
        if (!victim) return false;
        // Faded, not cut: a voice that stops dead clicks.
        const at = this.#ctx.currentTime;
        victim.out.gain.cancelScheduledValues(at);
        victim.out.gain.setTargetAtTime(0, at, 0.015);
        victim.busyUntil = 0;
      }
    }
    return this.#voices.length < MAX_VOICES || mix.tier >= TIER.alert;
  }

  /* ---------------------------------------------------------------- Instruments */

  /** Rises to `g` in `a` seconds, stays there for `hold`, and has died away `dur` seconds after it began. */
  #envelope(param, t, { a, hold, g, dur }) {
    const peak = Math.max(g, 0.0002);
    const top = Math.min(a, dur * 0.9);
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(peak, t + top);
    if (hold > 0) param.setValueAtTime(peak, t + Math.min(top + hold, dur * 0.95));
    param.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  /** Puts `node` through the filters asked for. Each is a frequency, or [from, to] swept over `sweep` seconds. */
  #filtered(node, t, sweep, { lp, hp, bp, q = 0.8 }, pitch = 1) {
    for (const [type, setting] of [['lowpass', lp], ['highpass', hp], ['bandpass', bp]]) {
      if (setting === undefined) continue;
      const filter = this.#ctx.createBiquadFilter();
      filter.type = type;
      filter.Q.value = q;
      const [from, to] = Array.isArray(setting) ? setting : [setting, setting];
      filter.frequency.setValueAtTime(Math.min(from * pitch, 20_000), t);
      if (to !== from) filter.frequency.exponentialRampToValueAtTime(Math.min(to * pitch, 20_000), t + sweep);
      node.connect(filter);
      node = filter;
    }
    return node;
  }

  /**
   * One oscillator. It starts at `f` and glides to `to` over `glide` seconds
   * (all of `dur` unless given); `vib` is [rate, depth] of a vibrato, in hertz.
   */
  tone(v, { type = 'sine', f, to = f, glide, at = 0, dur, a = 0.004, hold = 0, g = 0.3, lp, hp, bp, q = 0.8, sweep, vib }) {
    this.stack(v, { type, f, to, glide, at, dur, a, hold, g, lp, hp, bp, q, sweep, vib, voices: 1 });
  }

  /**
   * `voices` oscillators spread `spread` cents either side of one pitch, through
   * one filter and one envelope: the thick, moving tone of brass, strings or a
   * growl. `drive` (0 to 1) pushes them into soft clipping first.
   */
  stack(v, { type = 'sawtooth', f, to = f, glide, at = 0, dur, a = 0.01, hold = 0, g = 0.2, voices = 3, spread = 14, lp, hp, bp, q = 0.8, sweep, vib, drive = 0 }) {
    const ctx = this.#ctx;
    const t = v.t + at;
    const mix = ctx.createGain();
    mix.gain.value = 1 / Math.sqrt(voices);
    let wobble = null;
    if (vib) {
      wobble = ctx.createGain();
      wobble.gain.value = vib[1];
      const lfo = ctx.createOscillator();
      lfo.frequency.value = vib[0];
      lfo.connect(wobble);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    let last = null;
    for (let i = 0; i < voices; i++) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.detune.value = voices === 1 ? 0 : ((i / (voices - 1)) * 2 - 1) * spread;
      osc.frequency.setValueAtTime(f * v.pitch, t);
      if (to !== f) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to * v.pitch), t + (glide ?? dur));
      wobble?.connect(osc.frequency);
      osc.connect(mix);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      last = osc;
    }
    let node = mix;
    if (drive) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = driveCurve(drive);
      node.connect(shaper);
      node = shaper;
    }
    const amp = ctx.createGain();
    this.#envelope(amp.gain, t, { a, hold, g, dur });
    this.#filtered(node, t, sweep ?? dur, { lp, hp, bp, q }, v.pitch).connect(amp).connect(v.out);
    last.onended = () => amp.disconnect();
    v.end = Math.max(v.end, at + dur);
  }

  /** White noise through a filter: air, fire, stone, thunder. */
  noise(v, { at = 0, dur, a = 0.003, hold = 0, g = 0.3, lp, hp, bp, q = 0.8, sweep }) {
    const ctx = this.#ctx;
    const t = v.t + at;
    const source = ctx.createBufferSource();
    source.buffer = this.#noiseBuffer;
    source.loop = true;
    const amp = ctx.createGain();
    this.#envelope(amp.gain, t, { a, hold, g, dur });
    this.#filtered(source, t, sweep ?? dur, { lp, hp, bp, q }, v.pitch).connect(amp).connect(v.out);
    source.start(t, Math.random() * 1.5);
    source.stop(t + dur + 0.05);
    source.onended = () => amp.disconnect();
    v.end = Math.max(v.end, at + dur);
  }

  /**
   * Frequency modulation: a carrier at `f` bent by a modulator at `f × ratio`.
   * The depth runs from `index` to `indexTo`, so the tone starts bright and
   * clangorous and settles: metal, gongs, bells, electricity.
   */
  fm(v, { f, ratio = 1.41, index = 4, indexTo = 0.2, at = 0, dur, a = 0.003, hold = 0, g = 0.2 }) {
    const ctx = this.#ctx;
    const t = v.t + at;
    const carrier = ctx.createOscillator();
    const modulator = ctx.createOscillator();
    const depth = ctx.createGain();
    const pitch = f * v.pitch;
    carrier.frequency.value = pitch;
    modulator.frequency.value = pitch * ratio;
    depth.gain.setValueAtTime(Math.max(0.01, index * pitch * ratio), t);
    depth.gain.exponentialRampToValueAtTime(Math.max(0.01, indexTo * pitch * ratio), t + dur);
    modulator.connect(depth).connect(carrier.frequency);
    const amp = ctx.createGain();
    this.#envelope(amp.gain, t, { a, hold, g, dur });
    carrier.connect(amp).connect(v.out);
    for (const osc of [carrier, modulator]) {
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
    carrier.onended = () => amp.disconnect();
    v.end = Math.max(v.end, at + dur);
  }

  /** Struck metal or crystal: partials at `ratios` of `f`, the higher ones quieter and sooner gone. */
  bell(v, { f, ratios = [1, 2.76, 5.4, 8.93], at = 0, dur, g = 0.2 }) {
    ratios.forEach((ratio, i) => {
      // Past the top of hearing a partial would only fold back down as noise.
      if (f * ratio * v.pitch < 16_000) this.tone(v, { f: f * ratio, at, dur: dur * (1 - i * 0.16), a: 0.002, g: g / (i + 1) });
    });
  }

  /** Notes (MIDI numbers) sounded together, each as two oscillators a little apart in pitch, through one filter. */
  chord(v, notes, { type = 'sawtooth', at = 0, dur, a = 0.02, hold = 0, g = 0.2, lp, sweep, detune = 7, drive = 0 }) {
    const ctx = this.#ctx;
    const t = v.t + at;
    const mix = ctx.createGain();
    mix.gain.value = 1 / Math.sqrt(notes.length * 2);
    const bend = 1200 * Math.log2(v.pitch);
    let last = null;
    for (const note of notes) {
      for (const cents of [-detune, detune]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = midi(note);
        osc.detune.value = cents + bend;
        osc.connect(mix);
        osc.start(t);
        osc.stop(t + dur + 0.05);
        last = osc;
      }
    }
    let node = mix;
    if (drive) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = driveCurve(drive);
      node.connect(shaper);
      node = shaper;
    }
    const amp = ctx.createGain();
    this.#envelope(amp.gain, t, { a, hold, g, dur });
    this.#filtered(node, t, sweep ?? dur, { lp, q: 0.7 }).connect(amp).connect(v.out);
    last.onended = () => amp.disconnect();
    v.end = Math.max(v.end, at + dur);
  }

  /**
   * A recording from the sample library, one variant of `group`. Returns false,
   * having played nothing, when the library has none: the cue then synthesises
   * the layer. `rate` changes its speed and pitch, `dur` cuts it short with a
   * fade, `reverse` plays it backwards, `index` asks for a particular variant.
   */
  sample(v, group, { at = 0, g = 1, rate = 1, dur, index, reverse = false, lp, hp } = {}) {
    const item = this.#library?.pick(group, index);
    if (!item) return false;
    const ctx = this.#ctx;
    const t = v.t + at;
    let { buffer } = item;
    if (reverse) {
      if (!item.reversed) {
        item.reversed = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) item.reversed.getChannelData(channel).set(Float32Array.from(buffer.getChannelData(channel)).reverse());
      }
      buffer = item.reversed;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const speed = rate * v.pitch;
    source.playbackRate.value = speed;
    const length = Math.min(dur ?? Infinity, buffer.duration / speed);
    const amp = ctx.createGain();
    const level = g * item.level;
    amp.gain.setValueAtTime(level, t);
    if (dur !== undefined && dur < buffer.duration / speed) {
      amp.gain.setValueAtTime(level, t + length * 0.7);
      amp.gain.linearRampToValueAtTime(0, t + length);
    }
    this.#filtered(source, t, length, { lp, hp }).connect(amp).connect(v.out);
    source.start(t);
    source.stop(t + length + 0.02);
    source.onended = () => amp.disconnect();
    v.end = Math.max(v.end, at + length);
    return true;
  }
}
