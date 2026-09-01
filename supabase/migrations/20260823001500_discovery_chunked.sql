-- ===========================================================================
-- Chunked discovery, and tier assignment in SQL.
--
-- WHY. The first discovery build paged the whole book into an array and then
-- classified it. Measured against the live API that is 235 MB of JSON and
-- ~110,000 market objects held at once, against a 256 MB function limit, so it
-- died with WORKER_RESOURCE_LIMIT before writing a single row. Wall clock was
-- never the problem (~10s); retention was.
--
-- Two consequences, both structural rather than a tuning fix:
--
--   * Discovery now processes one page at a time and persists a cursor, so a
--     sweep spans several invocations and peak memory is one page.
--   * Ranking and caps move here. Choosing the top N of 110,000 markets is a
--     sort, which is what a database is for; doing it in a worker meant
--     holding every candidate in memory purely to order them.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Discovery-time book quality.
--
-- Tier assignment needs volume and spread, but those live in snapshots, which
-- only exist for markets already being priced -- a market cannot earn its way
-- into the universe using data it can only have once it is in the universe.
-- So discovery records what it saw at the moment it looked.
-- --------------------------------------------------------------------------
alter table public.markets
  add column disc_volume    bigint  not null default 0,
  add column disc_spread    smallint,
  add column disc_two_sided boolean not null default false,
  add column disc_seen_at   timestamptz;

-- A market should not be priced until something has deliberately tiered it.
-- The old default put every newly discovered market straight into the hourly
-- slow tier, which is how the universe drifted in the first place.
alter table public.markets alter column cadence_tier set default 'excluded';

-- --------------------------------------------------------------------------
-- Sweep cursor
--
-- Single row. The Kalshi cursor is opaque and position-dependent, so a sweep
-- that stops halfway has to resume from exactly where it left off rather than
-- restart -- restarting would re-page the head of the book forever and never
-- reach the tail.
-- --------------------------------------------------------------------------
create table public.discovery_state (
  id                 boolean primary key default true check (id),
  cursor             text,
  pages_done         integer not null default 0,
  markets_seen       integer not null default 0,
  sweep_started_at   timestamptz,
  last_completed_at  timestamptz,
  last_sweep_pages   integer,
  last_sweep_markets integer
);

insert into public.discovery_state (id) values (true) on conflict do nothing;

alter table public.discovery_state enable row level security;
revoke all on public.discovery_state from anon, authenticated;

-- --------------------------------------------------------------------------
-- Tier assignment
--
-- Runs once per completed sweep, over everything discovery has recorded.
--
-- Caps DEMOTE rather than exclude: a market that misses the fast cap falls to
-- slow, and one that misses slow falls to archive. Excluding on overflow would
-- silently blind the platform to the tail, which is the failure this whole
-- change exists to fix.
-- --------------------------------------------------------------------------
create or replace function public.assign_cadence_tiers()
returns jsonb
language plpgsql
security definer
set search_path = public
-- Measured at 10.2s over a 120,000-market book on first assignment and 3.4s
-- in steady state. That is comfortably inside this ceiling but NOT inside the
-- default PostgREST statement timeout, and a timeout here would be quiet in
-- the worst way: the sweep would report success while every market kept the
-- tier it already had.
set statement_timeout = '120s'
as $fn$
declare
  sel        jsonb;
  v_fast_h   numeric;
  v_slow_h   numeric;
  v_spread   integer;
  v_two      boolean;
  v_fast_cap integer;
  v_slow_cap integer;
  v_arch_cap integer;
  v_boost    numeric;
  v_now      timestamptz := now();
  v_result   jsonb;
begin
  select thresholds->'selection' into sel
    from public.model_versions
   where id = public.current_stable_version();

  if sel is null then
    raise exception 'assign_cadence_tiers: stable model version has no selection tunables';
  end if;

  v_fast_h   := (sel->>'fastHorizonDays')::numeric;
  v_slow_h   := (sel->>'slowHorizonDays')::numeric;
  v_spread   := (sel->>'maxSpreadCents')::integer;
  v_two      := coalesce((sel->>'requireTwoSidedBook')::boolean, true);
  v_fast_cap := (sel->>'fastCap')::integer;
  v_slow_cap := (sel->>'slowCap')::integer;
  v_arch_cap := (sel->>'archiveCap')::integer;
  v_boost    := coalesce((sel->>'anchorRankBoost')::numeric, 0);

  create temp table _tier on commit drop as
  with base as (
    select
      m.id,
      m.family,
      m.anchorable,
      extract(epoch from (m.close_time - v_now)) / 86400.0 as horizon,
      coalesce(m.disc_spread, 100)      as spread,
      coalesce(m.disc_two_sided, false) as two_sided,
      -- Liquidity on a log scale: the gap between 100 and 1,000 contracts
      -- matters, the gap between 100,000 and 101,000 does not.
      log(10, greatest(coalesce(m.disc_volume, 0), 1)::numeric)
        + case when m.anchorable then v_boost else 0 end as rank_score
    from public.markets m
    where m.resolved_at is null
  ),
  classified as (
    select b.*,
      case
        when b.family = 'mve_shard'                  then 'excluded'
        when b.horizon is null                       then 'archive'
        when b.horizon < 0                           then 'excluded'
        when b.horizon <= v_fast_h
         and (not v_two or b.two_sided)
         and b.spread <= v_spread                    then 'fast'
        when b.horizon <= v_slow_h                   then 'slow'
        else                                              'archive'
      end as want
    from base b
  ),
  fast_pick as (
    select c.id from classified c
     where c.want = 'fast'
     order by c.rank_score desc
     limit v_fast_cap
  ),
  slow_pool as (
    select c.* from classified c
     where c.want = 'slow'
        or (c.want = 'fast' and c.id not in (select f.id from fast_pick f))
  ),
  slow_pick as (
    select s.id from slow_pool s order by s.rank_score desc limit v_slow_cap
  ),
  arch_pool as (
    select c.* from classified c
     where c.want = 'archive'
        or (c.id in (select s.id from slow_pool s)
            and c.id not in (select s.id from slow_pick s))
  ),
  arch_pick as (
    select a.id from arch_pool a order by a.rank_score desc limit v_arch_cap
  ),
  final as (
    select
      c.id,
      c.family,
      round(c.rank_score::numeric, 3) as rank_score,
      c.want,
      (case
         when c.id in (select f.id from fast_pick f) then 'fast'
         when c.id in (select s.id from slow_pick s) then 'slow'
         when c.id in (select a.id from arch_pick a) then 'archive'
         else 'excluded'
       end)::public.cadence_tier as tier
    from classified c
  )
  -- Reason records both what the market qualified for and whether a cap moved
  -- it, so universe_membership explains itself without re-deriving the rules.
  select
    f.id,
    f.family,
    f.rank_score,
    f.want,
    f.tier,
    case
      when f.tier::text = f.want then 'qualified: ' || f.want
      else 'demoted from ' || f.want || ' (cap)'
    end as reason
  from final f;

  -- Close membership rows whose tier no longer holds. Rows are never deleted;
  -- a backtest has to be able to see what was visible at the time.
  update public.universe_membership um
     set left_at = v_now
    from _tier t
   where um.market_id = t.id
     and um.left_at is null
     and um.tier is distinct from t.tier;

  insert into public.universe_membership (market_id, tier, family, reason, rank_score)
  select t.id, t.tier, t.family, t.reason, t.rank_score
    from _tier t
   where not exists (
     select 1 from public.universe_membership um
      where um.market_id = t.id and um.left_at is null
   );

  update public.markets m
     set cadence_tier = t.tier,
         tier_reason  = t.reason
    from _tier t
   where m.id = t.id
     and (m.cadence_tier is distinct from t.tier
       or m.tier_reason is distinct from t.reason);

  select jsonb_build_object(
    'fast',     count(*) filter (where tier = 'fast'),
    'slow',     count(*) filter (where tier = 'slow'),
    'archive',  count(*) filter (where tier = 'archive'),
    'excluded', count(*) filter (where tier = 'excluded'),
    'demoted',  count(*) filter (where tier::text is distinct from want),
    'total',    count(*)
  ) into v_result from _tier;

  return v_result;
end;
$fn$;

revoke all on function public.assign_cadence_tiers() from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- Discovery now runs in chunks, so it needs to run more often than hourly.
-- Roughly eight invocations complete a full sweep; every five minutes gives a
-- sweep about every 40 minutes.
-- --------------------------------------------------------------------------
select cron.schedule(
  'oe-discover-markets', '2-57/5 * * * *',
  $cron$ select public.invoke_edge_function('discover-markets'); $cron$
);
