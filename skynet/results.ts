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
  weeks: WeekRow[];
  trades: Trade[];
  graded: GradedTrade[];
  end_state: RaceState;
}
