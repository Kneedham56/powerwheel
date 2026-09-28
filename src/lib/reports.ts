/**
 * Reporting math. Pure functions over rows from v_positions / v_transactions /
 * snapshots, so it's easy to add new metrics: load once, slice however you like.
 *
 * Two lenses are used on purpose:
 *  - "Realized" metrics look at roll *chains* that finished inside the period
 *    (a CSP rolled twice then expired = one chain, one win/loss).
 *  - "Cash" metrics look at option cash flow by transaction date (premium in,
 *    buybacks out), which is what shows up in the account that week.
 */
import type { PositionRow, Snapshot, Stream, TransactionRow } from "./types";

// ---------------------------------------------------------------------------
// dates & periods
// ---------------------------------------------------------------------------

const etFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Timestamp → "YYYY-MM-DD" in US Eastern (market) time. */
export function etDate(ts: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(ts) ? ts : etFormatter.format(new Date(ts));
}

export function todayEt(): string {
  return etFormatter.format(new Date());
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  return addDays(date, -dow);
}

export interface Period {
  key: string;
  label: string;
  from: string | null; // inclusive, null = beginning of time
  to: string; // inclusive
}

export const PERIOD_PRESETS = ["ytd", "30d", "90d", "12m", "all"] as const;

export function resolvePeriod(key: string | undefined, today = todayEt()): Period {
  const year = today.slice(0, 4);
  switch (key) {
    case "30d":
      return { key, label: "Last 30 days", from: addDays(today, -29), to: today };
    case "90d":
      return { key, label: "Last 90 days", from: addDays(today, -89), to: today };
    case "12m":
      return { key, label: "Last 12 months", from: addDays(today, -364), to: today };
    case "all":
      return { key, label: "All time", from: null, to: today };
    default:
      if (key && /^\d{4}$/.test(key)) {
        return { key, label: key, from: `${key}-01-01`, to: key === year ? today : `${key}-12-31` };
      }
      return { key: "ytd", label: `YTD ${year}`, from: `${year}-01-01`, to: today };
  }
}

function inPeriod(date: string | null, p: Period): boolean {
  if (!date) return false;
  return (!p.from || date >= p.from) && date <= p.to;
}

// ---------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------

export interface Scope {
  /** selected streams; undefined or empty = all streams */
  streamIds?: string[];
  /** stream → accounts it has positions in (for the capital fallback); see streamAccountMap */
  streamAccounts?: Map<string, string[]>;
}

function inScope(streamId: string, s: Scope) {
  return !s.streamIds?.length || s.streamIds.includes(streamId);
}

export function scopePositions(rows: PositionRow[], s: Scope) {
  return rows.filter((r) => inScope(r.stream_id, s));
}

export function scopeTransactions(rows: TransactionRow[], s: Scope) {
  return rows.filter((r) => inScope(r.stream_id, s));
}

export function streamAccountMap(rows: { stream_id: string; account_id: string }[]) {
  const m = new Map<string, Set<string>>();
  for (const r of rows) m.set(r.stream_id, (m.get(r.stream_id) ?? new Set()).add(r.account_id));
  return new Map([...m].map(([k, v]) => [k, [...v]]));
}

// ---------------------------------------------------------------------------
// chains
// ---------------------------------------------------------------------------

export interface Chain {
  id: string;
  ticker: string;
  strategy: PositionRow["strategy"];
  account_id: string;
  account_name: string;
  stream_id: string;
  stream_name: string;
  legs: PositionRow[];
  rolls: number;
  opened: string; // ET date
  closed: string | null; // ET date, null while any leg is live
  outcome: "open" | "expired" | "closed" | "assigned";
  net: number;
  collateral: number; // of the first leg
  current: PositionRow; // latest leg
}

export function buildChains(positions: PositionRow[]): Chain[] {
  const byChain = new Map<string, PositionRow[]>();
  for (const p of positions) {
    if (p.instrument !== "option") continue;
    const list = byChain.get(p.chain_id) ?? [];
    list.push(p);
    byChain.set(p.chain_id, list);
  }

  const chains: Chain[] = [];
  for (const [id, legs] of byChain) {
    legs.sort((a, b) => a.opened_at.localeCompare(b.opened_at));
    const parents = new Set(legs.map((l) => l.rolled_from_id).filter(Boolean));
    const current = legs.filter((l) => !parents.has(l.id)).at(-1) ?? legs.at(-1)!;
    const first = legs[0];
    // a "rolled" leaf means the new leg wasn't linked; treat the chain as finished
    const live = current.status === "open";
    chains.push({
      id,
      ticker: first.ticker,
      strategy: first.strategy,
      account_id: first.account_id,
      account_name: first.account_name,
      stream_id: first.stream_id,
      stream_name: first.stream_name,
      legs,
      rolls: legs.length - 1,
      opened: etDate(first.opened_at),
      closed: live || !current.closed_at ? null : etDate(current.closed_at),
      outcome: live ? "open" : current.status === "rolled" ? "closed" : (current.status as Chain["outcome"]),
      net: legs.reduce((s, l) => s + Number(l.net_amount), 0),
      collateral: Number(first.collateral ?? 0),
      current,
    });
  }
  return chains.sort((a, b) => b.opened.localeCompare(a.opened));
}

// ---------------------------------------------------------------------------
// capital
// ---------------------------------------------------------------------------

/**
 * Capital for a scope as of a date, from the latest snapshot at or before `date`.
 *  - All streams: whole-account snapshots for every account.
 *  - Selected streams: each stream's own snapshots when it has them (e.g. Tesla CC = the
 *    TSLA shares, Joint Wheel = Joint's cash); otherwise its accounts' whole-account value.
 */
export function capitalAsOf(snapshots: Snapshot[], date: string, s: Scope): number | null {
  const rows = snapshots.filter((x) => x.as_of <= date);
  if (!s.streamIds?.length) return sumLatest(rows.filter((x) => !x.stream_id));

  let total: number | null = null;
  const fallbackAccounts = new Set<string>();
  for (const sid of s.streamIds) {
    const own = sumLatest(rows.filter((x) => x.stream_id === sid));
    if (own !== null) total = (total ?? 0) + own;
    else for (const a of s.streamAccounts?.get(sid) ?? []) fallbackAccounts.add(a);
  }
  const accounts = sumLatest(rows.filter((x) => !x.stream_id && fallbackAccounts.has(x.account_id)));
  if (accounts !== null) total = (total ?? 0) + accounts;
  return total;
}

/** Sum of the latest snapshot per (account, stream). */
function sumLatest(rows: Snapshot[]): number | null {
  const latest = new Map<string, Snapshot>();
  for (const r of rows) {
    const k = `${r.account_id}:${r.stream_id ?? ""}`;
    const prev = latest.get(k);
    if (!prev || r.as_of > prev.as_of) latest.set(k, r);
  }
  if (!latest.size) return null;
  return [...latest.values()].reduce((sum, r) => sum + Number(r.total_value), 0);
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

export interface Summary {
  // realized (chains closed in period)
  chainsClosed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  realizedOptions: number;
  realizedStock: number;
  realized: number;
  grossGains: number;
  grossLosses: number;
  avgWin: number | null;
  avgLoss: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  expired: number;
  boughtBack: number;
  assigned: number;
  assignmentRate: number | null;
  rolledChains: number;
  totalRolls: number;
  // cash (option transactions in period)
  premiumCollected: number;
  buybackCost: number;
  netPremium: number;
  fees: number;
  contractsSold: number;
  // capital
  startCapital: number | null;
  startCapitalDate: string | null;
  /** true when no snapshot existed at the period start and a later one stands in */
  startCapitalIsProxy: boolean;
  endCapital: number | null;
  netDeposits: number;
  returnOnCapital: number | null;
  avgReturnOnCollateral: number | null;
  // open book
  openChains: number;
  openCollateral: number;
  openPremium: number;
}

export function summarize(
  positions: PositionRow[],
  txns: TransactionRow[],
  snapshots: Snapshot[],
  period: Period,
  scope: Scope,
): Summary {
  const pos = scopePositions(positions, scope);
  const tx = scopeTransactions(txns, scope);
  const chains = buildChains(pos);
  const closed = chains.filter((c) => inPeriod(c.closed, period));

  const winners = closed.filter((c) => c.net > 0 && c.outcome !== "assigned");
  const losers = closed.filter((c) => c.net < 0 || c.outcome === "assigned");
  const realizedOptions = sum(closed.map((c) => c.net));
  const realizedStock = sum(
    pos
      .filter((p) => p.instrument === "stock" && p.status !== "open" && inPeriod(p.closed_at && etDate(p.closed_at), period))
      .map((p) => Number(p.net_amount)),
  );

  const optTx = tx.filter((t) => t.instrument === "option" && inPeriod(etDate(t.occurred_at), period));
  const premiumCollected = sum(optTx.filter((t) => t.action === "sell_to_open").map((t) => Number(t.amount)));
  const buybackCost = -sum(optTx.filter((t) => t.action === "buy_to_close").map((t) => Number(t.amount)));

  const startDate = period.from ?? (chains.at(-1)?.opened ?? period.to);
  let startCapital = capitalAsOf(snapshots, startDate, scope);
  let startCapitalDate: string | null = startCapital === null ? null : startDate;
  if (startCapital === null) {
    // no snapshot before the period: fall back to the earliest one inside it
    const first = snapshots.filter((x) => inPeriod(x.as_of, period)).map((x) => x.as_of).sort()[0];
    if (first) {
      startCapital = capitalAsOf(snapshots, first, scope);
      startCapitalDate = first;
    }
  }
  const endCapital = capitalAsOf(snapshots, period.to, scope);
  const netDeposits = sum(
    snapshots
      .filter((s) => inPeriod(s.as_of, period))
      .filter((s) => (scope.streamIds?.length ? !!s.stream_id && scope.streamIds.includes(s.stream_id) : !s.stream_id))
      .map((s) => Number(s.net_deposits)),
  );
  const realized = realizedOptions + realizedStock;

  const csps = closed.filter((c) => c.strategy === "CSP");
  const withCollateral = closed.filter((c) => c.collateral > 0);
  const open = chains.filter((c) => c.outcome === "open");

  return {
    chainsClosed: closed.length,
    wins: winners.length,
    losses: losers.length,
    winRate: ratio(winners.length, closed.length),
    realizedOptions,
    realizedStock,
    realized,
    grossGains: sum(winners.map((c) => c.net)),
    grossLosses: sum(losers.map((c) => c.net)),
    avgWin: winners.length ? sum(winners.map((c) => c.net)) / winners.length : null,
    avgLoss: losers.length ? sum(losers.map((c) => c.net)) / losers.length : null,
    largestWin: winners.length ? Math.max(...winners.map((c) => c.net)) : null,
    largestLoss: losers.length ? Math.min(...losers.map((c) => c.net)) : null,
    expired: closed.filter((c) => c.outcome === "expired").length,
    boughtBack: closed.filter((c) => c.outcome === "closed").length,
    assigned: closed.filter((c) => c.outcome === "assigned").length,
    assignmentRate: ratio(csps.filter((c) => c.outcome === "assigned").length, csps.length),
    rolledChains: closed.filter((c) => c.rolls > 0).length,
    totalRolls: sum(closed.map((c) => c.rolls)),
    premiumCollected,
    buybackCost,
    netPremium: premiumCollected - buybackCost,
    fees: sum(optTx.map((t) => Number(t.fees))),
    contractsSold: sum(optTx.filter((t) => t.action === "sell_to_open").map((t) => Number(t.quantity))),
    startCapital,
    startCapitalDate,
    startCapitalIsProxy: startCapitalDate !== null && startCapitalDate > startDate,
    endCapital,
    netDeposits,
    returnOnCapital: startCapital ? realized / startCapital : null,
    avgReturnOnCollateral: withCollateral.length
      ? sum(withCollateral.map((c) => c.net / c.collateral)) / withCollateral.length
      : null,
    openChains: open.length,
    openCollateral: sum(open.map((c) => Number(c.current.collateral ?? 0))),
    openPremium: sum(open.map((c) => c.net)),
  };
}


// ---------------------------------------------------------------------------
// breakdowns
// ---------------------------------------------------------------------------

export interface WeekRow {
  week: string; // Monday
  byStream: Record<string, number>; // stream name → net option cash
  net: number;
  capital: number | null;
  returnPct: number | null;
  cumulative: number;
}

/**
 * Weekly views bucket option cash by EXPIRATION week, not trade date:
 *  - premium sold for next week's expiry counts toward next week;
 *  - a roll counts once, as its net credit/debit, in the NEW contract's expiration week
 *    (the buyback leg moves to where the new leg lands);
 *  - a plain buyback stays in the week of the contract it closed.
 */
function expiryBucketer(txns: TransactionRow[]) {
  const rollTarget = new Map<string, string>(); // roll_group_id → new leg's expiration
  for (const t of txns) {
    if (t.roll_group_id && t.expiration && (t.action === "sell_to_open" || t.action === "buy_to_open")) {
      const prev = rollTarget.get(t.roll_group_id);
      if (!prev || t.expiration > prev) rollTarget.set(t.roll_group_id, t.expiration);
    }
  }
  return (t: TransactionRow): string =>
    (t.roll_group_id && rollTarget.get(t.roll_group_id)) || t.expiration || etDate(t.occurred_at);
}

/**
 * Trades already made (trade date ≤ period end) whose expiration week is on or after the
 * period start, so upcoming expirations for positions opened today still show as future weeks.
 */
function weeklyOptionTxns(txns: TransactionRow[], period: Period, scope: Scope) {
  const bucket = expiryBucketer(txns);
  const tx = scopeTransactions(txns, scope).filter(
    (t) =>
      t.instrument === "option" &&
      Number(t.amount) !== 0 &&
      etDate(t.occurred_at) <= period.to &&
      (!period.from || bucket(t) >= period.from),
  );
  return { tx, week: (t: TransactionRow) => weekStart(bucket(t)) };
}

/** Net option cash flow per expiration week (premium in − buybacks, rolls netted), split by stream. */
export function weekly(txns: TransactionRow[], snapshots: Snapshot[], period: Period, scope: Scope): WeekRow[] {
  const { tx, week } = weeklyOptionTxns(txns, period, scope);
  const weeks = new Map<string, WeekRow>();
  for (const t of tx) {
    const w = week(t);
    const row = weeks.get(w) ?? { week: w, byStream: {}, net: 0, capital: null, returnPct: null, cumulative: 0 };
    row.byStream[t.stream_name] = (row.byStream[t.stream_name] ?? 0) + Number(t.amount);
    row.net += Number(t.amount);
    weeks.set(w, row);
  }
  let running = 0;
  return [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((r) => {
      running += r.net;
      const capital = capitalAsOf(snapshots, addDays(r.week, 6), scope);
      return { ...r, capital, returnPct: capital ? r.net / capital : null, cumulative: running };
    });
}

/** The option transactions behind each week's net premium (same buckets as `weekly`), newest first. */
export function weekTransactions(txns: TransactionRow[], period: Period, scope: Scope): Map<string, TransactionRow[]> {
  const { tx, week } = weeklyOptionTxns(txns, period, scope);
  const out = new Map<string, TransactionRow[]>();
  for (const t of tx) {
    const w = week(t);
    out.set(w, [...(out.get(w) ?? []), t]);
  }
  for (const list of out.values()) list.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  return out;
}

/** Closed chains in the period, grouped the same way as `groupChains`, most recent first. */
export function chainsByGroup(
  positions: PositionRow[],
  period: Period,
  scope: Scope,
  by: "ticker" | "stream" | "account" | "strategy",
): Map<string, Chain[]> {
  const out = new Map<string, Chain[]>();
  for (const c of buildChains(scopePositions(positions, scope))) {
    if (!inPeriod(c.closed, period)) continue;
    const key =
      by === "ticker" ? c.ticker : by === "stream" ? c.stream_id : by === "account" ? c.account_id : c.strategy;
    out.set(key, [...(out.get(key) ?? []), c]);
  }
  for (const list of out.values()) list.sort((a, b) => (b.closed ?? "").localeCompare(a.closed ?? ""));
  return out;
}

export interface GroupRow {
  key: string;
  label: string;
  color?: string | null;
  chains: number;
  wins: number;
  winRate: number | null;
  net: number;
  assigned: number;
  rolls: number;
  avgReturnOnCollateral: number | null;
}

export function groupChains(
  positions: PositionRow[],
  period: Period,
  scope: Scope,
  by: "ticker" | "stream" | "account" | "strategy",
  streams: Stream[] = [],
): GroupRow[] {
  const chains = buildChains(scopePositions(positions, scope)).filter((c) => inPeriod(c.closed, period));
  const groups = new Map<string, Chain[]>();
  for (const c of chains) {
    const key =
      by === "ticker" ? c.ticker : by === "stream" ? c.stream_id : by === "account" ? c.account_id : c.strategy;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const wins = list.filter((c) => c.net > 0 && c.outcome !== "assigned").length;
      const withColl = list.filter((c) => c.collateral > 0);
      const stream = by === "stream" ? streams.find((s) => s.id === key) : undefined;
      return {
        key,
        label:
          by === "stream" ? list[0].stream_name : by === "account" ? list[0].account_name : key,
        color: stream?.color,
        chains: list.length,
        wins,
        winRate: ratio(wins, list.length),
        net: sum(list.map((c) => c.net)),
        assigned: list.filter((c) => c.outcome === "assigned").length,
        rolls: sum(list.map((c) => c.rolls)),
        avgReturnOnCollateral: withColl.length
          ? sum(withColl.map((c) => c.net / c.collateral)) / withColl.length
          : null,
      };
    })
    .sort((a, b) => b.net - a.net);
}

// ---------------------------------------------------------------------------

function sum(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0);
}

function ratio(n: number, d: number) {
  return d ? n / d : null;
}
