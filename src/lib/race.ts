/**
 * The AI-vs-Kyle paper race engine. Pure functions only (no Next.js, no database, no network), like rules.ts.
 *
 * The AI trades the Sunday report's scored candidates (src/lib/prep.ts) by the ruleset (RULES) and its own playbook
 * (AI), three times a week:
 *   monday     covered calls on assigned shares, then puts on the best candidates up to AI.exposure.monday
 *   wednesday  buy back puts with AI.takeProfit captured or below the floor, stop out shares, redeploy
 *   friday     settle at the official close, stop out shares, mark to the close, score the week, review both sides
 *
 * scripts/race.ts does the I/O; docs/RACE.md is the runbook the routines follow.
 */
import type { CandidateRow } from "./prep";
import type { Chain } from "./reports";
import { AI, RULES_VERSION, daysTo, midOf, realMarket, techAt, type Bar, type OptionQuote } from "./rules";

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface Lot {
  id: string;
  symbol: string;
  theme: string;
  shares: number;
  cost: number; // per share: the put strike it was assigned at
  mark: number;
  opened: string;
  downtrendWeeks?: number; // Sundays in a row the report called it a Downtrend
}

export interface ShortOption {
  id: string;
  type: "put" | "call";
  symbol: string;
  theme: string;
  strike: number;
  expiration: string;
  contracts: number;
  price: number; // per share, the fill
  opened: string;
  week: number;
  setup?: string;
}

export interface RaceState {
  capital: number;
  start: string;
  cash: number;
  lots: Lot[];
  options: ShortOption[];
  seq: number;
  week: number;
  lastValue: number; // the paper account at the last Friday
  peak: number;
  maxDrawdown: number;
  opp: { index: number; peak: number; maxDrawdown: number; lastValue: number | null };
  current: { week: number; opened: string; expiry: string; valueAtOpen: number } | null;
  lastRun: { kind: RunKind; at: string; week: number } | null;
}

export type RunKind = "monday" | "wednesday" | "friday";

export type Action = "Sold put" | "Sold call" | "Bought back" | "Expired" | "Assigned" | "Called away" | "Sold shares" | "Skipped";

export interface Trade {
  id: string;
  date: string;
  week: number;
  action: Action;
  symbol: string | null;
  type: "put" | "call" | "shares" | null;
  strike: number | null;
  expiration: string | null;
  qty: number | null;
  price: number | null;
  bid: number | null;
  ask: number | null;
  cash: number | null;
  note: string;
  position_id: string | null;
  rules_version: string;
}

export interface WeekRow {
  week: number;
  date: string;
  label: string;
  ai_value: number;
  ai_return: number;
  ai_week_return: number | null;
  ai_drawdown: number;
  ai_max_drawdown: number;
  opp_value: number | null;
  opp_return: number | null;
  opp_week_return: number | null;
  opp_drawdown: number | null;
  opp_max_drawdown: number | null;
  opp_flows: number;
  premium: number;
  exposure: number;
  leverage: number;
  counts: Record<string, number>;
  note: string;
  rules_version: string;
}

export function newState(capital: number, start: string, oppValue: number | null): RaceState {
  return {
    capital,
    start,
    cash: capital,
    lots: [],
    options: [],
    seq: 0,
    week: 0,
    lastValue: capital,
    peak: capital,
    maxDrawdown: 0,
    opp: { index: 1, peak: 1, maxDrawdown: 0, lastValue: oppValue },
    current: null,
    lastRun: null,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Quotes by symbol. A symbol listed with an empty array has no weekly that Friday; an absent symbol wasn't quoted. */
export type QuoteBook = Record<string, OptionQuote[]>;

export const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number, d = 2) => `${(n * 100).toFixed(d)}%`;

export const spreadOf = (q: OptionQuote) => (q.ask ?? 0) - (q.bid ?? 0);
export const sellFill = (q: OptionQuote) => r2(midOf(q)! - AI.fillSpreadShare * spreadOf(q));
export const buyFill = (q: OptionQuote) => r2(midOf(q)! + AI.fillSpreadShare * spreadOf(q));

/** Premium for the week as a share of the strike (weeks to expiry rounded up). */
function weekly(q: OptionQuote, from: string) {
  const mid = midOf(q);
  return mid === null || !q.strike ? null : mid / q.strike / Math.max(1, Math.ceil(daysTo(from, q.expiry) / 7));
}

/** Market value of everything held: cash + shares at `spots` (else their mark) − what it would cost to close the options. */
export function accountValue(s: RaceState, spots: Record<string, number> = {}, optionMarks: Record<string, number> = {}) {
  const shares = s.lots.reduce((a, l) => a + l.shares * (spots[l.symbol] ?? l.mark), 0);
  const opts = s.options.reduce((a, o) => a + (optionMarks[o.id] ?? o.price) * 100 * o.contracts, 0);
  return s.cash + shares - opts;
}

/** Assigned exposure: shares at market plus every short put's strike × 100. */
export function exposure(s: RaceState, spots: Record<string, number> = {}) {
  return (
    s.lots.reduce((a, l) => a + l.shares * (spots[l.symbol] ?? l.mark), 0) +
    s.options.filter((o) => o.type === "put").reduce((a, o) => a + o.strike * 100 * o.contracts, 0)
  );
}

const nameExposure = (s: RaceState, sym: string, spots: Record<string, number>) =>
  s.lots.filter((l) => l.symbol === sym).reduce((a, l) => a + l.shares * (spots[sym] ?? l.mark), 0) +
  s.options.filter((o) => o.type === "put" && o.symbol === sym).reduce((a, o) => a + o.strike * 100 * o.contracts, 0);

const themeExposure = (s: RaceState, theme: string, spots: Record<string, number>) =>
  s.lots.filter((l) => l.theme === theme).reduce((a, l) => a + l.shares * (spots[l.symbol] ?? l.mark), 0) +
  s.options.filter((o) => o.type === "put" && o.theme === theme).reduce((a, o) => a + o.strike * 100 * o.contracts, 0);

class Ledger {
  trades: Trade[] = [];
  constructor(
    private s: RaceState,
    private date: string,
  ) {}
  id(prefix: string) {
    this.s.seq += 1;
    return prefix + String(this.s.seq).padStart(4, "0");
  }
  add(action: Action, t: Partial<Omit<Trade, "id" | "date" | "week" | "action" | "rules_version">>) {
    const row: Trade = {
      id: this.id("t"),
      date: this.date,
      week: this.s.week,
      action,
      symbol: t.symbol ?? null,
      type: t.type ?? null,
      strike: t.strike ?? null,
      expiration: t.expiration ?? null,
      qty: t.qty ?? null,
      price: t.price ?? null,
      bid: t.bid ?? null,
      ask: t.ask ?? null,
      cash: t.cash === undefined || t.cash === null ? null : r2(t.cash),
      note: t.note ?? "",
      position_id: t.position_id ?? null,
      rules_version: RULES_VERSION,
    };
    this.trades.push(row);
    return row;
  }
}

export class Refused extends Error {}

function guard(s: RaceState, kind: RunKind, date: string) {
  if (s.lastRun && s.lastRun.kind === kind && s.lastRun.at.slice(0, 10) === date) throw new Refused(`the ${kind} run already ran on ${date}`);
  if (kind === "monday" && s.current) throw new Refused(`week ${s.current.week} (opened ${s.current.opened}) isn't settled yet; run friday first`);
  if (kind === "wednesday" && !s.current) throw new Refused("no week is open: the Monday entry hasn't run this week");
}

/** True while a lot is too fresh for the stop: assigned fewer than `graceDays` calendar days before `date`. */
export function inStopGrace(opened: string, date: string, graceDays: number) {
  return (Date.parse(`${date}T21:00:00Z`) - Date.parse(`${opened}T21:00:00Z`)) / 864e5 < graceDays;
}

/** The floor the stop uses: the lowest low of the 20 sessions before the last bar. */
function stopFloor(bars: Bar[] | undefined) {
  if (!bars || bars.length < 22) return null;
  return techAt(bars, bars.length - 1)?.floor ?? null;
}

// ---------------------------------------------------------------------------
// picks: the Sunday report's candidates, the AI's strike
// ---------------------------------------------------------------------------

/** Eligible candidates, best score first (the report's order). */
export function rankedCandidates(cands: CandidateRow[]) {
  return cands.filter((c) => c.eligible && c.score !== null && c.target_strike !== null).sort((a, b) => b.score! - a.score!);
}

/** The AI's target strike: the report's target, or 0.8 of an expected move for a top-scored name in a Leading group. */
export function aiTarget(c: CandidateRow) {
  const base = c.target_strike!;
  if (c.exp_move === null || (c.score ?? 0) < AI.strike.aggressiveMinScore || c.group_quadrant !== "Leading") return base;
  const near = c.last - AI.strike.aggressiveMoves * c.exp_move;
  return c.floor !== null && near <= c.floor ? base : Math.max(base, near);
}

export interface QuotePlan {
  expiry: string;
  account_value: number;
  puts: { symbol: string; theme: string; max_strike: number; min_strike: number; strikes?: number[] }[];
  calls: { symbol: string; min_strike: number }[];
  bars: string[]; // symbols to fetch daily bars for
  too_big: string[];
}

/** What to quote for a Monday or Wednesday run. Budget-aware, so it doesn't quote 60 names to fill 8 slots. */
export function quotePlan(s: RaceState, kind: "monday" | "wednesday", cands: CandidateRow[], expiry: string, spots: Record<string, number>): QuotePlan {
  const v = accountValue(s, spots);
  const plan: QuotePlan = { expiry, account_value: r2(v), puts: [], calls: [], bars: [], too_big: [] };
  if (kind === "wednesday") {
    // the open puts, re-quoted at their own strike, and their names' bars for the floor check
    for (const o of s.options.filter((x) => x.type === "put")) plan.puts.push({ symbol: o.symbol, theme: o.theme, max_strike: o.strike, min_strike: o.strike, strikes: [o.strike] });
    plan.bars = [...new Set([...s.options.map((o) => o.symbol), ...s.lots.map((l) => l.symbol)])];
  }
  if (kind === "monday" && AI.coveredCall.use) {
    for (const l of s.lots) {
      const c = cands.find((x) => x.symbol === l.symbol);
      const px = spots[l.symbol] ?? l.mark;
      const move = c?.exp_move ?? px * 0.03;
      plan.calls.push({ symbol: l.symbol, min_strike: r2(Math.max(l.cost, px + AI.coveredCall.moves * move)) });
    }
  }
  const target = (kind === "monday" ? AI.exposure.monday : AI.exposure.wednesday) * v;
  let room = target - exposure(s, spots);
  const held = new Set(s.options.filter((o) => o.type === "put").map((o) => o.symbol));
  for (const c of rankedCandidates(cands)) {
    if (room <= 0 || plan.puts.length >= 16) break;
    if (held.has(c.symbol)) continue;
    const k = aiTarget(c);
    if (k * 100 > AI.oneContract * v) {
      plan.too_big.push(c.symbol);
      continue;
    }
    plan.puts.push({ symbol: c.symbol, theme: c.theme, max_strike: r2(k), min_strike: r2(Math.min(k, c.last) * 0.85) });
    room -= Math.min(AI.perTicker * v, k * 100 * Math.max(1, Math.floor((AI.perTicker * v) / (k * 100))));
  }
  return plan;
}

// ---------------------------------------------------------------------------
// selling puts and calls
// ---------------------------------------------------------------------------

function sellPuts(s: RaceState, L: Ledger, cands: CandidateRow[], quotes: QuoteBook, spots: Record<string, number>, date: string, expiry: string, exposureTarget: number) {
  const v = accountValue(s, spots);
  const held = new Set(s.options.filter((o) => o.type === "put").map((o) => o.symbol));
  for (const [i, c] of rankedCandidates(cands).entries()) {
    const tag = `#${i + 1} ${c.stage.toLowerCase()}, score ${c.score}`;
    if (held.has(c.symbol)) continue;
    const book = quotes[c.symbol];
    if (book === undefined) continue; // not quoted: past the budget
    const base = { symbol: c.symbol, type: "put" as const, expiration: expiry };
    if (!book.length) {
      L.add("Skipped", { ...base, note: `${tag}: no weekly expiring ${expiry}` });
      continue;
    }
    const target = aiTarget(c);
    const ok = book
      .filter((q) => q.expiry <= expiry && q.strike <= target + 1e-9 && realMarket(q) && (weekly(q, date) ?? 0) >= AI.minWeekly)
      .sort((a, b) => b.strike - a.strike);
    const q = ok[0];
    if (!q) {
      L.add("Skipped", { ...base, strike: r2(target), note: `${tag}: no strike at or under ${r2(target)} with a real market paying ${pct(AI.minWeekly)}+ for the week` });
      continue;
    }
    const k = q.strike;
    const per = k * 100;
    const tickerRoom = AI.perTicker * v - nameExposure(s, c.symbol, spots);
    const themeRoom = AI.perTheme * v - themeExposure(s, c.theme, spots);
    const totalRoom = Math.min(exposureTarget, AI.exposure.ceiling) * v - exposure(s, spots);
    let n = Math.floor(Math.min(tickerRoom, themeRoom, totalRoom) / per + 1e-9);
    // one contract may stretch an untouched ticker to AI.oneContract, if the theme and total still have room
    if (n < 1 && nameExposure(s, c.symbol, spots) === 0 && per <= AI.oneContract * v && per <= themeRoom && per <= totalRoom) n = 1;
    if (n < 1) {
      const why = totalRoom < per ? `the ${exposureTarget.toFixed(1)}x exposure target is reached` : themeRoom < per ? `${c.theme} is at ${pct(AI.perTheme, 0)} of the account` : `one contract (${usd(per)}) is over ${pct(AI.oneContract, 0)} of the account`;
      L.add("Skipped", { ...base, strike: k, bid: q.bid, ask: q.ask, note: `${tag}: ${why}` });
      if (totalRoom < per) break;
      continue;
    }
    const px = sellFill(q);
    const id = L.id("o");
    s.options.push({ id, type: "put", symbol: c.symbol, theme: c.theme, strike: k, expiration: q.expiry, contracts: n, price: px, opened: date, week: s.week, setup: c.put_call });
    s.cash += px * 100 * n;
    held.add(c.symbol);
    L.add("Sold put", {
      ...base,
      expiration: q.expiry,
      strike: k,
      qty: n,
      price: px,
      bid: q.bid,
      ask: q.ask,
      cash: px * 100 * n,
      position_id: id,
      note: `${tag}; ${pct(weekly(q, date)!)} for the week, ${pct(1 - k / c.last, 1)} below the price${q.delta !== null ? `, ${Math.abs(q.delta).toFixed(2)} delta` : ""}`,
    });
  }
}

function sellCalls(s: RaceState, L: Ledger, quotes: QuoteBook, minStrike: Record<string, number>, date: string, expiry: string) {
  for (const l of s.lots) {
    const n = Math.floor(l.shares / 100);
    if (n < 1 || s.options.some((o) => o.type === "call" && o.symbol === l.symbol)) continue;
    const book = quotes[l.symbol];
    if (book === undefined) continue;
    const floor = minStrike[l.symbol] ?? l.cost;
    const ok = book.filter((q) => q.expiry <= expiry && q.strike >= floor - 1e-9 && realMarket(q) && (weekly(q, date) ?? 0) >= AI.coveredCall.minWeekly).sort((a, b) => a.strike - b.strike);
    const q = ok[0];
    if (!q) {
      L.add("Skipped", { symbol: l.symbol, type: "call", qty: n, expiration: expiry, note: `No call at or above ${r2(floor)} with a real market paying ${pct(AI.coveredCall.minWeekly)}+; holding the shares with the stop` });
      continue;
    }
    const px = sellFill(q);
    const id = L.id("o");
    s.options.push({ id, type: "call", symbol: l.symbol, theme: l.theme, strike: q.strike, expiration: q.expiry, contracts: n, price: px, opened: date, week: s.week, setup: "Covered call" });
    s.cash += px * 100 * n;
    L.add("Sold call", { symbol: l.symbol, type: "call", strike: q.strike, expiration: q.expiry, qty: n, price: px, bid: q.bid, ask: q.ask, cash: px * 100 * n, position_id: id, note: `Covered call at or above cost ${r2(l.cost)} and one expected move` });
  }
}

/** Sell a lot at `price` (a stop or the two-Sunday downtrend rule). A covered call on it is bought back first. */
function sellLot(s: RaceState, L: Ledger, l: Lot, price: number, why: string, callQuotes?: QuoteBook) {
  for (const o of s.options.filter((x) => x.type === "call" && x.symbol === l.symbol)) {
    const q = callQuotes?.[o.symbol]?.find((x) => x.strike === o.strike);
    const px = q && midOf(q) !== null ? buyFill(q) : Math.max(0.01, price - o.strike + 0.05);
    s.cash -= px * 100 * o.contracts;
    s.options = s.options.filter((x) => x.id !== o.id);
    L.add("Bought back", { symbol: o.symbol, type: "call", strike: o.strike, expiration: o.expiration, qty: o.contracts, price: r2(px), cash: -px * 100 * o.contracts, position_id: o.id, note: "Closed the covered call to sell the shares" });
  }
  s.cash += price * l.shares;
  s.lots = s.lots.filter((x) => x.id !== l.id);
  const pnl = (price - l.cost) * l.shares;
  L.add("Sold shares", { symbol: l.symbol, type: "shares", qty: l.shares, price: r2(price), cash: price * l.shares, position_id: l.id, note: `${why}. ${pnl >= 0 ? "+" : "-"}${usd(Math.abs(pnl))} vs the ${r2(l.cost)} cost` });
}

// ---------------------------------------------------------------------------
// the three runs
// ---------------------------------------------------------------------------

export interface RunResult {
  state: RaceState;
  trades: Trade[];
  week?: WeekRow;
  report: string[];
}

export interface MondayInput {
  date: string;
  expiry: string;
  candidates: CandidateRow[];
  quotes: { puts: QuoteBook; calls: QuoteBook };
  spots: Record<string, number>; // live prices for every lot
}

export function monday(s0: RaceState, inp: MondayInput): RunResult {
  const s: RaceState = structuredClone(s0);
  guard(s, "monday", inp.date);
  s.week += 1;
  const L = new Ledger(s, inp.date);
  for (const l of s.lots) if (inp.spots[l.symbol] !== undefined) l.mark = inp.spots[l.symbol];

  // shares the Sunday report has called a Downtrend two weeks running get sold (RULES section 7)
  for (const l of [...s.lots]) {
    const c = inp.candidates.find((x) => x.symbol === l.symbol);
    l.downtrendWeeks = c?.stage === "Downtrend" ? (l.downtrendWeeks ?? 0) + 1 : 0;
    if (l.downtrendWeeks >= 2) sellLot(s, L, l, l.mark, "Downtrend two Sundays in a row", inp.quotes.calls);
  }

  const minStrike: Record<string, number> = {};
  for (const l of s.lots) {
    const c = inp.candidates.find((x) => x.symbol === l.symbol);
    minStrike[l.symbol] = Math.max(l.cost, l.mark + AI.coveredCall.moves * (c?.exp_move ?? l.mark * 0.03));
  }
  if (AI.coveredCall.use) sellCalls(s, L, inp.quotes.calls, minStrike, inp.date, inp.expiry);
  const value = accountValue(s, inp.spots);
  sellPuts(s, L, inp.candidates, inp.quotes.puts, inp.spots, inp.date, inp.expiry, AI.exposure.monday);

  s.current = { week: s.week, opened: inp.date, expiry: inp.expiry, valueAtOpen: r2(value) };
  s.lastRun = { kind: "monday", at: inp.date, week: s.week };
  return { state: s, trades: L.trades, report: summary(s, L.trades, inp.spots, `Week ${s.week} entry`) };
}

export interface WednesdayInput {
  date: string;
  candidates: CandidateRow[];
  quotes: { puts: QuoteBook; calls: QuoteBook }; // open puts at their strikes, plus new candidates
  spots: Record<string, number>;
  bars: Record<string, Bar[]>; // daily bars through yesterday's close, for open puts' names and lots
}

export function wednesday(s0: RaceState, inp: WednesdayInput): RunResult {
  const s: RaceState = structuredClone(s0);
  guard(s, "wednesday", inp.date);
  const L = new Ledger(s, inp.date);
  for (const l of s.lots) if (inp.spots[l.symbol] !== undefined) l.mark = inp.spots[l.symbol];

  // 1. profit velocity and the floor: buy back what's done or broken
  for (const o of s.options.filter((x) => x.type === "put")) {
    const q = inp.quotes.puts[o.symbol]?.find((x) => Math.abs(x.strike - o.strike) < 1e-9 && x.expiry === o.expiration);
    const bars = inp.bars[o.symbol];
    const floor = stopFloor(bars);
    const lastClose = bars?.at(-1)?.close ?? null;
    const broke = floor !== null && lastClose !== null && lastClose < floor;
    if (!q || midOf(q) === null) continue;
    const captured = 1 - midOf(q)! / o.price;
    if (captured < AI.takeProfit && !broke) continue;
    const px = buyFill(q);
    s.cash -= px * 100 * o.contracts;
    s.options = s.options.filter((x) => x.id !== o.id);
    const kept = (o.price - px) * 100 * o.contracts;
    L.add("Bought back", {
      symbol: o.symbol,
      type: "put",
      strike: o.strike,
      expiration: o.expiration,
      qty: o.contracts,
      price: px,
      bid: q.bid,
      ask: q.ask,
      cash: -px * 100 * o.contracts,
      position_id: o.id,
      note: broke
        ? `Closed below its floor (${r2(floor!)}); out before Friday, ${kept >= 0 ? "kept" : "lost"} ${usd(Math.abs(kept))}`
        : `${pct(captured, 0)} of the premium captured by Wednesday; kept ${usd(kept)} and freed the collateral`,
    });
  }

  // 2. stops on shares
  if (AI.stopBelowFloor) {
    for (const l of [...s.lots]) {
      if (inStopGrace(l.opened, inp.date, AI.stopGraceDays)) continue;
      const bars = inp.bars[l.symbol];
      const floor = stopFloor(bars);
      const close = bars?.at(-1)?.close;
      if (floor !== null && close !== undefined && close < floor) sellLot(s, L, l, inp.spots[l.symbol] ?? close, `Closed at ${r2(close)}, below its floor of ${r2(floor)}`, inp.quotes.calls);
    }
  }

  // 3. redeploy into this week's candidates
  sellPuts(s, L, inp.candidates, inp.quotes.puts, inp.spots, inp.date, s.current!.expiry, AI.exposure.wednesday);
  s.lastRun = { kind: "wednesday", at: inp.date, week: s.week };
  return { state: s, trades: L.trades, report: summary(s, L.trades, inp.spots, `Week ${s.week} Wednesday`) };
}

export interface FridayInput {
  date: string;
  closes: Record<string, number>; // official close of each expiring option's name (its expiration day) and of each lot
  bars?: Record<string, Bar[]>; // daily bars through today, for the stop on shares
  opp: { value: number; flows: number; pending?: number } | null;
}

export function friday(s0: RaceState, inp: FridayInput): RunResult {
  const s: RaceState = structuredClone(s0);
  guard(s, "friday", inp.date);
  if (!s.current) s.week += 1; // no Monday entry this week (holiday or a missed run): a no-trade week
  const L = new Ledger(s, inp.date);
  const counts: Record<string, number> = { puts_expired: 0, puts_assigned: 0, calls_expired: 0, calls_called: 0 };
  const missing: string[] = [];

  for (const o of [...s.options]) {
    if (o.expiration > inp.date) continue;
    const c = inp.closes[o.symbol];
    if (c === undefined) {
      missing.push(o.symbol);
      continue;
    }
    s.options = s.options.filter((x) => x.id !== o.id);
    const base = { symbol: o.symbol, type: o.type, strike: o.strike, expiration: o.expiration, qty: o.contracts, price: c, position_id: o.id };
    if (o.type === "put") {
      if (c < o.strike) {
        s.cash -= o.strike * 100 * o.contracts;
        const id = L.id("l");
        s.lots.push({ id, symbol: o.symbol, theme: o.theme, shares: 100 * o.contracts, cost: o.strike, mark: c, opened: o.expiration });
        counts.puts_assigned += 1;
        L.add("Assigned", { ...base, cash: -o.strike * 100 * o.contracts, note: `Closed at ${r2(c)}, under the strike: bought ${100 * o.contracts} shares at ${o.strike}` });
      } else {
        counts.puts_expired += 1;
        L.add("Expired", { ...base, cash: 0, note: `Closed at ${r2(c)}: kept the full premium` });
      }
    } else if (c > o.strike) {
      let left = 100 * o.contracts;
      let gain = 0;
      for (const l of s.lots.filter((x) => x.symbol === o.symbol)) {
        const take = Math.min(left, l.shares);
        gain += (o.strike - l.cost) * take;
        l.shares -= take;
        left -= take;
      }
      s.lots = s.lots.filter((l) => l.shares > 0);
      s.cash += o.strike * 100 * o.contracts;
      counts.calls_called += 1;
      L.add("Called away", { ...base, cash: o.strike * 100 * o.contracts, note: `Closed at ${r2(c)}, over the strike: sold ${100 * o.contracts} shares at ${o.strike} (${gain >= 0 ? "+" : "-"}${usd(Math.abs(gain))} vs cost)` });
    } else {
      counts.calls_expired += 1;
      L.add("Expired", { ...base, cash: 0, note: `Closed at ${r2(c)}: kept the shares and the premium` });
    }
  }

  for (const l of s.lots) {
    if (inp.closes[l.symbol] !== undefined) l.mark = inp.closes[l.symbol];
    else if (!missing.includes(l.symbol)) missing.push(l.symbol);
  }
  if (AI.stopBelowFloor && inp.bars) {
    for (const l of [...s.lots]) {
      if (inStopGrace(l.opened, inp.date, AI.stopGraceDays)) continue;
      const floor = stopFloor(inp.bars[l.symbol]);
      const close = inp.closes[l.symbol];
      if (floor !== null && close !== undefined && close < floor) sellLot(s, L, l, close, `Closed at ${r2(close)}, below its floor of ${r2(floor)}`);
    }
  }

  const value = accountValue(s);
  s.peak = Math.max(s.peak, value);
  const dd = value / s.peak - 1;
  s.maxDrawdown = Math.min(s.maxDrawdown, dd);

  let oppWeek: number | null = null;
  const notes: string[] = [];
  if (inp.opp && s.opp.lastValue) {
    oppWeek = (inp.opp.value - inp.opp.flows) / s.opp.lastValue - 1;
    s.opp.index *= 1 + oppWeek;
    s.opp.peak = Math.max(s.opp.peak, s.opp.index);
    s.opp.maxDrawdown = Math.min(s.opp.maxDrawdown, s.opp.index / s.opp.peak - 1);
    s.opp.lastValue = inp.opp.value;
    if (Math.abs(oppWeek) > 0.12 || (inp.opp.pending ?? 0) > 0) notes.push(`Kyle's week moved ${pct(oppWeek, 1)}${inp.opp.pending ? " with a deposit pending" : ""}: check for a deposit or withdrawal.`);
    if (inp.opp.flows) notes.push(`Kyle's return excludes ${usd(inp.opp.flows)} of deposits or withdrawals.`);
  } else notes.push("Kyle's account couldn't be read this week.");
  if (missing.length) notes.push(`No close for ${[...new Set(missing)].join(", ")}; left open.`);

  const wk = s.week;
  const row: WeekRow = {
    week: wk,
    date: inp.date,
    label: `Week ${wk}`,
    ai_value: r2(value),
    ai_return: value / s.capital - 1,
    ai_week_return: s.lastValue ? value / s.lastValue - 1 : null,
    ai_drawdown: dd,
    ai_max_drawdown: s.maxDrawdown,
    opp_value: inp.opp?.value ?? null,
    opp_return: inp.opp ? s.opp.index - 1 : null,
    opp_week_return: oppWeek,
    opp_drawdown: inp.opp ? s.opp.index / s.opp.peak - 1 : null,
    opp_max_drawdown: inp.opp ? s.opp.maxDrawdown : null,
    opp_flows: inp.opp?.flows ?? 0,
    premium: 0,
    exposure: r2(exposure(s)),
    leverage: value ? exposure(s) / value : 0,
    counts,
    note: notes.join(" "),
    rules_version: RULES_VERSION,
  };
  s.lastValue = value;
  s.current = null;
  s.lastRun = { kind: "friday", at: inp.date, week: wk };
  return { state: s, trades: L.trades, week: row, report: summary(s, L.trades, {}, `Week ${wk} settled`) };
}

/** Premium and counts for a week's row from all of that week's trades (Monday, Wednesday and Friday). */
export function finishWeek(row: WeekRow, weekTrades: Trade[]): WeekRow {
  const t = weekTrades.filter((x) => x.week === row.week);
  const premium = t.filter((x) => x.action === "Sold put" || x.action === "Sold call").reduce((a, x) => a + (x.cash ?? 0), 0);
  const buybacks = t.filter((x) => x.action === "Bought back").reduce((a, x) => a + (x.cash ?? 0), 0);
  return {
    ...row,
    premium: r2(premium + buybacks),
    counts: {
      ...row.counts,
      puts_sold: t.filter((x) => x.action === "Sold put").length,
      calls_sold: t.filter((x) => x.action === "Sold call").length,
      bought_back: t.filter((x) => x.action === "Bought back").length,
      shares_sold: t.filter((x) => x.action === "Sold shares").length,
    },
  };
}

function summary(s: RaceState, trades: Trade[], spots: Record<string, number>, title: string) {
  const v = accountValue(s, spots);
  const out = [`${title}: account ${usd(v)}, exposure ${usd(exposure(s, spots))} (${(exposure(s, spots) / v).toFixed(2)}x), cash ${usd(s.cash)}.`];
  for (const t of trades) out.push(`  ${t.action.padEnd(11)} ${(t.symbol ?? "").padEnd(5)} ${t.type ?? ""} ${t.strike ?? ""} x${t.qty ?? ""} @ ${t.price ?? ""}  ${t.note}`);
  return out;
}

// ---------------------------------------------------------------------------
// Friday review: both sides' trades graded the same way
// ---------------------------------------------------------------------------

export interface GradedTrade {
  side: "ai" | "kyle";
  symbol: string;
  type: "put" | "call";
  strike: number;
  expiration: string;
  contracts: number;
  opened: string;
  closed: string;
  outcome: "expired" | "assigned" | "called away" | "bought back" | "rolled";
  premium: number; // credits received, all legs
  net: number; // premium less buybacks
  /** the win/loss score (RULES / CLAUDE.md): net, less how far the stock ended past the strike when assigned */
  score: number;
  result: "win" | "loss";
  /** a buyback before expiry: what holding to expiry would have scored instead, and the difference */
  hold?: { close: number | null; score: number | null; edge: number | null; captured: number };
  rolls: number;
}

export interface ReviewStats {
  trades: number;
  wins: number;
  losses: number;
  score: number;
  early: number;
  early_beat_hold: number;
  early_edge: number; // total of (closed-early score − hold-to-expiry score)
}

export interface Review {
  week: number;
  from: string;
  to: string;
  ai: { trades: GradedTrade[]; stats: ReviewStats };
  kyle: { trades: GradedTrade[]; stats: ReviewStats };
  narrative: ReviewNarrative | null;
}

export interface ReviewNarrative {
  headline: string;
  ai_good: string[];
  ai_bad: string[];
  kyle_good: string[];
  kyle_bad: string[];
  steal_from_kyle: string[];
  steal_from_ai: string[];
  buybacks: string; // what the early closes say about buying back and reselling
  lessons: { side: "ai" | "kyle" | "both"; kind: "keep" | "steal" | "fix" | "rule"; text: string }[];
}

const past = (type: "put" | "call", strike: number, close: number) => Math.max(0, type === "put" ? strike - close : close - strike);

/** Hold-to-expiry score of a short option: premium kept, less how far the stock ended past the strike. */
function holdScore(type: "put" | "call", strike: number, premium: number, contracts: number, close: number | null) {
  return close === null ? null : r2(premium - past(type, strike, close) * 100 * contracts);
}

function stats(ts: GradedTrade[]): ReviewStats {
  const early = ts.filter((t) => t.hold);
  return {
    trades: ts.length,
    wins: ts.filter((t) => t.result === "win").length,
    losses: ts.filter((t) => t.result === "loss").length,
    score: r2(ts.reduce((a, t) => a + t.score, 0)),
    early: early.length,
    early_beat_hold: early.filter((t) => t.hold?.edge !== null && t.hold!.edge! >= 0).length,
    early_edge: r2(early.reduce((a, t) => a + (t.hold?.edge ?? 0), 0)),
  };
}

/**
 * The AI's trades that finished between `from` and `to`, graded. `closes` holds expiry-day closes keyed
 * "SYM@YYYY-MM-DD" for the hindsight check on buybacks (and for assignments).
 */
export function gradeAi(all: Trade[], from: string, to: string, closes: Record<string, number>): GradedTrade[] {
  const opens = new Map(all.filter((t) => (t.action === "Sold put" || t.action === "Sold call") && t.position_id).map((t) => [t.position_id!, t]));
  const out: GradedTrade[] = [];
  for (const t of all) {
    if (!t.position_id || t.date < from || t.date > to) continue;
    if (!["Expired", "Assigned", "Called away", "Bought back"].includes(t.action)) continue;
    const o = opens.get(t.position_id);
    if (!o || o.type === "shares" || !o.strike || !o.qty) continue;
    const type = o.type as "put" | "call";
    const premium = o.cash ?? 0;
    const buyback = t.action === "Bought back" ? -(t.cash ?? 0) : 0;
    const net = r2(premium - buyback);
    const close = t.action === "Bought back" ? (closes[`${o.symbol}@${o.expiration}`] ?? null) : (t.price ?? null);
    const assigned = t.action === "Assigned" || t.action === "Called away";
    const score = assigned && close !== null ? r2(net - past(type, o.strike, close) * 100 * o.qty) : net;
    const g: GradedTrade = {
      side: "ai",
      symbol: o.symbol!,
      type,
      strike: o.strike,
      expiration: o.expiration!,
      contracts: o.qty,
      opened: o.date,
      closed: t.date,
      outcome: t.action === "Bought back" ? "bought back" : t.action === "Assigned" ? "assigned" : t.action === "Called away" ? "called away" : "expired",
      premium: r2(premium),
      net,
      score,
      result: score >= 0 ? "win" : "loss",
      rolls: 0,
    };
    if (t.action === "Bought back") {
      const hold = holdScore(type, o.strike, premium, o.qty, close);
      g.hold = { close, score: hold, edge: hold === null ? null : r2(score - hold), captured: premium ? net / premium : 0 };
    }
    out.push(g);
  }
  return out;
}

/** Kyle's option chains (one account) that finished between `from` and `to`, graded the same way. */
export function gradeKyle(chains: Chain[], accountId: string, from: string, to: string, closes: Record<string, number>): GradedTrade[] {
  const out: GradedTrade[] = [];
  for (const c of chains) {
    if (c.account_id !== accountId || c.outcome === "open" || !c.closed || c.closed < from || c.closed > to) continue;
    const cur = c.current;
    const type = cur.option_type === "call" ? "call" : "put";
    const strike = Number(cur.strike);
    const contracts = Number(cur.quantity);
    const premium = r2(c.legs.reduce((a, l) => a + Number(l.credits), 0));
    const early = c.outcome === "closed" && !!cur.expiration && c.closed < cur.expiration;
    const g: GradedTrade = {
      side: "kyle",
      symbol: c.ticker,
      type,
      strike,
      expiration: cur.expiration ?? c.closed,
      contracts,
      opened: c.opened,
      closed: c.closed,
      outcome: c.outcome === "assigned" ? (type === "call" ? "called away" : "assigned") : c.outcome === "expired" ? "expired" : c.rolls ? "rolled" : "bought back",
      premium,
      net: r2(c.net),
      score: r2(c.score),
      result: c.score >= 0 ? "win" : "loss",
      rolls: c.rolls,
    };
    if (early) {
      // hindsight on the last leg: what holding it to expiry would have scored
      const close = closes[`${c.ticker}@${cur.expiration}`] ?? null;
      const legPremium = Number(cur.credits);
      const legHold = holdScore(type, strike, legPremium - Number(cur.fees), contracts, close);
      const legNet = Number(cur.net_amount);
      g.hold = {
        close,
        score: legHold === null ? null : r2(c.net - legNet + legHold),
        edge: legHold === null ? null : r2(legNet - legHold),
        captured: legPremium ? legNet / legPremium : 0,
      };
    }
    out.push(g);
  }
  return out;
}

/** Names and expiries the review needs a close for (buybacks before expiry, on both sides). */
export function reviewCloseNeeds(all: Trade[], chains: Chain[], accountId: string, from: string, to: string) {
  const need = new Set<string>();
  const opens = new Map(all.filter((t) => t.position_id && (t.action === "Sold put" || t.action === "Sold call")).map((t) => [t.position_id!, t]));
  for (const t of all) {
    if (t.action !== "Bought back" || t.date < from || t.date > to || !t.position_id) continue;
    const o = opens.get(t.position_id);
    if (o?.symbol && o.expiration && o.expiration <= to) need.add(`${o.symbol}@${o.expiration}`);
  }
  for (const c of chains) {
    if (c.account_id !== accountId || c.outcome !== "closed" || !c.closed || c.closed < from || c.closed > to) continue;
    const e = c.current.expiration;
    if (e && c.closed < e && e <= to) need.add(`${c.ticker}@${e}`);
  }
  return [...need].sort();
}

export function buildReview(week: number, from: string, to: string, ai: GradedTrade[], kyle: GradedTrade[], narrative: ReviewNarrative | null): Review {
  return { week, from, to, ai: { trades: ai, stats: stats(ai) }, kyle: { trades: kyle, stats: stats(kyle) }, narrative };
}
