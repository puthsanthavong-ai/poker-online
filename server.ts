import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import { Room, Player, startGame, play, pass, botMove } from './engine.js';
import { ensurePlayer, getProfile, getDaily, saveProfile, recordResults, lvlOf, loginBonus, buyItem, equipItem } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use((req, res, next) => /\.(ts|json|map|md)$/i.test(req.path) || req.path.includes('tenlen.db') ? res.status(404).end() : next());
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server);

const TURN_MS = 30_000;
const rooms = new Map<string, Room>();
const joinAttempts = new Map<string, number[]>();

const newCode = () => { let c; do { c = String(randomInt(100000, 1000000)); } while (rooms.has(c)); return c; };
const clean = (s: unknown) => String(s ?? '').trim().slice(0, 16) || 'Player';

function rateLimited(sock: Socket) {
  const now = Date.now();
  const hits = (joinAttempts.get(sock.id) ?? []).filter((t) => now - t < 60_000);
  hits.push(now); joinAttempts.set(sock.id, hits);
  return hits.length > 10;
}

// Each client gets its own view: opponents' hands are never sent.
function view(room: Room, p: Player) {
  return {
    code: room.code, phase: room.phase, turn: room.turn, deadline: room.deadline, winner: room.winner, toiTrang: !!room.toiTrang,
    me: room.players.indexOf(p), hand: p.hand, hostId: room.hostId,
    last: room.last ? { cards: room.last.cards, by: room.last.by, type: room.last.combo.type } : null,
    passed: [...room.passed], firstMove: room.firstMove, firstCard: room.firstMove ? room.firstCard : null,
    van: room.van, vanWins: [...room.vanWins], matchWinner: room.matchWinner, rules: room.rules,
    players: room.players.map((q) => ({ name: q.name, avatar: q.avatar ?? null, lv: q.lv ?? 0, bao: !!q.bao, ready: q.ready, online: !!q.socketId || !!q.bot, bot: !!q.bot, afk: !!q.afk, count: q.hand.length, host: q.id === room.hostId })),
    // on finish, reveal remaining cards for the result screen
    reveal: room.phase === 'finished' ? room.players.map((q) => q.hand) : null,
  };
}
function broadcast(room: Room) {
  let gains: Map<string, { coins: number; notes: string[] }> | null = null;
  if (room.phase === 'finished' && !room.recorded) {
    room.recorded = true; gains = recordResults(room);
    const w = room.winner;
    if (w != null) {
      room.vanWins[w] = (room.vanWins[w] ?? 0) + 1;
      if (room.vanWins[w] >= 2) room.matchWinner = w; // best of 3: first to 2 ván wins
      else if (room.van >= 3) { let b = 0; room.vanWins.forEach((v, i) => { if (v > room.vanWins[b]) b = i; }); room.matchWinner = b; }
    }
  }
  for (const p of room.players) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit('room:state', view(room, p));
    const g = gains?.get(p.id);
    if (g) io.to(p.socketId).emit('bonus', g);
  }
}

function autoPlay(room: Room) {
  const seat = room.turn;
  const mv = botMove(room, seat);
  if (mv && !play(room, seat, mv)) return;
  if (pass(room, seat)) play(room, seat, [room.players[seat].hand[0]]);
}

// Bots and AFK players move after a short pause; humans get TURN_MS, then the bot moves for them.
function armTimer(room: Room) {
  clearTimeout(room.timer);
  if (room.phase !== 'playing') return;
  const p = room.players[room.turn];
  const auto = p.bot || p.afk;
  const wait = auto ? 900 + randomInt(900) : !p.socketId ? 5000 : TURN_MS;
  room.deadline = Date.now() + wait;
  room.timer = setTimeout(() => {
    if (room.phase !== 'playing') return;
    if (!auto) { p.missed = (p.missed ?? 0) + 1; if (p.missed >= 2) p.afk = true; }
    autoPlay(room); armTimer(room); broadcast(room);
  }, wait);
}

io.on('connection', (sock) => {
  let room: Room | undefined;
  let me: Player | undefined;

  const attach = (r: Room, p: Player) => {
    room = r; me = p; p.socketId = sock.id; p.afk = false; p.missed = 0; clearTimeout(r.gc); sock.join(r.code); broadcast(r);
    ensurePlayer(p.id, p.name);
    const lb = loginBonus(p.id);
    if (lb) sock.emit('bonus', lb);
    const prof = getProfile(p.id);
    if (prof) {
      p.avatar = (prof.avatar as string) ?? undefined;
      p.lv = lvlOf((prof.xp as number) || 0);
      sock.emit('profile', prof);
      sock.emit('daily', getDaily(p.id) ?? { played: 0, won: 0, m1: 0, m2: 0, m3: 0 });
    }
    if (r.phase === 'playing' && r.players[r.turn] === p) armTimer(r); // only reset the clock when it's their turn
  };

  sock.on('room:create', ({ name, playerId }) => {
    if (!playerId || rateLimited(sock)) return sock.emit('error:msg', 'too_many_attempts');
    const code = newCode();
    const p: Player = { id: String(playerId), name: clean(name), socketId: null, hand: [], ready: true };
    const r: Room = { code, hostId: p.id, players: [p], phase: 'lobby', turn: 0, last: null, passed: new Set(), firstMove: true, firstCard: 0, winner: null, deadline: 0, van: 1, vanWins: [0], matchWinner: null, rules: { bao: true, strict2: false }, played: new Set() };
    rooms.set(code, r); attach(r, p);
  });

  // Quick play vs bots: create room, fill with N bots, start immediately.
  sock.on('game:quick', ({ name, playerId, bots }) => {
    if (!playerId || rateLimited(sock)) return sock.emit('error:msg', 'too_many_attempts');
    const n = Math.min(3, Math.max(1, Math.floor(+bots) || 1));
    const code = newCode();
    const p: Player = { id: String(playerId), name: clean(name), socketId: null, hand: [], ready: true };
    const r: Room = { code, hostId: p.id, players: [p], phase: 'lobby', turn: 0, last: null, passed: new Set(), firstMove: true, firstCard: 0, winner: null, deadline: 0, van: 1, vanWins: [0], matchWinner: null, rules: { bao: true, strict2: false }, played: new Set() };
    for (let i = 0; i < n; i++)
      r.players.push({ id: 'bot-' + randomInt(1_000_000_000), name: 'Bot ' + ['Ann', 'Ben', 'Cat', 'Dan'][i % 4], socketId: null, hand: [], ready: true, bot: true });
    r.vanWins = r.players.map(() => 0);
    rooms.set(code, r); attach(r, p);
    r.recorded = false; startGame(r); armTimer(r); broadcast(r);
  });

  sock.on('room:join', ({ code, name, playerId }) => {
    if (rateLimited(sock)) return sock.emit('error:msg', 'too_many_attempts');
    const r = rooms.get(String(code));
    if (!r || !playerId) return sock.emit('error:msg', 'room_not_found');
    const existing = r.players.find((p) => p.id === String(playerId));
    if (existing) return attach(r, existing); // reconnect
    if (r.phase !== 'lobby') return sock.emit('error:msg', 'game_in_progress');
    if (r.players.length >= 4) return sock.emit('error:msg', 'room_full');
    const p: Player = { id: String(playerId), name: clean(name), socketId: null, hand: [], ready: false };
    r.players.push(p); r.vanWins.push(0); attach(r, p);
  });

  sock.on('room:ready', () => {
    if (!room || !me || room.phase !== 'lobby') return;
    me.ready = !me.ready; broadcast(room);
  });

  sock.on('game:start', () => {
    if (!room || !me || me.id !== room.hostId) return;
    if (room.phase === 'playing') return;
    if (room.players.length < 2) return sock.emit('error:msg', 'need_2_players');
    if (!room.players.every((p) => p.ready)) return sock.emit('error:msg', 'not_all_ready');
    room.recorded = false;
    startGame(room); armTimer(room); broadcast(room);
  });

  sock.on('game:play', ({ cards }) => {
    if (!room || !me || !Array.isArray(cards)) return;
    me.afk = false; me.missed = 0;
    const err = play(room, room.players.indexOf(me), cards.map(Number));
    if (err) return sock.emit('error:msg', err);
    armTimer(room); broadcast(room);
  });

  sock.on('game:pass', () => {
    if (!room || !me) return;
    me.afk = false; me.missed = 0;
    const err = pass(room, room.players.indexOf(me));
    if (err) return sock.emit('error:msg', err);
    armTimer(room); broadcast(room);
  });

  sock.on('room:rules', ({ bao, strict2 }) => {
    if (!room || !me || me.id !== room.hostId || room.phase !== 'lobby') return;
    room.rules = { bao: !!bao, strict2: !!strict2 }; broadcast(room);
  });

  sock.on('game:bao', () => {
    if (!room || !me) return;
    const i = room.players.indexOf(me);
    if (room.phase !== 'playing' || i !== room.turn || me.hand.length !== 1 || me.bao || !room.rules.bao) return;
    me.bao = true; broadcast(room);
  });

  sock.on('game:next', () => {
    if (!room || !me || me.id !== room.hostId || room.phase !== 'finished' || room.matchWinner != null) return;
    room.van++; room.recorded = false;
    startGame(room); armTimer(room); broadcast(room);
  });

  sock.on('game:again', () => {
    if (!room || !me || me.id !== room.hostId || room.phase !== 'finished') return;
    room.phase = 'lobby'; room.van = 1; room.vanWins = room.players.map(() => 0); room.matchWinner = null; room.toiTrang = false;
    room.players.forEach((p) => { p.hand = []; p.ready = p.id === room!.hostId || !!p.bot; p.bao = false; });
    broadcast(room);
  });

  sock.on('room:addBot', () => {
    if (!room || !me || me.id !== room.hostId || room.phase !== 'lobby' || room.players.length >= 4) return;
    const n = room.players.filter((p) => p.bot).length;
    room.players.push({ id: 'bot-' + randomInt(1_000_000_000), name: 'Bot ' + ['Ann', 'Ben', 'Cat', 'Dan'][n % 4], socketId: null, hand: [], ready: true, bot: true });
    broadcast(room);
  });
  sock.on('room:removeBot', ({ seat }) => {
    if (!room || !me || me.id !== room.hostId || room.phase !== 'lobby') return;
    if (room.players[seat]?.bot) { room.players.splice(seat, 1); broadcast(room); }
  });
  sock.on('game:resume', () => { if (me) { me.afk = false; me.missed = 0; if (room) broadcast(room); } });

  sock.on('profile:save', ({ name, avatar }) => {
    if (!me) return;
    const n = name !== undefined ? clean(name) : undefined;
    const av = avatar === undefined ? undefined : String(avatar ?? '').slice(0, 8); // '' clears the avatar
    saveProfile(me.id, { name: n, avatar: av });
    if (n !== undefined) me.name = n;
    if (av !== undefined) me.avatar = av ?? undefined;
    if (room) broadcast(room);
    const prof = getProfile(me.id); if (prof) sock.emit('profile', prof);
  });
  sock.on('profile:cfg', (c) => {
    if (!me || !c || typeof c !== 'object') return;
    saveProfile(me.id, {
      lang: ['th', 'lo', 'en'].includes(c.lang) ? c.lang : undefined,
      vol: Number.isFinite(+c.vol) ? Math.min(1, Math.max(0, +c.vol)) : undefined,
      sound: c.sound === undefined ? undefined : c.sound ? 1 : 0,
      sort: c.sort === 'suit' || c.sort === 'rank' ? c.sort : undefined,
    });
  });
  sock.on('shop:buy', ({ id }) => {
    if (!me || typeof id !== 'string') return;
    const err = buyItem(id, me.id);
    if (err) return sock.emit('error:msg', err);
    const prof = getProfile(me.id); if (prof) sock.emit('profile', prof);
  });
  sock.on('shop:equip', ({ id }) => {
    if (!me || typeof id !== 'string') return;
    const err = equipItem(id, me.id);
    if (err) return sock.emit('error:msg', err);
    const prof = getProfile(me.id); if (prof) sock.emit('profile', prof);
  });

  sock.on('room:leave', () => leave(true));
  sock.on('disconnect', () => leave(false));

  function leave(explicit: boolean) {
    if (!room || !me) return;
    const r = room, who = me;
    if (explicit && r.phase === 'lobby') {
      r.players = r.players.filter((p) => p !== who);
      sock.leave(r.code);
    } else if (who.socketId === sock.id) who.socketId = null; // in game: seat is kept for reconnect, bot plays after a short wait
    // migrate host if the host seat is gone or its owner is offline, so the room can't get stuck
    const host = r.players.find((p) => p.id === r.hostId);
    if (!host || !host.socketId) {
      const h = r.players.find((p) => !p.bot && p.socketId) ?? r.players.find((p) => !p.bot);
      if (h) r.hostId = h.id;
    }
    const humans = r.players.filter((p) => !p.bot);
    if (!humans.length) { clearTimeout(r.timer); clearTimeout(r.gc); rooms.delete(r.code); }
    else if (!humans.some((p) => p.socketId)) { // everyone offline: keep the room 60s for reconnects
      clearTimeout(r.gc);
      r.gc = setTimeout(() => { if (!r.players.some((p) => !p.bot && p.socketId)) { clearTimeout(r.timer); rooms.delete(r.code); } }, 60_000);
    } else broadcast(r);
    room = undefined; me = undefined;
  }
});

const PORT = Number(process.env.PORT) || 3100;
server.listen(PORT, '0.0.0.0', () => console.log(`TENLEN ONLINE on http://localhost:${PORT}`));