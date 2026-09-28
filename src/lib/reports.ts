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
  streamId?: string;
  accountId?: string;
}

export function scopePositions(rows: PositionRow[], s: Scope) {
  return rows.filter(
    (r) => (!s.streamId || r.stream_id === s.streamId) && (!s.accountId || r.account_id === s.accountId),
  );
}

export function scopeTransactions(rows: TransactionRow[], s: Scope) {
  return rows.filter(
    (r) => (!s.streamId || r.stream_id === s.streamId) && (!s.accountId || r.account_id === s.accountId),
  );
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
 * Capital for a scope as of a date: sum of the latest snapshot at or before
 * `date` for each account in scope. When scoped to a stream and that stream has
 * its own snapshots, those are used instead of whole-account values.
 */
export function capitalAsOf(snapshots: Snapshot[], date: string, s: Scope, streamAccounts?: string[]): number | null {
  let rows = snapshots.filter((x) => x.as_of <= date);
  if (s.streamId) {
    const streamRows = rows.filter((x) => x.stream_id === s.streamId);
    rows = streamRows.length
      ? streamRows
      : rows.filter((x) => !x.stream_id && (streamAccounts ?? []).includes(x.account_id));
  } else {
    rows = rows.filter((x) => !x.stream_id);
  }
  if (s.accountId) rows = rows.filter((x) => x.account_id === s.accountId);

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

  const streamAccounts = [...new Set(pos.map((p) => p.account_id))];
  const startDate = period.from ?? (chains.at(-1)?.opened ?? period.to);
  let startCapital = capitalAsOf(snapshots, startDate, scope, streamAccounts);
  let startCapitalDate: string | null = startCapital === null ? null : startDate;
  if (startCapital === null) {
    // no snapshot before the period: fall back to the earliest one inside it
    const first = snapshots.filter((x) => inPeriod(x.as_of, period)).map((x) => x.as_of).sort()[0];
    if (first) {
      startCapital = capitalAsOf(snapshots, first, scope, streamAccounts);
      startCapitalDate = first;
    }
  }
  const endCapital = capitalAsOf(snapshots, period.to, scope, streamAccounts);
  const netDeposits = sum(
    snapshots
      .filter((s) => inPeriod(s.as_of, period) && (!scope.accountId || s.account_id === scope.accountId))
      .filter((s) => (scope.streamId ? s.stream_id === scope.streamId : !s.stream_id))
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

/** Net option cash flow per week (premium in − buybacks), split by stream. */
export function weekly(txns: TransactionRow[], snapshots: Snapshot[], period: Period, scope: Scope): WeekRow[] {
  const tx = scopeTransactions(txns, scope).filter(
    (t) => t.instrument === "option" && inPeriod(etDate(t.occurred_at), period) && Number(t.amount) !== 0,
  );
  const weeks = new Map<string, WeekRow>();
  for (const t of tx) {
    const w = weekStart(etDate(t.occurred_at));
    const row = weeks.get(w) ?? { week: w, byStream: {}, net: 0, capital: null, returnPct: null, cumulative: 0 };
    row.byStream[t.stream_name] = (row.byStream[t.stream_name] ?? 0) + Number(t.amount);
    row.net += Number(t.amount);
    weeks.set(w, row);
  }
  const streamAccounts = [...new Set(tx.map((t) => t.account_id))];
  let running = 0;
  return [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((r) => {
      running += r.net;
      const capital = capitalAsOf(snapshots, addDays(r.week, 6), scope, streamAccounts);
      return { ...r, capital, returnPct: capital ? r.net / capital : null, cumulative: running };
    });
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
