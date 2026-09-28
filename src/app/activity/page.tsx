import { Chips, PageTitle, StreamDot, param } from "@/components/ui";
import { loadAll } from "@/lib/db";
import { contractLabel, money, num, shortDate, signClass } from "@/lib/format";
import { etDate, resolvePeriod } from "@/lib/reports";

const ACTION_LABEL: Record<string, string> = {
  sell_to_open: "Sell to open",
  buy_to_close: "Buy to close",
  buy_to_open: "Buy to open",
  sell_to_close: "Sell to close",
  expire: "Expired",
  assign: "Assigned",
  buy: "Buy shares",
  sell: "Sell shares",
};

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const sp = await searchParams;
  const { streams, transactions } = await loadAll();
  const period = resolvePeriod(param(sp, "period") ?? "all");
  const streamId = param(sp, "stream");

  const rows = transactions.filter((t) => {
    const d = etDate(t.occurred_at);
    return (!period.from || d >= period.from) && d <= period.to && (!streamId || t.stream_id === streamId);
  });
  const streamColor = new Map(streams.map((s) => [s.id, s.color]));
  const total = rows.reduce((s, t) => s + Number(t.amount), 0);

  return (
    <div className="space-y-4">
      <PageTitle>Activity</PageTitle>
      <div className="card space-y-2">
        <Chips
          sp={sp}
          path="/activity"
          name="period"
          options={[
            { value: "", label: "All" },
            { value: "ytd", label: "YTD" },
            { value: "30d", label: "30D" },
            { value: "90d", label: "90D" },
          ]}
        />
        <Chips
          sp={sp}
          path="/activity"
          name="stream"
          options={[{ value: "", label: "All streams" }, ...streams.map((s) => ({ value: s.id, label: s.name }))]}
        />
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Action</th>
              <th>Contract</th>
              <th>Stream</th>
              <th className="num">Qty</th>
              <th className="num">Price</th>
              <th className="num">Fees</th>
              <th className="num">Cash</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>{shortDate(t.occurred_at)}</td>
                <td>
                  {ACTION_LABEL[t.action] ?? t.action}
                  {t.roll_group_id && <span className="ml-1 text-xs text-muted">(roll)</span>}
                </td>
                <td>{contractLabel(t)}</td>
                <td>
                  <StreamDot color={streamColor.get(t.stream_id)} />
                  {t.stream_name}
                </td>
                <td className="num">{num(t.quantity)}</td>
                <td className="num">{money(t.price)}</td>
                <td className="num">{t.fees ? money(t.fees) : ""}</td>
                <td className={`num ${signClass(t.amount)}`}>{money(t.amount)}</td>
                <td className="text-xs text-muted">{t.source}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7} className="font-medium">
                Net cash, {rows.length} transactions
              </td>
              <td className={`num font-medium ${signClass(total)}`}>{money(total)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
