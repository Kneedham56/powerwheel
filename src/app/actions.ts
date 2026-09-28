"use server";

// Every mutation goes through run(), which checks the session (see lib/auth.ts) and
// refuses writes in the read-only demo. Server actions are reachable by direct POST,
// so this check matters even though proxy.ts already gates the pages.

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, isDemo, isValidSession } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  assignTrade,
  closeTrade,
  deletePosition,
  expireTrade,
  openTrade,
  rollTrade,
  type OpenKind,
} from "@/lib/trades";

function str(f: FormData, k: string): string {
  return String(f.get(k) ?? "").trim();
}
function opt(f: FormData, k: string): string | null {
  return str(f, k) || null;
}
function n(f: FormData, k: string): number {
  const v = Number(str(f, k));
  if (!Number.isFinite(v)) throw new Error(`${k} must be a number`);
  return v;
}
function optN(f: FormData, k: string): number | undefined {
  return str(f, k) ? n(f, k) : undefined;
}

async function requireWrite() {
  if (isDemo()) throw new Error("This is a read-only demo — changes are disabled.");
  if (!(await isValidSession((await cookies()).get(SESSION_COOKIE)?.value))) throw new Error("Please sign in again.");
}

/** Run a mutation, then send the user back with a flash message in the URL. */
async function run(f: FormData, fallback: string, work: () => Promise<string | void>) {
  const back = str(f, "back") || fallback;
  let target: string;
  try {
    await requireWrite();
    const msg = await work();
    revalidatePath("/", "layout");
    target = withParam(back, "ok", msg || "Saved");
  } catch (e) {
    target = withParam(back, "error", e instanceof Error ? e.message : String(e));
  }
  redirect(target);
}

function withParam(url: string, key: string, value: string) {
  const u = new URL(url, "http://x");
  u.searchParams.delete("ok");
  u.searchParams.delete("error");
  u.searchParams.set(key, value);
  return u.pathname + u.search;
}

// ---------------------------------------------------------------------------
// trades
// ---------------------------------------------------------------------------

export async function openTradeAction(f: FormData) {
  await run(f, "/positions", async () => {
    const kind = str(f, "kind") as OpenKind;
    await openTrade(db(), {
      accountId: str(f, "account_id"),
      streamId: opt(f, "stream_id"),
      ticker: str(f, "ticker"),
      kind,
      strike: kind === "STOCK" ? null : n(f, "strike"),
      expiration: kind === "STOCK" ? null : str(f, "expiration"),
      quantity: n(f, "quantity"),
      price: n(f, "price"),
      fees: optN(f, "fees"),
      date: str(f, "date"),
      notes: opt(f, "notes"),
    });
    return `Opened ${str(f, "ticker").toUpperCase()} ${kind}`;
  });
}

export async function closeTradeAction(f: FormData) {
  await run(f, "/positions", async () => {
    await closeTrade(db(), {
      positionId: str(f, "position_id"),
      quantity: optN(f, "quantity"),
      price: n(f, "price"),
      fees: optN(f, "fees"),
      date: str(f, "date"),
      notes: opt(f, "notes"),
    });
    return "Closed";
  });
}

export async function rollTradeAction(f: FormData) {
  await run(f, "/positions", async () => {
    await rollTrade(db(), {
      positionId: str(f, "position_id"),
      quantity: optN(f, "quantity"),
      closePrice: n(f, "close_price"),
      newStrike: n(f, "new_strike"),
      newExpiration: str(f, "new_expiration"),
      newPrice: n(f, "new_price"),
      newQuantity: optN(f, "new_quantity"),
      fees: optN(f, "fees"),
      date: str(f, "date"),
      notes: opt(f, "notes"),
    });
    return "Rolled";
  });
}

export async function expireTradeAction(f: FormData) {
  await run(f, "/positions", async () => {
    await expireTrade(db(), { positionId: str(f, "position_id"), date: opt(f, "date") ?? undefined });
    return "Marked expired";
  });
}

export async function assignTradeAction(f: FormData) {
  await run(f, "/positions", async () => {
    await assignTrade(db(), {
      positionId: str(f, "position_id"),
      date: opt(f, "date") ?? undefined,
      quantity: optN(f, "quantity"),
    });
    return "Marked assigned";
  });
}

export async function deletePositionAction(f: FormData) {
  await run(f, "/positions", async () => {
    await deletePosition(db(), str(f, "position_id"));
    return "Deleted";
  });
}

export async function updatePositionAction(f: FormData) {
  await run(f, "/positions", async () => {
    const { error } = await db()
      .from("positions")
      .update({ stream_id: str(f, "stream_id"), notes: opt(f, "notes") })
      .eq("id", str(f, "position_id"));
    if (error) throw new Error(error.message);
  });
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export async function saveSnapshotAction(f: FormData) {
  await run(f, "/snapshots", async () => {
    const { error } = await db()
      .from("snapshots")
      .upsert(
        {
          account_id: str(f, "account_id"),
          stream_id: opt(f, "stream_id"),
          as_of: str(f, "as_of"),
          total_value: n(f, "total_value"),
          cash: optN(f, "cash") ?? null,
          net_deposits: optN(f, "net_deposits") ?? 0,
          notes: opt(f, "notes"),
        },
        { onConflict: "account_id,stream_id,as_of" },
      );
    if (error) throw new Error(error.message);
    return "Snapshot saved";
  });
}

export async function deleteSnapshotAction(f: FormData) {
  await run(f, "/snapshots", async () => {
    const { error } = await db().from("snapshots").delete().eq("id", str(f, "id"));
    if (error) throw new Error(error.message);
    return "Snapshot deleted";
  });
}

// ---------------------------------------------------------------------------
// settings: accounts, streams, rules
// ---------------------------------------------------------------------------

export async function saveAccountAction(f: FormData) {
  await run(f, "/settings", async () => {
    const row = { name: str(f, "name"), broker_account_ref: opt(f, "broker_account_ref"), is_active: f.get("is_active") === "on" };
    const id = opt(f, "id");
    const { error } = id
      ? await db().from("accounts").update(row).eq("id", id)
      : await db().from("accounts").insert({ ...row, is_active: true });
    if (error) throw new Error(error.message);
    return `Account ${row.name} saved`;
  });
}

export async function saveStreamAction(f: FormData) {
  await run(f, "/settings", async () => {
    const name = str(f, "name");
    const row = {
      name,
      slug: str(f, "slug") || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      description: opt(f, "description"),
      color: opt(f, "color"),
      sort_order: optN(f, "sort_order") ?? 0,
      is_active: f.has("id") ? f.get("is_active") === "on" : true,
    };
    const id = opt(f, "id");
    const { error } = id
      ? await db().from("streams").update(row).eq("id", id)
      : await db().from("streams").insert(row);
    if (error) throw new Error(error.message);
    return `Stream ${name} saved`;
  });
}

export async function addRuleAction(f: FormData) {
  await run(f, "/settings", async () => {
    const { error } = await db()
      .from("stream_rules")
      .insert({
        stream_id: str(f, "stream_id"),
        account_id: opt(f, "account_id"),
        ticker: opt(f, "ticker")?.toUpperCase() ?? null,
        kind: opt(f, "kind"),
        priority: optN(f, "priority") ?? 50,
      });
    if (error) throw new Error(error.message);
    return "Rule added (applies to new positions)";
  });
}

export async function deleteRuleAction(f: FormData) {
  await run(f, "/settings", async () => {
    const { error } = await db().from("stream_rules").delete().eq("id", str(f, "id"));
    if (error) throw new Error(error.message);
    return "Rule removed";
  });
}

/** Re-run stream rules over existing positions (e.g. after adding a new stream). */
export async function reapplyRulesAction(f: FormData) {
  await run(f, "/settings", async () => {
    const client = db();
    const { data, error } = await client.from("positions").select("id, account_id, ticker, instrument, option_type");
    if (error) throw new Error(error.message);
    let changed = 0;
    for (const p of data ?? []) {
      const kind = p.instrument === "stock" ? "stock" : p.option_type;
      const { data: streamId } = await client.rpc("assign_stream", {
        p_account: p.account_id,
        p_ticker: p.ticker,
        p_kind: kind,
      });
      if (streamId) {
        const res = await client.from("positions").update({ stream_id: streamId }).eq("id", p.id).neq("stream_id", streamId).select("id");
        changed += res.data?.length ?? 0;
      }
    }
    return `Re-applied rules: ${changed} position(s) moved`;
  });
}
