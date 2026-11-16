# Weekly prep runbook

The Sunday report and the Wednesday check behind `/prep`. A scheduled Claude routine runs this in a checkout of the
repo; anyone can also run it by hand. The numbers come from [`src/lib/rules.ts`](../src/lib/rules.ts) (see
[RULES.md](RULES.md)); the only hand-written part is the narrative.

## Ground rules

- **Robinhood is read-only.** Use only read tools (quotes, history, option chains and quotes, the market scanner,
  the earnings calendar, watchlists). Never place, change or cancel orders, alerts, scans or watchlists.
- **The report is public.** It must not mention any account: no holdings, positions, sizes, leverage, cost basis
  or P&L. Watchlist observations are fine ("most of the watchlist is lagging").
- Work in a scratch folder (e.g. `/tmp/prep`), not in the repo. Don't commit anything.
- **Keep raw data out of the conversation.** Scans, the VIX history, the earnings calendar and option chains often
  come back inline and are long (a single option chain can be 100 strikes). Hand each of those fetches to a helper
  agent that saves the answer exactly as returned (plain JSON) to the scratch folder and replies with only the file
  path. Answers that are saved to files automatically can be passed to the script directly.
- Plain words in every narrative field: short sentences, sentence case, no em dashes, sector names rather than
  tickers where possible. Facts only from the data and from sources you looked up this run.

## Sunday

1. **Watchlist.** `get_watchlists`, then `get_watchlist_items` for each custom list except "Options Watchlist".
   Write `wl.json`: `[{"symbol": "PLTR", "list": "CORE", "target": null}, ...]` (targets: buy prices noted in
   memory, if any; otherwise null). Never record whether a name is held.
2. **Scans.** `npm run prep -- scans --watchlist wl.json` prints two `preview_scan` argument sets. Run both and save
   the answers as `meta.json` (watchlist and funds) and `universe.json` (large-cap leaders on sale).
3. **Daily bars.** `npm run prep -- symbols --watchlist wl.json --scan universe.json` prints batches of 10 symbols
   and a start time. Call `get_equity_historicals` (interval "day", that start_time) for each batch; note each saved
   file. Then `get_index_historicals` for the VIX (instrument id `3b912aa2-88f9-4682-8ae3-e39520bdf4db`, interval
   "day", start about 130 days back) and save it as `vix.json`.
4. **Earnings.** `get_earnings_calendar` with `days: 12`, `filter: "high_market_cap"` (no start date). Save it.
5. **Manifest.** Write `manifest.json` next to the files:

   ```json
   {
     "run_date": "YYYY-MM-DD",
     "watchlist": "wl.json",
     "daily": ["<history file 1>", "..."],
     "vix": "vix.json",
     "meta_scan": ["meta.json"],
     "universe_scan": "universe.json",
     "earnings": ["<earnings file>"],
     "options": ["quotes.json"],
     "narrative": "narrative.json"
   }
   ```

   `run_date` is today. Add `"through": "YYYY-MM-DD"` (the last close) when running on a trading day, so a
   half-finished bar isn't used. You can list `quotes.json` and `narrative.json` now: files that don't exist yet are
   ignored until they do.
6. **Option quotes.** `npm run prep -- quote-plan manifest.json` lists up to 16 symbols (SPY last, for the baseline)
   with the expiry and a strike window (`min_strike` to `target_strike`). Always use helper agents for this (a few
   symbols each): for each symbol, call `get_option_instruments` (chain_symbol, expiration_dates = that expiry,
   type put), then `get_option_quotes` for the up to 8 highest strikes at or below `target_strike` (and not below
   `min_strike`), and return compact rows. Copy `bid_price` as it is (a 0 bid stays 0; the script treats that as no market). If a symbol has no
   contracts that Friday, use its nearest expiration within 9 days, or skip it. Save every symbol's rows in one
   `quotes.json`:

   ```json
   { "XLV": [{ "strike": 178, "expiry": "2026-11-20", "bid": 0.52, "ask": 0.56, "mark": 0.54, "delta": -0.16, "iv": 0.19, "open_interest": 812 }] }
   ```

7. **Context.** `npm run prep -- context manifest.json` prints the facts the narrative must match: index moves,
   this week's quadrant changes, the watchlist's stages, the picks and last week's logged results.
   `watchlist_never_sell` lists watchlist names below the 200-day on the lower band: mention them in
   `plain_read.watchlist` as names to leave alone. A stage of "Unknown" means too little price history (a recent
   listing); treat it as not a pick.
8. **Research.** WebSearch (standard mode) for: what moved markets last week and why; the US economic calendar for
   this week (CPI, PPI, jobs, retail sales, PCE, GDP, jobless claims, FOMC decisions and minutes, Fed speakers),
   confirming Fed dates on federalreserve.gov; market holidays and half days; big IPOs and index events. Earnings
   that matter: the watchlist's names, the mega caps and the big banks (from the calendar file).
9. **Narrative.** Write `narrative.json`:

   ```json
   {
     "headline": "One sentence: the week in a line.",
     "last_week": {
       "summary": "2 to 4 sentences: what happened and why, with the index and sector moves from the context.",
       "events": [{ "title": "October CPI", "result": "Hotter than expected at 0.4%; yields rose." }]
     },
     "this_week": {
       "base_case": "2 to 3 sentences: what most likely happens, and why.",
       "scenarios": [
         { "name": "Relief rally", "likelihood": "likely", "what": "...", "signals": "QQQ back above its 50-day" },
         { "name": "Chop", "likelihood": "possible", "what": "...", "signals": "..." },
         { "name": "Second leg down", "likelihood": "less likely", "what": "...", "signals": "..." }
       ]
     },
     "calendar": [
       { "date": "YYYY-MM-DD", "time": "8:30 AM", "title": "Retail sales", "kind": "macro", "importance": "high", "note": "Why it matters, one sentence.", "watchlist": false }
     ],
     "gauges": [
       { "id": "vix", "status": "yellow", "reading": "One or two sentences on what it did.", "flip": "One sentence naming the levels.", "good_level": null, "bad_level": 20 }
     ],
     "plain_read": {
       "favors": "Data favors ...",
       "avoid": "Data says avoid ...",
       "watchlist": "What this means for the watchlist names, e.g. most of them are lagging."
     },
     "watch_levels": [
       { "label": "Junk bonds floor", "symbol": "HYG", "level": 76.8, "good_when": "above", "why": "A close below says credit is cracking." }
     ]
   }
   ```

   - `kind`: macro, fed, earnings, opex, market, holiday, ipo or other. `importance`: high, medium or low.
     `watchlist: true` when it touches a watchlist name. Times are Eastern. Cover Monday to Friday; add next Monday
     if something big lands then. Include monthly options expiration (third Friday) when it's this week.
   - `gauges`: all nine ids, `vix`, `tlt`, `hyg`, `kre`, `iwm_spy`, `rsp_spy`, `uup`, `uso`, `cper`. Status is
     green, yellow or red as of the last close. `good_level` and `bad_level` are prices that would flip the read
     (VIX: bad_level only; the two ratio gauges: both null).
   - `watch_levels`: the specific market levels worth watching this week (the report already adds the 50- and
     200-day averages of SPY, QQQ, IWM and SMH, and SMH's 448). Market symbols only.
   - Scenarios: say "likely", "possible" or "less likely"; never promise an outcome.
10. **Build.** `npm run prep -- build manifest.json --dry-run`, fix anything it complains about, then run it again
    without `--dry-run`. It settles last week's logged picks, saves the report and logs this week's picks.
11. **Report.** Finish with a short message (it goes to a phone): the headline, the top picks with strike and premium,
    the 2 or 3 biggest calendar items, and anything that failed.

## Wednesday

Run after Wednesday's close.

1. `npm run prep -- wed-symbols` prints the batches (indices, every rotation fund, the watch-level symbols, Sunday's
   picks and the watchlist). Fetch daily bars for each batch as on Sunday.
2. Write `wed.json`: `{"run_date": "YYYY-MM-DD", "daily": [...files], "narrative": "wed-narrative.json"}`.
3. `npm run prep -- wed-context wed.json` prints how the indices, the watched levels, Sunday's picks and the rotation
   map moved since Sunday, the biggest watchlist moves and what's left on the calendar.
4. WebSearch what happened Monday to Wednesday (data releases, earnings, Fed talk) and what's still ahead.
5. Write `wed-narrative.json`:

   ```json
   {
     "headline": "One sentence: how the week is going.",
     "so_far": "2 to 3 sentences: what happened since Sunday, and which levels held or broke.",
     "whats_left": "1 to 2 sentences: the events still ahead and why they matter.",
     "outlook": "1 to 2 sentences: is Sunday's base case on track, and what would change it into Friday.",
     "calendar_additions": []
   }
   ```

6. `npm run prep -- wednesday wed.json --dry-run`, then without `--dry-run`.
7. Finish with a short message: the headline, any level that broke or was reclaimed, and anything that failed.
