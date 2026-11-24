/**
 * Long options for Skynet rulesets (levers.longs): buy weekly calls and puts, alone ("only") or beside the wheel ("add").
 *
 * Monday at the close, each side (calls, puts) ranks the names on features from bars through Friday's close (no
 * look-ahead), takes the top `maxNames` that pass its filters and have a real market, and buys the contract expiring
 * that Friday at the chosen strike, at mid + the ruleset's fill share of the spread. Each position gets `budget` ÷
 * maxNames of the account value in premium. Wednesday, a position can be sold at mid − the fill share of the spread
 * (take profit, stop, or always). Friday it settles at its intrinsic value from the close (cash, no shares). A per-contract
 * fee is paid on each buy and sell, and on a settlement worth something.
 *
 * The positions live in the race state under `longs` (outside `options`, which the race reads as short options). They
 * are always gone by Friday's close, so the week's account value is right; in between, the account value the wheel
 * reads on Monday after the buys and on Wednesday leaves them out (small: the week's premium). Pure functions only.
 */
import { accountValue, r2, spreadOf, type Action, type RaceState, type Trade } from "../src/lib/race";
import { midOf, type Bar, type OptionQuote } from "../src/lib/rules";
import type { CandidateRow } from "../src/lib/prep";
import { holdFeatures } from "./hold";
import { realMarket, stage, techAt } from "./logic";
import type { Rules, Ruleset } from "./rulesets";

export interface LongSide {
  /** most positions a week */
  maxNames: number;
  /** premium spent on this side each Monday, a share of the account value (0.05 = 5%) */
  budget: number;
  /** "atm" (default): the strike nearest the price; "otm" / "itm": nearest |delta| 0.3 / 0.7 on that side; a number: nearest that |delta| */
  strike?: "atm" | "otm" | "itm" | number;
  /** a name qualifies only when each feature is within [min, max] (null = no bound; a missing feature fails) */
  filters?: Record<string, [number | null, number | null]>;
  /** best first (a feature; "-x" = lowest first). A list averages the ranks. Default "rand" */
  rank?: string | string[];
  /** "big" (default): every name passing the size test with weeklies; "report": the Sunday report's eligible names; "stocks" / "funds" */
  universe?: "big" | "report" | "stocks" | "funds";
  /** the ruleset's market gate: "on" buys only while risk-on, "off" only while risk-off (default: always) */
  regime?: "on" | "off";
  /** only contracts whose spread is at most this share of the mid (default: the report's real-market test only) */
  maxSpread?: number;
  /** only contracts costing at least this per share (default 0.05) */
  minPrice?: number;
  /** a fixed list of names instead of `universe` (still needs weeklies and the size test) */
  symbols?: string[];
  /** at most this share of the contract's open interest in one position (a liquidity limit for a big account; default none) */
  maxOiShare?: number;
}

export interface LongLevers {
  /** "only": long options alone. "add": beside the wheel, sharing the account */
  mode: "only" | "add";
  calls?: LongSide;
  puts?: LongSide;
  /** Wednesday: sell a position worth at least (1 + takeProfit) × its cost */
  takeProfit?: number;
  /** Wednesday: sell a position worth at most (1 − stopLoss) × its cost */
  stopLoss?: number;
  /** Wednesday: sell every position (no Friday hold) */
  wedExit?: boolean;
  /** leave out leveraged and inverse ETFs (default true) */
  noLeveraged?: boolean;
}

export interface LongPos {
  id: string;
  symbol: string;
  type: "call" | "put";
  strike: number;
  expiry: string;
  contracts: number;
  /** per share, the fill */
  cost: number;
  opened: string;
}

export type LongState = RaceState & { longs?: LongPos[] };

export const longsOf = (rs: Ruleset) => rs.levers?.longs;

/** A quote, or one built by put-call parity from the other side when the stored chain dropped this strike. */
export type BookFn = (sym: string, type: "call" | "put") => OptionQuote[];

export interface LongMondayInput {
  /** features by symbol (longFeatures), for the names that may be traded */
  feats: Record<string, Record<string, number | null>>;
  /** names passing the size test with weeklies */
  big: string[];
  funds: string[];
  /** the Friday this week's options expire (the week's last day) */
  expiry: string;
  books: BookFn;
  spots: Record<string, number>;
  riskOn: boolean;
}

export interface LongMidInput {
  books: BookFn;
  spots: Record<string, number>;
}

interface Ledger {
  id(prefix: string): string;
  add(action: Action, t: Partial<Omit<Trade, "id" | "date" | "week" | "action" | "rules_version">>): Trade;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number, d = 0) => `${(n * 100).toFixed(d)}%`;

/** a placebo in [0, 1) from a string: no market information */
function hash01(s: string) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1e6) / 1e6;
}

/**
 * Features for one name as of Friday's close: the Sunday report's indicators (techAt: ret1w, ret4w, ret13w, vs50,
 * vs200, pctB, rsi, offHigh, rv20, atrPct), relative strength (rs4, rs13: return minus SPY's), the hold book's (mom12,
 * mom6, smooth, vol), the 30-day IV and its rank, ivrv (IV ÷ rv20), term (front-week ATM IV ÷ the next expiry's), the
 * report's score (null if not a candidate), the stage as a number (stageN: Leader 3, pulling back 2, Turning up 1, Breaking down −1, Downtrend −2), the market
 * (spyVs200, spyRet4w, vix) and placebos (rand: new every week; fixed: one per name).
 */
export function longFeatures(R: Rules, sym: string, bars: Bar[], spy: Bar[] | undefined, date: string, m: { iv: number | null; ivRank: number | null; termRatio?: number | null }, cand: CandidateRow | undefined, vix: number | null): Record<string, number | null> | null {
  const t = techAt(R, bars);
  if (!t || bars.length < 60) return null;
  const st = spy ? techAt(R, spy) : null;
  const hf = holdFeatures(sym, bars, spy, date);
  const rs4 = t.ret4w !== null && st?.ret4w != null ? t.ret4w - st.ret4w : null;
  const rs13 = t.ret13w !== null && st?.ret13w != null ? t.ret13w - st.ret13w : null;
  const sg = stage(R, rs4, rs13, t);
  const stageN = ({ Leader: 3, "Leader pulling back": 2, "Turning up": 1, Unknown: 0, "Breaking down": -1, Downtrend: -2 } as Record<string, number>)[sg] ?? 0;
  return {
    ret1w: t.ret1w,
    ret4w: t.ret4w,
    ret13w: t.ret13w,
    vs50: t.vs50,
    vs200: t.vs200,
    pctB: t.pctB,
    rsi: t.rsi14,
    offHigh: t.offHigh,
    rv20: t.realizedVol,
    atrPct: t.atr !== null ? t.atr / t.last : null,
    rs4,
    rs13,
    mom12: hf.mom12,
    mom6: hf.mom6,
    smooth: hf.smooth,
    vol: hf.vol,
    iv: m.iv,
    ivRank: m.ivRank,
    ivrv: m.iv && t.realizedVol ? m.iv / t.realizedVol : null,
    term: m.termRatio ?? null,
    score: cand?.eligible ? cand.score : null,
    stageN,
    spyVs200: st?.vs200 ?? null,
    spyRet4w: st?.ret4w ?? null,
    vix,
    rand: hash01(`${sym}|${date}`),
    fixed: hash01(sym),
  };
}

/** Put-call parity for a strike the stored chain dropped (deep in the money): C = P + S − K, P = C + K − S. */
export function quoteOrParity(calls: OptionQuote[], puts: OptionQuote[], type: "call" | "put", strike: number, spot: number | undefined): OptionQuote | null {
  const q = (type === "call" ? calls : puts).find((x) => x.strike === strike);
  if (q?.bid && q.ask) return q;
  const o = (type === "call" ? puts : calls).find((x) => x.strike === strike);
  if (!o || o.bid === null || o.ask === null || o.ask <= 0 || spot === undefined) return q ?? null;
  const k = type === "call" ? spot - strike : strike - spot;
  if (k <= 0) return q ?? null;
  return { ...o, bid: o.bid + k, ask: o.ask + k, delta: o.delta === null ? null : o.delta + (type === "call" ? 1 : -1) };
}

function pickContract(book: OptionQuote[], type: "call" | "put", spot: number, how: LongSide["strike"], ok: (q: OptionQuote) => boolean) {
  const live = book.filter(ok);
  if (!live.length) return null;
  if (how === undefined || how === "atm") return live.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a));
  const want = how === "otm" ? 0.3 : how === "itm" ? 0.7 : how;
  const side = live.filter((q) => q.delta !== null && (want < 0.5 ? (type === "call" ? q.strike > spot : q.strike < spot) : type === "call" ? q.strike <= spot : q.strike >= spot));
  if (!side.length) return null;
  return side.reduce((a, b) => (Math.abs(Math.abs(b.delta!) - want) < Math.abs(Math.abs(a.delta!) - want) ? b : a));
}

function rankNames(S: LongSide, inp: LongMondayInput, leveraged: Set<string>, noLev: boolean): string[] {
  const funds = new Set(inp.funds);
  const u = S.universe ?? "big";
  const keys = (Array.isArray(S.rank) ? S.rank : [S.rank ?? "rand"]).map((k) => ({ k: k.replace(/^-/, ""), low: k.startsWith("-") }));
  const pool = inp.big.filter((sym) => {
    const f = inp.feats[sym];
    if (!f || inp.spots[sym] === undefined) return false;
    if (noLev && leveraged.has(sym)) return false;
    if (u === "stocks" && funds.has(sym)) return false;
    if (u === "funds" && !funds.has(sym)) return false;
    if (u === "report" && f.score === null) return false;
    if (S.symbols && !S.symbols.includes(sym)) return false;
    if (keys.some(({ k }) => f[k] === null || f[k] === undefined)) return false;
    return !S.filters || Object.entries(S.filters).every(([k, [lo, hi]]) => typeof f[k] === "number" && (lo === null || f[k]! >= lo) && (hi === null || f[k]! <= hi));
  });
  const val = (sym: string, k: string) => inp.feats[sym][k]!;
  if (keys.length === 1) {
    const { k, low } = keys[0];
    return pool.sort((a, b) => (low ? val(a, k) - val(b, k) : val(b, k) - val(a, k)));
  }
  const avg = new Map<string, number>();
  for (const { k, low } of keys) [...pool].sort((a, b) => (low ? val(a, k) - val(b, k) : val(b, k) - val(a, k))).forEach((s, i) => avg.set(s, (avg.get(s) ?? 0) + i / keys.length));
  return pool.sort((a, b) => avg.get(a)! - avg.get(b)!);
}

/** Monday's buys, at the close (after the wheel's puts in "add" mode). */
export function longsBuy(rs: Ruleset, fees: number, s0: RaceState, L: Ledger, date: string, inp: LongMondayInput | undefined, leveraged: Set<string>) {
  const B = longsOf(rs);
  if (!B || !inp) return;
  const s = s0 as LongState;
  s.longs ??= [];
  const value = accountValue(s, inp.spots);
  for (const type of ["call", "put"] as const) {
    const S = type === "call" ? B.calls : B.puts;
    if (!S || S.maxNames <= 0 || S.budget <= 0) continue;
    if ((S.regime === "on" && !inp.riskOn) || (S.regime === "off" && inp.riskOn)) continue;
    const each = (S.budget * value) / S.maxNames;
    let n = 0;
    for (const sym of rankNames(S, inp, leveraged, B.noLeveraged ?? true)) {
      if (n >= S.maxNames) break;
      if (s.longs.some((p) => p.symbol === sym && p.type === type)) continue;
      const spot = inp.spots[sym];
      const ok = (x: OptionQuote) => x.expiry === inp.expiry && realMarket(rs.rules, x) && (S.maxSpread === undefined || spreadOf(x) <= S.maxSpread * midOf(x)!);
      const q = pickContract(inp.books(sym, type), type, spot, S.strike, ok);
      if (!q) continue;
      const px = r2(midOf(q)! + rs.ai.fillSpreadShare * spreadOf(q));
      if (px < (S.minPrice ?? 0.05)) continue;
      const contracts = Math.min(Math.floor(each / (px * 100 + fees)), S.maxOiShare !== undefined ? Math.floor(S.maxOiShare * (q.openInterest ?? 0)) : Infinity);
      if (contracts < 1) continue;
      const cash = -(px * 100 + fees) * contracts;
      s.cash += cash;
      const id = L.id("o");
      s.longs.push({ id, symbol: sym, type, strike: q.strike, expiry: q.expiry, contracts, cost: px, opened: date });
      const f = inp.feats[sym];
      L.add("Bought option" as Action, { symbol: sym, type, strike: q.strike, expiration: q.expiry, qty: contracts, price: px, bid: q.bid, ask: q.ask, cash, position_id: id, note: `Long ${type}: #${n + 1} by ${Array.isArray(S.rank) ? S.rank.join(" + ") : (S.rank ?? "rand")}; price ${r2(spot)}, delta ${q.delta?.toFixed(2) ?? "?"}, RSI ${f.rsi?.toFixed(0) ?? "?"}, 4-week ${f.ret4w !== null ? pct(f.ret4w, 1) : "?"}` });
      n++;
    }
  }
}

function sellPos(fees: number, s: LongState, L: Ledger, p: LongPos, px: number, q: OptionQuote | null, why: string) {
  const cash = (px * 100 - fees) * p.contracts;
  s.cash += cash;
  s.longs = s.longs!.filter((x) => x.id !== p.id);
  const pnl = cash + (p.cost * 100 + fees) * p.contracts;
  L.add("Sold option" as Action, { symbol: p.symbol, type: p.type, strike: p.strike, expiration: p.expiry, qty: p.contracts, price: px, bid: q?.bid ?? null, ask: q?.ask ?? null, cash, position_id: p.id, note: `Long ${p.type}: ${why}. ${pnl >= 0 ? "+" : "-"}${usd(Math.abs(pnl))} (${pct(px / p.cost - 1)}) vs the ${p.cost} cost` });
}

/** Wednesday: take profit, stop, or sell all. */
export function longsMid(rs: Ruleset, fees: number, s0: RaceState, L: Ledger, inp: LongMidInput | undefined) {
  const B = longsOf(rs);
  const s = s0 as LongState;
  if (!B || !inp || !s.longs?.length) return;
  if (!B.wedExit && B.takeProfit === undefined && B.stopLoss === undefined) return;
  for (const p of [...s.longs]) {
    const q = quoteOrParity(inp.books(p.symbol, "call"), inp.books(p.symbol, "put"), p.type, p.strike, inp.spots[p.symbol]);
    const mid = q ? midOf(q) : null;
    if (!q || mid === null || !q.bid) continue;
    const px = r2(Math.max(q.bid, mid - rs.ai.fillSpreadShare * spreadOf(q)));
    const r = px / p.cost - 1;
    if (B.wedExit) sellPos(fees, s, L, p, px, q, "Wednesday exit");
    else if (B.takeProfit !== undefined && r >= B.takeProfit) sellPos(fees, s, L, p, px, q, `take profit (${pct(r)} up)`);
    else if (B.stopLoss !== undefined && r <= -B.stopLoss) sellPos(fees, s, L, p, px, q, `stop (${pct(-r)} down)`);
  }
}

/** Friday: what expires settles at its intrinsic value from the close (no close: worth nothing). */
export function longsSettle(fees: number, s0: RaceState, L: Ledger, date: string, closes: Record<string, number>) {
  const s = s0 as LongState;
  if (!s.longs?.length) return;
  for (const p of [...s.longs]) {
    if (p.expiry > date) continue;
    const c = closes[p.symbol];
    const iv = c === undefined ? 0 : Math.max(0, p.type === "call" ? c - p.strike : p.strike - c);
    if (iv > 0) sellPos(fees, s, L, p, r2(iv), null, `expired in the money (close ${r2(c!)})`);
    else {
      s.longs = s.longs.filter((x) => x.id !== p.id);
      L.add("Option expired" as Action, { symbol: p.symbol, type: p.type, strike: p.strike, expiration: p.expiry, qty: p.contracts, price: 0, cash: 0, position_id: p.id, note: `Long ${p.type}: expired worthless${c === undefined ? " (no close)" : ` (close ${r2(c)})`}. -${usd((p.cost * 100 + fees) * p.contracts)}` });
    }
  }
}
