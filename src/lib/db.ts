import "server-only";
import { connection } from "next/server";
import { createAdminClient, selectAll } from "./supabase";
import type { Account, PositionRow, Snapshot, Stream, StreamRule, TransactionRow } from "./types";

export function db() {
  return createAdminClient();
}

/** Everything the reporting pages need. Data volume is small, so load it all and slice in memory. */
export async function loadAll() {
  await connection(); // always render with fresh data
  const client = db();
  const [accounts, streams, rules, positions, transactions, snapshots] = await Promise.all([
    selectAll<Account>((a, b) => client.from("accounts").select("*").order("name").range(a, b)),
    selectAll<Stream>((a, b) => client.from("streams").select("*").order("sort_order").range(a, b)),
    selectAll<StreamRule>((a, b) => client.from("stream_rules").select("*").order("priority").range(a, b)),
    selectAll<PositionRow>((a, b) => client.from("v_positions").select("*").order("opened_at", { ascending: false }).range(a, b)),
    selectAll<TransactionRow>((a, b) =>
      client.from("v_transactions").select("*").order("occurred_at", { ascending: false }).range(a, b),
    ),
    selectAll<Snapshot>((a, b) => client.from("snapshots").select("*").order("as_of", { ascending: false }).range(a, b)),
  ]);
  return { accounts, streams, rules, positions: numeric(positions), transactions: numeric(transactions), snapshots };
}

// numeric columns arrive as strings from PostgREST when large; normalise the ones we do math on
const NUMERIC_KEYS = [
  "strike", "quantity", "open_quantity", "open_price", "close_price", "credits", "debits",
  "fees", "net_amount", "collateral", "price", "amount", "total_value", "cash", "net_deposits",
];

function numeric<T extends object>(rows: T[]): T[] {
  for (const r of rows as Record<string, unknown>[]) {
    for (const k of NUMERIC_KEYS) {
      if (typeof r[k] === "string") r[k] = Number(r[k]);
    }
  }
  return rows;
}
