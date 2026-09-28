import type { ReactNode } from "react";
import {
  Chips,
  Flash,
  OptionTypePill,
  PageTitle,
  Stat,
  StatusPill,
  StreamDot,
  ToggleChips,
  multiParam,
  param,
} from "@/components/ui";
import { WeeklyChart, type WeeklyPoint } from "@/components/WeeklyChart";
import { loadAll } from "@/lib/db";
import { ACTION_LABEL, money, num, pct, shortDate, signClass } from "@/lib/format";
import {
  chainsByGroup,
  etDate,
  groupChains,
  resolvePeriod,
  streamAccountMap,
  summarize,
  todayEt,
  weekTransactions,
  weekly,
  type Chain,
  type GroupRow,
} from "@/lib/reports";
import { buildCycles, cyclesInPeriod, summarizeCycles, type Cycle } from "@/lib/cycles";
import type { TransactionRow } from "@/lib/types";

export default async function ReportsPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const { streams, positions, transactions, snapshots } = await loadAll();

  const period = resolvePeriod(param(sp, "period"));
  const activeStreams = streams.filter((st) => st.is_active);
  const selected = multiParam(sp, "streams", activeStreams.map((st) => st.id));
  const scope = { streamIds: selected, streamAccounts: streamAccountMap(positions) };
  const s = summarize(positions, transactions, snapshots, period, scope);
  const weeks = weekly(transactions, snapshots, period, scope);
  const weekTxns = weekTransactions(transactions, period, scope);
  const tickerChains = chainsByGroup(positions, period, scope, "ticker");
  const cycles = cyclesInPeriod(buildCycles(positions, scope), period);
  const cy = summarizeCycles(cycles);
  const streamColor = new Map(streams.map((st) => [st.id, st.color]));
  const posStatus = new Map(positions.map((p) => [p.id, p.status]));

  const years = [...new Set(transactions.map((t) => etDate(t.occurred_at).slice(0, 4)))].sort().reverse();
  const periodOptions = [
    { value: "", label: "YTD" },
    { value: "30d", label: "30D" },
    { value: "90d", label: "90D" },
    { value: "12m", label: "12M" },
    ...years.filter((y) => y !== todayEt().slice(0, 4)).map((y) => ({ value: y, label: y })),
    { value: "all", label: "All time" },
  ];

  const chartStreams = (selected.length ? activeStreams.filter((st) => selected.includes(st.id)) : activeStreams).map((st) => ({ name: st.name, color: st.color ?? "#888" }));
  const chartData: WeeklyPoint[] = weeks.map((w) => ({ week: w.week, cumulative: w.cumulative, ...w.byStream }));

  const empty = positions.length === 0;

  return (
    <div className="space-y-6">
      <Flash sp={sp} />
      <PageTitle>Reports · {period.label}</PageTitle>

      <div className="card space-y-2">
        <Chips sp={sp} path="/" name="period" options={periodOptions} />
        <ToggleChips
          sp={sp}
          path="/"
          name="streams"
          options={activeStreams.map((st) => ({ value: st.id, label: st.name, color: st.color }))}
        />
      </div>

      {empty && (
        <div className="card text-sm text-muted">
          No trades yet. Add one on <a className="text-accent underline" href="/trades/new">New trade</a>, or run the
          Robinhood sync (see README).
        </div>
      )}

      <section className="space-y-3">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Bottom line</h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Realized P&L"
            value={money(s.realized, true)}
            tone={signClass(s.realized)}
            sub={`Options ${money(s.realizedOptions, true)} · Stock ${money(s.realizedStock, true)}`}
          />
          <Stat
            label="Return on capital"
            value={pct(s.returnOnCapital, 2)}
            tone={signClass(s.returnOnCapital)}
            sub={
              !s.startCapital
                ? "Add account snapshots to see this"
                : s.startCapitalIsProxy
                  ? `on ${money(s.startCapital, true)} (value on ${shortDate(s.startCapitalDate)}, earliest snapshot)`
                  : `on ${money(s.startCapital, true)} value at ${shortDate(s.startCapitalDate)}`
            }
          />
          <Stat
            label="Net premium"
            value={money(s.netPremium, true)}
            tone={signClass(s.netPremium)}
            sub={`New ${money(s.newPremium, true)} + rolls ${money(s.rollNet, true)} − buybacks ${money(s.plainBuybacks, true)}`}
          />
          <Stat
            label="Open now"
            value={`${s.openChains} trades`}
            sub={`${money(s.openCollateral, true)} collateral · ${money(s.openPremium, true)} premium held`}
          />
        </div>

        <h3 className="pt-1 text-xs font-medium tracking-wide text-muted uppercase">Trades & wheel cycles</h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Win rate"
            value={pct(s.winRate)}
            sub={`${s.wins}W / ${s.losses}L · avg win ${money(s.avgWin, true)} · avg loss ${money(s.avgLoss, true)}`}
          />
          <Stat
            label="Avg return / trade"
            value={pct(s.avgReturnOnCollateral, 2)}
            sub="net P&L ÷ collateral, per closed trade"
          />
          <Stat
            label="Outcomes"
            value={
              <span className="text-base">
                {s.expired} expired · {s.boughtBack} bought back · {s.assigned} assigned
              </span>
            }
            sub={`CSP assignment rate ${pct(s.assignmentRate)} · ${s.totalRolls} rolls across ${s.rolledChains} trades`}
          />
          <Stat
            label="Wheel cycles"
            value={
              <span className="text-base">
                <span className="text-gain">{cy.green} green</span> · <span className="text-loss">{cy.red} red</span>
                {" · "}
                <span className={signClass(cy.closedNet)}>{money(cy.closedNet, true)}</span>
              </span>
            }
            sub={
              cy.open
                ? `${cy.open} open, holding ${num(cy.openShares, 0)} sh (${money(cy.openCost, true)} at strike)`
                : "no shares held from assignments"
            }
          />
        </div>
      </section>

      <section className="card">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-medium">Weekly net premium</h2>
          <span className="text-xs text-muted">premium sold − buybacks, by expiration week · line = cumulative</span>
        </div>
        <WeeklyChart data={chartData} streams={chartStreams} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <GroupTable title="By stream" rows={groupChains(positions, period, scope, "stream", streams)} dot />
        <GroupTable title="By strategy" rows={groupChains(positions, period, scope, "strategy")} />
      </div>

      <section className="card overflow-x-auto">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-medium">Weekly detail</h2>
          <span className="text-xs text-muted">click a week to see what made it up</span>
        </div>
        <div className="gtable">
          <div className={`ghead ${WEEK_COLS}`}>
            <span />
            <span className="text-left">Expiring week</span>
            <span>Net premium</span>
            <span>Account value</span>
            <span>Weekly return</span>
            <span>Cumulative</span>
          </div>
          {[...weeks].reverse().map((w) => (
            <Expandable
              key={w.week}
              cols={WEEK_COLS}
              cells={[
                shortDate(fridayOf(w.week)),
                <span key="n" className={signClass(w.net)}>
                  {money(w.net)}
                </span>,
                money(w.capital, true),
                pct(w.returnPct, 2),
                money(w.cumulative, true),
              ]}
            >
              <WeekBreakdown txns={weekTxns.get(w.week) ?? []} streamColor={streamColor} posStatus={posStatus} />
            </Expandable>
          ))}
        </div>
      </section>

      <GroupTable
        title="By ticker"
        hint="click a ticker to see its trades"
        rows={groupChains(positions, period, scope, "ticker")}
        detail={(key) => <ChainList chains={tickerChains.get(key) ?? []} />}
      />

      <section className="card overflow-x-auto">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-medium">Wheel cycles</h2>
          <span className="text-xs text-muted">
            put → assigned shares → covered calls → shares gone · click a cycle for its plays, newest first
          </span>
        </div>
        <div className="gtable">
          <div className={`ghead ${CYCLE_COLS}`}>
            <span />
            <span className="text-left">Ticker</span>
            <span>Account</span>
            <span>Assigned</span>
            <span>Complete</span>
            <span>Shares</span>
            <span>Put prem.</span>
            <span>Call prem.</span>
            <span>Shares P&L</span>
            <span>Total</span>
          </div>
          {cycles.map((c) => (
            <Expandable
              key={c.id}
              cols={CYCLE_COLS}
              cells={[
                c.ticker,
                c.account_name,
                shortDate(c.started),
                c.ended ? shortDate(c.ended) : <StatusPill key="o" status="open" label="holding" />,
                num(c.sharesAssigned, 0),
                <span key="p" className={signClass(c.putPremium)}>{money(c.putPremium, true)}</span>,
                <span key="c" className={signClass(c.callPremium)}>{money(c.callPremium, true)}</span>,
                <span key="s" className={signClass(c.stockPnl)}>{money(c.stockPnl, true)}</span>,
                <span key="t" className={`font-medium ${signClass(c.total)}`}>{money(c.total, true)}</span>,
              ]}
            >
              <CycleStory cycle={c} />
            </Expandable>
          ))}
          {!cycles.length && <div className="px-2 py-3 text-sm text-muted">No assignments in this period</div>}
        </div>
      </section>

      {/*
        Recently closed trades, hidden for now. To bring it back, restore this section:
        a table of buildChains(scopePositions(positions, scope)) closed in the period,
        newest first, showing closed date, ticker/strategy, stream, outcome, rolls, net, return.
      */}
    </div>
  );
}

// ---------------------------------------------------------------------------

const WEEK_COLS = "grid-cols-[1rem_minmax(6.5rem,1fr)_repeat(4,minmax(4.5rem,1fr))]";
const CYCLE_COLS = "grid-cols-[1rem_minmax(4rem,1fr)_repeat(8,minmax(4.5rem,1fr))]";
const GROUP_COLS = "grid-cols-[1rem_minmax(6rem,1.4fr)_repeat(6,minmax(3.5rem,1fr))]";

/** Monday of an expiration week → that Friday (the usual expiration day). */
function fridayOf(monday: string) {
  const d = new Date(`${monday}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4);
  return d.toISOString().slice(0, 10);
}

/** A grid row that expands to show `children` when clicked (or a plain row without children). */
function Expandable({ cols, cells, children }: { cols: string; cells: ReactNode[]; children?: ReactNode }) {
  const row = (
    <>
      <span className="text-muted transition-transform group-open:rotate-90">{children ? "▸" : ""}</span>
      {cells.map((c, i) => (
        <span key={i} className={i === 0 ? "text-left font-medium" : undefined}>
          {c}
        </span>
      ))}
    </>
  );
  if (!children) return <div className={`grow ${cols}`}>{row}</div>;
  return (
    <details className="group">
      <summary className={`grow ${cols}`}>{row}</summary>
      <div className="drill">{children}</div>
    </details>
  );
}

function GroupTable({
  title,
  hint,
  rows,
  dot,
  detail,
}: {
  title: string;
  hint?: string;
  rows: GroupRow[];
  dot?: boolean;
  detail?: (key: string) => ReactNode;
}) {
  return (
    <section className="card overflow-x-auto">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-medium">{title}</h2>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      <div className="gtable">
        <div className={`ghead ${GROUP_COLS}`}>
          <span />
          <span />
          <span>Trades</span>
          <span>Win rate</span>
          <span>Assigned</span>
          <span>Rolls</span>
          <span>Avg return</span>
          <span>Net P&L</span>
        </div>
        {rows.map((r) => (
          <Expandable
            key={r.key}
            cols={GROUP_COLS}
            cells={[
              <>
                {dot && <StreamDot color={r.color} />}
                {r.label}
              </>,
              r.chains,
              pct(r.winRate),
              r.assigned,
              r.rolls,
              pct(r.avgReturnOnCollateral, 2),
              <span key="n" className={signClass(r.net)}>
                {money(r.net)}
              </span>,
            ]}
          >
            {detail?.(r.key)}
          </Expandable>
        ))}
        {!rows.length && <div className="px-2 py-3 text-sm text-muted">Nothing closed in this period</div>}
      </div>
    </section>
  );
}

interface BreakdownRow {
  key: string;
  date: string;
  ticker: string;
  strike: string; // "40", or "375 → 385" for a roll
  optionType: "put" | "call" | null;
  action: string;
  stream_id: string;
  stream_name: string;
  quantity: number;
  price: number; // per share; net per share for rolls
  amount: number;
  /** where the position ended up (for a roll: the new contract) */
  status?: string;
}

/** One row per trade, except a roll, which collapses to one net row: old contract(s) → new. */
function breakdownRows(txns: TransactionRow[], posStatus: Map<string, string>): BreakdownRow[] {
  const rolls = new Map<string, TransactionRow[]>();
  const rows: BreakdownRow[] = [];
  for (const t of txns) {
    if (t.roll_group_id) rolls.set(t.roll_group_id, [...(rolls.get(t.roll_group_id) ?? []), t]);
    else
      rows.push({
        key: t.id,
        date: t.occurred_at,
        ticker: t.ticker,
        strike: num(t.strike),
        optionType: t.option_type,
        action: ACTION_LABEL[t.action] ?? t.action,
        stream_id: t.stream_id,
        stream_name: t.stream_name,
        quantity: Number(t.quantity),
        price: Number(t.price),
        amount: Number(t.amount),
        status: posStatus.get(t.position_id),
      });
  }
  for (const [id, legs] of rolls) {
    const closes = legs.filter((l) => l.action === "buy_to_close" || l.action === "sell_to_close");
    const opens = legs.filter((l) => l.action === "sell_to_open" || l.action === "buy_to_open");
    const qty = opens.reduce((s, l) => s + Number(l.quantity), 0) || closes.reduce((s, l) => s + Number(l.quantity), 0);
    const amount = legs.reduce((s, l) => s + Number(l.amount), 0);
    const strikes = (ls: TransactionRow[]) => [...new Set(ls.map((l) => num(l.strike)))].join(" + ");
    rows.push({
      key: id,
      date: legs.map((l) => l.occurred_at).sort()[0],
      ticker: legs[0].ticker,
      strike: opens.length && closes.length ? `${strikes(closes)} → ${strikes(opens)}` : strikes(legs),
      optionType: (opens[0] ?? legs[0]).option_type,
      action: opens.length && closes.length ? (amount >= 0 ? "Roll (credit)" : "Roll (debit)") : "Roll (partial)",
      stream_id: legs[0].stream_id,
      stream_name: legs[0].stream_name,
      quantity: qty,
      price: qty ? amount / (qty * 100) : 0,
      amount,
      status: opens.length ? posStatus.get(opens[0].position_id) : posStatus.get(legs[0].position_id),
    });
  }
  // puts first, then calls; A→Z by ticker; biggest premium first
  const typeOrder = (t: BreakdownRow["optionType"]) => (t === "put" ? 0 : t === "call" ? 1 : 2);
  return rows.sort(
    (a, b) =>
      typeOrder(a.optionType) - typeOrder(b.optionType) ||
      a.ticker.localeCompare(b.ticker) ||
      b.amount - a.amount,
  );
}

/** What made up a week, by type → ticker → premium. Rolls show as their net credit/debit. */
const OUTCOME_LABEL: Record<string, string> = { closed: "bought back" };

function WeekBreakdown({
  txns,
  streamColor,
  posStatus,
}: {
  txns: TransactionRow[];
  streamColor: Map<string, string | null>;
  posStatus: Map<string, string>;
}) {
  if (!txns.length) return <p className="text-xs text-muted">No option cash flow this week.</p>;
  const byTicker = new Map<string, number>();
  for (const t of txns) byTicker.set(t.ticker, (byTicker.get(t.ticker) ?? 0) + Number(t.amount));
  const tickers = [...byTicker.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const rows = breakdownRows(txns, posStatus);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="text-muted">By ticker:</span>
        {tickers.map(([t, v]) => (
          <span key={t}>
            {t} <span className={signClass(v)}>{money(v, true)}</span>
          </span>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Ticker</th>
            <th>Strike</th>
            <th>Type</th>
            <th>Action</th>
            <th>Stream</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Premium</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{shortDate(r.date)}</td>
              <td className="font-medium">{r.ticker}</td>
              <td>{r.strike}</td>
              <td>{r.optionType && <OptionTypePill type={r.optionType} />}</td>
              <td>{r.action}</td>
              <td>
                <StreamDot color={streamColor.get(r.stream_id)} />
                {r.stream_name}
              </td>
              <td>{num(r.quantity)}</td>
              <td>{money(r.price)}</td>
              <td className={signClass(r.amount)}>{money(r.amount)}</td>
              <td>{r.status && <StatusPill status={r.status} label={OUTCOME_LABEL[r.status]} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Everything that happened in one wheel cycle, newest first. */
function CycleStory({ cycle: c }: { cycle: Cycle }) {
  const strikes = (ch: Chain) =>
    ch.legs.map((l) => `${num(l.strike)}${l.option_type === "put" ? "P" : "C"} ×${num(l.quantity)}`).join(" → ");
  const rows = [
    ...c.puts.map((ch) => ({
      key: ch.id,
      date: ch.opened,
      type: "put" as const,
      what: strikes(ch),
      outcome: <StatusPill status={ch.outcome} label={OUTCOME_LABEL[ch.outcome]} />,
      amount: ch.net,
    })),
    ...c.calls.map((ch) => ({
      key: ch.id,
      date: ch.opened,
      type: "call" as const,
      what: strikes(ch),
      outcome: <StatusPill status={ch.outcome} label={OUTCOME_LABEL[ch.outcome]} />,
      amount: ch.net,
    })),
    ...c.lots.map((l) => {
      const q = Number(l.quantity);
      const cost = q ? Number(l.debits) / q : 0;
      const sold = q - Number(l.open_quantity);
      const avgSale = sold ? Number(l.credits) / sold : 0;
      return {
        key: l.id,
        date: etDate(l.opened_at),
        type: null,
        what: `${num(q, 0)} sh @ ${money(cost)}${sold ? ` → sold ${num(sold, 0)} @ ${money(avgSale)}` : ""}`,
        outcome: <StatusPill status={l.status === "open" ? "open" : "closed"} label={l.status === "open" ? "holding" : "sold"} />,
        amount: sold ? Number(l.credits) - cost * sold : 0,
      };
    }),
  ].sort((a, b) => b.date.localeCompare(a.date)); // newest first

  return (
    <div className="space-y-2">
      {c.status === "open" && c.adjustedBasis !== null && (
        <p className="text-xs">
          Holding {num(c.sharesHeld, 0)} sh · cost at strike {money(c.openCost / c.sharesHeld)}/sh · premium collected{" "}
          {money(c.putPremium + c.callPremium, true)} →{" "}
          <span className="font-medium">adjusted basis {money(c.adjustedBasis)}/sh</span>
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Leg</th>
            <th>Contracts / shares</th>
            <th>Outcome</th>
            <th>P&L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{shortDate(r.date)}</td>
              <td>{r.type ? <OptionTypePill type={r.type} /> : <span className="pill border border-border">Shares</span>}</td>
              <td className="!text-left">{r.what}</td>
              <td>{r.outcome}</td>
              <td className={signClass(r.amount)}>{money(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The trades (roll chains) behind a ticker row. */
function ChainList({ chains }: { chains: Chain[] }) {
  if (!chains.length) return <p className="text-xs text-muted">No closed trades in this period.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Opened</th>
          <th>Closed</th>
          <th>Type</th>
          <th>Contracts</th>
          <th>Account</th>
          <th>Outcome</th>
          <th>Rolls</th>
          <th>Net</th>
          <th>Return</th>
        </tr>
      </thead>
      <tbody>
        {chains.map((c) => (
          <tr key={c.id}>
            <td>{shortDate(c.opened)}</td>
            <td>{shortDate(c.closed)}</td>
            <td>{c.strategy}</td>
            <td className="min-w-[14rem] !text-left !whitespace-normal">
              {c.legs.map((l, i) => (
                <span key={l.id} className="inline-block whitespace-nowrap">
                  {i > 0 && <span className="mx-1 text-muted">→</span>}
                  {num(l.strike)}
                  {l.option_type === "put" ? "P" : "C"} {shortDate(l.expiration)} ×{num(l.quantity)}
                </span>
              ))}
            </td>
            <td>{c.account_name}</td>
            <td>
              <StatusPill status={c.outcome} />
            </td>
            <td>{c.rolls || ""}</td>
            <td className={signClass(c.net)}>{money(c.net)}</td>
            <td>{c.collateral ? pct(c.net / c.collateral, 2) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
