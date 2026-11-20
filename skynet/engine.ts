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
import { daysTo, midOf, type Bar, type OptionQuote } from "../src/lib/rules";
import { realMarket, techAt } from "./logic";
import type { Ruleset } from "./rulesets";

export interface EngineOptions {
  /** dollars per contract on each option trade and on assignment or call-away (0 = the race) */
  fees: number;
  /**
   * The account's margin limit: new puts never take exposure past this multiple of the account value, whatever the
   * ruleset asks for (Infinity = the race, where the ruleset's own ceiling is the only limit).
   */
  maxLeverage: number;
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

function stopFloor(rs: Ruleset, bars: Bar[] | undefined) {
  if (!bars || bars.length < 22) return null;
  return techAt(rs.rules, bars, bars.length - 1)?.floor ?? null;
}

export function aiTarget(rs: Ruleset, c: CandidateRow) {
  const base = c.target_strike!;
  if (c.exp_move === null || (c.score ?? 0) < rs.ai.strike.aggressiveMinScore || c.group_quadrant !== "Leading") return base;
  const near = c.last - rs.ai.strike.aggressiveMoves * c.exp_move;
  return c.floor !== null && near <= c.floor ? base : Math.max(base, near);
}

function sellPuts(rs: Ruleset, o: EngineOptions, s: RaceState, L: Ledger, cands: CandidateRow[], quotes: QuoteBook, spots: Record<string, number>, date: string, expiry: string, exposureTarget: number) {
  const A = rs.ai;
  const v = accountValue(s, spots);
  const held = new Set(s.options.filter((x) => x.type === "put").map((x) => x.symbol));
  for (const [i, c] of rankedCandidates(cands).entries()) {
    const tag = `#${i + 1} ${c.stage.toLowerCase()}, score ${c.score}`;
    if (held.has(c.symbol)) continue;
    const book = quotes[c.symbol];
    if (book === undefined) continue;
    const base = { symbol: c.symbol, type: "put" as const, expiration: expiry };
    if (!book.length) {
      L.add("Skipped", { ...base, note: `${tag}: no weekly expiring ${expiry}` });
      continue;
    }
    const target = aiTarget(rs, c);
    const ok = book
      .filter((q) => q.expiry <= expiry && q.strike <= target + 1e-9 && realMarket(rs.rules, q) && (weekly(q, date) ?? 0) >= A.minWeekly)
      .sort((a, b) => b.strike - a.strike);
    const q = ok[0];
    if (!q) {
      L.add("Skipped", { ...base, strike: r2(target), note: `${tag}: no strike at or under ${r2(target)} with a real market paying ${pct(A.minWeekly)}+ for the week` });
      continue;
    }
    const k = q.strike;
    const per = k * 100;
    const tickerRoom = A.perTicker * v - nameExposure(s, c.symbol, spots);
    const themeRoom = A.perTheme * v - themeExposure(s, c.theme, spots);
    const totalRoom = Math.min(exposureTarget, A.exposure.ceiling, o.maxLeverage) * v - exposure(s, spots);
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
    const n = Math.floor(l.shares / 100);
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
    L.add("Sold call", { symbol: l.symbol, type: "call", strike: q.strike, expiration: q.expiry, qty: n, price: px, bid: q.bid, ask: q.ask, cash, position_id: id, note: `Covered call at or above cost ${r2(l.cost)} and one expected move` });
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

export function monday(rs: Ruleset, o: EngineOptions, s0: RaceState, inp: MondayInput): RunResult {
  const s: RaceState = structuredClone(s0);
  s.week += 1;
  const L = new Ledger(s, inp.date, rs.name);
  for (const l of s.lots) if (inp.spots[l.symbol] !== undefined) l.mark = inp.spots[l.symbol];

  for (const l of [...s.lots]) {
    const c = inp.candidates.find((x) => x.symbol === l.symbol);
    l.downtrendWeeks = c?.stage === "Downtrend" ? (l.downtrendWeeks ?? 0) + 1 : 0;
    if (l.downtrendWeeks >= 2) sellLot(rs, o, s, L, l, l.mark, "Downtrend two Sundays in a row", inp.quotes.calls);
  }

  const minStrike: Record<string, number> = {};
  for (const l of s.lots) {
    const c = inp.candidates.find((x) => x.symbol === l.symbol);
    minStrike[l.symbol] = Math.max(l.cost, l.mark + rs.ai.coveredCall.moves * (c?.exp_move ?? l.mark * 0.03));
  }
  if (rs.ai.coveredCall.use) sellCalls(rs, o, s, L, inp.quotes.calls, minStrike, inp.date, inp.expiry);
  const value = accountValue(s, inp.spots);
  sellPuts(rs, o, s, L, inp.candidates, inp.quotes.puts, inp.spots, inp.date, inp.expiry, rs.ai.exposure.monday);

  s.current = { week: s.week, opened: inp.date, expiry: inp.expiry, valueAtOpen: r2(value) };
  s.lastRun = { kind: "monday", at: inp.date, week: s.week };
  return { state: s, trades: L.trades, report: [] };
}

export function wednesday(rs: Ruleset, o: EngineOptions, s0: RaceState, inp: WednesdayInput): RunResult {
  const s: RaceState = structuredClone(s0);
  if (!s.current) throw new Error(`wednesday ${inp.date}: no week is open`);
  const L = new Ledger(s, inp.date, rs.name);
  for (const l of s.lots) if (inp.spots[l.symbol] !== undefined) l.mark = inp.spots[l.symbol];

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

  if (rs.ai.stopBelowFloor) {
    for (const l of [...s.lots]) {
      const bars = inp.bars[l.symbol];
      const floor = stopFloor(rs, bars);
      const close = bars?.at(-1)?.close;
      if (floor !== null && close !== undefined && close < floor) sellLot(rs, o, s, L, l, inp.spots[l.symbol] ?? close, `Closed at ${r2(close)}, below its floor of ${r2(floor)}`, inp.quotes.calls);
    }
  }

  sellPuts(rs, o, s, L, inp.candidates, inp.quotes.puts, inp.spots, inp.date, s.current.expiry, rs.ai.exposure.wednesday);
  s.lastRun = { kind: "wednesday", at: inp.date, week: s.week };
  return { state: s, trades: L.trades, report: [] };
}

/** Friday: settle expiring options at the close, stop out shares, mark to the close and score the week. `opp` is the benchmark's value. */
export function friday(rs: Ruleset, o: EngineOptions, s0: RaceState, inp: FridayInput): RunResult & { week: WeekRow } {
  const s: RaceState = structuredClone(s0);
  if (!s.current) s.week += 1;
  const L = new Ledger(s, inp.date, rs.name);
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
      if (c < x.strike) {
        const cash = -x.strike * 100 * x.contracts - o.fees * x.contracts;
        s.cash += cash;
        const id = L.id("l");
        s.lots.push({ id, symbol: x.symbol, theme: x.theme, shares: 100 * x.contracts, cost: x.strike, mark: c, opened: x.expiration });
        counts.puts_assigned += 1;
        L.add("Assigned", { ...base, cash, note: `Closed at ${r2(c)}, under the strike: bought ${100 * x.contracts} shares at ${x.strike}` });
      } else {
        counts.puts_expired += 1;
        L.add("Expired", { ...base, cash: 0, note: `Closed at ${r2(c)}: kept the full premium` });
      }
    } else if (c > x.strike) {
      let left = 100 * x.contracts;
      let gain = 0;
      for (const l of s.lots.filter((y) => y.symbol === x.symbol)) {
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
  if (rs.ai.stopBelowFloor && inp.bars) {
    for (const l of [...s.lots]) {
      const floor = stopFloor(rs, inp.bars[l.symbol]);
      const close = inp.closes[l.symbol];
      if (floor !== null && close !== undefined && close < floor) sellLot(rs, o, s, L, l, close, `Closed at ${r2(close)}, below its floor of ${r2(floor)}`);
    }
  }

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
