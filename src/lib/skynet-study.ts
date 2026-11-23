import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSummary } from "../../skynet/results";
import { RULESETS, type Ruleset } from "../../skynet/rulesets";
import type { RunEntry } from "./skynet-runs";

/**
 * The Study tab on /skynet: a short, hand-picked list of runs to read, from data/skynet/study.json (local, gitignored,
 * kept up to date by the research chats). Without the file the tab says so.
 *
 *   {
 *     "updated": "2026-11-23",
 *     "intro": "…",
 *     "compare": ["kindred", "nasus", "azir"],                 // rulesets.ts keys for the rules table
 *     "sections": [{ "title": "…", "runs": [{ "dir": "nasus", "from": "2018-01-01", "to": "2025-12-31", "label": "…", "why": "…" }] }],
 *     "pooled": [{ "title": "…", "note": "…", "prefix": "Azir p", "control": "control",
 *                  "rows": [{ "label": "…", "variants": ["C7 + trend flat"] }] }]   // one section or a list of them
 *   }
 *
 * A run is the latest one in data/backtests/<dir> over that period. Pooled rows read every sweep run named
 * "<prefix><n>[ s<k>] · <variant>" (one per universe: the full list, or random slice k) and compare it with the
 * control run on the same universe.
 */

export interface StudyRun {
  dir: string;
  from: string;
  to: string;
  label: string;
  why: string;
}
export interface StudyFile {
  updated?: string;
  intro?: string;
  compare?: string[];
  sections: { title: string; note?: string; runs: StudyRun[] }[];
  pooled?: PooledSection | PooledSection[];
}
export interface PooledSection {
  title: string;
  note?: string;
  prefix: string;
  control: string;
  /** the control row's label (default "Nasus (control)") */
  controlLabel?: string;
  rows: { label: string; variants: string[]; why?: string }[];
}

/** The pooled sections, whether study.json has one or a list. */
export const pooledSections = (study: StudyFile): PooledSection[] => (!study.pooled ? [] : Array.isArray(study.pooled) ? study.pooled : [study.pooled]);

const file = () => join(process.cwd(), "data", "skynet", "study.json");

export function loadStudy(): { study: StudyFile | null; error?: string } {
  if (!existsSync(file())) return { study: null };
  try {
    return { study: JSON.parse(readFileSync(file(), "utf8")) as StudyFile };
  } catch (e) {
    return { study: null, error: `data/skynet/study.json doesn't parse: ${(e as Error).message}` };
  }
}

/** The latest run in a folder over a period (runs are newest first). */
export function resolveRun(r: StudyRun, runs: RunEntry[]) {
  return runs.find((x) => x.ruleset === r.dir && x.from === r.from && x.to === r.to) ?? null;
}

export interface PooledRow {
  label: string;
  why?: string;
  n: number;
  cagr: number;
  delta: number;
  better: number;
  dd: number;
  /** each universe's worst calendar year, averaged */
  worst: number;
  sharpe: number;
  /** the run on the full list (to open in All runs), if there is one */
  fullId: string | null;
  /** per year: mean return minus control's, and how many universes beat control */
  years: { year: string; delta: number; better: number; n: number }[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

type Sum = RunSummary & { id: string };

export function pooled(P: PooledSection, summaries: Sum[]): { rows: PooledRow[]; control: PooledRow | null; universes: number } {
  const re = new RegExp(`^${esc(P.prefix)}\\d+( s(\\d+))? · (.*)$`);
  // variant -> universe -> summary (summaries are newest first, so the first one seen wins)
  const by = new Map<string, Map<string, Sum>>();
  for (const s of summaries) {
    if (s.from !== "2018-01-01" || s.to !== "2025-12-31") continue;
    const m = re.exec(s.name);
    if (!m) continue;
    const u = m[2] ? `s${m[2]}` : "full";
    const v = by.get(m[3]) ?? new Map<string, Sum>();
    if (!v.has(u)) v.set(u, s);
    by.set(m[3], v);
  }
  const ctrl = by.get(P.control) ?? new Map<string, Sum>();
  const row = (label: string, variants: string[], why?: string): PooledRow => {
    const runs = new Map<string, Sum>();
    for (const v of variants) for (const [u, s] of by.get(v) ?? []) if (!runs.has(u)) runs.set(u, s);
    const us = [...runs.keys()].filter((u) => ctrl.has(u));
    const yrs = us.length ? runs.get(us[0])!.years.map((y) => y.year) : [];
    const yr = (s: RunSummary, y: string) => s.years.find((x) => x.year === y)?.return ?? 0;
    return {
      label,
      why,
      n: us.length,
      cagr: mean(us.map((u) => runs.get(u)!.total.cagr)),
      delta: mean(us.map((u) => runs.get(u)!.total.cagr - ctrl.get(u)!.total.cagr)),
      better: us.filter((u) => runs.get(u)!.total.cagr > ctrl.get(u)!.total.cagr).length,
      dd: mean(us.map((u) => runs.get(u)!.total.dd)),
      worst: mean(us.map((u) => Math.min(...runs.get(u)!.years.map((y) => y.return)))),
      sharpe: mean(us.map((u) => runs.get(u)!.total.sharpe ?? 0)),
      fullId: runs.get("full")?.id ?? null,
      years: yrs.map((y) => {
        const ds = us.map((u) => yr(runs.get(u)!, y) - yr(ctrl.get(u)!, y));
        return { year: y, delta: mean(ds), better: ds.filter((d) => d > 0).length, n: ds.length };
      }),
    };
  };
  return { rows: P.rows.map((r) => row(r.label, r.variants, r.why)), control: ctrl.size ? row(P.controlLabel ?? "Nasus (control)", [P.control]) : null, universes: ctrl.size };
}

// ---------------------------------------------------------------------------
// rules compared
// ---------------------------------------------------------------------------

/** Plain-words names for the settings that differ between rulesets. Anything else shows its path. */
const LABELS: [RegExp, string][] = [
  [/^levers\.spyMaDays$/, "Market gate: no new puts while SPY closes under its N-day average"],
  [/^levers\.ccCoverage$/, "Covered calls on this share of each assigned lot (the rest rides)"],
  [/^ai\.takeProfit$/, "Wednesday take profit: buy the put back once this much is captured"],
  [/^rules\.score\.trend\.(.+)$/, "Sunday score: points for the trend stage “$1”"],
  [/^rules\.score\.premiumMax$/, "Sunday score: most points for premium (paid in full at 0.71%+ of the strike a week)"],
  [/^rules\.score\.location\.(.+)$/, "Sunday score: points for location “$1”"],
  [/^rules\.score\.rotation\.(.+)$/, "Sunday score: points for a $1 sector"],
  [/^levers\.prep\.bonus\.vs200$/, "Sunday score bonus: distance above the 200-day average (0 pts at 0%, full at +50%)"],
  [/^levers\.prep\.bonus\.rs13$/, "Sunday score bonus: 13-week return vs SPY (0 pts at even, full at +30%)"],
  [/^levers\.prep\.bonus\.ivrv$/, "Sunday score bonus: options priced rich, 30-day IV ÷ 20-day realized vol (0 pts at 1.0, full at 1.6)"],
  [/^levers\.prep\.maxScore$/, "Sunday score cap"],
  [/^levers\.prep\.filters\.term$/, "Earnings filter: skip when front-week IV ÷ next-week IV is above this"],
  [/^levers\.prep\.filters\.rv60$/, "Volatility limit: skip names whose 60-day realized volatility is above this (a year's worth)"],
];

function flat(o: unknown, pre = "", out: Record<string, unknown> = {}) {
  if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) flat(v, pre ? `${pre}.${k}` : k, out);
  else out[pre] = o;
  return out;
}

const show = (path: string, v: unknown) => {
  if (v === undefined) return "off";
  if (Array.isArray(v) && v.length === 3 && path.includes(".bonus.")) return `up to ${v[2]} pts`;
  if (Array.isArray(v) && v.length === 2 && path.includes(".filters.rv60")) return v[1] === null ? "off" : `${Math.round(Number(v[1]) * 100)}%`;
  if (typeof v === "number" && /ccCoverage|takeProfit/.test(path)) return `${Math.round(v * 100)}%`;
  if (typeof v === "number" && /spyMaDays/.test(path)) return `${v} days`;
  return Array.isArray(v) ? JSON.stringify(v) : String(v);
};

/** One row per setting that differs between the named rulesets, in plain words where known. */
export function rulesCompared(keys: string[]) {
  const rss = keys.map((k) => RULESETS[k]).filter((r): r is Ruleset => !!r);
  const flats = rss.map((r) => flat({ rules: r.rules, ai: r.ai, levers: r.levers ?? {} }));
  const paths = [...new Set(flats.flatMap((f) => Object.keys(f)))].sort();
  const rows = paths
    .filter((p) => new Set(flats.map((f) => JSON.stringify(f[p]))).size > 1)
    .map((p) => {
      const i = LABELS.findIndex(([re]) => re.test(p));
      return { path: p, order: i < 0 ? LABELS.length : i, label: i < 0 ? p : p.replace(LABELS[i][0], LABELS[i][1]), values: flats.map((f) => show(p, f[p])) };
    })
    .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  return { names: rss.map((r) => r.name), notes: rss.map((r) => r.note), rows };
}
