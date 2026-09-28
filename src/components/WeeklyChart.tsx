"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface WeeklyPoint {
  week: string;
  cumulative: number;
  [stream: string]: number | string;
}

const money0 = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function WeeklyChart({ data, streams }: { data: WeeklyPoint[]; streams: { name: string; color: string }[] }) {
  if (!data.length) {
    return <div className="flex h-72 items-center justify-center text-sm text-muted">No option activity in this period</div>;
  }
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="week"
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            tickFormatter={(w: string) => w.slice(5)}
            stroke="var(--border)"
          />
          <YAxis yAxisId="w" tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={money0} stroke="var(--border)" width={70} />
          <YAxis
            yAxisId="c"
            orientation="right"
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            tickFormatter={money0}
            stroke="var(--border)"
            width={80}
          />
          <Tooltip
            formatter={(v) => money0(Number(v))}
            labelFormatter={(w) => `Week of ${w}`}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {streams.map((s) => (
            <Bar key={s.name} yAxisId="w" dataKey={s.name} stackId="w" fill={s.color} maxBarSize={28} />
          ))}
          <Line
            yAxisId="c"
            type="monotone"
            dataKey="cumulative"
            name="Cumulative"
            stroke="var(--foreground)"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
