/**
 * Skynet rulesets: frozen copies of the live ruleset, replayed and varied by the backtest.
 *
 * Skynet never edits src/lib/rules.ts. A ruleset here is a full snapshot of RULES and AI, so a later change to the
 * live rules doesn't silently change an old ruleset's results. Kyle adopts one by copying its values into rules.ts
 * (and RULES.md) himself.
 *
 * Names are random League of Legends champions and are never reused, even after a ruleset is deleted: add every name
 * to USED_NAMES. Sweep variants hang under a parent, like "Kindred · delta 0.22".
 */
import type { AI, RULES } from "../src/lib/rules";
import type { HoldLevers } from "./hold";
import type { LongLevers } from "./longs";
import type { LeapLevers } from "./leaps";
import type { SwingLevers } from "./swing";

/** Deep copy of a type with readonly and literal types widened, so variants can change any value. */
type Widen<T> = T extends number
  ? number
  : T extends string
    ? string
    : T extends boolean
      ? boolean
      : T extends readonly unknown[]
        ? Widen<T[number]>[]
        : T extends object
          ? { -readonly [K in keyof T]: Widen<T[K]> }
          : T;

export type Rules = Widen<typeof RULES>;
export type AiPlaybook = Widen<typeof AI>;

export interface Ruleset {
  name: string;
  /** a sweep variant's parent ruleset, else null */
  parent: string | null;
  /** the live RULES_VERSION this was copied from */
  basedOn: string;
  created: string;
  note: string;
  rules: Rules;
  ai: AiPlaybook;
  /** Skynet-only levers. Missing = Kindred's behaviour. */
  levers?: Levers;
}

export interface Levers {
  /**
   * How Monday's puts pick a strike. "expectedMove" (Kindred): one expected move below, floor guard, minWeekly.
   * "roc": the furthest out-of-the-money strike (below the price) whose week's premium is at least rocTarget of the
   * strike. No expected-move or floor cap. Wednesday redeploys keep the expected-move strike.
   */
  putStrike?: "expectedMove" | "roc" | "delta";
  /** putStrike "delta": the highest strike under the price whose |delta| is at most this, paying minWeekly+ */
  deltaTarget?: number;
  /** weekly premium ÷ strike for putStrike "roc", e.g. 0.01 */
  rocTarget?: number;
  /** Never sell assigned shares at a loss: no floor stop, no downtrend sale. They leave only by being called away. */
  holdUntilGreen?: boolean;
  /** Friday: an in-the-money put is bought back (at intrinsic + $0.05) instead of assigned. */
  avoidAssignment?: boolean;
  /** Share of each lot's contracts covered by calls (1 = all, Kindred). Rounded down. */
  ccCoverage?: number;
  /** Puts only on names whose 30-day ATM IV is at least / at most this (0.5 = 50%). A name with no IV is skipped. */
  ivMin?: number;
  ivMax?: number;
  /** Skip candidates scoring under this. */
  minScore?: number;
  /** Stop out shares at this loss from cost (0.2 = 20%) instead of the floor stop. holdUntilGreen still wins. */
  shareStop?: number;
  /** The floor stop fires only this far under the floor (0.03 = 3%). */
  stopBuffer?: number;
  /** false: no new puts on Wednesday (take profit and stops still run). */
  wedRedeploy?: boolean;
  /** Risk-off when SPY's last close is under its N-day average. */
  spyMaDays?: number;
  /** Risk-off only once SPY is this far under the average (0.02 = 2%), to cut whipsaw. */
  spyMaBand?: number;
  /** No puts on leveraged or inverse ETFs (engine.ts LEVERAGED). */
  noLeveraged?: boolean;
  /** Risk-off when VIX closed above this. */
  vixMax?: number;
  /** Risk-off multiplies the day's exposure target by this (default 0: no new puts). */
  riskOffScale?: number;
  /** Monday when risk-off: sell every share lot ("all") or only the ones under cost ("losers"). */
  riskOffExit?: "all" | "losers";
  /** Core holding: after Monday's puts, buy the core symbol up to this total exposure (1 = 1x the account); sold when risk-off. */
  core?: number;
  /** the core holding's symbol (default SPY) */
  coreSymbol?: string;
  /** Changes to the Sunday report (skynet/logic.ts buildCandidates). Missing = the live prep. */
  prep?: PrepLevers;
  /**
   * Kyle's Friday decide rule, at Friday's close, for a put in the money: take assignment if the stock still passes
   * Sunday's checks (trend qualifies, not in the never-sell zone, closed at or above its 20-day low); otherwise roll to
   * next week at the lowest strike (at or under this one) that still nets a credit; otherwise buy it back.
   * "floor": the looser test, take assignment whenever the stock closed at or above its 20-day low (no trend check).
   */
  fridayDecide?: boolean | "floor";
  /**
   * Friday, for a covered call in the money: if the stock passes the same checks (more upside likely), roll it to next
   * week at the highest strike (at or over this one and the cost) that still nets a credit; otherwise let it be called.
   */
  fridayRollCalls?: boolean;
  /** Swing trading (skynet/swing.ts): buy shares low and sell them high from the same Sunday report, alone ("only") or beside the wheel ("add"). */
  swing?: SwingLevers;
  /** Buy and hold (skynet/hold.ts): the cash in the best-ranked names, sold only for a better one; alone ("only") or with the wheel on the margin above it ("add"). */
  hold?: HoldLevers;
  /** Long options (skynet/longs.ts): buy weekly calls and puts, alone ("only") or beside the wheel ("add"). */
  longs?: LongLevers;
  /**
   * Longer-dated puts (Zilean): Monday's and Wednesday's puts go on the Thursday/Friday expiry nearest this many days
   * out (within ±10 days, ties to the nearer one) instead of this week's Friday. A name holds one put at a time, so an
   * open put blocks new ones on it until it's closed or settled. Open options are marked to market every Friday (mid,
   * or intrinsic with no quote). The premium minimum stays per week (`ai.minWeekly` × the weeks the option spans).
   * Covered calls stay weekly. Needs the long chains (`npm run skynet -- cache --long`).
   */
  dte?: number;
  /**
   * levers.dte: where the expected-move strike goes. "scaled" (default): `ai.strike.moves` expected moves for the
   * option's own life (the report's weekly move × √((days + 1) ÷ 5)), about the weekly put's chance of assignment.
   * "weekly": Azir's strike as is, one weekly move under (much nearer the money for a long option). `putStrike: "delta"`
   * still works on Monday.
   */
  dteStrike?: "scaled" | "weekly";
  /** levers.dte: on Wednesday, buy back any put with this many days or fewer left (and not expiring this week), e.g. 21. */
  dteClose?: number;
  /** Long-dated options (skynet/leaps.ts): LEAPS calls and puts held for months, the long-dated wheel (puts sold months out, then calls on assigned shares), calls sold against LEAPS calls. */
  leaps?: LeapLevers;
}

/**
 * Sunday-report levers. Features (logic.ts prepFeatures): ret6m, ret12m (returns), rv20, rv60 (realized vol), ivrv
 * (30-day IV ÷ 20-day realized), iv, ivRank, offHigh (vs the 52-week high, ≤ 0), worst60 (worst 5-day return in 60
 * days), toFloor (price ÷ floor − 1), rsi, pctB, vs50, vs200, rs4, rs13, weekly (the put's premium ÷ strike), otm
 * (1 − strike ÷ price), price, term (front-week ATM IV ÷ the next expiry's: 1.2+ usually means earnings that week),
 * rand (a hash of the name and date in [0, 1): a placebo with no market information).
 */
export interface PrepLevers {
  /** a candidate is eligible only when each feature is within [min, max] (null = no bound; a missing feature fails) */
  filters?: Record<string, [number | null, number | null]>;
  /** extra score points: 0 at `from`, `points` at `to`, linear and clamped (from > to works too) */
  bonus?: Record<string, [number, number, number]>;
  /** score cap; default 100 (bonuses can push past it when raised) */
  maxScore?: number;
  /** Kindred's eligibility skips funds outside Leading/Improving groups; false lets every fund in on its own trend */
  fundGate?: boolean;
  /** allow "Turning up" names (pref 3) into the eligible list; false removes them */
  turningUp?: boolean;
  /** Adaptive report (Veigar): a second "alt" score, and a rule that picks or mixes the two rankings each Sunday. */
  adapt?: AdaptLevers;
}

/**
 * The adaptive Sunday report. The ruleset's own score (rules.score + bonus/maxScore above) is the "base" ranking; `alt`
 * is a second one (Azir's momentum tilt). Each Sunday the report uses one of them, or interleaves them, from regime
 * features measured on bars through Friday's close only (logic.ts regimeFeatures):
 *   mom      the momentum spread: over the last `mom.weeks` weekly cohorts whose `mom.horizon`-week outcome is already
 *            known, the mean forward return of the top `mom.top` of uptrending stocks by Azir's momentum (vs200, rs13)
 *            minus the rest's. > 0 means momentum has been paying.
 *   momHit   the share of those cohorts where it paid
 *   crash    1 when SPY fell `crash.drop`+ from its 6-month high to a low within the last `crash.weeks` weeks and has
 *            bounced `crash.bounce`+ off that low (the momentum-crash setup), else 0. crashDrop / crashBounce: the parts.
 *   spyVs200, spyRet4, spyRet13, spyDd (vs its 6-month high), vix, vixVs50 (VIX ÷ its 50-day average − 1),
 *   breadth  share of stocks above their 200-day; disp: cross-sectional stdev of 20-day returns
 *   coin     0 or 1 from a hash of the date: a placebo switch with no market information; u: the same, uniform in [0, 1)
 */
export interface AdaptLevers {
  alt: { score?: Partial<Rules["score"]>; bonus?: Record<string, [number, number, number]>; maxScore?: number };
  /** "alt": always the alt ranking. "base": always the base (to use `trim` alone). "blend": interleave the two (no timing).
   * "switch": alt while `when` holds, else `otherwise`. */
  mode: "alt" | "base" | "blend" | "switch";
  /** blend: the share of slots that go to the alt ranking (default 0.5) */
  blendShare?: number;
  /** switch: alt only while every feature is inside [min, max] (null = no bound; a missing feature fails) */
  when?: Record<string, [number | null, number | null]>;
  /** switch: what to use when `when` fails (default "base") */
  otherwise?: "base" | "blend";
  mom?: { weeks?: number; horizon?: number; top?: number };
  /** lag: test as of that many weeks earlier (a placebo: the same shape, the wrong timing) */
  crash?: { drop?: number; weeks?: number; bounce?: number; lag?: number };
  /** In a regime where every feature in `when` holds, only the top `keep` names stay eligible (fewer puts that week). */
  trim?: { when: Record<string, [number | null, number | null]>; keep: number };
}

/** Apply `a.b.c=value` overrides to a deep copy of a ruleset. Numbers and true/false are parsed. */
export function withOverrides(rs: Ruleset, sets: string[], name?: string): Ruleset {
  if (!sets.length) return name ? { ...rs, name } : rs;
  const out = structuredClone(rs) as unknown as Record<string, unknown>;
  out.levers ??= {};
  for (const kv of sets) {
    const [path, raw] = kv.split("=");
    if (!path || raw === undefined) throw new Error(`bad --set "${kv}" (want a.b=value)`);
    const keys = path.split(".");
    let o = out;
    for (const k of keys.slice(0, -1)) {
      if (o[k] === undefined) {
        if (keys[0] !== "levers") throw new Error(`--set ${path}: no field "${k}"`);
        o[k] = {};
      }
      o = o[k] as Record<string, unknown>;
    }
    const last = keys.at(-1)!;
    if (keys[0] !== "levers" && !(last in o)) throw new Error(`--set ${path}: no field "${last}" (new knobs go under levers.)`);
    o[last] =
      raw === "true" ? true : raw === "false" ? false : raw.startsWith("[") || raw.startsWith("{") ? JSON.parse(raw) : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  }
  out.parent = rs.name;
  out.name = name ?? `${rs.name} · ${sets.join(" · ")}`;
  out.note = `${rs.name} with ${sets.join(", ")}`;
  return out as unknown as Ruleset;
}

/** Every name ever given to a Skynet ruleset. Never reuse one. */
export const USED_NAMES = ["Kindred", "Nasus", "Azir", "Veigar", "Talon", "Zed", "Braum", "Ornn", "Jhin", "Xayah", "Zilean", "Lux", "Taric"];

/** The first Skynet ruleset: the live RULES and AI as of RULES_VERSION 2026.11.16.1, unchanged. */
export const KINDRED: Ruleset = {
  name: "Kindred",
  parent: null,
  basedOn: "2026.11.16.1",
  created: "2026-11-19",
  note: "Baseline: a straight copy of the live rules and the AI's race playbook.",
  rules: {
    momentumDays: 20,
    trendDays: 63,
    pullbackWithin50d: 0.05,
    neverSellMaxPctB: 0.2,
    pick: { minMarketCap: 20e9, minExpiryDays: 4, maxSpreadOfMid: 0.2, minSpreadAbs: 0.1, minOpenInterest: 100 },
    strike: { floorLookback: 20, atrBelowFloor: 1, atrDays: 14 },
    premium: { targetWeekly: 0.005, checkWhyWeekly: 0.02 },
    score: {
      trend: { "Leader pulling back": 30, Leader: 26, "Turning up": 15 },
      rotation: { Leading: 15, Improving: 10, Weakening: 3, Lagging: 0 },
      rotationUnknown: 6,
      location: { middle: 25, upper: 18, stretched: 10, lowerInUptrend: 12 },
      premiumMax: 20,
      liquidityMax: 10,
      checkWhyPenalty: 10,
    },
    top: { count: 5, maxPerSector: 2 },
    techBottom: { smhLow: 448, hygAbove: 77.5, tltAbove: 80.2 },
  },
  ai: {
    exposure: { monday: 1.1, wednesday: 1.3, ceiling: 1.5 },
    perTicker: 0.15,
    oneContract: 0.2,
    perTheme: 0.3,
    strike: { moves: 1, aggressiveMoves: 0.8, aggressiveMinScore: 75 },
    fillSpreadShare: 0.25,
    minWeekly: 0.0025,
    takeProfit: 0.5,
    coveredCall: { use: true, moves: 1, minWeekly: 0.002 },
    stopBelowFloor: true,
    stopGraceDays: 0, // added with live rules 2026.11.22; 0 keeps Kindred's original same-day stop
  },
};

/** Variant: Kindred, but Monday's puts aim for 1% of the strike for the week. */
export const KINDRED_ROC1: Ruleset = {
  ...KINDRED,
  name: "Kindred · roc 1%",
  parent: "Kindred",
  created: "2026-11-22",
  note: "Kindred with Monday puts picked by premium: the furthest out-of-the-money strike paying 1%+ of the strike for the week.",
  levers: { putStrike: "roc", rocTarget: 0.01 },
};

/**
 * Nasus: Kindred with the market regime and share handling from Claude's first solo round (2026-11-23). Puts stop
 * while SPY is under its 175-day average, covered calls go on a quarter of each lot (the rest rides), and Wednesday
 * takes profit at 70% instead of 50%. Everything else is Kindred.
 */
export const NASUS: Ruleset = {
  ...KINDRED,
  name: "Nasus",
  parent: "Kindred",
  created: "2026-11-23",
  note: "Kindred + SPY 175-day risk-off gate (no new puts under it), covered calls on 25% of shares, take profit at 70%.",
  ai: { ...KINDRED.ai, takeProfit: 0.7 },
  levers: { ccCoverage: 0.25, spyMaDays: 175 },
};

/**
 * Azir: Nasus's trading with a reworked Sunday report (Claude's second solo round, 2026-11-23). The pick study showed
 * the Kindred score barely beats a random order. Azir drops the trend-stage ranking (every qualifying stage scores 20),
 * weights premium more (30 instead of 20), and adds up to 10 points each for momentum (distance above the 200-day,
 * 13-week strength against SPY) and rich options (30-day IV over 20-day realized vol). Scores can pass 100.
 * Everything Monday to Friday is Nasus.
 */
export const AZIR: Ruleset = {
  ...NASUS,
  name: "Azir",
  parent: "Nasus",
  created: "2026-11-23",
  note: "Nasus + Sunday report: flat trend score, premium weight 30, bonuses for vs200, 13-week relative strength and IV ÷ realized vol.",
  rules: {
    ...KINDRED.rules,
    score: { ...KINDRED.rules.score, trend: { "Leader pulling back": 20, Leader: 20, "Turning up": 20 }, premiumMax: 30 },
  },
  levers: {
    ...NASUS.levers,
    prep: { bonus: { vs200: [0, 0.5, 10], rs13: [0, 0.3, 10], ivrv: [1, 1.6, 10] }, maxScore: 200 },
  },
};

/**
 * Veigar: Azir with a volatility speed limit (Claude's third solo round, 2026-11-23). The Sunday report leaves out any
 * name whose 60-day realized volatility is above 80% a year (and names with under 3 months of bars, which have none).
 * The limit tightens on its own in wild markets: it removes almost nothing in 2018–19, about 10% of candidates in 2020
 * and 18% in 2025. Pooled over 11 universes it gives up about 2%/yr of Azir's return (mostly 2025's speculative
 * winners) for a smaller worst year, a better 2022 and a slightly smaller max drawdown. On the full list alone, and
 * from later start dates, it trails both Nasus and Azir, so it's a record of the round, not a recommendation: Azir
 * stays the best return. The round's adaptive reports (blend, momentum switch, crash guard: levers.prep.adapt) did no
 * better than a random switch, so Veigar doesn't use them. Everything Monday to Friday is Nasus.
 */
export const VEIGAR: Ruleset = {
  ...AZIR,
  name: "Veigar",
  parent: "Azir",
  created: "2026-11-23",
  note: "Azir + a volatility limit on the Sunday report: no names with 60-day realized vol above 80% a year.",
  levers: { ...AZIR.levers, prep: { ...AZIR.levers!.prep, filters: { rv60: [null, 0.8] } } },
};

/**
 * Talon: swing trading only, no options (Claude's fourth solo round, 2026-11-24). It reads Azir's Sunday report and,
 * on any run day (Monday, Wednesday, Friday, at the close), buys the report's eligible names whose 14-day RSI is at or
 * under 40, in score order: a pullback inside an uptrend. Up to 8 names at 15% of the account each (1x at most), no
 * new buys while SPY is under its 175-day average. A position is sold at the first daily close with RSI at or over 70,
 * a close under its 20-day low at entry minus 1 ATR, or after 28 days. Pooled over 11 universes it makes about what SPY
 * does (12.4%/yr, max drawdown −33%) and trails Azir (16.5%). A fixed target (3 ATR) and a trailing floor both did
 * worse; the RSI 40 entry is a narrow peak (35 and 45 do much worse), so treat it as thin.
 */
export const TALON: Ruleset = {
  ...AZIR,
  name: "Talon",
  parent: "Azir",
  created: "2026-11-24",
  note: "Swing only: buy the Sunday report's names at RSI ≤ 40 (any run day), sell at RSI ≥ 70, a stop 1 ATR under the 20-day low, or 28 days. No options.",
  levers: {
    ...AZIR.levers,
    swing: {
      mode: "only",
      exposure: 1,
      perName: 0.15,
      maxNames: 8,
      entryDays: ["monday", "wednesday", "friday"],
      entry: "close",
      filters: { rsi: [null, 40] },
      regime: true,
      rsiExit: 70,
      stopFloor: true,
      stopFloorAtr: 1,
      maxDays: 28,
    },
  },
};

/**
 * Zed: Azir's wheel with Talon's swing trading beside it (Claude's fourth solo round, 2026-11-24). Two changes to
 * Azir. (1) No covered calls: assigned shares ride with Nasus's floor stop and downtrend sale, so a name that runs after
 * assignment isn't capped (pooled over 11 universes, this alone is +1.7%/yr, better on 2018–23 and on 2024–25).
 * (2) A small Talon book on the spare margin: up to 3 names at 10% of the account (0.3x), bought at RSI ≤ 40 on any
 * run day and sold at RSI ≥ 70, a stop 1 ATR under the 20-day low, or 28 days. Kyle's other wheel + swing ideas were
 * tested and left out: aiming puts nearer the money on oversold names (neutral), running assigned shares on swing exits
 * or a trailing floor (sells 2025's runners), covered calls at the swing target and the Wednesday hard sell (worse).
 */
export const ZED: Ruleset = {
  ...AZIR,
  name: "Zed",
  parent: "Azir",
  created: "2026-11-24",
  note: "Azir with no covered calls, plus a 0.3x Talon swing book (3 names at 10%: RSI ≤ 40 in, RSI ≥ 70 / stop / 28 days out).",
  ai: { ...AZIR.ai, coveredCall: { ...AZIR.ai.coveredCall, use: false } },
  levers: {
    ...AZIR.levers,
    swing: { ...TALON.levers!.swing!, mode: "add", exposure: 0.3, maxNames: 3, perName: 0.1 },
  },
};

/**
 * Braum: buy and hold, no options (Claude's fifth solo round, 2026-11-24). All the cash goes into 10 stocks (no funds,
 * no leveraged ETFs, 20-day dollar volume $100M+), an equal share each, ranked by the average of two ranks: `smooth`
 * (the share of up weeks in the last year) and `mom12` (the 12-month return skipping the last month). That's
 * momentum that came in many small steady gains rather than a few jumps (the "frog in the pan" effect). Four times a
 * year (the first week of Jan, Apr, Jul, Oct) a holding that has fallen out of the top 30 is sold, and its money buys
 * the best stock not held. Nothing else sells: no stop, no target, no trimming winners, no market timing. Pooled over
 * 11 universes: 32.3%/yr vs SPY 12.3%, max drawdown −39% vs −32%, worst year −9.7%, better in 11 of 11. Every
 * neighbour (5–30 names, keep 20–100, weekly to quarterly, mom6 or ret12 in place of mom12) makes 25–37%; placebos
 * that swap momentum for noise make 14–16%. Momentum alone made 21–24% with drawdowns of −60 to −72%.
 */
export const BRAUM: Ruleset = {
  ...AZIR,
  name: "Braum",
  parent: "Azir",
  created: "2026-11-24",
  note: "Buy and hold: 10 stocks ranked by steady up weeks + 12-month momentum; each quarter a holding out of the top 30 is sold for the best stock not held. No options.",
  levers: {
    ...AZIR.levers,
    hold: { mode: "only", exposure: 1, maxNames: 10, rank: ["smooth", "mom12"], universe: "stocks", keep: 30, review: "quarterly" },
  },
};

/**
 * Ornn: Braum's book on the cash and Azir's wheel on the margin above it (Claude's fifth solo round, 2026-11-24). The
 * book is 1x the account; its lots count toward the 2x margin cap but not the wheel's exposure targets, so Azir's puts
 * get up to the 1x above the book. The wheel is Azir unchanged (covered calls on 25% of assigned shares, the floor
 * stop, the SPY 175-day gate). The book's lots never get calls or stops.
 */
export const ORNN: Ruleset = {
  ...AZIR,
  name: "Ornn",
  parent: "Azir",
  created: "2026-11-24",
  note: "Braum's buy-and-hold book on the cash (1x) + Azir's wheel on the margin above it (up to 2x in all).",
  levers: { ...AZIR.levers, hold: { ...BRAUM.levers!.hold!, mode: "add" } },
};

/**
 * Jhin: weekly long calls only, no wheel (Claude's sixth solo round, 2026-11-24). Every Monday at the close it buys
 * calls expiring that Friday on 5 stocks (no funds, no leveraged ETFs, 20-day dollar volume $100M+, weeklies), ranked
 * like Braum: the average of two ranks, `smooth` (share of up weeks in the last year) and `mom12` (12-month return
 * skipping the last month). The strike nearest 0.3 delta out of the money, only contracts with a spread under 8% of
 * the price and costing $0.30+ a share, bought at mid + ¼ spread. 3% of the account in premium a week, an equal share
 * each; held to Friday's close and settled at intrinsic value. About 70% of trades lose (most expire worthless); a few
 * 10–30x weeks pay for them. Pooled over 11 universes: 37.9%/yr, max drawdown −24%, worst year +13% (Azir 16.5%,
 * SPY 12.3%). Random calls at the same budget make 21%, the same 5 names never changing 14%. Long puts lose in every
 * form tried (bearish names, oversold, overbought, SPY in a downtrend), so Jhin buys none. The budget is the dial:
 * 2% gives 24% / −16%, 4% gives 49% / −32% (about SPY's drawdown).
 */
export const JHIN: Ruleset = {
  ...AZIR,
  name: "Jhin",
  parent: "Azir",
  created: "2026-11-24",
  note: "Long calls only: each Monday, 3% of the account on 0.3-delta calls expiring Friday on the 5 stocks ranked best by steady up weeks + 12-month momentum. No wheel, no puts.",
  levers: {
    ...AZIR.levers,
    longs: { mode: "only", calls: { maxNames: 5, budget: 0.03, strike: "otm", rank: ["smooth", "mom12"], universe: "stocks", maxSpread: 0.08, minPrice: 0.3 } },
  },
};

/**
 * Xayah: Azir's wheel with no covered calls, plus Jhin's call book at 2% of the account a week (Claude's sixth solo
 * round, 2026-11-24). The calls are bought after the Monday puts and are paid from cash; the wheel keeps the 2x margin
 * cap. Pooled over 11 universes: 41.8%/yr, max drawdown −41% (Azir 16.5% / −30%; Azir + random calls 27.7%). The
 * wheel adds drawdown more than return: Jhin alone at a 4% budget makes more (48.5%) with less drawdown (−32%).
 */
export const XAYAH: Ruleset = {
  ...AZIR,
  name: "Xayah",
  parent: "Azir",
  created: "2026-11-24",
  note: "Azir with no covered calls + Jhin's call book at 2% of the account a week.",
  ai: { ...AZIR.ai, coveredCall: { ...AZIR.ai.coveredCall, use: false } },
  levers: { ...AZIR.levers, longs: { ...JHIN.levers!.longs!, mode: "add", calls: { ...JHIN.levers!.longs!.calls!, budget: 0.02 } } },
};

/**
 * Zilean: Azir with longer-dated puts (Claude's seventh solo round, 2026-11-24). Monday's and Wednesday's puts go on
 * the Thursday/Friday expiry nearest 45 days out, at the highest strike with |delta| 0.30 or less, and on Wednesday any
 * put with 21 days or fewer left is bought back. The Sunday report, sizing, covered calls and the rest stay Azir.
 * Kyle asked whether longer puts (at least 21, 30 and 35 days) beat the weekly wheel, on return or on risk. Pooled
 * over 11 universes it wins on risk and loses on return. The first grid's 45-day winners (19.8%/yr vs Azir's 16.5%)
 * came almost all from one 2020 NIO assignment that ran 15x, and NIO is in every slice. With NIO removed, Zilean makes
 * 13.1%/yr vs Azir's 16.0% (better in 2 of 11), with a max drawdown of −18% vs −30%, a worst year of −3.6% vs −11%
 * and a Sharpe of 1.20 vs 0.80. It gives up the bull years (2021, 2025), where selling every week compounds faster.
 * Spending the spare risk doesn't flip it: more exposure and 25% a name lift Zilean to 18.0% (DD −27%), but the same
 * 25% a name lifts Azir to 20.4% (DD −36%), and fills at half the spread cost Zilean 2%/yr (Azir 0.6%). 21–35 days do
 * worse on both counts, and so do the strike scaled to the option's life (too far out to pay the weekly minimum), 50%
 * take profit, delta 0.20 and delta 0.30 on weekly puts. Azir's own strike on 45-day puts ties Azir, same drawdown.
 */
export const ZILEAN: Ruleset = {
  ...AZIR,
  name: "Zilean",
  parent: "Azir",
  created: "2026-11-24",
  note: "Azir with 45-day puts: delta 0.30 strike, bought back at 21 days left. Covered calls stay weekly.",
  levers: { ...AZIR.levers, dte: 45, putStrike: "delta", deltaTarget: 0.3, dteClose: 21 },
};

/**
 * Lux: LEAPS calls only, no wheel (Claude's eighth solo round, 2026-11-24). Each Monday at the close it holds calls
 * about 400 days out (300–540) on the 5 stocks Braum's ranking likes best (steady up weeks + 12-month momentum; names
 * with weeklies and the size test that week), the strike nearest 0.70 delta, sized so delta × shares = the account
 * ÷ 5 (1x stock-like exposure, about a third of the cash in premium). Sold and reopened with 120 days left; once a
 * quarter a name ranked below 15th is sold for the best one not held. Pooled over 11 universes, 2018–2025: 36.2%/yr,
 * max drawdown −48%, worst year −8% (Braum honest 25.3% / −40%, Azir 16.5%, SPY 12.3%); better than SPY on every
 * list and from 2019, 2020 and 2021 starts (42%, 26%, 18% vs SPY's 15%, 13%, 13%). The names do the work: the same
 * book on random names makes 13%, on fixed random names −2.5%. 3 or 4 names make a bit more with deeper drawdowns
 * (3: −58%); 0.8 delta makes less (31.7%) and swings more by list; 1.3x makes 40% at −58%. Fills at half the spread cost
 * about 4%/yr. Jhin's weekly calls make about as much with half the drawdown. The long-dated wheel (puts sold months
 * out) made 2–7%/yr in every form and long puts lost, so Lux holds neither.
 */
export const LUX: Ruleset = {
  ...AZIR,
  name: "Lux",
  parent: "Azir",
  created: "2026-11-24",
  note: "LEAPS calls only: 5 steady-momentum stocks, 0.70 delta about 400 days out at 1x exposure, rolled at 120 days left, names reviewed quarterly. No wheel, no puts.",
  levers: {
    ...AZIR.levers,
    leaps: {
      mode: "only",
      calls: { maxNames: 5, rank: ["smooth", "mom12"], universe: "stocks", dte: [300, 540], target: 400, delta: 0.7, alloc: 1, rollAt: 120, review: "quarterly", keep: 15 },
    },
  },
};

/**
 * Taric: Azir's wheel with no covered calls, plus Lux's LEAPS call book beside it (Claude's eighth solo round,
 * 2026-11-24). The calls are paid from cash; the wheel's puts use what's left under the 2x margin cap (which leaves
 * the LEAPS out, like the wheel's Monday sizing). Pooled over 11 universes: 43.0%/yr, max drawdown −53%, worst year
 * −10%, Sharpe 0.95 (Lux 36.2%, Azir 16.5%, Xayah 41.8% / −41%). From 2019, 2020 and 2021 starts: 51%, 37%, 28%
 * (SPY 15%, 13%, 13%). With covered calls kept it makes 36%.
 */
export const TARIC: Ruleset = {
  ...AZIR,
  name: "Taric",
  parent: "Azir",
  created: "2026-11-24",
  note: "Azir with no covered calls + Lux's LEAPS call book beside it.",
  ai: { ...AZIR.ai, coveredCall: { ...AZIR.ai.coveredCall, use: false } },
  levers: { ...AZIR.levers, leaps: { ...LUX.levers!.leaps!, mode: "add" } },
};

export const RULESETS: Record<string, Ruleset> = { kindred: KINDRED, "kindred-roc1": KINDRED_ROC1, nasus: NASUS, azir: AZIR, veigar: VEIGAR, talon: TALON, zed: ZED, braum: BRAUM, ornn: ORNN, jhin: JHIN, xayah: XAYAH, zilean: ZILEAN, lux: LUX, taric: TARIC };

export function getRuleset(name: string): Ruleset {
  const r = RULESETS[name.toLowerCase()];
  if (!r) throw new Error(`unknown ruleset "${name}" (known: ${Object.values(RULESETS).map((x) => x.name).join(", ")})`);
  return structuredClone(r);
}

/** A ruleset that is the live RULES and AI right now (for the parity check against src/lib). */
export function liveRuleset(rules: typeof RULES, ai: typeof AI, version: string): Ruleset {
  return { name: "live", parent: null, basedOn: version, created: "", note: "", rules: structuredClone(rules) as Rules, ai: structuredClone(ai) as AiPlaybook };
}
