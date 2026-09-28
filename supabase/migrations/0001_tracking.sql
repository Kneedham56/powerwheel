-- PowerWheel tracking schema
-- Run once in Supabase → SQL Editor (safe to re-run only on an empty project).
--
-- Model:
--   accounts      broker accounts (Individual, Joint)
--   streams       reporting buckets (Individual Wheel, Joint Wheel, Tesla CC, ...)
--   stream_rules  auto-assign new positions to a stream by account / ticker / kind
--   positions     one option contract series (or one stock lot) — a single leg
--   transactions  every event against a position: open, buy back, roll, expire, assign
--   snapshots     account (or stream) value on a date, for return-on-capital reporting
--
-- A roll = buy_to_close on the old position + sell_to_open on a new position, both
-- sharing roll_group_id; the new position's rolled_from_id points at the old one and
-- both share chain_id, so a rolled trade reports as one chain.


-- ---------------------------------------------------------------------------
-- accounts / streams
-- ---------------------------------------------------------------------------

create table accounts (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  broker             text not null default 'robinhood',
  broker_account_ref text unique,          -- broker account number, used by sync to match
  is_active          boolean not null default true,
  created_at         timestamptz not null default now()
);

create table streams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  slug        text not null unique,
  description text,
  color       text,                        -- hex, used in charts
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- null column = "matches anything". Lowest priority wins.
create table stream_rules (
  id         uuid primary key default gen_random_uuid(),
  stream_id  uuid not null references streams(id) on delete cascade,
  account_id uuid references accounts(id) on delete cascade,
  ticker     text,
  kind       text check (kind in ('put', 'call', 'stock')),
  priority   int not null default 100,
  created_at timestamptz not null default now()
);

create or replace function assign_stream(p_account uuid, p_ticker text, p_kind text)
returns uuid
language sql stable
as $$
  select r.stream_id
  from stream_rules r
  join streams s on s.id = r.stream_id and s.is_active
  where (r.account_id is null or r.account_id = p_account)
    and (r.ticker is null or upper(r.ticker) = upper(p_ticker))
    and (r.kind is null or r.kind = p_kind)
  order by r.priority,
           (r.account_id is not null)::int + (r.ticker is not null)::int + (r.kind is not null)::int desc
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- positions
-- ---------------------------------------------------------------------------

create table positions (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references accounts(id),
  stream_id        uuid not null references streams(id),
  instrument       text not null default 'option' check (instrument in ('option', 'stock')),
  ticker           text not null,
  option_type      text check (option_type in ('put', 'call')),
  side             text not null default 'short' check (side in ('short', 'long')),
  strike           numeric(12, 4),
  expiration       date,
  strategy         text generated always as (
                     case
                       when instrument = 'stock' then 'STOCK'
                       when option_type = 'put'  and side = 'short' then 'CSP'
                       when option_type = 'call' and side = 'short' then 'CC'
                       else 'OTHER'
                     end) stored,
  status           text not null default 'open'
                     check (status in ('open', 'closed', 'expired', 'assigned', 'rolled')),
  opened_at        timestamptz not null,
  closed_at        timestamptz,
  rolled_from_id   uuid references positions(id) on delete set null,
  chain_id         uuid not null,          -- root position of a roll chain (self when never rolled)
  assigned_from_id uuid references positions(id) on delete set null,  -- stock lot created by an assignment
  broker_ref       text,                   -- broker option instrument id (same contract can be reopened later)
  notes            text,
  created_at       timestamptz not null default now(),
  constraint option_fields check (
    instrument = 'stock' or (option_type is not null and strike is not null and expiration is not null)
  )
);

create index positions_account_idx on positions(account_id);
create index positions_stream_idx  on positions(stream_id);
create index positions_chain_idx   on positions(chain_id);
create index positions_opened_idx  on positions(opened_at);
create index positions_broker_idx  on positions(account_id, broker_ref);

create or replace function positions_before_insert()
returns trigger
language plpgsql
as $$
declare
  parent positions;
begin
  new.ticker := upper(trim(new.ticker));

  if new.rolled_from_id is not null then
    select * into parent from positions where id = new.rolled_from_id;
    new.chain_id  := coalesce(new.chain_id, parent.chain_id);
    new.stream_id := coalesce(new.stream_id, parent.stream_id);
  end if;

  new.chain_id := coalesce(new.chain_id, new.id);

  if new.stream_id is null then
    new.stream_id := assign_stream(
      new.account_id, new.ticker,
      case when new.instrument = 'stock' then 'stock' else new.option_type end);
  end if;

  if new.stream_id is null then
    raise exception 'No stream matched account %, ticker %. Add a stream rule.', new.account_id, new.ticker;
  end if;

  return new;
end $$;

create trigger positions_before_insert
before insert on positions
for each row execute function positions_before_insert();

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------

create table transactions (
  id            uuid primary key default gen_random_uuid(),
  position_id   uuid not null references positions(id) on delete cascade,
  occurred_at   timestamptz not null,
  action        text not null check (action in (
                  'sell_to_open', 'buy_to_close',     -- short options (the wheel)
                  'buy_to_open',  'sell_to_close',    -- long options
                  'expire', 'assign',                 -- option leaves with no cash
                  'buy', 'sell'                       -- stock
                )),
  quantity      numeric(14, 4) not null check (quantity > 0),   -- contracts, or shares for stock
  price         numeric(12, 4) not null default 0,              -- per share
  fees          numeric(12, 2) not null default 0,
  amount        numeric(14, 2),              -- signed cash flow net of fees; computed when null
  roll_group_id uuid,                        -- shared by the two legs of a roll
  broker_ref    text unique,                 -- broker order/leg id — makes sync idempotent
  source        text not null default 'manual' check (source in ('manual', 'sync', 'import')),
  notes         text,
  created_at    timestamptz not null default now()
);

create index transactions_position_idx on transactions(position_id);
create index transactions_occurred_idx on transactions(occurred_at);

create or replace function transactions_before_write()
returns trigger
language plpgsql
as $$
declare
  mult numeric;
  sign numeric;
begin
  if new.amount is null then
    select case when instrument = 'option' then 100 else 1 end into mult
    from positions where id = new.position_id;

    sign := case
      when new.action in ('sell_to_open', 'sell_to_close', 'sell') then 1
      when new.action in ('buy_to_close', 'buy_to_open', 'buy') then -1
      else 0
    end;

    new.amount := round(sign * new.price * new.quantity * mult - new.fees, 2);
  end if;
  return new;
end $$;

create trigger transactions_before_write
before insert or update on transactions
for each row execute function transactions_before_write();

-- Keep positions.status / closed_at in sync with their transactions.
create or replace function refresh_position_status(p_position uuid)
returns void
language plpgsql
as $$
declare
  opened   numeric;
  closed   numeric;
  last_txn transactions;
begin
  select
    coalesce(sum(quantity) filter (where action in ('sell_to_open', 'buy_to_open', 'buy')), 0),
    coalesce(sum(quantity) filter (where action not in ('sell_to_open', 'buy_to_open', 'buy')), 0)
  into opened, closed
  from transactions where position_id = p_position;

  select * into last_txn
  from transactions
  where position_id = p_position and action not in ('sell_to_open', 'buy_to_open', 'buy')
  order by occurred_at desc, created_at desc
  limit 1;

  if opened > 0 and closed >= opened then
    update positions set
      status = case
        when last_txn.action = 'expire' then 'expired'
        when last_txn.action = 'assign' then 'assigned'
        when last_txn.roll_group_id is not null then 'rolled'
        else 'closed'
      end,
      closed_at = last_txn.occurred_at
    where id = p_position;
  else
    update positions set status = 'open', closed_at = null where id = p_position;
  end if;
end $$;

create or replace function transactions_after_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform refresh_position_status(old.position_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform refresh_position_status(new.position_id);
  end if;
  return null;
end $$;

create trigger transactions_after_write
after insert or update or delete on transactions
for each row execute function transactions_after_write();

-- ---------------------------------------------------------------------------
-- snapshots
-- ---------------------------------------------------------------------------

-- stream_id null = whole account. Set stream_id to record capital allocated to a
-- stream inside an account (e.g. the TSLA shares backing Tesla CC).
create table snapshots (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts(id) on delete cascade,
  stream_id    uuid references streams(id) on delete cascade,
  as_of        date not null,
  total_value  numeric(14, 2) not null,
  cash         numeric(14, 2),
  net_deposits numeric(14, 2) not null default 0,  -- money added (+) / withdrawn (-) since the prior snapshot
  source       text not null default 'manual' check (source in ('manual', 'sync', 'import')),
  notes        text,
  created_at   timestamptz not null default now(),
  unique nulls not distinct (account_id, stream_id, as_of)
);

-- ---------------------------------------------------------------------------
-- reporting views
-- ---------------------------------------------------------------------------

create or replace view v_positions
with (security_invoker = true)
as
select
  p.*,
  a.name  as account_name,
  s.name  as stream_name,
  s.slug  as stream_slug,
  s.color as stream_color,
  coalesce(t.opened_qty, 0)                        as quantity,
  coalesce(t.opened_qty, 0) - coalesce(t.closed_qty, 0) as open_quantity,
  t.open_price,
  t.close_price,
  coalesce(t.credits, 0)                           as credits,
  coalesce(t.debits, 0)                            as debits,
  coalesce(t.fees, 0)                              as fees,
  coalesce(t.net, 0)                               as net_amount,
  case when p.instrument = 'option'
       then p.strike * 100 * coalesce(t.opened_qty, 0) end as collateral,
  (date_trunc('week', p.opened_at at time zone 'America/New_York'))::date as week_start
from positions p
join accounts a on a.id = p.account_id
join streams  s on s.id = p.stream_id
left join lateral (
  select
    sum(quantity) filter (where action in ('sell_to_open', 'buy_to_open', 'buy'))     as opened_qty,
    sum(quantity) filter (where action not in ('sell_to_open', 'buy_to_open', 'buy')) as closed_qty,
    sum(price * quantity) filter (where action in ('sell_to_open', 'buy_to_open', 'buy'))
      / nullif(sum(quantity) filter (where action in ('sell_to_open', 'buy_to_open', 'buy')), 0) as open_price,
    sum(price * quantity) filter (where action in ('buy_to_close', 'sell_to_close', 'sell'))
      / nullif(sum(quantity) filter (where action in ('buy_to_close', 'sell_to_close', 'sell')), 0) as close_price,
    sum(amount) filter (where amount > 0) as credits,
    -sum(amount) filter (where amount < 0) as debits,
    sum(fees) as fees,
    sum(amount) as net
  from transactions tx
  where tx.position_id = p.id
) t on true;

create or replace view v_transactions
with (security_invoker = true)
as
select
  tx.*,
  p.account_id, p.stream_id, p.ticker, p.instrument, p.option_type, p.strategy,
  p.strike, p.expiration, p.chain_id,
  a.name as account_name,
  s.name as stream_name
from transactions tx
join positions p on p.id = tx.position_id
join accounts  a on a.id = p.account_id
join streams   s on s.id = p.stream_id;

-- ---------------------------------------------------------------------------
-- security: RLS on, no policies. Only the server (secret key) can read/write.
-- Add auth + policies before exposing the app beyond localhost.
-- ---------------------------------------------------------------------------

alter table accounts     enable row level security;
alter table streams      enable row level security;
alter table stream_rules enable row level security;
alter table positions    enable row level security;
alter table transactions enable row level security;
alter table snapshots    enable row level security;

-- ---------------------------------------------------------------------------
-- seed
-- ---------------------------------------------------------------------------

insert into accounts (name) values ('Individual'), ('Joint');

insert into streams (name, slug, description, color, sort_order) values
  ('Individual Wheel', 'individual', 'Wheel in the individual account', '#2a78d6', 1),
  ('Joint Wheel',      'joint',      'Wheel in the joint account (excluding TSLA)', '#1f9e75', 2),
  ('Tesla CC',         'tesla',      'TSLA covered calls + shares in the joint account', '#d8532b', 3);

insert into stream_rules (stream_id, account_id, ticker, kind, priority)
select s.id, a.id, r.ticker, r.kind, r.priority
from (values
  ('individual', 'Individual', null,   null,    100),
  ('joint',      'Joint',      null,   null,    100),
  ('tesla',      'Joint',      'TSLA', 'call',  10),
  ('tesla',      'Joint',      'TSLA', 'stock', 10)
) as r(slug, account, ticker, kind, priority)
join streams  s on s.slug = r.slug
join accounts a on a.name = r.account;
