/**
 * Trade lifecycle operations. Shared by the web app (server actions) and the
 * sync/import scripts, so this file must not import anything Next.js-specific.
 *
 * Cash-flow math and position status live in the database triggers
 * (see supabase/migrations/0001_tracking.sql); these functions only record events.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Source, TxnAction } from "./types";

export type OpenKind = "CSP" | "CC" | "STOCK";

/** "2026-08-07" → noon UTC so the calendar day is the same in every US timezone. */
export function toTimestamp(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00Z` : date;
}

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: no data`);
  return res.data;
}

interface PositionCore {
  id: string;
  account_id: string;
  stream_id: string;
  instrument: "option" | "stock";
  ticker: string;
  option_type: "put" | "call" | null;
  side: "short" | "long";
  strike: number | null;
  expiration: string | null;
  status: string;
  chain_id: string;
  open_quantity: number;
}

export async function getPosition(db: SupabaseClient, id: string): Promise<PositionCore> {
  return must(
    await db
      .from("v_positions")
      .select("id, account_id, stream_id, instrument, ticker, option_type, side, strike, expiration, status, chain_id, open_quantity")
      .eq("id", id)
      .single(),
    "load position",
  );
}

async function insertTxn(
  db: SupabaseClient,
  t: {
    position_id: string;
    occurred_at: string;
    action: TxnAction;
    quantity: number;
    price?: number;
    fees?: number;
    roll_group_id?: string | null;
    broker_ref?: string | null;
    source?: Source;
    notes?: string | null;
  },
) {
  must(
    await db
      .from("transactions")
      .insert({
        price: 0,
        fees: 0,
        source: "manual",
        ...t,
        occurred_at: toTimestamp(t.occurred_at),
      })
      .select("id")
      .single(),
    `record ${t.action}`,
  );
}

// ---------------------------------------------------------------------------

export interface OpenInput {
  accountId: string;
  streamId?: string | null; // null → stream rules decide
  ticker: string;
  kind: OpenKind;
  strike?: number | null;
  expiration?: string | null;
  quantity: number; // contracts, or shares for STOCK
  price: number; // premium per share, or share price
  fees?: number;
  date: string;
  notes?: string | null;
  rolledFromId?: string | null;
  rollGroupId?: string | null;
  brokerRef?: string | null; // transaction-level idempotency key
  positionBrokerRef?: string | null;
  source?: Source;
}

export async function openTrade(db: SupabaseClient, input: OpenInput): Promise<string> {
  const isStock = input.kind === "STOCK";
  if (!isStock && (!input.strike || !input.expiration)) {
    throw new Error("Options need a strike and expiration");
  }

  const position = must(
    await db
      .from("positions")
      .insert({
        account_id: input.accountId,
        stream_id: input.streamId || null,
        instrument: isStock ? "stock" : "option",
        ticker: input.ticker,
        option_type: isStock ? null : input.kind === "CSP" ? "put" : "call",
        side: isStock ? "long" : "short",
        strike: isStock ? null : input.strike,
        expiration: isStock ? null : input.expiration,
        opened_at: toTimestamp(input.date),
        rolled_from_id: input.rolledFromId ?? null,
        broker_ref: input.positionBrokerRef ?? null,
        notes: input.notes ?? null,
      })
      .select("id")
      .single(),
    "create position",
  ) as { id: string };

  await insertTxn(db, {
    position_id: position.id,
    occurred_at: input.date,
    action: isStock ? "buy" : "sell_to_open",
    quantity: input.quantity,
    price: input.price,
    fees: input.fees ?? 0,
    roll_group_id: input.rollGroupId ?? null,
    broker_ref: input.brokerRef ?? null,
    source: input.source,
    notes: input.rolledFromId ? null : input.notes,
  });

  return position.id;
}

export interface CloseInput {
  positionId: string;
  quantity?: number; // default: everything still open
  price: number; // per share paid to buy back (or received selling stock)
  fees?: number;
  date: string;
  notes?: string | null;
  rollGroupId?: string | null;
  brokerRef?: string | null;
  source?: Source;
}

/** Buy back a short option early (or sell a stock lot). */
export async function closeTrade(db: SupabaseClient, input: CloseInput) {
  const p = await getPosition(db, input.positionId);
  const qty = input.quantity ?? p.open_quantity;
  if (qty <= 0) throw new Error("Nothing open on this position");

  const action: TxnAction =
    p.instrument === "stock" ? "sell" : p.side === "short" ? "buy_to_close" : "sell_to_close";

  await insertTxn(db, {
    position_id: p.id,
    occurred_at: input.date,
    action,
    quantity: qty,
    price: input.price,
    fees: input.fees ?? 0,
    roll_group_id: input.rollGroupId ?? null,
    broker_ref: input.brokerRef ?? null,
    source: input.source,
    notes: input.notes,
  });
}

/** Option expired worthless — keep the full premium. */
export async function expireTrade(
  db: SupabaseClient,
  input: { positionId: string; date?: string; quantity?: number; brokerRef?: string | null; source?: Source },
) {
  const p = await getPosition(db, input.positionId);
  if (p.instrument !== "option") throw new Error("Only options expire");
  const qty = input.quantity ?? p.open_quantity;
  if (qty <= 0) throw new Error("Nothing open on this position");

  await insertTxn(db, {
    position_id: p.id,
    occurred_at: input.date ?? p.expiration!,
    action: "expire",
    quantity: qty,
    broker_ref: input.brokerRef ?? null,
    source: input.source,
  });
}

/**
 * Option assigned.
 *  - CSP: records the assignment and opens a stock lot (bought at the strike).
 *  - CC:  records the assignment and sells shares at the strike from the oldest
 *         open stock lot for the same account/ticker, if one is tracked.
 */
export async function assignTrade(
  db: SupabaseClient,
  input: {
    positionId: string;
    date?: string;
    quantity?: number;
    fees?: number;
    brokerRef?: string | null;
    source?: Source;
    /** stock close on expiration day, used to judge the trade in win/loss reporting */
    underlyingClose?: number;
  },
): Promise<{ stockPositionId: string | null }> {
  const p = await getPosition(db, input.positionId);
  if (p.instrument !== "option") throw new Error("Only options get assigned");
  const qty = input.quantity ?? p.open_quantity;
  if (qty <= 0) throw new Error("Nothing open on this position");
  const date = input.date ?? p.expiration!;
  const shares = qty * 100;

  await insertTxn(db, {
    position_id: p.id,
    occurred_at: date,
    action: "assign",
    quantity: qty,
    broker_ref: input.brokerRef ?? null,
    source: input.source,
  });
  if (input.underlyingClose !== undefined) {
    must(await db.from("positions").update({ underlying_close: input.underlyingClose }).eq("id", p.id), "record expiry close");
  }

  if (p.option_type === "put") {
    const stock = must(
      await db
        .from("positions")
        .insert({
          account_id: p.account_id,
          instrument: "stock",
          ticker: p.ticker,
          side: "long",
          opened_at: toTimestamp(date),
          assigned_from_id: p.id,
          notes: `Assigned from ${p.ticker} ${p.strike}P ${p.expiration}`,
        })
        .select("id")
        .single(),
      "create stock lot",
    ) as { id: string };
    await insertTxn(db, {
      position_id: stock.id,
      occurred_at: date,
      action: "buy",
      quantity: shares,
      price: p.strike!,
      fees: input.fees ?? 0,
      broker_ref: input.brokerRef ? `${input.brokerRef}:stock` : null,
      source: input.source,
    });
    return { stockPositionId: stock.id };
  }

  // Covered call called away.
  const { data: lots } = await db
    .from("v_positions")
    .select("id, open_quantity")
    .eq("account_id", p.account_id)
    .eq("ticker", p.ticker)
    .eq("instrument", "stock")
    .eq("status", "open")
    .order("opened_at");

  let remaining = shares;
  let firstLot: string | null = null;
  for (const lot of (lots ?? []) as { id: string; open_quantity: number }[]) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(lot.open_quantity));
    if (take <= 0) continue;
    await insertTxn(db, {
      position_id: lot.id,
      occurred_at: date,
      action: "sell",
      quantity: take,
      price: p.strike!,
      fees: firstLot ? 0 : input.fees ?? 0,
      broker_ref: input.brokerRef ? `${input.brokerRef}:stock:${lot.id}` : null,
      source: input.source,
    });
    firstLot ??= lot.id;
    remaining -= take;
  }
  return { stockPositionId: firstLot };
}

export interface RollInput {
  positionId: string;
  quantity?: number; // contracts rolled; default all open
  closePrice: number; // per share paid to buy back the old leg
  newStrike: number;
  newExpiration: string;
  newPrice: number; // per share collected on the new leg
  newQuantity?: number; // default same as quantity
  fees?: number;
  date: string;
  notes?: string | null;
  closeBrokerRef?: string | null;
  openBrokerRef?: string | null;
  source?: Source;
}

/** Buy back the current leg and sell a new one, linked as one chain. Returns the new position id. */
export async function rollTrade(db: SupabaseClient, input: RollInput): Promise<string> {
  const p = await getPosition(db, input.positionId);
  if (p.instrument !== "option" || p.side !== "short") throw new Error("Only short options can be rolled");
  const qty = input.quantity ?? p.open_quantity;
  const rollGroupId = crypto.randomUUID();

  await closeTrade(db, {
    positionId: p.id,
    quantity: qty,
    price: input.closePrice,
    fees: input.fees ?? 0,
    date: input.date,
    rollGroupId,
    brokerRef: input.closeBrokerRef,
    source: input.source,
    notes: input.notes,
  });

  return openTrade(db, {
    accountId: p.account_id,
    streamId: p.stream_id,
    ticker: p.ticker,
    kind: p.option_type === "put" ? "CSP" : "CC",
    strike: input.newStrike,
    expiration: input.newExpiration,
    quantity: input.newQuantity ?? qty,
    price: input.newPrice,
    date: input.date,
    rolledFromId: p.id,
    rollGroupId,
    brokerRef: input.openBrokerRef,
    source: input.source,
  });
}

/** Remove a position and all its transactions (for fixing mistakes). */
export async function deletePosition(db: SupabaseClient, positionId: string) {
  const { error } = await db.from("positions").delete().eq("id", positionId);
  if (error) throw new Error(`delete position: ${error.message}`);
}
