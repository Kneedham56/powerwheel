/**
 * The ruleset: thresholds, weights and the math that applies them.
 *
 * Single source of truth for every decision (Sunday prep, the Wednesday check, the AI-vs-Kyle race).
 * docs/RULES.md is the plain-words half and carries the same version. When a rule changes, change both,
 * bump RULES_VERSION and add a changelog line to RULES.md.
 *
 * Pure functions only: no Next.js, no database, no network (scripts import this directly).
 */

export const RULES_VERSION = "2026.11.22";

export const RULES = {
  /** trading days used for the rotation map and the trend stage (≈ 4 and 13 weeks) */
  momentumDays: 20,
  trendDays: 63,
  /** "Leader pulling back": within this far below the 50-day */
  pullbackWithin50d: 0.05,
  /** never sell puts below the 200-day with band position at or under this */
  neverSellMaxPctB: 0.2,
  pick: {
    minMarketCap: 20e9, // stocks only; funds of any size
    minExpiryDays: 4, // first Friday at least this many days out
    maxSpreadOfMid: 0.2,
    minSpreadAbs: 0.1, // a spread this wide is fine on cheap options
    minOpenInterest: 100,
  },
  strike: {
    floorLookback: 20, // the floor = lowest low of the last N sessions
    atrBelowFloor: 1, // never within this many ATRs of the floor
    atrDays: 14,
  },
  premium: {
    targetWeekly: 0.005,
    checkWhyWeekly: 0.02,
  },
  score: {
    trend: { "Leader pulling back": 30, Leader: 26, "Turning up": 15 } as Record<string, number>,
    rotation: { Leading: 15, Improving: 10, Weakening: 3, Lagging: 0 } as Record<string, number>,
    rotationUnknown: 6,
    location: { middle: 25, upper: 18, stretched: 10, lowerInUptrend: 12 },
    premiumMax: 20,
    liquidityMax: 10,
    checkWhyPenalty: 10,
  },
  top: { count: 5, maxPerSector: 2 },
  techBottom: { smhLow: 448, hygAbove: 77.5, tltAbove: 80.2 },
} as const;

/**
 * The AI's playbook in the paper race (RULES.md section 10). Everything in RULES applies; these are the places where
 * the AI plays the same game differently from Kyle's personal habits, on purpose, so the results can be compared.
 */
export const AI = {
  /** assigned exposure (shares + short put strikes × 100) ÷ account value, by run; never above the ceiling */
  exposure: { monday: 1.1, wednesday: 1.3, ceiling: 1.5 },
  /** per ticker and per theme, as a share of account value; one contract may stretch a ticker to `oneContract` */
  perTicker: 0.15,
  oneContract: 0.2,
  perTheme: 0.3,
  /** strike: this many expected moves below the price; `aggressive` for top-scored names in a Leading group */
  strike: { moves: 1, aggressiveMoves: 0.8, aggressiveMinScore: 75 },
  /** fills: sell at mid − share × spread, buy back at mid + share × spread */
  fillSpreadShare: 0.25,
  /** skip a put paying less than this share of the strike for the week */
  minWeekly: 0.005,
  /** Wednesday: buy back a put once this much of its premium is captured, then redeploy */
  takeProfit: 0.5,
  /** covered calls on assigned shares: at or above max(cost, price + `moves` expected moves), paying at least `minWeekly` */
  coveredCall: { use: true, moves: 1, minWeekly: 0.002 },
  /** sell assigned shares on a close below the floor (the prior 20-session low) */
  stopBelowFloor: true,
  /** fresh assignments: the stop waits this many calendar days after the assignment, so the shares get a week of covered calls first */
  stopGraceDays: 7,
} as const;

// ---------------------------------------------------------------------------
// universe: the rotation funds and how stocks map onto them
// ---------------------------------------------------------------------------

/** Funds on the rotation map, their plain name and the theme they count against. */
export const FUNDS: Record<string, { name: string; theme: string }> = {
  IWM: { name: "Small caps", theme: "Broad market" },
  RSP: { name: "Equal-weight S&P", theme: "Broad market" },
  QQQ: { name: "Nasdaq 100", theme: "Technology" },
  XLK: { name: "Tech", theme: "Technology" },
  XLV: { name: "Health care", theme: "Healthcare" },
  XLF: { name: "Financials", theme: "Financial Services" },
  XLE: { name: "Energy", theme: "Energy" },
  XLI: { name: "Industrials", theme: "Industrials" },
  XLB: { name: "Materials", theme: "Basic Materials" },
  XLU: { name: "Utilities", theme: "Utilities" },
  XLP: { name: "Staples", theme: "Consumer Defensive" },
  XLY: { name: "Discretionary", theme: "Consumer Cyclical" },
  XLC: { name: "Communication", theme: "Communication Services" },
  XLRE: { name: "Real estate", theme: "Real Estate" },
  SMH: { name: "Semiconductors", theme: "Technology" },
  IGV: { name: "Software", theme: "Technology" },
  XBI: { name: "Biotech", theme: "Healthcare" },
  GDX: { name: "Gold miners", theme: "Basic Materials" },
  URA: { name: "Uranium", theme: "Energy" },
  ITA: { name: "Defense and aerospace", theme: "Industrials" },
  KRE: { name: "Regional banks", theme: "Financial Services" },
  IBIT: { name: "Bitcoin", theme: "Crypto" },
  ARKK: { name: "Speculative growth", theme: "Technology" },
  XRT: { name: "Retail", theme: "Consumer Cyclical" },
  XHB: { name: "Homebuilders", theme: "Consumer Cyclical" },
  IYT: { name: "Transports", theme: "Industrials" },
  IWO: { name: "Small-cap growth", theme: "Broad market" },
  IWN: { name: "Small-cap value", theme: "Broad market" },
  UFO: { name: "Space", theme: "Industrials" },
  TAN: { name: "Solar", theme: "Utilities" },
};

/** Broad sector (as the market scanner labels it) → the sector fund whose quadrant a stock inherits. */
export const SECTOR_FUND: Record<string, string> = {
  Technology: "XLK",
  Healthcare: "XLV",
  "Financial Services": "XLF",
  Energy: "XLE",
  Industrials: "XLI",
  "Basic Materials": "XLB",
  Utilities: "XLU",
  "Consumer Defensive": "XLP",
  "Consumer Cyclical": "XLY",
  "Communication Services": "XLC",
  "Real Estate": "XLRE",
};

// ---------------------------------------------------------------------------
// indicators from daily bars
// ---------------------------------------------------------------------------

export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Tech {
  last: number;
  date: string;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  vs50: number | null; // price ÷ 50-day − 1
  vs200: number | null;
  ma50vs200: number | null;
  pctB: number | null; // 20-day Bollinger band position (0 = lower band, 1 = upper)
  rsi14: number | null;
  atr: number | null;
  floor: number | null; // lowest low of the last `floorLookback` sessions
  ret1w: number | null; // last 5 sessions
  ret4w: number | null; // `momentumDays`
  ret13w: number | null; // `trendDays`
  high52: number | null;
  offHigh: number | null;
  realizedVol: number | null; // annualised, 20-day
}

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

/** Indicators as of bar index `end - 1` (default: the latest bar). Bars must be sorted oldest first. */
export function techAt(bars: Bar[], end = bars.length): Tech | null {
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

  const n = RULES.strike.atrDays;
  let atr: number | null = null;
  if (b.length > n) {
    const trs: number[] = [];
    for (let i = b.length - n; i < b.length; i++) {
      const prev = b[i - 1].close;
      trs.push(Math.max(b[i].high - b[i].low, Math.abs(b[i].high - prev), Math.abs(b[i].low - prev)));
    }
    atr = mean(trs);
  }

  const fl = b.slice(-RULES.strike.floorLookback);
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
    ret4w: ret(closes, RULES.momentumDays),
    ret13w: ret(closes, RULES.trendDays),
    high52,
    offHigh: high52 ? last / high52 - 1 : null,
    realizedVol,
  };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

export type Quadrant = "Leading" | "Weakening" | "Lagging" | "Improving";
export type Stage = "Leader" | "Leader pulling back" | "Turning up" | "Breaking down" | "Downtrend" | "Unknown";

/** Relative return: (1 + a) ÷ (1 + b) − 1. */
export const rel = (a: number | null, b: number | null) => (a === null || b === null ? null : (1 + a) / (1 + b) - 1);

export function quadrant(trend: number | null, momentum: number | null): Quadrant | null {
  if (trend === null || momentum === null) return null;
  if (trend >= 0) return momentum >= 0 ? "Leading" : "Weakening";
  return momentum >= 0 ? "Improving" : "Lagging";
}

export function stage(rs4: number | null, rs13: number | null, t: Pick<Tech, "vs50" | "vs200" | "ma50vs200">): Stage {
  if (rs4 === null || rs13 === null || t.vs50 === null || t.vs200 === null) return "Unknown";
  if (rs13 >= 0 && rs4 >= 0 && t.vs50 >= 0 && t.vs200 > 0) return "Leader";
  if (rs13 >= 0 && t.vs200 > 0 && t.vs50 >= -RULES.pullbackWithin50d) return "Leader pulling back";
  if (rs4 >= 0 && t.vs50 >= 0) return "Turning up";
  if (rs13 < 0 && (t.vs200 <= 0 || (t.ma50vs200 !== null && t.ma50vs200 < 0))) return "Downtrend";
  return "Breaking down";
}

export const STAGE_RANK: Record<Stage, number> = {
  "Leader pulling back": 1,
  Leader: 2,
  "Turning up": 3,
  "Breaking down": 4,
  Downtrend: 5,
  Unknown: 6,
};

export function inNeverSellZone(t: Pick<Tech, "pctB" | "vs200">) {
  return t.pctB !== null && t.vs200 !== null && t.pctB <= RULES.neverSellMaxPctB && t.vs200 < 0;
}

/** Trend qualifies for a put: a leader, or turning up while already above the 200-day. */
export function trendQualifies(st: Stage, t: Pick<Tech, "vs200">) {
  return st === "Leader" || st === "Leader pulling back" || (st === "Turning up" && (t.vs200 ?? 0) > 0);
}

export interface PutCall {
  label: string;
  /** 1 = best put setup … 10 = never sell puts here */
  pref: number;
}

/** The plain-words call for one name this week, before scoring. */
export function putCall(args: {
  stage: Stage;
  tech: Pick<Tech, "pctB" | "vs200">;
  weeklies: boolean;
  earnings: { date: string; timing: string | null } | null;
  expiry: string;
}): PutCall {
  const { stage: st, tech, weeklies, earnings, expiry } = args;
  if (inNeverSellZone(tech)) return { label: "Never sell puts here", pref: 10 };
  const keep = trendQualifies(st, tech);
  if (keep && !weeklies) return { label: "No weekly options", pref: 5 };
  if (keep && earnings && earningsBefore(earnings, expiry)) return { label: `Earnings ${dayLabel(earnings.date)}${timingLabel(earnings.timing)}`, pref: 4 };
  if (keep && st === "Turning up") return { label: "Small, far strike", pref: 3 };
  if (keep && middleBand(tech)) return { label: "Best: pullback to middle band", pref: 1 };
  if (keep) return { label: "Sell puts", pref: 2 };
  if (st === "Turning up") return { label: "Wait for the 200-day", pref: 6 };
  if (st === "Breaking down") return { label: "No new puts", pref: 7 };
  if (st === "Downtrend") return { label: "Skip", pref: 8 };
  return { label: "No trend data", pref: 9 };
}

const middleBand = (t: Pick<Tech, "pctB" | "vs200">) =>
  (t.vs200 ?? 0) > 0 && t.pctB !== null && t.pctB >= RULES.neverSellMaxPctB && t.pctB <= 0.6;

export function earningsBefore(e: { date: string; timing: string | null }, expiry: string) {
  return e.date < expiry || (e.date === expiry && e.timing !== "pm");
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayLabel(ymd: string) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const timingLabel = (t: string | null) => (t === "pm" ? " after close" : t === "am" ? " before open" : "");

export function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** The first Friday at least `minExpiryDays` after `from` (YYYY-MM-DD). */
export function targetExpiry(from: string) {
  const d = new Date(`${from}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + RULES.pick.minExpiryDays);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d);
}

/** Calendar days from `from` to the expiry's 4pm ET close (≈ 21:00 UTC). */
export function daysTo(from: string, expiry: string) {
  return Math.max(1, (Date.parse(`${expiry}T21:00:00Z`) - Date.parse(`${from}T21:00:00Z`)) / 864e5);
}

// ---------------------------------------------------------------------------
// strike and premium
// ---------------------------------------------------------------------------

/** One week's expected move: price × IV × √(days ÷ 365). Falls back to realised volatility. */
export function expectedMove(t: Pick<Tech, "last" | "realizedVol">, iv: number | null, days: number) {
  const vol = iv ?? t.realizedVol;
  return vol ? t.last * vol * Math.sqrt(days / 365) : null;
}

/**
 * Target strike: one expected move below the price (about 0.16 delta, the backtest's strike). If that lands in the
 * danger zone just under the floor (within 1 ATR below it), push it down to floor − 1 ATR, so a support break
 * doesn't assign you at the exact spot where everyone's stops sit.
 */
export function targetStrike(t: Pick<Tech, "last" | "floor" | "atr">, move: number | null) {
  if (move === null) return null;
  const base = t.last - move;
  if (t.floor === null || t.atr === null) return base;
  const lowEdge = t.floor - RULES.strike.atrBelowFloor * t.atr;
  return base <= t.floor && base > lowEdge ? lowEdge : base;
}

export interface OptionQuote {
  strike: number;
  expiry: string;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  delta: number | null;
  iv: number | null;
  openInterest: number | null;
}

export const midOf = (q: OptionQuote) => (q.bid !== null && q.ask !== null && q.ask > 0 ? (q.bid + q.ask) / 2 : null);

/** A real market: a bid, a spread within 20% of the mid (or $0.10), and enough open contracts. */
export function realMarket(q: OptionQuote) {
  const mid = midOf(q);
  if (!q.bid || q.bid <= 0 || mid === null || q.ask === null) return false;
  if (q.ask - q.bid > Math.max(RULES.pick.maxSpreadOfMid * mid, RULES.pick.minSpreadAbs)) return false;
  return (q.openInterest ?? 0) >= RULES.pick.minOpenInterest;
}

/** The highest listed strike at or under the target that has a real market. */
export function chooseStrike(quotes: OptionQuote[], target: number | null) {
  if (target === null) return null;
  const ok = quotes.filter((q) => q.strike <= target && realMarket(q));
  return ok.length ? ok.reduce((a, b) => (b.strike > a.strike ? b : a)) : null;
}

/** Premium per week as a share of the strike (a 3-week monthly is divided by 3). */
export function weeklyPremium(q: OptionQuote, from: string) {
  const mid = midOf(q);
  if (mid === null || !q.strike) return null;
  const weeks = Math.max(1, Math.ceil(daysTo(from, q.expiry) / 7));
  return mid / q.strike / weeks;
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

export interface ScoreParts {
  trend: number;
  rotation: number;
  location: number;
  premium: number;
  liquidity: number;
  penalty: number;
}

export interface ScoreInput {
  stage: Stage;
  tech: Pick<Tech, "pctB" | "vs200">;
  groupQuadrant: Quadrant | null;
  /** weekly premium from a live quote, when there is one */
  premiumWeekly: number | null;
  ivRank: number | null;
  /** 0–1: 1 = busy options (tight quoted spread or heavy volume) */
  liquidity: number | null;
}

export function score(inp: ScoreInput): { total: number; parts: ScoreParts; checkWhy: boolean } {
  const W = RULES.score;
  const trend = W.trend[inp.stage] ?? 0;
  const rotation = inp.groupQuadrant ? W.rotation[inp.groupQuadrant] : W.rotationUnknown;

  const b = inp.tech.pctB;
  let location = 0;
  if (b !== null) {
    if (b > 0.8) location = W.location.stretched;
    else if (b > 0.6) location = W.location.upper;
    else if (b >= RULES.neverSellMaxPctB) location = W.location.middle;
    else if ((inp.tech.vs200 ?? 0) > 0) location = W.location.lowerInUptrend;
  }

  let premium = 0;
  if (inp.premiumWeekly !== null) {
    // 0.5% a week earns 70% of the points; 0.7%+ earns them all
    premium = Math.min(W.premiumMax, (inp.premiumWeekly / RULES.premium.targetWeekly) * W.premiumMax * 0.7);
  } else if (inp.ivRank !== null) {
    premium = inp.ivRank * W.premiumMax * 0.7;
  }

  const liquidity = inp.liquidity === null ? W.liquidityMax / 2 : inp.liquidity * W.liquidityMax;
  const checkWhy = inp.premiumWeekly !== null && inp.premiumWeekly > RULES.premium.checkWhyWeekly;
  const penalty = checkWhy ? W.checkWhyPenalty : 0;

  const parts = { trend, rotation, location, premium, liquidity, penalty };
  const total = Math.max(0, Math.min(100, Math.round(trend + rotation + location + premium + liquidity - penalty)));
  return { total, parts, checkWhy };
}

/** A one-line, plain-words reason built from the strongest parts of the score. */
export function reasonFor(args: {
  stage: Stage;
  groupQuadrant: Quadrant | null;
  groupName: string | null;
  pctB: number | null;
  premiumWeekly: number | null;
  ivRank: number | null;
}) {
  const bits: string[] = [];
  bits.push(args.stage === "Leader pulling back" ? "A leader pulling back" : args.stage === "Leader" ? "A leader" : "Turning up above its 200-day");
  if (args.groupQuadrant && args.groupName) bits.push(`in ${args.groupName.toLowerCase()} (${args.groupQuadrant.toLowerCase()})`);
  if (args.pctB !== null && args.pctB >= RULES.neverSellMaxPctB && args.pctB <= 0.6) bits.push("near its middle band");
  else if (args.pctB !== null && args.pctB > 0.8) bits.push("stretched near its upper band");
  let s = bits.join(", ");
  if (args.premiumWeekly !== null) s += `; pays ${(args.premiumWeekly * 100).toFixed(2)}% a week`;
  else if (args.ivRank !== null && args.ivRank >= 0.5) s += "; premium is rich for this name";
  return s + ".";
}

/** Top N by score with at most `maxPerSector` from one theme. */
export function topPicks<T extends { score: number; theme: string }>(rows: T[]): T[] {
  const out: T[] = [];
  const per: Record<string, number> = {};
  for (const r of [...rows].sort((a, b) => b.score - a.score)) {
    if ((per[r.theme] ?? 0) >= RULES.top.maxPerSector) continue;
    per[r.theme] = (per[r.theme] ?? 0) + 1;
    out.push(r);
    if (out.length === RULES.top.count) break;
  }
  return out;
}
