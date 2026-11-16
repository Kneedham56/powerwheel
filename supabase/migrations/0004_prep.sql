-- Weekly prep: the Sunday report, the Wednesday check and the log of the machine's picks.
-- Written by `npm run prep` (see docs/PREP.md); shown publicly at /prep.
-- Market and watchlist data only: nothing here describes an account, a position or P&L.

create table prep_reports (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('sunday', 'wednesday')),
  week_of       date not null,               -- the Monday of the trading week the report is about
  as_of         date not null,               -- the last close the numbers use
  rules_version text not null,
  data          jsonb not null,
  created_at    timestamptz not null default now(),
  unique (kind, week_of)
);

create index prep_reports_week_idx on prep_reports (week_of desc);

-- One row per logged put: the Sunday top picks plus the SPY baseline, settled at expiration.
create table pick_log (
  id             uuid primary key default gen_random_uuid(),
  report_id      uuid not null references prep_reports (id) on delete cascade,
  week_of        date not null,
  rules_version  text not null,
  rank           int,                         -- 1-5 for picks; null for the baseline
  is_baseline    boolean not null default false,
  symbol         text not null,
  score          int,
  strike         numeric(12, 4) not null,
  expiration     date not null,
  premium        numeric(12, 4) not null,     -- per share, the mid when logged
  underlying     numeric(12, 4),              -- price when logged
  close_at_expiry numeric(12, 4),
  outcome        text check (outcome in ('expired', 'assigned')),
  pnl            numeric(12, 2),              -- per contract: premium kept, less (strike - close) when assigned
  roc            numeric(10, 6),              -- pnl / (strike * 100)
  settled_at     timestamptz,
  unique (report_id, symbol, is_baseline)
);

create index pick_log_open_idx on pick_log (expiration) where settled_at is null;

alter table prep_reports enable row level security;
alter table pick_log enable row level security;
