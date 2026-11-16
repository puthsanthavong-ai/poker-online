import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Room } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const db = new DatabaseSync(path.join(__dirname, 'tenlen.db'));

db.exec(`CREATE TABLE IF NOT EXISTS players(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Player',
  avatar TEXT,
  lang TEXT, vol REAL, sound INTEGER DEFAULT 1, sort TEXT,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  best_rank INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS daily(
  player_id TEXT NOT NULL, day TEXT NOT NULL,
  played INTEGER NOT NULL DEFAULT 0, won INTEGER NOT NULL DEFAULT 0,
  m1 INTEGER NOT NULL DEFAULT 0, m2 INTEGER NOT NULL DEFAULT 0, m3 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(player_id, day)
)`);

// migration: add progression columns if missing
for (const col of [
  'xp INTEGER NOT NULL DEFAULT 0', 'coins INTEGER NOT NULL DEFAULT 0',
  'streak INTEGER NOT NULL DEFAULT 0', 'best_streak INTEGER NOT NULL DEFAULT 0',
  'login_streak INTEGER NOT NULL DEFAULT 0', 'last_login TEXT',
  'owned TEXT', 'theme TEXT', 'fx TEXT',
]) { try { db.exec(`ALTER TABLE players ADD COLUMN ${col}`); } catch { /* exists */ } }

export const getProfile = (id: string) =>
  db.prepare('SELECT * FROM players WHERE id=?').get(id) as Record<string, any> | undefined;

export function ensurePlayer(id: string, name: string) {
  db.prepare(`INSERT INTO players(id,name,owned,theme) VALUES(?,?,'["t-green"]','t-green')
    ON CONFLICT(id) DO NOTHING`).run(id, name);
}

export function saveProfile(id: string, fields: Record<string, any>) {
  const cur = getProfile(id);
  if (!cur) return;
  const keys = ['name', 'avatar', 'lang', 'vol', 'sound', 'sort', 'owned', 'theme'];
  const sets = keys.filter((k) => fields[k] !== undefined).map((k) => `${k}=?`);
  if (!sets.length) return;
  db.prepare(`UPDATE players SET ${sets.join(',')} WHERE id=?`)
    .run(...keys.filter((k) => fields[k] !== undefined).map((k) => fields[k]), id);
}

export const getDaily = (id: string) =>
  db.prepare('SELECT * FROM daily WHERE player_id=? AND day=?').get(id, today()) as Record<string, any> | undefined;

export const lvlOf = (xp = 0) => { let l = 1, n = 100, r = xp; while (r >= n) { r -= n; l++; n += 50; } return l; };
export const xpInto = (xp = 0) => { let n = 100, r = xp; while (r >= n) { r -= n; n += 50; } return r; };
export const xpNext = (lvl: number) => 100 + (lvl - 1) * 50;

const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

// Daily login bonus. Returns {coins,notes} or null if already claimed today.
export function loginBonus(id: string) {
  const p = getProfile(id); if (!p) return null;
  if (p.last_login === today()) return null;
  const streak = (p.last_login === yesterday() ? (p.login_streak || 0) : 0) + 1;
  const coins = Math.min(25 * streak, 200);
  db.prepare('UPDATE players SET coins=coins+?, login_streak=?, last_login=? WHERE id=?')
    .run(coins, streak, today(), id);
  return { coins, notes: [`Daily login day ${streak}: +${coins}`] };
}

const STREAK_BONUS: Record<number, number> = { 2: 20, 3: 40, 5: 80, 7: 150, 10: 300 };
const MISSIONS = [
  { col: 'm1', need: (d: any) => d.played >= 3, coins: 30, note: 'Mission: play 3 games' },
  { col: 'm2', need: (d: any) => d.won >= 1, coins: 50, note: 'Mission: win 1 game' },
  { col: 'm3', need: (d: any) => d.won >= 2, coins: 80, note: 'Mission: win 2 games' },
];

// Called once when a game ends. Winner has an empty hand so sort puts them first.
// Returns Map<playerId,{coins,notes}> for bonus toasts.
export function recordResults(room: Room) {
  const gains = new Map<string, { coins: number; notes: string[] }>();
  const gain = (id: string, coins: number, note?: string) => {
    const g = gains.get(id) ?? { coins: 0, notes: [] };
    g.coins += coins; if (note) g.notes.push(note); gains.set(id, g);
  };
  const order = [...room.players].sort((a, b) => a.hand.length - b.hand.length);
  const day = today();
  const mult = [1, 2, 3][(room.van || 1) - 1] || 1; // ván 1/2/3 coin multiplier
  order.forEach((p, i) => {
    if (p.bot) return;
    const rank = i + 1, win = i === 0;
    const xp = 15 + (win ? 40 : rank === 2 ? 15 : 5);
    const coins = Math.round((10 + (win ? 30 : rank === 2 ? 15 : 5)) * mult);
    const streak = win ? ((getProfile(p.id)?.streak || 0) + 1) : 0;
    const sBonus = win ? Math.round((STREAK_BONUS[streak] ?? 0) * mult) : 0;
    db.prepare(`UPDATE players SET games=games+1, wins=wins+?, xp=xp+?, coins=coins+?, streak=?,
      best_streak=MAX(best_streak,?), best_rank=CASE WHEN best_rank IS NULL OR ?<best_rank THEN ? ELSE best_rank END
      WHERE id=?`)
      .run(win ? 1 : 0, xp, coins + sBonus, streak, streak, rank, rank, p.id);
    gain(p.id, coins + sBonus, win ? `Win +${coins}` : `Played +${coins}`);
    if (sBonus) gain(p.id, 0, `Win streak x${streak} bonus!`);

    // daily missions
    db.prepare(`INSERT INTO daily(player_id,day,played,won) VALUES(?,?,?,?)
      ON CONFLICT(player_id,day) DO UPDATE SET played=played+1, won=won+?`)
      .run(p.id, day, 1, win ? 1 : 0, win ? 1 : 0);
    const d = db.prepare('SELECT * FROM daily WHERE player_id=? AND day=?').get(p.id, day) as any;
    for (const m of MISSIONS) {
      if (!d[m.col] && m.need(d)) {
        db.prepare(`UPDATE daily SET ${m.col}=1 WHERE player_id=? AND day=?`).run(p.id, day);
        db.prepare('UPDATE players SET coins=coins+? WHERE id=?').run(m.coins, p.id);
        gain(p.id, m.coins, m.note);
      }
    }
  });

  // Settlement: ăn trắng pays a flat 20 per opponent (no per-card thối);
  // otherwise each human loser pays 5 coins per card left in hand × ván multiplier,
  // doubled when still holding a 2 (rank 12) — ×3 for red 2s in strict mode —
  // and doubled again for "cóng" (never played a card). Pot goes to the winner.
  const winner = order[0];
  if (!winner.bot) {
    const flat = !!room.toiTrang;
    const strict = !!room.rules?.strict2;
    let pot = 0;
    for (const p of order.slice(1)) {
      if (p.bot) continue;
      const has2 = p.hand.some((c) => (c >> 2) === 12);
      const red2 = p.hand.some((c) => (c >> 2) === 12 && (c & 3) >= 2);
      const cong = !room.played?.has(p.id) && p.hand.length > 0;
      const twoMult = strict ? (red2 ? 3 : has2 ? 2 : 1) : has2 ? 2 : 1;
      const pay = Math.round((flat ? 20 : p.hand.length * 5 * twoMult * (cong ? 2 : 1)) * mult);
      if (!pay) continue;
      pot += pay;
      db.prepare('UPDATE players SET coins=MAX(0,coins-?) WHERE id=?').run(pay, p.id);
      gain(p.id, 0, flat ? `Ăn trắng -${pay}` : `เสีย ${pay} coins${cong ? ' (cóng ×2)' : ''}${twoMult > 1 ? ` (มีไพ่ 2 → ×${twoMult})` : ''}`);
    }
    // báo bonus: winner who declared with 1 card left gets extra coins
    if (winner.bao) {
      const bonus = 40 * mult;
      db.prepare('UPDATE players SET coins=coins+? WHERE id=?').run(bonus, winner.id);
      gain(winner.id, bonus, 'Báoสำเร็จ!');
    }
    if (pot > 0) {
      db.prepare('UPDATE players SET coins=coins+? WHERE id=?').run(pot, winner.id);
      gain(winner.id, pot, flat ? `Ăn trắng +${pot}` : `รับค่าปรับรวม +${pot}`);
    }
  }
  return gains;
}

// Shop catalog (server-side validation; client has its own copy with names)
export const ITEMS: Record<string, { kind: string; lv: number; cost: number }> = {
  't-green': { kind: 'theme', lv: 1, cost: 0 },
  't-blue': { kind: 'theme', lv: 2, cost: 150 },
  't-purple': { kind: 'theme', lv: 4, cost: 400 },
  't-red': { kind: 'theme', lv: 6, cost: 800 },
  't-midnight': { kind: 'theme', lv: 8, cost: 1200 },
  'fx-gold': { kind: 'fx', lv: 3, cost: 250 },
  'fx-pink': { kind: 'fx', lv: 5, cost: 400 },
};

export function buyItem(id: string, playerId: string): string | null {
  const item = ITEMS[id];
  const p = getProfile(playerId);
  if (!item || !p) return 'unknown_item';
  const owned = JSON.parse(p.owned || '["t-green"]');
  if (owned.includes(id)) return 'already_owned';
  if (lvlOf(p.xp || 0) < item.lv) return 'need_level';
  if ((p.coins || 0) < item.cost) return 'not_enough_coins';
  owned.push(id);
  db.prepare('UPDATE players SET coins=coins-?, owned=? WHERE id=?').run(item.cost, JSON.stringify(owned), playerId);
  return null;
}

export function equipItem(id: string, playerId: string): string | null {
  const item = ITEMS[id];
  const p = getProfile(playerId);
  if (!item || !p) return 'unknown_item';
  const owned = JSON.parse(p.owned || '["t-green"]');
  if (!owned.includes(id)) return 'not_owned';
  if (item.kind === 'theme') db.prepare('UPDATE players SET theme=? WHERE id=?').run(id, playerId);
  if (item.kind === 'fx') db.prepare('UPDATE players SET fx=? WHERE id=?').run(id, playerId);
  return null;
}
