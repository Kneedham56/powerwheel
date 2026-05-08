7. Data Models
watchlist
sqlcreate table watchlist (
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
weekly_trades
sqlcreate table weekly_trades (
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
ai_refresh_log
sqlcreate table ai_refresh_log (
  id           uuid primary key default uuid_generate_v4(),
  refreshed_at timestamptz default now(),
  tickers      text[],
  macro_summary jsonb,
  raw_response  jsonb
);
