-- Where the stock closed on expiration day, recorded for options that were assigned
-- (a CSP put to us, or a CC called away). Win/loss reporting compares it with the strike:
-- a trade only counts as a loss when the move past the strike is bigger than the premium kept.
-- Filled by `npm run sync -- closes <file>` (see docs/SYNC.md); null until then.

alter table positions add column underlying_close numeric(12, 4);

-- v_positions selects p.*, so it has to be rebuilt to pick up the new column
drop view v_positions;

create view v_positions
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
