# Skynet backtest runbook

The backtest replays a Skynet ruleset week by week over the historical data in `data/parquet` (see [SKYNET-DATA.md](SKYNET-DATA.md)). The research plan (levers, logging, phases) is [SKYNET-PLAN.md](SKYNET-PLAN.md). Every decision inside a run is code. An AI can't unlearn market history, so it only works between runs: reading results, grading losses and proposing the next ruleset.

Skynet never changes `src/lib/rules.ts`, prep or the race. Kyle adopts a ruleset by copying its values into `rules.ts` and `RULES.md` himself.

## Commands

In Windows PowerShell, type `npm.cmd` instead of `npm`.

```
npm run skynet -- backtest --ruleset kindred [--from 2018-01-01] [--to 2025-12-31] [--symbols QQQ,IWM,TSLA]
                           [--fees 0.03] [--no-interest] [--margin-spread 0.015]
                           [--min-dollar-volume 1e8] [--quiet]
npm run skynet -- backtest --ruleset kindred --set ai.takeProfit=0.3 [--name "Kindred · TP 30%"]   # a one-off variant
npm run skynet -- parity [--from 2024-01-01] [--to 2024-06-30]     # Skynet's code vs src/lib, same answers?
npm run skynet -- sectors                                         # data/sectors.json from the prep reports
npm run skynet -- picks --ruleset nasus [--set ...]               # pick study: every Sunday candidate and its put's outcome
```

- The backtest reads Parquet through an in-memory DuckDB, so it runs while a pull holds `data/skynet.duckdb`.
- Without `--symbols` it uses every symbol the pull has finished (`data/progress.json`). That list grows during the paid month, so results change between runs. `run.json` records which symbols a run used.
- A full 2018–2025 run takes about 12 seconds on 10 symbols and about 70 seconds on 100.
- **See the results** at http://localhost:3000/skynet (`npm run dev`). The page reads `data/backtests` on this machine, so a deployed copy shows nothing. It has:
  - a run picker
  - the totals against SPY
  - account value by week against SPY
  - the run's settings
  - a year-by-year table; click a year to open its weeks, and a week to see its trades (the skipped candidates are folded away). A week's trades load only when you open it, which keeps the page light.

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
- **Nasus** is Kindred plus three changes: no new puts while SPY is under its 175-day average, covered calls on 25% of each lot, and take profit at 70%.
- **Azir** is Nasus with a reworked Sunday report. Every qualifying trend stage scores 20, premium weighs 30, and there are up to 10 bonus points each for distance above the 200-day, 13-week strength against SPY, and IV ÷ realized vol.

## Variants and levers

`--set a.b=value[,c.d=value]` (repeatable) changes any field of the ruleset for one run. Numbers and true/false are parsed. The run is named "<ruleset> · <overrides>" unless `--name` says otherwise, and its `parent` is the ruleset. An existing field is checked, so a typo fails instead of doing nothing.

Skynet-only levers live under `levers` on the ruleset (`Levers` in `skynet/rulesets.ts`). A missing lever means Kindred's behaviour, so parity is unaffected.

| Lever | What it does |
|---|---|
| `levers.putStrike=roc` + `levers.rocTarget=0.01` | Monday puts take the furthest out-of-the-money strike, below Monday's price, that pays at least the target for the week. There's no expected-move or floor cap. Wednesday redeploys keep the expected-move strike. |
| `levers.holdUntilGreen=true` | Assigned shares are never sold: no floor stop and no downtrend sale. They leave only by being called away. Covered calls already go at or above the cost. |
| `levers.avoidAssignment=true` | Friday: an in-the-money put is bought back at intrinsic + $0.05 instead of assigned. There are no Friday quotes, so that price stands in for the fill. |
| `levers.ccCoverage=0.5` | Covered calls on this share of each lot's contracts, rounded down. |
| `levers.ivMin` / `levers.ivMax` | Puts only on names whose 30-day ATM IV is at least / at most this. |
| `levers.putStrike=delta` + `levers.deltaTarget=0.2` | Monday puts take the highest strike under the price whose \|delta\| is at most the target and that pays `minWeekly`. |
| `levers.minScore=60` | Skip candidates scoring under this. |
| `levers.noLeveraged=true` | No puts on leveraged or inverse ETFs (`LEVERAGED` in `skynet/engine.ts`). |
| `levers.shareStop=0.2` | Stop out shares at this loss from cost instead of the floor stop. |
| `levers.stopBuffer=0.03` | The floor stop fires only this far under the floor. |
| `levers.wedRedeploy=false` | No new puts on Wednesday; take profit and stops still run. |
| `levers.spyMaDays=200` (+ `levers.spyMaBand=0.04`) | Risk-off while SPY's last close is under its N-day average (or under it by more than the band). Read from the close before each run. |
| `levers.vixMax=30` | Risk-off while VIX closed above this. |
| `levers.riskOffScale=0.5` | When risk-off, the day's put exposure target is multiplied by this (default 0: no new puts). |
| `levers.riskOffExit=all` / `losers` | Monday when risk-off: sell every share lot, or only those under cost. |
| `levers.core=1` (+ `levers.coreSymbol=QQQ`) | Core holding: after Monday's puts, buy SPY (or QQQ) until total exposure is this multiple of the account; all of it is sold when risk-off. Puts come first: the core doesn't count toward their target, only toward the 2x margin cap. It's never covered or stopped. |

### Sunday-report levers

`levers.prep` changes the Sunday report itself (`buildCandidates` in `skynet/logic.ts`). The live prep's score weights are already in the ruleset (`rules.score.*`, e.g. `rules.score.premiumMax=30`). `levers.prep` adds what the live prep doesn't have. JSON values are parsed, so they go in a job file or a single `--set`:

| Lever | What it does |
|---|---|
| `levers.prep.bonus={"vs200":[0,0.5,10]}` | Extra score points per feature: 0 at the first number, the third number of points at the second, linear and clamped in between. |
| `levers.prep.filters={"term":[null,1.15]}` | A candidate is eligible only with each feature inside [min, max] (`null` = no bound). A missing feature fails. |
| `levers.prep.maxScore=200` | The score cap (default 100). Raise it with bonuses so the top names don't tie at 100. |
| `levers.prep.fundGate=false` | Let funds outside Leading/Improving groups in on their own trend. |
| `levers.prep.turningUp=false` | Drop "Turning up" names from the eligible list. |

The features are listed on `PrepLevers` in `skynet/rulesets.ts`: returns, realized vol, IV ÷ realized vol, IV rank, distance from the high, floor and averages, %B, RSI, the put's premium and distance, and `term`. `term` is the front week's at-the-money IV ÷ the next expiry's (`feed.termRatio`). An earnings report before the front expiry pushes it to about 1.2, so `term ≤ 1.15` stands in for prep's earnings rule. In 2023 it caught every earnings week of AAPL, NFLX, NVDA and JPM, with no false alarms. The report cache is keyed by `rules` and `levers.prep`.

### Pick study

`npm run skynet -- picks --ruleset nasus` writes `data/skynet/picks-<ruleset>.jsonl`. It has one row per eligible candidate per Sunday:
- the report's fields and extra bar features
- the put the engine would sell on Monday (strike, fill, delta, spread)
- what happened: the expiry close, assignment, and the stock 4 and 13 weeks later (`put_pnl`, `wheel4`, `wheel13`, per dollar of strike)

Re-ranking each week's candidates offline and comparing the top 8 tests a scoring idea without a backtest's path noise. A single backtest of a ranking change is mostly noise: one or two speculative names decide the year. Check a ranking change in the pick study first. Then backtest it on the full universe and on random 80% slices (`--symbols`), and pool the results.

### Sweeps

`npm run skynet -- sweep --jobs jobs.json [--from --to --symbols --fees ...]` runs several variants through the same weeks in one process. Each year's chains load once and each Sunday report is built once per distinct `rules`, so a dozen variants take about as long as one run. Every variant keeps its own state and is written as its own run, with the same results as running it alone. The job file is a JSON array:

```json
[{ "ruleset": "kindred", "name": "Kindred · CC 50%", "set": ["levers.ccCoverage=0.5"] }]
```

Each run also writes `summary.json`, the headline numbers that the /skynet compare table reads. The table puts every run on the same period and symbol count side by side, best CAGR first, with each year green or red against the plain Kindred run.

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

- `run.json`: everything the `/skynet` page reads (format 2): the ruleset, the options, the totals and years, every week, every trade, the graded trades and the end state. Runs from before format 2 don't appear on the page; rerun them to see them.
- `weeks.csv`: one row per week: value, return, drawdown, leverage, premium, counts, and `spy_*` for the benchmark
- `trades.csv`: every sale, buyback, expiry, assignment, share sale and skip, each with a note saying why
- `graded.csv`: closed trades scored the way the race's review scores them (win = net premium after the move past the strike)
- `years.csv`: the year-by-year summary
- `summary.json`: the headline numbers for the compare table (written on first sight for older runs)

The console prints the same year-by-year table next to **SPY buy and hold**, starting at the first Monday's close. The years are tagged: train 2018–2023, validate 2024–2025, final exam 2026. Judge a change year by year: it should help most years, not just the total. Run 2026 rarely.

## Known gaps

These all make the backtest differ from live:
- **No earnings dates.** The rule that skips a name with earnings before expiry can't fire, unless a ruleset uses the `term` filter (see Sunday-report levers) as a stand-in.
- **No market caps.** The $20B test is replaced by 20-day average dollar volume of at least $100M (`--min-dollar-volume`). Funds always pass.
- **Survivorship.** The symbol list is today's priority list: names Kyle trades now, or that prep has reported on. It picks names that did well.
- **Sectors** come from `data/sectors.json` (`npm run skynet -- sectors`, the latest theme from the prep reports). A stock missing from it counts as theme "Other", with no sector-fund quadrant. That makes the 30% theme cap shared across every unknown stock.
- **No dividends** on SPY or on assigned shares. Both are price only, and there's no early assignment.
- **Weeks with a Friday holiday** (Good Friday, and some July 4 and Christmas weeks) have no Friday expiry, so no puts are sold. The live rules would also find no weekly.
- **Data starts in 2017.** Greeks history begins in early 2017. Runs from before then find no chains.
- **Fills use end-of-day quotes.** The live race trades during the session.
