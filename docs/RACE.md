# AI-vs-Kyle race runbook

The paper race behind `/race`. A scheduled Claude routine runs each part in a checkout of the repo, so the AI always
trades the latest [rules](RULES.md) (section 10 is its own playbook) and the latest Sunday report: there is nothing
to update in the routines when a rule changes. Anyone can also run it by hand.

## Ground rules

- **Paper only.** The AI never places, reviews, changes, cancels or exercises an order, and never touches alerts,
  scans or watchlists. Robinhood is read-only: quotes, history, option chains and quotes, the earnings calendar,
  accounts and portfolio values, and the order history the sync reads.
- **Kyle's dollars stay private.** Messages and the `/race` page show his side as percentages only. Never write an
  account number anywhere.
- Work in a scratch folder (e.g. `/tmp/race`), not in the repo. Don't commit anything. If a hook asks you to commit,
  don't: nothing in the repository changed.
- **Keep raw data out of the conversation.** Option chains are long (a single chain can be 100 strikes). Hand the
  quoting to helper agents that save rows to a file and reply with only the path, as in [PREP.md](PREP.md).
- All the trading math is in `src/lib/race.ts` on top of `src/lib/rules.ts`. Don't trade by judgment and don't edit
  the code during a run. If a command prints `REFUSED`, stop and report it.

## Quote rows

Every quote file is compact JSON, one array per symbol (the same shape the prep uses):

```json
{ "XLV": [{ "strike": 178, "expiry": "2026-11-20", "bid": 0.52, "ask": 0.56, "mark": 0.54, "delta": -0.16, "iv": 0.19, "open_interest": 812 }] }
```

Copy `bid_price` as it is (a 0 bid stays 0). Puts and calls go in separate files. A symbol with no contracts that
Friday goes in the manifest's `no_weekly` list.

## Monday, 7:00am Pacific (30 minutes after the open)

1. `get_equity_quotes ["SPY"]`. If the last trade isn't from today (a holiday), stop: Friday records a no-trade week.
2. `npm run race -- status` to see the open week, the shares held and the options open. If a week is still open
   (Friday didn't run), stop and report it.
3. `get_equity_quotes` for every lot; save `spots.json` as `{"SYM": last_trade_price}`.
4. `npm run race -- plan monday --spots spots.json`. It reads this week's Sunday report from the database and lists:
   `puts` (symbol, `min_strike` to `max_strike`), `calls` (covered calls on held shares, strikes at or above
   `min_strike`) and the expiry.
5. Quote them with helper agents (a few symbols each): `get_option_instruments` (chain_symbol, expiration_dates = the
   expiry, type put or call), then `get_option_quotes` for the up to 6 highest put strikes between `min_strike` and
   `max_strike`, or the up to 6 lowest call strikes at or above `min_strike`. Save `puts.json` and `calls.json`.
6. Write `monday.json`: `{"date": "YYYY-MM-DD", "puts": ["puts.json"], "calls": ["calls.json"], "no_weekly": [], "spots": "spots.json"}`.
7. `npm run race -- monday monday.json --dry-run`, then without `--dry-run`.
8. Report (it goes to a phone): each paper sale (symbol, strike, contracts, fill, premium), the exposure, and how
   many picks were skipped and why, in a few words.

## Wednesday, 7:00am Pacific (after the 5am Wednesday prep)

1. `npm run race -- status`. If no week is open, stop.
2. `get_equity_quotes` for every open option's name and every lot; save `spots.json`.
3. `npm run race -- plan wednesday --spots spots.json`. It lists the open puts (to re-quote at their own strike), new
   candidates for the freed room, and `bars` (names to fetch daily bars for).
4. `get_equity_historicals` for the `bars` symbols (interval "day", start about 45 days back); note the files. Quote
   the puts as on Monday.
5. Write `wednesday.json`: as Monday plus `"daily": [<history files>]` and `"through": "<yesterday>"` (so the floor
   check uses yesterday's close, not a half-finished bar).
6. `npm run race -- wednesday wednesday.json --dry-run`, then without `--dry-run`. It buys back puts with 50%+ of
   the premium captured or whose name closed below its floor, sells shares that closed below their floor, and
   redeploys up to 1.3x.
7. Report: what was bought back and why, what was sold, the exposure.

## Friday, 1:15pm Pacific (after the 1:00pm close)

1. **Sync Kyle's trades first** so the review sees the whole week: follow [SYNC.md](SYNC.md) steps 1 to 5 for the
   Individual account (the import is idempotent).
2. `npm run race -- friday-plan`. It lists the `daily_bars` symbols (expiring options, held shares, and the names the
   review needs a hindsight close for) with a start time, and what expires.
3. `get_equity_historicals` for those symbols in batches of 10 (interval "day", that start_time); note the files. If
   today's bar is missing for a name, add its last trade price to `spots.json` (it's marked provisional).
4. Kyle's account: `get_accounts`, then `get_portfolio` for the Individual margin account. Note `total_value` and
   `pending_deposits`. Deposits or withdrawals Kyle mentioned this week go in `flows` (deposits positive).
5. Write `friday.json`: `{"date": "YYYY-MM-DD", "daily": [...], "spots": "spots.json", "opp": {"value": <total_value>, "flows": 0, "pending": <pending_deposits>}}`.
6. `npm run race -- friday friday.json --dry-run`, then without `--dry-run`. It settles everything expiring at the
   official close, runs the stop on shares, scores the week and prints the review context: every trade that finished
   this week on both sides, graded the same way, with hindsight for each early buyback.
7. **The review.** From the context (and only from it), write `review.json`:

   ```json
   {
     "headline": "One sentence: who won the week and why.",
     "ai_good": ["The AI's best trades and what made them work."],
     "ai_bad": ["Its worst trades and what went wrong."],
     "kyle_good": ["Kyle's best trades, e.g. a CSP bought back for 40% in an hour and the money redeployed."],
     "kyle_bad": ["Kyle's worst, e.g. a covered call sold and bought back at a small loss."],
     "steal_from_kyle": ["What the AI should copy from Kyle."],
     "steal_from_ai": ["What Kyle should copy from the AI."],
     "buybacks": "What this week's early closes say: did buying back beat holding, and was the money redeployed well?",
     "lessons": [{ "side": "ai", "kind": "rule", "text": "A specific, testable change to propose." }]
   }
   ```

   Plain words, short sentences, no em dashes. Name trades by ticker, strike and day. Kyle's side in percentages or
   per-trade results only, never his account value. `kind` is keep, steal, fix or rule (a proposed rule change).
   Lessons are proposals; nothing changes a rule until Kyle adopts it.
8. `npm run race -- review review.json --dry-run`, then without `--dry-run`.
9. Report: the week's return for both sides and the total, who's ahead, both max drawdowns, the headline, and one
   lesson.

## Changing the race

- A rule change goes in `rules.ts` and RULES.md (bump the version); the next run uses it.
- The AI's own playbook is `AI` in `rules.ts` and RULES.md section 10.
- The engine is `src/lib/race.ts`; `scripts/race.ts` is the I/O.
