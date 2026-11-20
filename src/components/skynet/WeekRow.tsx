"use client";

import { useState, type ReactNode } from "react";
import { OptionTypePill } from "@/components/ui";
import type { Trade } from "@/lib/race";
import { dayLabel } from "@/lib/rules";

const px = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const tone = (n: number | null | undefined) => (!n ? "" : n > 0 ? "text-gain" : "text-loss");

/** A week's row; opening it loads that week's trades from the run (so the page doesn't carry every trade up front). */
export function WeekRow({ cols, cells, runId, week, note }: { cols: string; cells: ReactNode[]; runId: string; week: number; note: string }) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (trades || error) return;
    try {
      const r = await fetch(`/skynet/trades?${new URLSearchParams({ run: runId, week: String(week) })}`);
      const j = (await r.json()) as { trades?: Trade[]; error?: string };
      if (j.trades) setTrades(j.trades);
      else setError(j.error ?? "Couldn't load the trades.");
    } catch {
      setError("Couldn't load the trades.");
    }
  };
  return (
    <details className="group" onToggle={(e) => (e.currentTarget.open ? load() : undefined)}>
      <summary className={`grow ${cols}`}>
        <span className="text-muted transition-transform group-open:rotate-90">▸</span>
        {cells.map((c, i) => (
          <span key={i} className={i === 0 ? "text-left font-medium" : undefined}>
            {c}
          </span>
        ))}
      </summary>
      <div className="drill">
        {note && <p className="mb-2 text-xs text-muted">{note}</p>}
        {error ? <p className="text-xs text-loss">{error}</p> : trades ? <WeekTrades trades={trades} /> : <p className="text-xs text-muted">Loading…</p>}
      </div>
    </details>
  );
}

function WeekTrades({ trades }: { trades: Trade[] }) {
  const done = trades.filter((t) => t.action !== "Skipped");
  const skipped = trades.filter((t) => t.action === "Skipped");
  return (
    <div className="space-y-2">
      {done.length > 0 ? <TradeTable trades={done} /> : <p className="text-xs text-muted">No trades this week.</p>}
      {skipped.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
            {skipped.length} candidate{skipped.length > 1 ? "s" : ""} skipped
          </summary>
          <div className="mt-1">
            <TradeTable trades={skipped} />
          </div>
        </details>
      )}
    </div>
  );
}

function TradeTable({ trades }: { trades: Trade[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Day</th>
          <th>Action</th>
          <th>Ticker</th>
          <th>Type</th>
          <th>Strike</th>
          <th>Expires</th>
          <th>Qty</th>
          <th>Price</th>
          <th>Bid / ask</th>
          <th>Cash</th>
          <th className="text-left!">Why</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id}>
            <td>{dayLabel(t.date)}</td>
            <td className="font-medium">{t.action}</td>
            <td className="font-medium">{t.symbol ?? "—"}</td>
            <td>{t.type === "put" || t.type === "call" ? <OptionTypePill type={t.type} /> : (t.type ?? "")}</td>
            <td>{px(t.strike)}</td>
            <td>{t.expiration ? dayLabel(t.expiration) : "—"}</td>
            <td>{t.qty ?? "—"}</td>
            <td>{px(t.price)}</td>
            <td>{t.bid !== null || t.ask !== null ? `${px(t.bid)} / ${px(t.ask)}` : "—"}</td>
            <td className={tone(t.cash)}>{t.cash === null ? "—" : usd(t.cash)}</td>
            <td className="max-w-[28rem] text-left! whitespace-normal! text-muted">{t.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
