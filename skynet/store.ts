/**
 * Local DuckDB store for Skynet's historical market data.
 * Raw vendor columns are kept as delivered (typed); nothing is derived here.
 * Every write is idempotent: rows for the same key are replaced, and fetch_log is updated in
 * the same transaction, so a crash at any point resumes cleanly.
 */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { csvHeader } from "./theta";

export const DB_PATH = resolve(process.env.SKYNET_DB ?? join(process.cwd(), "data", "skynet.duckdb"));

const D = "DOUBLE";
const I = "INTEGER";
const B = "BIGINT";
const T = "TIMESTAMP";
const V = "VARCHAR";

const QUOTE = {
  open: D, high: D, low: D, close: D, volume: B, count: B,
  bid_size: I, bid_exchange: I, bid: D, bid_condition: I,
  ask_size: I, ask_exchange: I, ask: D, ask_condition: I,
};
const CONTRACT = { symbol: V, expiration: "DATE", strike: D, right: V };
const GREEKS = Object.fromEntries(
  ["delta", "theta", "vega", "rho", "epsilon", "lambda", "gamma", "vanna", "charm", "vomma", "veta", "vera", "speed", "zomma",
   "color", "ultima", "d1", "d2", "dual_delta", "dual_gamma", "implied_vol", "iv_error"].map((k) => [k, D]),
);

/** Table schemas: column -> DuckDB type. `date` is the trading day the row describes. */
export const TABLES: Record<string, Record<string, string>> = {
  option_eod: { date: "DATE", ...CONTRACT, created: T, last_trade: T, ...QUOTE },
  option_greeks_eod: { date: "DATE", ...CONTRACT, timestamp: T, ...QUOTE, ...GREEKS, underlying_timestamp: T, underlying_price: D },
  option_oi: { date: "DATE", ...CONTRACT, timestamp: T, open_interest: B },
  stock_eod: { symbol: V, date: "DATE", created: T, last_trade: T, ...QUOTE },
  index_eod: { symbol: V, date: "DATE", created: T, last_trade: T, ...QUOTE },
  rate_eod: { symbol: V, date: "DATE", created: "DATE", rate: D },
  option_symbols: { symbol: V },
  option_expirations: { symbol: V, expiration: "DATE" },
  // free reference series (Cboe VIX family, FRED T-bill)
  ext_daily: { source: V, symbol: V, date: "DATE", open: D, high: D, low: D, close: D },
};

export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

let tmpN = 0;

export class Store {
  private constructor(
    private inst: DuckDBInstance,
    public con: DuckDBConnection,
  ) {}
  private chain: Promise<unknown> = Promise.resolve();
  private cols = new Map<string, Set<string>>();

  static async open(path = DB_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    const inst = await DuckDBInstance.create(path);
    const s = new Store(inst, await inst.connect());
    for (const [t, schema] of Object.entries(TABLES)) {
      await s.con.run(`CREATE TABLE IF NOT EXISTS ${t} (${Object.entries(schema).map(([c, ty]) => `${ident(c)} ${ty}`).join(", ")})`);
    }
    await s.con.run(`CREATE TABLE IF NOT EXISTS fetch_log (
      endpoint VARCHAR, symbol VARCHAR, day DATE, status VARCHAR, rows INTEGER, ms INTEGER,
      fetched_at TIMESTAMP DEFAULT current_timestamp, PRIMARY KEY (endpoint, symbol, day))`);
    return s;
  }

  close() {
    this.con.closeSync();
    this.inst.closeSync();
  }

  async all<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const r = await this.con.runAndReadAll(sql);
    return r.getRowObjectsJS().map((o) => {
      for (const k of Object.keys(o)) if (typeof o[k] === "bigint") o[k] = Number(o[k]);
      return o;
    }) as T[];
  }

  /** Serialize writes: one transaction at a time on the single connection. */
  private exclusive<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async columns(table: string) {
    let c = this.cols.get(table);
    if (!c) {
      const rows = await this.all<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = ${q(table)}`);
      c = new Set(rows.map((r) => r.name));
      this.cols.set(table, c);
    }
    return c;
  }

  /** Keys (days) already fetched for an endpoint + symbol, as YYYY-MM-DD. */
  async done(endpoint: string, symbol: string): Promise<Set<string>> {
    const rows = await this.all<{ d: string }>(
      `SELECT strftime(day, '%Y-%m-%d') AS d FROM fetch_log WHERE endpoint = ${q(endpoint)} AND symbol = ${q(symbol)} AND status IN ('ok', 'no_data')`,
    );
    return new Set(rows.map((r) => r.d));
  }

  /**
   * Load one CSV response into `table`, replacing rows matched by `replaceWhere`, and log it.
   * `extras` are SQL expressions for columns not in the CSV (e.g. the request date).
   * Columns the vendor adds later are kept as VARCHAR rather than dropped.
   */
  load(args: {
    table: string;
    csv: string | null;
    extras?: Record<string, string>;
    replaceWhere: string;
    log?: { endpoint: string; symbol: string; day: string; status: "ok" | "no_data"; ms: number };
  }): Promise<number> {
    return this.exclusive(async () => {
      const { table, csv, extras = {}, replaceWhere, log } = args;
      const schema = TABLES[table];
      const header = csv ? csvHeader(csv) : [];
      const hasRows = !!csv && header.length > 0 && csv.indexOf("\n") !== -1 && csv.slice(csv.indexOf("\n") + 1).trim().length > 0;
      let tmp: string | null = null;
      await this.con.run("BEGIN TRANSACTION");
      try {
        await this.con.run(`DELETE FROM ${table} WHERE ${replaceWhere}`);
        let n = 0;
        if (hasRows) {
          const have = await this.columns(table);
          for (const h of header) {
            if (!have.has(h) && !(h in extras)) {
              await this.con.run(`ALTER TABLE ${table} ADD COLUMN ${ident(h)} VARCHAR`);
              have.add(h);
              console.warn(`  note: new vendor column ${table}.${h} (stored as VARCHAR)`);
            }
          }
          tmp = join(tmpdir(), `skynet-${process.pid}-${tmpN++}.csv`);
          writeFileSync(tmp, csv!);
          const target: string[] = [];
          const exprs: string[] = [];
          for (const h of header) {
            if (h in extras) continue;
            target.push(ident(h));
            const ty = schema[h];
            exprs.push(ty && ty !== V ? `TRY_CAST(${ident(h)} AS ${ty})` : ident(h));
          }
          for (const [c, e] of Object.entries(extras)) {
            target.push(ident(c));
            exprs.push(e);
          }
          const src = `read_csv(${q(tmp.replace(/\\/g, "/"))}, header = true, all_varchar = true, delim = ',', quote = '"')`;
          const r = await this.con.run(`INSERT INTO ${table} (${target.join(", ")}) SELECT ${exprs.join(", ")} FROM ${src}`);
          n = Number(r.rowsChanged);
        }
        if (log) {
          await this.con.run(
            `INSERT OR REPLACE INTO fetch_log (endpoint, symbol, day, status, rows, ms, fetched_at) VALUES
             (${q(log.endpoint)}, ${q(log.symbol)}, DATE ${q(log.day)}, ${q(log.status)}, ${n}, ${Math.round(log.ms)}, current_timestamp)`,
          );
        }
        await this.con.run("COMMIT");
        return n;
      } catch (e) {
        await this.con.run("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        if (tmp) {
          try {
            unlinkSync(tmp);
          } catch {}
        }
      }
    });
  }
}
