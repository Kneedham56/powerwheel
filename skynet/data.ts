/**
 * Skynet historical data: ThetaData (via the local Theta Terminal) + free reference series -> local DuckDB.
 * Runbook: docs/SKYNET-DATA.md
 *
 *   npm run skynet -- universe [--refresh]       symbol list + expiration history (finds weekly names, delisted ones too)
 *   npm run skynet -- plan [--from D] [--to D]   which symbols a pull would cover, and an estimate
 *   npm run skynet -- pull [--from 2016-01-01] [--to <yesterday>] [--symbols A,B] [--limit N]
 *                          [--concurrency 4] [--max-dte N] [--no-oi] [--no-stock]
 *   npm run skynet -- ref                        VIX family (Cboe), 3-month T-bill (FRED), Theta rates
 *   npm run skynet -- status
 *
 * Pulls are resumable: run the same command again and it skips what is already stored.
 * Days are fetched newest-first, so a tier's history limit is found on the first refused day.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pullBars } from "./alpaca";
import { DB_PATH, PARQUET_DIR, PROGRESS_FILE, Store, q } from "./store";
import { thetaGet } from "./theta";

// ---------------------------------------------------------------------------
// args and dates
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv[0];
function opt(name: string, dflt?: string) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
}
const flag = (name: string) => argv.includes(`--${name}`);

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
const compact = (s: string) => s.replace(/-/g, "");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

function weekdaysDesc(from: string, to: string) {
  const out: string[] = [];
  for (let d = to; d >= from; d = addDays(d, -1)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out;
}

function monthsDesc(from: string, to: string) {
  const out: { start: string; end: string }[] = [];
  let m = to.slice(0, 7);
  while (`${m}-31` >= from) {
    const [y, mo] = m.split("-").map(Number);
    const last = ymd(new Date(Date.UTC(y, mo, 0, 12)));
    out.push({ start: `${m}-01` < from ? from : `${m}-01`, end: last > to ? to : last });
    m = ymd(new Date(Date.UTC(y, mo - 2, 1, 12))).slice(0, 7);
  }
  return out;
}

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
// Cash-settled index options: can't be wheeled, and their chains are huge.
const EXCLUDE = new Set(["SPX", "SPXW", "XSP", "NDX", "NDXP", "XND", "RUT", "RUTW", "MRUT", "VIX", "VIXW", "DJX", "OEX", "XEO"]);
const CORE = ["SPY", "QQQ", "IWM"];

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping after the requests in flight finish (Ctrl-C again to force; nothing is lost either way).");
});

const MIN_FREE = 30e9;
function freeBytes(): number | null {
  try {
    const s = statfsSync(dirname(DB_PATH));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  return n;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length && !stopping) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

const fmtN = (n: number) => n.toLocaleString("en-US");
const fmtDur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`;
};

// ---------------------------------------------------------------------------
// tier gates: learned from the first refused request, shared by all symbols
// ---------------------------------------------------------------------------

interface Gate {
  name: string;
  off: boolean;
  floor: string | null; // days on or before this were refused (history limit)
}
const gate = (name: string): Gate => ({ name, off: false, floor: null });
const allowed = (g: Gate, day: string) => !g.off && (g.floor === null || day > g.floor);

function refused(g: Gate, day: string, recentFrom: string, message: string) {
  if (day >= recentFrom) {
    if (!g.off) console.log(`  ${g.name}: not in this subscription, skipping it (${message.slice(0, 90)})`);
    g.off = true;
  } else if (g.floor === null || day > g.floor) {
    if (g.floor === null) console.log(`  ${g.name}: history stops after ${day} on this subscription`);
    g.floor = day;
  }
}

// ---------------------------------------------------------------------------
// universe
// ---------------------------------------------------------------------------

async function universe(store: Store) {
  console.log("Fetching the option symbol list…");
  const r = await thetaGet("option/list/symbols", {});
  if (r.kind !== "ok") throw new Error(`symbol list: ${r.kind}`);
  await store.load({ table: "option_symbols", csv: r.csv, replaceWhere: "true" });
  const done = new Set(
    flag("refresh") ? [] : (await store.all<{ symbol: string }>(`SELECT symbol FROM fetch_log WHERE endpoint = 'expirations'`)).map((x) => x.symbol),
  );
  const syms = (await store.all<{ symbol: string }>(`SELECT symbol FROM option_symbols ORDER BY symbol`))
    .map((x) => x.symbol)
    .filter((s) => SYMBOL_RE.test(s) && !/\d/.test(s) && !EXCLUDE.has(s) && !done.has(s));
  console.log(`${fmtN(syms.length)} symbols need expiration history (${fmtN(done.size)} already stored).`);
  let n = 0;
  const t0 = Date.now();
  await pool(syms, Number(opt("concurrency", "4")), async (sym) => {
    const e = await thetaGet("option/list/expirations", { symbol: sym });
    if (e.kind === "forbidden") throw new Error(`expirations refused: ${e.message}`);
    await store.load({
      table: "option_expirations",
      csv: e.kind === "ok" ? e.csv : null,
      replaceWhere: `symbol = ${q(sym)}`,
      log: { endpoint: "expirations", symbol: sym, day: "1970-01-01", status: e.kind === "ok" ? "ok" : "no_data", ms: e.ms },
    });
    if (++n % 500 === 0) console.log(`  ${fmtN(n)} / ${fmtN(syms.length)}  (${fmtDur(Date.now() - t0)})`);
  });
  await store.exportTable("option_expirations");
  console.log(`Done: ${fmtN(n)} symbols in ${fmtDur(Date.now() - t0)}.`);
}

interface USym {
  symbol: string;
  weekly_months: number;
  exps: number;
  first_exp: string;
  last_exp: string;
}

/** Names that had weekly options (3+ expirations in a month) in at least `minMonths` months of the window. */
async function weeklyUniverse(store: Store, from: string, to: string, minMonths: number): Promise<USym[]> {
  const rows = await store.all<USym>(`
    WITH m AS (
      SELECT symbol, date_trunc('month', expiration) AS mo, count(*) AS n
      FROM option_expirations
      WHERE expiration BETWEEN DATE ${q(from)} AND DATE ${q(addDays(to, 60))}
      GROUP BY ALL),
    w AS (SELECT symbol, count(*) FILTER (WHERE n >= 3) AS weekly_months, sum(n) AS exps FROM m GROUP BY symbol),
    e AS (SELECT symbol, min(expiration) AS f, max(expiration) AS l FROM option_expirations GROUP BY symbol)
    SELECT w.symbol, w.weekly_months, w.exps, strftime(e.f, '%Y-%m-%d') AS first_exp, strftime(e.l, '%Y-%m-%d') AS last_exp
    FROM w JOIN e USING (symbol)
    WHERE w.weekly_months >= ${minMonths}
    ORDER BY w.weekly_months DESC, w.exps DESC`);
  const keep = rows.filter((r) => !EXCLUDE.has(r.symbol));
  const core = CORE.map((s) => keep.find((r) => r.symbol === s)).filter((r): r is USym => !!r);
  return [...core, ...keep.filter((r) => !CORE.includes(r.symbol))];
}

function window(): { from: string; to: string } {
  const from = opt("from", "2016-01-01")!;
  const to = opt("to", addDays(today(), -1))!;
  if (!isDate(from) || !isDate(to) || from > to) throw new Error(`bad --from/--to: ${from} ${to}`);
  return { from, to };
}

async function lookup(store: Store, list: string[], from: string, to: string): Promise<USym[]> {
  for (const s of list) if (!SYMBOL_RE.test(s)) throw new Error(`bad symbol: ${s}`);
  if (!list.length) return [];
  const known = await store.all<USym>(`
    SELECT symbol, 0 AS weekly_months, count(*) AS exps, strftime(min(expiration), '%Y-%m-%d') AS first_exp, strftime(max(expiration), '%Y-%m-%d') AS last_exp
    FROM option_expirations WHERE symbol IN (${list.map(q).join(", ")}) GROUP BY symbol`);
  return list.map((s) => known.find((k) => k.symbol === s) ?? { symbol: s, weekly_months: 0, exps: 0, first_exp: from, last_exp: to });
}

const MISSING_BARS = join(PARQUET_DIR, "stock_bars", "_missing.json");

/** data/priority.txt (written by `priority`, gitignored): symbols pulled before the rest of the universe. */
const PRIORITY_FILE = join(dirname(DB_PATH), "priority.txt");
const readPriority = () =>
  existsSync(PRIORITY_FILE)
    ? readFileSync(PRIORITY_FILE, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim().toUpperCase()).filter(Boolean)
    : [];

async function targets(store: Store, from: string, to: string): Promise<USym[]> {
  const explicit = opt("symbols");
  if (explicit) return lookup(store, explicit.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean), from, to);
  const n = (await store.all<{ n: number }>(`SELECT count(*) AS n FROM option_expirations`))[0].n;
  if (!n) throw new Error("No expiration history yet: run `npm run skynet -- universe` first (or pass --symbols).");
  // Priority names first (only those that ever had listed options), then the weekly universe.
  const pri = flag("no-priority") ? [] : (await lookup(store, [...new Set(readPriority())], from, to)).filter((s) => s.exps > 0);
  const seen = new Set(pri.map((s) => s.symbol));
  // Roots with no stock bars at Alpaca are index or other non-equity products (MSCI indexes,
  // micro index options): they can't be wheeled, so skip them (priority names always stay).
  const noBars = new Set<string>(existsSync(MISSING_BARS) ? JSON.parse(readFileSync(MISSING_BARS, "utf8")).symbols : []);
  const rest = flag("priority-only")
    ? []
    : (await weeklyUniverse(store, from, to, Number(opt("min-weekly-months", "3")))).filter((s) => !seen.has(s.symbol) && !noBars.has(s.symbol));
  const u = [...pri, ...rest];
  const limit = opt("limit");
  return limit ? u.slice(0, Number(limit)) : u;
}

/**
 * Write data/priority.txt from the app's database: index ETFs, then every ticker Kyle has traded
 * (most-traded first), then every symbol that has appeared in a prep report. The file stays local
 * (it's under data/), so the traded list never reaches the public repo.
 */
async function priority() {
  await import("../scripts/env");
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const traded = (await client.query(`SELECT upper(ticker) AS s FROM positions GROUP BY 1 ORDER BY count(*) DESC, 1`)).rows.map((r) => r.s as string);
    const prep = (
      await client.query(`
        SELECT s FROM (SELECT DISTINCT id, jsonb_path_query(data, 'strict $.**.symbol') #>> '{}' AS s FROM prep_reports) x
        GROUP BY s ORDER BY count(*) DESC, s`)
    ).rows.map((r) => r.s as string);
    const clean = (xs: string[]) => xs.filter((s) => SYMBOL_RE.test(s) && !EXCLUDE.has(s));
    const sections = [
      ["index ETFs", CORE],
      ["traded (most first)", clean(traded)],
      ["prep reports", clean(prep)],
    ] as const;
    const seen = new Set<string>();
    const lines = ["# Skynet pull priority: generated by `npm run skynet -- priority`; edit freely. Local only (data/ is gitignored)."];
    for (const [name, list] of sections) {
      const fresh = list.filter((s) => !seen.has(s));
      fresh.forEach((s) => seen.add(s));
      lines.push(`# ${name}`, ...fresh);
    }
    mkdirSync(dirname(PRIORITY_FILE), { recursive: true });
    writeFileSync(PRIORITY_FILE, lines.join("\n") + "\n");
    console.log(`Wrote ${PRIORITY_FILE}: ${seen.size} symbols (${sections.map(([n, l]) => `${n} ${l.length}`).join(", ")}).`);
  } finally {
    await client.end();
  }
}

/** The days worth asking about for a symbol: from a bit before its first expiry to its last. */
const symRange = (s: USym, from: string, to: string) => ({
  start: addDays(s.first_exp, -120) > from ? addDays(s.first_exp, -120) : from,
  end: s.last_exp < to ? s.last_exp : to,
});

async function plan(store: Store) {
  const { from, to } = window();
  const u = await targets(store, from, to);
  const avg = (await store.all<{ ms: number | null }>(`SELECT avg(ms) AS ms FROM fetch_log WHERE endpoint LIKE 'option_%' AND status = 'ok'`))[0].ms ?? 1000;
  const conc = Number(opt("concurrency", "4"));
  const calendar = await tradingCalendar(store, from, to);
  const est = (list: USym[], label: string) => {
    const parts = (["core", "rest", "all"] as DaysMode[]).map((m) => {
      let calls = 0;
      for (const s of list) {
        const { start, end } = symRange(s, from, to);
        const sc = schedule(calendar.filter((d) => d >= start && d <= end), m);
        calls += sc.quotes.length + (flag("no-oi") ? 0 : sc.oi.length);
      }
      return `${m} ~${fmtN(calls)} req, ${fmtDur((calls * avg) / conc)}`;
    });
    console.log(`${label} (${fmtN(list.length)} symbols): ${parts.join(" | ")}`);
  };
  console.log(`Window ${from} .. ${to}, at ~${Math.round(avg)}ms per request and ${conc} at a time (before skipping what's stored):`);
  const pri = new Set(readPriority());
  const head = u.filter((s) => pri.has(s.symbol));
  if (head.length) est(head, "  priority list");
  est(u, "  everything");
  console.log(u.slice(0, 40).map((s) => `${s.symbol}(${s.weekly_months})`).join(" "));
  if (u.length > 40) console.log(`… and ${fmtN(u.length - 40)} more`);
}

// ---------------------------------------------------------------------------
// trading days and the two-pass schedule
// ---------------------------------------------------------------------------

/** Trading days, newest first: SPY's Alpaca bars when present (skips holidays), else weekdays. */
async function tradingCalendar(store: Store, from: string, to: string): Promise<string[]> {
  const spy = join(PARQUET_DIR, "stock_bars", "SPY.parquet");
  if (existsSync(spy)) {
    const rows = await store.all<{ d: string }>(
      `SELECT DISTINCT strftime(date, '%Y-%m-%d') AS d FROM read_parquet(${q(spy.replace(/\\/g, "/"))}) WHERE adjustment = 'raw' ORDER BY 1 DESC`,
    );
    const last = rows[0]?.d ?? "";
    // Days after the last bar (bars not refreshed yet) fall back to weekdays.
    const tail = last < to ? weekdaysDesc(addDays(last, 1) > from ? addDays(last, 1) : from, to) : [];
    return [...tail, ...rows.map((r) => r.d).filter((d) => d >= from && d <= to)];
  }
  return weekdaysDesc(from, to);
}

/**
 * The days the wheel engine trades on: each week's first trading day (entry), its Wednesday
 * (take-profit and redeploy; the nearest day if Wednesday is a holiday) and its last trading day
 * (expiry and rolls). `entry` is the first day alone.
 */
function coreDays(days: string[]) {
  const weeks = new Map<string, string[]>();
  for (const d of days) {
    const dt = new Date(`${d}T12:00:00Z`);
    const monday = addDays(d, -((dt.getUTCDay() + 6) % 7));
    (weeks.get(monday) ?? weeks.set(monday, []).get(monday)!).push(d);
  }
  const core = new Set<string>();
  const entry = new Set<string>();
  for (const [monday, ds] of weeks) {
    const sorted = [...ds].sort();
    const wed = addDays(monday, 2);
    const mid = sorted.reduce((a, b) => (Math.abs(Date.parse(b) - Date.parse(wed)) < Math.abs(Date.parse(a) - Date.parse(wed)) ? b : a));
    core.add(sorted[0]).add(mid).add(sorted[sorted.length - 1]);
    entry.add(sorted[0]);
  }
  return { core, entry };
}

type DaysMode = "all" | "core" | "rest";

/** Which days get quotes/greeks and which get open interest, for a pass. core + rest = all, no overlap. */
function schedule(days: string[], mode: DaysMode) {
  if (mode === "all") return { quotes: days, oi: days };
  const { core, entry } = coreDays(days);
  return mode === "core"
    ? { quotes: days.filter((d) => core.has(d)), oi: days.filter((d) => entry.has(d)) }
    : { quotes: days.filter((d) => !core.has(d)), oi: days.filter((d) => !entry.has(d)) };
}

/** `--days core,rest` runs the passes in order in one process, so one Ctrl-C stops them all. */
function daysModes(): DaysMode[] {
  const ms = opt("days", "all")!.split(",").map((s) => s.trim());
  for (const m of ms) if (m !== "all" && m !== "core" && m !== "rest") throw new Error(`--days must be all, core, rest or a list like core,rest (got ${m})`);
  return ms as DaysMode[];
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

async function pull(store: Store) {
  for (const mode of daysModes()) {
    if (stopping) break;
    await pullPass(store, mode);
  }
}

async function pullPass(store: Store, mode: DaysMode) {
  const { from, to } = window();
  const conc = Number(opt("concurrency", "4"));
  const maxDte = opt("max-dte");
  const wantOi = !flag("no-oi");
  // Stock bars come from Alpaca (`bars`); Theta's stock endpoint is opt-in.
  const wantStock = flag("theta-stock");
  const calendar = await tradingCalendar(store, from, to);
  // A refusal this close to today means the endpoint isn't in the plan at all; older means a history limit.
  const recent = addDays(today(), -45);
  const G = { greeks: gate("greeks (IV, delta, stock price)"), eod: gate("option quotes"), oi: gate("open interest"), stock: gate("stock prices") };
  const u = await targets(store, from, to);
  console.log(`Pulling ${fmtN(u.length)} symbols, ${from} .. ${to}, days: ${mode}, ${conc} requests at a time. Ctrl-C stops cleanly; rerun to resume.`);
  const t0 = Date.now();
  let errors = 0;
  const finished: { symbol: string; from: string; to: string; requests: number; rows: number; minutes: number }[] = [];

  for (let i = 0; i < u.length && !stopping; i++) {
    const free = freeBytes();
    if (free !== null && free < MIN_FREE) {
      console.error(`Only ${(free / 1e9).toFixed(0)} GB free on the data drive; stopping before ${u[i].symbol}. Free up space, then rerun.`);
      break;
    }
    const s = u[i];
    const sym = s.symbol;
    const { start, end } = symRange(s, from, to);
    if (start > end) continue;
    const ts = Date.now();
    const [doneG, doneE, doneO, doneS] = await Promise.all(
      ["option_greeks", "option_eod", "option_oi", "stock_eod"].map((e) => store.done(e, sym)),
    );
    const stat = { req: 0, rows: 0, ms: 0, empty: 0 };

    const fetchDay = async (endpoint: string, path: string, table: string, g: Gate, day: string) => {
      const params: Record<string, string | number> = { symbol: sym, expiration: "*", start_date: compact(day), end_date: compact(day) };
      if (maxDte) params.max_dte = maxDte;
      const r = await thetaGet(path, params);
      stat.req++;
      stat.ms += r.ms;
      if (r.kind === "forbidden") {
        refused(g, day, recent, r.message);
        return 0;
      }
      const n = await store.load({
        table,
        csv: r.kind === "ok" ? r.csv : null,
        extras: { date: `DATE ${q(day)}` },
        replaceWhere: `symbol = ${q(sym)} AND date = DATE ${q(day)}`,
        log: { endpoint, symbol: sym, day, status: r.kind === "ok" ? "ok" : "no_data", ms: r.ms },
      });
      stat.rows += n;
      if (!n) stat.empty++;
      return n;
    };

    // Greeks rows carry the full quote, so plain quotes are only fetched when greeks gave nothing
    // (not in the plan, or before the vendor's greeks history starts: early 2017 on Standard).
    const greeksRows = new Set(
      (await store.all<{ d: string }>(`SELECT strftime(day, '%Y-%m-%d') AS d FROM fetch_log WHERE endpoint = 'option_greeks' AND symbol = ${q(sym)} AND rows > 0`)).map((r) => r.d),
    );
    const symDays = calendar.filter((d) => d >= start && d <= end);
    const sched = schedule(symDays, mode);
    const quoteDays = new Set(sched.quotes);
    const oiDays = new Set(sched.oi);
    const dayTask = async (day: string) => {
      try {
        if (quoteDays.has(day)) {
          let quoted = greeksRows.has(day);
          if (!quoted && !doneG.has(day) && allowed(G.greeks, day)) {
            quoted = (await fetchDay("option_greeks", "option/history/greeks/eod", "option_greeks_eod", G.greeks, day)) > 0;
          }
          if (!quoted && !doneE.has(day) && allowed(G.eod, day)) await fetchDay("option_eod", "option/history/eod", "option_eod", G.eod, day);
        }
        if (wantOi && oiDays.has(day) && !doneO.has(day) && allowed(G.oi, day)) await fetchDay("option_oi", "option/history/open_interest", "option_oi", G.oi, day);
      } catch (e) {
        errors++;
        console.error(`  error ${sym} ${day}: ${e instanceof Error ? e.message : e}`);
        if (errors > 50) {
          console.error("Too many errors; stopping. Check that the Theta Terminal is running, then rerun to resume.");
          stopping = true;
        }
      }
    };

    const monthTask = async (m: { start: string; end: string }) => {
      const final = m.end < addDays(today(), -3);
      if ((final && doneS.has(m.start)) || !allowed(G.stock, m.end)) return;
      try {
        const r = await thetaGet("stock/history/eod", { symbol: sym, start_date: compact(m.start), end_date: compact(m.end) });
        stat.req++;
        if (r.kind === "forbidden") return refused(G.stock, m.end, recent, r.message);
        await store.load({
          table: "stock_eod",
          csv: r.kind === "ok" ? r.csv : null,
          extras: { symbol: q(sym), date: `CAST(TRY_CAST("created" AS TIMESTAMP) AS DATE)` },
          replaceWhere: `symbol = ${q(sym)} AND date BETWEEN DATE ${q(m.start)} AND DATE ${q(m.end)}`,
          log: final ? { endpoint: "stock_eod", symbol: sym, day: m.start, status: r.kind === "ok" ? "ok" : "no_data", ms: r.ms } : undefined,
        });
      } catch (e) {
        errors++;
        console.error(`  error ${sym} stock ${m.start}: ${e instanceof Error ? e.message : e}`);
      }
    };

    // Stock months first (cheap), then option days newest-first.
    if (wantStock) await pool(monthsDesc(start, end), conc, monthTask);
    await pool(symDays.filter((d) => quoteDays.has(d) || oiDays.has(d)), conc, dayTask);

    await store.exportSymbol(sym);
    const el = Date.now() - t0;
    const eta = (el / (i + 1)) * (u.length - i - 1);
    if (!stopping) finished.push({ symbol: sym, from: start, to: end, requests: stat.req, rows: stat.rows, minutes: Math.round((Date.now() - ts) / 60_000) });
    writeFileSync(
      PROGRESS_FILE,
      JSON.stringify({ updated: new Date().toISOString(), pass: mode, window: { from, to }, total: u.length, done: i + 1, next: u[i + 1]?.symbol ?? null, elapsed: fmtDur(el), eta: fmtDur(eta), errors, finished }, null, 1),
    );
    console.log(
      `[${i + 1}/${u.length}] ${sym.padEnd(6)} ${start}..${end}  ${fmtN(stat.req)} req  ${fmtN(stat.rows)} rows` +
        `  ${stat.req ? Math.round(stat.ms / stat.req) : 0}ms avg  ${fmtDur(Date.now() - ts)}  | total ${fmtDur(el)}, ETA ${fmtDur(eta)}`,
    );
  }
  console.log(stopping ? "Stopped. Rerun the same command to resume." : `Finished in ${fmtDur(Date.now() - t0)} with ${errors} errors.`);
}

// ---------------------------------------------------------------------------
// reference series (free)
// ---------------------------------------------------------------------------

async function getText(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": "skynet-data/1.0" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function ref(store: Store) {
  // Cboe publishes the full daily history of its volatility indexes as CSV (DATE,OPEN,HIGH,LOW,CLOSE; MM/DD/YYYY).
  for (const sym of ["VIX", "VIX9D", "VIX3M", "VVIX"]) {
    try {
      const raw = await getText(`https://cdn.cboe.com/api/global/us_indices/daily_prices/${sym}_History.csv`);
      const lines = raw.trim().split(/\r?\n/);
      const head = lines[0].toUpperCase().split(",");
      const col = (n: string) => head.indexOf(n);
      const out = ["source,symbol,date,open,high,low,close"];
      for (const l of lines.slice(1)) {
        const f = l.split(",");
        const m = f[col("DATE")]?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) continue;
        const date = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
        const v = (n: string) => (col(n) === -1 ? "" : f[col(n)] ?? "");
        const close = col("CLOSE") === -1 ? f[1] : v("CLOSE"); // VVIX's file has a single value column
        out.push(["cboe", sym, date, v("OPEN"), v("HIGH"), v("LOW"), close].join(","));
      }
      const n = await store.load({ table: "ext_daily", csv: out.join("\n"), replaceWhere: `source = 'cboe' AND symbol = ${q(sym)}` });
      console.log(`  Cboe ${sym}: ${fmtN(n)} days`);
    } catch (e) {
      console.error(`  Cboe ${sym} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  // FRED: 3-month T-bill secondary market rate (percent), daily.
  try {
    const raw = await getText("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3");
    const out = ["source,symbol,date,open,high,low,close"];
    for (const l of raw.trim().split(/\r?\n/).slice(1)) {
      const [d, v] = l.split(",");
      if (isDate(d) && v && v !== ".") out.push(`fred,DTB3,${d},,,,${v}`);
    }
    const n = await store.load({ table: "ext_daily", csv: out.join("\n"), replaceWhere: `source = 'fred' AND symbol = 'DTB3'` });
    console.log(`  FRED DTB3: ${fmtN(n)} days`);
  } catch (e) {
    console.error(`  FRED DTB3 failed: ${e instanceof Error ? e.message : e}`);
  }
  // Theta's own rate series (SOFR and the 3-month Treasury), as far back as the subscription allows.
  const { from, to } = window();
  for (const sym of ["SOFR", "TREASURY_M3"]) {
    const g = gate(`Theta rate ${sym}`);
    let n = 0;
    for (const m of monthsDesc(from, to)) {
      if (!allowed(g, m.end) || stopping) break;
      const r = await thetaGet("interest_rate/history/eod", { symbol: sym, start_date: compact(m.start), end_date: compact(m.end) });
      if (r.kind === "forbidden") {
        refused(g, m.end, addDays(today(), -45), r.message);
        continue;
      }
      n += await store.load({
        table: "rate_eod",
        csv: r.kind === "ok" ? r.csv : null,
        extras: { symbol: q(sym), date: `TRY_CAST("created" AS DATE)` },
        replaceWhere: `symbol = ${q(sym)} AND date BETWEEN DATE ${q(m.start)} AND DATE ${q(m.end)}`,
      });
    }
    console.log(`  Theta ${sym}: ${fmtN(n)} days`);
  }
  for (const t of REF_TABLES) await store.exportTable(t);
}

// ---------------------------------------------------------------------------
// bars: daily stock bars from Alpaca (free, 2016+), straight to Parquet. Uses an in-memory
// database (the universe comes from the exported expirations file), so it runs during a pull.
// ---------------------------------------------------------------------------

async function bars() {
  await import("../scripts/env");
  const exp = join(PARQUET_DIR, "option_expirations.parquet");
  if (!existsSync(exp)) throw new Error("Run `npm run skynet -- universe` (or `export`) first: bars reads the universe from Parquet.");
  const mem = await Store.open(":memory:");
  try {
    await mem.con.run(`INSERT INTO option_expirations SELECT symbol, expiration FROM read_parquet(${q(exp.replace(/\\/g, "/"))})`);
    const { from, to } = window();
    const u = await targets(mem, from, to);
    await pullBars(mem, u.map((s) => s.symbol), from, to, flag("refresh"), () => stopping);
  } finally {
    mem.close();
  }
}

// ---------------------------------------------------------------------------
// export: (re)write every Parquet copy; pull does this per symbol as it goes
// ---------------------------------------------------------------------------

const REF_TABLES = ["ext_daily", "rate_eod", "option_expirations"];

async function exportAll(store: Store) {
  for (const t of REF_TABLES) await store.exportTable(t);
  const syms = (await store.all<{ symbol: string }>(`SELECT DISTINCT symbol FROM fetch_log WHERE endpoint LIKE 'option_%' AND status = 'ok' ORDER BY 1`)).map((r) => r.symbol);
  for (const s of syms) await store.exportSymbol(s);
  console.log(`Exported ${REF_TABLES.length} reference tables and ${fmtN(syms.length)} symbols to ${PARQUET_DIR}`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function status(store: Store) {
  let size = 0;
  try {
    size = statSync(DB_PATH).size;
  } catch {}
  const free = freeBytes();
  console.log(`Database: ${DB_PATH} (${(size / 1e9).toFixed(2)} GB; download log + work in progress)`);
  console.log(`Parquet store: ${PARQUET_DIR} (${(dirBytes(PARQUET_DIR) / 1e9).toFixed(2)} GB)${free === null ? "" : `, ${(free / 1e9).toFixed(0)} GB free`}`);
  const log = await store.all(`
    SELECT endpoint, count(DISTINCT symbol) AS symbols, count(*) FILTER (WHERE status = 'ok') AS ok,
           count(*) FILTER (WHERE status = 'no_data') AS no_data, sum(rows) AS rows, round(avg(ms)) AS avg_ms,
           strftime(min(day), '%Y-%m-%d') AS first_day, strftime(max(day), '%Y-%m-%d') AS last_day
    FROM fetch_log GROUP BY endpoint ORDER BY endpoint`);
  console.table(log);
  const counts: Record<string, number> = {};
  for (const t of ["option_greeks_eod", "option_eod", "option_oi", "stock_eod", "rate_eod", "ext_daily", "option_expirations"]) {
    counts[t] = (await store.all<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))[0].n;
  }
  console.log("Rows still in DuckDB (moved to Parquet when each symbol finishes):");
  console.table(counts);
}

// ---------------------------------------------------------------------------

async function main() {
  if (cmd === "priority") return priority();
  if (cmd === "bars") return bars();
  const cmds: Record<string, (s: Store) => Promise<void>> = { universe, plan, pull, ref, status, export: exportAll };
  const fn = cmd ? cmds[cmd] : undefined;
  if (!fn) {
    console.log("usage: npm run skynet -- universe | priority | plan | pull | ref | status | export   (see docs/SKYNET-DATA.md)");
    process.exit(1);
  }
  let store: Store;
  try {
    store = await Store.open();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/used by another process|lock/i.test(msg)) throw e;
    // A pull holds the database; show its progress file instead.
    if (cmd === "status" && existsSync(PROGRESS_FILE)) {
      const p = JSON.parse(readFileSync(PROGRESS_FILE, "utf8"));
      console.log(`A pull is running (database locked). Progress as of ${p.updated}, ${p.pass ?? "all"} pass: ${p.done}/${p.total} symbols, elapsed ${p.elapsed}, ETA ${p.eta}, ${p.errors} errors, next ${p.next}.`);
      console.table(p.finished.slice(-15));
      console.log(`Finished symbols are readable as Parquet under ${PARQUET_DIR}`);
      return;
    }
    throw new Error(`The database is locked, probably by a running pull. Stop it first, or read the Parquet files in ${PARQUET_DIR}.`);
  }
  try {
    await fn(store);
  } finally {
    store.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
