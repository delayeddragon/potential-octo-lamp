/**
 * RuneDeck — game server.
 *
 * Static hosting, lobby configuration, real-time 1v1 matchmaking with an
 * automatic AI-bot fallback, and one authoritative simulation (game.js) per match.
 *
 * Socket protocol
 *   client -> server   queue:join { nickname, hero, deck }   queue:cancel   queue:spawnBot   match:leave
 *                      match:ready { matchId }
 *                      game:playCard { slot, x, z }   game:cast { key, x, z }   game:useItem { key, x, z }
 *                      game:move { x, z }   game:attack { id }
 *   server -> client   server:hello { build }   lobby:stats   lobby:error   queue:joined
 *                      match:found   match:ready { matchId, side }   match:start { side, players, state }
 *                      match:ended
 *                      game:state   game:events   game:over
 *
 * A match runs: countdown (the versus screen, where each browser loads the
 * battlefield and reports `match:ready`), then the simulation's own
 * pre-game flyover (`state.introLeftMs`, during which it takes no orders), then the battle.
 *
 * The browser's scripts and this simulation share the map and the rules, so they
 * must come from the same build. Every browser file is therefore served from a
 * URL that contains a fingerprint of the build (`/build/<id>/...`): nothing that
 * caches by URL can pair one build's scripts with another build's server. A page
 * left open across an update learns the new fingerprint on reconnecting and reloads.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server } from 'socket.io';

import { createGame } from './game.js';
import { CARDS, CARD_IDS, CHAMPIONS, CHAMPION_IDS, DEFAULT_DECK, HERO, MATCH, SIDES, sanitizeLoadout } from './public/shared.js';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const THREE_DIR = path.join(ROOT_DIR, 'node_modules', 'three', 'build');
/** Post-processing passes (bloom) ship with Three.js as separate modules. */
const THREE_ADDONS_DIR = path.join(ROOT_DIR, 'node_modules', 'three', 'examples', 'jsm');
const PORT = envInt('PORT', 3000);
/** The search for a human rival: one minute, as the lobby promises. No environment variable stretches it. */
const QUEUE_TIMEOUT_MS = MATCH.queueTimeoutMs;
const MATCH_COUNTDOWN_MS = envInt('MATCH_COUNTDOWN_MS', 5_000);
/** How long past the countdown a match waits for a player whose battlefield is still loading. */
const MATCH_LOAD_GRACE_MS = envInt('MATCH_LOAD_GRACE_MS', 30_000);
const NICKNAME_MAX_LENGTH = 16;
/**
 * Shorter matches for testing: the regular time, the sudden-death overtime, and
 * the share of their health (in percent) that Towers and Thrones start with.
 */
const MATCH_RULES = {
  durationMs: envInt('MATCH_DURATION_MS', MATCH.durationMs),
  overtimeMs: envInt('MATCH_OVERTIME_MS', MATCH.overtimeMs),
  structureHp: Math.min(100, envInt('MATCH_STRUCTURE_HP_PERCENT', 100)) / 100,
};

/** The warlords who take the field when no human rival appears. */
const BOT_NAMES = [
  'Vexis the Hollow',
  'Dread Regent',
  'Ashen Oracle',
  'Kael the Unbound',
  'Obsidian Warden',
  'Sable Tactician',
  'Emberfang',
];

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    hero: HERO,
    champions: CHAMPIONS,
    cards: CARDS,
    defaultDeck: DEFAULT_DECK,
    deckSize: MATCH.deckSize,
    queueTimeoutMs: QUEUE_TIMEOUT_MS,
  });
});

// The browser imports Three.js as an ES module through the import map in index.html.
app.use('/vendor/three/addons', express.static(THREE_ADDONS_DIR, { maxAge: '7d' }));
app.use('/vendor/three', express.static(THREE_DIR, { maxAge: '7d' }));

/** Fingerprint of the browser files as they are on disk now: it changes whenever any of them does. */
function clientBuild() {
  const hash = createHash('sha1');
  for (const name of fs.readdirSync(PUBLIC_DIR).sort()) {
    const { size, mtimeMs } = fs.statSync(path.join(PUBLIC_DIR, name));
    hash.update(`${name}:${size}:${Math.round(mtimeMs)};`);
  }
  return hash.digest('hex').slice(0, 12);
}

// The page itself is never cached, and points its stylesheets and scripts into the current build's folder.
// Modules import each other by relative path, so everything they load stays inside that folder.
app.get(['/', '/index.html'], (_req, res) => {
  const html = fs
    .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace(/\b(href|src)="(?![a-z]+:|\/|#)([^"]+\.(?:css|js))"/g, `$1="/build/${clientBuild()}/$2"`);
  res.set('Cache-Control', 'no-store').type('html').send(html);
});
app.use('/build/:build', express.static(PUBLIC_DIR, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

const server = http.createServer(app);
const io = new Server(server);

/* -------------------------------------------------------------------------- */
/* Matchmaking state                                                          */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, Player>} socket id -> connected player */
const players = new Map();
/** Players waiting for an opponent, oldest first. */
const queue = [];
/** @type {Map<string, Match>} match id -> active match */
const matches = new Map();

/**
 * @typedef {{ id: string, nickname: string, isBot: boolean, socket: import('socket.io').Socket | null,
 *   hero: string, deck: string[],
 *   state: 'idle' | 'queued' | 'matched', queueTimer: NodeJS.Timeout | null, match: Match | null,
 *   side: 'radiant' | 'dire' | null }} Player  (`hero` is a champion id, `deck` the card ids taken into battle)
 * @typedef {{ id: string, room: string, state: 'countdown' | 'live', reason: 'pvp' | 'timeout' | 'dev',
 *   sides: { radiant: Player, dire: Player }, startTimer: NodeJS.Timeout | null,
 *   ready: { radiant: boolean, dire: boolean }, countdownOver: boolean,
 *   game: ReturnType<typeof createGame> | null }} Match
 */

io.on('connection', (socket) => {
  /** @type {Player} */
  const player = {
    id: socket.id,
    nickname: '',
    isBot: false,
    ...sanitizeLoadout(null),
    socket,
    state: 'idle',
    queueTimer: null,
    match: null,
    side: null,
  };
  players.set(socket.id, player);
  socket.emit('server:hello', { build: clientBuild() });
  broadcastStats();

  socket.on('queue:join', (payload) => joinQueue(player, payload));
  socket.on('queue:cancel', () => leaveQueue(player));
  socket.on('queue:spawnBot', () => {
    if (player.state === 'queued') startBotMatch(player, 'dev');
  });
  socket.on('match:leave', () => leaveMatch(player, 'opponent_left'));
  socket.on('match:ready', (payload) => markReady(player, payload?.matchId));

  // The simulation validates every intent; these only route them to the right match.
  socket.on('game:playCard', (payload) => {
    player.match?.game?.playCard(player.side, payload?.slot, payload?.x, payload?.z);
  });
  socket.on('game:cast', (payload) => player.match?.game?.cast(player.side, payload?.key, payload?.x, payload?.z));
  socket.on('game:useItem', (payload) => player.match?.game?.useItem(player.side, payload?.key, payload?.x, payload?.z));
  socket.on('game:move', (payload) => player.match?.game?.heroMove(player.side, payload?.x, payload?.z));
  socket.on('game:attack', (payload) => player.match?.game?.heroAttack(player.side, payload?.id));

  socket.on('disconnect', () => {
    leaveQueue(player);
    leaveMatch(player, 'opponent_disconnected');
    players.delete(socket.id);
    broadcastStats();
  });
});

function joinQueue(player, payload) {
  if (player.state !== 'idle') {
    player.socket.emit('lobby:error', { message: 'You are already in a queue or match.' });
    return;
  }
  player.nickname = sanitizeNickname(payload?.nickname);
  Object.assign(player, sanitizeLoadout(payload));
  player.socket.emit('queue:joined', { nickname: player.nickname, timeoutMs: QUEUE_TIMEOUT_MS, elapsedMs: 0 });

  // Anyone already waiting becomes Player 1 (Radiant); the newcomer is Player 2 (Dire).
  const opponent = queue.shift();
  if (opponent) {
    clearTimeout(opponent.queueTimer);
    opponent.queueTimer = null;
    createMatch(opponent, player, 'pvp');
    return;
  }

  player.state = 'queued';
  player.queueTimer = setTimeout(() => startBotMatch(player, 'timeout'), QUEUE_TIMEOUT_MS);
  queue.push(player);
  log('queue', `${player.nickname} is searching (${queue.length} waiting)`);
  broadcastStats();
}

function leaveQueue(player) {
  if (player.state !== 'queued') return;
  removeFromQueue(player);
  player.state = 'idle';
  log('queue', `${player.nickname} left the queue`);
  broadcastStats();
}

function removeFromQueue(player) {
  clearTimeout(player.queueTimer);
  player.queueTimer = null;
  const index = queue.indexOf(player);
  if (index !== -1) queue.splice(index, 1);
}

function startBotMatch(player, reason) {
  if (player.state !== 'queued') return;
  removeFromQueue(player);
  createMatch(player, createBot(player), reason);
}

/**
 * Server-side AI opponent. The simulation drives it; it has no socket. It takes
 * a champion its rival did not, and a random battle deck.
 */
function createBot(rival) {
  const others = CHAMPION_IDS.filter((id) => id !== rival.hero);
  const pool = [...CARD_IDS];
  const deck = Array.from({ length: MATCH.deckSize }, () => pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return {
    id: `bot_${shortId()}`,
    nickname: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
    isBot: true,
    hero: others[Math.floor(Math.random() * others.length)],
    deck,
    socket: null,
    state: 'matched',
    queueTimer: null,
    match: null,
    side: null,
  };
}

/** What both players may know about each other. A deck stays private. */
function rosterOf(match) {
  const entry = ({ nickname, isBot, hero }) => ({ nickname, isBot, hero });
  return { radiant: entry(match.sides.radiant), dire: entry(match.sides.dire) };
}

function createMatch(radiant, dire, reason) {
  const id = shortId();
  /** @type {Match} */
  const match = {
    id,
    room: `match:${id}`,
    state: 'countdown',
    reason,
    sides: { radiant, dire },
    startTimer: null,
    // A bot has nothing to load.
    ready: { radiant: radiant.isBot, dire: dire.isBot },
    countdownOver: false,
    game: null,
  };
  matches.set(id, match);

  for (const side of SIDES) {
    const participant = match.sides[side];
    participant.state = 'matched';
    participant.match = match;
    participant.side = side;
    if (participant.isBot) continue;
    participant.socket.join(match.room);
    participant.socket.emit('match:found', {
      matchId: id,
      reason,
      side,
      vsBot: radiant.isBot || dire.isBot,
      countdownMs: MATCH_COUNTDOWN_MS,
      players: rosterOf(match),
    });
  }

  match.startTimer = setTimeout(() => {
    match.countdownOver = true;
    // Whoever is still loading gets a little longer; after that the match starts regardless.
    match.startTimer = setTimeout(() => startGame(match), MATCH_LOAD_GRACE_MS);
    startWhenReady(match);
  }, MATCH_COUNTDOWN_MS);

  log('match', `${id} created (${reason}): ${radiant.nickname} [Radiant] vs ${dire.nickname} [Dire]`);
  broadcastStats();
}

/** A player's browser has the battlefield loaded. */
function markReady(player, matchId) {
  const match = player.match;
  if (!match || match.id !== matchId || match.state !== 'countdown' || match.ready[player.side]) return;
  match.ready[player.side] = true;
  io.to(match.room).emit('match:ready', { matchId: match.id, side: player.side });
  startWhenReady(match);
}

function startWhenReady(match) {
  if (match.countdownOver && match.ready.radiant && match.ready.dire) startGame(match);
}

function startGame(match) {
  if (match.state !== 'countdown' || !matches.has(match.id)) return;
  clearTimeout(match.startTimer);
  match.startTimer = null;
  match.state = 'live';
  const loadout = ({ nickname, isBot, hero, deck }) => ({ nickname, isBot, hero, deck });
  match.game = createGame({
    players: { radiant: loadout(match.sides.radiant), dire: loadout(match.sides.dire) },
    rules: MATCH_RULES,
    emit(side, event, payload) {
      const participant = match.sides[side];
      if (!participant.isBot) participant.socket.emit(event, payload);
    },
    // A finished game releases its players; the result screen is client-side.
    onOver() {
      log('match', `${match.id} finished`);
      closeMatch(match);
    },
  });

  for (const side of SIDES) {
    const participant = match.sides[side];
    if (participant.isBot) continue;
    participant.socket.emit('match:start', {
      matchId: match.id,
      side,
      players: rosterOf(match),
      state: match.game.snapshot(side),
    });
  }
  log('match', `${match.id} is live`);
}

/** Stops the match and frees its players. `leaver` leaving tells the other human why. */
function closeMatch(match, leaver = null, reasonForOpponent = null) {
  if (!matches.delete(match.id)) return;
  clearTimeout(match.startTimer);
  match.game?.stop();

  for (const side of SIDES) {
    const participant = match.sides[side];
    participant.match = null;
    participant.side = null;
    if (participant.isBot) continue;
    participant.state = 'idle';
    participant.socket.leave(match.room);
    if (leaver && participant !== leaver) {
      participant.socket.emit('match:ended', { matchId: match.id, reason: reasonForOpponent });
    }
  }
  broadcastStats();
}

function leaveMatch(player, reasonForOpponent) {
  const match = player.match;
  if (!match) return;
  log('match', `${match.id} ended (${player.nickname}: ${reasonForOpponent})`);
  closeMatch(match, player, reasonForOpponent);
}

function broadcastStats() {
  io.emit('lobby:stats', { online: players.size, searching: queue.length, matches: matches.size });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sanitizeNickname(raw) {
  const cleaned = (typeof raw === 'string' ? raw : '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _\-.']/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = [...cleaned].slice(0, NICKNAME_MAX_LENGTH).join('').trim();
  return clipped || `Knight-${1000 + Math.floor(Math.random() * 9000)}`;
}

function shortId() {
  return randomBytes(4).toString('hex');
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function log(scope, message) {
  console.log(`${new Date().toISOString()} [${scope}] ${message}`);
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

server.listen(PORT, () => {
  log('server', `RuneDeck listening on http://localhost:${PORT} (bot fallback after ${QUEUE_TIMEOUT_MS / 1000}s)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('server', `${signal} received, shutting down`);
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
