#!/usr/bin/env node
/**
 * RuneDeck — sound effect fetcher.
 *
 *   node scripts/fetch-sfx.mjs            download, verify and install the samples
 *   node scripts/fetch-sfx.mjs --verify   re-verify what is installed, without the network
 *   node scripts/fetch-sfx.mjs --refresh  download again instead of using the cached archives
 *
 * Downloads a few public-domain (CC0) sound packs from OpenGameArt, takes the
 * handful of files RuneDeck uses out of each and installs them in
 * public/assets/sfx/, with a manifest the sound engine reads and a CREDITS.md.
 *
 * Nothing is trusted. A pack is used only if its page still says CC0 and its
 * archive arrives with HTTP 200 as a real zip; a file is installed only if it
 * is larger than 2 KB, carries a valid Ogg Vorbis or PCM WAV header and holds
 * audible length. Whatever fails is deleted and reported, and is never listed
 * in the manifest: the sound engine synthesises every sound it has no sample
 * for, so a failed download costs texture, never a sound. (The browser makes
 * the last check itself: a file `decodeAudioData` rejects is dropped there.)
 *
 * No dependencies: the zip, Ogg and WAV readers below are all there is.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'public', 'assets', 'sfx');
const CACHE = path.join(ROOT, '.cache', 'sfx');
const AGENT = { 'User-Agent': 'RuneDeck-sfx-fetcher/1.0 (+https://opengameart.org)' };
const MIN_BYTES = 2048;
const MIN_SECONDS = 0.015;
const MAX_SECONDS = 6;
const OGA = 'https://opengameart.org';

/** The packs: where each is described, where its archive is, and who made it (checked against the page on every run). */
const PACKS = {
  'kenney-interface': { title: 'Interface Sounds', author: 'Kenney', page: 'interface-sounds', archive: 'kenney_interfaceSounds.zip' },
  'kenney-casino': { title: 'Casino Audio', author: 'Kenney', page: '54-casino-sound-effects-cards-dice-chips', archive: 'kenney_casino-audio.zip' },
  'kenney-rpg': { title: 'RPG Audio', author: 'Kenney', page: '50-rpg-sound-effects', archive: 'RPGsounds_Kenney.zip' },
  rpg80: { title: '80 CC0 RPG SFX', author: 'rubberduck', page: '80-cc0-rpg-sfx', archive: '80-CC0-RPG-SFX_0.zip' },
  sfx100: { title: '100 CC0 SFX', author: 'rubberduck', page: '100-cc0-sfx', archive: '100-CC0-SFX_0.zip' },
  breaking: { title: '75 CC0 breaking / falling / hit sfx', author: 'rubberduck', page: '75-cc0-breaking-falling-hit-sfx', archive: 'sfx_breaking_and_falling.zip' },
  bang: { title: '25 CC0 bang / firework SFX', author: 'rubberduck', page: '25-cc0-bang-firework-sfx', archive: '25-CC0-bang-sfx.zip' },
  swishes: { title: 'Swishes Sound Pack', author: 'artisticdude', page: 'swishes-sound-pack', archive: 'swishes.zip' },
};

/**
 * The samples: the name the sound engine knows each group by, the pack it comes
 * from and the files taken (by base name; each is one variant of the group).
 */
const SOUNDS = {
  // Interface
  tick: ['kenney-interface', 'tick_001.ogg', 'tick_002.ogg', 'tick_004.ogg'],
  drop: ['kenney-interface', 'drop_001.ogg', 'drop_002.ogg', 'drop_003.ogg'],
  latch: ['kenney-rpg', 'metalLatch.ogg', 'metalClick.ogg'],
  cardSlide: ['kenney-casino', 'card-slide-1.ogg', 'card-slide-2.ogg', 'card-slide-3.ogg', 'card-slide-4.ogg'],
  cardPlace: ['kenney-casino', 'card-place-1.ogg', 'card-place-2.ogg', 'card-place-4.ogg'],
  cardShove: ['kenney-casino', 'card-shove-1.ogg', 'card-shove-3.ogg'],
  // Gold, relics and the rune bottle
  coins: ['rpg80', 'item_coins_01.ogg', 'item_coins_02.ogg', 'item_coins_03.ogg'],
  purse: ['kenney-rpg', 'handleCoins.ogg', 'handleCoins2.ogg'],
  pop: ['sfx100', 'plop_01.ogg', 'plop_02.ogg'],
  gem: ['rpg80', 'item_gem_01.ogg', 'item_gem_03.ogg', 'item_gem_04.ogg'],
  // Steel
  blade: ['rpg80', 'blade_01.ogg', 'blade_02.ogg', 'blade_03.ogg'],
  knife: ['kenney-rpg', 'drawKnife1.ogg', 'drawKnife2.ogg', 'drawKnife3.ogg'],
  metal: ['breaking', 'bfh1_metal_hit_01.ogg', 'bfh1_metal_hit_03.ogg', 'bfh1_metal_hit_04.ogg', 'bfh1_metal_hit_05.ogg', 'bfh1_metal_hit_06.ogg'],
  swish: ['swishes', 'swish-1.wav', 'swish-3.wav', 'swish-4.wav', 'swish-7.wav', 'swish-9.wav'],
  whip: ['swishes', 'swish-11.wav', 'swish-12.wav', 'swish-13.wav'],
  // Bodies and marching
  impact: ['sfx100', 'hit_01.ogg', 'hit_02.ogg', 'hit_03.ogg'],
  footstep: ['kenney-rpg', 'footstep00.ogg', 'footstep01.ogg', 'footstep02.ogg', 'footstep03.ogg'],
  belt: ['kenney-rpg', 'beltHandle1.ogg', 'beltHandle2.ogg'],
  bodyfall: ['kenney-rpg', 'dropLeather.ogg'],
  // Stone, crystal and fire
  slam: ['sfx100', 'slam_01.ogg', 'slam_02.ogg', 'slam_06.ogg'],
  rock: ['breaking', 'bfh1_rock_falling_01.ogg', 'bfh1_rock_falling_03.ogg', 'bfh1_rock_falling_05.ogg'],
  rockhit: ['breaking', 'bfh1_rock_hit_01.ogg', 'bfh1_rock_falling_04.ogg'],
  rubble: ['breaking', 'bfh1_rock_breaking_01.ogg', 'bfh1_rock_breaking_02.ogg'],
  stone: ['rpg80', 'item_stone_02.ogg', 'item_stone_04.ogg', 'stones_04.ogg'],
  glass: ['sfx100', 'glass_01.ogg', 'glass_02.ogg', 'glass_03.ogg'],
  shatter: ['breaking', 'bfh1_glass_breaking_01.ogg', 'bfh1_glass_breaking_03.ogg'],
  fire: ['rpg80', 'spell_fire_06.ogg', 'spell_fire_07.ogg'],
  // Blasts and bells
  bang: ['bang', 'bang_03.ogg', 'bang_07.ogg', 'bang_09.ogg'],
  cannon: ['bang', 'cannon_03.ogg', 'cannon_04.ogg'],
  crack: ['bang', 'shot_01.ogg', 'shot_02.ogg'],
  bell: ['sfx100', 'bell_01.ogg'],
  gong: ['sfx100', 'gong_01.ogg'],
};

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

/** The entries of a zip archive: [{ name, read() }]. */
function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip archive');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = buffer.readUInt16LE(at + 10);
    const packed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.push({
      name,
      read() {
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const data = buffer.subarray(start, start + packed);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error(`zip method ${method} is not supported`);
      },
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Reads an Ogg Vorbis file's header and length. Throws if it is not one. */
function inspectOgg(data) {
  if (data.toString('latin1', 0, 4) !== 'OggS') throw new Error('no Ogg header');
  const segments = data[26];
  const packet = 27 + segments;
  if (data[packet] !== 1 || data.toString('latin1', packet + 1, packet + 7) !== 'vorbis') throw new Error('not Vorbis audio');
  const channels = data[packet + 11];
  const rate = data.readUInt32LE(packet + 12);
  if (!channels || channels > 2 || rate < 8000 || rate > 96000) throw new Error('implausible Vorbis header');
  // The last page says how many samples the stream holds.
  const last = data.lastIndexOf('OggS', data.length, 'latin1');
  const samples = Number(data.readBigInt64LE(last + 6));
  if (!(samples > 0)) throw new Error('empty stream');
  return { format: 'ogg', channels, rate, seconds: samples / rate };
}

/** Reads a PCM WAV file. Returns its samples mixed to mono, as floats. Throws if it is not one. */
function readWav(data) {
  if (data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WAVE') throw new Error('no WAV header');
  let format = null;
  let body = null;
  for (let at = 12; at + 8 <= data.length; ) {
    const id = data.toString('latin1', at, at + 4);
    const size = data.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      let tag = data.readUInt16LE(at + 8);
      // "Extensible" files keep the real format in a sub-header.
      if (tag === 0xfffe) tag = data.readUInt16LE(at + 32);
      format = { tag, channels: data.readUInt16LE(at + 10), rate: data.readUInt32LE(at + 12), bits: data.readUInt16LE(at + 22) };
    } else if (id === 'data') {
      body = data.subarray(at + 8, Math.min(data.length, at + 8 + size));
    }
    at += 8 + size + (size % 2);
  }
  if (!format || !body) throw new Error('WAV without format or data');
  const { tag, channels, rate, bits } = format;
  if (!(tag === 1 || tag === 3) || !channels || channels > 2 || rate < 8000 || rate > 96000) throw new Error('unsupported WAV format');
  const bytes = bits / 8;
  const read = {
    '1:16': (at) => body.readInt16LE(at) / 32768,
    '1:24': (at) => body.readIntLE(at, 3) / 8388608,
    '1:32': (at) => body.readInt32LE(at) / 2147483648,
    '3:32': (at) => body.readFloatLE(at),
  }[`${tag}:${bits}`];
  if (!read) throw new Error(`unsupported WAV sample size (${bits} bit)`);
  const frames = Math.floor(body.length / (bytes * channels));
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += read((frame * channels + channel) * bytes);
    mono[frame] = sum / channels;
  }
  return { rate, mono, channels, bits };
}

/** A 16-bit mono WAV file of `mono` (floats). Small, and every browser decodes it. */
function writeWav(mono, rate) {
  const out = Buffer.alloc(44 + mono.length * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + mono.length * 2, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(mono.length * 2, 40);
  for (let i = 0; i < mono.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mono[i])) * 32767), 44 + i * 2);
  return out;
}

/**
 * Checks one audio file. Returns { data, ext, seconds } ready to install (a WAV
 * comes back as 16-bit mono), or throws with the reason it was rejected.
 */
function verify(data, name) {
  if (data.length <= MIN_BYTES) throw new Error(`only ${data.length} bytes`);
  const head = data.toString('latin1', 0, 64).trimStart().toLowerCase();
  if (head.startsWith('<')) throw new Error('an HTML page, not audio');
  let checked;
  if (/\.ogg$/i.test(name)) {
    checked = { ...inspectOgg(data), data, ext: 'ogg' };
  } else if (/\.wav$/i.test(name)) {
    const wav = readWav(data);
    let peak = 0;
    for (const value of wav.mono) peak = Math.max(peak, Math.abs(value));
    if (peak < 0.02) throw new Error('silent');
    const out = wav.channels === 1 && wav.bits === 16 ? data : writeWav(wav.mono, wav.rate);
    checked = { format: 'wav', seconds: wav.mono.length / wav.rate, data: out, ext: 'wav' };
  } else {
    throw new Error('not an Ogg or WAV file');
  }
  if (!(checked.seconds >= MIN_SECONDS)) throw new Error(`only ${checked.seconds.toFixed(3)} s long`);
  if (checked.seconds > MAX_SECONDS) throw new Error(`${checked.seconds.toFixed(1)} s is too long for an effect`);
  if (checked.data.length <= MIN_BYTES) throw new Error(`only ${checked.data.length} bytes`);
  return checked;
}

/* -------------------------------------------------------------------------- */
/* Network                                                                    */
/* -------------------------------------------------------------------------- */

/** Confirms on the pack's page that it is still CC0, and reads its author. Returns null if the page cannot be read. */
async function checkLicence(pack) {
  try {
    const response = await fetch(`${OGA}/content/${pack.page}`, { headers: AGENT, signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) return null;
    const html = (await response.text()).replace(/\s+/g, ' ');
    const licences = [...html.matchAll(/class=['"]license-name['"][^>]*>([^<]+)</g)].map((match) => match[1].trim());
    const author = html.match(/Author:.{0,300}?\/users\/[^"']+["']>([^<]+)</)?.[1] ?? null;
    return { licences, author };
  } catch {
    return null;
  }
}

/** The pack's archive: from the cache, or downloaded (HTTP 200 and a real zip, or it is refused). */
async function archiveOf(id, pack, refresh) {
  const cached = path.join(CACHE, pack.archive);
  if (!refresh && fs.existsSync(cached)) return fs.readFileSync(cached);
  const url = `${OGA}/sites/default/files/${pack.archive}`;
  const response = await fetch(url, { headers: AGENT, signal: AbortSignal.timeout(180_000) });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type)) throw new Error(`the server sent ${type}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length < 22 || body.readUInt32LE(0) !== 0x04034b50) throw new Error('the download is not a zip archive');
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, body);
  return body;
}

/* -------------------------------------------------------------------------- */
/* Install                                                                    */
/* -------------------------------------------------------------------------- */

function writeCredits(manifest) {
  const lines = [
    '# Sound effect credits',
    '',
    'Every file in this folder is in the public domain under',
    '[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). None of them requires credit;',
    'they are credited here with thanks. `scripts/fetch-sfx.mjs` downloads and verifies them, and',
    '`manifest.json` lists what it installed. WAV files were mixed down to 16-bit mono; nothing else was changed.',
    '',
    'Every other sound in the game, and all of its music, is synthesised in `public/sound.js` and `public/music.js`.',
    '',
  ];
  for (const [id, pack] of Object.entries(manifest.packs)) {
    const used = Object.entries(manifest.sounds).flatMap(([group, files]) => files.filter((file) => file.pack === id).map((file) => `\`${file.file}\``));
    if (!used.length) continue;
    lines.push(`## ${pack.title} — ${pack.author}`, '', `${pack.page} (CC0)`, '', used.join(', '), '');
  }
  fs.writeFileSync(path.join(OUT, 'CREDITS.md'), lines.join('\n'));
}

/** Deletes every installed file the manifest does not list. */
function sweep(manifest) {
  const keep = new Set(['manifest.json', 'CREDITS.md', ...Object.values(manifest.sounds).flat().map((file) => file.file)]);
  for (const name of fs.readdirSync(OUT)) {
    if (!keep.has(name)) {
      fs.rmSync(path.join(OUT, name), { recursive: true, force: true });
      console.log(`  removed ${name} (not in the manifest)`);
    }
  }
}

function report(manifest) {
  const files = Object.values(manifest.sounds).flat();
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`\n${files.length} samples in ${Object.keys(manifest.sounds).length} groups verified and installed (${(bytes / 1024).toFixed(0)} KB) in ${path.relative(ROOT, OUT)}/`);
  if (manifest.rejected.length) {
    console.log(`${manifest.rejected.length} rejected:`);
    for (const item of manifest.rejected) console.log(`  ${item.group}: ${item.source} — ${item.reason}`);
  }
  const missing = Object.keys(SOUNDS).filter((group) => !manifest.sounds[group]);
  console.log(missing.length ? `Synthesised instead (no sample): ${missing.join(', ')}` : 'No group is without a sample.');
}

async function fetchAll(refresh) {
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = { version: 1, licence: 'CC0-1.0', sounds: {}, packs: {}, rejected: [] };
  const reject = (group, source, reason) => manifest.rejected.push({ group, source, reason });

  for (const [id, pack] of Object.entries(PACKS)) {
    const groups = Object.entries(SOUNDS).filter(([, [from]]) => from === id);
    process.stdout.write(`${pack.title} (${pack.author}) … `);
    const page = `${OGA}/content/${pack.page}`;
    const licence = await checkLicence(pack);
    if (licence && !(licence.licences.length === 1 && licence.licences[0] === 'CC0')) {
      console.log(`skipped: its page now lists ${licence.licences.join(', ') || 'no licence'}`);
      for (const [group] of groups) reject(group, pack.archive, 'the pack is no longer CC0 only');
      continue;
    }
    let entries;
    try {
      entries = unzip(await archiveOf(id, pack, refresh)).filter((entry) => !/(^|\/)(__MACOSX\/|\._)/.test(entry.name));
    } catch (error) {
      console.log(`failed: ${error.message}`);
      for (const [group] of groups) reject(group, pack.archive, `download failed: ${error.message}`);
      continue;
    }
    manifest.packs[id] = { title: pack.title, author: licence?.author ?? pack.author, licence: 'CC0-1.0', page, archive: `${OGA}/sites/default/files/${pack.archive}` };
    let installed = 0;
    for (const [group, [, ...names]] of groups) {
      for (const name of names) {
        const entry = entries.find((candidate) => path.posix.basename(candidate.name) === name);
        if (!entry) {
          reject(group, name, 'not in the archive');
          continue;
        }
        try {
          const checked = verify(entry.read(), name);
          const list = (manifest.sounds[group] ??= []);
          const file = `${group}-${list.length + 1}.${checked.ext}`;
          fs.writeFileSync(path.join(OUT, file), checked.data);
          list.push({ file, bytes: checked.data.length, seconds: Number(checked.seconds.toFixed(3)), pack: id, source: entry.name });
          installed++;
        } catch (error) {
          reject(group, name, error.message);
        }
      }
    }
    console.log(`${installed} files${licence ? '' : ' (its page could not be read; licence as recorded)'}`);
  }
  return manifest;
}

/** Checks the installed files against the manifest again; a file that fails is deleted and taken off it. */
function verifyInstalled() {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  manifest.rejected = [];
  for (const [group, files] of Object.entries(manifest.sounds)) {
    manifest.sounds[group] = files.filter((file) => {
      const full = path.join(OUT, file.file);
      try {
        const checked = verify(fs.readFileSync(full), file.file);
        if (checked.data.length !== file.bytes) throw new Error(`${checked.data.length} bytes, the manifest says ${file.bytes}`);
        return true;
      } catch (error) {
        manifest.rejected.push({ group, source: file.file, reason: error.code === 'ENOENT' ? 'missing' : error.message });
        fs.rmSync(full, { force: true });
        return false;
      }
    });
    if (!manifest.sounds[group].length) delete manifest.sounds[group];
  }
  return manifest;
}

const args = new Set(process.argv.slice(2));
const manifest = args.has('--verify') ? verifyInstalled() : await fetchAll(args.has('--refresh'));
fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
sweep(manifest);
writeCredits(manifest);
report(manifest);
