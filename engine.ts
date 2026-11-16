// Tien Len Mien Nam engine. Card id 0..51: rank = id>>2 (0=3 ... 12=2), suit = id&3 (0 spade,1 club,2 diamond,3 heart)
import { randomInt } from 'node:crypto';

export type Combo = { type: 'single' | 'pair' | 'triple' | 'quad' | 'straight' | 'pairseq'; len: number; high: number };
export const rank = (c: number) => c >> 2;

export function shuffledDeck(): number[] {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

export function analyze(cards: number[]): Combo | null {
  const n = cards.length;
  if (!n || new Set(cards).size !== n) return null;
  const s = [...cards].sort((a, b) => a - b);
  const r = s.map(rank);
  const high = s[n - 1];
  if (r.every((x) => x === r[0])) {
    const t = (['single', 'pair', 'triple', 'quad'] as const)[n - 1];
    return t ? { type: t, len: n, high } : null;
  }
  if (r[n - 1] === 12) return null; // 2 cannot be in sequences
  if (n >= 3 && r.every((x, i) => i === 0 || x === r[i - 1] + 1)) return { type: 'straight', len: n, high };
  if (n >= 6 && n % 2 === 0) {
    let ok = true;
    for (let i = 0; i < n; i += 2) {
      if (r[i] !== r[i + 1] || (i > 0 && r[i] !== r[i - 2] + 1)) ok = false;
    }
    if (ok) return { type: 'pairseq', len: n / 2, high };
  }
  return null;
}

export function beats(prev: Combo | null, next: Combo): boolean {
  if (!prev) return true;
  if (prev.type === next.type && prev.len === next.len) return next.high > prev.high;
  const two = (c: Combo) => rank(c.high) === 12;
  const quad = next.type === 'quad';
  const ps = next.type === 'pairseq' ? next.len : 0;
  // Real Miền Nam cutting rules ("chặt"):
  if (prev.type === 'single' && two(prev)) return quad || ps >= 3;          // heo lẻ ← tứ quý / 3+ đôi thông
  if ((prev.type === 'pair' || prev.type === 'triple') && two(prev)) return quad || ps >= 4; // đôi/sám 2 ← tứ quý / 4+ đôi thông
  if (prev.type === 'quad') return ps >= 4;                                // tứ quý ← 4+ đôi thông
  if (prev.type === 'pairseq') {
    if (prev.len === 3) return quad || ps >= 4;                            // 3 đôi thông ← tứ quý / 4+ đôi thông
    return ps > prev.len;                                                  // đôi thông dàiกว่า ชัต อันสั้นกว่า
  }
  return false;
}

export type Player = { id: string; name: string; socketId: string | null; hand: number[]; ready: boolean; bot?: boolean; afk?: boolean; missed?: number; avatar?: string; lv?: number; bao?: boolean };
export type Room = {
  code: string; hostId: string; players: Player[]; phase: 'lobby' | 'playing' | 'finished';
  turn: number; last: { cards: number[]; combo: Combo; by: number } | null; passed: Set<number>;
  firstMove: boolean; firstCard: number; winner: number | null; deadline: number; timer?: NodeJS.Timeout; gc?: NodeJS.Timeout;
  recorded?: boolean; toiTrang?: boolean;
  van: number; vanWins: number[]; matchWinner: number | null;
  rules: { bao: boolean; strict2: boolean }; played: Set<number>;
};

// Ăn trắng: dealt hands that win instantly (real Tien Len rules)
function toiTrang(hand: number[]): boolean {
  const cnt = new Map<number, number>(), suit = new Map<number, number>();
  for (const c of hand) {
    cnt.set(rank(c), (cnt.get(rank(c)) ?? 0) + 1);
    suit.set(c & 3, (suit.get(c & 3) ?? 0) + 1);
  }
  if (cnt.get(12) === 4) return true;                                        // tứ quý 2
  if ([...suit.values()].some((n) => n >= 12)) return true;                  // 12 lá đồng chất
  const counts = [...cnt.values()];
  if (counts.filter((n) => n === 3).length >= 4) return true;                // 4 bộ ba
  if (counts.filter((n) => n === 4).length >= 2) return true;                // 2 tứ quý
  if (counts.filter((n) => n >= 2).length >= 6) return true;                 // 6 đôi
  let dragon = true;                                                          // sảnh rồng 3-A
  for (let r = 0; r <= 11; r++) if (!cnt.has(r)) dragon = false;
  if (dragon) return true;
  const prs = [...cnt.entries()].filter(([r, n]) => n >= 2 && r < 12).map(([r]) => r).sort((a, b) => a - b);
  let run = 1, best = 1;                                                      // 5+ đôi thông
  for (let i = 1; i < prs.length; i++) {
    if (prs[i] === prs[i - 1] + 1) { run++; best = Math.max(best, run); } else run = 1;
  }
  return best >= 5;
}

export function startGame(room: Room) {
  const deck = shuffledDeck();
  room.players.forEach((p, i) => { p.hand = deck.slice(i * 13, i * 13 + 13).sort((a, b) => a - b); p.bao = false; });
  room.played = new Set();
  room.last = null; room.passed = new Set(); room.firstMove = true; room.winner = null;
  const ti = room.players.findIndex((p) => toiTrang(p.hand));
  if (ti >= 0) { room.winner = ti; room.phase = 'finished'; room.toiTrang = true; return; }
  room.toiTrang = false;
  room.firstCard = Math.min(...room.players.map((p) => p.hand[0])); // lowest dealt card starts (3 of spades when 4 play)
  room.turn = room.players.findIndex((p) => p.hand.includes(room.firstCard));
  room.phase = 'playing';
}

function advance(room: Room) {
  const n = room.players.length;
  let t = room.turn;
  do { t = (t + 1) % n; } while (room.passed.has(t));
  if (room.last && t === room.last.by) { room.last = null; room.passed.clear(); }
  room.turn = t;
}

export function play(room: Room, seat: number, cards: number[]): string | null {
  if (room.phase !== 'playing') return 'not_playing';
  if (room.turn !== seat) return 'not_your_turn';
  const p = room.players[seat];
  if (!cards.every((c) => Number.isInteger(c) && p.hand.includes(c))) return 'cards_not_in_hand';
  const combo = analyze(cards);
  if (!combo) return 'invalid_combo';
  if (room.firstMove && !cards.includes(room.firstCard)) return 'must_include_first_card';
  if (!beats(room.last?.combo ?? null, combo)) return 'cannot_beat';
  p.hand = p.hand.filter((c) => !cards.includes(c));
  room.last = { cards: [...cards].sort((a, b) => a - b), combo, by: seat };
  room.firstMove = false;
  room.played.add(seat);
  if (!p.hand.length) { room.winner = seat; room.phase = 'finished'; return null; }
  advance(room);
  return null;
}

export function pass(room: Room, seat: number): string | null {
  if (room.phase !== 'playing') return 'not_playing';
  if (room.turn !== seat) return 'not_your_turn';
  if (!room.last) return 'must_lead';
  room.passed.add(seat);
  advance(room);
  return null;
}


// ---------- Bot ----------
function combos(a: number[], k: number): number[][] {
  if (k === 0) return [[]];
  if (a.length < k) return [];
  const [h, ...rest] = a;
  return [...combos(rest, k - 1).map((c) => [h, ...c]), ...combos(rest, k)];
}

export function candidates(hand: number[]): number[][] {
  const out: number[][] = [];
  const by = new Map<number, number[]>();
  for (const c of [...hand].sort((a, b) => a - b)) by.set(rank(c), [...(by.get(rank(c)) ?? []), c]);
  for (const cs of by.values()) for (let k = 1; k <= cs.length; k++) out.push(...combos(cs, k));
  for (const need of [1, 2]) {
    const rs = [...by.keys()].filter((r) => r < 12 && by.get(r)!.length >= need).sort((a, b) => a - b);
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 2; j < rs.length && rs[j] - rs[i] === j - i; j++)
        out.push(rs.slice(i, j + 1).flatMap((r) => by.get(r)!.slice(0, need)));
  }
  return out;
}

/** Returns the cards the bot plays, or null to pass. */
export function botMove(room: Room, seat: number): number[] | null {
  const hand = room.players[seat].hand;
  const last = room.last?.combo ?? null;
  let opts = candidates(hand).map((cards) => ({ cards, combo: analyze(cards)! })).filter((o) => o.combo && beats(last, o.combo));
  if (room.firstMove) opts = opts.filter((o) => o.cards.includes(room.firstCard));
  if (!opts.length) return null;
  if (!last) { // leading: dump the biggest group that contains the lowest card
    const low = Math.min(...hand);
    const w = opts.filter((o) => o.cards.includes(low));
    const pool = w.length ? w : opts;
    pool.sort((a, b) => b.cards.length - a.cards.length || a.combo.high - b.combo.high);
    return pool[0].cards;
  }
  const same = opts.filter((o) => o.combo.type === last.type && o.combo.len === last.len);
  const pool = same.length ? same : opts; // otherwise chop
  pool.sort((a, b) => a.combo.high - b.combo.high);
  return pool[0].cards;
}