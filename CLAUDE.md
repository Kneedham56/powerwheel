@AGENTS.md

# PowerWheel — project context

Personal tracking + reporting app for Kyle's options **wheel strategy** (sell CSPs → get assigned → sell CCs → called away).
The AI forecasting / watchlist ideas in `docs/PRD-v1.0.md` are **parked**; current scope is tracking and reporting only.

## What it must handle
- Two Robinhood accounts: **Individual** and **Joint**. (A Roth IRA and an "Agentic" account also exist — not tracked unless Kyle asks.)
- Reporting **streams**, independent of accounts: Individual Wheel, Joint Wheel, Tesla CC (TSLA calls + shares inside Joint).
  Streams are data, not code — new ones are added in Settings; `stream_rules` auto-assign positions.
- Lifecycle events: sell to open, buy back early, roll (close + reopen as one chain), expire worthless, assignment (CSP → shares, CC → called away).
- Performance relative to account value (weekly `snapshots`), YTD / all-time / by-year filters, wins vs losses.
- Previous tracking was a weekly Google Sheet (ticker, call/put strike, qty, premium, potential win, assigned?, return % = premium / collateral).

## Architecture
- Next.js 16 App Router + Tailwind v4 + Recharts; server components + server actions. Runs on localhost (no auth yet — add Supabase Auth before deploying).
- Supabase Postgres. Schema: `supabase/migrations/*.sql`, applied in order with `npm run sql -- -f <file>` (uses `DIRECT_URL`). Schema changes go in a new numbered migration; never edit an applied one. RLS on, no policies; server uses `SUPABASE_SECRET_KEY`.
- Tables: `accounts`, `streams`, `stream_rules`, `positions` (one contract series / stock lot), `transactions` (events), `snapshots`.
  Views: `v_positions` (P&L per position), `v_transactions`.
- DB triggers own the math: `transactions.amount` (signed cash, ×100 for options, net of fees) and `positions.status` / `closed_at`.
- `src/lib/trades.ts` — lifecycle operations, shared by the app and `scripts/sync.ts` (keep it free of Next.js imports).
- `src/lib/reports.ts` — pure reporting functions. "Realized" = roll chains closed in the period; "cash" = option cash flow by date. New metrics go here.
- `src/lib/cycles.ts` — wheel cycles: per account+ticker, first put assignment until assigned shares are gone; total = assigned put premium + covered-call premium while holding + share P&L vs strike.
- `scripts/sync.ts` + `docs/SYNC.md` — Robinhood import (idempotent via leg ids in `transactions.broker_ref`).

## Conventions
- Premium/price is **per share** (as quoted); cash = price × contracts × 100.
- Dates from forms are stored at 12:00 UTC; reports bucket by US/Eastern date; weeks start Monday.
- Never commit `.env.local`. Never print key values.
- Only use **read** tools on the Robinhood connector. Never place, cancel, or modify orders.

## Commands
- `npm run dev` — app at http://localhost:3000
- `npm run typecheck`, `npm run lint`, `npm run build`
- `npm run sync -- status` / `npm run sync -- import <file.json>`
- `npm run sql -- "<sql>"` for ad-hoc queries

## Data notes
- History was backfilled on 2026-09-27 from Robinhood (Individual from Oct 2025, Joint from Nov 2025). Weekly realized option P&L was checked against `get_realized_pnl`; see the end of docs/SYNC.md.
- The Robinhood data supersedes the Google Sheet history. The sheet was only used to settle Individual expirations before 2025-11-03.
- Share lots exist only for shares that came from assignments. The TSLA shares in Joint predate tracking, so Tesla CC capital comes from stream snapshots.
