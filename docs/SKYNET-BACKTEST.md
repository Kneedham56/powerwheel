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
npm run skynet -- regime                                          # the adaptive report's regime features for every Sunday
npm run skynet -- longs-study --ruleset azir                      # long-option study: what buying each name's weekly call and put paid
npm run skynet -- cache [--long] [--missing]                      # data/cache (--long: the long-dated puts levers.dte needs)
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
- **Veigar** is Azir with a volatility limit on the Sunday report: no name whose 60-day realized volatility is above 80% a year (`levers.prep.filters={"rv60":[null,0.8]}`; names with under 3 months of bars have no rv60 and are left out too). It bites mostly in wild markets (about 10% of candidates in 2020, 18% in 2025, almost none in 2018–19). Pooled over 11 universes it gives up about 2%/yr of Azir's return for a smaller worst year and drawdown, but on the full list alone it trails both Nasus and Azir, so it's a record of the round rather than a recommendation. The adaptive reports below (blend, switch, crash guard) were tried for it and did no better than a random switch.
- **Talon** trades shares only, no options: Azir's report names at RSI ≤ 40, sold at RSI ≥ 70, a stop 1 ATR under the 20-day low, or 28 days (`levers.swing`). Pooled it makes about what SPY does.
- **Zed** is Azir with no covered calls plus a 0.3x Talon swing book.
- **Braum** is buy and hold, no options (`levers.hold`): all the cash in 10 stocks ranked by steady up weeks plus 12-month momentum, an equal share each. Once a quarter a holding that has fallen out of the top 30 is sold, and the money buys the best stock not held. Nothing else sells.
- **Ornn** is Braum's book on the cash (1x) with Azir's wheel on the margin above it (up to the 2x cap).
- **Jhin** buys weekly calls only, no wheel and no puts (`levers.longs`): every Monday, 3% of the account in premium on 0.3-delta calls expiring that Friday, on the 5 stocks Braum's ranking likes best (steady up weeks + 12-month momentum), held to Friday. About 70% of the trades lose; a few 10–30x weeks pay for them.
- **Xayah** is Azir with no covered calls plus Jhin's call book at 2% of the account a week.
- **Jhin** buys weekly calls only, no wheel and no puts (`levers.longs`): every Monday, 3% of the account in premium on 0.3-delta calls expiring that Friday, on the 5 stocks Braum's ranking likes best (steady up weeks + 12-month momentum), held to Friday. About 70% of the trades lose; a few 10–30x weeks pay for them.
- **Xayah** is Azir with no covered calls plus Jhin's call book at 2% of the account a week.

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
| `levers.fridayDecide=true` | Kyle's Friday rule, at the close, for a put in the money: take assignment if the stock still passes Sunday's checks (trend qualifies, not in the never-sell zone, at or above its 20-day low); otherwise roll to next week's expiry at the lowest strike, at or under this one, that still nets a credit (a cent a share or more after the buyback); otherwise buy it back. `=floor` takes assignment whenever the stock is at or above its 20-day low (no trend check). Reads Friday's closing chain. |
| `levers.fridayRollCalls=true` | Friday, for a covered call in the money: if the stock passes the same checks, roll to next week at the highest strike, at or over this one and the cost, that still nets a credit; otherwise let it be called away. |
| `levers.dte=30` | Longer-dated puts (Zilean): Monday's and Wednesday's puts go on the Thursday/Friday expiry nearest 30 days out (within ±10) instead of this Friday. A name holds one put at a time, so its open put blocks new ones until it's closed or settled; Wednesday's take-profit and floor cut check it every week. The minimum stays per week (`ai.minWeekly` × the weeks the option spans, rounded up). Covered calls stay weekly. Open options are marked to market each Friday (mid, else intrinsic), which plain runs don't need. Reads the long chains in `data/cache/chains-long` (`cache --long`: puts only, 16–56 days out, Thursday/Friday expiries), kept apart so the Sunday report's weeklies check doesn't change. |
| `levers.dteStrike=weekly` | With `dte`: Azir's strike as is (one weekly expected move under). The default, `scaled`, goes `ai.strike.moves` moves for the option's own life (the weekly move × √((days + 1) ÷ 5)), about the weekly put's chance of assignment. `putStrike=delta` also works on Monday. |
| `levers.dteClose=21` | With `dte`: on Wednesday, buy back any put with this many days or fewer left (one expiring that week is left to settle). |
| `levers.core=1` (+ `levers.coreSymbol=QQQ`) | Core holding: after Monday's puts, buy SPY (or QQQ) until total exposure is this multiple of the account; all of it is sold when risk-off. Puts come first: the core doesn't count toward their target, only toward the 2x margin cap. It's never covered or stopped. |

### Swing levers (`levers.swing`, skynet/swing.ts)

Shares bought low and sold high from the same Sunday report: Talon alone (`mode: "only"`, no puts or calls) or beside the wheel (`mode: "add"`, Zed). It's one JSON object, so it goes in a job file (`"levers.swing={...}"`); single fields can be changed with `--set levers.swing.rsiExit=65` once a ruleset has it.

Decisions happen on the run days at the close. Between them, resting orders play out against the daily bars, oldest day first: a limit buy fills at the open if the stock opens under it, else at the limit; a target sells at the open on a gap over it, else at the target; the stop, RSI, stretch, trail and time exits read daily closes and sell at that close. Each share fill pays `slip` (default 0.05% of the price). Swing lots are ordinary share lots tagged `swing` (targets and stops are kept as multiples of the cost, so splits are safe); the wheel's own share rules leave them alone.

| Field | What it does |
|---|---|
| `mode` | `only` (no options) or `add` (beside the wheel, sharing the account and the 2x cap). |
| `exposure`, `perName`, `maxNames` | Most of the account in swing positions (1 = 1x), one position's share, most positions and resting buys at once. `volTarget` (e.g. 0.03) shrinks a position to perName × min(1, volTarget ÷ ATR%). |
| `entryDays`, `entry`, `limitAtr` | Run days that may buy (default Monday). `close` buys at that close; `limit` rests a buy limitAtr × ATR under it until Friday's close. |
| `filters`, `rank` | Each feature, as of the run day's close, within [min, max]: `pctB`, `rsi`, `vs50`, `vs200`, `offHigh`, `ret1w`, `ret4w`, `toFloor`, `atrPct`, `score`, `rs4`, `rs13`, `iv`, `rand` (a placebo). Order: the report's (score) or a feature, best first (`-rsi` = lowest first). |
| `regime` | No new buys while the ruleset's market gate (`spyMaDays`, `vixMax`) is off. |
| `targetAtr` / `targetPct` | A resting sell at cost × (1 + k × ATR%) or cost × (1 + pct). |
| `stopAtr` / `stopPct` / `stopFloor` (+ `stopFloorAtr`, `stopTrail`) | A close under cost − k ATR, cost − pct, or the 20-day low at entry minus k ATR sells. `stopTrail` raises that floor with the 20-day low. |
| `rsiExit`, `stretchAtr`, `trail`, `trailArm` | A close at RSI ≥ x or ≥ SMA20 + k ATR sells; with `trail` it arms a "close under the prior day's low" tripwire instead (also armed by a close trailArm ATR over cost). |
| `maxDays`, `exitDowntrend` | Sell after N calendar days; sell on a Monday when Sunday's report calls it a Downtrend. |
| `adoptAssigned`, `calls`, `callCoverage` | Wheel + swing: assigned shares become swing lots (these exits apply); `calls` still sells covered calls on them, at or over the swing target, the cost and the price, on callCoverage of the contracts. |
| `putMoves` + `buyZone` | Wheel + swing: a name in the buy zone (Sunday report columns, e.g. `{"rsi":[null,40]}`) gets its put `putMoves` expected moves under the price instead of the usual strike. |
| `midweekExit` | Wheel + swing: Wednesday, a covered swing lot that is stretched or hot (stretchAtr / rsiExit) is sold and its call bought back. |

`data/skynet/tools/swingstats.js <run dir prefix>` lists a run's swing trades: count, win rate, average return, days held, why they closed, P&L by year.

### Buy-and-hold levers (`levers.hold`, skynet/hold.ts)

The cash goes into the best-ranked names and stays there: a holding is sold only when the money is wanted for a better name. Alone (`mode: "only"`, no options) or with the wheel on the margin above it (`mode: "add"`). One JSON object, so it goes in a job file (`"levers.hold={...}"`).

Every week the names are ranked on bars through Friday's close, and the book acts at Monday's close (each fill pays `slip`, default 0.05%). The first week it buys the top `maxNames`, an equal share each. On each review week after that, a holding that has dropped out of the top `keep` is sold, and its money buys the best name not held. That's the only sell: no stop, no target, no trimming of winners, so position sizes drift with the winners. A held name that stops trading (no bar for 10 days: delisted or bought out) is sold at its last price. Spare money (interest, the wheel's premium) is put to work on review weeks once it's 2%+ of the account.

Beside the wheel, hold lots carry the theme `hold`: no covered calls, no floor stop or downtrend sale, and they don't use the wheel's theme caps. Like the core holding, they count toward the account's 2x margin cap but not toward the wheel's exposure targets, so with `exposure: 1` the wheel's puts get the margin above 1x. A hold lot and a wheel lot can be the same stock (the per-ticker cap counts both).

| Field | What it does |
|---|---|
| `mode`, `exposure`, `maxNames` | `only` or `add`; the book's size as a multiple of the account value (1 = all the cash); how many names. |
| `rank` | Best first, or `-x` for lowest first. A list averages the ranks. Features (on daily closes): `mom12` (t−252 → t−21, the classic momentum factor), `mom6`, `ret12`, `ret6`, `ret3`, `vs200`, `offHigh`, `rs13` (13 weeks vs SPY), `vol` (a year of daily returns, annualised), `sharpe12` (ret12 ÷ vol), `smooth` (share of up weeks in a year), `dd12` (the year's worst drawdown), `price`, `days`; placebos `rand` (new every week) and `fixed` (one per name, never changes). |
| `keep`, `review` | Sell a holding once it ranks below `keep` (default 3 × maxNames; a huge number = never sell). Review `weekly`, `monthly` (default, the first week of each month), `quarterly` or `yearly`. |
| `filters`, `universe` | Each feature within [min, max]. `all` (default), `stocks`, `funds`, or a fixed list (`["SPY"]` is SPY buy and hold, the benchmark). |
| `noLeveraged`, `bigOnly` | Leave out leveraged and inverse ETFs (default yes); only names passing the report's size test, 20-day dollar volume of $100M+ (default yes; funds always pass). |
| `weekliesNow`, `topVolume` | Point-in-time universe checks (default off). `weekliesNow`: only names with weekly options that week. The stock list is every name that ever had weeklies, so without it the book can buy a future winner before it got them. `topVolume: N`: only the N names with the most 20-day dollar volume that week. Like `bigOnly`, a holding that stops qualifying can be sold on a review week. |
| `regime` | Sell the book on a Monday when the ruleset's market gate (`spyMaDays`, `vixMax`) is off, and buy back once it's on. Off by default (Buffett doesn't time). |
| `weight`, `minTrade`, `slip` | `equal` (default) or `rank` (best-ranked get more); spare money under this share of the account waits (default 0.02); cost per share fill. |

### Long-option levers (`levers.longs`, skynet/longs.ts)

Weekly calls and puts bought, alone (`mode: "only"`, no wheel) or beside the wheel (`mode: "add"`, sharing the account). One JSON object, so it goes in a job file (`"levers.longs={...}"`).

Monday at the close each side (`calls`, `puts`) ranks the names with weeklies that pass the size test, on features from bars through Friday's close, and buys the top `maxNames` that pass its filters and have a real market: the contract expiring that Friday (no Friday expiry that week, no buy), at mid + ¼ spread. Each position gets `budget` ÷ `maxNames` of the account value in premium, in whole contracts. Wednesday a position can be sold at mid − ¼ spread (`takeProfit`, `stopLoss`, `wedExit`). Friday what's left settles at its intrinsic value from the close, as cash (no shares change hands). The $0.03 fee is paid on each buy and sell, and on a settlement worth something.

The positions are kept apart from the wheel's short options (`longs` in the state) and are always gone by Friday's close, so the week's account value is right. In between, the account value the wheel reads on Wednesday leaves them out (small: one week's premium). The stored chains keep puts from 0.5x to 1.05x the price and calls from 0.95x to 1.6x, so an option that has gone deep in the money is priced on Wednesday by put-call parity from the other side at the same strike.

| Field | What it does |
|---|---|
| `mode` | `only` or `add`. |
| `calls`, `puts` | One side each: `maxNames`, `budget` (premium each Monday as a share of the account value), `strike` (`atm`, default: nearest the price; `otm` / `itm`: nearest \|delta\| 0.3 / 0.7; or a delta number), `rank` (best first, `-x` lowest first, a list averages the ranks), `filters` ([min, max] per feature), `universe` (`big`, default, `stocks`, `funds`, or `report`: the Sunday report's eligible names), `symbols` (a fixed list), `regime` (`on`: buy only while the ruleset's market gate is on; `off`: only while it's off), `maxSpread` (spread ÷ mid), `minPrice` (per share, default 0.05). |
| features | `ret1w`, `ret4w`, `ret13w`, `vs50`, `vs200`, `pctB`, `rsi`, `offHigh`, `rv20`, `atrPct`, `rs4`, `rs13` (vs SPY), `mom12`, `smooth`, `vol` (as in the hold book), `iv`, `ivRank`, `ivrv`, `term`, `score` (the Sunday report's, null if not eligible), `stageN` (Leader 3 … Downtrend −2), the market (`spyVs200`, `spyRet4w`, `vix`), placebos `rand` and `fixed`. |
| `takeProfit`, `stopLoss`, `wedExit` | Wednesday: sell a position up at least this share, down at least this share, or every position. A contract with no bid is held to Friday. |
| `noLeveraged` | Leave out leveraged and inverse ETFs (default yes). |

**Long-option study.** `npm run skynet -- longs-study --ruleset azir` writes `data/skynet/longs-<ruleset>.jsonl`: one row per name per week (names with weeklies passing the size test), with the features above and, for the call and the put at three strikes (at the money, \|delta\| ≈ 0.3 out, ≈ 0.7 in), the Monday fill and the return per dollar of premium held to Friday (`_fri`) or sold Wednesday (`_wed`). `data/skynet/tools/longs.js` prints returns by feature decile (train vs validate), `longtopk.js` screens a ranking rule compounded at a weekly budget, and `longconc.js` shows how much of a rule's profit comes from its best trades. Check a ranking idea there before a backtest.

### Sunday-report levers

`levers.prep` changes the Sunday report itself (`buildCandidates` in `skynet/logic.ts`). The live prep's score weights are already in the ruleset (`rules.score.*`, e.g. `rules.score.premiumMax=30`). `levers.prep` adds what the live prep doesn't have. JSON values are parsed, so they go in a job file or a single `--set`:

| Lever | What it does |
|---|---|
| `levers.prep.bonus={"vs200":[0,0.5,10]}` | Extra score points per feature: 0 at the first number, the third number of points at the second, linear and clamped in between. |
| `levers.prep.filters={"term":[null,1.15]}` | A candidate is eligible only with each feature inside [min, max] (`null` = no bound). A missing feature fails. |
| `levers.prep.maxScore=200` | The score cap (default 100). Raise it with bonuses so the top names don't tie at 100. |
| `levers.prep.fundGate=false` | Let funds outside Leading/Improving groups in on their own trend. |
| `levers.prep.turningUp=false` | Drop "Turning up" names from the eligible list. |
| `levers.prep.adapt={...}` | The adaptive report (below): a second score and a rule that picks or mixes the two rankings each Sunday. |

#### The adaptive report (`levers.prep.adapt`)

The ruleset's own score is the **base** ranking. `adapt.alt` describes a second one: `score` (overrides of `rules.score`, e.g. the trend points and `premiumMax`), `bonus` and `maxScore`, in the same form as above. Azir's report as an alt on top of Nasus:

```json
{"score":{"trend":{"Leader pulling back":20,"Leader":20,"Turning up":20},"premiumMax":30},"bonus":{"vs200":[0,0.5,10],"rs13":[0,0.3,10],"ivrv":[1,1.6,10]},"maxScore":200}
```

`adapt.mode` decides how the two are used each Sunday:

| Mode | What it does |
|---|---|
| `alt` | Always the alt ranking. Nasus + `alt` = Azir, trade for trade. |
| `blend` | Interleave the two orders, base first, no duplicates (`blendShare`: the alt's share of slots, default 0.5). Each name keeps the score of the ranking that placed it, and the engine keeps this order (`ranked` in engine.ts). No timing. |
| `switch` | The alt while every feature in `when` is inside its [min, max] (null = no bound), else `otherwise` (`base`, the default, or `blend`). |
| `base` | Always the base ranking (to use `trim` on its own). |

`adapt.trim={"when":{…},"keep":4}` shortens the list in a regime: while every feature in `when` holds, only the top `keep` names stay eligible (the rest are flagged "Trimmed: regime"), so fewer puts are sold that week.

The switch reads **regime features** (`regimeFeatures` in `skynet/logic.ts`), measured from bars through Friday's close and VIX through Friday:

| Feature | Meaning |
|---|---|
| `mom` | The momentum spread: for each weekly cohort `horizon` to `horizon + weeks − 1` weeks back (`adapt.mom`, default 4 and 13), the uptrending stocks (above their 200-day then) ranked by Azir's momentum bonus at that date (vs200, rs13); the top third's return over the next `horizon` weeks minus the rest's. Averaged over the cohorts. Every return ends at or before Friday. |
| `momHit`, `momLast` | The share of those cohorts where momentum paid; the latest cohort's spread. |
| `crash` | 1 when SPY fell `adapt.crash.drop`+ from its 6-month high to a low within the last `weeks` weeks and has bounced `bounce`+ off it (defaults 10%, 8, 5%): the momentum-crash setup. `crashDrop`, `crashBounce` are the parts. `crash.lag` runs the same test as of that many weeks earlier: a placebo with the right shape and the wrong timing. |
| `spyVs200`, `spyRet4`, `spyRet13`, `spyDd` | SPY's distance from its 200-day, 4- and 13-week return, and distance from its 6-month high. |
| `vix`, `vixVs50` | VIX's last close, and VIX ÷ its 50-day average − 1. |
| `breadth`, `disp` | The share of stocks above their 200-day; the cross-sectional spread (stdev) of 20-day returns. |
| `coin`, `u` | 0 or 1 (`coin`), or a number in [0, 1) (`u`), from a hash of the date: placebo switches with no market information. `"when":{"u":[0.23,null]}` uses the alt on a random 77% of Sundays. |

Examples: the momentum switch is `{"mode":"switch","alt":{…},"when":{"mom":[0,null]}}`; the crash guard is `{"mode":"switch","alt":{…},"when":{"crash":[null,0.5]},"crash":{"drop":0.15,"weeks":13,"bounce":0.1}}`.

**What the Veigar round found (2026-11-23):** on 11 universes, every timing rule (momentum switch, crash guards, blend) landed between Nasus and Azir, and none beat a random switch with the same share of weeks. The crash guard shifted 26 weeks late scored best of all. Path luck along the timeline is bigger than these signals, and slicing the stock list doesn't average it out. Hold any new switch rule to the `u` and `crash.lag` placebos.

`npm run skynet -- regime` writes every Sunday's features (and a few parameter variants) to `data/skynet/regime.jsonl`, keyed by the Monday like the pick file, so switch rules can be tried in the pick study first (`data/skynet/tools/switch.js`).

The features are listed on `PrepLevers` in `skynet/rulesets.ts`: returns, realized vol, IV ÷ realized vol, IV rank, distance from the high, floor and averages, %B, RSI, the put's premium and distance, `term`, and `rand` (a hash of the name and date: a placebo with no market information, e.g. `filters={"rand":[0.07,null]}` drops a random 7% of names each week). `term` is the front week's at-the-money IV ÷ the next expiry's (`feed.termRatio`). An earnings report before the front expiry pushes it to about 1.2, so `term ≤ 1.15` stands in for prep's earnings rule. In 2023 it caught every earnings week of AAPL, NFLX, NVDA and JPM, with no false alarms. The report cache is keyed by `rules` and `levers.prep`.

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
| Friday (the week's last day) | Friday's close (and its option chain, for the Friday rule) | Settle: assigned if the stock closed past the strike (or the Friday rule rolls or buys back first). Then stops, mark to market, score the week |

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

- `run.json`: everything the `/skynet` page reads (format 2): the ruleset, the options, the totals and years, every week, every trade, the graded trades and the end state. Runs from before format 2 don't appear on the page; rerun them to see them. Each week also lists `holdings`: the shares held at Friday's close (name, shares, close). The page shows them over a week's trades. Runs from before 2026-11-24 don't have them and show premium by ticker instead.
- `weeks.csv`: one row per week: value, return, drawdown, leverage, premium, counts, holdings, and `spy_*` for the benchmark
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
