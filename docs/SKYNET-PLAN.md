# Skynet research plan

This plan covers the research once the data pull is done. **Read this first in any new chat about Skynet.** It covers:
- where we are
- how runs are logged
- the levers
- how the research moves from hands-on runs to an agentic loop and then to new strategies

How to run things: [SKYNET-BACKTEST.md](SKYNET-BACKTEST.md) (backtests) and [SKYNET-DATA.md](SKYNET-DATA.md) (the pull).

## Where we are

**Done:**
- The pull is running.
- The backtest harness works: Kindred replays 2018–2025 week by week.
- Parity passes.
- The /skynet page shows a run year → week → trades.

**Not done:** levers beyond the plain ruleset values, a run ledger, a compare view, the research journal.

The state of each phase is kept in the journal (below), not here. This file only changes when the plan does.

## Phases

1. **Data solid.** Nothing below counts until the pull is finished and checked:
   - coverage by symbol and year, with gaps listed
   - split and segment checks
   - crossed or empty chains
   - a spot check of fills against Kyle's real fills

   Then freeze it: every run after that carries the same data version, so runs compare.
2. **Lever plumbing.** For each lever:
   - a ruleset field
   - code behind it whose default is exactly Kindred, so parity still passes with the defaults

   Plus:
   - a `--set` override and a sweep runner
   - the ledger
   - the compare view on /skynet
3. **Hands-on runs (Kyle + Claude).** The first list below, one run at a time, reading the trades in the UI to shake out bugs. A recursive loop on a buggy process just produces bad results faster, so this phase isn't skipped.
4. **Sweeps.** Mix and match the levers, hundreds to thousands of runs, then read the patterns together.
5. **Agentic loop.** Claude searches combinations alone within the guardrails below, logging everything, and reports back.
6. **New strategies**, each a new champion. In order:
   - swing trading (no options): Talon (built, `levers.swing`)
   - the wheel + swing: Zed (built)
   - buy and hold: Braum (built, `levers.hold`), and buy and hold + the wheel on the margin: Ornn (built)
   - long calls/puts: Jhin (built, `levers.longs`; calls only, since long puts lost in every form tried)
   - the wheel + long options: Xayah (built)

   The data already includes calls. The ledger and the journal carry over, so earlier findings feed these.

## Naming

- **A new champion** is for a real change to the rule logic or a new strategy. It goes in `USED_NAMES` and is never reused.
- **A variant** is the same logic with different lever values. It hangs under its parent and is named by what differs from it:
  - "Kindred · roc 1%"
  - "Kindred · roc 1% · no CC · TP 70%"

  The runner builds that name from the overrides. Variants don't need `USED_NAMES` entries.
- **Promotion:** a variant that wins and is worth building on can get its own champion name, with `parent` pointing at where it came from.

## Logging

Logging is what makes the research reusable. Every run, including failed and junk runs, leaves a record. Where things go:

| What | Where | In git? |
|---|---|---|
| The plan, the lever catalog, the process | this file | yes |
| One run's full output (run.json, csv files) | `data/backtests/<ruleset>/<period>_<stamp>/` | no |
| **Run ledger:** one line per run, the thing to query | `data/skynet/ledger.jsonl` | no |
| **Research journal:** dated entries, what we ran and learned | `data/skynet/JOURNAL.md` | no |
| Experiment notes: one question, its runs, the answer | `data/skynet/experiments/<nnn>-<slug>.md` | no |

Results stay out of the public repo: they come from licensed data and say a lot about the strategy. **Back up `data/skynet/`** along with `data/parquet` before the subscription ends.

### A ledger line holds

- **Identity:**
  - run id
  - when it ran
  - ruleset name and parent
  - experiment id and batch id
  - who launched it: Kyle, Claude by hand, or the loop
- **Reproducibility:**
  - the full ruleset hash
  - the lever overrides as flat `key: value` pairs
  - the git commit, and whether the tree had uncommitted changes
  - the engine version
  - the data version (the symbol list hash and the pull state)
  - period, symbols and fills
- **Results:**
  - total, CAGR, max drawdown, Sharpe, win rate, trades, assignments, average leverage, net premium
  - each of those again for train (2018–2023), validate (2024–2025) and each year, with excess over SPY
- **Health checks:** flags that point at bugs rather than strategy:
  - a week over ±15%
  - fills on zero bids
  - splits
  - weeks with no data
  - trades the engine skipped for missing quotes
- **Notes:** a hypothesis before the run and a verdict after (`keep`, `drop`, `bug`, `rerun`).

DuckDB reads the ledger directly (`read_json('data/skynet/ledger.jsonl')`), so the analysis is plain SQL, and the UI reads the same file.

**Bug fixes:** when the engine changes, its version goes up. Older ledger lines stay as history, but they are marked stale and left out of comparisons.

### The journal

The journal is how a new chat picks up the work without losing anything. Each session adds a dated entry:
- what ran
- what we saw
- bugs found and fixed
- decisions
- the next step

Its top section always holds **current state**, **open questions** and **next up**. When a chat retires, its takeaways go here, not only into chat memory.

## Levers

**"Exists"** means the field is already in the ruleset: a variant only changes a value. **"Code"** means it needs new engine code, with Kindred's behaviour as the default.

### Kyle's first list (the hands-on phase)

| # | Run | Lever(s) | Status |
|---|---|---|---|
| 1 | Base case | Kindred as is | exists |
| 2–6 | Aim for 0.2%, 0.5%, 1%, 1.5%, 2% weekly ROC | `levers.putStrike: "roc"` + `levers.rocTarget`: Monday puts take the furthest out-of-the-money strike that pays at least the target, instead of one expected move below. It's not just a higher minimum. Wednesday redeploys keep the expected-move strike | built |
| 7 | Never sell until green | `levers.holdUntilGreen`: assigned shares are never sold (no floor stop, no downtrend sale); covered calls already go at or above the cost. The Wednesday put cut stays | built |
| 8 | Never take assignment | Friday: an in-the-money put is either bought back at a loss (`ai.avoidAssignment: "buyback"`) or rolled out a week, same or lower strike, only for a net credit (`"roll"`). If no credit roll exists, it's bought back | buyback built (`levers.avoidAssignment`). Kyle's decide rule built (`levers.fridayDecide`, plus `fridayRollCalls` for covered calls): in a light test on 4 lists it cost 2–5%/yr as written; the floor-only version was about even |
| 9 | Never covered call | `ai.coveredCall.use: false` | exists |
| 10 | Covered call on only 50% of shares, sold at the top | `levers.ccCoverage: 0.5` (built), plus a top-zone gate (`when: "stretched"`, not built yet): sell the call only when the stock is stretched (≥2 ATR above its 20-day average, upper Bollinger, RSI > 70) | coverage built |
| 11 | High-IV names only | `levers.ivMin`: the 30-day ATM IV (a rank against the universe is a later option) | built |
| 12 | S&P 500 names only | `universe.list: "sp500"`, needs the S&P membership as it stood on each date. Today's list adds survivorship bias | data + code |
| 13 | Low-IV names only | `levers.ivMax` | built |

### More levers to mix in

**Strike and expiry**
- Expected-move distance (`ai.strike.moves`, 0.5–1.5), and the aggressive tilt (`aggressiveMoves`, `aggressiveMinScore`). Exists.
- A delta target instead of the expected move (0.10–0.35). Built (`levers.putStrike: "delta"`).
- Expiry: weekly (base), 2 weeks, or about 30–45 days and managed weekly. Code: positions span weeks.
- Floor guard: ATR under the floor (`rules.strike.atrBelowFloor`). Exists.

**Managing open puts**
- Take-profit level (`ai.takeProfit`: 30/50/70/none). Exists.
- Take-profit days: Wednesday only, or any day once the rest pass fills in the daily data. Code.
- Close below the floor on/off. Code: split from the share stop.
- Stop on a put at N× its credit. Code.
- Profit velocity: close when X% is captured in well under X% of the time. Code.

**Size and margin** (every run keeps the 2x account cap)
- Monday / Wednesday targets and the ceiling (`ai.exposure`, 0.5x–2x). Exists.
- Per ticker / per theme / one contract (`ai.perTicker`, `ai.perTheme`, `ai.oneContract`). Exists.
- Most names at once; top 5 only (Kyle's way) vs every eligible name (the AI's). Code.

**Market regime**
- VIX gate: no new puts above X, or smaller size. Built (`levers.vixMax`, `riskOffScale`).
- SPY trend gate: no puts or smaller size under the N-day average, with an optional band. Built (`levers.spyMaDays`, `spyMaBand`, `riskOffScale`, `riskOffExit`).
- Core holding: idle buying power in SPY/QQQ while risk-on. Built (`levers.core`).
- The tech-bottom tripwires (`rules.techBottom`) as an on/off. Code.

**Picking names**
- Minimum score (built, `levers.minScore`). Trend filter and never-sell zone on/off. Code.
- The Sunday report's score and eligibility. Built (`levers.prep`: per-feature bonuses and filters, score cap, fund gate, Turning-up names; the live weights are `rules.score.*`). Test a ranking idea in the pick study (`npm run skynet -- picks`) before a backtest.
- An adaptive Sunday report that reads the regime each week. Built (`levers.prep.adapt`): a second ("alt") score, and a rule that blends the two rankings, switches between them on a regime feature (the momentum spread, a momentum-crash setup, VIX, breadth, dispersion, SPY's trend), or trims the list in a chosen regime. Every feature reads bars through Friday only. `npm run skynet -- regime` writes each Sunday's features so switch rules can be tried in the pick study first, against a coin-flip placebo switch (`coin`).
- Universe:
  - ETFs only
  - single stocks only
  - sector ETFs only (Kyle's Oct 29 direction)
  - top N by dollar volume
  - Kyle's own names (`data/priority.txt`)
  - no leveraged ETFs

  Code.

**Assigned shares**
- Stop below the floor (base), hold until green (built), a % stop from cost or a buffer under the floor (built, `levers.shareStop`, `stopBuffer`), or sell at the next open (no wheel). Code.
- Covered call distance (`ai.coveredCall.moves`) and minimum premium. Exists.

**Robustness** (not levers to optimise; every finalist has to survive them)
- Fill at mid − 0.5 of the spread instead of 0.25 (`ai.fillSpreadShare`). Exists.
- Fees ×3. Interest off. Exists.

**Known quirks, shared with the live race** (could become levers):
- On Wednesday, the engine can cut a put below its floor and resell the same name the same day.
- Holiday-Monday weeks sell 2-week options because of `minExpiryDays: 4`.

**Data we don't have:**
- Earnings dates: there's no calendar, but the front-week IV ÷ next-week IV (`term` in `levers.prep.filters`) finds earnings weeks (built). In the backtest, skipping them costs about 3% a year.
- Market cap: dollar volume stands in for it.
- Point-in-time S&P membership.

Each is worth a small data task before the levers that need it.

## Guardrails for sweeps and the loop

A thousand runs means the best one is partly luck. To keep the search honest:
- **Search on train** (2018–2023). **Confirm on validate** (2024–2025). **2026 is the final exam**: it runs only when Kyle says.
- **Year by year beats the total.** A change has to help most years, not just one big year. Watch 2018 Q4, 2020, 2022 and April 2025.
- **Ranking changes need many universes.** A change to the Sunday report reshuffles which speculative names get assigned, and one name can decide a year. Judge it on the full universe plus random 80% slices of it (10 or more), and against a placebo (a bonus on a feature with no signal, like RSI). Nasus's own 2023 loses to every reshuffle, placebos included.
- **Plateaus over spikes.** A setting counts only if its neighbours do well too (roc 1% wins, and 0.8% and 1.2% are close).
- **Scoring:** CAGR, max drawdown and the worst year count together, not CAGR alone. The default target is the best CAGR with max drawdown no worse than SPY's.
- Finalists have to survive the robustness levers above.
- **Loop rules:**
  - Every run goes in the ledger with its hypothesis.
  - The loop stops at a run budget or when it plateaus.
  - It ends with a written report in the journal.
  - It never edits `rules.ts`, prep or the race.
  - Kyle adopts a ruleset himself.

## UI (local, http://localhost:3000/skynet)

Kept: the single-run view (summary, chart, year → week → trades, settings).

To add for the research phase:
- **Runs table** from the ledger: one row per run, lever columns, sortable, filter by experiment, lever and verdict. Stale runs hidden.
- **Compare:** pick 2–5 runs.
  - Their curves on one chart against SPY.
  - A year-by-year grid of excess return.
  - Their settings side by side, with the differences highlighted.
- **Risk vs return:** every run as a dot (CAGR against max drawdown), coloured by a chosen lever.
- **Lever effect:** for one lever, the median result at each value across all runs, split by year.
- **Health flags** on each run, linking to the weeks that tripped them.
