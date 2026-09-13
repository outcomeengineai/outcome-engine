-- ===========================================================================
-- Tier eligibility: status, actual close, and freshness.
--
-- WHY. After migration 2200 the tier still emptied: assignment picked 800,
-- and 1,440 of them were marked settled after an average of THREE MINUTES in
-- the tier, with 21 hours of runway by expected_close. They were finalized
-- before promotion. Tested against the live API:
--
--   * Kalshi does not update expected_expiration_time on an early
--     finalization. It updates close_time (to the moment of finalization)
--     and status. A retirement market finalized on 2026-09-09 still reports
--     an expected expiry in 2031.
--   * The events feed carries status on nested markets, and open EVENTS
--     contain finalized MARKETS. Discovery writes that status; assignment
--     never read it.
--   * 246,122 unresolved rows in the table against ~120,000 in the open
--     feed: markets that left the feed (finalized) still carry the future
--     dates of their last sighting, and were eligible on paper.
--
-- Three rules, all cheap, all from data already stored:
--   1. status in (finalized, settled, closed) is not eligible for anything.
--   2. horizon runs to the EARLIER of expected_close and close_time. For a
--      live market close_time is the later contractual deadline, so expected
--      wins; for an early finalization close_time has been rewritten to the
--      past, so it wins.
--   3. a market discovery has not seen within discoveryFreshnessHours is not
--      in the open feed, whatever its dates say. Not eligible.
-- ===========================================================================

update public.model_versions
   set thresholds = jsonb_set(
     thresholds, '{selection}',
     (thresholds->'selection') || jsonb_build_object('discoveryFreshnessHours', 2)
   )
 where jsonb_exists(thresholds, 'selection')
   and not jsonb_exists(thresholds->'selection', 'discoveryFreshnessHours');

create index if not exists markets_disc_seen_idx on public.markets (disc_seen_at)
  where resolved_at is null;

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
