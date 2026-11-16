/**
 * Weekly prep: the Sunday report and the Wednesday check (docs/PREP.md has the full routine).
 *
 * Claude pulls market data with the Robinhood connector (read-only), saves each raw tool answer to a file,
 * lists the files in a manifest, and runs:
 *
 *   npm run prep -- scans --watchlist wl.json             # preview_scan arguments to run (metadata + universe)
 *   npm run prep -- symbols --watchlist wl.json --scan <universe.json>   # what to fetch daily bars for
 *   npm run prep -- quote-plan <manifest.json>            # which puts to quote, at which expiry and strikes
 *   npm run prep -- context <manifest.json>               # facts to write the narrative from
 *   npm run prep -- build <manifest.json> [--dry-run]     # settle last week's picks, save the report, log picks
 *
 *   npm run prep -- wed-symbols                           # what to fetch for the Wednesday check
 *   npm run prep -- wed-context <manifest.json>
 *   npm run prep -- wednesday <manifest.json> [--dry-run]
 *
 * All numbers come from src/lib/rules.ts via src/lib/prep.ts; the narrative is the only hand-written part.
 */
import "./env";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createAdminClient } from "../src/lib/supabase";
import {
  baseSymbols,
  buildSunday,
  buildWednesday,
  closeOn,
  emptyNarrative,
  quotePlan,
  settle,
  sundayContext,
  wednesdayContext,
  wednesdaySymbols,
  type EarningsEvent,
  type SundayNarrative,
  type SundayReport,
  type SymbolMeta,
  type WatchItem,
  type WednesdayNarrative,
} from "../src/lib/prep";
import { FUNDS, RULES, RULES_VERSION, type Bar, type OptionQuote } from "../src/lib/rules";

// ---------------------------------------------------------------------------
// reading raw tool answers
// ---------------------------------------------------------------------------

/** A saved tool answer: plain JSON, a content-block array, or JSON after a header line. */
function readAnswer(path: string): unknown {
  const text = readFileSync(path, "utf8");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    const i = text.indexOf("{");
    if (i < 0) throw new Error(`${path}: not JSON`);
    v = JSON.parse(text.slice(i));
  }
  if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "text" in v[0]) {
    return JSON.parse((v as { text: string }[]).map((b) => b.text).join(""));
  }
  return v;
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function parseBars(files: string[], value = false): Record<string, Bar[]> {
  const out: Record<string, Map<string, Bar>> = {};
  for (const f of files) {
    const a = readAnswer(f) as Any;
    const results: Any[] = a?.data?.results ?? a?.results ?? [];
    if (!results.length) throw new Error(`${f}: no price history in it`);
    for (const r of results) {
      const sym = r.symbol || (value ? "VIX" : "");
      if (!sym) continue;
      const m = (out[sym] ??= new Map());
      for (const b of r.bars ?? []) {
        if (b.interpolated) continue;
        const pick = (k: string) => num(b[`${k}_price`] ?? b[`${k}_value`]);
        const close = pick("close");
        if (close === null) continue;
        const date = String(b.begins_at).slice(0, 10);
        m.set(date, { date, open: pick("open") ?? close, high: pick("high") ?? close, low: pick("low") ?? close, close });
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([s, m]) => [s, [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1))]));
}

function scanRows(files: string[]): Any[] {
  const rows: Any[] = [];
  for (const f of files) {
    const a = readAnswer(f) as Any;
    const res = a?.data?.result?.results;
    if (!Array.isArray(res)) throw new Error(`${f}: not a preview_scan answer`);
    rows.push(...res);
  }
  return rows;
}

function ymdFromScan(v: unknown) {
  const n = num(v);
  if (!n) return null;
  const s = String(Math.round(n));
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

function parseMeta(files: string[]): Record<string, SymbolMeta> {
  const out: Record<string, SymbolMeta> = {};
  for (const r of scanRows(files)) {
    const c = r.columns ?? {};
    out[r.ticker] = {
      name: c.Name,
      sector: c.Sector || undefined,
      marketCap: num(c["Market cap"]),
      iv: num(c["Implied volatility"]),
      ivRank: num(c["IV rank"]),
      weeklies: c.Expirations === undefined ? undefined : /weekly/i.test(String(c.Expirations)),
      earnings: ymdFromScan(c["Earnings date"]),
      optionsVolume: num(c["Options volume"] ?? c["Average options volume"]),
    };
  }
  return out;
}

function parseEarnings(files: string[]): EarningsEvent[] {
  const out: EarningsEvent[] = [];
  for (const f of files) {
    const a = readAnswer(f) as Any;
    for (const r of a?.data?.results ?? []) {
      if (!r.symbol || !r.report?.date) continue;
      out.push({ symbol: r.symbol, date: r.report.date, timing: r.report.timing ?? null, reported: r.eps?.actual !== null && r.eps?.actual !== undefined && r.eps?.actual !== "" });
    }
  }
  return out;
}

/**
 * Option quotes, in either form:
 *  - raw get_option_instruments and get_option_quotes answers (any order, any number of files), joined by id;
 *  - a compact file {"SYM": [{strike, expiry, bid, ask, mark, delta, iv, open_interest}, ...]} (what a helper agent
 *    returns, so the raw chains never have to pass through the conversation).
 */
function parseOptions(files: string[]): Record<string, OptionQuote[]> {
  const inst = new Map<string, Any>();
  const quotes = new Map<string, Any>();
  const out: Record<string, OptionQuote[]> = {};
  for (const f of files) {
    const a = readAnswer(f) as Any;
    if (a && !a.data && typeof a === "object") {
      for (const [sym, rows] of Object.entries(a as Record<string, Any[]>)) {
        for (const q of rows ?? []) {
          (out[sym] ??= []).push({
            strike: Number(q.strike),
            expiry: q.expiry ?? q.expiration_date,
            bid: num(q.bid),
            ask: num(q.ask),
            mark: num(q.mark),
            delta: num(q.delta),
            iv: num(q.iv),
            openInterest: num(q.open_interest ?? q.openInterest),
          });
        }
      }
      continue;
    }
    for (const i of a?.data?.instruments ?? []) inst.set(i.id, i);
    for (const r of a?.data?.results ?? []) if (r.quote?.instrument_id) quotes.set(r.quote.instrument_id, r.quote);
  }
  for (const [id, i] of inst) {
    if (i.type && i.type !== "put") continue;
    const q = quotes.get(id);
    if (!q) continue;
    (out[i.chain_symbol] ??= []).push({
      strike: Number(i.strike_price),
      expiry: i.expiration_date,
      bid: num(q.bid_price),
      ask: num(q.ask_price),
      mark: num(q.mark_price),
      delta: num(q.delta),
      iv: num(q.implied_volatility),
      openInterest: num(q.open_interest),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

interface Manifest {
  run_date?: string;
  /** ignore bars after this date (e.g. a Monday re-run of Sunday's report, or a mid-session run) */
  through?: string;
  watchlist?: string;
  daily: string[];
  vix?: string;
  meta_scan?: string[];
  universe_scan?: string;
  earnings?: string[];
  options?: string[];
  narrative?: string;
}

function loadManifest(path: string) {
  const dir = dirname(resolve(path));
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  const at = (p: string) => resolve(dir, p);
  // files listed for later steps (quotes, the narrative) may not exist yet when quote-plan and context run
  const list = (ps?: string[]) => (ps ?? []).map(at).filter((p) => existsSync(p));
  const cut = (bars: Record<string, Bar[]>) =>
    m.through ? Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.filter((x) => x.date <= m.through!)])) : bars;
  return { m, at, list, cut, runDate: m.run_date ?? todayPt() };
}

function todayPt() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function sundayInputs(path: string, withNarrative: boolean) {
  const { m, at, list, cut, runDate } = loadManifest(path);
  if (!m.daily?.length) throw new Error("manifest.daily is empty: list the get_equity_historicals answer files");
  const watchlist: WatchItem[] = m.watchlist ? JSON.parse(readFileSync(at(m.watchlist), "utf8")) : [];
  const universe = m.universe_scan ? scanRows([at(m.universe_scan)]).map((r) => r.ticker as string) : [];
  const metaFiles = [...list(m.meta_scan), ...(m.universe_scan ? [at(m.universe_scan)] : [])];
  return {
    runDate,
    bars: cut(parseBars(list(m.daily))),
    vix: m.vix ? (cut({ VIX: Object.values(parseBars([at(m.vix)], true))[0] ?? [] }).VIX ?? []) : [],
    meta: parseMeta(metaFiles),
    watchlist,
    scanSymbols: universe,
    earnings: parseEarnings(list(m.earnings)),
    quotes: parseOptions(list(m.options)),
    narrative: withNarrative && m.narrative && existsSync(at(m.narrative)) ? (JSON.parse(readFileSync(at(m.narrative), "utf8")) as SundayNarrative) : emptyNarrative(),
  };
}

function checkNarrative(n: SundayNarrative) {
  const missing: string[] = [];
  if (!n.headline) missing.push("headline");
  if (!n.last_week?.summary) missing.push("last_week.summary");
  if (!n.this_week?.base_case) missing.push("this_week.base_case");
  if (!n.calendar?.length) missing.push("calendar");
  if ((n.gauges ?? []).length < 9) missing.push("gauges (all 9)");
  if (!n.plain_read?.favors) missing.push("plain_read");
  if (missing.length) throw new Error(`narrative is missing: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const SCAN_COLUMNS = [
  { display_name: "Sector", expression: "fundamental.morningstarSectorLabel", order: 1 },
  // Robinhood returns these two under their standard names whatever we call them, so ask for those names
  { display_name: "Implied volatility", expression: "atmIv30Day", order: 2 },
  { display_name: "IV rank", expression: "ivRank", order: 3 },
  { display_name: "Earnings date", expression: "fundamental.earningsYmd", order: 4 },
  { display_name: "Expirations", expression: "optionsExpirationStyles", order: 5 },
  { display_name: "Options volume", expression: 'optionsTotalVolumeAvg(candleCount=30, candlePeriod="1d")', order: 6 },
  { display_name: "Market cap", order: 7 },
];

function cmdScans(args: string[]) {
  const wl = opt(args, "--watchlist");
  const watch: WatchItem[] = wl ? JSON.parse(readFileSync(wl, "utf8")) : [];
  const symbols = [...new Set([...watch.map((w) => w.symbol), ...Object.keys(FUNDS), "SPY"])];
  const metaScan = { filters: [{ expression: "symbol", predicate: "PREDICATE_ANY_OF", values: symbols }], columns: SCAN_COLUMNS };
  const universeScan = {
    filters: [
      { expression: "symbol", predicate: "PREDICATE_IN_LIST", values: ["Russell1000"] },
      { filter_type: "FILTER_TYPE_MARKET_CAP", predicate: "PREDICATE_GREATER_THAN", values: [String(RULES.pick.minMarketCap)] },
      { filter_type: "FILTER_TYPE_AVERAGE_OPTIONS_VOLUME", interval: "1d", length: 30, predicate: "PREDICATE_GREATER_THAN", values: ["5000"] },
      { display_title: "vs 200D", expression: "distanceFrom200DaySmaRatio()", predicate: "PREDICATE_GREATER_THAN", values: ["0"] },
      { display_title: "52w pos", expression: 'pricePosInRange(candleCount=252, candlePeriod="1d")', predicate: "PREDICATE_GREATER_THAN", values: ["0.6"] },
      { display_title: "BB pos (%B)", expression: 'pricePosInBollinger(candleCount=20, candlePeriod="1d")', predicate: "PREDICATE_LESS_THAN", values: ["0.8"] },
    ],
    columns: SCAN_COLUMNS,
  };
  console.log(JSON.stringify({ meta_scan: metaScan, universe_scan: universeScan }, null, 2));
}

async function cmdSymbols(args: string[]) {
  const wl = opt(args, "--watchlist");
  const watch: WatchItem[] = wl ? JSON.parse(readFileSync(wl, "utf8")) : [];
  const scan = opt(args, "--scan");
  const universe = scan ? scanRows([scan]).map((r) => r.ticker as string) : [];
  const open = await openPicks();
  const symbols = [...new Set([...baseSymbols(), ...watch.map((w) => w.symbol), ...universe, ...open.map((p) => p.symbol)])];
  printBatches(symbols, 420);
}

function printBatches(symbols: string[], daysBack: number) {
  const start = new Date(Date.now() - daysBack * 864e5).toISOString().slice(0, 10) + "T00:00:00Z";
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += 10) batches.push(symbols.slice(i, i + 10));
  console.log(JSON.stringify({ interval: "day", start_time: start, count: symbols.length, batches }, null, 2));
}

function cmdQuotePlan(path: string) {
  const inp = sundayInputs(path, false);
  console.log(JSON.stringify(quotePlan(inp), null, 2));
}

async function cmdContext(path: string) {
  const inp = sundayInputs(path, false);
  const r = buildSunday(inp);
  const last = await lastWeekResults();
  console.log(JSON.stringify({ ...sundayContext(r), last_week_picks: last }, null, 2));
}

async function cmdBuild(path: string, dryRun: boolean) {
  const inp = sundayInputs(path, true);
  checkNarrative(inp.narrative);
  const report = buildSunday(inp);
  const settled = await settleOpenPicks(inp.bars, dryRun);
  console.log(`rules ${RULES_VERSION} · week of ${report.week_of} · data through ${report.as_of} · expiry ${report.expiry}`);
  console.log(`${report.candidates.length} names ranked, ${report.picks.length} picks${report.baseline ? " + SPY baseline" : ""}`);
  for (const p of report.picks) console.log(`  ${p.rank}. ${p.symbol} ${p.strike}p ${p.expiry} mid ${p.mid.toFixed(2)} (${(p.premium_weekly * 100).toFixed(2)}%/wk) score ${p.score}`);
  console.log(`settled ${settled} logged picks from earlier weeks`);
  if (dryRun) {
    console.log("dry run: nothing saved");
    return;
  }
  const client = createAdminClient();
  const { data: row, error } = await client
    .from("prep_reports")
    .upsert({ kind: "sunday", week_of: report.week_of, as_of: report.as_of, rules_version: RULES_VERSION, data: report }, { onConflict: "kind,week_of" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await client.from("pick_log").delete().eq("report_id", row.id).is("settled_at", null);
  const logs = [
    ...report.picks.map((p) => ({ rank: p.rank, is_baseline: false, symbol: p.symbol, score: p.score, strike: p.strike, expiration: p.expiry, premium: p.mid, underlying: p.last })),
    ...(report.baseline ? [{ rank: null, is_baseline: true, symbol: "SPY", score: null, strike: report.baseline.strike, expiration: report.baseline.expiry, premium: report.baseline.mid, underlying: report.baseline.last }] : []),
  ].map((l) => ({ ...l, report_id: row.id, week_of: report.week_of, rules_version: RULES_VERSION }));
  if (logs.length) {
    const { error: e2 } = await client.from("pick_log").insert(logs);
    if (e2) throw new Error(e2.message);
  }
  console.log(`saved report ${row.id} and logged ${logs.length} puts`);
}

async function latestSunday(): Promise<SundayReport> {
  const client = createAdminClient();
  const { data, error } = await client.from("prep_reports").select("data").eq("kind", "sunday").order("week_of", { ascending: false }).limit(1).single();
  if (error) throw new Error(`no Sunday report yet: ${error.message}`);
  return data.data as SundayReport;
}

async function cmdWedSymbols() {
  const sunday = await latestSunday();
  console.log(`# Sunday report for the week of ${sunday.week_of}, data through ${sunday.as_of}`);
  printBatches(wednesdaySymbols(sunday), 420);
}

async function wednesdayReport(path: string, withNarrative: boolean) {
  const { m, at, list, cut, runDate } = loadManifest(path);
  const sunday = await latestSunday();
  const narrative: WednesdayNarrative =
    withNarrative && m.narrative ? JSON.parse(readFileSync(at(m.narrative), "utf8")) : { headline: "", so_far: "", whats_left: "", outlook: "" };
  return buildWednesday({ runDate, sunday, bars: cut(parseBars(list(m.daily))), narrative });
}

async function cmdWedContext(path: string) {
  console.log(JSON.stringify(wednesdayContext(await wednesdayReport(path, false)), null, 2));
}

async function cmdWednesday(path: string, dryRun: boolean) {
  const r = await wednesdayReport(path, true);
  if (!r.narrative.headline || !r.narrative.so_far || !r.narrative.whats_left) throw new Error("narrative needs headline, so_far, whats_left and outlook");
  console.log(`Wednesday check for the week of ${r.week_of}, data through ${r.as_of}`);
  console.log(JSON.stringify(wednesdayContext(r), null, 2));
  if (dryRun) {
    console.log("dry run: nothing saved");
    return;
  }
  const client = createAdminClient();
  const { error } = await client
    .from("prep_reports")
    .upsert({ kind: "wednesday", week_of: r.week_of, as_of: r.as_of, rules_version: RULES_VERSION, data: r }, { onConflict: "kind,week_of" });
  if (error) throw new Error(error.message);
  console.log("saved");
}

// ---------------------------------------------------------------------------
// pick log
// ---------------------------------------------------------------------------

interface OpenPick {
  id: string;
  symbol: string;
  strike: number;
  premium: number;
  expiration: string;
}

async function openPicks(): Promise<OpenPick[]> {
  try {
    const client = createAdminClient();
    const { data, error } = await client.from("pick_log").select("id, symbol, strike, premium, expiration").is("settled_at", null);
    if (error) throw new Error(error.message);
    return (data ?? []).map((p) => ({ ...p, strike: Number(p.strike), premium: Number(p.premium) }));
  } catch (e) {
    console.error(`(could not read the pick log: ${(e as Error).message})`);
    return [];
  }
}

/** Settles logged puts whose expiration has passed, using the close on expiration day. */
async function settleOpenPicks(bars: Record<string, Bar[]>, dryRun: boolean) {
  const today = todayPt();
  let n = 0;
  const client = dryRun ? null : createAdminClient();
  for (const p of await openPicks()) {
    if (p.expiration >= today) continue;
    const close = closeOn(bars[p.symbol], p.expiration);
    if (close === null || !bars[p.symbol]?.some((b) => b.date === p.expiration)) {
      console.error(`  can't settle ${p.symbol} ${p.strike}p ${p.expiration}: no close for that day in the bars`);
      continue;
    }
    const s = settle(p, close);
    n++;
    console.log(`  ${p.symbol} ${p.strike}p ${p.expiration}: close ${close.toFixed(2)} → ${s.outcome}, ${s.pnl >= 0 ? "+" : ""}${s.pnl} per contract`);
    if (client) {
      const { error } = await client
        .from("pick_log")
        .update({ close_at_expiry: close, outcome: s.outcome, pnl: s.pnl, roc: s.roc, settled_at: new Date().toISOString() })
        .eq("id", p.id);
      if (error) throw new Error(error.message);
    }
  }
  return n;
}

async function lastWeekResults() {
  try {
    const client = createAdminClient();
    const { data } = await client.from("pick_log").select("symbol, is_baseline, strike, expiration, premium, outcome, pnl, roc, settled_at").order("expiration", { ascending: false }).limit(12);
    return data ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------

function opt(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const file = rest.find((a) => !a.startsWith("--"));
  const dry = rest.includes("--dry-run");
  const need = () => {
    if (!file) throw new Error(`${cmd} needs a manifest file`);
    return file;
  };
  switch (cmd) {
    case "scans":
      return cmdScans(rest);
    case "symbols":
      return cmdSymbols(rest);
    case "quote-plan":
      return cmdQuotePlan(need());
    case "context":
      return cmdContext(need());
    case "build":
      return cmdBuild(need(), dry);
    case "wed-symbols":
      return cmdWedSymbols();
    case "wed-context":
      return cmdWedContext(need());
    case "wednesday":
      return cmdWednesday(need(), dry);
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
