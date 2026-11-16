import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { param } from "@/components/ui";
import { RotationMap } from "@/components/prep/RotationMap";
import { Sparkline } from "@/components/prep/Sparkline";
import { loadPrep, type LogRow } from "@/lib/prep-db";
import type { CalendarItem, CandidateRow, Check, SundayReport, WatchLevel, WednesdayReport } from "@/lib/prep";
import { dayLabel } from "@/lib/rules";

// Public page: market and watchlist data only (see proxy.ts). Nothing here may describe an account.

export const metadata: Metadata = {
  title: "Weekly prep · PowerWheel",
  description: "What happened last week, what's ahead this week, and where to sell puts.",
};

const spct = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`);
const pctU = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(d)}%`);
const px = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n < 0.1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const sign = (n: number | null | undefined) => (!n ? "" : n > 0 ? "text-gain" : "text-loss");

const QUAD_CLS: Record<string, string> = {
  Leading: "bg-gain/15 text-gain",
  Improving: "bg-accent/15 text-accent",
  Weakening: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  Lagging: "bg-foreground/10 text-muted",
};
const STATUS_CLS: Record<string, string> = {
  green: "bg-gain/15 text-gain",
  yellow: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  red: "bg-loss/15 text-loss",
};
const stageCls = (s: string) =>
  s === "Leader" || s === "Leader pulling back" ? "bg-gain/15 text-gain" : s === "Turning up" ? "bg-accent/15 text-accent" : s === "Breaking down" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : s === "Downtrend" ? "bg-loss/15 text-loss" : "bg-foreground/10 text-muted";
const callCls = (p: number) => (p <= 2 ? "bg-gain/15 text-gain" : p === 3 ? "bg-accent/15 text-accent" : p <= 5 || p === 7 ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : p === 8 || p === 10 ? "bg-loss/15 text-loss" : "bg-foreground/10 text-muted");

function Pill({ children, cls }: { children: ReactNode; cls?: string }) {
  return <span className={`pill whitespace-nowrap ${cls ?? "bg-foreground/10 text-muted"}`}>{children}</span>;
}

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {note && <p className="mt-0.5 max-w-3xl text-sm text-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function weekRange(weekOf: string) {
  const fri = new Date(`${weekOf}T12:00:00Z`);
  fri.setUTCDate(fri.getUTCDate() + 4);
  return `${dayLabel(weekOf)} to ${dayLabel(fri.toISOString().slice(0, 10))}`;
}

export default async function PrepPage({ searchParams }: PageProps<"/prep">) {
  const sp = await searchParams;
  const { sunday, wednesday, weeks, log } = await loadPrep(param(sp, "week"));

  if (!sunday) {
    return (
      <div className="card max-w-xl space-y-2">
        <h1 className="text-xl font-semibold">Weekly prep</h1>
        <p className="text-sm text-muted">No report yet. The first one appears after the Sunday run.</p>
      </div>
    );
  }
  const r = sunday;
  const nav = [
    wednesday && ["midweek", "Midweek check"],
    ["read", "The read"],
    ["last-week", "Last week"],
    ["this-week", "This week"],
    ["picks", "Top picks"],
    ["weather", "Market weather"],
    ["rotation", "Rotation"],
    ["watchlist", "Watchlist + picks"],
    ["scoreboard", "Scoreboard"],
  ].filter(Boolean) as [string, string][];

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Week of {weekRange(r.week_of)}</div>
        <h1 className="max-w-4xl text-2xl font-semibold tracking-tight">{r.narrative.headline}</h1>
        <p className="text-xs text-muted">
          Prices through the {dayLabel(r.as_of)} close · built {dayLabel(r.run_date)} · rules {r.rules_version} · puts expire {dayLabel(r.expiry)}
        </p>
        <nav className="flex flex-wrap gap-1.5">
          {nav.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-full border border-border px-3 py-1 text-xs text-muted hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
      </header>

      {wednesday && <Midweek w={wednesday} />}

      <Section id="read" title="The read">
        <div className="card grid gap-3 text-sm md:grid-cols-3">
          <ReadRow label="Favors" tone="text-gain" text={r.narrative.plain_read.favors} />
          <ReadRow label="Avoid" tone="text-loss" text={r.narrative.plain_read.avoid} />
          <ReadRow label="The watchlist" tone="text-muted" text={r.narrative.plain_read.watchlist} />
        </div>
      </Section>

      <LastWeek r={r} log={log} />
      <ThisWeek r={r} />
      <Picks r={r} />
      <Weather r={r} />
      <Rotation r={r} />
      <Watchlist rows={r.candidates} />
      <Scoreboard log={log} />

      {weeks.length > 1 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted">Earlier weeks</h2>
          <div className="flex flex-wrap gap-1.5">
            {weeks.map((w) => (
              <Link
                key={w}
                href={`/prep?week=${w}`}
                className={`rounded-full border px-3 py-1 text-xs ${w === r.week_of ? "border-accent bg-accent text-white" : "border-border text-muted hover:text-foreground"}`}
              >
                {dayLabel(w)}
              </Link>
            ))}
          </div>
        </section>
      )}
      <p className="text-xs text-muted">
        A rule-of-thumb read of public market data, not advice. The rules are in{" "}
        <a className="underline" href="https://github.com/Kneedham56/powerwheel/blob/main/docs/RULES.md">docs/RULES.md</a>.
      </p>
    </div>
  );
}

function ReadRow({ label, tone, text }: { label: string; tone: string; text: string }) {
  return (
    <div>
      <div className={`mb-1 text-xs font-medium uppercase tracking-wide ${tone}`}>{label}</div>
      <p>{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Midweek({ w }: { w: WednesdayReport }) {
  return (
    <Section id="midweek" title={`Midweek check · ${dayLabel(w.run_date)}`} note={`Prices through the ${dayLabel(w.as_of)} close, compared with Sunday's report.`}>
      <div className="card space-y-3 border-accent/40">
        <p className="text-base font-medium">{w.narrative.headline}</p>
        <div className="grid gap-3 text-sm md:grid-cols-3">
          <ReadRow label="So far" tone="text-muted" text={w.narrative.so_far} />
          <ReadRow label="What's left" tone="text-muted" text={w.narrative.whats_left} />
          <ReadRow label="Into Friday" tone="text-muted" text={w.narrative.outlook} />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h3 className="mb-2 text-sm font-medium">Levels we&apos;re watching</h3>
          <Levels levels={w.watch_levels} showChange />
        </div>
        <div className="space-y-4">
          <div className="card">
            <h3 className="mb-2 text-sm font-medium">Since Sunday</h3>
            <table className="w-full text-sm tabular-nums">
              <tbody>
                {w.indices.map((i) => (
                  <tr key={i.symbol} className="border-b border-border last:border-0">
                    <td className="py-1">
                      {i.symbol} <span className="text-xs text-muted">{i.name}</span>
                    </td>
                    <td className={`py-1 text-right ${sign(i.since_sunday)}`}>{spct(i.since_sunday)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {w.picks.length > 0 && (
            <div className="card">
              <h3 className="mb-2 text-sm font-medium">Sunday&apos;s picks</h3>
              <div className="flex flex-wrap gap-1.5">
                {w.picks.map((p) => (
                  <Pill key={p.symbol} cls={p.status === "safe" ? "bg-gain/15 text-gain" : p.status === "close" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : p.status === "under" ? "bg-loss/15 text-loss" : undefined}>
                    {p.symbol} {p.strike}p · {p.status === "under" ? "under the strike" : p.status === "close" ? "within 1 ATR" : p.status === "safe" ? `${pctU(p.cushion)} cushion` : "no price"}
                  </Pill>
                ))}
              </div>
            </div>
          )}
          {(w.rotation_changes.length > 0 || w.movers.length > 0) && (
            <div className="card space-y-2 text-sm">
              {w.rotation_changes.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted">Rotation moves since Sunday</div>
                  <div className="flex flex-wrap gap-1.5">
                    {w.rotation_changes.map((c) => (
                      <Pill key={c.symbol} cls={QUAD_CLS[c.to]}>
                        {c.name}: {c.from} → {c.to}
                      </Pill>
                    ))}
                  </div>
                </div>
              )}
              {w.movers.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted">Biggest watchlist moves since Sunday</div>
                  <div className="flex flex-wrap gap-1.5">
                    {w.movers.map((m) => (
                      <Pill key={m.symbol} cls={m.since_sunday >= 0 ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss"}>
                        {m.symbol} {spct(m.since_sunday)}
                      </Pill>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {w.calendar.length > 0 && (
        <div className="card">
          <h3 className="mb-2 text-sm font-medium">Still ahead this week</h3>
          <Calendar items={w.calendar} />
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

function LastWeek({ r, log }: { r: SundayReport; log: LogRow[] }) {
  const changed = r.rotation.filter((x) => x.quadrant_week_ago && x.quadrant_week_ago !== x.quadrant);
  const prevWeek = new Date(`${r.week_of}T12:00:00Z`);
  prevWeek.setUTCDate(prevWeek.getUTCDate() - 7);
  const lastPicks = log.filter((l) => l.week_of === prevWeek.toISOString().slice(0, 10));
  return (
    <Section id="last-week" title="Last week">
      <div className="card space-y-3 text-sm">
        <p>{r.narrative.last_week.summary}</p>
        {r.narrative.last_week.events.length > 0 && (
          <ul className="space-y-1">
            {r.narrative.last_week.events.map((e, i) => (
              <li key={i}>
                <span className="font-medium">{e.title}:</span> <span className="text-muted">{e.result}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-medium">Market</th>
                <th className="py-1 text-right font-medium">Last</th>
                <th className="py-1 text-right font-medium">Week</th>
                <th className="py-1 text-right font-medium">4 weeks</th>
                <th className="py-1 text-right font-medium">vs 50-day</th>
                <th className="py-1 text-right font-medium">vs 200-day</th>
              </tr>
            </thead>
            <tbody>
              {r.indices.map((i) => (
                <tr key={i.symbol} className="border-t border-border">
                  <td className="py-1">
                    {i.symbol} <span className="text-xs text-muted">{i.name}</span>
                  </td>
                  <td className="py-1 text-right">{px(i.last)}</td>
                  <td className={`py-1 text-right ${sign(i.week)}`}>{spct(i.week)}</td>
                  <td className={`py-1 text-right ${sign(i.month)}`}>{spct(i.month)}</td>
                  <td className={`py-1 text-right ${sign(i.vs50)}`}>{spct(i.vs50)}</td>
                  <td className={`py-1 text-right ${sign(i.vs200)}`}>{spct(i.vs200)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-4">
          <div className="card text-sm">
            <h3 className="mb-2 text-sm font-medium">Rotation changes this week</h3>
            {changed.length ? (
              <div className="flex flex-wrap gap-1.5">
                {changed.map((c) => (
                  <Pill key={c.symbol} cls={QUAD_CLS[c.quadrant]}>
                    {c.name}: {c.quadrant_week_ago} → {c.quadrant}
                  </Pill>
                ))}
              </div>
            ) : (
              <p className="text-muted">No fund changed quadrant.</p>
            )}
          </div>
          {lastPicks.length > 0 && (
            <div className="card text-sm">
              <h3 className="mb-2 text-sm font-medium">How last week&apos;s picks did</h3>
              <PickResults rows={lastPicks} />
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

function PickResults({ rows }: { rows: LogRow[] }) {
  return (
    <table className="w-full text-sm tabular-nums">
      <tbody>
        {[...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map((l) => (
          <tr key={l.symbol + l.is_baseline} className="border-b border-border last:border-0">
            <td className="py-1">
              {l.is_baseline ? <span className="text-muted">Baseline </span> : `${l.rank}. `}
              {l.symbol} {l.strike}p
            </td>
            <td className="py-1 text-right text-muted">{l.outcome ?? "open"}</td>
            <td className={`py-1 text-right ${sign(l.roc)}`}>{l.roc === null ? "—" : spct(l.roc, 2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------

function ThisWeek({ r }: { r: SundayReport }) {
  const tw = r.narrative.this_week;
  const like: Record<string, string> = { likely: "bg-accent/15 text-accent", possible: "bg-foreground/10 text-muted", "less likely": "bg-foreground/10 text-muted" };
  return (
    <Section id="this-week" title="This week">
      <div className="card space-y-3 text-sm">
        <p>
          <span className="font-medium">Base case: </span>
          {tw.base_case}
        </p>
        {tw.scenarios.length > 0 && (
          <div className="grid gap-3 md:grid-cols-3">
            {tw.scenarios.map((s) => (
              <div key={s.name} className="rounded-md border border-border p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">{s.name}</span>
                  <Pill cls={like[s.likelihood]}>{s.likelihood}</Pill>
                </div>
                <p>{s.what}</p>
                <p className="mt-1 text-xs text-muted">Signs: {s.signals}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="card lg:col-span-3">
          <h3 className="mb-2 text-sm font-medium">Calendar</h3>
          <Calendar items={r.calendar} />
        </div>
        <div className="space-y-4 lg:col-span-2">
          <div className="card">
            <h3 className="mb-2 text-sm font-medium">Levels to watch</h3>
            <Levels levels={r.watch_levels} />
          </div>
          <TechBottom checks={r.tech_bottom} />
        </div>
      </div>
    </Section>
  );
}

function Calendar({ items }: { items: CalendarItem[] }) {
  const days = [...new Set(items.map((i) => i.date))];
  const imp: Record<string, string> = { high: "bg-loss/15 text-loss", medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400", low: "bg-foreground/10 text-muted" };
  return (
    <div className="space-y-3 text-sm">
      {days.map((d) => (
        <div key={d}>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{dayLabel(d)}</div>
          <ul className="space-y-1">
            {items
              .filter((i) => i.date === d)
              .map((i, k) => (
                <li key={k} className={`flex gap-2 rounded px-1 ${i.watchlist ? "bg-gain/5" : ""}`}>
                  <span className="w-16 shrink-0 text-xs text-muted tabular-nums">{i.time}</span>
                  <span className="min-w-0">
                    <span className="font-medium">{i.title}</span> <Pill cls={imp[i.importance]}>{i.importance}</Pill>
                    {i.note && <span className="block text-xs text-muted">{i.note}</span>}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Levels({ levels, showChange }: { levels: (WatchLevel & { was_ok?: boolean | null })[]; showChange?: boolean }) {
  return (
    <table className="w-full text-sm tabular-nums">
      <tbody>
        {levels.map((l, i) => {
          const changed = showChange && l.was_ok !== undefined && l.was_ok !== null && l.ok !== null && l.was_ok !== l.ok;
          return (
            <tr key={i} className="border-b border-border last:border-0" title={l.why}>
              <td className="py-1">{l.label}</td>
              <td className="py-1 text-right text-muted">
                {px(l.last)} vs {px(l.level)}
              </td>
              <td className="py-1 text-right">
                {l.ok === null ? (
                  <Pill>no price</Pill>
                ) : (
                  <Pill cls={l.ok ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss"}>
                    {l.ok ? "holding" : "broken"}
                    {changed ? " (changed)" : ""}
                  </Pill>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TechBottom({ checks }: { checks: Check[] }) {
  const passing = checks.filter((c) => c.pass).length;
  return (
    <div className="card text-sm">
      <h3 className="text-sm font-medium">Tech-bottom checklist · {passing} of {checks.length}</h3>
      <p className="mb-2 text-xs text-muted">When most pass, tech is a trend to ride with closer puts on the leaders. Until then, rallies are bounces to sell premium into.</p>
      <ul className="space-y-1">
        {checks.map((c) => (
          <li key={c.label} className="flex items-start gap-2">
            <span className={c.pass ? "text-gain" : "text-loss"}>{c.pass ? "✓" : "✗"}</span>
            <span>
              {c.label} <span className="text-xs text-muted">· {c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Picks({ r }: { r: SundayReport }) {
  return (
    <Section
      id="picks"
      title="Top picks"
      note={`The five highest-scoring puts for ${dayLabel(r.expiry)}, at most two per sector. Strike: the lower of the floor minus one ATR and one expected move below the price, on a listed strike with a real market. Premium at the mid when the report was built.`}
    >
      {r.picks.length === 0 ? (
        <div className="card text-sm text-muted">No name passed every test this week. Sit in T-bills or wait for a red day.</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {r.picks.map((p) => (
            <div key={p.symbol} className="card space-y-2">
              <div className="flex items-baseline justify-between">
                <div>
                  <span className="text-xs text-muted">#{p.rank}</span> <span className="text-lg font-semibold">{p.symbol}</span>
                </div>
                <Pill cls="bg-accent/15 text-accent">score {p.score}</Pill>
              </div>
              <div className="text-xs text-muted">{p.name}</div>
              <div className="text-sm font-medium tabular-nums">
                Sell the {px(p.strike)} put · {dayLabel(p.expiry)}
              </div>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs tabular-nums">
                <dt className="text-muted">Premium</dt>
                <dd className="text-right">
                  {p.mid.toFixed(3)} · {pctU(p.premium_weekly, 2)}/wk
                </dd>
                <dt className="text-muted">Cushion</dt>
                <dd className="text-right">{pctU(p.cushion)}</dd>
                <dt className="text-muted">Price</dt>
                <dd className="text-right">{px(p.last)}</dd>
                <dt className="text-muted">Delta · open</dt>
                <dd className="text-right">
                  {p.delta === null ? "—" : p.delta.toFixed(2)} · {p.open_interest ?? "—"}
                </dd>
                <dt className="text-muted">Per contract</dt>
                <dd className="text-right">${Math.round(p.collateral).toLocaleString("en-US")}</dd>
              </dl>
              <p className="text-xs">{p.reason}</p>
              {p.flags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.flags.map((f) => (
                    <Pill key={f} cls="bg-amber-500/15 text-amber-600 dark:text-amber-400">
                      {f}
                    </Pill>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {r.baseline && (
        <p className="text-xs text-muted">
          Baseline for the scoreboard: SPY {px(r.baseline.strike)} put at {px(r.baseline.mid)} ({pctU(r.baseline.premium_weekly, 2)}/wk).
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

function Weather({ r }: { r: SundayReport }) {
  return (
    <Section id="weather" title="Market weather" note="The colour is Sunday's read. Dashed lines are the levels that would flip it: green for better, red for worse.">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {r.gauges.map((g) => (
          <div key={g.id} className="card space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium">{g.name}</div>
                <div className="text-xs text-muted">{g.series}</div>
              </div>
              <Pill cls={STATUS_CLS[g.status]}>{g.status}</Pill>
            </div>
            <div className="text-xl font-semibold tabular-nums">{g.latest === null ? "—" : g.latest < 2 ? g.latest.toFixed(3) : g.latest.toFixed(2)}</div>
            <Sparkline data={g.history} good={g.good_level} bad={g.bad_level} />
            <p className="text-sm">
              <span className="font-medium">For you: </span>
              {g.for_you}
            </p>
            <p className="text-sm text-muted">{g.reading}</p>
            {g.flip && <p className="text-xs text-muted">{g.flip}</p>}
          </div>
        ))}
      </div>
    </Section>
  );
}

function Rotation({ r }: { r: SundayReport }) {
  const quads = ["Leading", "Improving", "Weakening", "Lagging"] as const;
  const doWhat: Record<string, string> = { Leading: "sell puts on dips", Improving: "start small", Weakening: "no new puts", Lagging: "wait" };
  return (
    <Section
      id="rotation"
      title="Rotation"
      note="Each fund's return relative to the S&P 500: right of center has beaten it over 13 weeks, above center over the last 4. Funds tend to rotate clockwise: Improving, Leading, Weakening, Lagging."
    >
      <div className="card">
        <RotationMap points={r.rotation.map((x) => ({ symbol: x.symbol, name: x.name, x: x.trend, y: x.momentum, quadrant: x.quadrant }))} />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {quads.map((q) => (
          <div key={q} className="card text-sm">
            <div className="mb-2 flex items-center justify-between">
              <Pill cls={QUAD_CLS[q]}>{q}</Pill>
              <span className="text-xs text-muted">{doWhat[q]}</span>
            </div>
            <ul className="space-y-0.5">
              {r.rotation
                .filter((x) => x.quadrant === q)
                .sort((a, b) => b.momentum - a.momentum)
                .map((x) => (
                  <li key={x.symbol} className="flex justify-between gap-2 tabular-nums">
                    <span>
                      {x.symbol} <span className="text-xs text-muted">{x.name}</span>
                    </span>
                    <span className={`text-xs ${sign(x.week)}`}>{spct(x.week)} wk</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function Watchlist({ rows }: { rows: CandidateRow[] }) {
  return (
    <Section
      id="watchlist"
      title="Watchlist + picks"
      note="The watchlist plus any scan name or fund that qualifies as a pick this week, ranked by score. Names that can't be a pick this week keep their put call and sit below."
    >
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              {["Name", "Score", "Put call", "Trend", "Group", "Last", "Week", "4 wk vs SPY", "13 wk vs SPY", "vs 50-day", "vs 200-day", "Band", "IV", "IV rank", "1-wk move", "Target strike", "vs your target"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.symbol} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-2 py-1.5">
                  <span className="font-medium">{c.symbol}</span>{" "}
                  {c.source !== "Watchlist" && <Pill cls="bg-accent/15 text-accent">{c.source === "Fund" ? "Fund" : "Pick"}</Pill>}
                  <div className="max-w-40 truncate text-xs text-muted">{c.name}</div>
                </td>
                <td className="px-2 py-1.5 font-medium">{c.score ?? ""}</td>
                <td className="px-2 py-1.5">
                  <Pill cls={callCls(c.pref)}>{c.put_call}</Pill>
                  {c.flags.map((f) => (
                    <div key={f} className="text-xs text-muted">
                      {f}
                    </div>
                  ))}
                </td>
                <td className="px-2 py-1.5">
                  <Pill cls={stageCls(c.stage)}>{c.stage}</Pill>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-xs">
                  {c.theme}
                  {c.group_quadrant && (
                    <>
                      {" "}
                      <Pill cls={QUAD_CLS[c.group_quadrant]}>{c.group_quadrant}</Pill>
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">{px(c.last)}</td>
                <td className={`px-2 py-1.5 text-right ${sign(c.week)}`}>{spct(c.week)}</td>
                <td className={`px-2 py-1.5 text-right ${sign(c.rs4)}`}>{spct(c.rs4)}</td>
                <td className={`px-2 py-1.5 text-right ${sign(c.rs13)}`}>{spct(c.rs13)}</td>
                <td className={`px-2 py-1.5 text-right ${sign(c.vs50)}`}>{spct(c.vs50)}</td>
                <td className={`px-2 py-1.5 text-right ${sign(c.vs200)}`}>{spct(c.vs200)}</td>
                <td className="px-2 py-1.5 text-right">{c.pct_b === null ? "—" : c.pct_b.toFixed(2)}</td>
                <td className="px-2 py-1.5 text-right">{pctU(c.iv, 0)}</td>
                <td className="px-2 py-1.5 text-right">{pctU(c.iv_rank, 0)}</td>
                <td className="px-2 py-1.5 text-right">{c.exp_move === null ? "—" : `±${px(c.exp_move)}`}</td>
                <td className="px-2 py-1.5 text-right">{c.target_strike === null ? "—" : px(c.target_strike)}</td>
                <td className={`px-2 py-1.5 text-right ${sign(c.to_target)}`}>{c.to_target === null ? "" : spct(c.to_target)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function Scoreboard({ log }: { log: LogRow[] }) {
  const settled = log.filter((l) => l.outcome !== null && l.roc !== null);
  const stats = (rows: LogRow[]) => {
    if (!rows.length) return null;
    const wins = rows.filter((r) => (r.pnl ?? 0) > 0).length;
    const rocs = rows.map((r) => r.roc!);
    return { n: rows.length, winRate: wins / rows.length, avg: rocs.reduce((a, b) => a + b, 0) / rocs.length, worst: Math.min(...rocs), assigned: rows.filter((r) => r.outcome === "assigned").length };
  };
  const picks = stats(settled.filter((l) => !l.is_baseline));
  const base = stats(settled.filter((l) => l.is_baseline));
  const weeks = [...new Set(log.map((l) => l.week_of))];
  return (
    <Section
      id="scoreboard"
      title="Scoreboard"
      note="Every Sunday's top picks are logged with the exact put and settled at expiration against the close (assigned puts are marked to that close). The baseline is a plain SPY put one expected move below the price. Judge the picks over 8 to 12 weeks, not one."
    >
      {!settled.length ? (
        <div className="card text-sm text-muted">Nothing settled yet. The first picks settle at their expiration and show up here the Sunday after.</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {[
            ["Machine picks", picks],
            ["SPY baseline", base],
          ].map(([label, s]) =>
            s ? (
              <div key={label as string} className="card text-sm">
                <div className="mb-2 font-medium">{label as string}</div>
                <dl className="grid grid-cols-2 gap-y-1 tabular-nums">
                  <dt className="text-muted">Puts settled</dt>
                  <dd className="text-right">{(s as NonNullable<typeof picks>).n}</dd>
                  <dt className="text-muted">Win rate</dt>
                  <dd className="text-right">{pctU((s as NonNullable<typeof picks>).winRate, 0)}</dd>
                  <dt className="text-muted">Average return on collateral</dt>
                  <dd className={`text-right ${sign((s as NonNullable<typeof picks>).avg)}`}>{spct((s as NonNullable<typeof picks>).avg, 2)}</dd>
                  <dt className="text-muted">Worst</dt>
                  <dd className={`text-right ${sign((s as NonNullable<typeof picks>).worst)}`}>{spct((s as NonNullable<typeof picks>).worst, 2)}</dd>
                  <dt className="text-muted">Assigned</dt>
                  <dd className="text-right">{(s as NonNullable<typeof picks>).assigned}</dd>
                </dl>
              </div>
            ) : null,
          )}
        </div>
      )}
      {weeks.length > 0 && (
        <div className="card overflow-x-auto text-sm">
          <table className="w-full tabular-nums">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-medium">Week</th>
                <th className="py-1 font-medium">Rules</th>
                <th className="py-1 font-medium">Picks</th>
                <th className="py-1 text-right font-medium">Picks avg</th>
                <th className="py-1 text-right font-medium">Baseline</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => {
                const rows = log.filter((l) => l.week_of === w);
                const p = rows.filter((l) => !l.is_baseline);
                const b = rows.find((l) => l.is_baseline);
                const done = p.filter((l) => l.roc !== null);
                const avg = done.length ? done.reduce((a, l) => a + l.roc!, 0) / done.length : null;
                return (
                  <tr key={w} className="border-t border-border">
                    <td className="py-1">{dayLabel(w)}</td>
                    <td className="py-1 text-xs text-muted">{rows[0]?.rules_version}</td>
                    <td className="py-1 text-xs">{p.sort((a, c) => (a.rank ?? 9) - (c.rank ?? 9)).map((l) => `${l.symbol} ${l.strike}p`).join(", ")}</td>
                    <td className={`py-1 text-right ${sign(avg)}`}>{avg === null ? "open" : spct(avg, 2)}</td>
                    <td className={`py-1 text-right ${sign(b?.roc)}`}>{b ? (b.roc === null ? "open" : spct(b.roc, 2)) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
