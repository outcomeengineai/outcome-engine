-- ===========================================================================
-- Server-side helpers: settings access, model-version resolution, billing
-- math, snapshot retention, and the views the clients actually read.
--
-- The fee formula lives in TWO places by necessity — here (so the monthly job
-- is one transaction) and in packages/shared/src/money.ts (so the stake card
-- can quote it). The shared-package tests and close_billing_period() below use
-- the same rule: 20% of max(0, net). If one changes, change both.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- platform_settings accessors
-- --------------------------------------------------------------------------
create or replace function public.setting(p_key text, p_default jsonb default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.platform_settings where key = p_key), p_default);
$$;

create or replace function public.setting_numeric(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::numeric from public.platform_settings where key = p_key), p_default);
$$;

create or replace function public.setting_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::boolean from public.platform_settings where key = p_key), p_default);
$$;

create or replace function public.fee_rate()
returns numeric
language sql
stable
as $$
  select public.setting_numeric('fee_rate', 0.20);
$$;

grant execute on function public.setting(text, jsonb) to authenticated;
grant execute on function public.setting_numeric(text, numeric) to authenticated;
grant execute on function public.setting_bool(text, boolean) to authenticated;
grant execute on function public.fee_rate() to authenticated;

-- --------------------------------------------------------------------------
-- Model version resolution
-- --------------------------------------------------------------------------

-- The version the scoring engine writes against: the most recently published
-- stable version.
create or replace function public.current_stable_version()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.model_versions
   where status = 'stable'
   order by published_at desc nulls last
   limit 1;
$$;

-- The version a given member's view is scored by. Honours a pinned preference
-- while that version's transition window is still open, then falls back to
-- current stable. This is why the transition window needs no separate job to
-- unpin people: an expired window simply stops being honoured.
create or replace function public.effective_version_for(p_user uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select mv.id
       from public.users u
       join public.model_versions mv on mv.id = u.preferred_model_version_id
      where u.id = p_user
        and mv.status in ('stable', 'deprecated')
        and mv.transition_ends_at is not null
        and mv.transition_ends_at > now()),
    public.current_stable_version()
  );
$$;

grant execute on function public.current_stable_version() to authenticated;
grant execute on function public.effective_version_for(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- Publishing a model version.
--
-- Publishing does not delete the old stable — it opens a transition window on
-- it. Members pinned to it keep their scores until the window closes, after
-- which effective_version_for() stops honouring the pin and deprecate_expired_
-- versions() marks it deprecated.
-- --------------------------------------------------------------------------
create or replace function public.publish_model_version(p_version uuid)
returns public.model_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_days integer;
  v_row public.model_versions;
begin
  if not public.is_admin() then
    raise exception 'only an admin may publish a model version';
  end if;

  v_window_days := public.setting_numeric('transition_window_days', 14)::integer;

  update public.model_versions
     set status = 'stable',
         transition_ends_at = now() + make_interval(days => v_window_days)
   where status = 'stable'
     and id <> p_version;

  update public.model_versions
     set status = 'stable',
         published_at = coalesce(published_at, now()),
         transition_ends_at = null
   where id = p_version
  returning * into v_row;

  if v_row.id is null then
    raise exception 'model version % not found', p_version;
  end if;

  insert into public.activity_log (user_id, event_type, detail, metadata)
  values (auth.uid(), 'model.published',
          format('Published %s', v_row.version_label),
          jsonb_build_object('model_version_id', v_row.id, 'label', v_row.version_label));

  return v_row;
end;
$$;

grant execute on function public.publish_model_version(uuid) to authenticated;

create or replace function public.deprecate_expired_versions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.model_versions
     set status = 'deprecated', deprecated_at = now()
   where status = 'stable'
     and transition_ends_at is not null
     and transition_ends_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- --------------------------------------------------------------------------
-- Billing
-- --------------------------------------------------------------------------

-- Open the current period for a user if one is not already open.
create or replace function public.ensure_open_billing_period(p_user uuid, p_at timestamptz default now())
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz := date_trunc('month', p_at);
  v_end   timestamptz := date_trunc('month', p_at) + interval '1 month';
  v_row   public.billing_periods;
begin
  select * into v_row
    from public.billing_periods
   where user_id = p_user and period_start = v_start;

  if v_row.id is null then
    insert into public.billing_periods (user_id, period_start, period_end, fee_rate, status)
    values (p_user, v_start, v_end, public.fee_rate(), 'open')
    on conflict (user_id, period_start) do nothing
    returning * into v_row;

    if v_row.id is null then
      select * into v_row from public.billing_periods
       where user_id = p_user and period_start = v_start;
    end if;
  end if;

  return v_row;
end;
$$;

-- Recompute a period's totals from its LIVE resolved trades.
--
-- Paper trades are excluded by the `mode = 'live'` filter, which is the single
-- point where that invariant is enforced for billing. Trades are attributed to
-- a period by RESOLUTION time, not open time: you are billed on profit when it
-- is realized.
create or replace function public.recompute_billing_period(p_period uuid)
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.billing_periods;
  v_wins   bigint := 0;
  v_losses bigint := 0;
  v_net    bigint := 0;
begin
  select * into v_row from public.billing_periods where id = p_period for update;
  if v_row.id is null then
    raise exception 'billing period % not found', p_period;
  end if;

  select
    coalesce(sum(case when r.pnl >= 0 then r.pnl else 0 end), 0),
    coalesce(sum(case when r.pnl <  0 then -r.pnl else 0 end), 0)
  into v_wins, v_losses
  from public.trade_resolutions r
  join public.trades t on t.id = r.trade_id
  where t.user_id = v_row.user_id
    and t.mode = 'live'
    and r.resolved_at >= v_row.period_start
    and r.resolved_at <  v_row.period_end;

  v_net := v_wins - v_losses;

  update public.billing_periods
     set gross_wins = v_wins,
         gross_losses = v_losses,
         net_pnl = v_net,
         -- THE fee rule. Losses offset wins; a losing period owes nothing.
         fee_owed = round(greatest(0, v_net) * v_row.fee_rate)
   where id = p_period
  returning * into v_row;

  return v_row;
end;
$$;

-- Close a period: freeze totals and hand it to the invoicing step.
create or replace function public.close_billing_period(p_period uuid)
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.billing_periods;
begin
  v_row := public.recompute_billing_period(p_period);

  if v_row.status <> 'open' then
    return v_row;
  end if;

  update public.billing_periods
     set closed_at = now(),
         -- Nothing owed means nothing to invoice; settle it immediately so it
         -- does not sit in the admin's "pending" queue forever.
         status = case when v_row.fee_owed = 0 then 'paid' else 'invoiced' end
   where id = p_period
  returning * into v_row;

  insert into public.activity_log (user_id, event_type, detail, metadata)
  values (v_row.user_id, 'billing.period_closed',
          format('Period closed: net %s, fee %s',
                 (v_row.net_pnl / 100.0)::numeric(12,2),
                 (v_row.fee_owed / 100.0)::numeric(12,2)),
          jsonb_build_object('billing_period_id', v_row.id,
                             'net_pnl', v_row.net_pnl,
                             'fee_owed', v_row.fee_owed));

  return v_row;
end;
$$;

-- Admin override for a payment that arrived outside Stripe (rare P2P balance).
create or replace function public.mark_period_paid(p_period uuid, p_note text default null)
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.billing_periods;
begin
  if not public.is_admin() then
    raise exception 'only an admin may mark a period paid';
  end if;

  update public.billing_periods
     set status = 'paid', grace_until = null
   where id = p_period
  returning * into v_row;

  if v_row.id is null then
    raise exception 'billing period % not found', p_period;
  end if;

  insert into public.payments (billing_period_id, amount, method, status, note, paid_at, marked_by)
  values (p_period, v_row.fee_owed, 'manual', 'succeeded', p_note, now(), auth.uid());

  -- Paying clears the reason the account was restricted.
  update public.users
     set account_status = 'active'
   where id = v_row.user_id
     and account_status in ('grace', 'paused');

  insert into public.activity_log (user_id, event_type, detail, metadata)
  values (v_row.user_id, 'billing.marked_paid',
          coalesce(p_note, 'Marked paid by admin'),
          jsonb_build_object('billing_period_id', p_period, 'admin_id', auth.uid()));

  return v_row;
end;
$$;

create or replace function public.waive_period(p_period uuid, p_note text default null)
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.billing_periods;
begin
  if not public.is_admin() then
    raise exception 'only an admin may waive a period';
  end if;

  update public.billing_periods
     set status = 'waived', grace_until = null
   where id = p_period
  returning * into v_row;

  update public.users
     set account_status = 'active'
   where id = v_row.user_id
     and account_status in ('grace', 'paused');

  insert into public.activity_log (user_id, event_type, detail, metadata)
  values (v_row.user_id, 'billing.waived', coalesce(p_note, 'Waived by admin'),
          jsonb_build_object('billing_period_id', p_period, 'admin_id', auth.uid()));

  return v_row;
end;
$$;

grant execute on function public.mark_period_paid(uuid, text) to authenticated;
grant execute on function public.waive_period(uuid, text) to authenticated;
grant execute on function public.publish_model_version(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- Inactivity flagging. Flags only — removal is always a manual admin action,
-- so this never touches 'removed'.
-- --------------------------------------------------------------------------
create or replace function public.flag_inactive_accounts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer := public.setting_numeric('inactivity_threshold_days', 30)::integer;
  n integer;
begin
  update public.users u
     set account_status = 'inactive'
   where u.role = 'member'
     and u.account_status = 'active'
     and coalesce(u.last_trade_at, u.created_at) < now() - make_interval(days => v_days);
  get diagnostics n = row_count;

  -- Someone who traded again is no longer inactive.
  update public.users u
     set account_status = 'active'
   where u.account_status = 'inactive'
     and coalesce(u.last_trade_at, u.created_at) >= now() - make_interval(days => v_days);

  return n;
end;
$$;

-- --------------------------------------------------------------------------
-- Snapshot retention: roll raw rows into daily aggregates, then prune.
-- --------------------------------------------------------------------------
create or replace function public.rollup_and_prune_snapshots()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer := public.setting_numeric('snapshot_retention_days', 30)::integer;
  v_cutoff timestamptz := now() - make_interval(days => v_days);
  n integer;
begin
  insert into public.market_snapshots_daily as d
    (market_id, day, open_price, close_price, high_price, low_price,
     avg_spread, volume, open_interest, sample_count)
  select
    s.market_id,
    (s.ts at time zone 'UTC')::date as day,
    (array_agg(s.price order by s.ts asc))[1],
    (array_agg(s.price order by s.ts desc))[1],
    max(s.price),
    min(s.price),
    avg(s.spread)::numeric(6,2),
    max(s.volume),
    max(s.open_interest),
    count(*)::integer
  from public.market_snapshots s
  where s.ts < v_cutoff
  group by s.market_id, (s.ts at time zone 'UTC')::date
  on conflict (market_id, day) do update
    set open_price = excluded.open_price,
        close_price = excluded.close_price,
        high_price = excluded.high_price,
        low_price = excluded.low_price,
        avg_spread = excluded.avg_spread,
        volume = excluded.volume,
        open_interest = excluded.open_interest,
        sample_count = excluded.sample_count;

  delete from public.market_snapshots where ts < v_cutoff;
  get diagnostics n = row_count;

  -- Scores are written every scoring pass, so they grow far faster than
  -- snapshots: a few hundred markets every five minutes is millions of rows a
  -- month, and latest_scores (a DISTINCT ON) degrades with every one of them.
  --
  -- Keep everything recent, and keep the newest row per (market, version)
  -- forever regardless of age — that row is what a historical trade's card
  -- still renders from, and deleting it would blank out old positions.
  delete from public.scores s
   where s.ts < v_cutoff
     and s.id not in (
       select distinct on (market_id, model_version_id) id
         from public.scores
        order by market_id, model_version_id, ts desc
     );

  return n;
end;
$$;

-- --------------------------------------------------------------------------
-- Views the clients read
-- --------------------------------------------------------------------------

-- The newest score per (market, model version). security_invoker keeps the
-- caller's RLS in force rather than the view owner's.
create or replace view public.latest_scores
with (security_invoker = true) as
select distinct on (s.model_version_id, s.market_id)
  s.id, s.market_id, s.model_version_id, s.ts, s.side, s.score, s.breakdown
from public.scores s
order by s.model_version_id, s.market_id, s.ts desc;

-- The newest snapshot per market.
create or replace view public.latest_snapshots
with (security_invoker = true) as
select distinct on (s.market_id)
  s.market_id, s.ts, s.price, s.volume, s.spread, s.open_interest, s.liquidity
from public.market_snapshots s
order by s.market_id, s.ts desc;

-- Everything the Decision Desk needs for one card, already joined.
create or replace view public.decision_desk
with (security_invoker = true) as
select
  m.id            as market_id,
  m.question,
  m.category,
  m.close_time,
  ls.model_version_id,
  ls.side,
  ls.score,
  ls.breakdown,
  ls.ts           as scored_at,
  snap.price      as yes_price,
  snap.volume,
  snap.spread,
  snap.liquidity,
  -- Price of the side the model picked, which is what the stake card quotes.
  case when ls.side = 'YES' then snap.price else 100 - snap.price end as side_price
from public.markets m
join public.latest_scores ls on ls.market_id = m.id
left join public.latest_snapshots snap on snap.market_id = m.id
where m.resolved_at is null
  and (m.close_time is null or m.close_time > now());

-- Open positions with live mark-to-market. Unrealized PnL uses the current
-- price of the side HELD, matching unrealizedPnlCents() in the shared package.
create or replace view public.open_positions
with (security_invoker = true) as
select
  t.id            as trade_id,
  t.user_id,
  t.market_id,
  m.question,
  m.category,
  t.mode,
  t.side,
  t.entry_price,
  t.contracts,
  t.stake_cents,
  t.entry_score,
  t.model_version_id,
  mv.version_label as entry_model_label,
  t.opened_at,
  case when t.side = 'YES' then snap.price else 100 - snap.price end as current_price,
  (
    (case when t.side = 'YES' then snap.price else 100 - snap.price end)::bigint
    - t.entry_price::bigint
  ) * t.contracts as unrealized_pnl
from public.trades t
join public.markets m on m.id = t.market_id
join public.model_versions mv on mv.id = t.model_version_id
left join public.latest_snapshots snap on snap.market_id = t.market_id
where t.status = 'open';

-- Resolved trades with their realized PnL.
create or replace view public.resolved_positions
with (security_invoker = true) as
select
  t.id as trade_id,
  t.user_id,
  t.market_id,
  m.question,
  m.category,
  t.mode,
  t.side,
  t.entry_price,
  t.contracts,
  t.stake_cents,
  t.entry_score,
  mv.version_label as entry_model_label,
  t.opened_at,
  r.outcome,
  r.pnl,
  r.resolved_at,
  extract(epoch from (r.resolved_at - t.opened_at)) as hold_seconds
from public.trades t
join public.trade_resolutions r on r.trade_id = t.id
join public.markets m on m.id = t.market_id
join public.model_versions mv on mv.id = t.model_version_id;

grant select on public.latest_scores, public.latest_snapshots, public.decision_desk,
                public.open_positions, public.resolved_positions to authenticated;
