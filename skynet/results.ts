/**
 * The shape of a backtest's run.json (data/backtests/<ruleset>/<run>/run.json), written by skynet/backtest.ts and read
 * by the local /skynet page. Types only, so the app can import it without pulling in DuckDB.
 */
import type { GradedTrade, RaceState, Trade, WeekRow } from "../src/lib/race";
import type { Ruleset } from "./rulesets";

export interface RunOptions {
  from: string;
  to: string;
  capital: number;
  maxLeverage: number;
  symbols: string[];
  fees: number;
  interest: boolean;
  marginSpread: number;
  minDollarVolume: number;
  quiet: boolean;
}

export interface YearRow {
  year: string;
  split: "train" | "validate" | "final exam" | "other";
  weeks: number;
  return: number;
  spy_return: number;
  excess: number;
  max_drawdown: number;
  spy_max_drawdown: number;
  trades: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  assigned: number;
  called_away: number;
  shares_stopped: number;
  net_premium: number;
  avg_leverage: number;
}

export interface Totals {
  ret: number;
  spy: number;
  cagr: number;
  spyCagr: number;
  dd: number;
  spyDd: number;
  winRate: number | null;
  trades: number;
  sharpe: number | null;
}

/** A share position at a week's Friday close: every lot of the name added up, marked at that close. */
export interface Holding {
  symbol: string;
  shares: number;
  price: number;
}

/** A backtest week: the race's week row plus what the account held at the end of it (runs from before 2026-11-24 have none). */
export type RunWeek = WeekRow & { holdings?: Holding[] };

export interface RunFile {
  /** 2 = weeks, trades and graded trades are inside run.json */
  format: number;
  ruleset: Ruleset;
  options: RunOptions;
  ran_at: string;
  seconds: number;
  total: Totals;
  years: YearRow[];
  notes: string[];
  interest: number;
  weeks: RunWeek[];
  trades: Trade[];
  graded: GradedTrade[];
  end_state: RaceState;
}

/** A run's headline numbers, written next to run.json as summary.json so the compare table doesn't parse every run. */
export interface RunSummary {
  name: string;
  parent: string | null;
  note: string;
  from: string;
  to: string;
  ran_at: string;
  symbols: number;
  total: Totals;
  /** exposure at Friday's close, after the week's puts expired: mostly shares held */
  avg_leverage: number;
  /** put collateral sold each week (Monday + Wednesday) ÷ the account value going in, averaged over the weeks */
  put_deploy?: number;
  years: { year: string; split: YearRow["split"]; return: number; spy_return: number; max_drawdown: number }[];
}

export function summarize(run: Pick<RunFile, "ruleset" | "options" | "ran_at" | "total" | "years" | "weeks" | "trades">): RunSummary {
  const lev = run.weeks.map((w) => w.leverage ?? 0);
  const sold = new Map<number, number>();
  for (const t of run.trades) if (t.action === "Sold put" && t.strike && t.qty) sold.set(t.week, (sold.get(t.week) ?? 0) + t.strike * 100 * t.qty);
  const going = new Map(run.weeks.map((w, i) => [w.week, i ? run.weeks[i - 1].ai_value : run.options.capital]));
  const deploy = run.weeks.map((w) => (sold.get(w.week) ?? 0) / (going.get(w.week) || run.options.capital));
  return {
    name: run.ruleset.name,
    parent: run.ruleset.parent,
    note: run.ruleset.note,
    from: run.options.from,
    to: run.options.to,
    ran_at: run.ran_at,
    symbols: run.options.symbols.length,
    total: run.total,
    avg_leverage: lev.length ? lev.reduce((a, b) => a + b, 0) / lev.length : 0,
    put_deploy: deploy.length ? deploy.reduce((a, b) => a + b, 0) / deploy.length : 0,
    years: run.years.map((y) => ({ year: y.year, split: y.split, return: y.return, spy_return: y.spy_return, max_drawdown: y.max_drawdown })),
  };
}
