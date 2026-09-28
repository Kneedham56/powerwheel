-- A single roll order can close several lots of the same contract. Only one of them
-- becomes the new leg's rolled_from_id, so fold the other lots' chains into the new
-- leg's chain: the whole roll then reports as one trade.

create or replace function merge_roll_chain(p_roll_group uuid)
returns int
language plpgsql
as $$
declare
  target uuid;
  moved  int;
begin
  select p.chain_id into target
  from transactions t
  join positions p on p.id = t.position_id
  where t.roll_group_id = p_roll_group and t.action = 'sell_to_open'
  order by t.created_at
  limit 1;

  if target is null then
    return 0;
  end if;

  update positions
  set chain_id = target
  where chain_id in (
    select p.chain_id
    from transactions t
    join positions p on p.id = t.position_id
    where t.roll_group_id = p_roll_group and t.action in ('buy_to_close', 'sell_to_close')
  )
  and chain_id <> target;

  get diagnostics moved = row_count;
  return moved;
end $$;

-- repair existing data, oldest rolls first so merges cascade forward
do $$
declare
  g uuid;
begin
  for g in
    select roll_group_id from transactions
    where roll_group_id is not null
    group by roll_group_id
    order by min(occurred_at)
  loop
    perform merge_roll_chain(g);
  end loop;
end $$;
