/**
 * The race engine with the ruleset passed in, for the backtest.
 *
 * Mirrors monday / wednesday / friday in src/lib/race.ts, which read the global RULES and AI. State, trade and week
 * shapes, account value, exposure and the grading are imported from race.ts as they are. With `fees: 0` and the live
 * ruleset this gives the same trades as race.ts (`npm run skynet -- parity` checks it).
 *
 * Differences from the race, on purpose:
 *  - no opponent account: the week row's opp_* columns carry a benchmark (SPY buy and hold) instead
 *  - an optional per-contract fee, charged on every option fill and on assignment or call-away
 *  - an account margin limit on top of the ruleset's exposure targets (the same for every run)
 *  - no run guard by wall clock (the backtest calls the runs in order)
 *
 * Pure functions only.
 */
import type { CandidateRow } from "../src/lib/prep";
import {
  accountValue,
  exposure,
  inStopGrace,
  r2,
  rankedCandidates,
  spreadOf,
  type Action,
  type FridayInput,
  type Lot,
  type MondayInput,
  type RaceState,
  type QuoteBook,
  type RunResult,
  type Trade,
  type WednesdayInput,
  type WeekRow,
} from "../src/lib/race";
import { daysTo, midOf, rel, type Bar, type OptionQuote } from "../src/lib/rules";
import { inNeverSellZone, realMarket, stage, techAt, trendQualifies } from "./logic";
import type { Ruleset } from "./rulesets";
import { HOLD, holdOf, holdStep, type HoldInput } from "./hold";
import { adoptLot, inBuyZone, isSwingLot, swingCallFloor, swingEnter, swingHot, swingOf, swingWalk, type SwingInput } from "./swing";

export interface EngineOptions {
  /** dollars per contract on each option trade and on assignment or call-away (0 = the race) */
  fees: number;
  /**
   * The account's margin limit: new puts never take exposure past this multiple of the account value, whatever the
   * ruleset asks for (Infinity = the race, where the ruleset's own ceiling is the only limit).
   */
  maxLeverage: number;
}

/** Leveraged and inverse ETFs in the universe (for `levers.noLeveraged`). */
export const LEVERAGED = new Set(
  "AGQ BITI BITX BOIL CONL DPST DUST ERX ETHU FAS FAZ JDST JNUG KOLD LABD LABU MSTU MSTX NUGT NVDL NVDX SCO SDOW SDS SOXL SOXS SPXL SPXS SPXU SQQQ SSO SVIX SVXY TECS TMF TMV TNA TQQQ TSLL TSLQ TZA UCO UPRO UVIX UVXY VXX YANG YINN ZSL".split(" "),
);

/** The market as of the last close before a run (Skynet levers read it; the race doesn't). */
export interface Regime {
  /** SPY closes, oldest first, through the last close before the run */
  spy: number[];
  vix: number | null;
  /** that day's closes for the core symbols (SPY, QQQ) */
  px: Record<string, number>;
}

/** The theme of the core holding (levers.core): never covered, never stopped, sold only when risk-off. */
export const CORE = "core";

/** A book lot (the core holding or levers.hold): outside the wheel. No covered calls, no stops, no downtrend sale, and it
 * counts toward the margin cap but not the wheel's exposure targets. */
const isBook = (l: Lot) => l.theme === CORE || l.theme === HOLD;

/** Options off: swing or buy and hold alone. */
const noOptions = (rs: Ruleset) => swingOf(rs)?.mode === "only" || holdOf(rs)?.mode === "only";

/** Share of the exposure target new puts may use: 1, or `riskOffScale` when a regime lever says risk-off. */
export function regimeScale(rs: Ruleset, g?: Regime): number {
  const lv = rs.levers;
  if (!lv || !g) return 1;
  let off = false;
  if (lv.spyMaDays && g.spy.length >= lv.spyMaDays) {
    const ma = g.spy.slice(-lv.spyMaDays).reduce((a, b) => a + b, 0) / lv.spyMaDays;
    if (g.spy.at(-1)! < ma * (1 - (lv.spyMaBand ?? 0))) off = true;
  }
  if (lv.vixMax !== undefined && g.vix !== null && g.vix > lv.vixMax) off = true;
  return off ? (lv.riskOffScale ?? 0) : 1;
}

/** Shares are stopped out: the floor stop (Kindred), or a loss of `levers.shareStop` from cost; never with holdUntilGreen. */
function stopHit(rs: Ruleset, l: Lot, close: number | undefined, floor: number | null) {
  if (close === undefined) return false;
  if (rs.levers?.shareStop !== undefined) return close < l.cost * (1 - rs.levers.shareStop);
  return floor !== null && close < floor * (1 - (rs.levers?.stopBuffer ?? 0));
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number, d = 2) => `${(n * 100).toFixed(d)}%`;

const sellFill = (rs: Ruleset, q: OptionQuote) => r2(midOf(q)! - rs.ai.fillSpreadShare * spreadOf(q));
const buyFill = (rs: Ruleset, q: OptionQuote) => r2(midOf(q)! + rs.ai.fillSpreadShare * spreadOf(q));

function weekly(q: OptionQuote, from: string) {
  const mid = midOf(q);
  return mid === null || !q.strike ? null : mid / q.strike / Math.max(1, Math.ceil(daysTo(from, q.expiry) / 7));
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
    private version: string,
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
      rules_version: this.version,
    };
    this.trades.push(row);
    return row;
  }
}

const stopWhy = (rs: Ruleset, l: Lot, close: number, floor: number | null) =>
  rs.levers?.shareStop !== undefined ? `Closed at ${r2(close)}, ${pct(1 - close / l.cost, 1)} under the ${r2(l.cost)} cost` : `Closed at ${r2(close)}, below its floor of ${r2(floor!)}`;

function stopFloor(rs: Ruleset, bars: Bar[] | undefined) {
  if (!bars || bars.length < 22) return null;
  return techAt(rs.rules, bars, bars.length - 1)?.floor ?? null;
}

/** The eligible candidates in trading order. The adaptive report (levers.prep.adapt) has already set the order (a blend
 * interleaves two rankings), so it's kept; otherwise the race's ranking (by score). They agree when there's no blend. */
export function ranked(rs: Ruleset, cands: CandidateRow[]) {
  if (!rs.levers?.prep?.adapt) return rankedCandidates(cands);
  return cands.filter((c) => c.eligible && c.score !== null && c.target_strike !== null);
}

export function aiTarget(rs: Ruleset, c: CandidateRow) {
  const base = c.target_strike!;
  if (c.exp_move === null || (c.score ?? 0) < rs.ai.strike.aggressiveMinScore || c.group_quadrant !== "Leading") return base;
  const near = c.last - rs.ai.strike.aggressiveMoves * c.exp_move;
  return c.floor !== null && near <= c.floor ? base : Math.max(base, near);
}

function sellPuts(rs: Ruleset, o: EngineOptions, s: RaceState, L: Ledger, cands: CandidateRow[], quotes: QuoteBook, spots: Record<string, number>, date: string, expiry: string, exposureTarget: number, day: "monday" | "wednesday") {
  const A = rs.ai;
  const roc = day === "monday" && rs.levers?.putStrike === "roc" ? (rs.levers.rocTarget ?? 0.01) : null;
  const delta = day === "monday" && rs.levers?.putStrike === "delta" ? (rs.levers.deltaTarget ?? 0.2) : null;
  const v = accountValue(s, spots);
  const held = new Set(s.options.filter((x) => x.type === "put").map((x) => x.symbol));
  for (const [i, c] of ranked(rs, cands).entries()) {
    const tag = `#${i + 1} ${c.stage.toLowerCase()}, score ${c.score}`;
    if (held.has(c.symbol)) continue;
    const lv = rs.levers;
    if (lv?.minScore !== undefined && (c.score ?? 0) < lv.minScore) continue;
    if (lv?.noLeveraged && LEVERAGED.has(c.symbol)) continue;
    if ((lv?.ivMin !== undefined && (c.iv ?? -1) < lv.ivMin) || (lv?.ivMax !== undefined && (c.iv === null || c.iv > lv.ivMax))) continue;
    const book = quotes[c.symbol];
    if (book === undefined) continue;
    const base = { symbol: c.symbol, type: "put" as const, expiration: expiry };
    if (!book.length) {
      L.add("Skipped", { ...base, note: `${tag}: no weekly expiring ${expiry}` });
      continue;
    }
    const px0 = spots[c.symbol] ?? c.last;
    // levers.swing.putMoves: a buy-zone name's put goes nearer the money (more premium, aiming to be assigned low)
    const pm = rs.levers?.swing?.putMoves;
    const zone = pm !== undefined && c.exp_move !== null && inBuyZone(rs, c);
    const target = zone ? c.last - pm! * c.exp_move! : roc === null ? aiTarget(rs, c) : px0;
    const ok =
      delta !== null
        ? book
            .filter((q) => q.expiry <= expiry && q.strike < px0 && q.delta !== null && Math.abs(q.delta) <= delta && realMarket(rs.rules, q) && (weekly(q, date) ?? 0) >= A.minWeekly)
            .sort((a, b) => b.strike - a.strike)
        : roc === null
        ? book
            .filter((q) => q.expiry <= expiry && q.strike <= target + 1e-9 && realMarket(rs.rules, q) && (weekly(q, date) ?? 0) >= A.minWeekly)
            .sort((a, b) => b.strike - a.strike)
        : book
            .filter((q) => q.expiry <= expiry && q.strike < px0 && realMarket(rs.rules, q) && (weekly(q, date) ?? 0) >= roc)
            .sort((a, b) => a.strike - b.strike);
    const q = ok[0];
    if (!q) {
      const note =
        roc === null
          ? `${tag}: no strike at or under ${r2(target)} with a real market paying ${pct(A.minWeekly)}+ for the week`
          : `${tag}: no strike under the price (${r2(px0)}) with a real market paying ${pct(roc)}+ for the week`;
      L.add("Skipped", { ...base, strike: r2(target), note });
      continue;
    }
    const k = q.strike;
    const per = k * 100;
    const tickerRoom = A.perTicker * v - nameExposure(s, c.symbol, spots);
    const themeRoom = A.perTheme * v - themeExposure(s, c.theme, spots);
    // the core holding (levers.core) and the hold book (levers.hold) don't count toward the target, only toward the margin cap
    const all = exposure(s, spots);
    const core = s.lots.filter(isBook).reduce((x, l) => x + l.shares * (spots[l.symbol] ?? l.mark), 0);
    const totalRoom = Math.min(Math.min(exposureTarget, A.exposure.ceiling) * v - (all - core), o.maxLeverage * v - all);
    let n = Math.floor(Math.min(tickerRoom, themeRoom, totalRoom) / per + 1e-9);
    if (n < 1 && nameExposure(s, c.symbol, spots) === 0 && per <= A.oneContract * v && per <= themeRoom && per <= totalRoom) n = 1;
    if (n < 1) {
      const why = totalRoom < per ? `the ${exposureTarget.toFixed(1)}x exposure target is reached` : themeRoom < per ? `${c.theme} is at ${pct(A.perTheme, 0)} of the account` : `one contract (${usd(per)}) is over ${pct(A.oneContract, 0)} of the account`;
      L.add("Skipped", { ...base, strike: k, bid: q.bid, ask: q.ask, note: `${tag}: ${why}` });
      if (totalRoom < per) break;
      continue;
    }
    const px = sellFill(rs, q);
    const id = L.id("o");
    s.options.push({ id, type: "put", symbol: c.symbol, theme: c.theme, strike: k, expiration: q.expiry, contracts: n, price: px, opened: date, week: s.week, setup: c.put_call });
    const cash = px * 100 * n - o.fees * n;
    s.cash += cash;
    held.add(c.symbol);
    L.add("Sold put", {
      ...base,
      expiration: q.expiry,
      strike: k,
      qty: n,
      price: px,
      bid: q.bid,
      ask: q.ask,
      cash,
      position_id: id,
      note: `${tag}; ${pct(weekly(q, date)!)} for the week, ${pct(1 - k / c.last, 1)} below the price${q.delta !== null ? `, ${Math.abs(q.delta).toFixed(2)} delta` : ""}`,
    });
  }
}

function sellCalls(rs: Ruleset, o: EngineOptions, s: RaceState, L: Ledger, quotes: QuoteBook, minStrike: Record<string, number>, date: string, expiry: string) {
  const CC = rs.ai.coveredCall;
  for (const l of s.lots) {
    if (isBook(l) || (isSwingLot(l) && !swingOf(rs)?.calls)) continue;
    const cover = isSwingLot(l) ? (swingOf(rs)?.callCoverage ?? rs.levers?.ccCoverage ?? 1) : (rs.levers?.ccCoverage ?? 1);
    const n = Math.floor(Math.floor(l.shares / 100) * cover + 1e-9);
    if (n < 1 || s.options.some((x) => x.type === "call" && x.symbol === l.symbol)) continue;
    const book = quotes[l.symbol];
    if (book === undefined) continue;
    const floor = minStrike[l.symbol] ?? l.cost;
    const ok = book.filter((q) => q.expiry <= expiry && q.strike >= floor - 1e-9 && realMarket(rs.rules, q) && (weekly(q, date) ?? 0) >= CC.minWeekly).sort((a, b) => a.strike - b.strike);
    const q = ok[0];
    if (!q) {
      L.add("Skipped", { symbol: l.symbol, type: "call", qty: n, expiration: expiry, note: `No call at or above ${r2(floor)} with a real market paying ${pct(CC.minWeekly)}+; holding the shares with the stop` });
      continue;
    }
    const px = sellFill(rs, q);
    const id = L.id("o");
    s.options.push({ id, type: "call", symbol: l.symbol, theme: l.theme, strike: q.strike, expiration: q.expiry, contracts: n, price: px, opened: date, week: s.week, setup: "Covered call" });
    const cash = px * 100 * n - o.fees * n;
    s.cash += cash;
    L.add("Sold call", { symbol: l.symbol, type: "call", strike: q.strike, expiration: q.expiry, qty: n, price: px, bid: q.bid, ask: q.ask, cash, position_id: id, note: isSwingLot(l) ? `Swing lot: covered call at or above ${r2(floor)} (the swing target, cost or price)` : `Covered call at or above cost ${r2(l.cost)} and one expected move` });
  }
}

function sellLot(rs: Ruleset, o: EngineOptions, s: RaceState, L: Ledger, l: Lot, price: number, why: string, callQuotes?: QuoteBook) {
  for (const x of s.options.filter((y) => y.type === "call" && y.symbol === l.symbol)) {
    const q = callQuotes?.[x.symbol]?.find((y) => y.strike === x.strike);
    const px = q && midOf(q) !== null ? buyFill(rs, q) : Math.max(0.01, price - x.strike + 0.05);
    const cash = -px * 100 * x.contracts - o.fees * x.contracts;
    s.cash += cash;
    s.options = s.options.filter((y) => y.id !== x.id);
    L.add("Bought back", { symbol: x.symbol, type: "call", strike: x.strike, expiration: x.expiration, qty: x.contracts, price: r2(px), cash, position_id: x.id, note: "Closed the covered call to sell the shares" });
  }
  s.cash += price * l.shares;
  s.lots = s.lots.filter((x) => x.id !== l.id);
  const pnl = (price - l.cost) * l.shares;
  L.add("Sold shares", { symbol: l.symbol, type: "shares", qty: l.shares, price: r2(price), cash: price * l.shares, position_id: l.id, note: `${why}. ${pnl >= 0 ? "+" : "-"}${usd(Math.abs(pnl))} vs the ${r2(l.cost)} cost` });
}

/**
 * levers.core: top the account up to `core`x exposure with the core symbol (SPY) after Monday's puts, and sell it all
 * when risk-off. Trades only when the change is 2%+ of the account, so it doesn't churn every week.
 */
function adjustCore(rs: Ruleset, o: EngineOptions, s: RaceState, L: Ledger, spots: Record<string, number>, date: string, g?: Regime) {
  const lv = rs.levers;
  if (!lv?.core || !g) return;
  const sym = lv.coreSymbol ?? "SPY";
  const px = g.px[sym];
  if (!px) return;
  const lot = s.lots.find((l) => l.theme === CORE);
  const sp = { ...spots, [sym]: px };
  const v = accountValue(s, sp);
  const have = lot?.shares ?? 0;
  const other = exposure(s, sp) - have * px;
  const want = regimeScale(rs, g) >= 1 ? Math.floor(Math.max(0, Math.min(lv.core, o.maxLeverage) * v - other) / px) : 0;
  const diff = want - have;
  if (diff === 0 || (want > 0 && Math.abs(diff) * px < 0.02 * v)) return;
  s.cash -= diff * px;
  if (diff > 0) {
    if (lot) Object.assign(lot, { cost: (lot.cost * have + diff * px) / want, shares: want, mark: px });
    else s.lots.push({ id: "core", symbol: sym, theme: CORE, shares: want, cost: px, mark: px, opened: date });
    L.add("Bought shares" as Action, { symbol: sym, type: "shares", qty: diff, price: r2(px), cash: -diff * px, position_id: "core", note: `Core: topped up to ${want} shares (${lv.core}x exposure target)` });
  } else {
    const pnl = (px - lot!.cost) * -diff;
    if (want === 0) s.lots = s.lots.filter((l) => l !== lot);
    else Object.assign(lot!, { shares: want, mark: px });
    L.add("Sold shares", { symbol: sym, type: "shares", qty: -diff, price: r2(px), cash: -diff * px, position_id: "core", note: `Core: ${want === 0 ? "risk-off, sold it all" : `trimmed to ${want} shares`}. ${pnl >= 0 ? "+" : "-"}${usd(Math.abs(pnl))} vs cost` });
  }
}

export function monday(rs: Ruleset, o: EngineOptions, s0: RaceState, inp: MondayInput & { swing?: SwingInput; hold?: HoldInput }, g?: Regime): RunResult {
  const s: RaceState = structuredClone(s0);
  s.week += 1;
  const L = new Ledger(s, inp.date, rs.name);
  for (const l of s.lots) if (inp.spots[l.symbol] !== undefined) l.mark = inp.spots[l.symbol];
  const only = noOptions(rs);
  swingWalk(rs, s, L, "monday", inp.date, inp.spots, inp.swing);

  for (const l of [...s.lots]) {
    if (isBook(l) || isSwingLot(l)) continue;
    const c = inp.candidates.find((x) => x.symbol === l.symbol);
    l.downtrendWeeks = c?.stage === "Downtrend" ? (l.downtrendWeeks ?? 0) + 1 : 0;
    if (l.downtrendWeeks >= 2 && !rs.levers?.holdUntilGreen) sellLot(rs, o, s, L, l, l.mark, "Downtrend two Sundays in a row", inp.quotes.calls);
  }

  const exit = rs.levers?.riskOffExit;
  if (exit && regimeScale(rs, g) < 1)
    for (const l of [...s.lots]) if (!isBook(l) && !isSwingLot(l) && (exit === "all" || l.mark < l.cost)) sellLot(rs, o, s, L, l, l.mark, "Risk-off: out of the shares", inp.quotes.calls);

  const minStrike: Record<string, number> = {};
  for (const l of s.lots) {
    if (isBook(l)) continue;
    const c = inp.candidates.find((x) => x.symbol === l.symbol);
    minStrike[l.symbol] = isSwingLot(l) ? swingCallFloor(rs, l) : Math.max(l.cost, l.mark + rs.ai.coveredCall.moves * (c?.exp_move ?? l.mark * 0.03));
  }
  // levers.hold: the book takes the cash first; the wheel's puts get the margin above it
  holdStep(rs, o.maxLeverage, s, L, inp.date, inp.hold, LEVERAGED);
  if (rs.ai.coveredCall.use && !only) sellCalls(rs, o, s, L, inp.quotes.calls, minStrike, inp.date, inp.expiry);
  const value = accountValue(s, inp.spots);
  if (!only) sellPuts(rs, o, s, L, inp.candidates, inp.quotes.puts, inp.spots, inp.date, inp.expiry, rs.ai.exposure.monday * regimeScale(rs, g), "monday");
  swingEnter(rs, o.maxLeverage, s, L, "monday", inp.date, ranked(rs, inp.candidates), inp.spots, inp.swing);
  adjustCore(rs, o, s, L, inp.spots, inp.date, g);

  s.current = { week: s.week, opened: inp.date, expiry: inp.expiry, valueAtOpen: r2(value) };
  s.lastRun = { kind: "monday", at: inp.date, week: s.week };
  return { state: s, trades: L.trades, report: [] };
}

export function wednesday(rs: Ruleset, o: EngineOptions, s0: RaceState, inp: WednesdayInput & { swing?: SwingInput }, g?: Regime): RunResult {
  const s: RaceState = structuredClone(s0);
  if (!s.current) throw new Error(`wednesday ${inp.date}: no week is open`);
  const L = new Ledger(s, inp.date, rs.name);
  for (const l of s.lots) if (inp.spots[l.symbol] !== undefined) l.mark = inp.spots[l.symbol];
  swingWalk(rs, s, L, "wednesday", inp.date, inp.spots, inp.swing);

  for (const x of s.options.filter((y) => y.type === "put")) {
    const q = inp.quotes.puts[x.symbol]?.find((y) => Math.abs(y.strike - x.strike) < 1e-9 && y.expiry === x.expiration);
    const bars = inp.bars[x.symbol];
    const floor = stopFloor(rs, bars);
    const lastClose = bars?.at(-1)?.close ?? null;
    const broke = floor !== null && lastClose !== null && lastClose < floor;
    if (!q || midOf(q) === null) continue;
    const captured = 1 - midOf(q)! / x.price;
    if (captured < rs.ai.takeProfit && !broke) continue;
    const px = buyFill(rs, q);
    const cash = -px * 100 * x.contracts - o.fees * x.contracts;
    s.cash += cash;
    s.options = s.options.filter((y) => y.id !== x.id);
    const kept = (x.price - px) * 100 * x.contracts;
    L.add("Bought back", {
      symbol: x.symbol,
      type: "put",
      strike: x.strike,
      expiration: x.expiration,
      qty: x.contracts,
      price: px,
      bid: q.bid,
      ask: q.ask,
      cash,
      position_id: x.id,
      note: broke
        ? `Closed below its floor (${r2(floor!)}); out before Friday, ${kept >= 0 ? "kept" : "lost"} ${usd(Math.abs(kept))}`
        : `${pct(captured, 0)} of the premium captured by Wednesday; kept ${usd(kept)} and freed the collateral`,
    });
  }

  const covered = new Set(s.options.filter((x) => x.type === "call").map((x) => x.symbol));
  if (swingOf(rs)?.midweekExit)
    for (const l of [...s.lots]) {
      if (!isSwingLot(l) || !covered.has(l.symbol)) continue;
      const why = swingHot(rs, inp.swing?.bars[l.symbol]);
      if (why && inp.spots[l.symbol] !== undefined) sellLot(rs, o, s, L, l, inp.spots[l.symbol], `Swing: ${why} on Wednesday; out before Friday`, inp.quotes.calls);
    }
  if (rs.ai.stopBelowFloor && !rs.levers?.holdUntilGreen) {
    for (const l of [...s.lots]) {
      // swing lots keep their own stop, except while a covered call is open (the swing walk leaves those alone)
      if (isBook(l) || (isSwingLot(l) && !covered.has(l.symbol)) || inStopGrace(l.opened, inp.date, rs.ai.stopGraceDays)) continue;
      const bars = inp.bars[l.symbol];
      const floor = stopFloor(rs, bars);
      const close = bars?.at(-1)?.close;
      if (stopHit(rs, l, close, floor)) sellLot(rs, o, s, L, l, inp.spots[l.symbol] ?? close!, stopWhy(rs, l, close!, floor), inp.quotes.calls);
    }
  }

  if (rs.levers?.wedRedeploy !== false && !noOptions(rs)) sellPuts(rs, o, s, L, inp.candidates, inp.quotes.puts, inp.spots, inp.date, s.current.expiry, rs.ai.exposure.wednesday * regimeScale(rs, g), "wednesday");
  swingEnter(rs, o.maxLeverage, s, L, "wednesday", inp.date, ranked(rs, inp.candidates), inp.spots, inp.swing);
  s.lastRun = { kind: "wednesday", at: inp.date, week: s.week };
  return { state: s, trades: L.trades, report: [] };
}

/**
 * What the Friday decide rule reads (levers.fridayDecide / fridayRollCalls), all as of Friday's close: daily bars for
 * the names with an expiring option in the money and for SPY, today's quotes for the expiring options, and next week's
 * quotes to roll into.
 */
export interface FridayDecideInput {
  bars: Record<string, Bar[]>;
  spy: Bar[];
  today: { puts: QuoteBook; calls: QuoteBook };
  next: { expiry: string; puts: QuoteBook; calls: QuoteBook };
}

/** Would the stock still make Sunday's list? Trend qualifies, not in the never-sell zone, closed at or above its 20-day low (through yesterday). */
function stillQualifies(rs: Ruleset, bars: Bar[] | undefined, spy: Bar[], close: number, floorOnly = false) {
  if (!bars || bars.length < 2 || spy.length < 2) return false;
  if (floorOnly) {
    const f = stopFloor(rs, bars);
    return f === null || close >= f;
  }
  const t = techAt(rs.rules, bars);
  const m = techAt(rs.rules, spy);
  if (!t || !m) return false;
  const st = stage(rs.rules, rel(t.ret4w, m.ret4w), rel(t.ret13w, m.ret13w), t);
  const floor = stopFloor(rs, bars);
  return trendQualifies(st, t) && !inNeverSellZone(rs.rules, t) && (floor === null || close >= floor);
}

/**
 * The Friday decide rule, before settlement: rolls or buys back the in-the-money options it doesn't want settled. What
 * it leaves is settled as usual (puts assigned, calls called away). Fills: buy at mid + the fill share of the spread
 * (or intrinsic + $0.05 with no quote), sell at mid − it; a roll needs the sale to beat the buyback by a cent a share.
 */
function fridayDecide(rs: Ruleset, o: EngineOptions, s: RaceState, L: Ledger, inp: FridayInput & { decide?: FridayDecideInput }) {
  const D = inp.decide;
  if (!D) return;
  for (const x of [...s.options]) {
    if (x.expiration > inp.date) continue;
    const c = inp.closes[x.symbol];
    if (c === undefined) continue;
    const isPut = x.type === "put";
    if (isPut ? !(rs.levers?.fridayDecide && c < x.strike) : !(rs.levers?.fridayRollCalls && c > x.strike)) continue;
    const ok = stillQualifies(rs, D.bars[x.symbol], D.spy, c, isPut && rs.levers?.fridayDecide === "floor");
    if (isPut && ok) continue; // take assignment
    if (!isPut && !ok) continue; // let it be called away
    const q0 = (isPut ? D.today.puts : D.today.calls)[x.symbol]?.find((q) => Math.abs(q.strike - x.strike) < 1e-9 && q.expiry === x.expiration);
    const intrinsic = isPut ? x.strike - c : c - x.strike;
    const buy = q0 && midOf(q0) !== null && q0.ask !== null ? Math.max(buyFill(rs, q0), r2(intrinsic)) : r2(intrinsic + 0.05);
    const lot = s.lots.find((l) => l.symbol === x.symbol);
    const book = (isPut ? D.next.puts : D.next.calls)[x.symbol] ?? [];
    const credit = (q: OptionQuote) => midOf(q) !== null && sellFill(rs, q) - buy >= 0.01;
    const roll = isPut
      ? book.filter((q) => q.expiry === D.next.expiry && q.strike <= x.strike + 1e-9 && realMarket(rs.rules, q) && credit(q)).sort((a, b) => a.strike - b.strike)[0]
      : book
          .filter((q) => q.expiry === D.next.expiry && q.strike >= x.strike - 1e-9 && q.strike >= (lot?.cost ?? 0) - 1e-9 && realMarket(rs.rules, q) && credit(q))
          .sort((a, b) => b.strike - a.strike)[0];
    if (!isPut && !roll) continue; // no credit roll: the shares are called away
    const cashOut = -buy * 100 * x.contracts - o.fees * x.contracts;
    s.cash += cashOut;
    s.options = s.options.filter((y) => y.id !== x.id);
    const base = { symbol: x.symbol, type: x.type, strike: x.strike, expiration: x.expiration, qty: x.contracts, price: buy, cash: cashOut, position_id: x.id };
    if (!roll) {
      const kept = (x.price - buy) * 100 * x.contracts;
      L.add("Bought back", { ...base, note: `Closed at ${r2(c)}, under the strike and failing Sunday's checks; no roll for a credit, bought back (${kept >= 0 ? "kept" : "lost"} ${usd(Math.abs(kept))})` });
      continue;
    }
    const px = sellFill(rs, roll);
    const id = L.id("o");
    s.options.push({ id, type: x.type, symbol: x.symbol, theme: x.theme, strike: roll.strike, expiration: roll.expiry, contracts: x.contracts, price: px, opened: inp.date, week: s.week, setup: `Rolled from ${x.strike}` });
    const cashIn = px * 100 * x.contracts - o.fees * x.contracts;
    s.cash += cashIn;
    const why = isPut ? "under the strike and failing Sunday's checks" : "over the strike with the trend intact";
    L.add("Bought back", { ...base, note: `Closed at ${r2(c)}, ${why}: rolled to ${roll.strike} for ${roll.expiry}` });
    L.add(isPut ? "Sold put" : "Sold call", {
      symbol: x.symbol,
      type: x.type,
      strike: roll.strike,
      expiration: roll.expiry,
      qty: x.contracts,
      price: px,
      bid: roll.bid,
      ask: roll.ask,
      cash: cashIn,
      position_id: id,
      note: `Roll from ${x.strike}: net credit ${usd((px - buy) * 100 * x.contracts)}`,
    });
  }
}

/** Friday: settle expiring options at the close, stop out shares, mark to the close and score the week. `opp` is the benchmark's value. */
export function friday(rs: Ruleset, o: EngineOptions, s0: RaceState, inp: FridayInput & { decide?: FridayDecideInput; swing?: SwingInput }): RunResult & { week: WeekRow } {
  const s: RaceState = structuredClone(s0);
  if (!s.current) s.week += 1;
  const L = new Ledger(s, inp.date, rs.name);
  swingWalk(rs, s, L, "friday", inp.date, inp.closes, inp.swing);
  fridayDecide(rs, o, s, L, inp);
  const counts: Record<string, number> = { puts_expired: 0, puts_assigned: 0, calls_expired: 0, calls_called: 0 };
  const missing: string[] = [];

  for (const x of [...s.options]) {
    if (x.expiration > inp.date) continue;
    const c = inp.closes[x.symbol];
    if (c === undefined) {
      missing.push(x.symbol);
      continue;
    }
    s.options = s.options.filter((y) => y.id !== x.id);
    const base = { symbol: x.symbol, type: x.type, strike: x.strike, expiration: x.expiration, qty: x.contracts, price: c, position_id: x.id };
    if (x.type === "put") {
      if (c < x.strike && rs.levers?.avoidAssignment) {
        const px = r2(x.strike - c + 0.05);
        const cash = -px * 100 * x.contracts - o.fees * x.contracts;
        s.cash += cash;
        const kept = (x.price - px) * 100 * x.contracts;
        L.add("Bought back", { ...base, price: px, cash, note: `Closed at ${r2(c)}, under the strike: bought back at ${px} instead of taking assignment; ${kept >= 0 ? "kept" : "lost"} ${usd(Math.abs(kept))}` });
      } else if (c < x.strike) {
        const cash = -x.strike * 100 * x.contracts - o.fees * x.contracts;
        s.cash += cash;
        const id = L.id("l");
        s.lots.push({ id, symbol: x.symbol, theme: x.theme, shares: 100 * x.contracts, cost: x.strike, mark: c, opened: x.expiration });
        adoptLot(rs, s.lots.at(-1)!, inp.bars?.[x.symbol], inp.date);
        counts.puts_assigned += 1;
        L.add("Assigned", { ...base, cash, note: `Closed at ${r2(c)}, under the strike: bought ${100 * x.contracts} shares at ${x.strike}` });
      } else {
        counts.puts_expired += 1;
        L.add("Expired", { ...base, cash: 0, note: `Closed at ${r2(c)}: kept the full premium` });
      }
    } else if (c > x.strike) {
      let left = 100 * x.contracts;
      let gain = 0;
      for (const l of s.lots.filter((y) => y.symbol === x.symbol).sort((a, b) => Number(isBook(a)) - Number(isBook(b)))) {
        const take = Math.min(left, l.shares);
        gain += (x.strike - l.cost) * take;
        l.shares -= take;
        left -= take;
      }
      s.lots = s.lots.filter((l) => l.shares > 0);
      const cash = x.strike * 100 * x.contracts - o.fees * x.contracts;
      s.cash += cash;
      counts.calls_called += 1;
      L.add("Called away", { ...base, cash, note: `Closed at ${r2(c)}, over the strike: sold ${100 * x.contracts} shares at ${x.strike} (${gain >= 0 ? "+" : "-"}${usd(Math.abs(gain))} vs cost)` });
    } else {
      counts.calls_expired += 1;
      L.add("Expired", { ...base, cash: 0, note: `Closed at ${r2(c)}: kept the shares and the premium` });
    }
  }

  for (const l of s.lots) {
    if (inp.closes[l.symbol] !== undefined) l.mark = inp.closes[l.symbol];
    else if (!missing.includes(l.symbol)) missing.push(l.symbol);
  }
  if (rs.ai.stopBelowFloor && !rs.levers?.holdUntilGreen && inp.bars) {
    for (const l of [...s.lots]) {
      if (isBook(l) || (isSwingLot(l) && !s.options.some((x) => x.type === "call" && x.symbol === l.symbol)) || inStopGrace(l.opened, inp.date, rs.ai.stopGraceDays)) continue;
      const floor = stopFloor(rs, inp.bars[l.symbol]);
      const close = inp.closes[l.symbol];
      if (stopHit(rs, l, close, floor)) sellLot(rs, o, s, L, l, close!, stopWhy(rs, l, close!, floor));
    }
  }

  swingEnter(rs, o.maxLeverage, s, L, "friday", inp.date, inp.swing ? ranked(rs, inp.swing.cands) : [], inp.closes, inp.swing);
  const value = accountValue(s);
  s.peak = Math.max(s.peak, value);
  const dd = value / s.peak - 1;
  s.maxDrawdown = Math.min(s.maxDrawdown, dd);

  let oppWeek: number | null = null;
  if (inp.opp && s.opp.lastValue) {
    oppWeek = inp.opp.value / s.opp.lastValue - 1;
    s.opp.index *= 1 + oppWeek;
    s.opp.peak = Math.max(s.opp.peak, s.opp.index);
    s.opp.maxDrawdown = Math.min(s.opp.maxDrawdown, s.opp.index / s.opp.peak - 1);
    s.opp.lastValue = inp.opp.value;
  }
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
    opp_flows: 0,
    premium: 0,
    exposure: r2(exposure(s)),
    leverage: value ? exposure(s) / value : 0,
    counts,
    note: missing.length ? `No close for ${[...new Set(missing)].join(", ")}; left open.` : "",
    rules_version: rs.name,
  };
  s.lastValue = value;
  s.current = null;
  s.lastRun = { kind: "friday", at: inp.date, week: wk };
  return { state: s, trades: L.trades, week: row, report: [] };
}
