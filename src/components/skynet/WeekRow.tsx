"use client";

import { useState, type ReactNode } from "react";
import { WeekTrades } from "@/components/race/WeekTrades";
import type { Trade } from "@/lib/race";

/**
 * A backtest week's row; opening it loads that week's trades from the run (so the page doesn't carry every trade up
 * front) and shows them the way the AI race page does.
 */
export function WeekRow({ cols, cells, runId, week, note, title }: { cols: string; cells: ReactNode[]; runId: string; week: number; note: string; title: string }) {
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
      <div className="drill space-y-3">
        {note && <p className="text-xs text-muted">{note}</p>}
        {error ? (
          <p className="text-xs text-loss">{error}</p>
        ) : !trades ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : trades.length ? (
          <WeekTrades trades={trades} title={title} />
        ) : (
          <p className="text-xs text-muted">No trades this week.</p>
        )}
      </div>
    </details>
  );
}
