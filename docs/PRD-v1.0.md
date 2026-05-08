# PowerWheel AI
## Product Requirements Document (PRD)
**Author:** Kyle Needham · **Version:** 1.0 · **Date:** May 2026
**Status:** Ready for Engineering Handoff — MVP Phase

---

## 1. Background & Problem Statement

### What is the Wheel Strategy?
Options trading has a reputation for high-risk speculation. The Wheel Strategy is the opposite side of that trade. Rather than buying options and gambling on large price moves, Wheel traders *sell* options — acting as "the house." The mechanics:

1. **Sell a Cash-Secured Put (CSP):** Collect a premium upfront. If the stock stays above your strike price, you keep the cash and repeat. If it drops below, you get assigned 100 shares at a price you were already willing to pay.
2. **Sell a Covered Call (CC):** Once assigned shares, sell call options against them. Collect more premium. If the stock rises above your call strike, shares get called away at a profit. Repeat from step 1.

The result is a consistent, income-generating strategy with defined risk. The "wheel" keeps spinning: collect premium → potentially acquire stock at a discount → collect more premium → sell shares at a gain → repeat.

### The Problem
Executing this strategy weekly across a 10–20 ticker watchlist is analytically intensive. A trader must:
- Monitor current prices and week-over-week movement across all tickers
- Pull live options chains and calculate return percentages (premium / cash secured) for multiple strike prices
- Track weekly trade entries, assignments, and P&L in a spreadsheet
- Assess macro sentiment and per-ticker catalysts (earnings, FOMC, sector rotation) before committing capital

Today this is done manually across browser tabs, spreadsheets, and news feeds. It takes 3–5 hours per week. The data is stale the moment it's entered. There is no single source of truth.

**PowerWheel AI** replaces this workflow with a unified, AI-powered dashboard.

---

## 2. Product Vision

**One-click weekly refresh.** A trader opens PowerWheel on Sunday evening, hits Refresh, and within 60 seconds has a fully populated dashboard: current prices, CSP/CC premiums and return percentages for the optimal weekly strike, AI-generated sentiment and catalysts per ticker, and a macro market overview. They make decisions, log trades, and close the tab. That's the product.

**Target User:** Experienced retail options trader running a wheel strategy on a focused watchlist (10–30 tickers). Technically comfortable but not a developer. Values speed, accuracy, and signal over noise.

---

## 3. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Reduce weekly analysis time | Minutes spent on pre-trade research | < 30 min (from ~3–5 hrs) |
| Improve decision quality | % of trades influenced by AI sentiment | > 80% |
| Track performance | Weekly premium capture rate | Visible, accurate, up to date |
| Reliable data refresh | Successful refresh rate | > 95% |

---

## 4. Scope — MVP

### In Scope
- Watchlist dashboard with live price, options data, and AI sentiment
- Weekly trade tracker with manual entry and P&L calculation
- One-click AI refresh (prices + options + sentiment)
- Analytics summary (win rate, total premium, assignment %)
- Single-user, authenticated access

### Out of Scope (Post-MVP)
- Broker API integration (Robinhood, Tastytrade)
- Automated trade execution
- Multi-user / team access
- Mobile-native application
- Portfolio-level risk modeling

---

## 5. User Stories

**As a trader, I want to:**
- See all watchlist tickers with current price, day change, and 52-week high in a single table
- See the optimal CSP and CC strike for the nearest weekly expiration, with premium and % return pre-calculated
- See an AI-generated 1–2 week sentiment rating (Bullish / Neutral / Bearish) and confidence level per ticker
- See key upcoming catalysts (earnings date, FOMC, macro events) flagged automatically
- Refresh all of the above with a single button click
- Log a weekly trade (CSP or CC) with ticker, strike, premium, quantity, and expiration
- See my weekly and cumulative P&L, win rate, and assignment percentage
- View a macro market summary (SPX/VIX outlook, sector rotation, recommended weekly bias)

---

## 6. Feature Specifications

### 6.1 Watchlist Dashboard

**Layout:** Full-width data table, one row per ticker. Sortable columns. Sticky header.

**Columns:**

| Column | Source | Notes |
|--------|--------|-------|
| Ticker | User-defined | Editable |
| Company Name | Polygon.io | Auto-populated |
| Price | Polygon.io | Real-time on refresh |
| Day Change % | Polygon.io | Color-coded red/green |
| 52W High | Polygon.io | |
| CSP Strike | Polygon.io options chain | Nearest weekly, 3–5% OTM |
| CSP Premium | Polygon.io | Last price or mid |
| CSP Return % | Calculated | Premium / (Strike × 100) |
| CC Strike | Polygon.io options chain | Nearest weekly, 2–3% OTM |
| CC Premium | Polygon.io | |
| CC Return % | Calculated | Premium / (Price × 100) |
| AI Sentiment | Grok API | Bullish / Neutral / Bearish badge |
| AI Confidence | Grok API | High / Medium / Low |
| Key Catalysts | Grok API | One-line summary |
| Wheel Bias | Grok API | CSP / CC / Hold recommendation |
| Last Refresh | System | Timestamp |

**Refresh Flow:**
1. User clicks "Refresh All"
2. Frontend calls `POST /api/refresh`
3. Backend reads watchlist tickers
4. Fetches snapshot + options chain from Polygon.io per ticker
5. Constructs batch prompt → calls Grok API
6. Parses JSON response
7. Writes results to Supabase
8. Frontend re-fetches and re-renders

**Edge Cases:**
- Ticker not found on Polygon → show warning badge, skip row
- Options chain empty (illiquid ticker) → show "No data" in options columns
- Grok API timeout → surface last cached sentiment with stale timestamp indicator
- Market closed → use last available prices, flag as delayed

---

### 6.2 Weekly Trades Tracker

**Layout:** Separate tab/page. Table of all trade entries, grouped by week. Manual entry form at top.

**Trade Entry Fields:**

| Field | Type | Validation |
|-------|------|------------|
| Week # | Auto / manual | Integer |
| Week Start Date | Date picker | Required |
| Ticker | Dropdown (from watchlist) | Required |
| Contract Type | Select: CSP / CC | Required |
| Strike | Number | Required |
| Premium (per share) | Number | Required |
| Quantity (contracts) | Integer | Required, min 1 |
| Expiration Date | Date picker | Required |
| Assigned? | Toggle: Yes / No / Pending | Default: Pending |
| Actual P&L | Number | Editable after close |
| Notes | Text | Optional |

**Calculated Fields:**
- **Potential Win** = Premium × Quantity × 100 (auto-calculated, displayed)
- **Actual P&L** = User-entered after expiration

**Totals Row:** Sticky footer row showing sum of Potential Win and Actual P&L for visible (filtered) rows.

**Filters:** By week, by ticker, by contract type, by assigned status.

**Edge Cases:**
- Early close / roll → Notes field captures this; Actual P&L overrides Potential Win
- Assigned position → system flags for CC follow-up (visual indicator only, no automation in MVP)

---

### 6.3 Analytics Dashboard

**Cards (top of page):**
- Total Premium Collected (YTD)
- Win Rate (expired worthless / total contracts)
- Assignment Rate (assigned / total CSPs sold)
- Average Weekly Return %
- Capital Efficiency (avg % return per trade)

**Charts:**
- Weekly Potential vs. Actual Premium (bar chart, last 12 weeks)
- Assignment Rate Trend (line chart)
- Ticker Exposure Breakdown (pie/donut — % of trades by ticker)

**Data source:** Supabase `weekly_trades` table, aggregated client-side via recharts.

---

### 6.4 AI Analysis Engine

**Per-Ticker Prompt Structure:**
```json
{
  "context": "Wheel strategy options trader. Weekly expiration focus (0-7 DTE). Selling CSPs and CCs for premium income.",
  "tickers": [
    { "ticker": "TSLA", "price": 285.40, "day_change": "-1.2%", "52w_high": 358.64 }
  ],
  "request": "For each ticker: 1-2 week directional sentiment, confidence, key catalysts, wheel bias (CSP/CC/Hold)."
}
```

**Expected Response Schema (per ticker):**
```json
{
  "TSLA": {
    "sentiment": "Bullish",
    "confidence": "Medium",
    "catalysts": "Earnings in 3 weeks; no major macro events this week. Technically holding support.",
    "wheel_bias": "CSP"
  }
}
```

**Macro Market Summary (separate call):**
- SPX and VIX directional outlook
- Major events calendar this week (FOMC, CPI, earnings concentration)
- Recommended weekly bias: Aggressive CSP / Conservative / Heavy CC / Avoid

**Caching:** AI results cached in Supabase with `refreshed_at` timestamp. UI shows staleness indicator if > 24 hours old.

---

## 7. Data Models

### `watchlist`
```sql
create table watchlist (
  id              uuid primary key default uuid_generate_v4(),
  ticker          text unique not null,
  company_name    text,
  current_price   numeric,
  day_change_pct  numeric,
  high_52w        numeric,
  csp_strike      numeric,
  csp_premium     numeric,
  csp_return_pct  numeric,
  cc_strike       numeric,
  cc_premium      numeric,
  cc_return_pct   numeric,
  ai_sentiment    text check (ai_sentiment in ('Bullish','Neutral','Bearish')),
  ai_confidence   text check (ai_confidence in ('High','Medium','Low')),
  ai_catalysts    text,
  wheel_bias      text check (wheel_bias in ('CSP','CC','Hold')),
  refreshed_at    timestamptz,
  notes           text,
  created_at      timestamptz default now()
);
```

### `weekly_trades`
```sql
create table weekly_trades (
  id              uuid primary key default uuid_generate_v4(),
  week_number     int not null,
  week_start_date date not null,
  ticker          text references watchlist(ticker),
  contract_type   text check (contract_type in ('CSP','CC')),
  strike          numeric not null,
  premium         numeric not null,
  quantity        int not null default 1,
  expiration_date date not null,
  potential_win   numeric generated always as (premium * quantity * 100) stored,
  assigned        text check (assigned in ('Yes','No','Pending')) default 'Pending',
  actual_pnl      numeric,
  notes           text,
  created_at      timestamptz default now()
);
```

### `ai_refresh_log`
```sql
create table ai_refresh_log (
  id           uuid primary key default uuid_generate_v4(),
  refreshed_at timestamptz default now(),
  tickers      text[],
  macro_summary jsonb,
  raw_response  jsonb
);
```

---

## 8. Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | Next.js 15 (App Router) + TypeScript | Industry standard, Vercel-native |
| UI Components | shadcn/ui + Tailwind CSS | Finance-grade table components, dark mode |
| Data Tables | TanStack Table v8 | Sortable, filterable, virtualized |
| Charts | Recharts | Lightweight, composable |
| Backend | Next.js API Routes | Collocated with frontend, minimal ops |
| Database | Supabase (PostgreSQL) | Auth + DB + realtime in one |
| Market Data | Polygon.io REST API | Options chains, snapshots, 52W data |
| AI / Sentiment | Grok API (xAI) | Real-time financial knowledge, fast |
| AI Dev Tooling | Claude (Anthropic) + Cursor | Spec generation, code acceleration |
| Auth | Supabase Auth | Single-user JWT, email/password |
| Hosting | Vercel | Zero-config, free tier sufficient |
| Version Control | GitHub | Standard |

---

## 9. API Integration Notes

### Polygon.io
- **Endpoint used:** `/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}` (price/snapshot)
- **Endpoint used:** `/v3/reference/options/contracts` (options chain by expiration)
- **Rate limit:** Free tier: 5 req/min — batch calls server-side, add 300ms delay between tickers
- **Expiration targeting:** Next Friday UTC timestamp, fallback to following Friday if within 1 day of expiry
- **Strike selection logic:** CSP = highest put strike ≤ 95% of current price; CC = lowest call strike ≥ 102% of current price

### Grok API (xAI)
- **Endpoint:** `POST https://api.x.ai/v1/chat/completions`
- **Model:** `grok-3-latest`
- **Batch all tickers in one prompt** to minimize API calls and latency
- **Temperature:** 0.2 (deterministic financial analysis)
- **Response format:** Instruct JSON-only output, strip markdown fences before parse
- **Error handling:** On parse failure, log raw response and return last cached sentiment

### Supabase
- **Client:** `@supabase/supabase-js` with RLS enabled
- **Auth:** Single user, email/password. All tables scoped to `auth.uid()`
- **Realtime:** Not required for MVP; add on post-MVP for live price streaming

---

## 10. Security

- All API keys stored in Vercel environment variables (`process.env`) — never in client bundle
- Supabase RLS policies enforce single-user data isolation
- No brokerage credentials stored at any phase
- `.env.local` excluded from version control via `.gitignore`

---

## 11. Project Structure

```
powerwheel/
├── app/
│   ├── page.tsx                  # Watchlist Dashboard
│   ├── trades/page.tsx           # Weekly Trades Tracker
│   ├── analytics/page.tsx        # Analytics Dashboard
│   └── api/
│       ├── refresh/route.ts      # Main refresh endpoint
│       └── trades/route.ts       # CRUD for weekly trades
├── components/
│   ├── WatchlistTable.tsx
│   ├── TradesTable.tsx
│   ├── AnalyticsCards.tsx
│   ├── MacroSummary.tsx
│   └── RefreshButton.tsx
├── lib/
│   ├── polygon.ts                # Polygon.io client
│   ├── grok.ts                   # Grok API client
│   └── supabase.ts               # Supabase client
├── types/
│   └── index.ts                  # Shared TypeScript types
├── .env.local                    # API keys (gitignored)
└── README.md
```

---

## 12. Development Phases

### Phase 1 — Core MVP (Weeks 1–3)
- [ ] Supabase schema setup + auth
- [ ] Next.js project scaffolding + shadcn/ui
- [ ] Watchlist table (read/write from Supabase)
- [ ] Polygon.io price + options data integration
- [ ] Grok AI sentiment integration + refresh endpoint
- [ ] Weekly Trades tracker (manual entry + totals)
- [ ] Deploy to Vercel

### Phase 2 — Analytics & Polish (Weeks 4–5)
- [ ] Analytics dashboard (cards + charts)
- [ ] Macro AI summary section
- [ ] Staleness indicators + error states
- [ ] Dark mode + responsive layout
- [ ] Performance optimization (rate limiting, caching)

### Phase 3 — Post-MVP
- [ ] Broker API read integration (position import)
- [ ] Automated trade logging from broker
- [ ] AI watchlist recommendations ("suggest additions")
- [ ] Agent-based trade execution (Anthropic tool use / MCP)

---

## 13. Open Questions for Engineering

1. **Polygon free tier rate limits** — do we need a paid tier for 20+ tickers in a single refresh, or is server-side queuing sufficient?
2. **Options data freshness** — Polygon free tier returns delayed data (15 min). Is this acceptable for a pre-market Sunday refresh workflow, or should we budget for real-time tier?
3. **Supabase RLS** — confirm policy structure before schema migration. Single-user for MVP means simple `auth.uid() = user_id` pattern, but worth reviewing before Phase 3 multi-user work.
4. **Grok API JSON reliability** — response parsing requires stripping markdown fences. Add a fallback schema validator (Zod) to catch malformed responses before they hit the DB write.

---

*Document prepared by Kyle Needham. Built with Claude (Anthropic) for spec generation and Cursor for code acceleration — demonstrating AI-first PM workflow throughout.*
