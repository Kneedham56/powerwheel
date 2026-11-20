"use client";

import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface EquityPoint {
  date: string;
  value: number;
  spy: number | null;
}

const usdK = (v: number) => `$${Math.round(v / 1000)}k`;
const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Account value each Friday for the ruleset and for SPY buy and hold, from the same starting capital. */
export function SkynetChart({ data, name, capital }: { data: EquityPoint[]; name: string; capital: number }) {
  if (data.length < 2) return <div className="flex h-64 items-center justify-center text-sm text-muted">Not enough weeks to chart.</div>;
  const yearTicks = data.filter((p, i) => i === 0 || p.date.slice(0, 4) !== data[i - 1].date.slice(0, 4)).map((p) => p.date);
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="date" ticks={yearTicks} tickFormatter={(d: string) => d.slice(0, 4)} tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--border)" />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={usdK} stroke="var(--border)" width={56} domain={["auto", "auto"]} />
          <ReferenceLine y={capital} stroke="var(--muted)" strokeDasharray="4 4" />
          <Tooltip
            formatter={(v) => usd(Number(v))}
            labelFormatter={(l) => `Week ending ${l}`}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="linear" dataKey="value" name={name} stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="linear" dataKey="spy" name="SPY buy and hold" stroke="var(--foreground)" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A run picker: changes ?run= on select. */
export function RunPicker({ runs, current }: { runs: { id: string; label: string }[]; current: string }) {
  return (
    <select
      className="input w-auto"
      value={current}
      onChange={(e) => {
        const u = new URL(window.location.href);
        u.searchParams.set("run", e.target.value);
        window.location.assign(u.toString());
      }}
    >
      {runs.map((r) => (
        <option key={r.id} value={r.id}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
