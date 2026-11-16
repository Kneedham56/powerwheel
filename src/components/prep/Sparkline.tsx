"use client";

import { Line, LineChart, ReferenceLine, ResponsiveContainer, YAxis } from "recharts";

/** A small trend line with the levels that would flip the gauge (green = better, red = worse). */
export function Sparkline({ data, good, bad }: { data: { d: string; v: number }[]; good: number | null; bad: number | null }) {
  if (data.length < 2) return <div className="h-14" />;
  const vals = data.map((p) => p.v).concat([good, bad].filter((v): v is number => v !== null));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
  return (
    <div className="h-14 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <YAxis hide domain={[lo - pad, hi + pad]} />
          {good !== null && <ReferenceLine y={good} stroke="var(--gain)" strokeDasharray="3 3" />}
          {bad !== null && <ReferenceLine y={bad} stroke="var(--loss)" strokeDasharray="3 3" />}
          <Line type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
