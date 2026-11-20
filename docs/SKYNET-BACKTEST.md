# Skynet backtest runbook

The backtest replays a Skynet ruleset week by week over the historical data in `data/parquet` (see [SKYNET-DATA.md](SKYNET-DATA.md)). Every decision inside a run is code. An AI can't unlearn market history, so it only works between runs: reading results, grading losses and proposing the next ruleset.

Skynet never changes `src/lib/rules.ts`, prep or the race. Kyle adopts a ruleset by copying its values into `rules.ts` and `RULES.md` himself.

## Commands

In Windows PowerShell, type `npm.cmd` instead of `npm`.

```
npm run skynet -- backtest --ruleset kindred [--from 2018-01-01] [--to 2025-12-31] [--symbols QQQ,IWM,TSLA]
                           [--fees 0.03] [--no-interest] [--margin-spread 0.015]
                           [--min-dollar-volume 1e8] [--quiet]
npm run skynet -- parity [--from 2024-01-01] [--to 2024-06-30]     # Skynet's code vs src/lib, same answers?
npm run skynet -- sectors                                         # data/sectors.json from the prep reports
```

- The backtest reads Parquet through an in-memory DuckDB, so it runs while a pull holds `data/skynet.duckdb`.
- Without `--symbols` it uses every symbol the pull has finished (`data/progress.json`). That list grows during the paid month, so results change between runs. `run.json` records which symbols a run used.
- A full 2018–2025 run takes about 12 seconds on 10 symbols and about 70 seconds on 100.
- **See the results** at http://localhost:3000/skynet (`npm run dev`). The page reads `data/backtests` on this machine, so a deployed copy shows nothing. It has:
  - a run picker
  - the totals against SPY
  - account value by week against SPY
  - the run's settings
  - a year-by-year table; click a year to open its weeks, and a week to see its trades (the skipped candidates are folded away)

## The account

Every run trades the same account (`ACCOUNT` in `skynet/backtest.ts`), so runs compare.
- It starts with **$100,000**.
- **Margin is capped at 2x the account value** in exposure: shares at market plus short put strikes × 100. That's $200k at the start, and it moves with the account.
- A ruleset decides how much of that to use (`ai.exposure`: the Monday and Wednesday targets and a ceiling), but it can't go past the 2x cap.
- The research knobs live in the ruleset, not the account:
  - minimum weekly return on the strike (`ai.minWeekly`)
  - exposure targets
  - per-ticker and per-theme caps
  - strike distance
  - take-profit

## Rulesets

`skynet/rulesets.ts` holds them. Each one is a full frozen copy of `RULES` and `AI`, so a later change to the live rules doesn't change an old ruleset.
- Names are random League of Legends champions and are never reused. Add every name to `USED_NAMES`.
- Sweep variants hang under a parent (`parent: "Kindred"`) and are named like "Kindred · delta 0.22".
- **Kindred** is the first ruleset: the live rules and the race's AI playbook as of `RULES_VERSION` 2026.11.16.1, unchanged.

## How a week runs

It works the same way the race does (`src/lib/race.ts`, [RACE.md](RACE.md)), from end-of-day data:

| Step | Data it sees | What it does |
|---|---|---|
| Sunday report | Bars through Friday's close, Friday's closing chain for this Friday's expiry | Candidates, scores and target strikes (prep's `buildSunday`) |
| Monday | Monday's closing quotes and prices | Covered calls on shares, then puts on the best candidates |
| Wednesday (the day nearest it) | Wednesday's closing quotes; the floor check uses Tuesday's close | Take profit at 50%, cut below the floor, stop out shares, redeploy |
| Friday (the week's last day) | Friday's close | Settle: assigned if the stock closed past the strike. Then stops, mark to market, score the week |

- **Fills:** sell at mid − ¼ of the spread, buy at mid + ¼ (the ruleset's `fillSpreadShare`). There's a $0.03 fee per contract on every option trade and on each assignment or call-away (`--fees`).
- **Cash:** positive cash earns the 3-month T-bill (FRED DTB3). Negative cash is margin and pays the T-bill + 1.5%. `--no-interest` turns both off.
- **Splits:** held shares and open options follow the stock. The ratio comes from raw ÷ split-adjusted prices.

## No lookahead

- Indicators use the `split` series, cut at the run day and scaled to that day's raw price. The floor, ATR and target strike are in that day's dollars. Bars never reach across a `segment` (a ticker reused by a different company).
- Strikes, marks and settlement use `raw` closes.
- Open interest is pulled on each week's first day. Later days in the week use the latest pull on or before them.
- IV rank compares the 30-day at-the-money IV with the year before the run day.
- The size test uses dollar volume from the 20 sessions before Monday.

## Code

- `skynet/rulesets.ts`: the rulesets.
- `skynet/logic.ts`: the functions from `rules.ts` and `prep.ts` that read the global `RULES`, rewritten to take the ruleset as an argument. Functions that don't read it are imported as they are.
- `skynet/engine.ts`: the race's Monday, Wednesday and Friday with the ruleset passed in. Shapes, account value, exposure and grading are imported from `race.ts`.
- `skynet/feed.ts`: the Parquet reader (bars, chains, open interest, IV, VIX, T-bill).
- `skynet/backtest.ts`: the weekly loop, the summary and the files, plus the parity check.
- **Parity:** `npm run skynet -- parity` runs the same weeks through Skynet's code (live ruleset, no fees, no interest) and through `src/lib`'s prep and race. Every Sunday's candidates and every trade must match.
  - Run it after any change to `rules.ts`, `prep.ts` or `race.ts`.
  - When it fails, update `logic.ts` or `engine.ts` to match.

## Output

Each run writes `data/backtests/<ruleset>/<from>_<to>_<timestamp>/` (gitignored, never commit it):

- `run.json`: everything the `/skynet` page reads (format 2): the ruleset, the options, the totals and years, every week, every trade, the graded trades and the end state. Runs from before format 2 show up in the picker, but you have to rerun them to view them.
- `weeks.csv`: one row per week: value, return, drawdown, leverage, premium, counts, and `spy_*` for the benchmark
- `trades.csv`: every sale, buyback, expiry, assignment, share sale and skip, each with a note saying why
- `graded.csv`: closed trades scored the way the race's review scores them (win = net premium after the move past the strike)
- `years.csv`: the year-by-year summary

The console prints the same year-by-year table next to **SPY buy and hold**, starting at the first Monday's close. The years are tagged: train 2018–2023, validate 2024–2025, final exam 2026. Judge a change year by year: it should help most years, not just the total. Run 2026 rarely.

## Known gaps

These all make the backtest differ from live:
- **No earnings dates.** The rule that skips a name with earnings before expiry can't fire. This flatters single stocks.
- **No market caps.** The $20B test is replaced by 20-day average dollar volume of at least $100M (`--min-dollar-volume`). Funds always pass.
- **Survivorship.** The symbol list is today's priority list: names Kyle trades now, or that prep has reported on. It picks names that did well.
- **Sectors** come from `data/sectors.json` (`npm run skynet -- sectors`, the latest theme from the prep reports). A stock missing from it counts as theme "Other", with no sector-fund quadrant. That makes the 30% theme cap shared across every unknown stock.
- **No dividends** on SPY or on assigned shares. Both are price only, and there's no early assignment.
- **Weeks with a Friday holiday** (Good Friday, and some July 4 and Christmas weeks) have no Friday expiry, so no puts are sold. The live rules would also find no weekly.
- **Data starts in 2017.** Greeks history begins in early 2017. Runs from before then find no chains.
- **Fills use end-of-day quotes.** The live race trades during the session.
