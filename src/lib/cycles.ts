/**
 * Wheel cycles: one ticker in one account, from the first put assignment until the
 * assigned shares are all gone (sold or called away).
 *
 *   total = premium from the put(s) that were assigned into the cycle
 *         + premium from covered calls sold while holding the shares
 *         + gain/loss on the shares themselves (vs. the strike they were assigned at)
 *
 * Only shares that came from assignments are tracked, so stock owned before wheeling
 * (e.g. the TSLA behind Tesla CC) never forms a cycle.
 */
import { buildChains, etDate, inPeriod, scopePositions, type Chain, type Period, type Scope } from "./reports";
import type { PositionRow } from "./types";

export interface Cycle {
  id: string;
  ticker: string;
  account_id: string;
  account_name: string;
  stream_id: string;
  stream_name: string;
  started: string; // ET date of the first assignment
  ended: string | null; // ET date the last shares left; null while shares are held
  status: "open" | "closed";
  puts: Chain[]; // put trades assigned into this cycle
  calls: Chain[]; // covered calls sold while holding the shares
  lots: PositionRow[]; // share lots
  putPremium: number;
  callPremium: number;
  sharesAssigned: number;
  sharesHeld: number;
  /** realized share gain/loss on lots already sold / called away */
  stockPnl: number;
  /** cost (at strike) of shares still held */
  openCost: number;
  /** open cycles: (cost of held shares − all premium) / shares held */
  adjustedBasis: number | null;
  /** premiums + realized share P&L (for an open cycle, "so far") */
  total: number;
}

export function buildCycles(positions: PositionRow[], scope: Scope = {}): Cycle[] {
  const pos = scopePositions(positions, scope);
  const chains = buildChains(pos);
  const chainByLeg = new Map<string, Chain>();
  for (const c of chains) for (const l of c.legs) chainByLeg.set(l.id, c);

  // share lots created by assignments, grouped per account + ticker
  const lotsByKey = new Map<string, PositionRow[]>();
  for (const p of pos) {
    if (p.instrument !== "stock" || !p.assigned_from_id) continue;
    const k = `${p.account_id}|${p.ticker}`;
    lotsByKey.set(k, [...(lotsByKey.get(k) ?? []), p]);
  }

  const cycles: Cycle[] = [];
  for (const lots of lotsByKey.values()) {
    lots.sort((a, b) => a.opened_at.localeCompare(b.opened_at));

    // merge lots whose holding periods overlap into one cycle
    const groups: PositionRow[][] = [];
    let current: PositionRow[] = [];
    let heldUntil: string | null = null; // last day shares were held in `current`; null = still held
    for (const lot of lots) {
      const opened = etDate(lot.opened_at);
      const lotUntil = lot.status === "open" || !lot.closed_at ? null : etDate(lot.closed_at);
      if (current.length && heldUntil !== null && opened > heldUntil) {
        groups.push(current); // shares were all gone before this lot: new cycle
        current = [];
      }
      if (!current.length) heldUntil = lotUntil;
      else heldUntil = laterOrOpen(heldUntil, lotUntil);
      current.push(lot);
    }
    if (current.length) groups.push(current);

    for (const g of groups) cycles.push(makeCycle(g, chains, chainByLeg));
  }
  return cycles.sort((a, b) => (b.ended ?? "9999").localeCompare(a.ended ?? "9999") || b.started.localeCompare(a.started));
}

function makeCycle(lots: PositionRow[], chains: Chain[], chainByLeg: Map<string, Chain>): Cycle {
  const first = lots[0];
  const started = etDate(first.opened_at);
  const open = lots.some((l) => l.status === "open");
  const ended = open ? null : lots.map((l) => etDate(l.closed_at!)).sort().at(-1)!;

  const puts = [
    ...new Map(
      lots
        .map((l) => chainByLeg.get(l.assigned_from_id!))
        .filter((c): c is Chain => !!c && c.strategy === "CSP")
        .map((c) => [c.id, c]),
    ).values(),
  ];
  const calls = chains.filter(
    (c) =>
      c.strategy === "CC" &&
      c.account_id === first.account_id &&
      c.ticker === first.ticker &&
      c.opened >= started &&
      (ended === null || c.opened <= ended),
  );

  const putPremium = sum(puts.map((c) => c.net));
  const callPremium = sum(calls.map((c) => c.net));
  const closedLots = lots.filter((l) => l.status !== "open");
  const openLots = lots.filter((l) => l.status === "open");
  // a partly sold lot stays open; its realized part is net cash beyond the remaining cost
  const stockPnl =
    sum(closedLots.map((l) => Number(l.net_amount))) +
    sum(openLots.map((l) => Number(l.credits) - (Number(l.debits) * (Number(l.quantity) - Number(l.open_quantity))) / Math.max(Number(l.quantity), 1)));
  const sharesHeld = sum(openLots.map((l) => Number(l.open_quantity)));
  const openCost = sum(openLots.map((l) => (Number(l.debits) * Number(l.open_quantity)) / Math.max(Number(l.quantity), 1)));
  const premiums = putPremium + callPremium;

  return {
    id: `${first.account_id}|${first.ticker}|${started}`,
    ticker: first.ticker,
    account_id: first.account_id,
    account_name: first.account_name,
    stream_id: first.stream_id,
    stream_name: first.stream_name,
    started,
    ended,
    status: open ? "open" : "closed",
    puts,
    calls,
    lots,
    putPremium,
    callPremium,
    sharesAssigned: sum(lots.map((l) => Number(l.quantity))),
    sharesHeld,
    stockPnl,
    openCost,
    adjustedBasis: sharesHeld ? (openCost - premiums) / sharesHeld : null,
    total: premiums + stockPnl,
  };
}

/** Cycles to show for a period: every cycle that ended in it, plus all still open. */
export function cyclesInPeriod(cycles: Cycle[], period: Period) {
  return cycles.filter((c) => c.status === "open" || inPeriod(c.ended, period));
}

export interface CycleSummary {
  closed: number;
  green: number;
  red: number;
  closedNet: number;
  open: number;
  openShares: number;
  openCost: number;
}

export function summarizeCycles(cycles: Cycle[]): CycleSummary {
  const closed = cycles.filter((c) => c.status === "closed");
  const open = cycles.filter((c) => c.status === "open");
  return {
    closed: closed.length,
    green: closed.filter((c) => c.total > 0).length,
    red: closed.filter((c) => c.total < 0).length,
    closedNet: sum(closed.map((c) => c.total)),
    open: open.length,
    openShares: sum(open.map((c) => c.sharesHeld)),
    openCost: sum(open.map((c) => c.openCost)),
  };
}

/** The later of two "held until" dates, where null means still held. */
function laterOrOpen(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return a > b ? a : b;
}

function sum(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0);
}
