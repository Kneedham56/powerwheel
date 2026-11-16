"use client";

import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, LabelList } from "recharts";

export interface MapPoint {
  symbol: string;
  name: string;
  x: number; // 13-week strength vs SPY
  y: number; // 4-week momentum vs SPY
  quadrant: string;
}

const COLOR: Record<string, string> = {
  Leading: "var(--gain)",
  Improving: "var(--accent)",
  Weakening: "#d97706",
  Lagging: "var(--muted)",
};

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;

export function RotationMap({ points }: { points: MapPoint[] }) {
  if (!points.length) return <div className="flex h-72 items-center justify-center text-sm text-muted">No rotation data</div>;
  const groups = Object.keys(COLOR).map((q) => ({ q, data: points.filter((p) => p.quadrant === q) }));
  return (
    <div className="h-[26rem] w-full">
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 16, right: 24, bottom: 24, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            type="number"
            dataKey="x"
            name="13 weeks vs SPY"
            tickFormatter={pct}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            stroke="var(--border)"
            label={{ value: "13-week strength vs S&P 500 →", position: "insideBottomRight", offset: -12, fontSize: 11, fill: "var(--muted)" }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="4 weeks vs SPY"
            tickFormatter={pct}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            stroke="var(--border)"
            width={48}
            label={{ value: "4-week momentum →", angle: -90, position: "insideLeft", fontSize: 11, fill: "var(--muted)" }}
          />
          <ReferenceLine x={0} stroke="var(--muted)" />
          <ReferenceLine y={0} stroke="var(--muted)" />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={({ payload }) => {
              const p = payload?.[0]?.payload as MapPoint | undefined;
              if (!p) return null;
              return (
                <div className="rounded-md border border-border bg-surface px-2 py-1 text-xs shadow">
                  <div className="font-medium">
                    {p.symbol} · {p.name}
                  </div>
                  <div className="text-muted">
                    13 wk {pct(p.x)} · 4 wk {pct(p.y)} · {p.quadrant}
                  </div>
                </div>
              );
            }}
          />
          {groups.map((g) => (
            <Scatter key={g.q} name={g.q} data={g.data} fill={COLOR[g.q]}>
              <LabelList dataKey="symbol" position="right" style={{ fontSize: 10, fill: "var(--foreground)" }} />
            </Scatter>
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
