/**
 * Daily stock bars from Alpaca's free market-data plan (history from 2016, 200 requests/min).
 * Fills the gap ThetaData's free stock tier leaves (it starts 2023-06). Writes straight to
 * data/parquet/stock_bars/<SYMBOL>.parquet, never to the DuckDB file, so it can run while an
 * options pull holds that file. Each file has both `raw` prices (match option strikes) and
 * `split`-adjusted ones (for indicators), in the `adjustment` column.
 * Keys: ALPACA_KEY_ID and ALPACA_SECRET_KEY in .env.local (a free paper/data-only account).
 */
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PARQUET_DIR, Store, q } from "./store";

const BASE = "https://data.alpaca.markets/v2/stocks/bars";
export const BARS_DIR = join(PARQUET_DIR, "stock_bars");
const BATCH = 50;
/** Option roots that Alpaca spells with a share-class dot. Files keep the option root's name. */
const ALIAS: Record<string, string> = { BRKB: "BRK.B", BFB: "BF.B", RDSA: "RDS.A", RDSB: "RDS.B", LENB: "LEN.B", HEIA: "HEI.A" };
const fromAlpaca = Object.fromEntries(Object.entries(ALIAS).map(([k, v]) => [v, k]));
const MIN_GAP_MS = 320; // stays under 200 requests a minute

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
}

let last = 0;
async function get(url: string): Promise<{ bars: Record<string, AlpacaBar[]> | null; next_page_token: string | null }> {
  const headers = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID ?? "", "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY ?? "" };
  for (let attempt = 0; ; attempt++) {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    let status = 0;
    let body = "";
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      status = res.status;
      body = await res.text();
    } catch (e) {
      body = e instanceof Error ? e.message : String(e);
    }
    if (status === 200) return JSON.parse(body);
    if ((status === 0 || status === 429 || status >= 500) && attempt < 8) {
      const ms = status === 429 ? 60_000 : 2000 * 2 ** attempt;
      console.warn(`  alpaca ${status || "no response"}, retrying in ${ms / 1000}s`);
      await new Promise((r) => setTimeout(r, ms));
      continue;
    }
    throw new Error(`Alpaca ${status}: ${body.slice(0, 200)}`);
  }
}

/** Pull daily bars for `symbols`; skips symbols that already have a file unless `refresh`. */
export async function pullBars(store: Store, symbols: string[], from: string, to: string, refresh: boolean, shouldStop: () => boolean) {
  if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) throw new Error("Set ALPACA_KEY_ID and ALPACA_SECRET_KEY in .env.local");
  mkdirSync(BARS_DIR, { recursive: true });
  const todo = symbols.filter((s) => refresh || !existsSync(join(BARS_DIR, `${s}.parquet`)));
  console.log(`Stock bars ${from} .. ${to}: ${todo.length} symbols to fetch (${symbols.length - todo.length} already stored).`);
  const missing: string[] = [];
  const t0 = Date.now();
  let req = 0;
  for (let b = 0; b < todo.length && !shouldStop(); b += BATCH) {
    const batch = todo.slice(b, b + BATCH);
    const rows = new Map<string, string[]>(batch.map((s) => [s, []]));
    for (const adj of ["raw", "split"]) {
      let token: string | null = null;
      do {
        // asof "-": the literal ticker on each date, matching how option data is keyed. (The default
        // maps today's company back through renames, which stitches a reused ticker's old company
        // onto its new one.)
        const qs = new URLSearchParams({ symbols: batch.map((s) => ALIAS[s] ?? s).join(","), timeframe: "1Day", start: from, end: to, adjustment: adj, feed: "sip", limit: "10000", asof: "-" });
        if (token) qs.set("page_token", token);
        const j = await get(`${BASE}?${qs}`);
        req++;
        for (const [alpacaSym, bars] of Object.entries(j.bars ?? {})) {
          const sym = fromAlpaca[alpacaSym] ?? alpacaSym;
          const out = rows.get(sym);
          if (!out) continue;
          for (const x of bars) {
            out.push(JSON.stringify({ symbol: sym, date: x.t.slice(0, 10), adjustment: adj, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v, trades: x.n, vwap: x.vw }));
          }
        }
        token = j.next_page_token;
      } while (token);
    }
    for (const [sym, lines] of rows) {
      if (!lines.length) {
        missing.push(sym);
        continue;
      }
      const final = join(BARS_DIR, `${sym}.parquet`);
      const tmpJson = `${final}.json`;
      writeFileSync(tmpJson, lines.join("\n"));
      // `segment` marks a likely change of company under a reused ticker, so indicators never
      // reach across one. It starts a new segment on a gap over 45 days (BBBY: Bed Bath ends 2023,
      // Beyond starts 2025) or an overnight jump beyond 3x / under 1/3 in the split-adjusted series
      // (META: a Roundhill ETF handed the ticker straight to Meta in 2022). Splits don't trigger it.
      await store.con.run(
        `COPY (
           WITH b AS (
             SELECT symbol, CAST(date AS DATE) AS date, adjustment, open, high, low, close, volume, trades, vwap
             FROM read_json(${q(tmpJson.replace(/\\/g, "/"))}, format = 'newline_delimited',
               columns = {symbol: 'VARCHAR', date: 'VARCHAR', adjustment: 'VARCHAR', open: 'DOUBLE', high: 'DOUBLE', low: 'DOUBLE',
                          close: 'DOUBLE', volume: 'DOUBLE', trades: 'BIGINT', vwap: 'DOUBLE'})),
           s AS (
             SELECT date, date - lag(date) OVER w AS gap, open / NULLIF(lag(close) OVER w, 0) AS jump
             FROM b WHERE adjustment = 'split' WINDOW w AS (ORDER BY date)),
           seg AS (
             SELECT date, CAST(sum(CASE WHEN gap > 45 OR jump > 3 OR jump < 1.0 / 3 THEN 1 ELSE 0 END) OVER (ORDER BY date) AS INTEGER) AS segment FROM s)
           SELECT b.symbol, b.date, b.adjustment, coalesce(seg.segment, 0) AS segment,
                  b.open, b.high, b.low, b.close, b.volume, b.trades, b.vwap
           FROM b LEFT JOIN seg USING (date) ORDER BY b.adjustment, b.date)
         TO ${q(`${final}.tmp`.replace(/\\/g, "/"))} (FORMAT parquet, COMPRESSION zstd)`,
      );
      renameSync(`${final}.tmp`, final);
      unlinkSync(tmpJson);
    }
    const done = Math.min(b + BATCH, todo.length);
    console.log(`  ${done}/${todo.length} symbols, ${req} requests, ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  if (missing.length) {
    writeFileSync(join(BARS_DIR, "_missing.json"), JSON.stringify({ updated: new Date().toISOString(), from, to, symbols: missing }, null, 1));
    console.log(`No Alpaca bars for ${missing.length} symbols (listed in stock_bars/_missing.json); their daily close is still in the option data from 2017 on.`);
  }
}
