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
  /** false: no new puts on Wednesday (take profit and stops still run). */
  wedRedeploy?: boolean;
  /** Risk-off when SPY's last close is under its N-day average. */
  spyMaDays?: number;
  /** Risk-off when VIX closed above this. */
  vixMax?: number;
  /** Risk-off multiplies the day's exposure target by this (default 0: no new puts). */
  riskOffScale?: number;
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
        if (k !== "levers") throw new Error(`--set ${path}: no field "${k}"`);
        o[k] = {};
      }
      o = o[k] as Record<string, unknown>;
    }
    const last = keys.at(-1)!;
    if (keys[0] !== "levers" && !(last in o)) throw new Error(`--set ${path}: no field "${last}" (new knobs go under levers.)`);
    o[last] = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  }
  out.parent = rs.name;
  out.name = name ?? `${rs.name} · ${sets.join(" · ")}`;
  out.note = `${rs.name} with ${sets.join(", ")}`;
  return out as unknown as Ruleset;
}

/** Every name ever given to a Skynet ruleset. Never reuse one. */
export const USED_NAMES = ["Kindred", "Nasus"];

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

export const RULESETS: Record<string, Ruleset> = { kindred: KINDRED, "kindred-roc1": KINDRED_ROC1 };

export function getRuleset(name: string): Ruleset {
  const r = RULESETS[name.toLowerCase()];
  if (!r) throw new Error(`unknown ruleset "${name}" (known: ${Object.values(RULESETS).map((x) => x.name).join(", ")})`);
  return structuredClone(r);
}

/** A ruleset that is the live RULES and AI right now (for the parity check against src/lib). */
export function liveRuleset(rules: typeof RULES, ai: typeof AI, version: string): Ruleset {
  return { name: "live", parent: null, basedOn: version, created: "", note: "", rules: structuredClone(rules) as Rules, ai: structuredClone(ai) as AiPlaybook };
}
