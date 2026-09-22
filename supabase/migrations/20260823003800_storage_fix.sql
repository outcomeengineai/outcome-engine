-- ===========================================================================
-- Storage: why the database tripled, and the fixes.
--
-- Read on 2026-09-22: 1,329 MB. The prune job (oe-prune-snapshots) had
-- failed on every run since about 2026-09-16, so nothing had been deleted
-- for a week. Snapshots held 11 days instead of 5, scores 21 days instead
-- of 3. Four causes, four fixes:
--
--  1. edge_theses.score_id references scores ON DELETE SET NULL and had no
--     index. Deleting a score therefore sequentially scanned edge_theses
--     (137k rows) once PER DELETED SCORE. Hundreds of thousands of scores
--     due -> statement timeout -> the whole prune transaction rolled back,
--     every time. The index below makes that lookup an index probe.
--
--  2. universe_membership carried a row for every EXCLUDED market: 843k
--     open rows, 288 MB, for markets we never price. Membership is the
--     point-in-time record of the PRICED tiers; exclusion is the absence of
--     membership. assign_cadence_tiers no longer opens excluded rows (it
--     still closes a priced row when a market leaves), and compaction
--     drops every excluded row, bounded per run. Readers already ignore
--     excluded rows (calibration_rows filters u.tier <> 'excluded').
--
--  3. A SET statement_timeout on a function does nothing for the statement
--     that is already running: Postgres arms the timer when the statement
--     starts, from the session's value. The cron command now sets it before
--     the call. And each step is bounded per run anyway, so a normal run
--     fits in the default budget with or without that.
--
--  4. The markets table held the entire Kalshi past: 848k rows, 840k of
--     them excluded, 358 MB. A market that is excluded, closed or unseen
--     for a week, and was never priced or scored carries no information
--     the platform uses (base rates come from resolved positions, not from
--     markets). prune_dead_markets drops those, 50k per run, and leaves
--     anything with a snapshot, thesis, or trade alone. Discovery simply
--     re-inserts a market if Kalshi ever lists it again.
-- ===========================================================================

-- 1. The missing index.
create index if not exists edge_theses_score_idx on public.edge_theses (score_id);

-- 2a. Tier assignment: identical to 2300 except membership rows are opened
--     only for priced tiers.
create or replace function public.assign_cadence_tiers()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $fn$
declare
  sel        jsonb;
  v_fast_h   numeric;
  v_slow_h   numeric;
  v_min_h    numeric;
  v_fresh_h  numeric;
  v_spread   integer;
  v_two      boolean;
  v_fast_cap integer;
  v_slow_cap integer;
  v_arch_cap integer;
  v_boost    numeric;
  v_incumb   numeric;
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
  v_min_h    := coalesce((sel->>'fastMinHorizonHours')::numeric, 3);
  v_fresh_h  := coalesce((sel->>'discoveryFreshnessHours')::numeric, 2);
  v_spread   := (sel->>'maxSpreadCents')::integer;
  v_two      := coalesce((sel->>'requireTwoSidedBook')::boolean, true);
  v_fast_cap := (sel->>'fastCap')::integer;
  v_slow_cap := (sel->>'slowCap')::integer;
  v_arch_cap := (sel->>'archiveCap')::integer;
  v_boost    := coalesce((sel->>'anchorRankBoost')::numeric, 0);
  v_incumb   := coalesce((sel->>'incumbentRankBoost')::numeric, 0);

  create temp table _tier on commit drop as
  with base as (
    select
      m.id,
      m.family,
      m.anchorable,
      m.cadence_tier as current_tier,
      coalesce(m.status, '') in ('finalized', 'settled', 'closed')       as ended,
      m.disc_seen_at is null
        or m.disc_seen_at < v_now - make_interval(hours => v_fresh_h::int) as stale,
      -- The EARLIER of expected and actual close. See header.
      extract(epoch from (least(coalesce(m.expected_close, m.close_time), m.close_time) - v_now))
        / 86400.0 as horizon,
      coalesce(m.disc_spread, 100)      as spread,
      coalesce(m.disc_two_sided, false) as two_sided,
      log(10, greatest(coalesce(m.disc_volume, 0), 1)::numeric)
        + case when m.anchorable then v_boost else 0 end
        + case when m.cadence_tier = 'fast' then v_incumb else 0 end as rank_score
    from public.markets m
    where m.resolved_at is null
  ),
  classified as (
    select b.*,
      case
        when b.ended                                      then 'excluded'
        when b.stale                                      then 'excluded'
        when b.family = 'mve_shard'                       then 'excluded'
        when b.horizon is null                            then 'archive'
        when b.horizon < 0                                then 'excluded'
        when b.horizon <= v_fast_h
         and (not v_two or b.two_sided)
         and b.spread <= v_spread
         and (b.horizon * 24 >= v_min_h or b.current_tier = 'fast') then 'fast'
        when b.horizon * 24 < v_min_h                     then 'excluded'
        when b.horizon <= v_slow_h                        then 'slow'
        else                                                   'archive'
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
      c.id, c.family, c.ended, c.stale, c.horizon,
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
  select
    f.id, f.family, f.rank_score, f.want, f.tier,
    case
      when f.tier::text = f.want and f.want = 'excluded' and f.ended               then 'finalized'
      when f.tier::text = f.want and f.want = 'excluded' and f.stale               then 'not in open feed'
      when f.tier::text = f.want and f.want = 'excluded' and f.horizon < 0         then 'expired'
      when f.tier::text = f.want and f.want = 'excluded' and f.horizon * 24 < v_min_h then 'too short to track'
      when f.tier::text = f.want then 'qualified: ' || f.want
      else 'demoted from ' || f.want || ' (cap)'
    end as reason
  from final f;

  update public.universe_membership um
     set left_at = v_now
    from _tier t
   where um.market_id = t.id
     and um.left_at is null
     and um.tier is distinct from t.tier;

  insert into public.universe_membership (market_id, tier, family, reason, rank_score)
  select t.id, t.tier, t.family, t.reason, t.rank_score
    from _tier t
   where t.tier <> 'excluded'
     and not exists (
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
    'fast',      count(*) filter (where tier = 'fast'),
    'slow',      count(*) filter (where tier = 'slow'),
    'archive',   count(*) filter (where tier = 'archive'),
    'excluded',  count(*) filter (where tier = 'excluded'),
    'finalized', count(*) filter (where reason = 'finalized'),
    'stale',     count(*) filter (where reason = 'not in open feed'),
    'tooShort',  count(*) filter (where reason = 'too short to track'),
    'demoted',   count(*) filter (where tier::text is distinct from want),
    'total',     count(*)
  ) into v_result from _tier;

  return v_result;
end;
$fn$;

-- 2b. Compaction: every excluded row goes, bounded per run.
create or replace function public.compact_universe_membership()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare n integer;
begin
  delete from public.universe_membership
   where id in (
     select id from public.universe_membership
      where tier = 'excluded'
      limit 200000
   );
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- 3. Rollup and prune, bounded: at most one day of snapshot backlog per
--    call (the normal case is exactly one day), at most 100k scores.
create or replace function public.rollup_and_prune_snapshots()
returns integer
language plpgsql
security definer
set search_path = public, cron
as $fn$
declare
  v_days      integer := public.setting_numeric('snapshot_retention_days', 5)::integer;
  v_score_d   integer := public.setting_numeric('score_retention_days', 3)::integer;
  v_act_d     integer := public.setting_numeric('activity_retention_days', 14)::integer;
  v_cron_d    integer := public.setting_numeric('cron_log_retention_days', 2)::integer;
  v_retain    timestamptz := now() - make_interval(days => v_days);
  v_oldest    timestamptz;
  v_cutoff    timestamptz;
  n           integer := 0;
  n_scores    integer := 0;
  n_act       integer := 0;
  n_cron      integer := 0;
begin
  select min(ts) into v_oldest from public.market_snapshots;
  -- One day of backlog per call: a week of missed runs is cleared over a
  -- few calls instead of one statement that cannot finish.
  v_cutoff := least(v_retain, coalesce(v_oldest, v_retain) + interval '1 day');

  insert into public.market_snapshots_daily as d
    (market_id, day, open_price, close_price, high_price, low_price,
     avg_spread, volume, open_interest, sample_count)
  select
    s.market_id,
    (s.ts at time zone 'UTC')::date as day,
    (array_agg(s.price order by s.ts asc))[1],
    (array_agg(s.price order by s.ts desc))[1],
    max(s.price), min(s.price),
    round(avg(s.spread)::numeric, 2),
    max(s.volume), max(s.open_interest),
    count(*)
  from public.market_snapshots s
  where s.ts < v_cutoff
  group by s.market_id, (s.ts at time zone 'UTC')::date
  on conflict (market_id, day) do update
    set close_price   = excluded.close_price,
        high_price    = greatest(d.high_price, excluded.high_price),
        low_price     = least(d.low_price, excluded.low_price),
        avg_spread    = excluded.avg_spread,
        volume        = greatest(d.volume, excluded.volume),
        open_interest = excluded.open_interest,
        sample_count  = d.sample_count + excluded.sample_count;

  delete from public.market_snapshots where ts < v_cutoff;
  get diagnostics n = row_count;

  delete from public.scores s
   where s.id in (
     select s2.id from public.scores s2
      where s2.ts < now() - make_interval(days => v_score_d)
        and not exists (select 1 from public.market_latest_scores l where l.score_id = s2.id)
      limit 100000
   );
  get diagnostics n_scores = row_count;

  delete from public.activity_log where ts < now() - make_interval(days => v_act_d);
  get diagnostics n_act = row_count;

  delete from cron.job_run_details where end_time < now() - make_interval(days => v_cron_d);
  get diagnostics n_cron = row_count;

  insert into public.activity_log (event_type, detail, metadata)
  values ('maintenance.pruned',
          format('%s snapshots (to %s), %s scores, %s activity rows, %s cron rows',
                 n, to_char(v_cutoff, 'YYYY-MM-DD HH24:MI'), n_scores, n_act, n_cron),
          jsonb_build_object('snapshots', n, 'cutoff', v_cutoff, 'scores', n_scores,
                             'activity', n_act, 'cron', n_cron));

  return n;
end;
$fn$;

-- 4. Dead markets.
create or replace function public.prune_dead_markets(p_limit integer default 50000)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare n integer;
begin
  delete from public.markets m
   where m.id in (
     select m2.id
       from public.markets m2
      where m2.cadence_tier = 'excluded'
        and (m2.status in ('finalized', 'settled', 'closed')
             or coalesce(m2.disc_seen_at, m2.first_seen_at) < now() - interval '7 days')
        and not exists (select 1 from public.market_snapshots       s where s.market_id = m2.id)
        and not exists (select 1 from public.market_snapshots_daily d where d.market_id = m2.id)
        and not exists (select 1 from public.edge_theses            t where t.market_id = m2.id)
        and not exists (select 1 from public.scores                 c where c.market_id = m2.id)
        and not exists (select 1 from public.trades                 r where r.market_id = m2.id)
      limit p_limit
   );
  get diagnostics n = row_count;
  return n;
end;
$fn$;

create or replace function public.prune_all()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare a integer; b integer; c integer;
begin
  a := public.rollup_and_prune_snapshots();
  b := public.compact_universe_membership();
  c := public.prune_dead_markets();
  return jsonb_build_object('snapshots', a, 'membership', b, 'markets', c);
end;
$fn$;

-- The cron command sets the budget itself; the function-level setting it
-- replaces could not.
select cron.schedule(
  'oe-prune-snapshots', '30 */6 * * *',
  $cron$ set statement_timeout = '900s'; select public.prune_all(); $cron$
);
