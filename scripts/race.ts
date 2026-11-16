/**
 * The AI-vs-Kyle paper race (docs/RACE.md has the routine). Paper only: nothing here places an order.
 *
 * Claude pulls market data with the Robinhood connector (read-only), saves each raw answer to a file, and runs:
 *
 *   npm run race -- status                              # the race, the paper account and the open week
 *   npm run race -- plan monday|wednesday [--spots f]   # what to quote (puts, covered calls) and which bars to fetch
 *   npm run race -- monday <manifest.json> [--dry-run]
 *   npm run race -- wednesday <manifest.json> [--dry-run]
 *   npm run race -- friday-plan                         # closes to fetch, the review's hindsight closes, the opponent
 *   npm run race -- friday <manifest.json> [--dry-run]  # settle, score the week, grade both sides' trades
 *   npm run race -- review <narrative.json> [--dry-run] # save the Friday review's narrative and its lessons
 *
 *   npm run race -- init --capital 140000 --start 2026-11-02 --opponent Individual --opp-baseline <value>
 *   npm run race -- import-artifact <state.json> <trades.json> <weeks.json> --opp-last <value>   # one-time move from the old dashboard
 *
 * All decisions come from src/lib/race.ts on top of src/lib/rules.ts and the week's Sunday report.
 */
import "./env";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createAdminClient, selectAll } from "../src/lib/supabase";
import type { SundayReport } from "../src/lib/prep";
import {
  Refused,
  buildReview,
  finishWeek,
  friday,
  gradeAi,
  gradeKyle,
  monday,
  newState,
  quotePlan,
  reviewCloseNeeds,
  wednesday,
  type RaceState,
  type ReviewNarrative,
  type RunResult,
  type Trade,
  type WeekRow,
} from "../src/lib/race";
import { buildChains } from "../src/lib/reports";
import { RULES_VERSION, targetExpiry, type Bar } from "../src/lib/rules";
import type { PositionRow } from "../src/lib/types";
import { num, parseBars, parseOptions, type Any } from "./answers";

const SLUG = process.env.RACE_SLUG || "ai-vs-kyle";
const db = createAdminClient();

function todayPt() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Monday of a date's week. */
function mondayOf(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

interface Race {
  id: string;
  slug: string;
  name: string;
  starts_on: string;
  capital: number;
  opponent_account_id: string | null;
  opponent_baseline: number | null;
}

async function getRace(): Promise<Race> {
  const { data, error } = await db.from("races").select("*").eq("slug", SLUG).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`no race "${SLUG}" yet: run init first`);
  return { ...data, capital: Number(data.capital), opponent_baseline: num(data.opponent_baseline) } as Race;
}

async function loadState(race: Race) {
  const { data, error } = await db.from("race_state").select("state, version").eq("race_id", race.id).single();
  if (error) throw new Error(`race state: ${error.message}`);
  return { state: data.state as RaceState, version: data.version as number };
}

async function loadTrades(race: Race): Promise<Trade[]> {
  const rows = await selectAll<Any>((a, b) => db.from("race_trades").select("*").eq("race_id", race.id).order("id").range(a, b));
  return rows.map((r) => ({
    ...r,
    strike: num(r.strike),
    qty: num(r.qty),
    price: num(r.price),
    bid: num(r.bid),
    ask: num(r.ask),
    cash: num(r.cash),
  })) as Trade[];
}

/** The Sunday report for the week of `date` (the latest one, with a warning, if this week's isn't in yet). */
async function sundayFor(date: string): Promise<SundayReport> {
  const week = mondayOf(date);
  const { data } = await db.from("prep_reports").select("data").eq("kind", "sunday").eq("week_of", week).maybeSingle();
  if (data) return data.data as SundayReport;
  const { data: last, error } = await db.from("prep_reports").select("data").eq("kind", "sunday").order("week_of", { ascending: false }).limit(1).single();
  if (error) throw new Error(`no Sunday report: ${error.message}`);
  console.warn(`! no Sunday report for the week of ${week}; using the one for ${(last.data as SundayReport).week_of}`);
  return last.data as SundayReport;
}

/** Save a run: the state pinned to the version read, then its trades, the week row and the review. */
async function save(race: Race, version: number, res: RunResult, extra: { review?: unknown } = {}) {
  const { data, error } = await db
    .from("race_state")
    .update({ state: res.state, version: version + 1, updated_at: new Date().toISOString() })
    .eq("race_id", race.id)
    .eq("version", version)
    .select("version");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("REFUSED: the race state changed since it was read (another run?). Nothing saved.");
  if (res.trades.length) {
    const { error: e } = await db.from("race_trades").upsert(res.trades.map((t) => ({ ...t, race_id: race.id })), { onConflict: "race_id,id" });
    if (e) throw new Error(`trades: ${e.message}`);
  }
  if (res.week) {
    const all = await loadTrades(race);
    const row = finishWeek(res.week, all);
    const { error: e } = await db.from("race_weeks").upsert({ ...row, race_id: race.id }, { onConflict: "race_id,week" });
    if (e) throw new Error(`week: ${e.message}`);
  }
  if (extra.review && res.week) {
    const { error: e } = await db.from("race_reviews").upsert({ race_id: race.id, week: res.week.week, data: extra.review }, { onConflict: "race_id,week" });
    if (e) throw new Error(`review: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// manifests
// ---------------------------------------------------------------------------

interface Manifest {
  date?: string;
  puts?: string[]; // put quotes: compact {"SYM": [rows]} files or raw instrument + quote answers
  calls?: string[];
  no_weekly?: string[]; // symbols with no contracts that Friday
  spots?: string; // {"SYM": price}
  daily?: string[]; // get_equity_historicals answers
  through?: string; // ignore bars after this date
  opp?: { value: number; flows?: number; pending?: number } | null;
}

function loadManifest(path: string) {
  const dir = dirname(resolve(path));
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  const at = (p: string) => resolve(dir, p);
  const files = (ps?: string[]) => (ps ?? []).map(at).filter((p) => existsSync(p));
  let bars = files(m.daily).length ? parseBars(files(m.daily)) : {};
  if (m.through) bars = Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.filter((x) => x.date <= m.through!)]));
  const book = (type: "put" | "call") => {
    const q = files(type === "put" ? m.puts : m.calls).length ? parseOptions(files(type === "put" ? m.puts : m.calls), type) : {};
    for (const s of m.no_weekly ?? []) q[s] ??= [];
    return q;
  };
  const spots: Record<string, number> = m.spots && existsSync(at(m.spots)) ? JSON.parse(readFileSync(at(m.spots), "utf8")) : {};
  return { m, date: m.date ?? todayPt(), bars, puts: book("put"), calls: book("call"), spots };
}

function print(res: RunResult) {
  console.log(res.report.join("\n"));
}

function run<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof Refused) {
      console.log(`REFUSED: ${e.message}. Nothing saved.`);
      process.exit(2);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdStatus() {
  const race = await getRace();
  const { state, version } = await loadState(race);
  const weeks = await selectAll<Any>((a, b) => db.from("race_weeks").select("week, date, ai_return, opp_return").eq("race_id", race.id).order("week").range(a, b));
  console.log(`${race.name} (${race.slug}), started ${race.starts_on} with $${race.capital.toLocaleString("en-US")}. State v${version}, rules ${RULES_VERSION}.`);
  console.log(`Week ${state.week}${state.current ? ` open since ${state.current.opened}, expiry ${state.current.expiry}` : " settled"}; last run ${state.lastRun?.kind ?? "none"} ${state.lastRun?.at ?? ""}.`);
  console.log(`Cash $${Math.round(state.cash).toLocaleString("en-US")}; lots: ${state.lots.map((l) => `${l.symbol} ${l.shares}@${l.cost}`).join(", ") || "none"}; options: ${state.options.map((o) => `${o.symbol} ${o.strike}${o.type[0].toUpperCase()} x${o.contracts} ${o.expiration}`).join(", ") || "none"}.`);
  for (const w of weeks) console.log(`  week ${w.week} ${w.date}: AI ${(Number(w.ai_return) * 100).toFixed(2)}%  Kyle ${w.opp_return === null ? "—" : (Number(w.opp_return) * 100).toFixed(2) + "%"}`);
}

async function cmdPlan(kind: "monday" | "wednesday", spotsPath: string | undefined, date: string) {
  const race = await getRace();
  const { state } = await loadState(race);
  const report = await sundayFor(date);
  const spots: Record<string, number> = spotsPath ? JSON.parse(readFileSync(spotsPath, "utf8")) : {};
  const expiry = kind === "wednesday" && state.current ? state.current.expiry : targetExpiry(date);
  const plan = quotePlan(state, kind, report.candidates, expiry, spots);
  console.log(`# ${kind} plan for ${date}: Sunday report of ${report.week_of} (rules ${report.rules_version}), ${report.candidates.filter((c) => c.eligible).length} eligible candidates`);
  console.log(`# spots needed (lots${kind === "wednesday" ? " and open puts" : ""}): ${[...new Set([...state.lots.map((l) => l.symbol), ...(kind === "wednesday" ? state.options.map((o) => o.symbol) : [])])].join(", ") || "none"}`);
  console.log(JSON.stringify(plan, null, 2));
}

async function cmdMonday(path: string, dryRun: boolean) {
  const race = await getRace();
  const { state, version } = await loadState(race);
  const { date, puts, calls, spots } = loadManifest(path);
  const report = await sundayFor(date);
  const res = run(() => monday(state, { date, expiry: targetExpiry(date), candidates: report.candidates, quotes: { puts, calls }, spots }));
  print(res);
  if (dryRun) return console.log("dry run: nothing saved");
  await save(race, version, res);
  console.log("saved");
}

async function cmdWednesday(path: string, dryRun: boolean) {
  const race = await getRace();
  const { state, version } = await loadState(race);
  const { date, puts, calls, spots, bars } = loadManifest(path);
  const report = await sundayFor(date);
  const res = run(() => wednesday(state, { date, candidates: report.candidates, quotes: { puts, calls }, spots, bars }));
  print(res);
  if (dryRun) return console.log("dry run: nothing saved");
  await save(race, version, res);
  console.log("saved");
}

async function opponentChains(race: Race) {
  if (!race.opponent_account_id) return [];
  const rows = await selectAll<PositionRow>((a, b) => db.from("v_positions").select("*").eq("account_id", race.opponent_account_id!).range(a, b));
  return buildChains(rows);
}

async function cmdFridayPlan(date: string) {
  const race = await getRace();
  const { state } = await loadState(race);
  const trades = await loadTrades(race);
  const chains = await opponentChains(race);
  const from = mondayOf(date);
  const expiring = state.options.filter((o) => o.expiration <= date);
  const needs = reviewCloseNeeds(trades, chains, race.opponent_account_id ?? "", from, date);
  const symbols = [...new Set([...expiring.map((o) => o.symbol), ...state.lots.map((l) => l.symbol), ...needs.map((n) => n.split("@")[0])])].sort();
  const start = new Date(`${date}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 45);
  console.log(JSON.stringify({
    date,
    week: state.current?.week ?? state.week + 1,
    daily_bars: { symbols, interval: "day", start_time: `${start.toISOString().slice(0, 10)}T00:00:00Z`, why: "official closes for settlement, the stop on shares, and the review's hindsight" },
    expiring: expiring.map((o) => `${o.symbol} ${o.strike} ${o.type} ${o.expiration}`),
    review_closes: needs,
    opponent: race.opponent_account_id ? "the opponent account (Individual): get_portfolio total_value and pending_deposits" : null,
  }, null, 2));
}

async function cmdFriday(path: string, dryRun: boolean) {
  const race = await getRace();
  const { state, version } = await loadState(race);
  const { m, date, bars, spots } = loadManifest(path);
  const closes: Record<string, number> = {};
  const provisional: string[] = [];
  const closeOn = (sym: string, day: string) => (bars[sym] as Bar[] | undefined)?.find((b) => b.date === day)?.close;
  for (const o of state.options.filter((x) => x.expiration <= date)) {
    const c = closeOn(o.symbol, o.expiration) ?? spots[o.symbol];
    if (c !== undefined) closes[o.symbol] = c;
    if (closeOn(o.symbol, o.expiration) === undefined && spots[o.symbol] !== undefined) provisional.push(o.symbol);
  }
  for (const l of state.lots) {
    const c = closeOn(l.symbol, date) ?? spots[l.symbol];
    if (c !== undefined) closes[l.symbol] = c;
  }
  const res = run(() => friday(state, { date, closes, bars, opp: m.opp ? { value: m.opp.value, flows: m.opp.flows ?? 0, pending: m.opp.pending } : null }));
  if (provisional.length && res.week) res.week.note = `${res.week.note} Provisional close (last trade) for ${provisional.join(", ")}.`.trim();

  // the review: both sides' trades that finished this week
  const trades = [...(await loadTrades(race)), ...res.trades];
  const chains = await opponentChains(race);
  const from = mondayOf(date);
  const hindsight: Record<string, number> = {};
  for (const k of reviewCloseNeeds(trades, chains, race.opponent_account_id ?? "", from, date)) {
    const [sym, day] = k.split("@");
    const c = closeOn(sym, day);
    if (c !== undefined) hindsight[k] = c;
  }
  for (const o of state.options.filter((x) => x.expiration <= date)) if (closes[o.symbol] !== undefined) hindsight[`${o.symbol}@${o.expiration}`] = closes[o.symbol];
  const review = buildReview(res.week!.week, from, date, gradeAi(trades, from, date, hindsight), gradeKyle(chains, race.opponent_account_id ?? "", from, date, hindsight), null);

  print(res);
  console.log(`\nReview context (write the narrative from this, then run: npm run race -- review <narrative.json>):`);
  console.log(JSON.stringify({ week: res.week, ai: review.ai, kyle: review.kyle }, null, 2));
  if (dryRun) return console.log("dry run: nothing saved");
  await save(race, version, res, { review });
  console.log("saved");
}

async function cmdReview(path: string, dryRun: boolean) {
  const race = await getRace();
  const n = JSON.parse(readFileSync(path, "utf8")) as ReviewNarrative;
  const missing = ["headline", "buybacks"].filter((k) => !(n as unknown as Any)[k]);
  if (missing.length) throw new Error(`narrative is missing: ${missing.join(", ")}`);
  const { data, error } = await db.from("race_reviews").select("week, data").eq("race_id", race.id).order("week", { ascending: false }).limit(1).single();
  if (error) throw new Error(`no review to add the narrative to: ${error.message}`);
  console.log(`Week ${data.week}: ${n.headline}\n${(n.lessons ?? []).length} lessons`);
  if (dryRun) return console.log("dry run: nothing saved");
  const { error: e1 } = await db.from("race_reviews").update({ data: { ...data.data, narrative: n } }).eq("race_id", race.id).eq("week", data.week);
  if (e1) throw new Error(e1.message);
  await db.from("race_lessons").delete().eq("race_id", race.id).eq("week", data.week).eq("status", "proposed");
  if (n.lessons?.length) {
    const { error: e2 } = await db.from("race_lessons").insert(n.lessons.map((l) => ({ ...l, race_id: race.id, week: data.week })));
    if (e2) throw new Error(e2.message);
  }
  console.log("saved");
}

async function cmdInit(args: Record<string, string>) {
  const capital = Number(args.capital ?? 140000);
  const start = args.start ?? todayPt();
  let oppId: string | null = null;
  if (args.opponent) {
    const { data, error } = await db.from("accounts").select("id").eq("name", args.opponent).single();
    if (error) throw new Error(`account "${args.opponent}": ${error.message}`);
    oppId = data.id;
  }
  const baseline = args["opp-baseline"] ? Number(args["opp-baseline"]) : null;
  const { data: race, error } = await db
    .from("races")
    .insert({ slug: SLUG, name: args.name ?? "AI vs Kyle", starts_on: start, capital, opponent_account_id: oppId, opponent_baseline: baseline })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const state = newState(capital, start, baseline);
  const { error: e } = await db.from("race_state").insert({ race_id: race.id, state });
  if (e) throw new Error(e.message);
  console.log(`created race ${SLUG} starting ${start} with $${capital.toLocaleString("en-US")}`);
}

/** One-time move from the old artifact dashboard: its engine state, trade log and week rows. */
async function cmdImport(statePath: string, tradesPath: string, weeksPath: string, oppLast: number | null, dryRun: boolean) {
  const race = await getRace();
  const old = JSON.parse(readFileSync(statePath, "utf8")) as Any;
  const s = old.data ?? old;
  const theme = (x: Any) => x.theme ?? (x.sector === "Funds" ? "Funds" : x.sector) ?? "Other";
  const state: RaceState = {
    capital: s.rules?.capital ?? race.capital,
    start: s.start,
    cash: s.cash,
    lots: s.lots.map((l: Any) => ({ id: l.id, symbol: l.symbol, theme: theme(l), shares: l.shares, cost: l.cost, mark: l.mark, opened: l.opened })),
    options: s.options.map((o: Any) => ({ id: o.id, type: o.type, symbol: o.symbol, theme: theme(o), strike: o.strike, expiration: o.expiration, contracts: o.contracts, price: o.price, opened: o.opened, week: o.week, setup: o.setup })),
    seq: s.seq,
    week: s.week,
    lastValue: s.weeks.at(-1)?.ai_value ?? race.capital,
    peak: s.ai_peak,
    maxDrawdown: s.ai_max_drawdown,
    opp: { index: s.kyle.index, peak: s.kyle.peak, maxDrawdown: s.kyle.max_drawdown, lastValue: oppLast },
    current: s.current ? { week: s.current.week, opened: s.current.opened, expiry: s.current.expiry, valueAtOpen: s.current.value_at_open } : null,
    lastRun: s.last_run ? { kind: s.last_run.kind, at: String(s.last_run.at).slice(0, 10), week: s.last_run.week } : null,
  };
  const rawTrades = JSON.parse(readFileSync(tradesPath, "utf8")) as Any[];
  // the old log has no position ids: tie each close to the latest open of the same contract
  const openBy = new Map<string, string>();
  const trades: Trade[] = rawTrades.map((t) => {
    const key = `${t.symbol}|${t.type}|${t.strike}|${t.expiration}`;
    let pos: string | null = null;
    if (t.action === "Sold put" || t.action === "Sold call") {
      pos = `${t.id}`;
      openBy.set(key, pos);
    } else if (["Expired", "Assigned", "Called away", "Bought back"].includes(t.action)) pos = openBy.get(key) ?? null;
    return {
      id: t.id,
      date: t.date,
      week: t.week,
      action: t.action,
      symbol: t.symbol,
      type: t.type,
      strike: t.strike,
      expiration: t.expiration,
      qty: t.qty,
      price: t.price,
      bid: t.bid,
      ask: t.ask,
      cash: t.cash,
      note: t.note ?? "",
      position_id: pos,
      rules_version: "artifact",
    };
  });
  const weeks = (JSON.parse(readFileSync(weeksPath, "utf8")) as Any[]).map(
    (w): WeekRow => ({
      week: w.week,
      date: w.date,
      label: w.label,
      ai_value: w.ai_value,
      ai_return: w.ai_return,
      ai_week_return: w.ai_week_return,
      ai_drawdown: w.ai_drawdown,
      ai_max_drawdown: w.ai_max_drawdown,
      opp_value: null,
      opp_return: w.kyle_return,
      opp_week_return: w.kyle_week_return,
      opp_drawdown: w.kyle_drawdown,
      opp_max_drawdown: w.kyle_max_drawdown,
      opp_flows: 0,
      premium: w.premium,
      exposure: w.exposure,
      leverage: w.leverage,
      counts: { puts_sold: w.puts_sold, puts_expired: w.puts_expired, puts_assigned: w.puts_assigned, calls_sold: w.calls_sold, calls_expired: w.calls_expired, calls_called: w.calls_called },
      note: w.note ?? "",
      rules_version: "artifact",
    }),
  );
  // open options take their opening trade's id, so Friday's settlement ties back to the sale
  for (const o of state.options) o.id = openBy.get(`${o.symbol}|${o.type}|${o.strike}|${o.expiration}`) ?? o.id;
  console.log(`week ${state.week}${state.current ? " (open)" : ""}, cash ${Math.round(state.cash)}, ${state.lots.length} lots, ${state.options.length} options, ${trades.length} trades, ${weeks.length} weeks`);
  if (dryRun) return console.log("dry run: nothing saved");
  const { error: e1 } = await db.from("race_state").update({ state, version: 2, updated_at: new Date().toISOString() }).eq("race_id", race.id);
  if (e1) throw new Error(e1.message);
  const { error: e2 } = await db.from("race_trades").upsert(trades.map((t) => ({ ...t, race_id: race.id })), { onConflict: "race_id,id" });
  if (e2) throw new Error(e2.message);
  const { error: e3 } = await db.from("race_weeks").upsert(weeks.map((w) => ({ ...w, race_id: race.id })), { onConflict: "race_id,week" });
  if (e3) throw new Error(e3.message);
  console.log("imported");
}

function flags(rest: string[]) {
  const out: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const k = rest[i].slice(2);
      const v = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
      out[k] = v;
    } else pos.push(rest[i]);
  }
  return { f: out, pos };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { f, pos } = flags(rest);
  const dry = f["dry-run"] === "true";
  const date = f.date ?? todayPt();
  switch (cmd) {
    case "status":
      return cmdStatus();
    case "plan":
      if (pos[0] !== "monday" && pos[0] !== "wednesday") throw new Error("usage: plan monday|wednesday [--spots spots.json] [--date YYYY-MM-DD]");
      return cmdPlan(pos[0], f.spots, date);
    case "monday":
      return cmdMonday(pos[0], dry);
    case "wednesday":
      return cmdWednesday(pos[0], dry);
    case "friday-plan":
      return cmdFridayPlan(date);
    case "friday":
      return cmdFriday(pos[0], dry);
    case "review":
      return cmdReview(pos[0], dry);
    case "init":
      return cmdInit(f);
    case "import-artifact":
      return cmdImport(pos[0], pos[1], pos[2], f["opp-last"] ? Number(f["opp-last"]) : null, dry);
    default:
      throw new Error(`unknown command "${cmd ?? ""}": see the header of scripts/race.ts`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
