import { OptionTypePill, StatusPill } from "@/components/ui";
import { money, pct, shortDate } from "@/lib/format";
import type { Trade } from "@/lib/race";

/**
 * A paper week's trades: by ticker (or, for a backtest week, the shares held at Friday's close), then one row per
 * position (its sale netted against any buyback), with skipped picks collapsed into one line. Shared by the AI race
 * page and the Skynet backtest page so both read the same way.
 */

/** Shares of a name held at a week's Friday close (Skynet runs record it per week). */
export interface Holding {
  symbol: string;
  shares: number;
  price: number;
}

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const px = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const tone = (n: number | null | undefined) => (!n ? "" : n > 0 ? "text-gain" : "text-loss");

interface PositionRow {
  key: string;
  date: string;
  ticker: string;
  strike: number | null;
  type: Trade["type"];
  qty: number;
  price: number | null;
  closePrice: number | null;
  /** premium sold minus anything bought back */
  net: number | null;
  collateral: number | null;
  outcome: { status: string; label?: string };
}

const OPENS = new Set(["Sold put", "Sold call"]);

/** One row per paper position, its sale netted against any buyback, like the Reports page's weekly detail. */
function positionRows(trades: Trade[]): PositionRow[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    if (t.action === "Skipped") continue;
    const k = t.position_id ?? t.id;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const rows: PositionRow[] = [];
  for (const [key, legs] of groups) {
    const opens = legs.filter((l) => OPENS.has(l.action));
    const buys = legs.filter((l) => l.action === "Bought back");
    const sales = legs.filter((l) => l.action === "Sold shares");
    const first = opens[0] ?? legs[0];
    const qty = opens.reduce((a, l) => a + (l.qty ?? 0), 0) || (first.qty ?? 0);
    const wavg = (ls: Trade[]) => {
      const q = ls.reduce((a, l) => a + (l.qty ?? 0), 0);
      return q ? ls.reduce((a, l) => a + (l.price ?? 0) * (l.qty ?? 0), 0) / q : null;
    };
    const has = (a: string) => legs.some((l) => l.action === a);
    const isOption = first.type === "put" || first.type === "call";
    const outcome = buys.length
      ? { status: "closed", label: "bought back" }
      : has("Called away")
        ? { status: "assigned", label: "called away" }
        : has("Assigned")
          ? { status: "assigned" }
          : has("Expired")
            ? { status: "expired" }
            : has("Sold shares")
              ? { status: "closed", label: "sold" }
              : { status: "open" };
    rows.push({
      key,
      date: legs.map((l) => l.date).sort()[0],
      ticker: first.symbol ?? "",
      strike: first.strike,
      type: first.type,
      qty,
      price: opens.length ? wavg(opens) : first.price,
      closePrice: buys.length ? wavg(buys) : !isOption && sales.length && legs.some((l) => (l.action as string) === "Bought shares") ? wavg(sales) : null,
      net: isOption ? [...opens, ...buys].reduce((a, l) => a + (l.cash ?? 0), 0) : null,
      collateral: isOption && first.strike ? first.strike * 100 * qty : null,
      outcome,
    });
  }
  const typeOrder = (t: Trade["type"]) => (t === "put" ? 0 : t === "call" ? 1 : 2);
  return rows.sort((a, b) => typeOrder(a.type) - typeOrder(b.type) || (b.net ?? 0) - (a.net ?? 0));
}

export function WeekTrades({ trades, title = "AI trades", holdings }: { trades: Trade[]; title?: string; holdings?: Holding[] | null }) {
  const rows = positionRows(trades);
  const skipped = [...new Set(trades.filter((t) => t.action === "Skipped" && t.symbol).map((t) => t.symbol as string))];
  if (!rows.length && !skipped.length && !holdings?.length) return null;
  const byTicker = new Map<string, number>();
  for (const r of rows) if (r.net !== null) byTicker.set(r.ticker, (byTicker.get(r.ticker) ?? 0) + r.net);
  const tickers = [...byTicker.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">{title}</div>
      {holdings ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="text-muted">Held at the Friday close:</span>
          {holdings.length ? (
            holdings.map((h) => (
              <span key={h.symbol}>
                <span className="font-medium">{h.symbol}</span> {px(h.shares)} <span className="text-muted">@</span> {money(h.price)}
              </span>
            ))
          ) : (
            <span className="text-muted">no shares</span>
          )}
        </div>
      ) : tickers.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="text-muted">By ticker:</span>
          {tickers.map(([t, v]) => (
            <span key={t}>
              {t} <span className={tone(v)}>{usd(v)}</span>
            </span>
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Ticker</th>
              <th>Strike</th>
              <th>Type</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Net premium</th>
              <th>ROC</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{shortDate(r.date)}</td>
                <td className="font-medium">{r.ticker}</td>
                <td>{px(r.strike)}</td>
                <td>{r.type === "put" || r.type === "call" ? <OptionTypePill type={r.type} /> : <span className="pill border border-border">Shares</span>}</td>
                <td>{px(r.qty)}</td>
                <td>{r.closePrice !== null ? `${money(r.price ?? 0)} → ${money(r.closePrice)}` : r.price !== null ? money(r.price) : "—"}</td>
                <td className={tone(r.net)}>{r.net !== null ? money(r.net) : "—"}</td>
                <td className={tone(r.net)}>{r.net !== null && r.collateral ? pct(r.net / r.collateral, 2) : "—"}</td>
                <td>
                  <StatusPill status={r.outcome.status} label={r.outcome.label} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {skipped.length > 0 && <p className="text-xs text-muted">Skipped by the rules: {skipped.join(", ")}</p>}
    </div>
  );
}
