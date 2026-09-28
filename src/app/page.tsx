import type { ReactNode } from "react";
import { Chips, Flash, PageTitle, Stat, StatusPill, StreamDot, param } from "@/components/ui";
import { WeeklyChart, type WeeklyPoint } from "@/components/WeeklyChart";
import { loadAll } from "@/lib/db";
import { ACTION_LABEL, contractLabel, money, num, pct, shortDate, signClass } from "@/lib/format";
import {
  chainsByGroup,
  etDate,
  groupChains,
  resolvePeriod,
  summarize,
  todayEt,
  weekTransactions,
  weekly,
  type Chain,
  type GroupRow,
} from "@/lib/reports";
import type { TransactionRow } from "@/lib/types";

export default async function ReportsPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const { accounts, streams, positions, transactions, snapshots } = await loadAll();

  const period = resolvePeriod(param(sp, "period"));
  const scope = { streamId: param(sp, "stream"), accountId: param(sp, "account") };
  const s = summarize(positions, transactions, snapshots, period, scope);
  const weeks = weekly(transactions, snapshots, period, scope);
  const weekTxns = weekTransactions(transactions, period, scope);
  const tickerChains = chainsByGroup(positions, period, scope, "ticker");
  const streamColor = new Map(streams.map((st) => [st.id, st.color]));

  const years = [...new Set(transactions.map((t) => etDate(t.occurred_at).slice(0, 4)))].sort().reverse();
  const periodOptions = [
    { value: "", label: "YTD" },
    { value: "30d", label: "30D" },
    { value: "90d", label: "90D" },
    { value: "12m", label: "12M" },
    ...years.filter((y) => y !== todayEt().slice(0, 4)).map((y) => ({ value: y, label: y })),
    { value: "all", label: "All time" },
  ];

  const chartStreams = streams.map((st) => ({ name: st.name, color: st.color ?? "#888" }));
  const chartData: WeeklyPoint[] = weeks.map((w) => ({ week: w.week, cumulative: w.cumulative, ...w.byStream }));

  const empty = positions.length === 0;

  return (
    <div className="space-y-6">
      <Flash sp={sp} />
      <PageTitle>Reports · {period.label}</PageTitle>

      <div className="card space-y-2">
        <Chips sp={sp} path="/" name="period" options={periodOptions} />
        <Chips
          sp={sp}
          path="/"
          name="stream"
          options={[{ value: "", label: "All streams" }, ...streams.map((st) => ({ value: st.id, label: st.name }))]}
        />
        <Chips
          sp={sp}
          path="/"
          name="account"
          options={[{ value: "", label: "All accounts" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
        />
      </div>

      {empty && (
        <div className="card text-sm text-muted">
          No trades yet. Add one on <a className="text-accent underline" href="/trades/new">New trade</a>, or run the
          Robinhood sync (see README).
        </div>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
          label="Win rate"
          value={pct(s.winRate)}
          sub={`${s.wins}W / ${s.losses}L of ${s.chainsClosed} closed trades`}
        />
        <Stat
          label="Net premium (cash)"
          value={money(s.netPremium, true)}
          tone={signClass(s.netPremium)}
          sub={`${money(s.premiumCollected, true)} sold − ${money(s.buybackCost, true)} bought back`}
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
          label="Gains vs losses"
          value={
            <span className="text-base">
              <span className="text-gain">{money(s.grossGains, true)}</span> /{" "}
              <span className="text-loss">{money(s.grossLosses, true)}</span>
            </span>
          }
          sub={`Avg win ${money(s.avgWin, true)} · avg loss ${money(s.avgLoss, true)} · worst ${money(s.largestLoss, true)}`}
        />
        <Stat
          label="Open now"
          value={`${s.openChains} trades`}
          sub={`${money(s.openCollateral, true)} collateral · ${money(s.openPremium, true)} premium held`}
        />
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
            <span>Expiring week</span>
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
              <WeekBreakdown txns={weekTxns.get(w.week) ?? []} streamColor={streamColor} />
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
  contract: string;
  action: string;
  stream_id: string;
  stream_name: string;
  quantity: number;
  price: number; // per share; net per share for rolls
  amount: number;
}

/** One row per trade, except a roll, which collapses to one net row: old contract(s) → new. */
function breakdownRows(txns: TransactionRow[]): BreakdownRow[] {
  const rolls = new Map<string, TransactionRow[]>();
  const rows: BreakdownRow[] = [];
  for (const t of txns) {
    if (t.roll_group_id) rolls.set(t.roll_group_id, [...(rolls.get(t.roll_group_id) ?? []), t]);
    else
      rows.push({
        key: t.id,
        date: t.occurred_at,
        contract: contractLabel(t),
        action: ACTION_LABEL[t.action] ?? t.action,
        stream_id: t.stream_id,
        stream_name: t.stream_name,
        quantity: Number(t.quantity),
        price: Number(t.price),
        amount: Number(t.amount),
      });
  }
  for (const [id, legs] of rolls) {
    const closes = legs.filter((l) => l.action === "buy_to_close" || l.action === "sell_to_close");
    const opens = legs.filter((l) => l.action === "sell_to_open" || l.action === "buy_to_open");
    const qty = opens.reduce((s, l) => s + Number(l.quantity), 0) || closes.reduce((s, l) => s + Number(l.quantity), 0);
    const amount = legs.reduce((s, l) => s + Number(l.amount), 0);
    const label = (ls: TransactionRow[]) => [...new Set(ls.map((l) => contractLabel(l)))].join(" + ");
    rows.push({
      key: id,
      date: legs.map((l) => l.occurred_at).sort()[0],
      contract: opens.length && closes.length ? `${label(closes)} → ${label(opens)}` : label(legs),
      action: opens.length && closes.length ? (amount >= 0 ? "Roll (credit)" : "Roll (debit)") : "Roll (partial)",
      stream_id: legs[0].stream_id,
      stream_name: legs[0].stream_name,
      quantity: qty,
      price: qty ? amount / (qty * 100) : 0,
      amount,
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** What made up a week, in trade order. Rolls show as their net credit/debit. */
function WeekBreakdown({ txns, streamColor }: { txns: TransactionRow[]; streamColor: Map<string, string | null> }) {
  if (!txns.length) return <p className="text-xs text-muted">No option cash flow this week.</p>;
  const byTicker = new Map<string, number>();
  for (const t of txns) byTicker.set(t.ticker, (byTicker.get(t.ticker) ?? 0) + Number(t.amount));
  const tickers = [...byTicker.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const rows = breakdownRows(txns);

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
            <th>Contract</th>
            <th>Action</th>
            <th>Stream</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Cash</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{shortDate(r.date)}</td>
              <td className="!whitespace-normal">{r.contract}</td>
              <td>{r.action}</td>
              <td>
                <StreamDot color={streamColor.get(r.stream_id)} />
                {r.stream_name}
              </td>
              <td>{num(r.quantity)}</td>
              <td>{money(r.price)}</td>
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
