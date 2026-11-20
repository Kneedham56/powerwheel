import type { Metadata } from "next";
import { RunPicker, SkynetChart } from "@/components/skynet/SkynetChart";
import { WeekRow } from "@/components/skynet/WeekRow";
import { Expandable, PageTitle, Stat, param } from "@/components/ui";
import type { WeekRow as WeekRowData } from "@/lib/race";
import { dayLabel } from "@/lib/rules";
import { listRuns, loadRun } from "@/lib/skynet-runs";
import type { RunFile, YearRow } from "../../../skynet/results";

// Private and local only: backtest results are read from data/backtests on this machine (gitignored).

export const metadata: Metadata = {
  title: "Skynet backtests · PowerWheel",
  description: "Skynet rulesets replayed over the historical data, year by year and week by week.",
};

const spct = (n: number | null | undefined, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`);
const pctU = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(d)}%`);
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const tone = (n: number | null | undefined) => (!n ? "" : n > 0 ? "text-gain" : "text-loss");
const SPLIT_STYLE: Record<string, string> = {
  train: "bg-accent/15 text-accent",
  validate: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "final exam": "bg-loss/15 text-loss",
  other: "bg-foreground/10 text-foreground",
};

const YEAR_COLS = "grid-cols-[1rem_minmax(7rem,1.2fr)_repeat(6,minmax(4.5rem,1fr))_minmax(8rem,1.3fr)_repeat(3,minmax(4.5rem,1fr))]";
const WEEK_COLS = "grid-cols-[1rem_minmax(7rem,1.2fr)_repeat(8,minmax(4.5rem,1fr))]";

export default async function SkynetPage({ searchParams }: PageProps<"/skynet">) {
  const sp = await searchParams;
  const runs = listRuns();
  if (!runs.length) {
    return (
      <div>
        <PageTitle>Skynet backtests</PageTitle>
        <div className="card text-sm text-muted">
          No runs on this machine yet. Backtests are local only: run <code>npm run skynet -- backtest --ruleset kindred</code> and reload. Results land in
          <code> data/backtests</code>.
        </div>
      </div>
    );
  }
  const id = param(sp, "run") ?? runs[0].id;
  const { run, error } = loadRun(id, runs);
  const picker = (
    <RunPicker
      current={id}
      runs={runs.map((r) => ({ id: r.id, label: `${r.ruleset} · ${r.from} → ${r.to} · ran ${r.stamp.slice(0, 4)}-${r.stamp.slice(4, 6)}-${r.stamp.slice(6, 8)} ${r.stamp.slice(9, 11)}:${r.stamp.slice(11, 13)} UTC` }))}
    />
  );
  if (!run) {
    return (
      <div>
        <PageTitle right={picker}>Skynet backtests</PageTitle>
        <div className="card text-sm text-muted">{error}</div>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageTitle right={picker}>Skynet backtests</PageTitle>
      <Summary run={run} />
      <section className="card">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">Account value</h2>
          <span className="text-xs text-muted">each Friday, against SPY bought with the same {usd(run.options.capital)} on the first Monday (price only)</span>
        </div>
        <SkynetChart name={run.ruleset.name} capital={run.options.capital} data={run.weeks.map((w) => ({ date: w.date, value: w.ai_value, spy: w.opp_value }))} />
      </section>
      <Years run={run} runId={id} />
      <Settings run={run} />
      {run.notes.length > 0 && (
        <section className="card text-xs text-muted">
          <div className="mb-1 font-medium">Notes from the run</div>
          <ul className="list-disc space-y-0.5 pl-5">
            {run.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted">
        Known gaps: no earnings dates, a dollar-volume stand-in for market cap, today&apos;s symbol list (survivorship), no dividends, end-of-day fills. See
        docs/SKYNET-BACKTEST.md.
      </p>
    </div>
  );
}

function Summary({ run }: { run: RunFile }) {
  const t = run.total;
  const g = run.graded;
  const wins = g.filter((x) => x.result === "win").length;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      <Stat label={`${run.ruleset.name} total`} value={<span className={tone(t.ret)}>{spct(t.ret)}</span>} sub={`SPY ${spct(t.spy)}`} />
      <Stat label="Per year (CAGR)" value={<span className={tone(t.cagr)}>{spct(t.cagr)}</span>} sub={`SPY ${spct(t.spyCagr)}`} />
      <Stat label="Max drawdown" value={<span className="text-loss">{spct(t.dd)}</span>} sub={`SPY ${spct(t.spyDd)}`} />
      <Stat label="Win rate" value={pctU(t.winRate, 0)} sub={`${wins}–${g.length - wins} of ${g.length} trades`} />
      <Stat label="Sharpe" value={t.sharpe === null ? "—" : t.sharpe.toFixed(2)} sub="weekly, annualised" />
      <Stat label="Ending value" value={usd(run.weeks.at(-1)?.ai_value)} sub={`from ${usd(run.options.capital)} · interest ${usd(run.interest)}`} />
    </div>
  );
}

/**
 * Years as dropdowns of their weeks, and weeks as dropdowns of their trades. The weeks are on the page from the start
 * (a few hundred rows); a week's trades load when it's opened, so the page doesn't carry thousands of trade rows.
 */
function Years({ run, runId }: { run: RunFile; runId: string }) {
  return (
    <section className="card overflow-x-auto">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-medium">Year by year</h2>
        <span className="text-xs text-muted">click a year for its weeks, and a week for its trades</span>
      </div>
      <div className="gtable min-w-[64rem]">
        <div className={`ghead ${YEAR_COLS}`}>
          <span />
          <span className="text-left">Year</span>
          <span>Return</span>
          <span>SPY</span>
          <span>vs SPY</span>
          <span>Max DD</span>
          <span>SPY DD</span>
          <span>Trades</span>
          <span>Win rate</span>
          <span>Assigned</span>
          <span>Avg lev</span>
          <span>Net premium</span>
        </div>
        {run.years.map((y) => (
          <Expandable key={y.year} cols={YEAR_COLS} cells={yearCells(y)}>
            <Weeks weeks={run.weeks.filter((w) => w.date.startsWith(y.year))} runId={runId} title={`${run.ruleset.name} trades`} />
          </Expandable>
        ))}
      </div>
    </section>
  );
}

function yearCells(y: YearRow) {
  return [
    <span key="y">
      {y.year} <span className={`pill ml-1 ${SPLIT_STYLE[y.split]}`}>{y.split}</span>
    </span>,
    <span key="r" className={tone(y.return)}>{spct(y.return)}</span>,
    <span key="s" className={tone(y.spy_return)}>{spct(y.spy_return)}</span>,
    <span key="e" className={tone(y.excess)}>{spct(y.excess)}</span>,
    <span key="d" className={y.max_drawdown < 0 ? "text-loss" : ""}>{spct(y.max_drawdown)}</span>,
    spct(y.spy_max_drawdown),
    String(y.trades),
    y.win_rate === null ? "—" : `${(y.win_rate * 100).toFixed(0)}% (${y.wins}–${y.losses})`,
    String(y.assigned),
    `${y.avg_leverage.toFixed(2)}x`,
    <span key="p" className={tone(y.net_premium)}>{usd(y.net_premium)}</span>,
  ];
}

function Weeks({ weeks, runId, title }: { weeks: WeekRowData[]; runId: string; title: string }) {
  return (
    <div className="gtable min-w-[52rem]">
      <div className={`ghead ${WEEK_COLS}`}>
        <span />
        <span className="text-left">Week ending</span>
        <span>Value</span>
        <span>Week</span>
        <span>SPY week</span>
        <span>Drawdown</span>
        <span>Leverage</span>
        <span>Net premium</span>
        <span>Puts sold</span>
        <span>Assigned</span>
      </div>
      {weeks.map((w) => {
        return (
          <WeekRow
            key={w.week}
            cols={WEEK_COLS}
            runId={runId}
            week={w.week}
            note={w.note}
            title={title}
            cells={[
              dayLabel(w.date),
              usd(w.ai_value),
              <span key="a" className={tone(w.ai_week_return)}>{spct(w.ai_week_return, 2)}</span>,
              <span key="b" className={tone(w.opp_week_return)}>{spct(w.opp_week_return, 2)}</span>,
              <span key="c" className={w.ai_drawdown < 0 ? "text-loss" : ""}>{spct(w.ai_drawdown)}</span>,
              w.leverage ? `${w.leverage.toFixed(2)}x` : "—",
              <span key="p" className={tone(w.premium)}>{usd(w.premium)}</span>,
              String(w.counts.puts_sold ?? 0),
              String(w.counts.puts_assigned ?? 0),
            ]}
          />
        );
      })}
    </div>
  );
}

function Settings({ run }: { run: RunFile }) {
  const o = run.options;
  const a = run.ruleset.ai;
  const R = run.ruleset.rules;
  const rows: [string, string][] = [
    ["Ruleset", `${run.ruleset.name}${run.ruleset.parent ? ` (under ${run.ruleset.parent})` : ""}, from rules ${run.ruleset.basedOn}`],
    ["Period", `${o.from} → ${o.to}, ${run.weeks.length} weeks`],
    ["Account", `${usd(o.capital)}, margin up to ${o.maxLeverage}x the account value`],
    ["Exposure targets", `Monday ${a.exposure.monday}x, Wednesday ${a.exposure.wednesday}x, ceiling ${a.exposure.ceiling}x`],
    ["Per ticker / theme", `${pctU(a.perTicker, 0)} / ${pctU(a.perTheme, 0)} of the account (one contract may stretch to ${pctU(a.oneContract, 0)})`],
    ["Minimum premium", `puts ${pctU(a.minWeekly, 2)} of the strike a week, covered calls ${pctU(a.coveredCall.minWeekly, 2)}`],
    ["Strike", `${a.strike.moves} expected move below (${a.strike.aggressiveMoves} for score ${a.strike.aggressiveMinScore}+ in a Leading group), never within ${R.strike.atrBelowFloor} ATR under the floor`],
    ["Take profit", `buy back on Wednesday at ${pctU(a.takeProfit, 0)} captured`],
    ["Fills and costs", `mid ∓ ${a.fillSpreadShare} of the spread, $${o.fees}/contract, ${o.interest ? `cash earns the T-bill, margin pays T-bill + ${pctU(o.marginSpread, 1)}` : "no interest"}`],
    ["Symbols", `${o.symbols.length}: ${o.symbols.join(", ")}`],
    ["Ran", `${run.ran_at.slice(0, 16).replace("T", " ")} UTC in ${run.seconds}s`],
  ];
  return (
    <section className="card">
      <h2 className="mb-2 font-medium">Run settings</h2>
      {run.ruleset.note && <p className="mb-2 text-sm text-muted">{run.ruleset.note}</p>}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm md:grid-cols-[12rem_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
