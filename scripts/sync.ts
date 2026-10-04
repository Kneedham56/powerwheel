/**
 * Robinhood → PowerWheel sync.
 *
 * Claude (or anyone) pulls data with the Robinhood connector, puts the raw tool
 * responses in an import file (or points at the files the tools saved), and runs:
 *
 *   npm run sync -- status              # accounts, `since` date for the pull, what needs settling
 *   npm run sync -- import <file.json>  # import it
 *   npm run sync -- csv <report.csv> --account <name> [--dry-run]   # Robinhood account activity CSV
 *   npm run sync -- closes              # assigned options still missing the stock's expiry-day close
 *   npm run sync -- closes <file.json>  # fill them: {"AAOI": {"2026-10-02": 112.3}, ...}
 *
 * All interpretation (P&L row classification, expiration vs assignment, snapshots)
 * happens here, not in the prompt.
 *
 * Everything for an account is replayed in time order (orders, called-away shares,
 * share sales, expirations) so rolls, assignments and share lots line up.
 * Idempotent: every event carries a broker_ref, so re-importing is a no-op.
 * File format: see docs/SYNC.md.
 */
import "./env";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase";
import { applyEvents, planImport } from "../src/lib/csv-import";
import { assignTrade, closeTrade, expireTrade, openTrade } from "../src/lib/trades";

// ---------------------------------------------------------------------------
// input shapes
// ---------------------------------------------------------------------------

interface RhExecution {
  id: string;
  price: string;
  quantity: string;
  timestamp: string;
}

interface RhLeg {
  id: string;
  option_id: string;
  side: "buy" | "sell";
  position_effect: "open" | "close";
  expiration_date: string;
  strike_price: string;
  option_type: "put" | "call";
  executions: RhExecution[];
}

interface RhOrder {
  id: string;
  chain_symbol: string;
  state: string;
  created_at: string;
  legs: RhLeg[];
}

/** A row from get_pnl_trade_history, trimmed to what we use. */
interface PnlRow {
  timestamp: string;
  symbol: string;
  quantity: number | string;
  price: number | string;
}

/** get_pnl_trade_history row, as returned. */
interface RhPnlTrade extends PnlRow {
  side: string;
}

/** Tool responses may be passed whole ({ data: {...}, guide }) or unwrapped. */
type Raw<T> = T | { data: T };

interface AccountInput {
  account_ref: string;
  /** get_option_orders response(s) or their orders[] */
  orders?: Raw<{ orders: RhOrder[] }> | RhOrder[];
  /** paths to saved get_option_orders results */
  order_files?: string[];
  /** get_pnl_trade_history response, unchanged; classified into the lists below */
  pnl?: Raw<{ span?: string; trades: RhPnlTrade[] }>;
  /** paths to saved get_pnl_trade_history results */
  pnl_files?: string[];
  /** get_portfolio response, unchanged; becomes today's snapshot */
  portfolio?: Raw<RhPortfolio>;
  /** pnl rows with side "sell" and a positive price — shares sold */
  stock_sales?: PnlRow[];
  /** pnl rows at expiration with side "" and a positive price — shares called away by a CC */
  call_aways?: PnlRow[];
  /**
   * pnl rows with side "" and price 0 — contracts that expired worthless (date = ET expiration).
   * For options expiring on/after `expirations_from`, anything still open at expiration that
   * isn't covered by these rows is treated as assigned.
   */
  expirations?: { date: string; symbol: string; quantity: number }[];
  expirations_from?: string;
}

interface AssignRule {
  ticker: string;
  option_type: "put" | "call";
  strike: number;
  /** expiration window (inclusive) */
  from: string;
  to: string;
  account_ref?: string;
}

interface ImportFile {
  accounts?: AccountInput[];
  /** explicit settlements for specific contracts */
  events?: { account_ref: string; option_id: string; type: "expire" | "assign"; date: string; quantity?: number }[];
  /**
   * Automatic settlement of options still open after expiration (expiration < before):
   * assigned if a call-away or an `assigned` rule matches, otherwise `default`.
   */
  settle?: { before: string; default: "expire" | "skip"; assigned?: AssignRule[] };
  /** stream = optional stream slug, to record capital allocated to a stream inside the account */
  snapshots?: { account_ref: string; stream?: string; as_of: string; total_value: number; cash?: number; net_deposits?: number }[];
}

interface RhPortfolio {
  total_value: string;
  equity_value?: string;
  cash?: string;
}

/**
 * Stream capital recorded from each account's portfolio on every sync:
 * stream slug → which account and which get_portfolio field.
 */
const STREAM_SNAPSHOTS: Record<string, { account: string; field: keyof RhPortfolio }> = {
  tesla: { account: "Joint", field: "equity_value" }, // the TSLA shares behind Tesla CC
  joint: { account: "Joint", field: "cash" }, // cash securing Joint CSPs
};

const SPAN_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, "3month": 90 };

function unwrap<T>(raw: Raw<T>): T {
  return raw && typeof raw === "object" && "data" in raw ? (raw as { data: T }).data : (raw as T);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Fill expirations / call_aways / stock_sales / expirations_from from raw P&L history:
 *   side "", price 0        → contract expired worthless
 *   side "", price > 0      → shares called away by a covered call at expiration
 *   side "sell", price > 0  → shares sold
 * Everything else (option buybacks and rolls) is already covered by the orders.
 */
function classifyPnl(group: AccountInput) {
  const responses = [
    ...(group.pnl ? [unwrap(group.pnl)] : []),
    ...(group.pnl_files ?? []).map((f) => unwrap(readJson<Raw<{ span?: string; trades: RhPnlTrade[] }>>(f))),
  ];
  if (!responses.length) return;

  group.expirations ??= [];
  group.call_aways ??= [];
  group.stock_sales ??= [];
  let from = "9999-12-31";
  const today = etDate(new Date().toISOString());

  for (const r of responses) {
    for (const t of r.trades ?? []) {
      const price = Number(t.price);
      const row = { timestamp: t.timestamp, symbol: t.symbol, quantity: Number(t.quantity), price };
      if (t.side === "" && price === 0) group.expirations.push({ date: etDate(t.timestamp), symbol: t.symbol, quantity: row.quantity });
      else if (t.side === "" && price > 0) group.call_aways.push(row);
      else if (t.side === "sell" && price > 0) group.stock_sales.push(row);
    }
    // P&L rows are authoritative for expirations inside the window the response covers
    const days = SPAN_DAYS[r.span ?? ""];
    const start = days
      ? addDays(today, -days)
      : (r.trades ?? []).map((t) => etDate(t.timestamp)).sort()[0] ?? today;
    if (start < from) from = start;
  }
  group.expirations_from ??= from;
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------

const log = { added: [] as string[], skipped: 0, warnings: [] as string[] };

type Db = SupabaseClient;

async function txnExists(db: Db, brokerRef: string) {
  const { data } = await db.from("transactions").select("id").eq("broker_ref", brokerRef).maybeSingle();
  return !!data;
}

interface OpenRow {
  id: string;
  open_quantity: number;
  ticker: string;
  option_type: "put" | "call" | null;
  strike: number | null;
  expiration: string | null;
  broker_ref: string | null;
}

async function openOptions(db: Db, accountId: string, filter: Partial<Record<"ticker" | "option_type" | "expiration" | "broker_ref", string>>) {
  let q = db
    .from("v_positions")
    .select("id, open_quantity, ticker, option_type, strike, expiration, broker_ref")
    .eq("account_id", accountId)
    .eq("instrument", "option")
    .eq("status", "open");
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { data, error } = await q.order("opened_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ ...r, open_quantity: Number(r.open_quantity), strike: Number(r.strike) })) as OpenRow[];
}

/** Oldest open position for a contract; falls back to contract details for hand-entered positions. */
async function findOpen(db: Db, accountId: string, order: RhOrder, leg: RhLeg) {
  const [byRef] = await openOptions(db, accountId, { broker_ref: leg.option_id });
  if (byRef) return byRef;
  const manual = (
    await openOptions(db, accountId, {
      ticker: order.chain_symbol,
      option_type: leg.option_type,
      expiration: leg.expiration_date,
    })
  ).find((p) => !p.broker_ref && p.strike === Number(leg.strike_price));
  if (manual) await db.from("positions").update({ broker_ref: leg.option_id }).eq("id", manual.id);
  return manual ?? null;
}

function fill(leg: RhLeg) {
  const qty = leg.executions.reduce((s, e) => s + Number(e.quantity), 0);
  const notional = leg.executions.reduce((s, e) => s + Number(e.quantity) * Number(e.price), 0);
  const ts = leg.executions.map((e) => e.timestamp).sort()[0];
  return { qty, price: qty ? Math.round((notional / qty) * 10000) / 10000 : 0, ts };
}

const etDate = (ts: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ts));

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

async function importOrder(db: Db, accountId: string, accountName: string, order: RhOrder) {
  // Only final states; a cancelled order can still carry partial fills.
  if (order.state !== "filled" && order.state !== "cancelled") return;
  const legs = order.legs.filter((l) => l.executions?.length);
  const closes = legs.filter((l) => l.position_effect === "close");
  const opens = legs.filter((l) => l.position_effect === "open");
  const isRoll = closes.length > 0 && opens.length > 0;
  const label = (l: RhLeg) =>
    `${accountName} ${order.chain_symbol} ${Number(l.strike_price)}${l.option_type[0].toUpperCase()} ${l.expiration_date}`;

  let rolledFrom: string | null = null;

  for (const leg of closes) {
    if (await txnExists(db, leg.id)) {
      log.skipped++;
      const { data } = await db.from("transactions").select("position_id").eq("broker_ref", leg.id).single();
      rolledFrom ??= data?.position_id ?? null;
      continue;
    }
    const f = fill(leg);
    // one order can close several lots of the same contract
    let remaining = f.qty;
    for (let i = 0; remaining > 0; i++) {
      const pos = await findOpen(db, accountId, order, leg);
      if (!pos) {
        log.warnings.push(
          `No open position to close ${remaining} of ${label(leg)} (order ${order.id}); opened before the synced history?`,
        );
        break;
      }
      const qty = Math.min(remaining, pos.open_quantity);
      await closeTrade(db, {
        positionId: pos.id,
        quantity: qty,
        price: f.price,
        date: f.ts,
        rollGroupId: isRoll ? order.id : null,
        brokerRef: i === 0 ? leg.id : `${leg.id}:${i}`,
        source: "sync",
      });
      rolledFrom ??= pos.id;
      remaining -= qty;
    }
    log.added.push(`${isRoll ? "roll close" : "buy back"} ${label(leg)} x${f.qty} @ ${f.price}`);
  }

  for (const leg of opens) {
    if (await txnExists(db, leg.id)) {
      log.skipped++;
      continue;
    }
    if (leg.side !== "sell") {
      log.warnings.push(`Skipped long option ${label(leg)} (buying to open isn't tracked)`);
      continue;
    }
    const f = fill(leg);
    await openTrade(db, {
      accountId,
      ticker: order.chain_symbol,
      kind: leg.option_type === "put" ? "CSP" : "CC",
      strike: Number(leg.strike_price),
      expiration: leg.expiration_date,
      quantity: f.qty,
      price: f.price,
      date: f.ts,
      rolledFromId: isRoll ? rolledFrom : null,
      rollGroupId: isRoll ? order.id : null,
      brokerRef: leg.id,
      positionBrokerRef: leg.option_id,
      source: "sync",
    });
    log.added.push(`${isRoll ? "roll open" : "sell"} ${label(leg)} x${f.qty} @ ${f.price}`);
  }

  if (isRoll) {
    const { error } = await db.rpc("merge_roll_chain", { p_roll_group: order.id });
    if (error) throw new Error(`merge_roll_chain: ${error.message}`);
  }
}

/** Shares called away at expiration → assign the matching open covered calls. */
async function importCallAway(db: Db, acct: Acct, row: PnlRow) {
  const date = etDate(row.timestamp);
  let contracts = Math.round(Number(row.quantity) / 100);
  const ccs = await openOptions(db, acct.id, { ticker: row.symbol, option_type: "call", expiration: date });
  if (!ccs.length) {
    log.warnings.push(`Call-away ${acct.name} ${row.symbol} ${row.quantity} sh on ${date}: no open covered call expiring that day`);
    return;
  }
  // prefer the strike closest to the realized price
  ccs.sort((a, b) => Math.abs(a.strike! - Number(row.price)) - Math.abs(b.strike! - Number(row.price)));
  for (const cc of ccs) {
    if (contracts <= 0) break;
    const qty = Math.min(contracts, cc.open_quantity);
    const ref = `callaway:${acct.ref}:${cc.id}:${date}`;
    if (await txnExists(db, ref)) {
      log.skipped++;
    } else {
      await assignTrade(db, { positionId: cc.id, date, quantity: qty, brokerRef: ref, source: "sync" });
      log.added.push(`called away ${acct.name} ${row.symbol} ${cc.strike}C x${qty} on ${date}`);
    }
    contracts -= qty;
  }
}

/** Shares sold → close open stock lots (from assignments) oldest first. */
async function importStockSale(db: Db, acct: Acct, row: PnlRow) {
  const ref = `stocksale:${acct.ref}:${row.symbol}:${row.timestamp}:${row.quantity}`;
  if (await txnExists(db, `${ref}:0`)) {
    log.skipped++;
    return;
  }
  const { data: lots } = await db
    .from("v_positions")
    .select("id, open_quantity")
    .eq("account_id", acct.id)
    .eq("ticker", row.symbol)
    .eq("instrument", "stock")
    .eq("status", "open")
    .order("opened_at");
  let remaining = Number(row.quantity);
  let i = 0;
  for (const lot of lots ?? []) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(lot.open_quantity));
    await closeTrade(db, {
      positionId: lot.id,
      quantity: take,
      price: Number(row.price),
      date: row.timestamp,
      brokerRef: `${ref}:${i++}`,
      source: "sync",
    });
    remaining -= take;
  }
  const matched = Number(row.quantity) - remaining;
  if (matched > 0) log.added.push(`sold ${acct.name} ${row.symbol} ${matched} sh @ ${Number(row.price).toFixed(2)}`);
  if (remaining > 0 && matched > 0) {
    log.warnings.push(`${acct.name} ${row.symbol}: sold ${row.quantity} sh but only ${matched} were tracked wheel shares`);
  }
}

interface Settleable {
  id: string;
  ticker: string;
  option_type: "put" | "call";
  strike: number;
  expiration: string;
  open_quantity: number;
}

/** Settle options that expired before `until` and are still open. */
async function settleExpired(db: Db, acct: Acct, until: string, file: ImportFile, input?: AccountInput) {
  const s = file.settle;
  if (!s) return;
  const cutoff = until < s.before ? until : s.before;
  const { data } = await db
    .from("v_positions")
    .select("id, ticker, option_type, strike, expiration, open_quantity")
    .eq("account_id", acct.id)
    .eq("instrument", "option")
    .eq("status", "open")
    .lt("expiration", cutoff)
    .order("opened_at");
  const rows = (data ?? []).map((p) => ({ ...p, strike: Number(p.strike), open_quantity: Number(p.open_quantity) })) as Settleable[];

  const usePnl = (p: Settleable) => !!input?.expirations && p.expiration >= (input.expirations_from ?? "");
  const groups = new Map<string, Settleable[]>();
  for (const p of rows.filter(usePnl)) groups.set(`${p.expiration}|${p.ticker}`, [...(groups.get(`${p.expiration}|${p.ticker}`) ?? []), p]);
  for (const [key, list] of groups) await settleFromPnl(db, acct, key, list, input!);

  for (const p of rows.filter((x) => !usePnl(x))) {
    const strike = Number(p.strike);
    const assigned = (s.assigned ?? []).some(
      (r) =>
        r.ticker === p.ticker &&
        r.option_type === p.option_type &&
        Math.abs(r.strike - strike) < 0.001 &&
        p.expiration >= r.from &&
        p.expiration <= r.to &&
        (!r.account_ref || r.account_ref === acct.ref),
    );
    const ref = `settle:${acct.ref}:${p.id}`;
    if (await txnExists(db, ref)) continue;
    const label = `${acct.name} ${p.ticker} ${strike}${p.option_type === "put" ? "P" : "C"} ${p.expiration}`;
    if (assigned) {
      await assignTrade(db, { positionId: p.id, date: p.expiration, brokerRef: ref, source: "sync" });
      log.added.push(`assigned ${label}`);
    } else if (s.default === "expire") {
      await expireTrade(db, { positionId: p.id, date: p.expiration, brokerRef: ref, source: "sync" });
      log.added.push(`expired ${label}`);
    }
  }
}

/**
 * One ticker's options for one expiration date. Robinhood reports one "expired" row per
 * contract (strike), so match rows to strike groups by quantity; whatever isn't covered
 * was assigned.
 */
async function settleFromPnl(db: Db, acct: Acct, key: string, list: Settleable[], input: AccountInput) {
  const [date, ticker] = key.split("|");
  const byContract = new Map<string, { positions: Settleable[]; left: number }>();
  for (const p of list) {
    const k = `${p.option_type}|${p.strike}`;
    const g = byContract.get(k) ?? { positions: [], left: 0 };
    g.positions.push(p);
    g.left += p.open_quantity;
    byContract.set(k, g);
  }

  const expireQty = new Map<string, number>();
  const pnlRows = (input.expirations ?? [])
    .filter((r) => r.date === date && r.symbol === ticker)
    .map((r) => r.quantity)
    .sort((a, b) => b - a);
  for (const rowQty of pnlRows) {
    let q = rowQty;
    const groups = [...byContract.values()].filter((g) => g.left > 0);
    const g =
      groups.find((x) => x.left === rowQty) ??
      groups.filter((x) => x.left >= rowQty).sort((a, b) => a.left - b.left)[0] ??
      groups.sort((a, b) => b.left - a.left)[0];
    if (!g) continue; // already settled on an earlier run
    for (const p of g.positions) {
      const room = p.open_quantity - (expireQty.get(p.id) ?? 0);
      const take = Math.min(room, q);
      if (take <= 0) continue;
      expireQty.set(p.id, (expireQty.get(p.id) ?? 0) + take);
      g.left -= take;
      q -= take;
      if (q <= 0) break;
    }
  }

  for (const p of list) {
    const label = `${acct.name} ${p.ticker} ${p.strike}${p.option_type === "put" ? "P" : "C"} ${p.expiration}`;
    const exp = expireQty.get(p.id) ?? 0;
    const asg = p.open_quantity - exp;
    if (exp > 0 && !(await txnExists(db, `settle:${acct.ref}:${p.id}`))) {
      await expireTrade(db, { positionId: p.id, date, quantity: exp, brokerRef: `settle:${acct.ref}:${p.id}`, source: "sync" });
      log.added.push(`expired ${label} x${exp}`);
    }
    if (asg > 0 && !(await txnExists(db, `settle-assign:${acct.ref}:${p.id}`))) {
      await assignTrade(db, { positionId: p.id, date, quantity: asg, brokerRef: `settle-assign:${acct.ref}:${p.id}`, source: "sync" });
      log.added.push(`assigned ${label} x${asg}`);
    }
  }
}

// ---------------------------------------------------------------------------

interface Acct {
  id: string;
  name: string;
  ref: string;
}

type Item =
  | { at: string; kind: "order"; order: RhOrder }
  | { at: string; kind: "callaway"; row: PnlRow }
  | { at: string; kind: "sale"; row: PnlRow };

async function importFile(path: string) {
  const db = createAdminClient();
  const file = readJson<ImportFile>(path);
  const today = etDate(new Date().toISOString());
  // default: settle anything that expired before today, using the P&L rows when present
  file.settle ??= { before: today, default: "skip" };
  file.snapshots ??= [];

  const { data: accts, error } = await db.from("accounts").select("id, name, broker_account_ref");
  if (error) throw new Error(error.message);
  const byRef = new Map<string, Acct>();
  for (const a of accts ?? []) if (a.broker_account_ref) byRef.set(a.broker_account_ref, { id: a.id, name: a.name, ref: a.broker_account_ref });
  const acct = (ref: string) => {
    const a = byRef.get(ref);
    if (!a) throw new Error(`Unknown account_ref ${ref}. Set it on the Settings page (Broker account #).`);
    return a;
  };

  for (const group of file.accounts ?? []) {
    const a = acct(group.account_ref);
    const ordersOf = (raw: unknown): RhOrder[] =>
      Array.isArray(raw) ? raw : (unwrap(raw as Raw<{ orders: RhOrder[] }>)?.orders ?? []);
    const orders = [...ordersOf(group.orders ?? []), ...(group.order_files ?? []).flatMap((f) => ordersOf(readJson(f)))];
    classifyPnl(group);

    if (group.portfolio) {
      const p = unwrap(group.portfolio);
      file.snapshots.push({ account_ref: group.account_ref, as_of: today, total_value: Number(p.total_value), cash: p.cash ? Number(p.cash) : undefined });
      for (const [slug, s] of Object.entries(STREAM_SNAPSHOTS)) {
        if (s.account === a.name && p[s.field] !== undefined) {
          file.snapshots.push({ account_ref: group.account_ref, stream: slug, as_of: today, total_value: Number(p[s.field]) });
        }
      }
    }
    const items: Item[] = [
      ...orders.map((o) => ({ at: o.created_at, kind: "order" as const, order: o })),
      ...(group.call_aways ?? []).map((row) => ({ at: row.timestamp, kind: "callaway" as const, row })),
      ...(group.stock_sales ?? []).map((row) => ({ at: row.timestamp, kind: "sale" as const, row })),
    ].sort((x, y) => x.at.localeCompare(y.at));

    console.log(`${a.name}: replaying ${items.length} item(s)...`);
    let lastDay = "";
    for (const it of items) {
      // settle everything that expired before today's events
      const day = etDate(it.at);
      if (day !== lastDay) {
        await settleExpired(db, a, day, file, group);
        lastDay = day;
      }
      if (it.kind === "order") await importOrder(db, a.id, a.name, it.order);
      else if (it.kind === "callaway") await importCallAway(db, a, it.row);
      else await importStockSale(db, a, it.row);
    }
    // final settlement: call-aways at 4pm on expiration day were already applied
    if (file.settle) await settleExpired(db, a, file.settle.before, file, group);
  }

  for (const ev of file.events ?? []) {
    const a = acct(ev.account_ref);
    const ref = `${ev.type}:${ev.account_ref}:${ev.option_id}:${ev.date}`;
    if (await txnExists(db, ref)) {
      log.skipped++;
      continue;
    }
    const [pos] = await openOptions(db, a.id, { broker_ref: ev.option_id });
    if (!pos) {
      log.warnings.push(`No open position for ${ev.type} event on option ${ev.option_id} (${a.name})`);
      continue;
    }
    const args = { positionId: pos.id, date: ev.date, quantity: ev.quantity, brokerRef: ref, source: "sync" as const };
    if (ev.type === "expire") await expireTrade(db, args);
    else await assignTrade(db, args);
    log.added.push(`${ev.type} ${a.name} ${pos.ticker} ${pos.strike}${pos.option_type === "put" ? "P" : "C"} ${pos.expiration}`);
  }

  const { data: streamRows } = await db.from("streams").select("id, slug");
  const streamId = new Map((streamRows ?? []).map((r) => [r.slug as string, r.id as string]));
  for (const s of file.snapshots ?? []) {
    const a = acct(s.account_ref);
    if (s.stream && !streamId.has(s.stream)) throw new Error(`Unknown stream slug ${s.stream}`);
    const { error: e } = await db.from("snapshots").upsert(
      {
        account_id: a.id,
        stream_id: s.stream ? streamId.get(s.stream) : null,
        as_of: s.as_of,
        total_value: s.total_value,
        cash: s.cash ?? null,
        net_deposits: s.net_deposits ?? 0,
        source: "sync",
      },
      { onConflict: "account_id,stream_id,as_of" },
    );
    if (e) throw new Error(`snapshot: ${e.message}`);
    log.added.push(`snapshot ${a.name}${s.stream ? ` [${s.stream}]` : ""} ${s.as_of} = ${s.total_value}`);
  }

  const verbose = process.argv.includes("--verbose");
  console.log(`\nImported ${log.added.length} item(s), skipped ${log.skipped} already-synced.`);
  for (const l of verbose || log.added.length <= 60 ? log.added : log.added.slice(-60)) console.log("  +", l);
  if (!verbose && log.added.length > 60) console.log(`  ... (${log.added.length - 60} earlier items, --verbose to show all)`);
  if (log.warnings.length) {
    console.log(`\n${log.warnings.length} warning(s):`);
    for (const w of log.warnings) console.log("  !", w);
  }
}

async function status() {
  const db = createAdminClient();
  const today = etDate(new Date().toISOString());
  const { data: accounts } = await db.from("accounts").select("id, name, broker_account_ref").eq("is_active", true);

  for (const a of accounts ?? []) {
    const { data: last } = await db
      .from("v_transactions")
      .select("occurred_at")
      .eq("account_id", a.id)
      .eq("source", "sync")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: snap } = await db
      .from("snapshots")
      .select("as_of")
      .eq("account_id", a.id)
      .is("stream_id", null)
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    // pull from a few days before the last synced event; overlap is skipped on import
    const since = last?.occurred_at ? addDays(etDate(last.occurred_at), -3) : "2025-10-01";
    console.log(
      `${a.name.padEnd(12)} account_ref=${a.broker_account_ref ?? "(not set!)"}  since=${since}  last synced event=${last?.occurred_at ?? "never"}  last snapshot=${snap?.as_of ?? "never"}`,
    );
  }

  const { data: stale } = await db
    .from("v_positions")
    .select("account_id, ticker, option_type, strike, expiration, open_quantity, broker_ref")
    .eq("status", "open")
    .eq("instrument", "option")
    .lt("expiration", today)
    .order("expiration");
  const refs = new Map((accounts ?? []).map((a) => [a.id, a.broker_account_ref]));

  console.log(`\nOpen options past expiration (need settling): ${stale?.length ?? 0}`);
  for (const p of stale ?? []) {
    console.log(
      JSON.stringify({
        account_ref: refs.get(p.account_id),
        option_id: p.broker_ref,
        ticker: p.ticker,
        option_type: p.option_type,
        strike: Number(p.strike),
        expiration: p.expiration,
        open_quantity: Number(p.open_quantity),
      }),
    );
  }
}

/**
 * Win/loss reporting marks an assigned option against where the stock closed on expiration day.
 * With no file, lists what's missing; with a file of closes, fills it in.
 */
async function closes(file?: string) {
  const db = createAdminClient();
  const { data } = await db
    .from("positions")
    .select("id, ticker, expiration")
    .eq("instrument", "option")
    .eq("status", "assigned")
    .is("underlying_close", null);
  const rows = data ?? [];
  if (!file) {
    const need = [...new Set(rows.map((r) => `${r.ticker} ${r.expiration}`))].sort();
    console.log(`Assigned options missing an expiry close: ${rows.length} (${need.length} ticker/date pairs)`);
    for (const n of need) console.log("  ", n);
    return;
  }
  const px = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, number>>;
  let filled = 0;
  const missing = new Set<string>();
  for (const r of rows) {
    const close = px[r.ticker]?.[r.expiration];
    if (close === undefined) {
      missing.add(`${r.ticker} ${r.expiration}`);
      continue;
    }
    const { error } = await db.from("positions").update({ underlying_close: close }).eq("id", r.id);
    if (error) throw new Error(`update ${r.ticker} ${r.expiration}: ${error.message}`);
    filled++;
  }
  console.log(`Filled ${filled} of ${rows.length}.`);
  if (missing.size) console.log(`Still missing: ${[...missing].sort().join(", ")}`);
}

/** Import a Robinhood account activity report (see lib/csv-import.ts). --dry-run only prints the plan. */
async function csvImport(file: string) {
  const args = process.argv.slice(2);
  const accountName = args[args.indexOf("--account") + 1];
  const plan = planImport(readFileSync(file, "utf8"));
  console.log(`${plan.range?.from} → ${plan.range?.to}: ${plan.events.length} events`, plan.stats);
  console.log("not tracked:", plan.ignored);
  for (const w of plan.warnings.slice(0, 20)) console.log("  !", w);
  if (args.includes("--dry-run")) return;
  if (!args.includes("--account") || !accountName) throw new Error("usage: sync csv <file> --account <name> [--dry-run]");
  const db = createAdminClient();
  const { data: acct } = await db.from("accounts").select("id").eq("name", accountName).maybeSingle();
  if (!acct) throw new Error(`No account named "${accountName}" (Settings → Accounts)`);
  const t0 = Date.now();
  let cursor: number | null = 0;
  let applied = 0;
  let skipped = 0;
  const warnings: string[] = [];
  while (cursor !== null) {
    const r = await applyEvents(db, acct.id, plan.events, cursor, 25_000);
    applied += r.applied;
    skipped += r.skipped;
    warnings.push(...r.warnings);
    cursor = r.next;
    console.log(`  ${cursor ?? plan.events.length}/${plan.events.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  console.log(`Imported ${applied} event(s), skipped ${skipped} already-imported.`);
  for (const w of warnings.slice(0, 40)) console.log("  !", w);
}

const [cmd, arg] = process.argv.slice(2);
(cmd === "import" && arg ? importFile(arg) : cmd === "status" ? status() : cmd === "closes" ? closes(arg) : cmd === "csv" && arg ? csvImport(arg) : Promise.reject(new Error("usage: sync status | sync import <file.json> [--verbose] | sync closes [file.json] | sync csv <file.csv> --account <name> [--dry-run]")))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
