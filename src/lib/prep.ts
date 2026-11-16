/**
 * Weekly prep: builds the Sunday report and the Wednesday check from market data plus a written narrative.
 *
 * Every number comes from the rules module (src/lib/rules.ts); this file only gathers, arranges and labels.
 * Pure (no database, no network): scripts/prep.ts does the I/O, the /prep page renders the result.
 * Public by design: market and watchlist data only, never anything about an account.
 */
import {
  FUNDS,
  RULES,
  RULES_VERSION,
  SECTOR_FUND,
  STAGE_RANK,
  chooseStrike,
  daysTo,
  dayLabel,
  expectedMove,
  inNeverSellZone,
  midOf,
  putCall,
  quadrant,
  reasonFor,
  rel,
  score,
  stage,
  targetExpiry,
  targetStrike,
  techAt,
  topPicks,
  weeklyPremium,
  type Bar,
  type OptionQuote,
  type Quadrant,
  type ScoreParts,
  type Stage,
  type Tech,
} from "./rules";

// ---------------------------------------------------------------------------
// fixed parts of the report
// ---------------------------------------------------------------------------

export const INDICES: { symbol: string; name: string }[] = [
  { symbol: "SPY", name: "S&P 500" },
  { symbol: "QQQ", name: "Nasdaq 100" },
  { symbol: "IWM", name: "Small caps" },
  { symbol: "RSP", name: "Equal-weight S&P" },
  { symbol: "SMH", name: "Semiconductors" },
  { symbol: "TLT", name: "Long bonds" },
  { symbol: "HYG", name: "Junk bonds" },
];

export const GAUGES: { id: string; name: string; series: string; means: string }[] = [
  { id: "vix", name: "Fear gauge", series: "VIX", means: "The price of S&P 500 insurance." },
  { id: "tlt", name: "Long bonds", series: "TLT", means: "Rising means yields are falling." },
  { id: "hyg", name: "Junk bonds", series: "HYG", means: "Lenders' appetite for risk." },
  { id: "kre", name: "Regional banks", series: "KRE", means: "Credit plumbing for smaller companies." },
  { id: "iwm_spy", name: "Small vs large", series: "IWM/SPY", means: "Rises when small caps beat the S&P 500." },
  { id: "rsp_spy", name: "Breadth", series: "RSP/SPY", means: "Rises when the average stock beats the index." },
  { id: "uup", name: "Dollar", series: "UUP", means: "Rising means tighter money." },
  { id: "uso", name: "Oil", series: "USO", means: "Feeds inflation." },
  { id: "cper", name: "Copper", series: "CPER", means: "Real-economy demand." },
];

/** What each gauge colour means for selling puts on growth names (fixed text, follows Sunday's colour). */
export const GAUGE_FOR_YOU: Record<string, Record<string, string>> = {
  vix: { green: "Calm market. Premium is thinner, so don't move strikes closer to make up for it.", yellow: "Nerves are up. Premium pays more, but keep strikes at the usual distance and size.", red: "Fear is high. Premium is rich but swings are big: sell further out and smaller." },
  tlt: { green: "Rates are easing, a tailwind for growth names.", yellow: "Rates are flat. No push either way.", red: "Rates are rising, which hits growth names hardest. Lean on funds over single names." },
  hyg: { green: "Lenders are relaxed, so riskier names tend to hold their dips.", yellow: "Credit is wobbly. Dips in weaker names can run further than usual.", red: "Lenders are pulling back. Cash-burning names get hit first: skip puts on them." },
  kre: { green: "Banks are steady, so money keeps flowing to smaller companies.", yellow: "Banks are shaky. This often turns before small caps do.", red: "Bank stress. Smaller companies lose funding first: stick to funds and leaders." },
  iwm_spy: { green: "Small caps are beating big caps.", yellow: "Small and big caps are even. Pick by trend, name by name.", red: "Big caps are winning. Rallies may skip smaller names." },
  rsp_spy: { green: "Most stocks are joining in. Dips are more likely to get bought.", yellow: "Only some stocks are joining in. Be choosier.", red: "A few giants carry the index. Most stocks may not follow it up." },
  uup: { green: "A soft dollar is a tailwind for growth stocks.", yellow: "The dollar is steady. No push either way.", red: "A rising dollar tightens money and weighs on growth names." },
  uso: { green: "Oil is calm, which keeps inflation worries down.", yellow: "Oil is firming. Worth watching ahead of inflation reports.", red: "Oil is surging, which feeds inflation and rate fears." },
  cper: { green: "Copper is rising, a sign real demand is healthy.", yellow: "Copper is flat. Demand is steady.", red: "Copper is falling, an early sign of a slowing economy." },
};

const GAUGE_SYMBOLS = ["TLT", "HYG", "KRE", "IWM", "SPY", "RSP", "UUP", "USO", "CPER"];

/** Symbols the Sunday report needs daily bars for, before the watchlist and scan names. */
export function baseSymbols() {
  return [...new Set([...INDICES.map((i) => i.symbol), ...GAUGE_SYMBOLS, ...Object.keys(FUNDS)])];
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

export interface SymbolMeta {
  name?: string;
  sector?: string;
  marketCap?: number | null;
  iv?: number | null; // 30-day at-the-money implied volatility (0.4 = 40%)
  ivRank?: number | null; // 0–1
  weeklies?: boolean;
  earnings?: string | null; // next earnings date from the scanner (no timing)
  optionsVolume?: number | null; // 30-day average contracts a day
}

export interface WatchItem {
  symbol: string;
  list?: string;
  target?: number | null;
}

export interface EarningsEvent {
  symbol: string;
  date: string;
  timing: string | null;
  reported: boolean;
}

export interface SundayNarrative {
  headline: string;
  last_week: { summary: string; events: { title: string; result: string }[] };
  this_week: {
    base_case: string;
    scenarios: { name: string; likelihood: "likely" | "possible" | "less likely"; what: string; signals: string }[];
  };
  calendar: CalendarItem[];
  gauges: { id: string; status: "green" | "yellow" | "red"; reading: string; flip: string; good_level: number | null; bad_level: number | null }[];
  plain_read: { favors: string; avoid: string; watchlist: string };
  watch_levels: { label: string; symbol: string; level: number; good_when: "above" | "below"; why: string }[];
}

export interface CalendarItem {
  date: string;
  time: string;
  title: string;
  kind: "macro" | "fed" | "earnings" | "opex" | "market" | "holiday" | "ipo" | "other";
  importance: "high" | "medium" | "low";
  note: string;
  watchlist?: boolean;
}

export interface WednesdayNarrative {
  headline: string;
  so_far: string;
  whats_left: string;
  outlook: string;
  calendar_additions?: CalendarItem[];
}

export interface SundayInputs {
  runDate: string; // the day the report is built (YYYY-MM-DD)
  bars: Record<string, Bar[]>;
  vix: Bar[];
  meta: Record<string, SymbolMeta>;
  watchlist: WatchItem[];
  scanSymbols: string[]; // leaders-on-sale candidates beyond the watchlist
  earnings: EarningsEvent[];
  quotes: Record<string, OptionQuote[]>;
  narrative: SundayNarrative;
}

// ---------------------------------------------------------------------------
// report shapes (stored as prep_reports.data)
// ---------------------------------------------------------------------------

export interface IndexRow {
  symbol: string;
  name: string;
  last: number;
  week: number | null;
  month: number | null;
  vs50: number | null;
  vs200: number | null;
}

export interface GaugeRow {
  id: string;
  name: string;
  series: string;
  means: string;
  status: "green" | "yellow" | "red";
  reading: string;
  flip: string;
  for_you: string;
  good_level: number | null;
  bad_level: number | null;
  latest: number | null;
  history: { d: string; v: number }[];
}

export interface RotationRow {
  symbol: string;
  name: string;
  trend: number;
  momentum: number;
  trend_prior: number | null;
  momentum_prior: number | null;
  quadrant: Quadrant;
  quadrant_prior: Quadrant | null; // four weeks ago (the map's tail)
  quadrant_week_ago?: Quadrant | null; // one week ago (what changed this week)
  week: number | null;
}

export interface CandidateRow {
  symbol: string;
  name: string;
  source: "Watchlist" | "Scan" | "Fund";
  list: string;
  theme: string;
  group: string | null; // the fund whose quadrant it inherits
  group_quadrant: Quadrant | null;
  last: number;
  week: number | null;
  stage: Stage;
  stage_rank: number;
  put_call: string;
  pref: number;
  rs4: number | null;
  rs13: number | null;
  vs50: number | null;
  vs200: number | null;
  pct_b: number | null;
  rsi: number | null;
  iv: number | null;
  iv_rank: number | null;
  exp_move: number | null;
  floor: number | null;
  target_strike: number | null;
  to_target: number | null; // price vs the watchlist buy target
  eligible: boolean; // could be a pick this week
  score: number | null;
  parts: ScoreParts | null;
  flags: string[];
}

export interface Pick {
  rank: number;
  symbol: string;
  name: string;
  theme: string;
  score: number;
  parts: ScoreParts;
  reason: string;
  last: number;
  expiry: string;
  strike: number;
  mid: number;
  premium_weekly: number;
  delta: number | null;
  open_interest: number | null;
  cushion: number; // how far the price can fall before the strike
  collateral: number; // strike × 100
  flags: string[];
}

export interface Baseline {
  symbol: string;
  last: number;
  expiry: string;
  strike: number;
  mid: number;
  premium_weekly: number;
}

export interface Check {
  label: string;
  detail: string;
  pass: boolean;
}

export interface WatchLevel {
  label: string;
  symbol: string;
  level: number;
  good_when: "above" | "below";
  why: string;
  last: number | null;
  ok: boolean | null; // on the good side right now
}

export interface SundayReport {
  kind: "sunday";
  week_of: string;
  as_of: string;
  run_date: string;
  rules_version: string;
  expiry: string;
  narrative: SundayNarrative;
  indices: IndexRow[];
  gauges: GaugeRow[];
  rotation: RotationRow[];
  candidates: CandidateRow[];
  picks: Pick[];
  baseline: Baseline | null;
  tech_bottom: Check[];
  watch_levels: WatchLevel[];
  calendar: CalendarItem[];
}

export interface WednesdayReport {
  kind: "wednesday";
  week_of: string;
  as_of: string;
  run_date: string;
  rules_version: string;
  sunday_as_of: string;
  narrative: WednesdayNarrative;
  indices: (IndexRow & { since_sunday: number | null })[];
  watch_levels: (WatchLevel & { was_ok: boolean | null })[];
  picks: { symbol: string; strike: number; expiry: string; last: number | null; cushion: number | null; status: "safe" | "close" | "under" | "unknown" }[];
  rotation_changes: { symbol: string; name: string; from: Quadrant | null; to: Quadrant }[];
  tech_bottom: Check[];
  movers: { symbol: string; since_sunday: number }[];
  calendar: CalendarItem[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Monday of the trading week a report built on `runDate` is about (Sun → next day, Wed → that week's Monday). */
export function weekOf(runDate: string) {
  const d = new Date(`${runDate}T12:00:00Z`);
  const dow = d.getUTCDay();
  const shift = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + shift);
  return d.toISOString().slice(0, 10);
}

function ratioBars(a: Bar[], b: Bar[]): Bar[] {
  const bm = new Map(b.map((x) => [x.date, x]));
  return a
    .filter((x) => bm.has(x.date))
    .map((x) => {
      const y = bm.get(x.date)!;
      return { date: x.date, open: x.open / y.open, high: x.high / y.high, low: x.low / y.low, close: x.close / y.close };
    });
}

function closeOn(bars: Bar[] | undefined, date: string) {
  if (!bars?.length) return null;
  let c: number | null = null;
  for (const b of bars) if (b.date <= date) c = b.close;
  return c;
}

function rsVsSpy(t: Tech, spy: Tech) {
  return { rs4: rel(t.ret4w, spy.ret4w), rs13: rel(t.ret13w, spy.ret13w) };
}

function techBottom(bars: Record<string, Bar[]>, rotation: RotationRow[]): Check[] {
  const smh = bars.SMH ? techAt(bars.SMH) : null;
  const hyg = bars.HYG ? techAt(bars.HYG) : null;
  const tlt = bars.TLT ? techAt(bars.TLT) : null;
  const smhLow = smh ? Math.min(...bars.SMH.slice(-RULES.strike.floorLookback).map((b) => b.low)) : null;
  const smhQ = rotation.find((r) => r.symbol === "SMH")?.quadrant ?? null;
  const T = RULES.techBottom;
  const f = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toFixed(2));
  return [
    { label: `SMH holds above ${T.smhLow}`, detail: `Lowest low in 20 sessions: ${f(smhLow)}`, pass: smhLow !== null && smhLow > T.smhLow },
    { label: "SMH above its 50-day", detail: `SMH ${f(smh?.last)} vs 50-day ${f(smh?.sma50)}`, pass: !!smh && smh.vs50 !== null && smh.vs50 > 0 },
    { label: `Junk bonds (HYG) above ${T.hygAbove}`, detail: `HYG ${f(hyg?.last)}`, pass: !!hyg && hyg.last > T.hygAbove },
    { label: `Long bonds (TLT) above ${T.tltAbove}`, detail: `TLT ${f(tlt?.last)}`, pass: !!tlt && tlt.last > T.tltAbove },
    { label: "Chips Improving or Leading", detail: `SMH is ${smhQ ?? "unknown"} on the rotation map`, pass: smhQ === "Improving" || smhQ === "Leading" },
  ];
}

function levelStatus(l: { level: number; good_when: "above" | "below" }, last: number | null) {
  if (last === null) return null;
  return l.good_when === "above" ? last >= l.level : last <= l.level;
}

/** Levels every report watches, on top of the narrative's own. */
function defaultLevels(bars: Record<string, Bar[]>): SundayNarrative["watch_levels"] {
  const out: SundayNarrative["watch_levels"] = [];
  for (const s of ["SPY", "QQQ", "IWM", "SMH"]) {
    const t = bars[s] ? techAt(bars[s]) : null;
    if (t?.sma200) out.push({ label: `${s} 200-day average`, symbol: s, level: round2(t.sma200), good_when: "above", why: "The long-term trend line." });
    if (t?.sma50) out.push({ label: `${s} 50-day average`, symbol: s, level: round2(t.sma50), good_when: "above", why: "The medium-term trend line." });
  }
  out.push({ label: "SMH early-November low", symbol: "SMH", level: RULES.techBottom.smhLow, good_when: "above", why: "A higher low above it is the first sign of a tech bottom." });
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Sunday
// ---------------------------------------------------------------------------

export function buildSunday(inp: SundayInputs): SundayReport {
  const { bars, meta } = inp;
  if (!bars.SPY?.length) throw new Error("No SPY bars: the report needs SPY to measure everything against.");
  const spy = techAt(bars.SPY)!;
  const spyPrior = techAt(bars.SPY, bars.SPY.length - RULES.momentumDays);
  const spyWeekAgo = techAt(bars.SPY, bars.SPY.length - 5);
  const asOf = spy.date;
  const expiry = targetExpiry(inp.runDate);
  const days = daysTo(inp.runDate, expiry);

  // indices
  const indices: IndexRow[] = INDICES.filter((i) => bars[i.symbol]?.length).map((i) => {
    const t = techAt(bars[i.symbol])!;
    return { symbol: i.symbol, name: i.name, last: t.last, week: t.ret1w, month: t.ret4w, vs50: t.vs50, vs200: t.vs200 };
  });

  // gauges (colour and words from the narrative, numbers and history from the data)
  const gaugeBars: Record<string, Bar[]> = { ...bars, VIX: inp.vix };
  if (bars.IWM && bars.SPY) gaugeBars["IWM/SPY"] = ratioBars(bars.IWM, bars.SPY);
  if (bars.RSP && bars.SPY) gaugeBars["RSP/SPY"] = ratioBars(bars.RSP, bars.SPY);
  const gauges: GaugeRow[] = GAUGES.map((g) => {
    const n = inp.narrative.gauges.find((x) => x.id === g.id);
    const series = gaugeBars[g.series] ?? [];
    const status = n?.status ?? "yellow";
    return {
      id: g.id,
      name: g.name,
      series: g.series,
      means: g.means,
      status,
      reading: n?.reading ?? "",
      flip: n?.flip ?? "",
      for_you: GAUGE_FOR_YOU[g.id]?.[status] ?? "",
      good_level: n?.good_level ?? null,
      bad_level: n?.bad_level ?? null,
      latest: series.length ? series[series.length - 1].close : null,
      history: series.slice(-90).map((b) => ({ d: b.date, v: b.close })),
    };
  });

  // rotation map
  const rotation: RotationRow[] = [];
  for (const [symbol, f] of Object.entries(FUNDS)) {
    const b = bars[symbol];
    if (!b?.length) continue;
    const t = techAt(b)!;
    const tp = spyPrior ? techAt(b, b.length - RULES.momentumDays) : null;
    const trend = rel(t.ret13w, spy.ret13w);
    const momentum = rel(t.ret4w, spy.ret4w);
    const q = quadrant(trend, momentum);
    if (trend === null || momentum === null || !q) continue;
    const trendPrior = tp && spyPrior ? rel(tp.ret13w, spyPrior.ret13w) : null;
    const momentumPrior = tp && spyPrior ? rel(tp.ret4w, spyPrior.ret4w) : null;
    const tw = spyWeekAgo ? techAt(b, b.length - 5) : null;
    const quadrantWeekAgo = tw && spyWeekAgo ? quadrant(rel(tw.ret13w, spyWeekAgo.ret13w), rel(tw.ret4w, spyWeekAgo.ret4w)) : null;
    rotation.push({
      quadrant_week_ago: quadrantWeekAgo,
      symbol,
      name: f.name,
      trend,
      momentum,
      trend_prior: trendPrior,
      momentum_prior: momentumPrior,
      quadrant: q,
      quadrant_prior: quadrant(trendPrior, momentumPrior),
      week: t.ret1w,
    });
  }
  const quad = new Map(rotation.map((r) => [r.symbol, r.quadrant]));

  // earnings: the calendar first (has timing), the scanner's date as a fallback
  const earn = new Map<string, { date: string; timing: string | null }>();
  for (const e of inp.earnings) {
    if (e.reported || e.date < inp.runDate) continue;
    const cur = earn.get(e.symbol);
    if (!cur || e.date < cur.date) earn.set(e.symbol, { date: e.date, timing: e.timing });
  }

  // candidates: the watchlist, then scan names, then the funds
  const watch = new Map(inp.watchlist.map((w) => [w.symbol, w]));
  const order: { symbol: string; source: CandidateRow["source"] }[] = [
    ...inp.watchlist.map((w) => ({ symbol: w.symbol, source: "Watchlist" as const })),
    ...inp.scanSymbols.filter((s) => !watch.has(s) && !FUNDS[s]).map((s) => ({ symbol: s, source: "Scan" as const })),
    ...Object.keys(FUNDS).filter((s) => !watch.has(s)).map((s) => ({ symbol: s, source: "Fund" as const })),
  ];
  const seen = new Set<string>();
  const candidates: CandidateRow[] = [];
  for (const { symbol, source } of order) {
    if (seen.has(symbol) || !bars[symbol]?.length) continue;
    seen.add(symbol);
    const t = techAt(bars[symbol])!;
    const m = meta[symbol] ?? {};
    const fund = FUNDS[symbol];
    const { rs4, rs13 } = rsVsSpy(t, spy);
    const st = stage(rs4, rs13, t);
    const e = earn.get(symbol) ?? (m.earnings && m.earnings >= inp.runDate ? { date: m.earnings, timing: null } : null);
    const weeklies = m.weeklies ?? !!fund;
    const call = putCall({ stage: st, tech: t, weeklies, earnings: e, expiry });
    const group = fund ? symbol : m.sector ? (SECTOR_FUND[m.sector] ?? null) : null;
    const groupQ = group ? (quad.get(group) ?? null) : null;
    const theme = fund ? fund.theme : (m.sector ?? "Other");
    const bigEnough = !!fund || (m.marketCap ?? 0) >= RULES.pick.minMarketCap;
    const move = expectedMove(t, m.iv ?? null, days);
    const target = targetStrike(t, move);
    const flags: string[] = [];

    // the strike that would be sold: highest at or under the target with a real market
    const qs = (inp.quotes[symbol] ?? []).filter((q) => q.expiry === expiry || inp.quotes[symbol]?.every((x) => x.expiry !== expiry));
    const chosen = chooseStrike(qs, target);
    const prem = chosen ? weeklyPremium(chosen, inp.runDate) : null;
    if (qs.length && !chosen) flags.push("No real market");
    if (chosen && chosen.expiry !== expiry) flags.push("No weekly that Friday");
    if (!bigEnough && call.pref <= 3) flags.push("Under $20B: watch only");
    // a fund is the group itself: only Leading or Improving funds take new puts
    const fundOut = !!fund && groupQ !== "Leading" && groupQ !== "Improving";
    if (fundOut && call.pref <= 3) flags.push(`Fund is ${groupQ ?? "unranked"}: no new puts`);

    const eligible = call.pref <= 3 && bigEnough && !fundOut && !(qs.length && !chosen) && !(chosen && chosen.expiry !== expiry);
    let liquidity: number | null = null;
    if (chosen) {
      const mid = midOf(chosen)!;
      liquidity = (chosen.ask! - chosen.bid!) / mid <= 0.1 ? 1 : 0.6;
    } else if (m.optionsVolume) {
      liquidity = m.optionsVolume >= 50000 ? 0.9 : m.optionsVolume >= 10000 ? 0.7 : m.optionsVolume >= 2000 ? 0.5 : 0.3;
    }
    const sc = call.pref <= 3 ? score({ stage: st, tech: t, groupQuadrant: groupQ, premiumWeekly: prem, ivRank: m.ivRank ?? null, liquidity }) : null;
    if (sc?.checkWhy) flags.push("Check why: over 2% a week");

    if (source === "Scan" && !eligible) continue; // scan names only show up when they are picks
    if (source === "Fund" && (call.pref > 3 || fundOut)) continue; // funds only when they qualify; the map shows the rest

    const w = watch.get(symbol);
    candidates.push({
      symbol,
      name: fund?.name ?? m.name ?? symbol,
      source,
      list: w?.list ?? "",
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
      to_target: w?.target && t.last ? t.last / w.target - 1 : null,
      eligible,
      score: sc?.total ?? null,
      parts: sc?.parts ?? null,
      flags,
    });
  }
  // sellable picks first (best score on top), then names with a good trend that can't be sold this week, then the rest
  candidates.sort(
    (a, b) => Number(b.eligible) - Number(a.eligible) || (b.score ?? -1) - (a.score ?? -1) || a.pref - b.pref || (b.rs13 ?? -9) - (a.rs13 ?? -9),
  );

  // top picks: eligible, quoted, scored, at most 2 per theme
  const pickable = candidates
    .filter((c) => c.eligible && c.score !== null && inp.quotes[c.symbol]?.length)
    .map((c) => ({ ...c, score: c.score! }));
  const picks: Pick[] = topPicks(pickable).map((c, i) => {
    const q = chooseStrike(inp.quotes[c.symbol], c.target_strike)!;
    const mid = midOf(q)!;
    const pw = weeklyPremium(q, inp.runDate)!;
    return {
      rank: i + 1,
      symbol: c.symbol,
      name: c.name,
      theme: c.theme,
      score: c.score,
      parts: c.parts!,
      reason: reasonFor({ stage: c.stage, groupQuadrant: c.group_quadrant, groupName: c.group ? (FUNDS[c.group]?.name ?? c.group) : null, pctB: c.pct_b, premiumWeekly: pw, ivRank: c.iv_rank }),
      last: c.last,
      expiry: q.expiry,
      strike: q.strike,
      mid,
      premium_weekly: pw,
      delta: q.delta,
      open_interest: q.openInterest,
      cushion: 1 - q.strike / c.last,
      collateral: q.strike * 100,
      flags: c.flags,
    };
  });

  // baseline: an SPY put one expected move below the price
  let baseline: Baseline | null = null;
  if (inp.quotes.SPY?.length) {
    const target = spy.last - (expectedMove(spy, meta.SPY?.iv ?? null, days) ?? 0);
    const q = chooseStrike(inp.quotes.SPY, target);
    if (q) baseline = { symbol: "SPY", last: spy.last, expiry: q.expiry, strike: q.strike, mid: midOf(q)!, premium_weekly: weeklyPremium(q, inp.runDate)! };
  }

  const levels = [...defaultLevels(bars), ...(inp.narrative.watch_levels ?? [])];
  const watch_levels: WatchLevel[] = levels.map((l) => {
    const last = bars[l.symbol]?.length ? bars[l.symbol][bars[l.symbol].length - 1].close : null;
    return { ...l, last, ok: levelStatus(l, last) };
  });

  const calendar = [...(inp.narrative.calendar ?? [])].sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));

  return {
    kind: "sunday",
    week_of: weekOf(inp.runDate),
    as_of: asOf,
    run_date: inp.runDate,
    rules_version: RULES_VERSION,
    expiry,
    narrative: inp.narrative,
    indices,
    gauges,
    rotation,
    candidates,
    picks,
    baseline,
    tech_bottom: techBottom(bars, rotation),
    watch_levels,
    calendar,
  };
}

/** The candidates worth quoting options for, best first (premium unknown yet, so scored on IV rank). */
export function quotePlan(inp: Omit<SundayInputs, "quotes" | "narrative">, limit = 15) {
  const report = buildSunday({ ...inp, quotes: {}, narrative: emptyNarrative() });
  const days = daysTo(inp.runDate, report.expiry);
  const spy = techAt(inp.bars.SPY)!;
  const spyTarget = spy.last - (expectedMove(spy, inp.meta.SPY?.iv ?? null, days) ?? 0);
  const rows = report.candidates
    .filter((c) => c.eligible && c.target_strike !== null)
    .slice(0, limit)
    .map((c) => ({ symbol: c.symbol, score: c.score, last: round2(c.last), target_strike: round2(c.target_strike!), min_strike: round2(c.target_strike! * 0.9) }));
  return {
    expiry: report.expiry,
    symbols: [...rows, { symbol: "SPY", score: null, last: round2(spy.last), target_strike: round2(spyTarget), min_strike: round2(spyTarget * 0.95) }],
  };
}

export function emptyNarrative(): SundayNarrative {
  return {
    headline: "",
    last_week: { summary: "", events: [] },
    this_week: { base_case: "", scenarios: [] },
    calendar: [],
    gauges: [],
    plain_read: { favors: "", avoid: "", watchlist: "" },
    watch_levels: [],
  };
}

/** Facts to write the narrative from: so the words match the numbers. */
export function sundayContext(r: SundayReport) {
  const changed = r.rotation.filter((x) => x.quadrant_week_ago && x.quadrant_week_ago !== x.quadrant);
  const wl = r.candidates.filter((c) => c.source === "Watchlist");
  const byQuad = (q: Quadrant) => r.rotation.filter((x) => x.quadrant === q).map((x) => `${x.name} (${x.symbol})`);
  const stages: Record<string, number> = {};
  for (const c of wl) stages[c.stage] = (stages[c.stage] ?? 0) + 1;
  return {
    as_of: r.as_of,
    expiry: r.expiry,
    indices: r.indices.map((i) => ({ ...i, week: pctStr(i.week), month: pctStr(i.month), vs50: pctStr(i.vs50), vs200: pctStr(i.vs200) })),
    gauges_latest: r.gauges.map((g) => ({ id: g.id, series: g.series, latest: g.latest, week_ago: g.history.length > 5 ? g.history[g.history.length - 6].v : null })),
    rotation: { Leading: byQuad("Leading"), Improving: byQuad("Improving"), Weakening: byQuad("Weakening"), Lagging: byQuad("Lagging") },
    quadrant_changes_this_week: changed.map((x) => `${x.name} (${x.symbol}): ${x.quadrant_week_ago} → ${x.quadrant}`),
    watchlist_stages: stages,
    watchlist_week_best: [...wl].sort((a, b) => (b.week ?? 0) - (a.week ?? 0)).slice(0, 5).map((c) => `${c.symbol} ${pctStr(c.week)}`),
    watchlist_week_worst: [...wl].sort((a, b) => (a.week ?? 0) - (b.week ?? 0)).slice(0, 5).map((c) => `${c.symbol} ${pctStr(c.week)}`),
    watchlist_never_sell: wl.filter((c) => c.pref === 10).map((c) => c.symbol),
    picks: r.picks.map((p) => `${p.rank}. ${p.symbol} ${p.strike}p ${p.expiry} @ ${p.mid.toFixed(3)} (${pctStr(p.premium_weekly, 2)}/wk, score ${p.score})`),
    tech_bottom: r.tech_bottom.map((c) => `${c.pass ? "✓" : "✗"} ${c.label}: ${c.detail}`),
  };
}

const pctStr = (n: number | null, d = 1) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`);

// ---------------------------------------------------------------------------
// Wednesday
// ---------------------------------------------------------------------------

export interface WednesdayInputs {
  runDate: string;
  sunday: SundayReport;
  bars: Record<string, Bar[]>;
  narrative: WednesdayNarrative;
}

/** Symbols the Wednesday check needs fresh bars for. */
export function wednesdaySymbols(sunday: SundayReport) {
  return [
    ...new Set([
      ...INDICES.map((i) => i.symbol),
      ...Object.keys(FUNDS),
      ...sunday.watch_levels.map((l) => l.symbol),
      ...sunday.picks.map((p) => p.symbol),
      ...sunday.candidates.filter((c) => c.source === "Watchlist").map((c) => c.symbol),
    ]),
  ];
}

export function buildWednesday(inp: WednesdayInputs): WednesdayReport {
  const { bars, sunday } = inp;
  if (!bars.SPY?.length) throw new Error("No SPY bars.");
  const spy = techAt(bars.SPY)!;
  const sundayClose = (s: string) => closeOn(bars[s], sunday.as_of);
  const sinceSunday = (s: string) => {
    const a = sundayClose(s);
    const b = bars[s]?.length ? bars[s][bars[s].length - 1].close : null;
    return a && b ? b / a - 1 : null;
  };

  const indices = INDICES.filter((i) => bars[i.symbol]?.length).map((i) => {
    const t = techAt(bars[i.symbol])!;
    return { symbol: i.symbol, name: i.name, last: t.last, week: t.ret1w, month: t.ret4w, vs50: t.vs50, vs200: t.vs200, since_sunday: sinceSunday(i.symbol) };
  });

  const watch_levels = sunday.watch_levels.map((l) => {
    const last = bars[l.symbol]?.length ? bars[l.symbol][bars[l.symbol].length - 1].close : l.last;
    return { ...l, last, ok: levelStatus(l, last), was_ok: l.ok };
  });

  const picks = sunday.picks.map((p) => {
    const last = bars[p.symbol]?.length ? bars[p.symbol][bars[p.symbol].length - 1].close : null;
    const cushion = last ? 1 - p.strike / last : null;
    const t = bars[p.symbol]?.length ? techAt(bars[p.symbol]) : null;
    const status: "safe" | "close" | "under" | "unknown" =
      cushion === null ? "unknown" : cushion < 0 ? "under" : t?.atr && last && last - p.strike < t.atr ? "close" : "safe";
    return { symbol: p.symbol, strike: p.strike, expiry: p.expiry, last, cushion, status };
  });

  const rotationNow: RotationRow[] = [];
  for (const [symbol, f] of Object.entries(FUNDS)) {
    const b = bars[symbol];
    if (!b?.length) continue;
    const t = techAt(b)!;
    const trend = rel(t.ret13w, spy.ret13w);
    const momentum = rel(t.ret4w, spy.ret4w);
    const q = quadrant(trend, momentum);
    if (!q || trend === null || momentum === null) continue;
    rotationNow.push({ symbol, name: f.name, trend, momentum, trend_prior: null, momentum_prior: null, quadrant: q, quadrant_prior: null, week: t.ret1w });
  }
  const sundayQ = new Map(sunday.rotation.map((r) => [r.symbol, r.quadrant]));
  const rotation_changes = rotationNow
    .filter((r) => sundayQ.get(r.symbol) && sundayQ.get(r.symbol) !== r.quadrant)
    .map((r) => ({ symbol: r.symbol, name: r.name, from: sundayQ.get(r.symbol) ?? null, to: r.quadrant }));

  const movers = sunday.candidates
    .filter((c) => c.source === "Watchlist")
    .map((c) => ({ symbol: c.symbol, since_sunday: sinceSunday(c.symbol) }))
    .filter((m): m is { symbol: string; since_sunday: number } => m.since_sunday !== null)
    .sort((a, b) => Math.abs(b.since_sunday) - Math.abs(a.since_sunday))
    .slice(0, 10);

  const calendar = [...sunday.calendar, ...(inp.narrative.calendar_additions ?? [])]
    .filter((c) => c.date >= inp.runDate)
    .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));

  return {
    kind: "wednesday",
    week_of: sunday.week_of,
    as_of: spy.date,
    run_date: inp.runDate,
    rules_version: RULES_VERSION,
    sunday_as_of: sunday.as_of,
    narrative: inp.narrative,
    indices,
    watch_levels,
    picks,
    rotation_changes,
    tech_bottom: techBottom(bars, rotationNow),
    movers,
    calendar,
  };
}

export function wednesdayContext(r: WednesdayReport) {
  return {
    as_of: r.as_of,
    indices_since_sunday: r.indices.map((i) => `${i.symbol} ${pctStr(i.since_sunday)} (vs 50-day ${pctStr(i.vs50)}, vs 200-day ${pctStr(i.vs200)})`),
    levels: r.watch_levels.map((l) => `${l.label}: ${l.last?.toFixed(2) ?? "—"} vs ${l.level} (${l.ok === null ? "?" : l.ok ? "holding" : "broken"}${l.was_ok !== null && l.ok !== l.was_ok ? `, was ${l.was_ok ? "holding" : "broken"} Sunday` : ""})`),
    picks: r.picks.map((p) => `${p.symbol} ${p.strike}p: last ${p.last?.toFixed(2) ?? "—"}, ${p.status}`),
    rotation_changes: r.rotation_changes.map((c) => `${c.name}: ${c.from} → ${c.to}`),
    movers: r.movers.map((m) => `${m.symbol} ${pctStr(m.since_sunday)}`),
    tech_bottom: r.tech_bottom.map((c) => `${c.pass ? "✓" : "✗"} ${c.label}`),
    calendar_left: r.calendar.map((c) => `${dayLabel(c.date)} ${c.time} ${c.title}`),
  };
}

// ---------------------------------------------------------------------------
// settling the pick log
// ---------------------------------------------------------------------------

export interface LoggedPick {
  strike: number;
  premium: number;
  expiration: string;
  symbol: string;
}

export function settle(p: LoggedPick, closeAtExpiry: number) {
  const assigned = closeAtExpiry < p.strike;
  const pnl = (p.premium - (assigned ? p.strike - closeAtExpiry : 0)) * 100;
  return { outcome: assigned ? ("assigned" as const) : ("expired" as const), pnl: round2(pnl), roc: pnl / (p.strike * 100) };
}

export { closeOn, inNeverSellZone };
