# Skynet data runbook

Skynet is the backtesting research bot. It is separate from the live rules, prep and race. This doc covers its historical market data: what gets pulled, from where, and how to run the one-month bulk download.

Everything lands in a local DuckDB file, `data/skynet.duckdb` (override with `SKYNET_DB`). The `data/` folder is gitignored. **The data is licensed for personal use only: never commit it, upload it or share it.**

## Sources

| Data | Source | Cost |
|---|---|---|
| Option chains: every strike and expiry, puts and calls, expired contracts included | ThetaData, through the local Theta Terminal | Free tier from 2023-06-01; Options Standard ($80/mo) from 2016 |
| IV, greeks, the stock price on each option row | ThetaData `greeks/eod` | Options Standard |
| Open interest | ThetaData | Options Value and up |
| Stock daily bars | ThetaData `stock/history/eod` | Free from 2023-06; earlier needs a stock subscription |
| Symbol list and expiration history from 2012, delisted names included | ThetaData | Free |
| VIX, VIX9D, VIX3M, VVIX daily history | Cboe's public CSVs | Free |
| 3-month T-bill rate (DTB3) | FRED | Free |
| SOFR and 3-month Treasury | ThetaData | Free from 2024 |

The downloader works out what your subscription covers on its own. It fetches the newest days first; the first refusal from the vendor tells it the history limit, and older days for that endpoint are skipped. Refused requests aren't logged, so once you upgrade, the same command pulls what was missing.

If `greeks/eod` is available, it replaces the plain quote endpoint, since it returns the same bid/ask/OHLC fields plus IV, greeks and the stock price.

## Theta Terminal

- It lives in `E:\ThetaTerminal`, outside the repo. The login is in `creds.txt` next to the jar: email on line 1, password on line 2. Edit it in Notepad, never in a terminal.
- Start it from a terminal in that folder and leave it running while pulling:
  `& 'C:\Program Files\Eclipse Adoptium\jre-21.0.13.9-hotspot\bin\java.exe' -jar ThetaTerminalv3.jar`
- The startup log shows the subscription, e.g. `Subscriptions: Stock: FREE Options: STANDARD ...`.
- Only one terminal may run at a time (a second one causes error 478).

## Commands

In Windows PowerShell, type `npm.cmd` instead of `npm`, since the default script policy blocks `npm.ps1`.

```
npm run skynet -- universe            # symbol list + expiration history for every symbol (about 40 min on free, done once)
npm run skynet -- priority            # write data/priority.txt from the app DB: index ETFs, traded tickers, prep-report names
npm run skynet -- plan                # which symbols a pull covers, with a time estimate
npm run skynet -- pull                # the download (resumable; rerun the same command after any stop)
npm run skynet -- ref                 # Cboe VIX family, FRED T-bill, Theta rates
npm run skynet -- status              # what's stored, per endpoint
```

`pull` options:
- `--from` / `--to`: the window. Default is 2016-01-01 through yesterday.
- `--symbols TSLA,AAPL`: pull just these, instead of the universe.
- `--limit N`: only the top N names.
- `--concurrency N`: Standard allows 4 concurrent requests, Pro 8. The terminal queues anything above the limit, so going over is safe.
- `--max-dte N`: only expiries within N days. This saves space but drops LEAPS; the default keeps everything.
- `--min-weekly-months N`: how strict the weekly filter is (default 3).
- `--no-oi` / `--no-stock`: skip open interest or stock bars.

**Priority:** `data/priority.txt` is pulled before the rest of the universe, top to bottom. `priority` builds it from:
- SPY, QQQ and IWM
- every ticker Kyle has traded, most-traded first
- every symbol that has appeared in a prep report

The file is local, since `data/` is gitignored, so the traded list never reaches the repo. You can edit it by hand. Each symbol is pulled for the whole window before the next one starts, so the names at the top are complete and usable while the rest keep downloading.

- `--priority-only` stops after the priority list.
- `--no-priority` ignores it.

As of 2026-11-19, at 4 requests at a time and about 1 second each:
- the index ETFs plus traded names (top 45): about 12 hours
- the whole priority list (135): about 2 days
- everything (about 1,365): about 17 days

**Universe:** every symbol that had weekly options, meaning 3+ expirations in a month, in at least 3 months of the window. It's worked out from each symbol's expiration history, so names that were delisted later are included. SPY, QQQ and IWM go first, then names ordered by how many months they had weeklies. Cash-settled index options (SPX, NDX, RUT, VIX and similar) are excluded.

Ctrl-C stops after the requests in flight finish. Each day's rows and its log entry are written in one transaction, so a crash or kill loses nothing and resumes cleanly.

## The paid month

1. Run the free steps first, so no paid time goes to setup: `universe`, `priority`, `ref`, and a small `pull` to confirm the terminal works.
2. Subscribe to **Options Standard, billed monthly**. Restart the Theta Terminal and check that the log says `Options: STANDARD`.
3. Smoke test: `npm run skynet -- pull --symbols SPY --from 2016-01-04 --to 2016-01-08`. Then `status`: `option_greeks` and `option_oi` should have rows, and `underlying_price` and `implied_vol` should be filled in.
4. `npm run skynet -- plan` gives the estimate. Then start `npm run skynet -- pull` in a terminal tab and leave it. If it stops, because of a reboot, a terminal restart or too many errors, just rerun it.
5. Check `status` now and then. Names finish in priority order, so a partial pull is still useful.
6. Before cancelling: confirm in `status` that coverage reaches 2016 for the core names, then copy `data/skynet.duckdb` somewhere safe as a backup.
7. Cancel the subscription. The free tier keeps working for new days from June 2023 on, without open interest or vendor IV.

## Known gaps

- **Greeks history on Options Standard starts in early 2017.** It's a rolling 10-year window: 2016-12 returns no data and 2017-03 works. For 2016 the pull stores plain quotes and open interest, and IV and delta can be computed from those.
- The Theta Terminal listens on `0.0.0.0:25503` by default (config.toml, `host`), so other devices on the home network can reach it unless Windows Firewall blocks Java. Set `host = "127.0.0.1"` and restart the terminal to keep it local only.

- **Stock bars before 2023-06 need a stock subscription.** Options Standard covers options only. The greeks rows carry the daily stock close, `underlying_price`, which is enough for pricing. Indicators that need high/low/volume (ATR, volume trends) need stock bars, so decide on day 1 whether to add a stock plan for the same month.
- Index levels (SPX, NDX) aren't pulled. Use SPY and QQQ, or the Cboe series.
- Earnings dates and the macro calendar (Fed meetings, CPI) are not in here yet.

## Tables

- `option_greeks_eod`, `option_eod`, `option_oi`: one row per contract per trading day (`date`), with the vendor's columns as delivered.
- `stock_eod`, `rate_eod`, `ext_daily` (with `source` = `cboe` or `fred`): daily series.
- `option_symbols`, `option_expirations`: the universe source.
- `fetch_log`: what has been fetched (`ok` or `no_data`, rows, ms). This is what makes reruns resume.

If the vendor adds a column, it's stored as VARCHAR rather than dropped, and the run prints a note.
