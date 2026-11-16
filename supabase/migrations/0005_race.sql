-- AI-vs-Kyle paper race: an AI runs the wheel on a paper account by the ruleset (src/lib/rules.ts) and is
-- compared with a real account. Written by `npm run race` (see docs/RACE.md); shown at /race (private).
-- Paper only: nothing here places or describes a real order.

-- One row per race. A friend's copy of the app can run its own race against its own account.
create table races (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  starts_on     date not null,
  capital       numeric(14, 2) not null,       -- the paper account's starting cash
  opponent_account_id uuid references accounts (id),
  opponent_baseline numeric(14, 2),            -- the opponent's account value when the race started
  created_at    timestamptz not null default now()
);

-- The paper account as the engine sees it (cash, share lots, open options, peaks, the week in progress).
-- `version` pins writes so two runs can't overwrite each other.
create table race_state (
  race_id       uuid primary key references races (id) on delete cascade,
  state         jsonb not null,
  version       int not null default 1,
  updated_at    timestamptz not null default now()
);

-- One row per settled week, plus week 0 (the start).
create table race_weeks (
  race_id       uuid not null references races (id) on delete cascade,
  week          int not null,
  date          date not null,
  label         text not null,
  ai_value      numeric(14, 2) not null,
  ai_return     numeric(12, 6) not null,
  ai_week_return numeric(12, 6),
  ai_drawdown   numeric(12, 6),
  ai_max_drawdown numeric(12, 6),
  opp_value     numeric(14, 2),                -- the opponent's account value (private: the page shows % only)
  opp_return    numeric(12, 6),
  opp_week_return numeric(12, 6),
  opp_drawdown  numeric(12, 6),
  opp_max_drawdown numeric(12, 6),
  opp_flows     numeric(14, 2) not null default 0,  -- deposits (+) / withdrawals (-) taken out of the week's return
  premium       numeric(14, 2) not null default 0,
  exposure      numeric(14, 2) not null default 0,
  leverage      numeric(10, 4) not null default 0,
  counts        jsonb not null default '{}',   -- puts sold/expired/assigned, calls sold/expired/called, closes
  note          text not null default '',
  rules_version text,
  primary key (race_id, week)
);

-- Every paper trade and every skipped pick, with the reason.
create table race_trades (
  race_id       uuid not null references races (id) on delete cascade,
  id            text not null,                 -- t0001 … (engine sequence)
  date          date not null,
  week          int not null,
  action        text not null,                 -- Sold put, Sold call, Bought back, Expired, Assigned, Called away, Sold shares, Skipped
  symbol        text,
  type          text,                          -- put, call, shares
  strike        numeric(12, 4),
  expiration    date,
  qty           numeric(14, 4),
  price         numeric(12, 4),
  bid           numeric(12, 4),
  ask           numeric(12, 4),
  cash          numeric(14, 2),
  note          text not null default '',
  rules_version text,
  position_id   text,                          -- the engine's option or lot id, to tie a close to its open
  primary key (race_id, id)
);

create index race_trades_week_idx on race_trades (race_id, week);

-- The Friday review: both sides' trades graded, what to steal, and the narrative.
create table race_reviews (
  race_id       uuid not null references races (id) on delete cascade,
  week          int not null,
  data          jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (race_id, week)
);

-- Lessons that build up into rule proposals. Nothing here changes a rule by itself.
create table race_lessons (
  id            uuid primary key default gen_random_uuid(),
  race_id       uuid not null references races (id) on delete cascade,
  week          int not null,
  side          text not null check (side in ('ai', 'kyle', 'both')),
  kind          text not null check (kind in ('keep', 'steal', 'fix', 'rule')),
  text          text not null,
  status        text not null default 'proposed' check (status in ('proposed', 'adopted', 'rejected')),
  created_at    timestamptz not null default now()
);

alter table races        enable row level security;
alter table race_state   enable row level security;
alter table race_weeks   enable row level security;
alter table race_trades  enable row level security;
alter table race_reviews enable row level security;
alter table race_lessons enable row level security;
