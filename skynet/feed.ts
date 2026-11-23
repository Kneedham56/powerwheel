/**
 * Skynet's historical feed: each run day's inputs, built from the Parquet store strictly as of that day.
 *
 * Reads data/parquet with an in-memory DuckDB (`read_parquet`). It never opens data/skynet.duckdb, which a running
 * pull holds.
 *  - stock_bars/<SYM>.parquet: `split` prices for indicators (rescaled to the day's raw price, so levels like the
 *    floor and the target strike are in that day's dollars), `raw` closes for strikes, marks and settlement. Bars
 *    never reach across a `segment` (a reused ticker).
 *  - option_greeks_eod/<SYM>.parquet: bid, ask, delta, IV and the stock price on each contract, per day.
 *  - option_oi/<SYM>.parquet: open interest, pulled on each week's first trading day; later days in the week use the
 *    latest one on or before them.
 *  - ext_daily.parquet: VIX (Cboe) and the 3-month T-bill (FRED DTB3).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { Bar, OptionQuote } from "../src/lib/rules";

export const DATA_DIR = join(process.cwd(), "data");
export const PARQUET = join(DATA_DIR, "parquet");
const P = (...parts: string[]) => join(PARQUET, ...parts).replace(/\\/g, "/");
const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The backtest cache (data/cache, gitignored): per symbol, the slice of option_greeks_eod + option_oi that runs read
 * (every core day's contracts within CACHE_MAX_DAYS, open interest already joined) and the 30-day IV on every week's
 * last day. A run reads these small files instead of scanning the full Parquet store. Build it with
 * `npm run skynet -- cache` after the data changes; `--no-cache` on a backtest reads the store directly.
 */
export const CACHE = join(DATA_DIR, "cache");
const C = (...parts: string[]) => join(CACHE, ...parts).replace(/\\/g, "/");
export const CACHE_MAX_DAYS = 15;

export const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A trading week as the pull's core days see it: first day (entry), the day nearest Wednesday, last day (expiry). */
export interface Week {
  monday: string; // the calendar Monday
  entry: string;
  mid: string;
  last: string;
  days: string[];
}

interface SymBars {
  date: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[]; // split-adjusted
  raw: number[]; // raw close
  volume: number[]; // raw volume
  segment: number[];
}

export interface Contract extends OptionQuote {
  right: "put" | "call";
}

/** One day's chains: symbol → contracts (expiring within the feed's window). */
export type DayChains = Map<string, Contract[]>;

export class Feed {
  private bars = new Map<string, SymBars>();
  private chains = new Map<string, DayChains>(); // date → chains
  private spots = new Map<string, Map<string, number>>(); // date → symbol → stock price from the option rows
  private ivs = new Map<string, Map<string, number>>(); // symbol → date → 30-day at-the-money IV
  vix = new Map<string, number>();
  tbill = new Map<string, number>(); // percent
  private refDates: string[] = [];

  private constructor(private con: DuckDBConnection) {}

  static async open() {
    const inst = await DuckDBInstance.create(":memory:");
    const f = new Feed(await inst.connect());
    await f.loadRef();
    return f;
  }

  private async rows<T>(sql: string): Promise<T[]> {
    const r = await this.con.runAndReadAll(sql);
    return r.getRowObjectsJson() as unknown as T[];
  }

  // -------------------------------------------------------------------------
  // what's available
  // -------------------------------------------------------------------------

  /**
   * Symbols whose option data is complete for backtesting: the pull's finished list (data/progress.json). During the
   * `rest` pass every symbol's core days are done, so any file counts.
   */
  static finishedSymbols(): { symbols: string[]; note: string } {
    const prog = join(DATA_DIR, "progress.json");
    const files = existsSync(P("option_greeks_eod")) ? listParquet("option_greeks_eod") : [];
    if (!existsSync(prog)) return { symbols: files, note: "no progress.json: using every option file" };
    const p = JSON.parse(readFileSync(prog, "utf8")) as { pass?: string; finished?: { symbol: string }[]; next?: string };
    if (p.pass === "rest") return { symbols: files, note: "rest pass: every symbol's core days are done" };
    const done = new Set((p.finished ?? []).map((x) => x.symbol));
    return { symbols: files.filter((s) => done.has(s)), note: `${p.pass ?? "all"} pass: ${done.size} finished${p.next ? `, ${p.next} in progress` : ""}` };
  }

  hasBars = (sym: string) => existsSync(P("stock_bars", `${sym}.parquet`));
  hasOptions = (sym: string) => existsSync(P("option_greeks_eod", `${sym}.parquet`));

  // -------------------------------------------------------------------------
  // reference series and the calendar
  // -------------------------------------------------------------------------

  private async loadRef() {
    const ext = P("ext_daily.parquet");
    if (!existsSync(ext)) throw new Error(`missing ${ext}: run npm run skynet -- ref`);
    for (const r of await this.rows<{ symbol: string; d: string; close: number }>(
      `SELECT symbol, strftime(date, '%Y-%m-%d') d, close FROM read_parquet(${sq(ext)}) WHERE symbol IN ('VIX', 'DTB3') AND close IS NOT NULL ORDER BY date`,
    )) {
      (r.symbol === "VIX" ? this.vix : this.tbill).set(r.d, Number(r.close));
    }
    this.refDates = [...new Set([...this.vix.keys(), ...this.tbill.keys()])].sort();
  }

  /** The latest value on or before `date`. */
  asOf(series: Map<string, number>, date: string): number | null {
    let lo = 0;
    let hi = this.refDates.length - 1;
    let best: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.refDates[mid] <= date) {
        lo = mid + 1;
        best = mid;
      } else hi = mid - 1;
    }
    for (let i = best ?? -1; i >= 0; i--) {
      const v = series.get(this.refDates[i]);
      if (v !== undefined) return v;
    }
    return null;
  }

  /** Trading weeks from SPY's raw bars, the same calendar the pull uses. */
  weeks(from: string, to: string): Week[] {
    const spy = this.bars.get("SPY");
    if (!spy) throw new Error("load SPY bars first");
    const byWeek = new Map<string, string[]>();
    for (const d of spy.date) {
      if (d < from || d > to) continue;
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      const monday = addDays(d, -((dow + 6) % 7));
      (byWeek.get(monday) ?? byWeek.set(monday, []).get(monday)!).push(d);
    }
    return [...byWeek.entries()].map(([monday, days]) => {
      const wed = addDays(monday, 2);
      const mid = days.reduce((a, b) => (Math.abs(Date.parse(b) - Date.parse(wed)) < Math.abs(Date.parse(a) - Date.parse(wed)) ? b : a));
      return { monday, entry: days[0], mid, last: days[days.length - 1], days };
    });
  }

  // -------------------------------------------------------------------------
  // stock bars
  // -------------------------------------------------------------------------

  async loadBars(symbols: string[]) {
    for (const s of symbols) {
      if (this.bars.has(s) || !this.hasBars(s)) continue;
      const rows = await this.rows<{ d: string; adjustment: string; segment: number; open: number; high: number; low: number; close: number; volume: number }>(
        `SELECT strftime(date, '%Y-%m-%d') d, adjustment, segment, open, high, low, close, volume FROM read_parquet(${sq(P("stock_bars", `${s}.parquet`))}) ORDER BY date`,
      );
      const raw = new Map(rows.filter((r) => r.adjustment === "raw").map((r) => [r.d, r]));
      const b: SymBars = { date: [], open: [], high: [], low: [], close: [], raw: [], volume: [], segment: [] };
      for (const r of rows) {
        if (r.adjustment !== "split") continue;
        const x = raw.get(r.d);
        if (!x) continue;
        b.date.push(r.d);
        b.open.push(Number(r.open));
        b.high.push(Number(r.high));
        b.low.push(Number(r.low));
        b.close.push(Number(r.close));
        b.raw.push(Number(x.close));
        b.volume.push(Number(x.volume));
        b.segment.push(Number(r.segment));
      }
      if (b.date.length) this.bars.set(s, b);
    }
  }

  /** Index of the last bar on or before (or strictly before) `date`, or -1. */
  private idx(b: SymBars, date: string, strict: boolean) {
    let lo = 0;
    let hi = b.date.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (strict ? b.date[mid] < date : b.date[mid] <= date) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  }

  /**
   * Daily bars as a chart would have shown them on `date`: the last `n` bars through `date` (or before it, with
   * `strict`), within the latest bar's segment, split-adjusted and scaled to that bar's raw price.
   */
  barsAsOf(sym: string, date: string, opts: { strict?: boolean; n?: number } = {}): Bar[] | undefined {
    const b = this.bars.get(sym);
    if (!b) return undefined;
    const end = this.idx(b, date, !!opts.strict);
    if (end < 0) return undefined;
    // a bar more than 10 days stale means the name wasn't trading (delisted or not yet listed)
    if (Date.parse(date) - Date.parse(b.date[end]) > 10 * 864e5) return undefined;
    const seg = b.segment[end];
    let start = Math.max(0, end - (opts.n ?? 290) + 1);
    for (let i = end; i >= start; i--) {
      if (b.segment[i] !== seg) {
        start = i + 1;
        break;
      }
    }
    const k = b.raw[end] / b.close[end];
    const out: Bar[] = [];
    for (let i = start; i <= end; i++) out.push({ date: b.date[i], open: b.open[i] * k, high: b.high[i] * k, low: b.low[i] * k, close: b.close[i] * k });
    return out;
  }

  /** The raw close on exactly `date` (else the option rows' stock price that day). */
  close(sym: string, date: string): number | undefined {
    const b = this.bars.get(sym);
    if (b) {
      const i = this.idx(b, date, false);
      if (i >= 0 && b.date[i] === date) return b.raw[i];
    }
    return this.spots.get(date)?.get(sym);
  }

  /** raw ÷ split-adjusted on `date`: it changes by the split ratio across a split. */
  splitFactor(sym: string, date: string): number | null {
    const b = this.bars.get(sym);
    if (!b) return null;
    const i = this.idx(b, date, false);
    return i < 0 ? null : b.raw[i] / b.close[i];
  }

  /** Average daily dollar volume over the 20 sessions before `date` (a stand-in for the market-cap test). */
  dollarVolume(sym: string, date: string): number | null {
    const b = this.bars.get(sym);
    if (!b) return null;
    const end = this.idx(b, date, true);
    if (end < 19) return null;
    let s = 0;
    for (let i = end - 19; i <= end; i++) s += b.raw[i] * b.volume[i];
    return s / 20;
  }

  // -------------------------------------------------------------------------
  // option chains
  // -------------------------------------------------------------------------

  /**
   * Load chains for `symbols` on `days`: contracts expiring within `maxDays`, puts from half the stock price up to just
   * above it, calls from just below it up to 1.6×. Open interest is the latest pull on or before each day.
   */
  useCache = true;
  private cached = (kind: "chains" | "iv", s: string) => this.useCache && existsSync(C(kind, `${s}.parquet`)) && (kind === "iv" || this.cacheMaxDays() >= 0);
  private cacheMax: number | null = null;
  private cacheMaxDays() {
    if (this.cacheMax === null) {
      const m = C("manifest.json");
      this.cacheMax = existsSync(m) ? (JSON.parse(readFileSync(m, "utf8")) as { maxDays: number }).maxDays : -1;
    }
    return this.cacheMax;
  }

  /** The chain query over the full store (also what the cache is built from). Dates come back as DATE. */
  private chainSql(s: string, dayList: string, minDay: string, maxDay: string, maxDays: number) {
    const g = sq(P("option_greeks_eod", `${s}.parquet`));
    const oiFile = P("option_oi", `${s}.parquet`);
    return `
        WITH q AS (
          SELECT date, expiration, strike, "right", bid, ask, delta, implied_vol, underlying_price
          FROM read_parquet(${g})
          WHERE date IN (${dayList}) AND expiration >= date AND expiration <= date + ${Math.round(maxDays)}
            AND underlying_price > 0
            AND (("right" = 'PUT' AND strike BETWEEN 0.5 * underlying_price AND 1.05 * underlying_price)
              OR ("right" = 'CALL' AND strike BETWEEN 0.95 * underlying_price AND 1.6 * underlying_price))
        )${
          existsSync(oiFile)
            ? `,
        oi AS (
          SELECT date, expiration, strike, "right", open_interest FROM read_parquet(${sq(oiFile)})
          WHERE date BETWEEN DATE ${sq(minDay)} - 10 AND DATE ${sq(maxDay)} AND expiration >= DATE ${sq(minDay)}
        )
        SELECT q.date d, q.expiration e, q.strike, q."right", q.bid, q.ask, q.delta, q.implied_vol iv, q.underlying_price u, oi.open_interest oi
        FROM q ASOF LEFT JOIN oi ON q.expiration = oi.expiration AND q.strike = oi.strike AND q."right" = oi."right" AND q.date >= oi.date`
            : `
        SELECT date d, expiration e, strike, "right", bid, ask, delta, implied_vol iv, underlying_price u, NULL::BIGINT oi FROM q`
        }`;
  }

  private ivSql(s: string, dayList: string) {
    return `
        WITH x AS (
          SELECT date, implied_vol,
                 rank() OVER (PARTITION BY date ORDER BY abs(date_diff('day', date, expiration) - 30), expiration, abs(strike - underlying_price), strike) rk
          FROM read_parquet(${sq(P("option_greeks_eod", `${s}.parquet`))})
          WHERE date IN (${dayList}) AND expiration BETWEEN date + 7 AND date + 60 AND implied_vol > 0.01 AND implied_vol < 5 AND bid > 0
        )
        SELECT date d, avg(implied_vol) iv FROM x WHERE rk = 1 GROUP BY date`;
  }

  /**
   * Build data/cache for `symbols`: chains on `days` (the core days: each week's Friday before, entry and middle day)
   * and IV on `ivDays` (each week's last day). One pass over each symbol's store.
   */
  async buildCache(symbols: string[], days: string[], ivDays: string[], log: (s: string, i: number) => void = () => {}) {
    mkdirSync(C("chains"), { recursive: true });
    mkdirSync(C("iv"), { recursive: true });
    const dayList = days.map((d) => `DATE ${sq(d)}`).join(", ");
    const ivList = ivDays.map((d) => `DATE ${sq(d)}`).join(", ");
    const minDay = days.reduce((a, b) => (a < b ? a : b));
    const maxDay = days.reduce((a, b) => (a > b ? a : b));
    for (const [i, s] of symbols.entries()) {
      if (!this.hasOptions(s)) continue;
      await this.con.run(`COPY (${this.chainSql(s, dayList, minDay, maxDay, CACHE_MAX_DAYS)} ORDER BY d, e, strike) TO ${sq(C("chains", `${s}.parquet`))} (FORMAT parquet)`);
      await this.con.run(`COPY (${this.ivSql(s, ivList)} ORDER BY d) TO ${sq(C("iv", `${s}.parquet`))} (FORMAT parquet)`);
      log(s, i);
    }
    writeFileSync(C("manifest.json"), JSON.stringify({ built: new Date().toISOString(), maxDays: CACHE_MAX_DAYS, symbols: symbols.length, from: minDay, to: maxDay }, null, 1));
    this.cacheMax = null;
  }

  async loadChains(symbols: string[], days: string[], maxDays: number) {
    if (!days.length) return;
    const dayList = days.map((d) => `DATE ${sq(d)}`).join(", ");
    const minDay = days.reduce((a, b) => (a < b ? a : b));
    const maxDay = days.reduce((a, b) => (a > b ? a : b));
    const fromCache = this.useCache && this.cacheMaxDays() >= maxDays;
    for (const s of symbols) {
      if (!this.hasOptions(s)) continue;
      const inner =
        fromCache && this.cached("chains", s)
          ? `SELECT * FROM read_parquet(${sq(C("chains", `${s}.parquet`))}) WHERE d IN (${dayList}) AND e <= d + ${Math.round(maxDays)}`
          : this.chainSql(s, dayList, minDay, maxDay, maxDays);
      const sql = `SELECT strftime(d, '%Y-%m-%d') d, strftime(e, '%Y-%m-%d') e, strike, "right", bid, ask, delta, iv, u, oi FROM (${inner})`;
      const rows = await this.rows<{ d: string; e: string; strike: number; right: string; bid: number | null; ask: number | null; delta: number | null; iv: number | null; u: number; oi: number | string | null }>(sql);
      for (const r of rows) {
        let day = this.chains.get(r.d);
        if (!day) this.chains.set(r.d, (day = new Map()));
        let list = day.get(s);
        if (!list) day.set(s, (list = []));
        list.push({
          right: r.right === "PUT" ? "put" : "call",
          strike: Number(r.strike),
          expiry: r.e,
          bid: r.bid === null ? null : Number(r.bid),
          ask: r.ask === null ? null : Number(r.ask),
          mark: null,
          delta: r.delta === null ? null : Number(r.delta),
          iv: r.iv === null ? null : Number(r.iv),
          openInterest: r.oi === null ? null : Number(r.oi),
        });
        let sp = this.spots.get(r.d);
        if (!sp) this.spots.set(r.d, (sp = new Map()));
        sp.set(s, Number(r.u));
      }
    }
  }

  /** Drop chains before `date`, to keep memory flat over a long run. */
  dropChainsBefore(date: string) {
    for (const d of [...this.chains.keys()]) if (d < date) this.chains.delete(d);
  }

  chain(sym: string, date: string): Contract[] {
    return this.chains.get(date)?.get(sym) ?? [];
  }

  /**
   * Front-week at-the-money IV ÷ the next expiry's, on `date` (null without two expiries). An earnings report before
   * the front expiry packs its move into fewer days, so the ratio jumps (about 1.2+); the backtest has no earnings
   * calendar, and this stands in for one.
   */
  termRatio(sym: string, date: string): number | null {
    const ch = this.chain(sym, date);
    const spot = this.spots.get(date)?.get(sym);
    if (!ch.length || !spot) return null;
    const exps = [...new Set(ch.map((c) => c.expiry).filter((e) => e > date))].sort();
    if (exps.length < 2) return null;
    const atm = (e: string) => {
      const cs = ch.filter((c) => c.expiry === e && c.iv !== null && c.iv > 0);
      if (!cs.length) return null;
      const k = cs.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a)).strike;
      const at = cs.filter((c) => c.strike === k);
      return at.reduce((a, c) => a + c.iv!, 0) / at.length;
    };
    const f = atm(exps[0]);
    const n = atm(exps[1]);
    return f && n ? f / n : null;
  }

  /** Contracts of one type expiring on `expiry`, as the race's quote book wants them. */
  book(sym: string, date: string, type: "put" | "call", expiry: string): OptionQuote[] {
    return this.chain(sym, date)
      .filter((c) => c.right === type && c.expiry === expiry)
      .map(({ strike, expiry: e, bid, ask, mark, delta, iv, openInterest }) => ({ strike, expiry: e, bid, ask, mark, delta, iv, openInterest }));
  }

  /**
   * 30-day at-the-money implied volatility on each of `days`: the expiry nearest 30 days out (7–60), the strike nearest
   * the stock price, the average of its put and call.
   */
  async loadIv(symbols: string[], days: string[]) {
    if (!days.length) return;
    const dayList = days.map((d) => `DATE ${sq(d)}`).join(", ");
    for (const s of symbols) {
      if (!this.hasOptions(s)) continue;
      const inner = this.cached("iv", s) ? `SELECT d, iv FROM read_parquet(${sq(C("iv", `${s}.parquet`))}) WHERE d IN (${dayList})` : this.ivSql(s, dayList);
      const rows = await this.rows<{ d: string; iv: number }>(`SELECT strftime(d, '%Y-%m-%d') d, iv FROM (${inner})`);
      const m = this.ivs.get(s) ?? new Map<string, number>();
      for (const r of rows) m.set(r.d, Number(r.iv));
      this.ivs.set(s, m);
    }
  }

  /** The 30-day IV on `date`, and its rank (0–1) within the year before it. */
  ivOn(sym: string, date: string): { iv: number | null; ivRank: number | null } {
    const m = this.ivs.get(sym);
    const iv = m?.get(date) ?? null;
    if (!m || iv === null) return { iv, ivRank: null };
    const yearAgo = addDays(date, -365);
    const hist = [...m.entries()].filter(([d]) => d >= yearAgo && d <= date).map(([, v]) => v);
    if (hist.length < 20) return { iv, ivRank: null };
    const lo = Math.min(...hist);
    const hi = Math.max(...hist);
    return { iv, ivRank: hi > lo ? (iv - lo) / (hi - lo) : null };
  }
}

function listParquet(table: string) {
  const dir = P(table);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".parquet") && !f.startsWith("_"))
    .map((f) => f.replace(/\.parquet$/, ""))
    .sort();
}
