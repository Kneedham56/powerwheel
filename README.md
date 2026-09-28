# PowerWheel

Tracking and reporting for an options wheel strategy: cash-secured puts, covered calls, rolls, buybacks and assignments.
It tracks several accounts and reporting streams, and measures performance against account value.

> The original AI dashboard spec (watchlist, Polygon, Grok sentiment) is in [docs/PRD-v1.0.md](docs/PRD-v1.0.md) and is parked for now.

## Features

- **Streams.** Report on buckets that don't have to match broker accounts. For example, Individual Wheel, Joint Wheel, and Tesla CC inside the joint account. Rules assign positions to streams automatically, and you can add new streams any time.
- **Full lifecycle.** Sell to open, buy back early, roll (tracked as one chain), expire worthless, and assignment. Assignment opens a stock lot; a called-away CC sells it.
- **Reports.** YTD, 30/90 days, 12 months, per year, or all time; filter by stream or account. Includes:
  - realized P&L, return on account value, win rate, gains vs losses
  - net premium after buybacks, assignment rate, rolls
  - a weekly chart, and breakdowns by stream, strategy and ticker
- **Account value snapshots.** Recorded weekly, so returns are measured against the capital you actually had.
- **Robinhood sync.** A script imports orders pulled with the Robinhood connector. It's idempotent and handles rolls. See [docs/SYNC.md](docs/SYNC.md).

## Running it

```bash
npm run dev
```

Open http://localhost:3000. Press Ctrl+C in that terminal to stop it. There is no login yet, so keep it on localhost.

| Command | What it does |
|---|---|
| `npm run dev` | the app, with live reload while you edit code |
| `npm run sync -- status` | what's synced from Robinhood, and anything waiting to be settled |
| `npm run sync -- import <file>` | import a sync file (see [docs/SYNC.md](docs/SYNC.md)) |
| `npm run sql -- "select ..."` | run SQL against the database (`-f file.sql` for a migration) |
| `npm run typecheck` / `npm run lint` | checks to run before committing |

## Setup (new machine)

1. Install Node.js 20+ and run `npm install`.
2. Create `.env.local`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   SUPABASE_SECRET_KEY=sb_secret_...
   DATABASE_URL=postgresql://...   # pooled connection string
   DIRECT_URL=postgresql://...     # direct connection string, used by npm run sql
   ```
3. Apply the migrations in order: `npm run sql -- -f supabase/migrations/0001_tracking.sql`, then `0002`, and so on.
4. In **Settings → Accounts**, enter each account's broker account number so the sync can match orders.

## Layout

```
supabase/migrations/   schema, triggers, views, seed data
src/lib/trades.ts      lifecycle operations (shared by the app and the sync)
src/lib/reports.ts     reporting math: add new metrics here
src/app/               pages: reports, positions, new trade, activity, account value, settings
scripts/sync.ts        Robinhood import (npm run sync -- status | import <file>)
```
