/**
 * Sectors for the backtest: the theme each stock counts against and the sector fund whose rotation quadrant it
 * inherits. There's no history of sectors in the data pull, so `npm run skynet -- sectors` copies the latest theme of
 * every stock that has appeared in a prep report into data/sectors.json (local, gitignored). Stocks missing from the
 * file get the prep report's fallback: theme "Other", no sector fund.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FUNDS, SECTOR_FUND } from "../src/lib/rules";
import { DATA_DIR } from "./feed";

const FILE = join(DATA_DIR, "sectors.json");

export function loadSectors(): Record<string, string> {
  if (!existsSync(FILE)) return {};
  return (JSON.parse(readFileSync(FILE, "utf8")) as { sectors: Record<string, string> }).sectors ?? {};
}

export async function sectorsCmd() {
  await import("../scripts/env");
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const rows = (
      await client.query(`
        SELECT DISTINCT ON (c->>'symbol') c->>'symbol' AS symbol, c->>'theme' AS theme
        FROM prep_reports r, jsonb_array_elements(r.data->'candidates') c
        WHERE c->>'theme' IS NOT NULL
        ORDER BY c->>'symbol', r.created_at DESC`)
    ).rows as { symbol: string; theme: string }[];
    const sectors: Record<string, string> = {};
    for (const r of rows) if (!FUNDS[r.symbol] && SECTOR_FUND[r.theme]) sectors[r.symbol] = r.theme;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), source: "prep_reports candidates (latest theme)", sectors }, null, 1));
    console.log(`Wrote ${FILE}: ${Object.keys(sectors).length} stocks.`);
  } finally {
    await client.end();
  }
}
