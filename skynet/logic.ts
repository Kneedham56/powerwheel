/**
 * The ruleset's decision math with the ruleset passed in, for the backtest.
 *
 * src/lib/rules.ts and src/lib/prep.ts read the global RULES, and Skynet must not change them, so the functions that
 * read RULES are mirrored here with a `Rules` argument. Functions that don't read RULES are imported as they are.
 * `npm run skynet -- parity` checks that these give the same answers as src/lib with the live ruleset: run it after
 * any change to rules.ts or prep.ts, and update this file when it fails.
 *
 * Pure functions only.
 */
import type { CandidateRow } from "../src/lib/prep";
import {
  FUNDS,
  SECTOR_FUND,
  STAGE_RANK,
  daysTo,
  earningsBefore,
  expectedMove,
  midOf,
  quadrant,
  rel,
  ymd,
  type Bar,
  type OptionQuote,
  type PutCall,
  type Quadrant,
  type ScoreInput,
  type ScoreParts,
  type Stage,
  type Tech,
} from "../src/lib/rules";
import type { AdaptLevers, PrepLevers, Rules } from "./rulesets";

// ---------------------------------------------------------------------------
// indicators (rules.ts techAt)
// ---------------------------------------------------------------------------

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function sma(closes: number[], n: number, end = closes.length): number | null {
  if (end < n) return null;
  return mean(closes.slice(end - n, end));
}

function ret(closes: number[], n: number, end = closes.length): number | null {
  const i = end - 1 - n;
  if (i < 0 || !closes[i]) return null;
  return closes[end - 1] / closes[i] - 1;
}

export function techAt(R: Rules, bars: Bar[], end = bars.length): Tech | null {
  if (end < 2) return null;
  const b = bars.slice(0, end);
  const closes = b.map((x) => x.close);
  const last = closes[closes.length - 1];
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);

  let pctB: number | null = null;
  if (s20 !== null) {
    const win = closes.slice(-20);
    const sd = Math.sqrt(mean(win.map((c) => (c - s20) ** 2)));
    pctB = sd > 0 ? (last - (s20 - 2 * sd)) / (4 * sd) : 0.5;
  }

  let rsi14: number | null = null;
  if (closes.length > 15) {
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gain += d;
      else loss -= d;
    }
    gain /= 14;
    loss /= 14;
    for (let i = 15; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * 13 + Math.max(d, 0)) / 14;
      loss = (loss * 13 + Math.max(-d, 0)) / 14;
    }
    rsi14 = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }

  const n = R.strike.atrDays;
  let atr: number | null = null;
  if (b.length > n) {
    const trs: number[] = [];
    for (let i = b.length - n; i < b.length; i++) {
      const prev = b[i - 1].close;
      trs.push(Math.max(b[i].high - b[i].low, Math.abs(b[i].high - prev), Math.abs(b[i].low - prev)));
    }
    atr = mean(trs);
  }

  const fl = b.slice(-R.strike.floorLookback);
  const floor = fl.length ? Math.min(...fl.map((x) => x.low)) : null;
  const yr = b.slice(-252);
  const high52 = yr.length ? Math.max(...yr.map((x) => x.high)) : null;

  let realizedVol: number | null = null;
  if (closes.length > 21) {
    const lr = closes.slice(-21).slice(1).map((c, i) => Math.log(c / closes[closes.length - 21 + i]));
    const m = mean(lr);
    realizedVol = Math.sqrt(mean(lr.map((x) => (x - m) ** 2))) * Math.sqrt(252);
  }

  return {
    last,
    date: b[b.length - 1].date,
    sma20: s20,
    sma50: s50,
    sma200: s200,
    vs50: s50 ? last / s50 - 1 : null,
    vs200: s200 ? last / s200 - 1 : null,
    ma50vs200: s50 && s200 ? s50 / s200 - 1 : null,
    pctB,
    rsi14,
    atr,
    floor,
    ret1w: ret(closes, 5),
    ret4w: ret(closes, R.momentumDays),
    ret13w: ret(closes, R.trendDays),
    high52,
    offHigh: high52 ? last / high52 - 1 : null,
    realizedVol,
  };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

export function stage(R: Rules, rs4: number | null, rs13: number | null, t: Pick<Tech, "vs50" | "vs200" | "ma50vs200">): Stage {
  if (rs4 === null || rs13 === null || t.vs50 === null || t.vs200 === null) return "Unknown";
  if (rs13 >= 0 && rs4 >= 0 && t.vs50 >= 0 && t.vs200 > 0) return "Leader";
  if (rs13 >= 0 && t.vs200 > 0 && t.vs50 >= -R.pullbackWithin50d) return "Leader pulling back";
  if (rs4 >= 0 && t.vs50 >= 0) return "Turning up";
  if (rs13 < 0 && (t.vs200 <= 0 || (t.ma50vs200 !== null && t.ma50vs200 < 0))) return "Downtrend";
  return "Breaking down";
}

export function inNeverSellZone(R: Rules, t: Pick<Tech, "pctB" | "vs200">) {
  return t.pctB !== null && t.vs200 !== null && t.pctB <= R.neverSellMaxPctB && t.vs200 < 0;
}

export function trendQualifies(st: Stage, t: Pick<Tech, "vs200">) {
  return st === "Leader" || st === "Leader pulling back" || (st === "Turning up" && (t.vs200 ?? 0) > 0);
}

const middleBand = (R: Rules, t: Pick<Tech, "pctB" | "vs200">) => (t.vs200 ?? 0) > 0 && t.pctB !== null && t.pctB >= R.neverSellMaxPctB && t.pctB <= 0.6;

/** rules.ts putCall, with the labels kept short (the backtest doesn't print earnings day names). */
export function putCall(
  R: Rules,
  args: { stage: Stage; tech: Pick<Tech, "pctB" | "vs200">; weeklies: boolean; earnings: { date: string; timing: string | null } | null; expiry: string },
): PutCall {
  const { stage: st, tech, weeklies, earnings, expiry } = args;
  if (inNeverSellZone(R, tech)) return { label: "Never sell puts here", pref: 10 };
  const keep = trendQualifies(st, tech);
  if (keep && !weeklies) return { label: "No weekly options", pref: 5 };
  if (keep && earnings && earningsBefore(earnings, expiry)) return { label: `Earnings ${earnings.date}`, pref: 4 };
  if (keep && st === "Turning up") return { label: "Small, far strike", pref: 3 };
  if (keep && middleBand(R, tech)) return { label: "Best: pullback to middle band", pref: 1 };
  if (keep) return { label: "Sell puts", pref: 2 };
  if (st === "Turning up") return { label: "Wait for the 200-day", pref: 6 };
  if (st === "Breaking down") return { label: "No new puts", pref: 7 };
  if (st === "Downtrend") return { label: "Skip", pref: 8 };
  return { label: "No trend data", pref: 9 };
}

// ---------------------------------------------------------------------------
// dates, strike and premium
// ---------------------------------------------------------------------------

export function targetExpiry(R: Rules, from: string) {
  const d = new Date(`${from}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + R.pick.minExpiryDays);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d);
}

export function targetStrike(R: Rules, t: Pick<Tech, "last" | "floor" | "atr">, move: number | null) {
  if (move === null) return null;
  const base = t.last - move;
  if (t.floor === null || t.atr === null) return base;
  const lowEdge = t.floor - R.strike.atrBelowFloor * t.atr;
  return base <= t.floor && base > lowEdge ? lowEdge : base;
}

export function realMarket(R: Rules, q: OptionQuote) {
  const mid = midOf(q);
  if (!q.bid || q.bid <= 0 || mid === null || q.ask === null) return false;
  if (q.ask - q.bid > Math.max(R.pick.maxSpreadOfMid * mid, R.pick.minSpreadAbs)) return false;
  return (q.openInterest ?? 0) >= R.pick.minOpenInterest;
}

export function chooseStrike(R: Rules, quotes: OptionQuote[], target: number | null) {
  if (target === null) return null;
  const ok = quotes.filter((q) => q.strike <= target && realMarket(R, q));
  return ok.length ? ok.reduce((a, b) => (b.strike > a.strike ? b : a)) : null;
}

export function weeklyPremium(q: OptionQuote, from: string) {
  const mid = midOf(q);
  if (mid === null || !q.strike) return null;
  const weeks = Math.max(1, Math.ceil(daysTo(from, q.expiry) / 7));
  return mid / q.strike / weeks;
}

export function score(R: Rules, inp: ScoreInput): { total: number; parts: ScoreParts; checkWhy: boolean } {
  const W = R.score;
  const trend = W.trend[inp.stage] ?? 0;
  const rotation = inp.groupQuadrant ? W.rotation[inp.groupQuadrant] : W.rotationUnknown;

  const b = inp.tech.pctB;
  let location = 0;
  if (b !== null) {
    if (b > 0.8) location = W.location.stretched;
    else if (b > 0.6) location = W.location.upper;
    else if (b >= R.neverSellMaxPctB) location = W.location.middle;
    else if ((inp.tech.vs200 ?? 0) > 0) location = W.location.lowerInUptrend;
  }

  let premium = 0;
  if (inp.premiumWeekly !== null) premium = Math.min(W.premiumMax, (inp.premiumWeekly / R.premium.targetWeekly) * W.premiumMax * 0.7);
  else if (inp.ivRank !== null) premium = inp.ivRank * W.premiumMax * 0.7;

  const liquidity = inp.liquidity === null ? W.liquidityMax / 2 : inp.liquidity * W.liquidityMax;
  const checkWhy = inp.premiumWeekly !== null && inp.premiumWeekly > R.premium.checkWhyWeekly;
  const penalty = checkWhy ? W.checkWhyPenalty : 0;

  const parts = { trend, rotation, location, premium, liquidity, penalty };
  const total = Math.max(0, Math.min(100, Math.round(trend + rotation + location + premium + liquidity - penalty)));
  return { total, parts, checkWhy };
}

// ---------------------------------------------------------------------------
// the Sunday report's candidate list (prep.ts buildSunday, the parts the race reads)
// ---------------------------------------------------------------------------

export interface CandidateMeta {
  name?: string;
  sector?: string;
  /** passes the size test (prep: market cap ≥ minMarketCap; funds always pass). The backtest has no history of market caps. */
  bigEnough?: boolean;
  marketCap?: number | null;
  iv?: number | null;
  ivRank?: number | null;
  weeklies?: boolean;
  earnings?: { date: string; timing: string | null } | null;
  optionsVolume?: number | null;
  /** Skynet only: front-week ATM IV ÷ the next expiry's (feed.termRatio), the earnings stand-in */
  termRatio?: number | null;
}

export interface CandidateInputs {
  runDate: string;
  bars: Record<string, Bar[]>; // split-adjusted to runDate, oldest first, through the last close before runDate
  meta: Record<string, CandidateMeta>;
  /** watchlist names first (prep keeps them even when not eligible), then other stocks */
  watchlist: string[];
  scanSymbols: string[];
  quotes: Record<string, OptionQuote[]>;
  /** Skynet only (the adaptive report): VIX closes through Friday, oldest first */
  vix?: number[];
}

export interface RotationRow {
  symbol: string;
  quadrant: Quadrant;
}

/** Features the prep levers read (rulesets.ts PrepLevers). Missing inputs leave a feature out. */
/** A per-name, per-date number in [0, 1) with no market information (a placebo filter or bonus). */
function hashRand(symbol: string, date: string) {
  let h = 2166136261;
  for (const ch of `${symbol}|${date}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (Math.imul(h ^ (h >>> 15), 2246822519) >>> 0) / 2 ** 32;
}

export function prepFeatures(t: Tech, bars: Bar[], m: CandidateMeta, put: OptionQuote | null, rs4: number | null, rs13: number | null, from: string, symbol = ""): Record<string, number> {
  const c = bars.map((b) => b.close);
  const f: Record<string, number | null> = {
    ret6m: c.length > 126 ? c.at(-1)! / c[c.length - 127] - 1 : null,
    ret12m: c.length > 252 ? c.at(-1)! / c[c.length - 253] - 1 : null,
    rv20: t.realizedVol,
    rv60: null,
    ivrv: m.iv && t.realizedVol ? m.iv / t.realizedVol : null,
    iv: m.iv ?? null,
    ivRank: m.ivRank ?? null,
    offHigh: t.offHigh,
    worst60: null,
    toFloor: t.floor ? t.last / t.floor - 1 : null,
    rsi: t.rsi14,
    pctB: t.pctB,
    vs50: t.vs50,
    vs200: t.vs200,
    rs4,
    rs13,
    weekly: put ? weeklyPremium(put, from) : null,
    otm: put ? 1 - put.strike / t.last : null,
    price: t.last,
    term: m.termRatio ?? null,
    rand: hashRand(symbol, from),
  };
  if (c.length > 61) {
    const lr = c.slice(-61).slice(1).map((x, i) => Math.log(x / c[c.length - 61 + i]));
    const mu = mean(lr);
    f.rv60 = Math.sqrt(mean(lr.map((x) => (x - mu) ** 2))) * Math.sqrt(252);
    let w = 0;
    for (let i = c.length - 60; i < c.length; i++) w = Math.min(w, c[i] / c[i - 5] - 1);
    f.worst60 = w;
  }
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && Number.isFinite(v))) as Record<string, number>;
}

// ---------------------------------------------------------------------------
// regime features for the adaptive report (rulesets.ts AdaptLevers), from bars through Friday only
// ---------------------------------------------------------------------------

const ramp01 = (v: number, a: number, b: number) => Math.max(0, Math.min(1, (v - a) / (b - a)));
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/**
 * Market-regime features as of the last bar (Friday's close). Every number reads bars at or before that close: the
 * momentum spread looks at cohorts formed `horizon` weeks or more ago and their returns up to Friday at most.
 */
export function regimeFeatures(bars: Record<string, Bar[]>, stocks: string[], vix: number[] | undefined, A: Pick<AdaptLevers, "mom" | "crash">): Record<string, number> {
  const spyB = bars.SPY;
  const out: Record<string, number> = {};
  if (!spyB?.length) return out;
  const spy = spyB.map((b) => b.close);
  const E = spy.length;
  const last = spy[E - 1];
  const lastDate = spyB[E - 1].date;

  // SPY trend and the crash setup
  const s200 = sma(spy, 200);
  if (s200) out.spyVs200 = last / s200 - 1;
  const r4 = ret(spy, 20);
  const r13 = ret(spy, 63);
  if (r4 !== null) out.spyRet4 = r4;
  if (r13 !== null) out.spyRet13 = r13;
  const hi6 = Math.max(...spy.slice(-126));
  out.spyDd = last / hi6 - 1;
  const C = { drop: 0.1, weeks: 8, bounce: 0.05, lag: 0, ...A.crash };
  {
    // lag: the same test as of `lag` weeks earlier (a placebo with the right shape and the wrong timing)
    const sp = spy.slice(0, Math.max(1, E - 5 * C.lag));
    const n = sp.length;
    let worst = 0;
    let lowAt = -1;
    for (let j = Math.max(0, n - C.weeks * 5); j < n; j++) {
      const peak = Math.max(...sp.slice(Math.max(0, j - 126), j + 1));
      const dd = sp[j] / peak - 1;
      if (dd < worst) {
        worst = dd;
        lowAt = j;
      }
    }
    out.crashDrop = worst;
    out.crashBounce = lowAt >= 0 ? sp[n - 1] / sp[lowAt] - 1 : 0;
    out.crash = worst <= -C.drop && out.crashBounce >= C.bounce ? 1 : 0;
  }

  // placebo for switch rules: a coin flip from the date alone (no market information)
  out.coin = (Math.imul(Number(lastDate.replaceAll("-", "")), 2654435761) >>> 20) & 1;
  out.u = (Math.imul(Number(lastDate.replaceAll("-", "")) ^ 0x5bd1e995, 2246822519) >>> 0) / 2 ** 32;

  if (vix?.length) {
    out.vix = vix[vix.length - 1];
    if (vix.length >= 50) out.vixVs50 = out.vix / mean(vix.slice(-50)) - 1;
  }

  // stocks aligned to SPY's calendar: the same last date, then index from the end
  const M = { weeks: 13, horizon: 4, top: 1 / 3, ...A.mom };
  const H = M.horizon * 5;
  const al: number[][] = [];
  for (const s of stocks) {
    const b = bars[s];
    if (!b || b.length < 30 || b[b.length - 1].date !== lastDate) continue;
    al.push(b.map((x) => x.close));
  }
  // breadth and dispersion now
  let up = 0;
  let n200 = 0;
  const r20: number[] = [];
  for (const c of al) {
    const m = sma(c, 200);
    if (m) {
      n200++;
      if (c[c.length - 1] > m) up++;
    }
    const r = ret(c, 20);
    if (r !== null && Number.isFinite(r)) r20.push(Math.max(-0.6, Math.min(1.5, r)));
  }
  if (n200) out.breadth = up / n200;
  if (r20.length > 20) out.disp = sd(r20);

  // momentum spread: cohorts cut at E-1-5k (k = horizon .. horizon+weeks-1), scored on Azir's momentum at the cut,
  // judged by the return from the cut to `horizon` weeks later (at or before Friday)
  const spreads: number[] = [];
  for (let k = M.horizon; k < M.horizon + M.weeks; k++) {
    const back = 5 * k; // bars back from the end to the cut
    const cutS = E - 1 - back;
    if (cutS < 64) break;
    const spyRet13 = spy[cutS] / spy[cutS - 63] - 1;
    const rows: { m: number; f: number }[] = [];
    for (const c of al) {
      const cut = c.length - 1 - back;
      if (cut < 200) continue;
      const m200 = sma(c, 200, cut + 1)!;
      const vs200 = c[cut] / m200 - 1;
      if (vs200 <= 0) continue; // the candidate pool is uptrending names
      const rs13 = c[cut] / c[cut - 63] - 1 - spyRet13;
      const f = c[cut + H] / c[cut] - 1;
      if (!Number.isFinite(f) || !Number.isFinite(rs13)) continue;
      rows.push({ m: ramp01(vs200, 0, 0.5) + ramp01(rs13, 0, 0.3), f: Math.max(-0.6, Math.min(1.5, f)) });
    }
    if (rows.length < 20) continue;
    rows.sort((a, b) => b.m - a.m);
    const nTop = Math.max(1, Math.round(rows.length * M.top));
    spreads.push(mean(rows.slice(0, nTop).map((r) => r.f)) - mean(rows.slice(nTop).map((r) => r.f)));
  }
  if (spreads.length) {
    out.mom = mean(spreads);
    out.momHit = spreads.filter((x) => x > 0).length / spreads.length;
    out.momLast = spreads[0];
  }
  return out;
}

/** Every feature inside its [min, max] (null = no bound; a missing feature fails). */
const holds = (when: Record<string, [number | null, number | null]> | undefined, f: Record<string, number>) =>
  Object.entries(when ?? {}).every(([k, [lo, hi]]) => f[k] !== undefined && (lo === null || f[k] >= lo) && (hi === null || f[k] <= hi));

/** Which ranking the adaptive report uses this Sunday. */
export function adaptChoice(A: AdaptLevers, f: Record<string, number>): "alt" | "base" | "blend" {
  if (A.mode !== "switch") return A.mode;
  return holds(A.when, f) ? "alt" : (A.otherwise ?? "base");
}

export function buildCandidates(
  R: Rules,
  inp: CandidateInputs,
  P?: PrepLevers,
): { expiry: string; rotation: RotationRow[]; candidates: CandidateRow[]; regime?: { choice: "alt" | "base" | "blend"; features: Record<string, number> } } {
  const { bars, meta } = inp;
  if (!bars.SPY?.length) throw new Error(`No SPY bars before ${inp.runDate}.`);
  const spy = techAt(R, bars.SPY)!;
  const expiry = targetExpiry(R, inp.runDate);
  const days = daysTo(inp.runDate, expiry);

  const rotation: RotationRow[] = [];
  for (const symbol of Object.keys(FUNDS)) {
    const b = bars[symbol];
    if (!b?.length) continue;
    const t = techAt(R, b)!;
    const q = quadrant(rel(t.ret13w, spy.ret13w), rel(t.ret4w, spy.ret4w));
    if (q) rotation.push({ symbol, quadrant: q });
  }
  const quad = new Map(rotation.map((r) => [r.symbol, r.quadrant]));

  const watch = new Set(inp.watchlist);
  const order: { symbol: string; source: CandidateRow["source"] }[] = [
    ...inp.watchlist.map((s) => ({ symbol: s, source: "Watchlist" as const })),
    ...inp.scanSymbols.filter((s) => !watch.has(s) && !FUNDS[s]).map((s) => ({ symbol: s, source: "Scan" as const })),
    ...Object.keys(FUNDS).filter((s) => !watch.has(s)).map((s) => ({ symbol: s, source: "Fund" as const })),
  ];
  const seen = new Set<string>();
  const candidates: CandidateRow[] = [];
  const A = P?.adapt;
  const RA: Rules | null = A ? { ...R, score: { ...R.score, ...A.alt.score } } : null;
  const altScore = new Map<CandidateRow, number>();
  const baseScore = new Map<CandidateRow, number>();
  const withBonus = (raw: number, feat: Record<string, number>, bonus: Record<string, [number, number, number]> | undefined, cap: number | undefined) => {
    let extra = 0;
    for (const [k, [a, b, pts]] of Object.entries(bonus ?? {})) {
      const v = feat[k];
      if (v === undefined || a === b) continue;
      extra += pts * Math.max(0, Math.min(1, (v - a) / (b - a)));
    }
    return Math.max(0, Math.min(cap ?? 100, Math.round(raw + extra)));
  };
  const rawOf = (p: ScoreParts) => p.trend + p.rotation + p.location + p.premium + p.liquidity - p.penalty;
  for (const { symbol, source } of order) {
    if (seen.has(symbol) || !bars[symbol]?.length) continue;
    seen.add(symbol);
    const t = techAt(R, bars[symbol])!;
    const m = meta[symbol] ?? {};
    const fund = FUNDS[symbol];
    const rs4 = rel(t.ret4w, spy.ret4w);
    const rs13 = rel(t.ret13w, spy.ret13w);
    const st = stage(R, rs4, rs13, t);
    const e = m.earnings && m.earnings.date >= inp.runDate ? m.earnings : null;
    const weeklies = m.weeklies ?? !!fund;
    const call = putCall(R, { stage: st, tech: t, weeklies, earnings: e, expiry });
    const group = fund ? symbol : m.sector ? (SECTOR_FUND[m.sector] ?? null) : null;
    const groupQ = group ? (quad.get(group) ?? null) : null;
    const theme = fund ? fund.theme : (m.sector ?? "Other");
    const bigEnough = !!fund || (m.bigEnough ?? (m.marketCap ?? 0) >= R.pick.minMarketCap);
    const move = expectedMove(t, m.iv ?? null, days);
    const target = targetStrike(R, t, move);
    const flags: string[] = [];

    const qs = (inp.quotes[symbol] ?? []).filter((q) => q.expiry === expiry || inp.quotes[symbol]?.every((x) => x.expiry !== expiry));
    const chosen = chooseStrike(R, qs, target);
    const prem = chosen ? weeklyPremium(chosen, inp.runDate) : null;
    if (qs.length && !chosen) flags.push("No real market");
    if (chosen && chosen.expiry !== expiry) flags.push("No weekly that Friday");
    if (!bigEnough && call.pref <= 3) flags.push("Under $20B: watch only");
    const fundOut = !!fund && groupQ !== "Leading" && groupQ !== "Improving" && P?.fundGate !== false;
    if (fundOut && call.pref <= 3) flags.push(`Fund is ${groupQ ?? "unranked"}: no new puts`);

    let eligible = call.pref <= 3 && bigEnough && !fundOut && !(qs.length && !chosen) && !(chosen && chosen.expiry !== expiry);
    const feat = P ? prepFeatures(t, bars[symbol], m, chosen, rs4, rs13, inp.runDate, symbol) : null;
    if (P && eligible) {
      if (P.turningUp === false && call.pref === 3) eligible = false;
      for (const [k, [lo, hi]] of Object.entries(P.filters ?? {})) {
        const v = feat![k];
        if (v === undefined || (lo !== null && v < lo) || (hi !== null && v > hi)) {
          eligible = false;
          flags.push(`Prep filter: ${k}`);
          break;
        }
      }
    }
    let liquidity: number | null = null;
    if (chosen) liquidity = (chosen.ask! - chosen.bid!) / midOf(chosen)! <= 0.1 ? 1 : 0.6;
    else if (m.optionsVolume) liquidity = m.optionsVolume >= 50000 ? 0.9 : m.optionsVolume >= 10000 ? 0.7 : m.optionsVolume >= 2000 ? 0.5 : 0.3;
    const scIn: ScoreInput = { stage: st, tech: t, groupQuadrant: groupQ, premiumWeekly: prem, ivRank: m.ivRank ?? null, liquidity };
    const sc = call.pref <= 3 ? score(R, scIn) : null;
    if (sc?.checkWhy) flags.push("Check why: over 2% a week");
    if (sc && P) sc.total = withBonus(rawOf(sc.parts), feat!, P.bonus, P.maxScore);
    const alt = sc && A ? withBonus(rawOf(score(RA!, scIn).parts), feat!, A.alt.bonus, A.alt.maxScore) : null;

    if (source === "Scan" && !eligible) continue;
    if (source === "Fund" && (call.pref > 3 || fundOut)) continue;

    candidates.push({
      symbol,
      name: fund?.name ?? m.name ?? symbol,
      source,
      list: "",
      theme,
      group,
      group_quadrant: groupQ,
      last: t.last,
      week: t.ret1w,
      stage: st,
      stage_rank: STAGE_RANK[st],
      put_call: call.label,
      pref: call.pref,
      rs4,
      rs13,
      vs50: t.vs50,
      vs200: t.vs200,
      pct_b: t.pctB,
      rsi: t.rsi14,
      iv: m.iv ?? null,
      iv_rank: m.ivRank ?? null,
      exp_move: move,
      floor: t.floor,
      target_strike: target,
      to_target: null,
      eligible,
      score: sc?.total ?? null,
      parts: sc?.parts ?? null,
      flags,
    });
    if (alt !== null) {
      altScore.set(candidates.at(-1)!, alt);
      baseScore.set(candidates.at(-1)!, sc!.total);
    }
  }
  const byRank = (a: CandidateRow, b: CandidateRow) =>
    Number(b.eligible) - Number(a.eligible) || (b.score ?? -1) - (a.score ?? -1) || a.pref - b.pref || (b.rs13 ?? -9) - (a.rs13 ?? -9);
  if (!A) {
    candidates.sort(byRank);
    return { expiry, rotation, candidates };
  }

  const features = regimeFeatures(bars, inp.scanSymbols, inp.vix, A);
  const choice = adaptChoice(A, features);
  const ranked = adaptiveOrder(A, choice, features, candidates, altScore, baseScore, byRank);
  return { expiry, rotation, candidates: trimList(A, features, ranked), regime: { choice, features } };
}

/** The adaptive report's order: one ranking's scores, or the two interleaved (blend). Mutates the rows' scores. */
function adaptiveOrder(
  A: AdaptLevers,
  choice: "alt" | "base" | "blend",
  features: Record<string, number>,
  candidates: CandidateRow[],
  altScore: Map<CandidateRow, number>,
  baseScore: Map<CandidateRow, number>,
  byRank: (a: CandidateRow, b: CandidateRow) => number,
): CandidateRow[] {
  const scored = (m: Map<CandidateRow, number>) => {
    for (const [c, v] of m) c.score = v;
    return [...candidates].sort(byRank);
  };
  if (choice !== "blend") return scored(choice === "alt" ? altScore : baseScore);

  // blend: interleave the two orders (each slot goes to the ranking behind on its share), no duplicates. A name keeps
  // the score of the ranking that placed it; the engine keeps this order (engine.ts ranked).
  const share = A.blendShare ?? 0.5;
  const byAlt = scored(altScore).filter((c) => c.eligible && c.score !== null);
  const altOf = new Map(byAlt.map((c) => [c.symbol, c.score!]));
  const byBase = scored(baseScore).filter((c) => c.eligible && c.score !== null);
  const out: CandidateRow[] = [];
  const placed = new Set<string>();
  const next = (list: CandidateRow[], from: number) => {
    let k = from;
    while (k < list.length && placed.has(list[k].symbol)) k++;
    return k;
  };
  let ia = 0;
  let ib = 0;
  let nAlt = 0;
  while (out.length < byAlt.length) {
    const takeAlt = (nAlt + 1) / (out.length + 1) <= share + 1e-9;
    if (takeAlt) ia = next(byAlt, ia);
    else ib = next(byBase, ib);
    const c = takeAlt ? byAlt[ia] : byBase[ib];
    if (!c) break;
    c.score = takeAlt ? altOf.get(c.symbol)! : baseScore.get(c)!;
    placed.add(c.symbol);
    out.push(c);
    if (takeAlt) nAlt++;
  }
  const rest = candidates.filter((c) => !placed.has(c.symbol));
  for (const c of rest) if (baseScore.has(c)) c.score = baseScore.get(c)!;
  return [...out, ...rest.sort(byRank)];
}

/** trim: in the named regime only the top `keep` names stay eligible. */
function trimList(A: AdaptLevers, features: Record<string, number>, list: CandidateRow[]) {
  if (!A.trim || !holds(A.trim.when, features)) return list;
  let n = 0;
  for (const c of list) {
    if (!c.eligible || c.score === null || c.target_strike === null) continue;
    if (++n > A.trim.keep) {
      c.eligible = false;
      c.flags.push("Trimmed: regime");
    }
  }
  return list;
}

