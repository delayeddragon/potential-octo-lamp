/**
 * RuneDeck — the music.
 *
 * Two pieces, made of oscillators and noise as they play; nothing is downloaded.
 *
 *   lobby    slow chords, a harp and a far bell: the hall before a battle
 *   battle   war drums, a bass, running strings and a horn tune in D minor
 *
 * `set(theme)` cross-fades from one to the other, or to silence for null.
 *
 * The battle has three intensities, and each adds players and quickens the pulse:
 *
 *   0   drums, bass, a ticking string and now and then a line of the tune
 *   1   the strings run in quavers, a shaker joins, the tune is played through
 *   2   galloping bass, snare and brass in semiquavers, a tone higher
 *
 * A change of intensity takes hold on the next beat (the change of key on the
 * next bar), so it never lands across the music.
 *
 * Notes are scheduled a little ahead of the audio clock from a timer (the lobby
 * further ahead than the battle: see `LOOKAHEAD`). Browsers slow the timers of
 * a hidden tab, so the music is hushed there (`hush`) and picks its place up
 * again when the player comes back.
 */

const hz = (note) => 440 * 2 ** ((note - 69) / 12);
const pickOther = (list, last) => {
  const at = Math.floor(Math.random() * list.length);
  return list.length > 1 && list[at] === last ? list[(at + 1) % list.length] : list[at];
};

/**
 * How far ahead of the audio clock each theme's notes are scheduled, and how often the scheduler looks.
 * The battle keeps close to the clock, so that a change of intensity is heard at once. The lobby has
 * nothing to answer to, and it plays while the battlefield loads and holds the page's timers up for
 * long moments: it is scheduled far enough ahead to play through them.
 */
const LOOKAHEAD = { lobby: 1.5, battle: 0.35 };
const TICK_MS = 90;
/** A theme that has been faded out is no longer scheduled after this long. */
const SILENT_AFTER = 5;
/** How fast a theme comes in and goes out: time constants, so about three times as long to finish. */
const FADE_IN = 0.45;
const FADE_OUT = 0.9;

/* -------------------------------------------------------------------------- */
/* Instruments                                                                */
/* -------------------------------------------------------------------------- */

function createKit(ctx) {
  const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  /** A gain into `to` that rises to `g` in `a` seconds, holds for `hold`, and has died away by `dur`. */
  function amp(to, t, { g, a = 0.005, hold = 0, dur }) {
    const node = ctx.createGain();
    const peak = Math.max(g, 0.0002);
    const top = Math.min(a, dur * 0.8);
    node.gain.setValueAtTime(0.0001, t);
    node.gain.linearRampToValueAtTime(peak, t + top);
    if (hold > 0) node.gain.setValueAtTime(peak, t + Math.min(top + hold, dur * 0.95));
    node.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(to);
    return node;
  }

  function osc(to, t, dur, type, f, cents = 0) {
    const node = ctx.createOscillator();
    node.type = type;
    node.frequency.value = f;
    node.detune.value = cents;
    node.connect(to);
    node.start(t);
    node.stop(t + dur + 0.03);
    return node;
  }

  function filter(to, type, f, q = 0.7) {
    const node = ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = f;
    node.Q.value = q;
    node.connect(to);
    return node;
  }

  function noise(to, t, dur) {
    const node = ctx.createBufferSource();
    node.buffer = noiseBuffer;
    node.loop = true;
    node.connect(to);
    node.start(t, Math.random() * 0.9);
    node.stop(t + dur + 0.03);
    return node;
  }

  /** Once `source` has stopped, `out` is taken off the graph, or the graph would only grow. */
  const tidy = (source, out) => {
    source.onended = () => out.disconnect();
  };

  return {
    /** Sustained strings: each note is two saws a few cents apart, and the chord shares one filter. */
    pad(to, notes, t, dur, g, { cutoff = 900, a = 0.6, r = 1.2 } = {}) {
      const out = ctx.createGain();
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(g, t + a);
      out.gain.setValueAtTime(g, t + Math.max(dur, a));
      out.gain.linearRampToValueAtTime(0, t + Math.max(dur, a) + r);
      out.connect(to);
      const tone = filter(out, 'lowpass', cutoff);
      let last = null;
      for (const note of notes) for (const cents of [-7, 7]) last = osc(tone, t, Math.max(dur, a) + r, 'sawtooth', hz(note), cents);
      tidy(last, out);
    },

    /** A low hum under the chords. */
    drone(to, note, t, dur, g, { a = 1.5, r = 2 } = {}) {
      const out = ctx.createGain();
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(g, t + a);
      out.gain.setValueAtTime(g, t + Math.max(dur, a));
      out.gain.linearRampToValueAtTime(0, t + Math.max(dur, a) + r);
      out.connect(to);
      osc(out, t, Math.max(dur, a) + r, 'sine', hz(note));
      const fifth = ctx.createGain();
      fifth.gain.value = 0.22;
      fifth.connect(out);
      tidy(osc(fifth, t, Math.max(dur, a) + r, 'triangle', hz(note + 12), 4), out);
    },

    /** A harp string. */
    pluck(to, note, t, dur, g) {
      const out = amp(to, t, { g, a: 0.004, dur });
      osc(out, t, dur, 'triangle', hz(note));
      const octave = ctx.createGain();
      octave.gain.value = 0.22;
      octave.connect(out);
      tidy(osc(octave, t, dur * 0.6, 'sine', hz(note) * 2), octave);
      tidy(osc(out, t, dur, 'sine', hz(note), 5), out);
    },

    /** A small bell: three partials that are not quite in tune, the high ones gone first. */
    bell(to, note, t, dur, g) {
      const out = ctx.createGain();
      out.gain.value = g;
      out.connect(to);
      const partials = [[1, 1, 1], [2.76, 0.32, 0.55], [5.4, 0.1, 0.3]];
      partials.forEach(([ratio, level, life], index) => {
        const source = osc(amp(out, t, { g: level, a: 0.003, dur: dur * life }), t, dur * life, 'sine', hz(note) * ratio);
        if (index === 0) tidy(source, out);
      });
    },

    /** A bowed bass note: a saw that closes as it sounds, over a sine an octave's weight below it. */
    bass(to, note, t, dur, g) {
      const out = amp(to, t, { g, a: 0.008, hold: dur * 0.45, dur });
      const tone = filter(out, 'lowpass', 700, 1.1);
      tone.frequency.setValueAtTime(760, t);
      tone.frequency.exponentialRampToValueAtTime(230, t + dur);
      osc(tone, t, dur, 'sawtooth', hz(note));
      const sub = ctx.createGain();
      sub.gain.value = 0.75;
      sub.connect(out);
      tidy(osc(sub, t, dur, 'sine', hz(note)), out);
    },

    /** A short stroke of the strings. */
    string(to, note, t, dur, g, cutoff = 1800) {
      const out = amp(to, t, { g, a: 0.012, dur });
      const tone = filter(out, 'lowpass', cutoff);
      osc(tone, t, dur, 'sawtooth', hz(note), -6);
      tidy(osc(tone, t, dur, 'sawtooth', hz(note), 6), out);
    },

    /** Horns, or with `bright` above 1, trumpets: the filter opens with the breath and closes after it. */
    horn(to, notes, t, dur, g, bright = 1) {
      const out = amp(to, t, { g, a: 0.045, hold: dur * 0.55, dur });
      const tone = filter(out, 'lowpass', 380, 1.3);
      tone.frequency.setValueAtTime(380 * bright, t);
      tone.frequency.linearRampToValueAtTime(1500 * bright, t + Math.min(0.09, dur * 0.4));
      tone.frequency.exponentialRampToValueAtTime(620 * bright, t + dur);
      let last = null;
      for (const note of notes) {
        osc(tone, t, dur, 'sawtooth', hz(note), -5);
        last = osc(tone, t, dur, 'sawtooth', hz(note), 5);
      }
      tidy(last, out);
    },

    /** A war drum: a low note that falls as it is struck, and the slap of the skin. */
    drum(to, t, g, { f = 92, drop = 44, dur = 0.45 } = {}) {
      const out = amp(to, t, { g, a: 0.002, dur });
      const body = osc(out, t, dur, 'sine', f);
      body.frequency.setValueAtTime(f, t);
      body.frequency.exponentialRampToValueAtTime(drop, t + 0.11);
      noise(filter(amp(out, t, { g: 0.6, a: 0.001, dur: 0.07 }), 'lowpass', 1400), t, 0.07);
      tidy(body, out);
    },

    /** A snare, a rim or a shaker: a short band of noise. */
    hit(to, t, g, { band = 1900, q = 0.8, dur = 0.14, type = 'bandpass' } = {}) {
      const out = amp(to, t, { g, a: 0.001, dur });
      tidy(noise(filter(out, type, band, q), t, dur), out);
    },

    /** Noise that rises into `t + dur`: the breath before a blow. */
    swell(to, t, dur, g) {
      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.exponentialRampToValueAtTime(Math.max(g, 0.0002), t + dur);
      out.gain.linearRampToValueAtTime(0, t + dur + 0.06);
      out.connect(to);
      const tone = filter(out, 'bandpass', 500, 1.2);
      tone.frequency.setValueAtTime(400, t);
      tone.frequency.exponentialRampToValueAtTime(5200, t + dur);
      tidy(noise(tone, t, dur + 0.06), out);
    },

    /** A cymbal. */
    crash(to, t, g, dur = 1.8) {
      const out = amp(to, t, { g, a: 0.002, dur });
      tidy(noise(filter(out, 'highpass', 3800), t, dur), out);
    },

    /** A draught through the hall: quiet noise that comes and goes. */
    air(to, t, dur, g) {
      const out = ctx.createGain();
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(g, t + dur * 0.45);
      out.gain.linearRampToValueAtTime(0, t + dur);
      out.connect(to);
      const tone = filter(out, 'bandpass', 420, 0.6);
      tone.frequency.setValueAtTime(320, t);
      tone.frequency.linearRampToValueAtTime(620, t + dur * 0.5);
      tone.frequency.linearRampToValueAtTime(380, t + dur);
      tidy(noise(tone, t, dur), out);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The lobby                                                                  */
/* -------------------------------------------------------------------------- */

const LOBBY_BPM = 66;
/** Each chord lasts two bars of eight quavers. `harp` is what the harp may play over it, low to high. */
const LOBBY_CHORDS = [
  { root: 38, pad: [50, 57, 62, 65], harp: [62, 65, 69, 74, 76, 77] }, // D minor, with its ninth in the harp
  { root: 34, pad: [46, 53, 57, 62], harp: [58, 62, 65, 69, 74, 77] }, // B flat major seventh
  { root: 41, pad: [53, 57, 60, 67], harp: [60, 65, 67, 69, 72, 77] }, // F, added ninth
  { root: 36, pad: [48, 55, 62, 64], harp: [60, 62, 64, 67, 72, 76] }, // C, added ninth
  { root: 38, pad: [50, 57, 62, 65], harp: [65, 69, 74, 76, 77, 81] },
  { root: 43, pad: [55, 58, 62, 65], harp: [58, 62, 65, 67, 70, 74] }, // G minor seventh
  { root: 34, pad: [46, 53, 57, 62], harp: [62, 65, 69, 70, 74, 77] },
  { root: 33, pad: [45, 52, 57, 62], harp: [57, 62, 64, 69, 74, 76] }, // A, suspended: it never quite resolves
];
/** One bar of harp: which of the chord's harp notes falls on each quaver, or -1 for none. */
const HARP_BARS = [
  [0, 2, 3, -1, 4, -1, 2, -1],
  [0, -1, 2, 3, -1, 5, -1, 3],
  [1, 3, -1, 4, -1, 2, -1, -1],
  [0, 2, 4, 5, 4, -1, 2, -1],
  [-1, -1, 3, -1, 4, -1, 5, -1],
  [0, -1, -1, 2, -1, 3, -1, -1],
];
/** What the bell answers with, in the second bar of every other chord: [quaver, harp note]. */
const BELL_PHRASES = [
  [[0, 3], [3, 5], [6, 4]],
  [[0, 5], [2, 4], [4, 3], [7, 4]],
  [[1, 4], [4, 5]],
];

function createLobby(kit, dry, wet) {
  let bar = HARP_BARS[0];
  let phrase = BELL_PHRASES[0];
  return {
    /** The length of the step about to be played, in seconds. */
    stepSeconds: () => 60 / LOBBY_BPM / 2,
    reset() {},
    schedule(step, t, sec) {
      const at = step % 16;
      const number = Math.floor(step / 16) % LOBBY_CHORDS.length;
      const chord = LOBBY_CHORDS[number];
      if (at === 0) {
        kit.pad(wet, chord.pad, t, sec * 16, 0.034, { cutoff: 760, a: 1.8, r: 2.6 });
        kit.drone(dry, chord.root, t, sec * 16, 0.13, { a: 1.6, r: 2.4 });
        kit.air(wet, t, sec * 16, 0.035);
      }
      const quaver = at % 8;
      if (quaver === 0) {
        bar = pickOther(HARP_BARS, bar);
        if (at === 8) phrase = pickOther(BELL_PHRASES, phrase);
      }
      const string = bar[quaver];
      if (string >= 0) kit.pluck(wet, chord.harp[string], t, 2.2, (quaver === 0 ? 0.105 : 0.07) * (0.8 + Math.random() * 0.4));
      if (at >= 8 && number % 2 === 1) {
        for (const [when, note] of phrase) if (when === quaver) kit.bell(wet, chord.harp[note] + 12, t, 3.4, 0.05);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The battle                                                                 */
/* -------------------------------------------------------------------------- */

/** Beats a minute at each intensity. The pulse eases from one to the next over a bar or so. */
const BATTLE_BPM = [98, 110, 124];
/** How many semitones the whole piece is raised at each intensity. */
const BATTLE_KEY = [0, 0, 2];

/** One chord a bar, eight bars round: the bass note, and the three notes above it. */
const D_MINOR = { root: 38, tones: [50, 53, 57] };
const B_FLAT = { root: 34, tones: [50, 53, 58] };
const C_MAJOR = { root: 36, tones: [52, 55, 60] };
const G_MINOR = { root: 31, tones: [50, 55, 58] };
const A_MAJOR = { root: 33, tones: [49, 52, 57] };
const BATTLE_CHORDS = [D_MINOR, D_MINOR, B_FLAT, C_MAJOR, D_MINOR, G_MINOR, B_FLAT, A_MAJOR];

/** The tune, bar by bar: [semiquaver it starts on, note, how many semiquavers it lasts]. */
const BATTLE_TUNE = [
  [[0, 69, 6], [6, 74, 2], [8, 77, 8]],
  [[0, 76, 4], [4, 74, 4], [8, 69, 8]],
  [[0, 70, 6], [6, 74, 2], [8, 77, 6], [14, 79, 2]],
  [[0, 76, 8], [8, 72, 4], [12, 76, 4]],
  [[0, 74, 6], [6, 77, 2], [8, 81, 8]],
  [[0, 79, 4], [4, 77, 4], [8, 74, 4], [12, 70, 4]],
  [[0, 77, 6], [6, 76, 2], [8, 74, 8]],
  [[0, 73, 8], [8, 76, 4], [12, 69, 4]],
];
/** At the lowest intensity only these bars of the tune are played, an octave down. */
const QUIET_TUNE_BARS = new Set([0, 1, 4]);

/** The drums of a bar at each intensity: semiquaver -> how hard. */
const DRUMS = [
  { 0: 1, 8: 0.8, 11: 0.4 },
  { 0: 1, 3: 0.55, 6: 0.72, 8: 0.95, 11: 0.55, 14: 0.72 },
  { 0: 1, 3: 0.6, 6: 0.78, 8: 1, 10: 0.45, 11: 0.6, 14: 0.8 },
];

function createBattle(kit, dry, wet, wanted) {
  /** The intensity now being played, the pulse, and the key: each follows what is wanted in its own time. */
  let level = 0;
  let bpm = BATTLE_BPM[0];
  let key = 0;
  /** Bars played since the theme began: the bar of drums that opens it is bar -1. */
  let opened = false;

  function intro(at, t, sec) {
    // One bar of drums gathering, and a breath, before the first chord.
    if (at === 0) {
      kit.swell(wet, t, sec * 16, 0.09);
      kit.drone(dry, 38, t, sec * 16, 0.16, { a: sec * 10, r: 0.6 });
    }
    const roll = { 0: 0.5, 4: 0.55, 8: 0.65, 10: 0.6, 12: 0.75, 13: 0.7, 14: 0.85, 15: 0.95 };
    if (roll[at]) kit.drum(dry, t, 0.42 * roll[at], { f: 84 + at, drop: 42 });
  }

  /** The stakes have just risen: a cymbal and a great drum on this beat. */
  function accent(t) {
    kit.crash(wet, t, 0.12, 2);
    kit.drum(dry, t, 0.55, { f: 70, drop: 30, dur: 0.9 });
  }

  return {
    stepSeconds() {
      bpm += (BATTLE_BPM[level] - bpm) * 0.1;
      return 60 / bpm / 4;
    },
    /** Starts the piece again from its opening bar. */
    reset() {
      level = wanted();
      bpm = BATTLE_BPM[level];
      key = BATTLE_KEY[level];
      opened = false;
    },
    state: () => ({ level, bpm: Math.round(bpm), key }),
    schedule(step, t, sec) {
      const at = step % 16;
      if (step < 16) {
        intro(at, t, sec);
        return;
      }
      if (at % 4 === 0 && wanted() !== level) {
        const rose = wanted() > level;
        level = wanted();
        if (rose) accent(t);
      }
      const bar = (Math.floor(step / 16) - 1) % BATTLE_CHORDS.length;
      if (at === 0) key = BATTLE_KEY[level];
      const chord = BATTLE_CHORDS[bar];
      const root = chord.root + key;
      const tones = chord.tones.map((note) => note + key);
      const barSeconds = sec * 16;

      if (at === 0) {
        if (!opened) {
          opened = true;
          kit.crash(wet, t, 0.1, 2.2);
        }
        kit.pad(wet, tones, t, barSeconds * 0.96, [0.02, 0.023, 0.026][level], { cutoff: [720, 1050, 1500][level], a: 0.12, r: 0.5 });
      }

      // Drums: a slow heartbeat, then the three-three-two of a march, then a fill to end every other bar.
      const blow = DRUMS[level][at];
      if (blow) kit.drum(dry, t, 0.46 * blow, { f: at === 0 ? 86 : 98, drop: at === 0 ? 38 : 46 });
      if (level === 2 && bar % 2 === 1 && at >= 12) kit.drum(dry, t, 0.24 + (at - 12) * 0.05, { f: 120 + (at - 12) * 16, drop: 70, dur: 0.22 });

      // Bass: held notes, then quavers, then a gallop.
      if (level === 0) {
        if (at === 0) kit.bass(dry, root, t, sec * 7, 0.2);
        else if (at === 8) kit.bass(dry, root, t, sec * 5, 0.16);
      } else if (level === 1) {
        if (at % 2 === 0) kit.bass(dry, root + (at === 6 || at === 14 ? 12 : 0), t, sec * 1.8, at % 4 === 0 ? 0.19 : 0.14);
      } else if (at % 4 !== 1) {
        kit.bass(dry, root + (at >= 12 && bar % 2 === 1 ? 12 : 0), t, sec * 1.1, at % 4 === 0 ? 0.2 : 0.13);
      }

      // Strings: a tick on the beat, then running quavers, then semiquavers.
      if (level === 0) {
        if (at % 4 === 0) kit.string(wet, tones[(at / 4) % 3] + 12, t, sec * 2.2, 0.03, 1400);
      } else if (level === 1) {
        if (at % 2 === 0) {
          const run = [tones[0], tones[2], tones[1], tones[2], tones[0] + 12, tones[2], tones[1], tones[2]];
          kit.string(wet, run[at / 2] + 12, t, sec * 1.7, at % 4 === 0 ? 0.042 : 0.03, 2000);
        }
      } else {
        const run = [tones[0], tones[0] + 12, tones[1], tones[0] + 12, tones[2], tones[0] + 12, tones[1], tones[0] + 12];
        kit.string(wet, run[at % 8] + 12, t, sec * 1.15, at % 4 === 0 ? 0.044 : 0.028, 2600);
      }

      // Shaker and snare.
      if (level === 1 && at % 2 === 0) kit.hit(dry, t, at % 4 === 2 ? 0.035 : 0.018, { band: 7200, type: 'highpass', dur: 0.05 });
      if (level === 2) {
        kit.hit(dry, t, at % 4 === 2 ? 0.04 : at % 2 === 0 ? 0.026 : 0.014, { band: 7600, type: 'highpass', dur: 0.045 });
        if (at === 4 || at === 12) kit.hit(wet, t, 0.13, { band: 1900, q: 0.7, dur: 0.17 });
      }

      // The tune: a line of it now and then, then all of it, then doubled above with brass under it.
      if (level > 0 || QUIET_TUNE_BARS.has(bar)) {
        for (const [start, note, length] of BATTLE_TUNE[bar]) {
          if (start !== at) continue;
          const pitch = note + key - (level === 0 ? 12 : 0);
          const voices = level === 2 ? [pitch, pitch + 12] : [pitch];
          kit.horn(wet, voices, t, sec * length * 0.95, [0.05, 0.06, 0.05][level], [0.8, 1.15, 1.5][level]);
        }
      }
      if (level === 2 && (at === 0 || at === 6 || (at === 12 && bar % 2 === 1))) {
        kit.horn(wet, tones.map((note) => note + 12), t, sec * (at === 0 ? 3.4 : 2.2), 0.036, 1.7);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The director                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Plays the music into `out`, and what should echo into `hall` (the reverb).
 * `live: false` is for a context that renders to a buffer: the whole of it is
 * scheduled at once, as the theme and intensity stand when the theme is set.
 */
export function createMusic(ctx, out, hall, { live = true } = {}) {
  const kit = createKit(ctx);
  let theme = null;
  let intensity = 0;
  let hushed = false;
  let timer = 0;

  /** Everything passes through these two, which close in a hidden tab. */
  const main = ctx.createGain();
  main.connect(out);
  const echo = ctx.createGain();
  echo.connect(hall);

  /** One theme: its two inputs (`dry`, and `wet` which also echoes), its faders, and where it is in its score. */
  function player(name, wetness, build) {
    const fade = ctx.createGain();
    fade.gain.value = 0;
    fade.connect(main);
    const fadeEcho = ctx.createGain();
    fadeEcho.gain.value = 0;
    fadeEcho.connect(echo);
    const dry = ctx.createGain();
    dry.connect(fade);
    const wet = ctx.createGain();
    wet.connect(fade);
    const send = ctx.createGain();
    send.gain.value = wetness;
    wet.connect(send).connect(fadeEcho);
    return { name, fade, fadeEcho, score: build(dry, wet), ahead: LOOKAHEAD[name], active: false, step: 0, next: 0, silentAt: Infinity };
  }

  const players = [
    player('lobby', 0.7, (dry, wet) => createLobby(kit, dry, wet)),
    player('battle', 0.35, (dry, wet) => createBattle(kit, dry, wet, () => intensity)),
  ];

  /** Schedules every step that begins before `until`, or as far ahead of the clock as each theme is kept. */
  function advance(until) {
    const now = ctx.currentTime;
    let busy = false;
    for (const one of players) {
      if (!one.active) continue;
      // The timer was held up (a busy page, a sleeping machine): skip what was missed rather than play it all at once.
      if (live && one.next < now - 0.05) one.next = now + 0.05;
      const horizon = until ?? now + one.ahead;
      while (one.next < horizon) {
        if (one.next >= one.silentAt) {
          one.active = false;
          break;
        }
        const seconds = one.score.stepSeconds();
        one.score.schedule(one.step, one.next, seconds);
        one.next += seconds;
        one.step += 1;
      }
      busy ||= one.active;
    }
    return busy;
  }

  function pump() {
    if (!live) {
      advance(ctx.length / ctx.sampleRate);
      return;
    }
    const busy = !hushed && advance();
    if (busy && !timer) timer = setInterval(pump, TICK_MS);
    else if (!busy && timer) {
      clearInterval(timer);
      timer = 0;
    }
  }

  return {
    /** Plays `name` ('lobby' or 'battle'), fading out whatever was playing; null fades to silence. */
    set(name) {
      const wanted = players.some((one) => one.name === name) ? name : null;
      if (wanted === theme) return;
      theme = wanted;
      const now = ctx.currentTime;
      for (const one of players) {
        const on = one.name === theme;
        for (const { gain } of [one.fade, one.fadeEcho]) {
          gain.cancelScheduledValues(now);
          gain.setTargetAtTime(on ? 1 : 0, now, on ? FADE_IN : FADE_OUT);
        }
        if (on) {
          one.silentAt = Infinity;
          // A theme still dying away carries on from where it was; one that had stopped begins again.
          if (!one.active) {
            one.active = true;
            one.step = 0;
            one.next = now + 0.06;
            one.score.reset();
          }
        } else if (one.active) {
          one.silentAt = now + SILENT_AFTER;
        }
      }
      pump();
    },

    /** 0, 1 or 2: how hard the battle theme drives. */
    setIntensity(value) {
      intensity = Math.min(2, Math.max(0, Math.round(Number(value) || 0)));
    },

    /** Quietens the music and stops scheduling it (a hidden tab), or brings it back. */
    hush(hide) {
      if (hushed === Boolean(hide)) return;
      hushed = Boolean(hide);
      const now = ctx.currentTime;
      for (const { gain } of [main, echo]) {
        gain.cancelScheduledValues(now);
        gain.setTargetAtTime(hushed ? 0 : 1, now, hushed ? 0.08 : 0.3);
      }
      pump();
    },

    /** What is playing, for diagnostics and tests. */
    get state() {
      const battle = players[1];
      return {
        theme,
        intensity,
        hushed,
        scheduling: Boolean(timer),
        playing: players.filter((one) => one.active).map((one) => one.name),
        battle: { step: battle.step, ...battle.score.state() },
      };
    },
  };
}
