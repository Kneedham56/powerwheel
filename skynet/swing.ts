/**
 * Swing trading for Skynet rulesets (levers.swing): buy shares low, sell them high, from the same Sunday report.
 *
 * Decisions happen on the run days (Monday, Wednesday, Friday, at the close). In between, resting orders play out
 * against the daily bars, oldest day first:
 *  - a limit buy fills at the open if the stock opens under the limit, else at the limit once the day's low reaches it
 *  - a target sell fills at the open if it gaps over the target, else at the target once the day's high reaches it
 *  - the stop, the stretch exit, the RSI exit, the trailing tripwire and the time stop read daily closes and sell at
 *    that close (pre-committed tripwires, the way Kyle runs them)
 *
 * Positions are ordinary share lots in the race state with a `swing` tag (so account value, exposure and splits work
 * as for assigned shares). Their target and stop are kept as multiples of the cost, so a split can't stale them.
 * The wheel's own share rules (downtrend sale, floor stop, covered calls) leave tagged lots alone unless a lever says
 * otherwise. Pure functions only.
 */
import type { CandidateRow } from "../src/lib/prep";
import { accountValue, exposure, r2, type Action, type Lot, type RaceState, type Trade } from "../src/lib/race";
import type { Bar, Tech } from "../src/lib/rules";
import { techAt } from "./logic";
import type { Ruleset } from "./rulesets";

export interface SwingLevers {
  /** "only": swing trading alone (no puts, no calls). "add": beside the wheel, sharing the account. */
  mode: "only" | "add";
  /** swing exposure cap, a multiple of the account value (the account's margin limit still applies) */
  exposure: number;
  /** one position's size, a share of the account value */
  perName: number;
  /** most positions (and resting buys) at once */
  maxNames: number;
  /** run days that may open positions (default Monday only) */
  entryDays?: ("monday" | "wednesday" | "friday")[];
  /** "close": buy at the run day's close. "limit": rest a buy at close − limitAtr × ATR until Friday's close. */
  entry: "close" | "limit";
  limitAtr?: number;
  /** a name qualifies only when each of its features (as of the run day's close) is within [min, max].
   * Features: pctB, rsi, vs50, vs200, offHigh, ret1w, ret4w, toFloor (close ÷ 20-day low − 1), atrPct (ATR ÷ close),
   * score (the Sunday score), rs4, rs13 (vs SPY), iv, rand (a placebo). A missing feature fails. */
  filters?: Record<string, [number | null, number | null]>;
  /** entries respect the ruleset's regime gate (levers.spyMaDays, vixMax): no new swing buys while risk-off */
  regime?: boolean;
  /** ranking for entries: "score" (the report's order, default) or a feature, best first ("-rsi" = lowest first) */
  rank?: string;

  /** exits: a resting target at cost × (1 + targetAtr × ATR%) or cost × (1 + targetPct) */
  targetAtr?: number;
  targetPct?: number;
  /** stop at a daily close under cost × (1 − stopAtr × ATR%) or cost × (1 − stopPct) */
  stopAtr?: number;
  stopPct?: number;
  /** stop at a daily close under the 20-day low as it stood at entry (minus stopFloorAtr × ATR) */
  stopFloor?: boolean;
  stopFloorAtr?: number;
  /** a daily close at or over SMA20 + stretchAtr × ATR (or RSI at or over rsiExit) sells, or arms the trail */
  stretchAtr?: number;
  rsiExit?: number;
  /** after the stretch or RSI zone is reached (or the close is trailArm × ATR over cost), a close under the prior
   * day's low sells */
  trail?: boolean;
  trailArm?: number;
  /** the floor stop trails: it rises with the 20-day low (minus stopFloorAtr × ATR) as the stock climbs (a Donchian exit) */
  stopTrail?: boolean;
  /** size each position to perName × min(1, volTarget ÷ ATR%): smaller positions in wilder names */
  volTarget?: number;
  /** sell at the close once a lot is this many calendar days old */
  maxDays?: number;
  /** a run day's close with the stock in a Downtrend stage (Sunday report) sells */
  exitDowntrend?: boolean;
  /** cost of each share fill, as a share of the price (half spread + impact), default 0.0005 */
  slip?: number;

  /** wheel + swing: assigned shares become swing lots (these exits apply); their target/stop measure from the strike */
  adoptAssigned?: boolean;
  /** wheel + swing: tagged lots still get covered calls, struck at or over the swing target (or the cost) and the price */
  calls?: boolean;
  /** wheel + swing: share of a tagged lot's contracts covered (default the ruleset's ccCoverage) */
  callCoverage?: number;
  /** wheel + swing: Monday's put on a name in the buy zone goes `putMoves` expected moves under the price (nearer the
   * money than the usual strike: more premium, aiming to be assigned at the bottom) */
  putMoves?: number;
  /** the buy zone, on the Sunday report's columns (pct_b, rsi, vs50, vs200, rs4, rs13, score, iv): each within [min, max] */
  buyZone?: Record<string, [number | null, number | null]>;
  /** wheel + swing: Wednesday, a tagged lot with an open call that is stretched or hot (stretchAtr / rsiExit) is sold
   * and its call bought back, instead of waiting for Friday */
  midweekExit?: boolean;
}

export interface SwingMeta {
  /** ATR ÷ price at entry */
  atr: number;
  /** the 20-day low ÷ cost at entry */
  floor: number | null;
  /** highest close ÷ cost since entry */
  peak: number;
  tagged: boolean;
  /** last daily bar already processed */
  lastDay: string;
  source: "swing" | "assigned";
}

export type SwingLot = Lot & { swing?: SwingMeta };

interface Pending {
  id: string;
  symbol: string;
  theme: string;
  limit: number;
  shares: number;
  atr: number;
  floor: number | null;
  placed: string;
}

export interface SwingState {
  pending: Pending[];
}

/** What a run day gives the swing step: daily bars through today's close for held lots, resting buys and candidates. */
export interface SwingInput {
  bars: Record<string, Bar[]>;
  /** the week's Sunday report */
  cands: CandidateRow[];
  /** the ruleset's regime gate (levers.spyMaDays, vixMax) as of the close before the run */
  riskOn: boolean;
}

export interface SwingLedger {
  id(prefix: string): string;
  add(action: Action, t: Partial<Omit<Trade, "id" | "date" | "week" | "action" | "rules_version">>): Trade;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;

export const swingOf = (rs: Ruleset) => rs.levers?.swing;
export const isSwingLot = (l: Lot) => !!(l as SwingLot).swing;
const stateOf = (s: RaceState): SwingState => ((s as RaceState & { swing?: SwingState }).swing ??= { pending: [] });

/** The tagged lots' value plus resting buys at their limit. */
function swingExposure(s: RaceState, spots: Record<string, number>) {
  const lots = s.lots.filter(isSwingLot).reduce((a, l) => a + l.shares * (spots[l.symbol] ?? l.mark), 0);
  return lots + stateOf(s).pending.reduce((a, p) => a + p.limit * p.shares, 0);
}

function targetOf(S: SwingLevers, l: SwingLot) {
  const m = l.swing!;
  if (S.targetAtr !== undefined) return l.cost * (1 + S.targetAtr * m.atr);
  if (S.targetPct !== undefined) return l.cost * (1 + S.targetPct);
  return null;
}

function stopOf(S: SwingLevers, l: SwingLot) {
  const m = l.swing!;
  const xs: number[] = [];
  if (S.stopAtr !== undefined) xs.push(l.cost * (1 - S.stopAtr * m.atr));
  if (S.stopPct !== undefined) xs.push(l.cost * (1 - S.stopPct));
  if (S.stopFloor && m.floor !== null) xs.push(l.cost * (m.floor - (S.stopFloorAtr ?? 0) * m.atr));
  return xs.length ? Math.max(...xs) : null;
}

/** The lowest strike a covered call on a tagged lot may use: the swing target (else the cost), and not under the price. */
export function swingCallFloor(rs: Ruleset, l: Lot) {
  const S = swingOf(rs);
  if (!S || !isSwingLot(l)) return l.cost;
  return Math.max(l.cost, l.mark, targetOf(S, l as SwingLot) ?? l.cost);
}

/** Is a Sunday candidate in the buy zone (levers.swing.buyZone)? No zone = every name. */
export function inBuyZone(rs: Ruleset, c: CandidateRow) {
  const Z = swingOf(rs)?.buyZone;
  if (!Z) return true;
  const row = c as unknown as Record<string, number | null>;
  return Object.entries(Z).every(([k, [lo, hi]]) => typeof row[k] === "number" && (lo === null || row[k]! >= lo) && (hi === null || row[k]! <= hi));
}

/** Stretched or hot at the last bar's close (levers.swing.stretchAtr / rsiExit)? */
export function swingHot(rs: Ruleset, bars: Bar[] | undefined) {
  const S = swingOf(rs);
  if (!S || !bars || bars.length < 21) return null;
  const t = techAt(rs.rules, bars);
  if (!t) return null;
  if (S.stretchAtr !== undefined && t.sma20 !== null && t.atr !== null && t.last >= t.sma20 + S.stretchAtr * t.atr) return `stretched ${S.stretchAtr} ATR over its 20-day average`;
  if (S.rsiExit !== undefined && t.rsi14 !== null && t.rsi14 >= S.rsiExit) return `RSI ${t.rsi14.toFixed(0)}`;
  return null;
}

function sell(S: SwingLevers, s: RaceState, L: SwingLedger, l: SwingLot, px: number, why: string) {
  const fill = px * (1 - (S.slip ?? 0.0005));
  s.cash += fill * l.shares;
  s.lots = s.lots.filter((x) => x.id !== l.id);
  const pnl = (fill - l.cost) * l.shares;
  L.add("Sold shares", {
    symbol: l.symbol,
    type: "shares",
    qty: l.shares,
    price: r2(fill),
    cash: fill * l.shares,
    position_id: l.id,
    note: `Swing: ${why}. ${pnl >= 0 ? "+" : "-"}${usd(Math.abs(pnl))} (${pct(fill / l.cost - 1)}) vs the ${r2(l.cost)} cost`,
  });
}

/** a placebo in [0, 1) from the name and date: no market information */
function hash01(sym: string, date: string) {
  let h = 2166136261;
  for (const ch of `${sym}|${date}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1e6) / 1e6;
}

function features(t: Tech, c: CandidateRow | undefined): Record<string, number | null> {
  return {
    pctB: t.pctB,
    rsi: t.rsi14,
    vs50: t.vs50,
    vs200: t.vs200,
    offHigh: t.offHigh,
    ret1w: t.ret1w,
    ret4w: t.ret4w,
    toFloor: t.floor ? t.last / t.floor - 1 : null,
    atrPct: t.atr !== null ? t.atr / t.last : null,
    score: c?.score ?? null,
    rs4: c?.rs4 ?? null,
    rs13: c?.rs13 ?? null,
    iv: c?.iv ?? null,
    rand: c ? hash01(c.symbol, t.date) : null,
  };
}

/** Walk a tagged lot through the daily bars since it was last looked at; sells it if an exit fires. */
function walkLot(rs: Ruleset, S: SwingLevers, s: RaceState, L: SwingLedger, l: SwingLot, bars: Bar[], date: string, hasCall: boolean) {
  const m = l.swing!;
  const T = targetOf(S, l);
  const stop = stopOf(S, l);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.date <= m.lastDay || b.date > date) continue;
    m.lastDay = b.date;
    if (hasCall) continue; // the covered call is the exit while it's open
    if (T !== null && b.open >= T) return sell(S, s, L, l, b.open, `opened at ${r2(b.open)} over the ${r2(T)} target on ${b.date}`);
    if (T !== null && b.high >= T) return sell(S, s, L, l, T, `hit the ${r2(T)} target on ${b.date}`);
    const stopNow = S.stopTrail ? stopOf(S, l) : stop;
    if (stopNow !== null && b.close < stopNow) return sell(S, s, L, l, b.close, `closed at ${r2(b.close)} under the ${r2(stopNow)} ${S.stopTrail ? "trailing " : ""}stop on ${b.date}`);
    if (S.stopTrail && i >= 19) m.floor = Math.max(m.floor ?? 0, Math.min(...bars.slice(i - 19, i + 1).map((x) => x.low)) / l.cost);
    const t = S.stretchAtr !== undefined || S.rsiExit !== undefined ? techAt(rs.rules, bars, i + 1) : null;
    const stretched = !!t && S.stretchAtr !== undefined && t.sma20 !== null && t.atr !== null && b.close >= t.sma20 + S.stretchAtr * t.atr;
    const hot = !!t && S.rsiExit !== undefined && t.rsi14 !== null && t.rsi14 >= S.rsiExit;
    if ((stretched || hot) && !S.trail) return sell(S, s, L, l, b.close, `${stretched ? `stretched ${S.stretchAtr} ATR over its 20-day average` : `RSI ${t!.rsi14!.toFixed(0)}`} on ${b.date}`);
    if (S.trail) {
      if (m.tagged && i > 0 && b.close < bars[i - 1].low) return sell(S, s, L, l, b.close, `closed at ${r2(b.close)} under the prior day's low after the run (${b.date})`);
      if (stretched || hot || (S.trailArm !== undefined && b.close >= l.cost * (1 + S.trailArm * m.atr))) m.tagged = true;
    }
    m.peak = Math.max(m.peak, b.close / l.cost);
    if (S.maxDays !== undefined && (Date.parse(b.date) - Date.parse(l.opened)) / 864e5 >= S.maxDays) return sell(S, s, L, l, b.close, `held ${S.maxDays} days (${b.date})`);
  }
}

/**
 * A run day's first swing step, at the close and before the wheel acts: play the resting buys and the exits through
 * today's bars. `inp.cands` is the week's Sunday report.
 */
export function swingWalk(rs: Ruleset, s: RaceState, L: SwingLedger, day: "monday" | "wednesday" | "friday", date: string, spots: Record<string, number>, inp: SwingInput | undefined) {
  const S = swingOf(rs);
  if (!S || !inp) return;
  const st = stateOf(s);
  const slip = S.slip ?? 0.0005;
  const cands = inp.cands;

  // 1. resting buys, then exits, through today
  for (const p of [...st.pending]) {
    const bars = inp.bars[p.symbol];
    if (!bars) continue;
    for (const b of bars) {
      if (b.date <= p.placed || b.date > date) continue;
      const px = b.open <= p.limit ? b.open : b.low <= p.limit ? p.limit : null;
      if (px === null) continue;
      const fill = px * (1 + slip);
      s.cash -= fill * p.shares;
      st.pending = st.pending.filter((x) => x.id !== p.id);
      const lot: SwingLot = { id: p.id, symbol: p.symbol, theme: p.theme, shares: p.shares, cost: fill, mark: b.close, opened: b.date, swing: { atr: p.atr, floor: p.floor === null ? null : p.floor / fill, peak: b.close / fill, tagged: false, lastDay: b.date, source: "swing" } };
      s.lots.push(lot);
      L.add("Bought shares" as Action, { symbol: p.symbol, type: "shares", qty: p.shares, price: r2(fill), cash: -fill * p.shares, position_id: p.id, note: `Swing: limit ${r2(p.limit)} filled on ${b.date}` });
      break;
    }
  }
  const calls = new Set(s.options.filter((x) => x.type === "call").map((x) => x.symbol));
  for (const l of [...s.lots] as SwingLot[]) {
    if (!l.swing) continue;
    const bars = inp.bars[l.symbol];
    if (bars) walkLot(rs, S, s, L, l, bars, date, calls.has(l.symbol));
  }
  if (S.exitDowntrend && day === "monday")
    for (const l of [...s.lots] as SwingLot[]) if (l.swing && !calls.has(l.symbol) && cands.find((c) => c.symbol === l.symbol)?.stage === "Downtrend") sell(S, s, L, l, spots[l.symbol] ?? l.mark, "Downtrend on Sunday's report");
  if (day === "friday") st.pending = st.pending.filter((p) => p.placed >= date); // unfilled buys lapse at Friday's close
  for (const l of s.lots) {
    const c = inp.bars[l.symbol]?.at(-1);
    if (c && c.date === date) l.mark = c.close;
  }
}

/**
 * A run day's second swing step, after the wheel: on an entry day, open new positions in `ranked` order (the Sunday
 * report's eligible names). `inp.riskOn` is the ruleset's regime gate as of the close before.
 */
export function swingEnter(rs: Ruleset, maxLeverage: number, s: RaceState, L: SwingLedger, day: "monday" | "wednesday" | "friday", date: string, ranked: CandidateRow[], spots: Record<string, number>, inp: SwingInput | undefined) {
  const S = swingOf(rs);
  if (!S || !inp) return;
  const st = stateOf(s);
  const slip = S.slip ?? 0.0005;
  if (!(S.entryDays ?? ["monday"]).includes(day) || (S.regime && !inp.riskOn)) return;
  const marks = Object.fromEntries(s.lots.map((l) => [l.symbol, l.mark]));
  const sp = { ...marks, ...spots };
  const v = accountValue(s, sp);
  let swingExp = swingExposure(s, sp);
  let total = exposure(s, sp) + st.pending.reduce((a, p) => a + p.limit * p.shares, 0);
  let names = s.lots.filter(isSwingLot).length + st.pending.length;
  const taken = new Set([...s.lots.map((l) => l.symbol), ...st.pending.map((p) => p.symbol)]);
  const pool: { c: CandidateRow; t: Tech; f: Record<string, number | null> }[] = [];
  for (const c of ranked) {
    if (taken.has(c.symbol)) continue;
    const bars = inp.bars[c.symbol];
    if (!bars || bars.at(-1)!.date !== date) continue;
    const t = techAt(rs.rules, bars);
    if (!t || t.atr === null || !(t.atr > 0)) continue;
    const f = features(t, c);
    if (S.filters && !Object.entries(S.filters).every(([k, [lo, hi]]) => f[k] !== null && f[k] !== undefined && (lo === null || f[k]! >= lo) && (hi === null || f[k]! <= hi))) continue;
    pool.push({ c, t, f });
  }
  if (S.rank && S.rank !== "score") {
    const k = S.rank.replace(/^-/, "");
    const sign = S.rank.startsWith("-") ? 1 : -1;
    pool.sort((a, b) => sign * ((a.f[k] ?? Infinity * -sign) - (b.f[k] ?? Infinity * -sign)));
  }
  for (const { c, t } of pool) {
    if (names >= S.maxNames) break;
    const px = t.last;
    const limit = S.entry === "limit" ? px - (S.limitAtr ?? 1) * t.atr! : px;
    if (!(limit > 0)) continue;
    const size = S.volTarget !== undefined ? S.perName * Math.min(1, S.volTarget / (t.atr! / px)) : S.perName;
    const room = Math.min(size * v, S.exposure * v - swingExp, maxLeverage * v - total);
    const n = Math.floor(room / limit);
    if (n < 1) {
      if (Math.min(S.exposure * v - swingExp, maxLeverage * v - total) < limit) break;
      continue;
    }
    const id = L.id("w");
    const atr = t.atr! / px;
    if (S.entry === "limit") {
      st.pending.push({ id, symbol: c.symbol, theme: c.theme, limit, shares: n, atr, floor: t.floor, placed: date });
      L.add("Skipped", { symbol: c.symbol, type: "shares", qty: n, price: r2(limit), position_id: id, note: `Swing: limit buy at ${r2(limit)} (${S.limitAtr ?? 1} ATR under ${r2(px)}) until Friday; score ${c.score}` });
    } else {
      const fill = px * (1 + slip);
      s.cash -= fill * n;
      const lot: SwingLot = { id, symbol: c.symbol, theme: c.theme, shares: n, cost: fill, mark: px, opened: date, swing: { atr, floor: t.floor === null ? null : t.floor / fill, peak: 1, tagged: false, lastDay: date, source: "swing" } };
      s.lots.push(lot);
      L.add("Bought shares" as Action, { symbol: c.symbol, type: "shares", qty: n, price: r2(fill), cash: -fill * n, position_id: id, note: `Swing: bought at the close; score ${c.score}, RSI ${t.rsi14?.toFixed(0)}, %B ${t.pctB?.toFixed(2)}` });
    }
    swingExp += limit * n;
    total += limit * n;
    names += 1;
    taken.add(c.symbol);
  }
}

/** Wheel + swing: tag a freshly assigned lot so the swing exits manage it (levers.swing.adoptAssigned). */
export function adoptLot(rs: Ruleset, l: Lot, bars: Bar[] | undefined, date: string) {
  const S = swingOf(rs);
  if (!S?.adoptAssigned) return;
  const t = bars && bars.length > 15 ? techAt(rs.rules, bars) : null;
  const atr = t?.atr ? t.atr / t.last : 0.03;
  (l as SwingLot).swing = { atr, floor: t?.floor ? t.floor / l.cost : null, peak: l.mark / l.cost, tagged: false, lastDay: date, source: "assigned" };
}
