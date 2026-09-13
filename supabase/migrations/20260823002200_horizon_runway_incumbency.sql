-- ===========================================================================
-- Horizon from expected expiry; minimum runway; incumbency.
--
-- WHY. The fast tier turned over almost entirely every sweep: 11,890
-- departures in 12 hours against a cap of 800. 9,258 of them left as
-- "settled" with a median of 50 hours still on their close_time. Traced to
-- the source: KXMLBSPREAD-26SEP11... is a game played on September 11 with a
-- close_time of September 14. close_time is a contractual deadline; Kalshi
-- finalizes the market when the game ends and rewrites close_time to the
-- actual close -- but a finalized market leaves the open-events feed, so
-- discovery never sees the correction. expected_expiration_time, which the
-- feed does carry, said September 11 all along.
--
-- Ranking by cumulative volume made it worse: finished games have the most
-- volume, so the tier filled with markets that were already over, ranked
-- to the top precisely because they were over. Each sweep promoted the next
-- batch of corpses. None accumulated the three snapshots drift needs.
--
-- Three changes, all selection tunables on the model version (section 7):
--   * horizon is measured to expected_expiration_time, falling back to
--     close_time only when the expected value is absent;
--   * a market must have fastMinHorizonHours of runway to be PROMOTED to
--     fast -- 15-minute crypto contracts and games in the ninth inning are
--     not worth a slot they cannot use;
--   * an incumbent in the fast tier receives incumbentRankBoost, so it holds
--     its slot until it expires rather than being reshuffled out by a
--     marginally higher-volume newcomer. Stability is what lets history
--     accumulate, which was the point of the tiers.
-- ===========================================================================

alter table public.markets
  add column expected_close timestamptz;

comment on column public.markets.expected_close is
  'Kalshi expected_expiration_time: when the market is expected to actually '
  'end. close_time is a contractual deadline that can sit days later. Horizon '
  'is measured to this.';

update public.model_versions
   set thresholds = jsonb_set(
     thresholds, '{selection}',
     (thresholds->'selection')
       || jsonb_build_object('fastMinHorizonHours', 3, 'incumbentRankBoost', 0.5)
   )
 where jsonb_exists(thresholds, 'selection')
   and not jsonb_exists(thresholds->'selection', 'fastMinHorizonHours');

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
  v_min_h    numeric;   -- hours of runway required for promotion to fast
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
      -- Days to the EXPECTED end, not the contractual deadline.
      extract(epoch from (coalesce(m.expected_close, m.close_time) - v_now)) / 86400.0 as horizon,
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
        when b.family = 'mve_shard'                       then 'excluded'
        when b.horizon is null                            then 'archive'
        when b.horizon < 0                                then 'excluded'
        -- Fast: near-dated, tradeable book, and either enough runway to be
        -- worth promoting or already in the tier (an incumbent rides its
        -- slot to expiry; it is not re-promoted, it is retained).
        when b.horizon <= v_fast_h
         and (not v_two or b.two_sided)
         and b.spread <= v_spread
         and (b.horizon * 24 >= v_min_h or b.current_tier = 'fast') then 'fast'
        -- Too short to track at any cadence: expires before history exists.
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
      c.id,
      c.family,
      round(c.rank_score::numeric, 3) as rank_score,
      c.want,
      c.horizon,
      (case
         when c.id in (select f.id from fast_pick f) then 'fast'
         when c.id in (select s.id from slow_pick s) then 'slow'
         when c.id in (select a.id from arch_pick a) then 'archive'
         else 'excluded'
       end)::public.cadence_tier as tier
    from classified c
  )
  select
    f.id,
    f.family,
    f.rank_score,
    f.want,
    f.tier,
    case
      when f.tier::text = f.want and f.want = 'excluded' and f.horizon < 0
        then 'expired'
      when f.tier::text = f.want and f.want = 'excluded' and f.horizon * 24 < v_min_h
        then 'too short to track'
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
    'fast',     count(*) filter (where tier = 'fast'),
    'slow',     count(*) filter (where tier = 'slow'),
    'archive',  count(*) filter (where tier = 'archive'),
    'excluded', count(*) filter (where tier = 'excluded'),
    'tooShort', count(*) filter (where reason = 'too short to track'),
    'demoted',  count(*) filter (where tier::text is distinct from want),
    'total',    count(*)
  ) into v_result from _tier;

  return v_result;
end;
$fn$;
