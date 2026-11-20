# Skynet data runbook

Skynet is the backtesting research bot. It is separate from the live rules, prep and race. This doc covers its historical market data: what gets pulled, from where, and how to run the one-month bulk download. The backtest that replays rulesets over this data has its own runbook: [SKYNET-BACKTEST.md](SKYNET-BACKTEST.md).

Everything lands in a local DuckDB file, `data/skynet.duckdb` (override with `SKYNET_DB`). The `data/` folder is gitignored. **The data is licensed for personal use only: never commit it, upload it or share it.**

## Sources

| Data | Source | Cost |
|---|---|---|
| Option chains: every strike and expiry, puts and calls, expired contracts included | ThetaData, through the local Theta Terminal | Free tier from 2023-06-01; Options Standard ($80/mo) from 2016 |
| IV, greeks, the stock price on each option row | ThetaData `greeks/eod` | Options Standard |
| Open interest | ThetaData | Options Value and up |
| Stock daily bars (OHLCV) | **Alpaca** free market-data plan (`bars` command) | Free from 2016, 200 requests/min |
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
npm run skynet -- bars [--refresh]    # Alpaca daily stock bars, 2016 on (minutes; can run during a pull)
npm run skynet -- status              # what's stored, per endpoint (during a pull: its progress file)
npm run skynet -- export              # rewrite the Parquet store from DuckDB (normally automatic)
```

**Two passes, so the useful data arrives first.** Each request costs about the same whether it returns the whole chain or a filtered slice; the vendor builds the full chain either way. So the lever is how many requests, not their size.
- **`--days core`:** greeks on the days the wheel engine trades. That's each week's first trading day (entry), its Wednesday (take-profit and redeploy; the nearest trading day if Wednesday is a holiday) and its last trading day (expiry and rolls), with open interest on entry days only. It's about 40% of the requests.
- **`--days rest`:** the other days, plus the rest of the open interest.
- **`--days core,rest`:** both passes in order in one process (one Ctrl-C stops both). This is what the paid month runs.
- **`--days all`** (the default): every day in one pass.

The passes never overlap, and the trading calendar comes from SPY's Alpaca bars, so holidays aren't requested.

As of 2026-11-19, at the measured ~1.46 s per request (SPY; smaller names are faster):
- core pass: priority list about 26 hours, everything about 10 days
- rest pass: about 14 more days

`pull` options:
- `--from` / `--to`: the window. Default is 2016-01-01 through yesterday.
- `--symbols TSLA,AAPL`: pull just these, instead of the universe.
- `--limit N`: only the top N names.
- `--concurrency N`: Standard allows 4 concurrent requests, Pro 8. The terminal queues anything above the limit, so going over is safe.
- `--max-dte N`: only expiries within N days. This saves space but drops LEAPS; the default keeps everything.
- `--min-weekly-months N`: how strict the weekly filter is (default 3).
- `--days all|core|rest|core,rest`: see above.
- `--no-oi`: skip open interest.
- `--theta-stock`: also pull ThetaData stock EOD (off by default, since Alpaca bars cover it).

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
4. `npm run skynet -- plan` gives the estimate. Then start `node --import tsx skynet/data.ts pull --days core,rest` in a terminal tab and leave it. If it stops, because of a reboot, a terminal restart or too many errors, just rerun it.
5. Check `status` now and then. Names finish in priority order, so a partial pull is still useful.
6. Before cancelling: confirm in `status` that coverage reaches 2016 for the core names, then copy `data/skynet.duckdb` somewhere safe as a backup.
7. Cancel the subscription. The free tier keeps working for new days from June 2023 on, without open interest or vendor IV.

## Stock bars (Alpaca)

ThetaData's free stock tier only reaches back to 2023-06, so daily bars come from Alpaca's free market-data plan instead.
- **Setup:** a free paper/data-only account, with keys in `.env.local` as `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY`.
- **Output:** `bars` writes `data/parquet/stock_bars/<SYMBOL>.parquet` directly, never the DuckDB file, so it runs alongside an options pull. It gets its symbol list from the exported `option_expirations.parquet` and the priority file. The full set takes about 6 minutes.
- **Adjustment:** each file holds both `raw` prices (the ones option strikes use) and `split`-adjusted prices (for indicators), in the `adjustment` column.
- **Literal tickers:** Alpaca is queried with `asof=-`, so each date gets whatever traded under that literal ticker, the same way option data is keyed. Alpaca's default rename mapping would stitch a reused ticker's old company onto its new one.
- **`segment`:** a counter that goes up at a likely company change. Indicators must never reach across segments. It triggers on:
  - a gap over 45 days (BBBY: Bed Bath ends 2023-05, Beyond starts 2025-08)
  - an overnight jump beyond 3× or under ⅓ in the split-adjusted series (META: a Roundhill ETF handed the ticker to Meta on 2022-06-09)

  Real splits and squeezes (NVDA, TSLA, AAPL, GME) don't trigger it.
- **Missing symbols:** ones Alpaca has no bars for are listed in `stock_bars/_missing.json`. As of 2026-11-19 that's 40, all index or other non-equity roots (MSCI indexes, micro index options).
  - The options pull skips these, since they can't be wheeled; priority names always stay.
  - Share-class roots map to Alpaca's dotted tickers (BRKB is `BRK.B`, RDSA is `RDS.A`).
  - For any equity that still lacks bars, the daily close is in the greeks rows (`underlying_price`) from 2017 on.

## Known gaps

- **Greeks history on Options Standard starts in early 2017.** It's a rolling 10-year window: 2016-12 returns no data and 2017-03 works. For 2016 the pull stores plain quotes and open interest, and IV and delta can be computed from those.
- The Theta Terminal listens on `0.0.0.0:25503` by default (config.toml, `host`), so other devices on the home network can reach it unless Windows Firewall blocks Java. Set `host = "127.0.0.1"` and restart the terminal to keep it local only.

- Index levels (SPX, NDX) aren't pulled. Use SPY and QQQ, or the Cboe series.
- Earnings dates and the macro calendar (Fed meetings, CPI) are not in here yet.

## Where the data lives

**Parquet is the permanent store:** `data/parquet/<table>/<SYMBOL>.parquet`, plus `data/parquet/<table>.parquet` for the reference tables.
- When a symbol finishes (or a pull stops), its rows are merged into its file and cleared from DuckDB.
- `data/skynet.duckdb` keeps only the download log (`fetch_log`) and the symbol in progress.

A running pull locks the DuckDB file, but Parquet files can be read at any time, so backtests read those. For example, in DuckDB:
`SELECT * FROM read_parquet('data/parquet/option_greeks_eod/*.parquet', union_by_name = true)`

`status` during a pull shows `data/progress.json` (symbols finished, ETA, errors). `export` rewrites the Parquet copies from DuckDB by hand; normally you never need it.

Tables:
- `option_greeks_eod`, `option_eod`, `option_oi`: one row per contract per trading day (`date`), with the vendor's columns.
  - The higher-order greeks (vanna, charm, vomma, veta, vera, speed, zomma, color, ultima, epsilon, lambda, d1, d2, dual_*) aren't stored. They are closed-form math on the stock price, strike, time, rate and IV, all of which are kept, and they were over half the bytes.
  - SPY's first 232 greeks days still have them.
- `stock_eod`, `rate_eod`, `ext_daily` (with `source` = `cboe` or `fred`): daily series.
- `option_symbols`, `option_expirations`: the universe source.
- `fetch_log`: what has been fetched (`ok` or `no_data`, rows, ms). This is what makes reruns resume.

Size: SPY, the largest chain, is about 13,000 contracts a day at roughly 40–75 bytes per row. The pull stops on its own if the data drive falls below 30 GB free.

If the vendor adds a column, it's stored as VARCHAR rather than dropped, and the run prints a note.
