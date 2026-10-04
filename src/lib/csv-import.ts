/**
 * Robinhood "Account activity report" CSV → PowerWheel.
 *
 * Two halves, both free of Next.js imports (the web app and `npm run sync -- csv` share them):
 *  - planImport(): pure. Parses the CSV and turns it into an ordered list of events, guessing
 *    rolls, and replays them against an in-memory book to find rows that can't be matched.
 *  - applyEvents(): writes events to the database through trades.ts, so every cash-flow rule
 *    still lives in the DB triggers.
 *
 * What the CSV has: STO (sell to open), BTC (buy to close), OEXP (expired), OASGN (assigned),
 * stock Buy/Sell rows, and cash rows. What it lacks vs. the order API: order ids, so rolls are
 * guessed (same day + ticker + type, one contract closed and a different one opened, same size).
 * Cash rows (interest, margin interest, deposits) and share buys that didn't come from an
 * assignment aren't tracked, same as the Robinhood sync.
 *
 * Idempotent: each row gets a ref from its contents (plus an occurrence number for identical
 * rows), stored in transactions.broker_ref, so uploading overlapping reports is a no-op.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assignTrade, closeTrade, expireTrade, openTrade } from "./trades";

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface CsvRow {
  date: string; // YYYY-MM-DD (activity date)
  code: string;
  instrument: string;
  description: string;
  quantity: number;
  price: number;
  amount: number;
  /** stable id for idempotency: content hash + occurrence number among identical rows */
  ref: string;
}

function money(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  const v = Number(t.replace(/[()$,]/g, ""));
  return t.startsWith("(") ? -v : v;
}

function usDate(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

export function parseRows(text: string): { rows: CsvRow[]; skipped: number } {
  const table = parseCsv(text);
  const head = table.findIndex((r) => r.includes("Trans Code") && r.includes("Activity Date"));
  if (head < 0) throw new Error("This doesn't look like a Robinhood account activity report (no Trans Code column).");
  const col = Object.fromEntries(table[head].map((h, i) => [h.trim(), i]));
  const seen = new Map<string, number>();
  const rows: CsvRow[] = [];
  let skipped = 0;
  for (const r of table.slice(head + 1)) {
    const date = usDate(r[col["Activity Date"]] ?? "");
    const code = (r[col["Trans Code"]] ?? "").trim();
    if (!date || !code) {
      if (r.some((c) => c.trim())) skipped++; // trailing disclaimer lines
      continue;
    }
    const base = [date, code, r[col["Instrument"]], r[col["Description"]], r[col["Quantity"]], r[col["Price"]], r[col["Amount"]]].join("|");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    rows.push({
      date,
      code,
      instrument: (r[col["Instrument"]] ?? "").trim(),
      description: (r[col["Description"]] ?? "").replace(/\s+/g, " ").trim(),
      quantity: Number((r[col["Quantity"]] ?? "").replace(/[^\d.-]/g, "")) || 0,
      price: money(r[col["Price"]] ?? ""),
      amount: money(r[col["Amount"]] ?? ""),
      ref: `csv:${createHash("sha1").update(base).digest("hex").slice(0, 20)}:${n}`,
    });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

export interface Contract {
  ticker: string;
  type: "put" | "call";
  expiration: string;
  strike: number;
}

const key = (c: Contract) => `${c.ticker}|${c.type}|${c.expiration}|${c.strike}`;
const label = (c: Contract) => `${c.ticker} ${c.strike}${c.type === "put" ? "P" : "C"} ${c.expiration}`;

const OPTION_RE = /^(?:Option Expiration for )?(\S+) (\d{1,2}\/\d{1,2}\/\d{4}) (Put|Call) \$([\d,.]+)$/;

function contractOf(row: CsvRow): Contract | null {
  const m = OPTION_RE.exec(row.description);
  const expiration = m && usDate(m[2]);
  if (!m || !expiration) return null;
  return { ticker: m[1], type: m[3] === "Put" ? "put" : "call", expiration, strike: Number(m[4].replace(/,/g, "")) };
}

/**
 * Fees = the gap between the quoted price and the cash that actually moved: a sell receives
 * less than price × size, a buy pays more. Never negative (the quoted price is rounded).
 */
function feesOf(row: CsvRow): number {
  const gross = row.price * row.quantity * 100;
  const gap = row.code === "STO" ? gross - row.amount : Math.abs(row.amount) - gross;
  return Math.max(0, Math.round(gap * 100) / 100);
}

export interface Leg {
  ref: string;
  date: string;
  contract: Contract;
  quantity: number;
  price: number;
  fees: number;
}

export type PlanEvent =
  | { kind: "open"; date: string; leg: Leg }
  | { kind: "close"; date: string; leg: Leg }
  | { kind: "roll"; date: string; id: string; closes: Leg[]; opens: Leg[] }
  | { kind: "expire"; date: string; ref: string; contract: Contract; quantity: number }
  | { kind: "assign"; date: string; ref: string; contract: Contract; quantity: number }
  | { kind: "sell_shares"; date: string; ref: string; ticker: string; quantity: number; price: number; fees: number };

export interface Plan {
  events: PlanEvent[];
  warnings: string[];
  stats: Record<string, number>;
  ignored: Record<string, number>;
  range: { from: string; to: string } | null;
}

/** deterministic uuid so a re-import produces the same roll group id */
function uuidFrom(s: string) {
  const h = createHash("sha1").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function planImport(text: string): Plan {
  const { rows, skipped } = parseRows(text);
  const warnings: string[] = [];
  const ignored: Record<string, number> = {};
  const ignore = (why: string) => (ignored[why] = (ignored[why] ?? 0) + 1);
  if (skipped) ignored["footer / blank lines"] = skipped;

  interface Dated {
    opens: Leg[];
    closes: Leg[];
    others: PlanEvent[];
  }
  const byDate = new Map<string, Dated>();
  const day = (d: string) => {
    if (!byDate.has(d)) byDate.set(d, { opens: [], closes: [], others: [] });
    return byDate.get(d)!;
  };

  for (const r of rows) {
    const c = contractOf(r);
    switch (r.code) {
      case "STO":
      case "BTC": {
        if (!c) {
          warnings.push(`Couldn't read the contract in "${r.description}" (${r.date})`);
          break;
        }
        const leg: Leg = { ref: r.ref, date: r.date, contract: c, quantity: r.quantity, price: r.price, fees: feesOf(r) };
        (r.code === "STO" ? day(r.date).opens : day(r.date).closes).push(leg);
        break;
      }
      case "OEXP":
      case "OASGN":
        if (!c) warnings.push(`Couldn't read the contract in "${r.description}" (${r.date})`);
        else
          day(r.date).others.push({
            kind: r.code === "OEXP" ? "expire" : "assign",
            date: r.date,
            ref: r.ref,
            contract: c,
            quantity: r.quantity,
          });
        break;
      case "Sell":
        if (/Option Assigned|Options Assigned/i.test(r.description)) break; // called away: handled by the OASGN row
        day(r.date).others.push({
          kind: "sell_shares",
          date: r.date,
          ref: r.ref,
          ticker: r.instrument,
          quantity: r.quantity,
          price: r.price,
          fees: Math.max(0, Math.round((r.price * r.quantity - r.amount) * 100) / 100),
        });
        break;
      case "Buy":
        if (!/Option Assigned|Options Assigned/i.test(r.description)) ignore("share purchases (only shares from assignments are tracked)");
        break;
      case "INT":
      case "MINT":
      case "GOLD":
      case "SLIP":
      case "ACH":
        ignore(`cash rows (${r.code})`);
        break;
      default:
        ignore(`other (${r.code})`);
    }
  }

  const events: PlanEvent[] = [];
  const rollCount = { n: 0 };
  for (const date of [...byDate.keys()].sort()) {
    const d = byDate.get(date)!;
    const { rolls, opens, closes } = pairRolls(date, mergeFills(d.opens), mergeFills(d.closes));
    rollCount.n += rolls.length;
    for (const o of opens) events.push({ kind: "open", date, leg: o });
    events.push(...rolls);
    for (const c of closes) events.push({ kind: "close", date, leg: c });
    // expirations before assignments keeps a mixed day deterministic; both only touch what's open
    events.push(...d.others.filter((e) => e.kind === "expire"), ...d.others.filter((e) => e.kind === "assign"), ...d.others.filter((e) => e.kind === "sell_shares"));
  }

  // replay against an in-memory book to flag rows with nothing to act on
  const book = new Map<string, number>();
  const shares = new Map<string, number>();
  const take = (k: string, q: number) => {
    const have = book.get(k) ?? 0;
    book.set(k, Math.max(0, have - q));
    return Math.max(0, q - have);
  };
  const stats: Record<string, number> = { opened: 0, boughtBack: 0, expired: 0, assigned: 0, rolls: rollCount.n, sharesSold: 0 };
  let premium = 0;
  const openLeg = (l: Leg) => {
    book.set(key(l.contract), (book.get(key(l.contract)) ?? 0) + l.quantity);
    stats.opened += l.quantity;
    premium += l.price * l.quantity * 100 - l.fees;
  };
  const closeLeg = (l: Leg) => {
    const miss = take(key(l.contract), l.quantity);
    if (miss) warnings.push(`${l.date}: bought back ${l.quantity} ${label(l.contract)} but only ${l.quantity - miss} were open (opened before this report starts?)`);
    stats.boughtBack += l.quantity;
    premium -= l.price * l.quantity * 100 + l.fees;
  };
  for (const e of events) {
    if (e.kind === "open") openLeg(e.leg);
    else if (e.kind === "close") closeLeg(e.leg);
    else if (e.kind === "roll") {
      e.closes.forEach(closeLeg);
      e.opens.forEach(openLeg);
    } else if (e.kind === "expire" || e.kind === "assign") {
      const miss = take(key(e.contract), e.quantity);
      if (miss) warnings.push(`${e.date}: ${e.kind === "expire" ? "expiration" : "assignment"} of ${e.quantity} ${label(e.contract)} but only ${e.quantity - miss} were open (opened before this report starts?)`);
      stats[e.kind === "expire" ? "expired" : "assigned"] += e.quantity;
      if (e.kind === "assign") shares.set(e.contract.ticker, (shares.get(e.contract.ticker) ?? 0) + (e.contract.type === "put" ? 1 : -1) * e.quantity * 100);
    } else {
      const have = shares.get(e.ticker) ?? 0;
      const used = Math.min(have, e.quantity);
      shares.set(e.ticker, have - used);
      stats.sharesSold += used;
      if (used < e.quantity) ignore("share sales not from assignments");
    }
  }
  stats.premiumNet = Math.round(premium * 100) / 100;

  const dates = [...byDate.keys()].sort();
  return { events, warnings, stats, ignored, range: dates.length ? { from: dates[0], to: dates.at(-1)! } : null };
}

/**
 * The CSV has one row per fill; the order data has one leg per order. Fills of the same
 * contract on the same day become one leg (summed size, weighted price), so a 20-lot order
 * filled in five pieces is one trade, not five. Its ref is the first fill's, which stays
 * stable when overlapping reports are uploaded.
 */
function mergeFills(legs: Leg[]): Leg[] {
  const m = new Map<string, Leg[]>();
  for (const l of legs) m.set(key(l.contract), [...(m.get(key(l.contract)) ?? []), l]);
  return [...m.values()].map((ls) => {
    const quantity = ls.reduce((a, l) => a + l.quantity, 0);
    const notional = ls.reduce((a, l) => a + l.price * l.quantity, 0);
    return {
      ...ls[0],
      quantity,
      price: quantity ? Math.round((notional / quantity) * 10000) / 10000 : 0,
      fees: Math.round(ls.reduce((a, l) => a + l.fees, 0) * 100) / 100,
    };
  });
}

/**
 * Same day, same ticker and type: a contract closed and a *different* contract opened, same
 * size → one roll. Anything unpaired stays a plain open / buyback (including a round trip on
 * the same contract).
 */
function pairRolls(date: string, opens: Leg[], closes: Leg[]) {
  const rolls: Extract<PlanEvent, { kind: "roll" }>[] = [];
  const keep = { opens: new Set(opens), closes: new Set(closes) };
  const group = (legs: Leg[]) => {
    const m = new Map<string, Leg[]>(); // contract key → legs
    for (const l of legs) m.set(key(l.contract), [...(m.get(key(l.contract)) ?? []), l]);
    return [...m.values()];
  };
  const qty = (ls: Leg[]) => ls.reduce((s, l) => s + l.quantity, 0);
  const openGroups = group(opens);
  const used = new Set<Leg[]>();
  for (const cg of group(closes)) {
    const c = cg[0].contract;
    const match = openGroups.find((og) => {
      const o = og[0].contract;
      return (
        !used.has(og) &&
        o.ticker === c.ticker &&
        o.type === c.type &&
        key(o) !== key(c) &&
        o.expiration >= c.expiration &&
        qty(og) === qty(cg)
      );
    });
    if (!match) continue;
    used.add(match);
    cg.forEach((l) => keep.closes.delete(l));
    match.forEach((l) => keep.opens.delete(l));
    rolls.push({ kind: "roll", date, id: uuidFrom(`roll:${cg[0].ref}`), closes: cg, opens: match });
  }
  return { rolls, opens: opens.filter((l) => keep.opens.has(l)), closes: closes.filter((l) => keep.closes.has(l)) };
}

// ---------------------------------------------------------------------------
// applying
// ---------------------------------------------------------------------------

type Db = SupabaseClient;

export interface ApplyResult {
  applied: number;
  skipped: number;
  warnings: string[];
}

async function exists(db: Db, ref: string) {
  const { data } = await db.from("transactions").select("id").eq("broker_ref", ref).maybeSingle();
  return !!data;
}

async function openLots(db: Db, accountId: string, c: Contract) {
  const { data, error } = await db
    .from("v_positions")
    .select("id, open_quantity")
    .eq("account_id", accountId)
    .eq("instrument", "option")
    .eq("status", "open")
    .eq("ticker", c.ticker)
    .eq("option_type", c.type)
    .eq("expiration", c.expiration)
    .eq("strike", c.strike)
    .order("opened_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ id: r.id as string, open: Number(r.open_quantity) })).filter((l) => l.open > 0);
}

/** Run `act` over the oldest open lots of a contract until `quantity` is covered. Returns what was left unmatched. */
async function eachLot(
  db: Db,
  accountId: string,
  c: Contract,
  quantity: number,
  act: (lot: { id: string }, take: number, i: number) => Promise<void>,
) {
  let remaining = quantity;
  let i = 0;
  for (const lot of await openLots(db, accountId, c)) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.open);
    await act(lot, take, i++);
    remaining -= take;
  }
  return remaining;
}

const cents = (n: number) => Math.round(n * 100) / 100;

async function closeLeg(db: Db, accountId: string, l: Leg, rollGroupId: string | null, res: ApplyResult): Promise<string | null> {
  if (await exists(db, l.ref)) {
    res.skipped++;
    const { data } = await db.from("transactions").select("position_id").eq("broker_ref", l.ref).single();
    return data?.position_id ?? null;
  }
  let first: string | null = null;
  const left = await eachLot(db, accountId, l.contract, l.quantity, async (lot, take, i) => {
    await closeTrade(db, {
      positionId: lot.id,
      quantity: take,
      price: l.price,
      fees: cents((l.fees * take) / l.quantity),
      date: l.date,
      rollGroupId,
      brokerRef: i === 0 ? l.ref : `${l.ref}:${i}`,
      source: "import",
    });
    first ??= lot.id;
  });
  if (left > 0) res.warnings.push(`${l.date}: no open position to buy back ${left} of ${label(l.contract)} (opened before this report starts?)`);
  res.applied++;
  return first;
}

async function openLeg(db: Db, accountId: string, l: Leg, rolledFromId: string | null, rollGroupId: string | null, res: ApplyResult) {
  if (await exists(db, l.ref)) {
    res.skipped++;
    return;
  }
  await openTrade(db, {
    accountId,
    ticker: l.contract.ticker,
    kind: l.contract.type === "put" ? "CSP" : "CC",
    strike: l.contract.strike,
    expiration: l.contract.expiration,
    quantity: l.quantity,
    price: l.price,
    fees: l.fees,
    date: l.date,
    rolledFromId,
    rollGroupId,
    brokerRef: l.ref,
    source: "import",
  });
  res.applied++;
}

/** Apply one event. Safe to repeat: rows already imported are skipped. */
export async function applyEvent(db: Db, accountId: string, e: PlanEvent, res: ApplyResult) {
  switch (e.kind) {
    case "open":
      return openLeg(db, accountId, e.leg, null, null, res);
    case "close":
      await closeLeg(db, accountId, e.leg, null, res);
      return;
    case "roll": {
      let from: string | null = null;
      for (const c of e.closes) {
        const id = await closeLeg(db, accountId, c, e.id, res); // every close runs; the first one is what the new leg rolls from
        from ??= id;
      }
      for (const o of e.opens) await openLeg(db, accountId, o, from, e.id, res);
      const { error } = await db.rpc("merge_roll_chain", { p_roll_group: e.id });
      if (error) throw new Error(`merge_roll_chain: ${error.message}`);
      return;
    }
    case "expire":
    case "assign": {
      if (await exists(db, e.ref)) {
        res.skipped++;
        return;
      }
      const left = await eachLot(db, accountId, e.contract, e.quantity, async (lot, take, i) => {
        const brokerRef = i === 0 ? e.ref : `${e.ref}:${i}`;
        if (e.kind === "expire") await expireTrade(db, { positionId: lot.id, date: e.date, quantity: take, brokerRef, source: "import" });
        else await assignTrade(db, { positionId: lot.id, date: e.date, quantity: take, brokerRef, source: "import" });
      });
      if (left > 0)
        res.warnings.push(`${e.date}: no open position for ${e.kind === "expire" ? "expiration" : "assignment"} of ${left} ${label(e.contract)} (opened before this report starts?)`);
      res.applied++;
      return;
    }
    case "sell_shares": {
      if (await exists(db, `${e.ref}`)) {
        res.skipped++;
        return;
      }
      const { data: lots } = await db
        .from("v_positions")
        .select("id, open_quantity")
        .eq("account_id", accountId)
        .eq("ticker", e.ticker)
        .eq("instrument", "stock")
        .eq("status", "open")
        .order("opened_at");
      let remaining = e.quantity;
      let i = 0;
      for (const lot of lots ?? []) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(lot.open_quantity));
        await closeTrade(db, {
          positionId: lot.id,
          quantity: take,
          price: e.price,
          fees: cents((e.fees * take) / e.quantity),
          date: e.date,
          brokerRef: i === 0 ? e.ref : `${e.ref}:${i}`,
          source: "import",
        });
        i++;
        remaining -= take;
      }
      // shares that didn't come from an assignment aren't tracked; nothing to do for them
      if (remaining < e.quantity) res.applied++;
      return;
    }
  }
}

/** Apply events from `cursor` until done or `budgetMs` is used. Returns where to resume. */
export async function applyEvents(
  db: Db,
  accountId: string,
  events: PlanEvent[],
  cursor = 0,
  budgetMs = Infinity,
): Promise<ApplyResult & { next: number | null }> {
  const res: ApplyResult = { applied: 0, skipped: 0, warnings: [] };
  const start = Date.now();
  let i = cursor;
  for (; i < events.length; i++) {
    if (Date.now() - start > budgetMs) return { ...res, next: i };
    await applyEvent(db, accountId, events[i], res);
  }
  return { ...res, next: null };
}
