"use client";

import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface RacePoint {
  label: string;
  date: string;
  ai: number;
  kyle: number | null;
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

/** Cumulative return by week for both sides, from the start (week 0). */
export function RaceChart({ data }: { data: RacePoint[] }) {
  if (data.length < 2) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted">The first point lands after the first Friday.</div>;
  }
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--border)" />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={pct} stroke="var(--border)" width={56} />
          <ReferenceLine y={0} stroke="var(--muted)" strokeDasharray="4 4" />
          <Tooltip
            formatter={(v) => pct(Number(v))}
            labelFormatter={(l, p) => `${l}${p?.[0]?.payload?.date ? `, ${p[0].payload.date}` : ""}`}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="linear" dataKey="ai" name="AI (paper)" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} />
          <Line type="linear" dataKey="kyle" name="Kyle (Individual)" stroke="var(--foreground)" strokeWidth={2} dot={{ r: 3 }} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
