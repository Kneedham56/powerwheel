/**
 * Skynet backtest: replay a ruleset week by week over the historical feed, with code-only decisions.
 *
 *   npm run skynet -- backtest --ruleset kindred [--from 2018-01-01] [--to 2025-12-31] [--symbols QQQ,IWM]
 *                              [--fees 0.03] [--no-interest] [--margin-spread 0.015]
 *                              [--min-dollar-volume 1e8] [--quiet]
 *   npm run skynet -- parity [--from 2024-01-01] [--to 2024-06-30] [--symbols ...]
 *
 * Each week, as the race does it (src/lib/race.ts, docs/RACE.md):
 *   Sunday     the report's candidates, from bars through Friday's close and Friday's closing chains
 *   Monday     covered calls on shares, then puts on the best candidates (end-of-day quotes, fills at mid − ¼ spread)
 *   Wednesday  take profit or cut on the floor (yesterday's close), stop out shares, redeploy
 *   Friday     settle at the stock's close (assigned if it closed past the strike), stops, mark to market
 *
 * Every run trades the same account (ACCOUNT): $100k, margin up to 2x the account value.
 *
 * Results go to data/backtests/<ruleset>/<run id>/ (gitignored): run.json (what the /skynet page reads: totals, years,
 * weeks, trades), plus weeks.csv, trades.csv, graded.csv and years.csv for spreadsheets.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSunday, emptyNarrative, type CandidateRow } from "../src/lib/prep";
import {
  finishWeek,
  friday as liveFriday,
  gradeAi,
  monday as liveMonday,
  newState,
  wednesday as liveWednesday,
  type FridayInput,
  type GradedTrade,
  type MondayInput,
  type RaceState,
  type QuoteBook,
  type RunResult,
  type Trade,
  type WednesdayInput,
  type WeekRow,
} from "../src/lib/race";
import { AI, FUNDS, RULES, RULES_VERSION, type Bar, type OptionQuote } from "../src/lib/rules";
import { friday, monday, wednesday, type EngineOptions, type Regime } from "./engine";
import { addDays, DATA_DIR, Feed } from "./feed";
import { buildCandidates, targetExpiry, type CandidateMeta } from "./logic";
import { getRuleset, liveRuleset, withOverrides, type Ruleset } from "./rulesets";
import { summarize, type RunFile, type RunOptions, type Totals, type YearRow } from "./results";
import { loadSectors } from "./sectors";

/**
 * The account every run trades, fixed so runs compare: $100k, and margin up to 2x the account value in exposure
 * (shares at market + short put strikes × 100), which is $200k at the start. A ruleset chooses how much of it to use
 * (`ai.exposure`); it can't go past it.
 */
export const ACCOUNT = { capital: 100_000, maxLeverage: 2 } as const;

// ---------------------------------------------------------------------------
// options and the two implementations (Skynet's, and src/lib's for the parity check)
// ---------------------------------------------------------------------------

/**
 * fees: per contract. interest: positive cash earns the 3-month T-bill, negative cash (margin) pays it plus
 * `marginSpread`. minDollarVolume: a stock passes the size test (there's no history of market caps) when its 20-day
 * average dollar volume is at least this.
 */
export type SimOptions = RunOptions;

interface SundayIn {
  runDate: string;
  bars: Record<string, Bar[]>;
  meta: Record<string, CandidateMeta>;
  stocks: string[];
  quotes: Record<string, OptionQuote[]>;
}

interface Impl {
  label: string;
  candidates(inp: SundayIn): { expiry: string; candidates: CandidateRow[] };
  monday(s: RaceState, inp: MondayInput, g?: Regime): RunResult;
  wednesday(s: RaceState, inp: WednesdayInput, g?: Regime): RunResult;
  friday(s: RaceState, inp: FridayInput): RunResult;
}

function skynetImpl(rs: Ruleset, eo: EngineOptions): Impl {
  return {
    label: rs.name,
    candidates: (inp) => buildCandidates(rs.rules, { runDate: inp.runDate, bars: inp.bars, meta: inp.meta, watchlist: [], scanSymbols: inp.stocks, quotes: inp.quotes }),
    monday: (s, inp, g) => monday(rs, eo, s, inp, g),
    wednesday: (s, inp, g) => wednesday(rs, eo, s, inp, g),
    friday: (s, inp) => friday(rs, eo, s, inp),
  };
}

/** The live code in src/lib (prep's Sunday report, the race's three runs), unchanged. */
const liveImpl: Impl = {
  label: "src/lib",
  candidates: (inp) => {
    const meta = Object.fromEntries(Object.entries(inp.meta).map(([k, m]) => [k, { sector: m.sector, marketCap: m.bigEnough ? 1e15 : 0, iv: m.iv, ivRank: m.ivRank, weeklies: m.weeklies }]));
    const r = buildSunday({ runDate: inp.runDate, bars: inp.bars, vix: [], meta, watchlist: [], scanSymbols: inp.stocks, earnings: [], quotes: inp.quotes, narrative: emptyNarrative() });
    return { expiry: r.expiry, candidates: r.candidates };
  },
  monday: liveMonday,
  wednesday: liveWednesday,
  friday: liveFriday,
};

// ---------------------------------------------------------------------------
// the weekly loop
// ---------------------------------------------------------------------------

export interface RunOutput {
  weeks: WeekRow[];
  trades: Trade[];
  candidates: Map<string, CandidateRow[]>; // per Sunday, for the parity check
  state: RaceState;
  notes: string[];
  interest: number;
  spyStart: number;
}

async function simulate(feed: Feed, impl: Impl, rs: Ruleset, o: SimOptions, keepCandidates = false): Promise<RunOutput> {
  return (await simulateMany(feed, [{ impl, rs }], o, keepCandidates))[0];
}

/**
 * Step several rulesets through the same weeks in one process: each year's chains are loaded once, and each Sunday
 * report is built once per distinct `rules` (most variants only change `ai` or `levers`). Every run keeps its own
 * state, so the results are the same as running each one alone.
 */
async function simulateMany(feed: Feed, runs: { impl: Impl; rs: Ruleset }[], o: SimOptions, keepCandidates = false): Promise<RunOutput[]> {
  const tradable = o.symbols;
  const funds = Object.keys(FUNDS);
  const stocks = tradable.filter((s) => !FUNDS[s] && s !== "SPY");
  const sectors = loadSectors();
  const weeks = feed.weeks(addDays(o.from, -10), o.to);
  const first = weeks.findIndex((w) => w.entry >= o.from);
  if (first < 1) throw new Error(`no trading weeks from ${o.from}`);
  const spyStart = feed.close("SPY", weeks[first].entry)!;

  interface Run {
    impl: Impl;
    rs: Ruleset;
    key: string;
    state: RaceState;
    trades: Trade[];
    rows: WeekRow[];
    candidates: Map<string, CandidateRow[]>;
    factor: Map<string, number>;
    notes: string[];
    interest: number;
  }
  const rr: Run[] = runs.map(({ impl, rs }) => ({
    impl,
    rs,
    key: `${impl.label === "src/lib" ? "live" : "skynet"}:${JSON.stringify(rs.rules)}`,
    state: newState(o.capital, weeks[first].entry, o.capital),
    trades: [],
    rows: [],
    candidates: new Map(),
    factor: new Map(),
    notes: [],
    interest: 0,
  }));
  const rules = [...new Map(rr.map((r) => [r.key, r.rs.rules])).values()];
  let lastFriday = weeks[first - 1].last;

  // IV history for every week's last day (the Sunday report reads Friday's), from a year before the start
  const lastDays = feed.weeks(addDays(o.from, -380), o.to).map((w) => w.last);
  await feed.loadIv(tradable, lastDays);

  // the Sunday report reads Friday's chain for next Friday (7 days out); 2+ expiries in this window = weeklies
  const maxDays = Math.max(...rules.map((R) => R.pick.minExpiryDays)) + 11;
  let loadedYear = "";
  for (let i = first; i < weeks.length; i++) {
    const w = weeks[i];
    const prev = weeks[i - 1];
    const year = w.entry.slice(0, 4);
    if (year !== loadedYear) {
      // a year of chains at a time: the days the runs read (Friday before, Monday, Wednesday)
      const ys = weeks.filter((x, j) => j >= first - 1 && x.entry.slice(0, 4) === year);
      const days = new Set<string>();
      for (const x of ys) {
        const j = weeks.indexOf(x);
        if (j > 0) days.add(weeks[j - 1].last);
        days.add(x.entry);
        days.add(x.mid);
      }
      feed.dropChainsBefore(prev.last);
      if (!o.quiet) process.stdout.write(`  ${year}: loading chains for ${tradable.length} symbols, ${days.size} days... `);
      const t0 = Date.now();
      await feed.loadChains(tradable, [...days], maxDays);
      if (!o.quiet) console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
      loadedYear = year;
    }

    const held = (r: Run) => [...new Set([...r.state.lots.map((l) => l.symbol), ...r.state.options.map((x) => x.symbol)])];
    // splits: shares and open options follow the stock (raw ÷ split-adjusted changes by the ratio). The factor is
    // remembered after every run for what's held, and forgotten once a name isn't, so an old split never reaches a
    // later position.
    const splitCheck = (r: Run, date: string) => {
      for (const [sym, was] of r.factor) {
        const f = feed.splitFactor(sym, date);
        if (f === null || Math.abs(f / was - 1) <= 0.01) continue;
        const m = was / f;
        r.state = structuredClone(r.state);
        for (const l of r.state.lots.filter((x) => x.symbol === sym)) Object.assign(l, { shares: l.shares * m, cost: l.cost / m, mark: l.mark / m });
        for (const x of r.state.options.filter((y) => y.symbol === sym)) Object.assign(x, { strike: x.strike / m, contracts: x.contracts * m, price: x.price / m });
        r.notes.push(`${date}: ${sym} split ${m.toFixed(3)} for 1; shares and open options adjusted`);
      }
    };
    const remember = (r: Run, date: string) => {
      r.factor.clear();
      for (const sym of held(r)) {
        const f = feed.splitFactor(sym, date);
        if (f !== null) r.factor.set(sym, f);
      }
    };

    // Sunday: the report, from Friday's close (once per distinct rules)
    const runDate = addDays(w.monday, -1);
    const sundayBars: Record<string, Bar[]> = {};
    for (const s of new Set(["SPY", ...funds, ...tradable])) {
      const b = feed.barsAsOf(s, w.entry, { strict: true });
      if (b && b.length >= 2) sundayBars[s] = b; // techAt needs two bars (a name listed on Friday has one)
    }
    const meta: Record<string, CandidateMeta> = {};
    for (const s of tradable) {
      const ch = feed.chain(s, prev.last);
      const exps = new Set(ch.map((c) => c.expiry).filter((e) => e > prev.last));
      const dv = feed.dollarVolume(s, w.entry);
      meta[s] = { sector: sectors[s], bigEnough: !!FUNDS[s] || (dv !== null && dv >= o.minDollarVolume), ...feed.ivOn(s, prev.last), weeklies: exps.size >= 2 };
    }
    const reports = new Map<string, CandidateRow[]>();
    for (const r of rr) {
      if (reports.has(r.key)) continue;
      const expiry = targetExpiry(r.rs.rules, runDate);
      const quotes: Record<string, OptionQuote[]> = {};
      for (const s of tradable) if (feed.chain(s, prev.last).length) quotes[s] = feed.book(s, prev.last, "put", expiry);
      reports.set(r.key, r.impl.candidates({ runDate, bars: sundayBars, meta, stocks, quotes }).candidates.filter((c) => tradable.includes(c.symbol)));
    }

    const putBooks = new Map<string, QuoteBook>();
    const putBook = (date: string, exp: string) => {
      const k = `${date}|${exp}`;
      if (!putBooks.has(k)) putBooks.set(k, Object.fromEntries(tradable.filter((s) => feed.chain(s, date).length).map((s) => [s, feed.book(s, date, "put", exp)])));
      return putBooks.get(k)!;
    };
    const callBook = (r: Run, date: string, exp: string) => Object.fromEntries([...new Set(r.state.lots.map((l) => l.symbol))].filter((s) => feed.chain(s, date).length).map((s) => [s, feed.book(s, date, "call", exp)]));
    const spotsOn = (date: string, syms: string[]) => Object.fromEntries(syms.map((s) => [s, feed.close(s, date)]).filter(([, v]) => v !== undefined)) as Record<string, number>;
    const rate = (feed.asOf(feed.tbill, w.last) ?? 0) / 100;
    const days = (Date.parse(w.last) - Date.parse(lastFriday)) / 864e5;
    const spy = feed.close("SPY", w.last)!;
    // the market as of the close before each run (no look-ahead)
    const regimeAt = (date: string): Regime => ({ spy: (feed.barsAsOf("SPY", date, { strict: true, n: 250 }) ?? []).map((b) => b.close), vix: feed.asOf(feed.vix, addDays(date, -1)) ?? null });
    const gMon = regimeAt(w.entry);
    const gWed = regimeAt(w.mid);

    for (const run of rr) {
      const cands = reports.get(run.key)!;
      if (keepCandidates) run.candidates.set(runDate, cands);
      const take = (res: RunResult) => {
        run.state = res.state;
        run.trades.push(...res.trades);
      };

      // Monday
      splitCheck(run, w.entry);
      const monExpiry = targetExpiry(run.rs.rules, w.entry);
      take(run.impl.monday(run.state, { date: w.entry, expiry: monExpiry, candidates: cands, quotes: { puts: putBook(w.entry, monExpiry), calls: callBook(run, w.entry, monExpiry) }, spots: spotsOn(w.entry, held(run)) }, gMon));
      remember(run, w.entry);

      // Wednesday (skipped in a week too short to have one between entry and expiry)
      if (w.mid !== w.entry && w.mid !== w.last) {
        splitCheck(run, w.mid);
        const bars: Record<string, Bar[]> = {};
        for (const s of held(run)) {
          const b = feed.barsAsOf(s, w.mid, { strict: true, n: 60 });
          if (b) bars[s] = b;
        }
        const exp = run.state.current!.expiry;
        take(run.impl.wednesday(run.state, { date: w.mid, candidates: cands, quotes: { puts: putBook(w.mid, exp), calls: callBook(run, w.mid, exp) }, spots: spotsOn(w.mid, held(run)), bars }, gWed));
        remember(run, w.mid);
      }

      // Friday: interest since last Friday, then settle
      splitCheck(run, w.last);
      if (o.interest) {
        const amt = run.state.cash * (run.state.cash >= 0 ? rate : rate + o.marginSpread) * (days / 365);
        run.state = { ...run.state, cash: run.state.cash + amt };
        run.interest += amt;
      }
      const fBars: Record<string, Bar[]> = {};
      for (const s of held(run)) {
        const b = feed.barsAsOf(s, w.last, { n: 60 });
        if (b) fBars[s] = b;
      }
      const res = run.impl.friday(run.state, { date: w.last, closes: spotsOn(w.last, held(run)), bars: fBars, opp: { value: (o.capital * spy) / spyStart, flows: 0 } }) as RunResult & { week?: WeekRow };
      take(res);
      remember(run, w.last);
      if (res.week) run.rows.push({ ...res.week, note: [res.week.note, `vix ${feed.asOf(feed.vix, w.last) ?? ""}`].filter(Boolean).join("; ") });
    }
    lastFriday = w.last;
    if (!o.quiet && w.last.slice(0, 4) !== weeks[i + 1]?.last.slice(0, 4))
      for (const run of rr) console.log(`  ${year}: ${run.rs.name}: ${usd(run.state.lastValue)} (${pct(run.state.lastValue / o.capital - 1)})`);
  }
  return rr.map((run) => ({
    weeks: run.rows.map((row) => finishWeek(row, run.trades)),
    trades: run.trades,
    candidates: run.candidates,
    state: run.state,
    notes: run.notes,
    interest: run.interest,
    spyStart,
  }));
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number | null, d = 1) => (n === null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`);


const split = (y: string): YearRow["split"] => (y >= "2018" && y <= "2023" ? "train" : y === "2024" || y === "2025" ? "validate" : y === "2026" ? "final exam" : "other");

function drawdown(values: number[], start: number) {
  let peak = start;
  let dd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    dd = Math.min(dd, v / peak - 1);
  }
  return dd;
}

export function yearRows(weeks: WeekRow[], graded: GradedTrade[], capital: number): YearRow[] {
  const years = [...new Set(weeks.map((w) => w.date.slice(0, 4)))];
  let prevV = capital;
  let prevS = capital;
  return years.map((y) => {
    const ws = weeks.filter((w) => w.date.startsWith(y));
    const gs = graded.filter((g) => g.closed.startsWith(y));
    const end = ws.at(-1)!;
    const v = ws.map((w) => w.ai_value);
    const sp = ws.map((w) => w.opp_value ?? prevS);
    const row: YearRow = {
      year: y,
      split: split(y),
      weeks: ws.length,
      return: end.ai_value / prevV - 1,
      spy_return: (end.opp_value ?? prevS) / prevS - 1,
      excess: 0,
      max_drawdown: drawdown(v, prevV),
      spy_max_drawdown: drawdown(sp, prevS),
      trades: gs.length,
      wins: gs.filter((g) => g.result === "win").length,
      losses: gs.filter((g) => g.result === "loss").length,
      win_rate: gs.length ? gs.filter((g) => g.result === "win").length / gs.length : null,
      assigned: ws.reduce((a, w) => a + (w.counts.puts_assigned ?? 0), 0),
      called_away: ws.reduce((a, w) => a + (w.counts.calls_called ?? 0), 0),
      shares_stopped: ws.reduce((a, w) => a + (w.counts.shares_sold ?? 0), 0),
      net_premium: Math.round(ws.reduce((a, w) => a + w.premium, 0)),
      avg_leverage: ws.reduce((a, w) => a + w.leverage, 0) / ws.length,
    };
    row.excess = row.return - row.spy_return;
    prevV = end.ai_value;
    prevS = end.opp_value ?? prevS;
    return row;
  });
}

function printYears(name: string, ys: YearRow[], total: Totals) {
  const head = ["Year", "Set", name, "SPY", "Excess", "Max DD", "SPY DD", "Trades", "Win rate", "Assigned", "Shares sold", "Avg lev"];
  const body = ys.map((y) => [y.year, y.split, pct(y.return), pct(y.spy_return), pct(y.excess), pct(y.max_drawdown), pct(y.spy_max_drawdown), String(y.trades), y.win_rate === null ? "—" : `${(y.win_rate * 100).toFixed(0)}% (${y.wins}-${y.losses})`, String(y.assigned), String(y.shares_stopped), `${y.avg_leverage.toFixed(2)}x`]);
  body.push(["Total", "", pct(total.ret), pct(total.spy), pct(total.ret - total.spy), pct(total.dd), pct(total.spyDd), String(total.trades), total.winRate === null ? "—" : `${(total.winRate * 100).toFixed(0)}%`, "", "", ""]);
  body.push(["CAGR", "", pct(total.cagr), pct(total.spyCagr), pct(total.cagr - total.spyCagr), "", "", "", "", "", "", ""]);
  const wid = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i < 2 ? c.padEnd(wid[i]) : c.padStart(wid[i]))).join("  ");
  console.log(line(head));
  console.log(wid.map((w) => "-".repeat(w)).join("  "));
  for (const [i, r] of body.entries()) {
    if (i === ys.length) console.log(wid.map((w) => "-".repeat(w)).join("  "));
    console.log(line(r));
  }
  if (total.sharpe !== null) console.log(`Sharpe (weekly, annualised, vs 0): ${total.sharpe.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

function csv<T extends object>(rows: T[]): string {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell((r as Record<string, unknown>)[c])).join(","))].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(3);
const opt = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name: string) => argv.includes(`--${name}`);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

async function setup(defaultFrom: string, defaultTo: string): Promise<{ feed: Feed; o: SimOptions }> {
  const from = opt("from", defaultFrom)!;
  const to = opt("to", defaultTo)!;
  if (!isDate(from) || !isDate(to) || from > to) throw new Error(`bad --from/--to: ${from} ${to}`);
  if (from < "2017-03-01") console.log("Note: option greeks start in early 2017; before that the feed has no chains, so no trades.");
  const fin = Feed.finishedSymbols();
  const want = opt("symbols")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const s of want ?? []) if (!fin.symbols.includes(s)) console.log(`Warning: ${s} hasn't finished downloading (${fin.note}); its results will be partial.`);
  const feed = await Feed.open();
  feed.useCache = !flag("no-cache");
  const symbols = (want ?? fin.symbols).filter((s) => feed.hasOptions(s) && feed.hasBars(s));
  if (!symbols.length) throw new Error(`no symbols with both option data and bars (${fin.note})`);
  await feed.loadBars([...new Set(["SPY", ...Object.keys(FUNDS), ...symbols])]);
  if (!feed.hasBars("SPY")) throw new Error("no SPY bars: run npm run skynet -- bars");
  const o: SimOptions = {
    from,
    to,
    capital: ACCOUNT.capital,
    maxLeverage: ACCOUNT.maxLeverage,
    symbols,
    fees: Number(opt("fees", "0.03")),
    interest: !flag("no-interest"),
    marginSpread: Number(opt("margin-spread", "0.015")),
    minDollarVolume: Number(opt("min-dollar-volume", "1e8")),
    quiet: flag("quiet"),
  };
  console.log(`Symbols (${symbols.length}): ${symbols.join(", ")}  [${fin.note}]`);
  return { feed, o };
}

export async function backtestCmd() {
  const sets = argv.flatMap((a, i) => (a === "--set" ? argv[i + 1].split(",") : []));
  const rs = withOverrides(getRuleset(opt("ruleset", "kindred")!), sets, opt("name"));
  const { feed, o } = await setup("2018-01-01", "2025-12-31");
  console.log(`Backtest ${rs.name} (from rules ${rs.basedOn}), ${o.from} to ${o.to}, ${usd(o.capital)}, margin to ${o.maxLeverage}x, fees $${o.fees}/contract, interest ${o.interest ? `T-bill, margin +${(o.marginSpread * 100).toFixed(1)}%` : "off"}`);
  const t0 = Date.now();
  const out = await simulate(feed, skynetImpl(rs, { fees: o.fees, maxLeverage: o.maxLeverage }), rs, o);
  writeRun(feed, rs, o, out, t0);
}

/**
 * Sweep: several variants through the same weeks in one process (chains loaded once per year), each written as its
 * own run. A job file is JSON: [{ "ruleset": "kindred", "name": "Kindred · CC 50%", "set": ["levers.ccCoverage=0.5"] }].
 *
 *   npm run skynet -- sweep --jobs jobs.json [--from --to --symbols ...]
 */
export async function sweepCmd() {
  const file = opt("jobs");
  if (!file) throw new Error("sweep needs --jobs <file.json>");
  const jobs = JSON.parse(readFileSync(file, "utf8")) as { ruleset?: string; name?: string; set?: string[] }[];
  const rss = jobs.map((j) => withOverrides(getRuleset(j.ruleset ?? "kindred"), j.set ?? [], j.name));
  const { feed, o } = await setup("2018-01-01", "2025-12-31");
  console.log(`Sweep of ${rss.length} rulesets, ${o.from} to ${o.to}:\n${rss.map((r) => `  ${r.name}`).join("\n")}`);
  const t0 = Date.now();
  const eo = { fees: o.fees, maxLeverage: o.maxLeverage };
  const outs = await simulateMany(feed, rss.map((rs) => ({ impl: skynetImpl(rs, eo), rs })), o);
  for (const [i, rs] of rss.entries()) writeRun(feed, rs, o, outs[i], t0, true);
  console.log(`Sweep done: ${rss.length} runs in ${Math.round((Date.now() - t0) / 1000)}s`);
}

function writeRun(feed: Feed, rs: Ruleset, o: SimOptions, out: RunOutput, t0: number, brief = false) {
  if (!out.weeks.length) throw new Error("no weeks were run");

  const closes: Record<string, number> = {};
  const opens = new Map(out.trades.filter((t) => t.position_id && (t.action === "Sold put" || t.action === "Sold call")).map((t) => [t.position_id!, t]));
  for (const t of out.trades) {
    const op = t.action === "Bought back" && t.position_id ? opens.get(t.position_id) : undefined;
    const c = op?.symbol && op.expiration ? feed.close(op.symbol, op.expiration) : undefined;
    if (op && c !== undefined) closes[`${op.symbol}@${op.expiration}`] = c;
  }
  const graded = gradeAi(out.trades, o.from, o.to, closes);
  const years = yearRows(out.weeks, graded, o.capital);
  const last = out.weeks.at(-1)!;
  const yrs = (Date.parse(last.date) - Date.parse(out.weeks[0].date)) / (365.25 * 864e5) || 1;
  const wr = out.weeks.map((w) => w.ai_week_return ?? 0);
  const m = wr.reduce((a, b) => a + b, 0) / wr.length;
  const sd = Math.sqrt(wr.reduce((a, b) => a + (b - m) ** 2, 0) / wr.length);
  const total: Totals = {
    ret: last.ai_value / o.capital - 1,
    spy: (last.opp_value ?? o.capital) / o.capital - 1,
    cagr: (last.ai_value / o.capital) ** (1 / yrs) - 1,
    spyCagr: ((last.opp_value ?? o.capital) / o.capital) ** (1 / yrs) - 1,
    dd: last.ai_max_drawdown,
    spyDd: last.opp_max_drawdown ?? 0,
    winRate: graded.length ? graded.filter((g) => g.result === "win").length / graded.length : null,
    trades: graded.length,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(52) : null,
  };

  if (!brief) {
  console.log("");
  printYears(rs.name, years, total);
  console.log(`\nInterest ${usd(out.interest)}; ${out.state.lots.length} share lots and ${out.state.options.length} options still open at the end (marked at the last close).`);
  console.log("SPY is price only (no dividends), and so are the wheel's shares; the wheel's cash earns the T-bill unless --no-interest.");
  for (const n of out.notes) console.log(`  ${n}`);
  }

  const id = new Date(t0).toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const dir = join(DATA_DIR, "backtests", rs.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), `${o.from}_${o.to}_${id}`);
  mkdirSync(dir, { recursive: true });
  const run: RunFile = {
    format: 2,
    ruleset: rs,
    options: o,
    ran_at: new Date().toISOString(),
    seconds: Math.round((Date.now() - t0) / 1000),
    total,
    years,
    notes: out.notes,
    interest: out.interest,
    weeks: out.weeks,
    trades: out.trades,
    graded,
    end_state: out.state,
  };
  writeFileSync(join(dir, "run.json"), JSON.stringify(run));
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summarize(run)));
  writeFileSync(join(dir, "weeks.csv"), csv(out.weeks.map((w) => ({ ...w, spy_value: w.opp_value, spy_return: w.opp_return, spy_drawdown: w.opp_drawdown }))));
  writeFileSync(join(dir, "trades.csv"), csv(out.trades));
  writeFileSync(join(dir, "graded.csv"), csv(graded.map(({ hold, ...g }) => ({ ...g, hold_close: hold?.close ?? null, hold_score: hold?.score ?? null, hold_edge: hold?.edge ?? null }))));
  writeFileSync(join(dir, "years.csv"), csv(years));
  console.log(`${brief ? `${rs.name}: CAGR ${pct(total.cagr)}, max DD ${pct(total.dd)}, Sharpe ${total.sharpe?.toFixed(2)}. ` : "\n"}Wrote ${dir} (${Math.round((Date.now() - t0) / 1000)}s)`);
}

/**
 * Parity: the same weeks through Skynet's mirrored code (with the live ruleset, no fees, no interest) and through
 * src/lib's prep and race. Every Sunday's candidates and every trade must match.
 */
export async function parityCmd() {
  const { feed, o } = await setup("2024-01-01", "2024-06-30");
  const po: SimOptions = { ...o, fees: 0, interest: false, quiet: true };
  const live = liveRuleset(RULES, AI, RULES_VERSION);
  const a = await simulate(feed, skynetImpl(live, { fees: 0, maxLeverage: Infinity }), live, po, true);
  const b = await simulate(feed, liveImpl, live, po, true);
  const strip = (t: Trade) => ({ ...t, rules_version: "" });
  let bad = 0;
  for (const [d, ca] of a.candidates) {
    const cb = b.candidates.get(d) ?? [];
    if (JSON.stringify(ca) !== JSON.stringify(cb)) {
      bad++;
      if (bad <= 3) console.log(`Candidates differ on ${d}:\n  skynet ${JSON.stringify(ca).slice(0, 600)}\n  src/lib ${JSON.stringify(cb).slice(0, 600)}`);
    }
  }
  const ta = a.trades.map(strip);
  const tb = b.trades.map(strip);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (JSON.stringify(ta[i]) !== JSON.stringify(tb[i])) {
      bad++;
      console.log(`Trade ${i} differs:\n  skynet  ${JSON.stringify(ta[i])}\n  src/lib ${JSON.stringify(tb[i])}`);
      break;
    }
  }
  const va = a.weeks.map((w) => w.ai_value).join();
  const vb = b.weeks.map((w) => w.ai_value).join();
  if (va !== vb) {
    bad++;
    console.log("Weekly values differ.");
  }
  const sells = ta.filter((t) => t.action === "Sold put" || t.action === "Sold call").length;
  console.log(`${bad ? "PARITY FAILED" : "Parity OK"}: ${a.candidates.size} Sundays, ${ta.length} trade rows (${sells} sales), ${a.weeks.length} weeks, rules ${RULES_VERSION}.`);
  if (bad) process.exit(1);
}

/** Build data/cache (see feed.ts): every core day's chains and every week's IV, for every finished symbol. */
export async function cacheCmd() {
  const feed = await Feed.open();
  feed.useCache = false;
  await feed.loadBars(["SPY"]);
  const symbols = opt("symbols")?.split(",") ?? Feed.finishedSymbols().symbols;
  const weeks = feed.weeks("2016-01-01", opt("to") ?? new Date().toISOString().slice(0, 10));
  const days = new Set<string>();
  for (const [j, w] of weeks.entries()) {
    if (j > 0) days.add(weeks[j - 1].last);
    days.add(w.entry);
    days.add(w.mid);
  }
  const t0 = Date.now();
  console.log(`Caching ${symbols.length} symbols, ${days.size} chain days, ${weeks.length} IV days...`);
  await feed.buildCache(symbols, [...days].sort(), weeks.map((w) => w.last), (s, i) => {
    if (i % 50 === 0 || i === symbols.length - 1) console.log(`  ${i + 1}/${symbols.length} ${s}  ${Math.round((Date.now() - t0) / 1000)}s`);
  });
  console.log(`Wrote data/cache (${Math.round((Date.now() - t0) / 1000)}s)`);
}
