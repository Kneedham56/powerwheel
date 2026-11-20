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
}

/** Every name ever given to a Skynet ruleset. Never reuse one. */
export const USED_NAMES = ["Kindred"];

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
  },
};

export const RULESETS: Record<string, Ruleset> = { kindred: KINDRED };

export function getRuleset(name: string): Ruleset {
  const r = RULESETS[name.toLowerCase()];
  if (!r) throw new Error(`unknown ruleset "${name}" (known: ${Object.values(RULESETS).map((x) => x.name).join(", ")})`);
  return structuredClone(r);
}

/** A ruleset that is the live RULES and AI right now (for the parity check against src/lib). */
export function liveRuleset(rules: typeof RULES, ai: typeof AI, version: string): Ruleset {
  return { name: "live", parent: null, basedOn: version, created: "", note: "", rules: structuredClone(rules) as Rules, ai: structuredClone(ai) as AiPlaybook };
}
