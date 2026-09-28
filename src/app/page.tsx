import { Chips, Flash, PageTitle, Stat, StatusPill, StreamDot, param } from "@/components/ui";
import { WeeklyChart, type WeeklyPoint } from "@/components/WeeklyChart";
import { loadAll } from "@/lib/db";
import { money, pct, shortDate, signClass } from "@/lib/format";
import {
  buildChains,
  etDate,
  groupChains,
  resolvePeriod,
  scopePositions,
  summarize,
  todayEt,
  weekly,
  type GroupRow,
} from "@/lib/reports";

export default async function ReportsPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const { accounts, streams, positions, transactions, snapshots } = await loadAll();

  const period = resolvePeriod(param(sp, "period"));
  const scope = { streamId: param(sp, "stream"), accountId: param(sp, "account") };
  const s = summarize(positions, transactions, snapshots, period, scope);
  const weeks = weekly(transactions, snapshots, period, scope);

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
  const recent = buildChains(scopePositions(positions, scope))
    .filter((c) => c.closed && (!period.from || c.closed >= period.from) && c.closed <= period.to)
    .sort((a, b) => (b.closed ?? "").localeCompare(a.closed ?? ""))
    .slice(0, 15);

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
          <span className="text-xs text-muted">premium sold − buybacks, by week opened/closed · line = cumulative</span>
        </div>
        <WeeklyChart data={chartData} streams={chartStreams} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <GroupTable title="By stream" rows={groupChains(positions, period, scope, "stream", streams)} dot />
        <GroupTable title="By strategy" rows={groupChains(positions, period, scope, "strategy")} />
      </div>
      <GroupTable title="By ticker" rows={groupChains(positions, period, scope, "ticker")} />

      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-medium">Weekly detail</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Week of</th>
              <th className="num">Net premium</th>
              <th className="num">Account value</th>
              <th className="num">Weekly return</th>
              <th className="num">Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {[...weeks].reverse().map((w) => (
              <tr key={w.week}>
                <td>{shortDate(w.week)}</td>
                <td className={`num ${signClass(w.net)}`}>{money(w.net)}</td>
                <td className="num">{money(w.capital, true)}</td>
                <td className="num">{pct(w.returnPct, 2)}</td>
                <td className="num">{money(w.cumulative, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-medium">Recently closed</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Closed</th>
              <th>Trade</th>
              <th>Stream</th>
              <th>Outcome</th>
              <th className="num">Rolls</th>
              <th className="num">Net</th>
              <th className="num">Return</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((c) => (
              <tr key={c.id}>
                <td>{shortDate(c.closed)}</td>
                <td>
                  {c.ticker} {c.strategy}
                </td>
                <td>{c.stream_name}</td>
                <td>
                  <StatusPill status={c.outcome} />
                </td>
                <td className="num">{c.rolls || ""}</td>
                <td className={`num ${signClass(c.net)}`}>{money(c.net)}</td>
                <td className="num">{c.collateral ? pct(c.net / c.collateral, 2) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function GroupTable({ title, rows, dot }: { title: string; rows: GroupRow[]; dot?: boolean }) {
  return (
    <section className="card overflow-x-auto">
      <h2 className="mb-2 font-medium">{title}</h2>
      <table className="table">
        <thead>
          <tr>
            <th></th>
            <th className="num">Trades</th>
            <th className="num">Win rate</th>
            <th className="num">Assigned</th>
            <th className="num">Rolls</th>
            <th className="num">Avg return</th>
            <th className="num">Net P&L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="font-medium">
                {dot && <StreamDot color={r.color} />}
                {r.label}
              </td>
              <td className="num">{r.chains}</td>
              <td className="num">{pct(r.winRate)}</td>
              <td className="num">{r.assigned}</td>
              <td className="num">{r.rolls}</td>
              <td className="num">{pct(r.avgReturnOnCollateral, 2)}</td>
              <td className={`num ${signClass(r.net)}`}>{money(r.net)}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={7} className="text-muted">
                Nothing closed in this period
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
