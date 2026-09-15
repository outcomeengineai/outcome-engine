-- =========================================================================
-- GENERATED — do not edit. Rebuild: npm run build:manual-sql
--
-- Migrations not yet applied to the live database, in order, wrapped in one
-- transaction. Paste into the Supabase SQL editor and Run.
--
-- All-or-nothing: a failure applies nothing, so it is safe to re-run after a
-- fix. Already-applied statements would fail on the first CREATE, which is
-- why this file only contains what is genuinely outstanding — keep
-- APPLIED_THROUGH in scripts/build-manual-sql.mjs current.
-- =========================================================================

begin;


-- ===== 20260823001500_discovery_chunked.sql ========================

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


-- ===== 20260823001600_base_rate_stats.sql ==========================

-- ===========================================================================
-- Base rates aggregated in SQL.
--
-- WHY. The scorer loaded every resolved position as a row and tallied wins per
-- (category, side) in the function. PostgREST caps any response at 1,000 rows
-- and says nothing, so once members had accumulated more than a thousand
-- resolved trades the base rates would have been computed from an arbitrary
-- subset -- and base rates feed every score. That is a silent, growing bias,
-- found while fixing the same truncation in the slow pricing tier.
--
-- A tally is a GROUP BY. It belongs here, where the result is a few dozen
-- rows regardless of how many trades exist.
-- ===========================================================================
create or replace view public.base_rate_stats
with (security_invoker = true) as
select
  category,
  side,
  count(*) filter (where outcome = 'win') as wins,
  count(*)                                as total
from public.resolved_positions
group by category, side;

comment on view public.base_rate_stats is
  'Win tallies per (category, side) over all resolved positions, paper and '
  'live. Paper is included on purpose: the question is whether the model was '
  'right, not who owes what, and excluding paper would discard most early '
  'evidence.';


-- ===== 20260823001700_tiered_scoring_cron.sql ======================

-- ===========================================================================
-- Scoring runs per cadence tier, like pricing.
--
-- WHY. The first pass over the tiered universe scored 82 of the 800 fast-tier
-- markets. The scorer filled its slots by volume across every snapshot, so
-- 300 of 400 went to long-dated slow markets that out-rank near-dated ones on
-- volume -- undoing the tiering it was meant to read.
--
-- The scorer now takes a tier and scores that tier's candidates, with a
-- history window scaled to the tier's pricing cadence. Schedules follow the
-- pricing jobs by a minute or two so each pass reads fresh snapshots.
-- ===========================================================================

do $$
begin
  perform cron.unschedule('oe-score-markets');
exception when others then
  null;
end;
$$;

-- Fast: every 5 minutes, one minute behind fast pricing. The tier members act
-- on; the whole cap is scored every pass.
select cron.schedule(
  'oe-score-fast', '1-56/5 * * * *',
  $cron$ select public.invoke_edge_function('score-markets', '{"tier":"fast"}'::jsonb); $cron$
);

-- Slow: hourly, two minutes behind slow pricing (:10). Drift on hourly
-- snapshots needs three active intervals, so this tier only starts producing
-- directions a few hours after a market enters it -- expected, not a fault.
select cron.schedule(
  'oe-score-slow', '12 * * * *',
  $cron$ select public.invoke_edge_function('score-markets', '{"tier":"slow"}'::jsonb); $cron$
);

-- Archive: daily, after archive pricing (08:25). History only for now; a
-- score here is a long-dated tail-entry candidate, not a desk item.
select cron.schedule(
  'oe-score-archive', '40 8 * * *',
  $cron$ select public.invoke_edge_function('score-markets', '{"tier":"archive"}'::jsonb); $cron$
);


-- ===== 20260823001800_v1_2_draft.sql ===============================

-- ===========================================================================
-- Model v1.2 -- DRAFT. Supersedes the v1.1 drift-only stopgap.
--
-- Inserted as a draft, not published. Publishing is a section 7 act that
-- needs the full-cap fast-tier distribution behind it; this migration puts
-- the version on the table with its reasoning recorded, so publishing is a
-- one-line decision when the evidence lands, not a rushed edit.
--
-- WHAT CHANGES, and why each part:
--
--   1. surface 4.0 -> 5.0.  v1.1 lowered it because "scoreMax 4.8 across 394
--      markets". Those 394 had a median horizon of 1,217 days. On the tiered
--      universe the fast tier sits at score p50 5.1 / p90 6.5 after fifty
--      minutes of history: 5.0 is the median, not a ceiling. The v1.1 premise
--      was a correct response to a fact measured on the wrong universe.
--      PROVISIONAL until the full-cap distribution confirms it.
--
--   2. news weight -> 0 (default 0.28, Weather 0.08).  GDELT has been
--      unreachable on every pass (newsAborted: true). The signal contributed a
--      neutral value at full weight, compressing every score toward the
--      middle and damping the one signal that works. Zero until a real source
--      exists. combineSignals normalises by the weight total, so micro and
--      base scale up in their existing 5:1 ratio; the shared package tests
--      pin that behaviour.
--
--   3. selection is part of the contract, deliberately. v1 and v1.1 had the
--      block stamped on after the fact. v1.2 is the first version published
--      knowing what it can see.
--
-- WHAT DOES NOT CHANGE: minSideSeparation 0.5 (it gated 45 of 82 fast-tier
-- markets that had no direction -- doing its job); micro:base ratio; risk
-- limits; strongPick. No anchors: those add a signal (section 1) and belong
-- to a later version.
--
-- Evidence recorded for the notes, first tiered pass, 2026-09-11 17:01 UTC,
-- ~50 min of fast-tier history:
--   fast  considered 82  scored 36 (44%)  scoreP50 5.1  scoreP90 6.5  sepP90 3.6
--   slow  considered 300 scored 1 (0.3%)  scoreP50 3.7  belowSurface 247
--   old universe (v1.1 basis): scored 6 of ~394 (1.5%)  scoreMax 4.8
-- ===========================================================================

insert into public.model_versions
  (version_label, status, weights, thresholds, risk_limits, notes)
select
  'v1.2',
  'draft',
  jsonb_build_object(
    'default',   jsonb_build_object('micro', 0.60, 'news', 0, 'base', 0.12),
    'overrides', jsonb_build_object(
      'Weather', jsonb_build_object('micro', 0.70, 'news', 0, 'base', 0.22)
    )
  ),
  thresholds || jsonb_build_object('surface', 5.0),
  risk_limits,
  'Supersedes v1.1 (drift-only stopgap). The stopgap lowered surface to 4.0 '
  'because 5.0 was unreachable on a universe with a 1,217-day median horizon. '
  'On the tiered universe the fast tier scores p50 5.1 / p90 6.5, so 5.0 is '
  'restored. News weight zeroed until a reachable source exists: GDELT aborted '
  'on every pass and was diluting live signals at full weight. Selection '
  'tunables are part of this version by design. Evidence: first tiered pass '
  '2026-09-11 17:01Z, fast 36/82 directional (44%) vs slow 1/300 (0.3%) vs '
  'old universe 6/394 (1.5%). Surface value provisional until the full-cap '
  'distribution is read.'
from public.model_versions
where version_label = 'v1.1'
  and not exists (select 1 from public.model_versions where version_label = 'v1.2');

-- Not published here. When the distribution confirms:
--   select public.publish_model_version(
--     (select id from public.model_versions where version_label = 'v1.2'));
-- or publish from the admin dashboard, which calls the same function.


-- ===== 20260823001900_latest_denormalized.sql ======================

-- ===========================================================================
-- "Latest" is a column, not a sort.
--
-- WHY. latest_snapshots was DISTINCT ON over the entire market_snapshots
-- table, with no index that supports the ordering. Every Decision Desk and
-- Positions load sorted every snapshot ever written to find the newest per
-- market. Measured on three days of realistic volume (871k snapshots):
--
--   latest_snapshots alone      445 ms
--   decision_desk (Desk tab)    708 ms
--
-- on a laptop, growing linearly with history -- ~300k rows a day. That is the
-- multi-second tab switch in the admin dashboard, and it would only get
-- worse. latest_scores had the same shape over scores (89 ms and growing).
--
-- The newest snapshot per market is now six columns on markets, and the
-- newest score per (version, market) is a small table, both maintained by
-- statement-level triggers on insert. The views keep their names and exact
-- column lists, so every consumer -- admin, member app, scorer -- is
-- unchanged. The Desk gets a view that resolves the caller's effective
-- version itself, turning three sequential round-trips into one.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Newest snapshot, on the market row
-- --------------------------------------------------------------------------
alter table public.markets
  add column last_price         smallint,
  add column last_volume        bigint,
  add column last_spread        smallint,
  add column last_open_interest bigint,
  add column last_liquidity     bigint,
  add column last_snapshot_at   timestamptz;

create or replace function public.markets_apply_latest_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- One UPDATE per statement, not per row: ingestion inserts in 500-row
  -- chunks, and the newest row per market within the chunk is all that
  -- matters. Never move backwards if an older snapshot arrives late.
  update public.markets m
     set last_price         = n.price,
         last_volume        = n.volume,
         last_spread        = n.spread,
         last_open_interest = n.open_interest,
         last_liquidity     = n.liquidity,
         last_snapshot_at   = n.ts
    from (
      select distinct on (market_id) market_id, ts, price, volume, spread, open_interest, liquidity
        from inserted
       order by market_id, ts desc
    ) n
   where m.id = n.market_id
     and (m.last_snapshot_at is null or n.ts >= m.last_snapshot_at);
  return null;
end;
$fn$;

create trigger market_snapshots_apply_latest
  after insert on public.market_snapshots
  referencing new table as inserted
  for each statement execute function public.markets_apply_latest_snapshot();

-- Backfill from what exists. One-time cost of the sort this migration removes.
update public.markets m
   set last_price = s.price, last_volume = s.volume, last_spread = s.spread,
       last_open_interest = s.open_interest, last_liquidity = s.liquidity, last_snapshot_at = s.ts
  from (
    select distinct on (market_id) market_id, ts, price, volume, spread, open_interest, liquidity
      from public.market_snapshots
     order by market_id, ts desc
  ) s
 where m.id = s.market_id;

-- Same name, same columns, same types. Consumers do not change.
create or replace view public.latest_snapshots
with (security_invoker = true) as
select
  m.id                 as market_id,
  m.last_snapshot_at   as ts,
  m.last_price         as price,
  m.last_volume        as volume,
  m.last_spread        as spread,
  m.last_open_interest as open_interest,
  m.last_liquidity     as liquidity
from public.markets m
where m.last_snapshot_at is not null;

-- --------------------------------------------------------------------------
-- Newest score per (version, market)
-- --------------------------------------------------------------------------
create table public.market_latest_scores (
  model_version_id uuid not null references public.model_versions(id) on delete cascade,
  market_id        text not null references public.markets(id) on delete cascade,
  score_id         uuid not null,
  ts               timestamptz not null,
  side             public.market_side not null,
  score            numeric(3,1) not null,
  breakdown        jsonb not null,
  primary key (model_version_id, market_id)
);

create index market_latest_scores_version_score_idx
  on public.market_latest_scores (model_version_id, score desc);

alter table public.market_latest_scores enable row level security;
create policy market_latest_scores_select on public.market_latest_scores
  for select to authenticated using (true);
revoke all on public.market_latest_scores from anon;

create or replace function public.scores_apply_latest()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.market_latest_scores
    (model_version_id, market_id, score_id, ts, side, score, breakdown)
  select distinct on (model_version_id, market_id)
         model_version_id, market_id, id, ts, side, score, breakdown
    from inserted
   order by model_version_id, market_id, ts desc
  on conflict (model_version_id, market_id) do update
     set score_id  = excluded.score_id,
         ts        = excluded.ts,
         side      = excluded.side,
         score     = excluded.score,
         breakdown = excluded.breakdown
   where excluded.ts >= market_latest_scores.ts;
  return null;
end;
$fn$;

create trigger scores_apply_latest
  after insert on public.scores
  referencing new table as inserted
  for each statement execute function public.scores_apply_latest();

insert into public.market_latest_scores
  (model_version_id, market_id, score_id, ts, side, score, breakdown)
select distinct on (model_version_id, market_id)
       model_version_id, market_id, id, ts, side, score, breakdown
  from public.scores
 order by model_version_id, market_id, ts desc
on conflict do nothing;

create or replace view public.latest_scores
with (security_invoker = true) as
select
  l.score_id as id,
  l.market_id,
  l.model_version_id,
  l.ts,
  l.side,
  l.score,
  l.breakdown
from public.market_latest_scores l;

-- --------------------------------------------------------------------------
-- The Desk in one round-trip
--
-- The page used to call getUser(), then effective_version_for(), then query
-- decision_desk with the result, then model_versions for the label and
-- thresholds -- four sequential network hops before rendering. The view
-- resolves the caller's version itself and carries the version fields along.
-- --------------------------------------------------------------------------
create or replace view public.my_decision_desk
with (security_invoker = true) as
select
  d.*,
  mv.version_label,
  mv.thresholds
from public.decision_desk d
join public.model_versions mv on mv.id = d.model_version_id
where d.model_version_id = public.effective_version_for(auth.uid());

grant select on public.my_decision_desk to authenticated;


-- ===== 20260823002000_signal_hold.sql ==============================

-- ===========================================================================
-- Manual signal holds, and the news signal put on one.
--
-- WHY. signal_health knows two ways for a signal to be off: a performance
-- break (auto-disabled on hit rate) and a cooldown (disabled_until). A signal
-- that is UNAVAILABLE is neither. A disabled row with no disabled_until reads
-- as an expired cooldown and is flipped back to healthy within the hour.
--
-- News is unavailable. Measured directly against GDELT:
--
--   * one request permitted every five seconds (HTTP 429 otherwise)
--   * ~12 seconds per response when permitted
--
-- The scorer fired 60 concurrent requests with a 2.5s timeout, failing on both
-- counts every pass -- and kept doing so every five minutes, collecting 429s
-- from a free public service for nothing. Done politely it is still hopeless:
-- 800 fast-tier markets at one request per five seconds is 67 minutes per
-- pass against a 5-minute cadence. The per-market article search that the
-- signal was designed around cannot run on this source at all.
--
-- A hold is set by a person, states why, and is lifted by a person. The
-- health job leaves held signals alone; the scorer treats them as disabled
-- and does not fetch.
-- ===========================================================================
alter table public.signal_health
  add column hold_reason text;

comment on column public.signal_health.hold_reason is
  'Non-null puts the signal on a manual hold: treated as disabled by the '
  'scorer, never auto-re-enabled by signal-health. For unavailability, not '
  'performance -- performance is what the automatic breaker is for.';

update public.signal_health
   set status          = 'disabled',
       disabled_until  = null,
       disabled_reason = 'Held: source unavailable (see hold_reason).',
       hold_reason     =
         'GDELT permits one request per five seconds and answers in ~12s; '
         'per-market article search cannot run at 800 markets per 5-minute '
         'pass. Held until a viable news source exists. Set by migration '
         '20260823002000 on 2026-09-11.',
       computed_at     = now()
 where signal = 'news';

insert into public.activity_log (event_type, detail, metadata)
values (
  'signal.held',
  'news held: GDELT rate-limited to 1 req/5s with ~12s latency; unusable at platform scale',
  jsonb_build_object('signal', 'news', 'source', 'GDELT', 'rate_limit', '1/5s', 'latency_s', 12)
);


-- ===== 20260823002100_v1_2_thresholds_anchored.sql =================

-- ===========================================================================
-- v1.2 draft: thresholds anchored to the fast-tier distribution, and how.
--
-- The score is a RANKING, not a probability (addendum decision 1). A
-- ranking's thresholds only mean something relative to the distribution they
-- cut, so they are set as tier percentiles of the UNFILTERED scores -- the
-- scorer's own pre-gate report, not the surfaced set, which would be the
-- model grading its own homework.
--
-- Why it matters now: when the news signal was held, activeWeights
-- renormalised and micro went from 60% of the score to 83%. Micro saturates
-- (8c drift, 3x volume, tight book -- routine for near-dated markets), so the
-- ceiling moved from 8.3 to 9.6 and a third of the desk cleared v1.1's
-- absolute strongPick of 7.0. The rank did not change; the labels broke.
-- Percentile anchoring is robust to exactly this: any hold or auto-disable
-- shifts the scale, and absolute thresholds silently break while percentile
-- ones do not.
--
-- Sample: score-markets fast-tier pre-gate report, 2026-09-13 02:41 UTC,
-- news held: scoreP50 4.8, scoreP90 7.1 over 152 considered.
--   surface    = p50 -> 5.0   (rounded to the half-point)
--   strongPick = p90 -> 7.0
-- These are v1's original values. v1.1 lowered surface to 4.0 on a sample
-- with a 1,217-day median horizon; on the tiered universe the original
-- numbers are where the distribution actually sits.
--
-- To redo after any change to weights, holds or selection: read the latest
-- fast-tier byTier block and set surface = round2(scoreP50), strongPick =
-- round2(scoreP90), where round2 rounds to the nearest 0.5.
-- ===========================================================================
update public.model_versions
   set thresholds = thresholds
       || jsonb_build_object('surface', 5.0, 'strongPick', 7.0)
       || jsonb_build_object('anchoring', jsonb_build_object(
            'method',    'tier percentiles of pre-gate scores',
            'tier',      'fast',
            'surface',   'p50',
            'strongPick','p90',
            'sample',    jsonb_build_object(
               'at', '2026-09-13T02:41:00Z', 'considered', 152,
               'scoreP50', 4.8, 'scoreP90', 7.1, 'newsHeld', true))),
       notes = notes || ' Thresholds anchored 2026-09-13 as fast-tier percentiles '
               'of pre-gate scores (p50 4.8 -> surface 5.0, p90 7.1 -> strongPick 7.0); '
               'see thresholds.anchoring for the sample and method.'
 where version_label = 'v1.2'
   and status = 'draft';


-- ===== 20260823002200_horizon_runway_incumbency.sql ================

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


-- ===== 20260823002300_status_and_freshness.sql =====================

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


-- ===== 20260823002400_v1_2_reanchored.sql ==========================

-- ===========================================================================
-- v1.2 draft: thresholds re-anchored on the stable universe.
--
-- The 2026-09-13 anchoring (surface 5.0 / strongPick 7.0) was measured on a
-- fast tier that was mostly finished games, with price histories truncated
-- to the oldest 1,000 rows per batch. Neither fact was known at the time.
-- Both are fixed (migrations 2200-2300, and the paged history load), and
-- the tier has now held stable -- ~790 markets, single-digit churn per
-- sweep -- for several hours with complete histories.
--
-- Sample: score-markets fast-tier pre-gate report, 2026-09-14 02:26 UTC,
-- news held, skippedNoData 0, 794 considered:
--   scoreP50 4.2 -> surface    4.0
--   scoreP90 7.6 -> strongPick 7.5
--   sepP50 0.5, sepP90 4.6, sepMax 5.0; 362 scored with a direction.
--
-- Same method as before (tier percentiles of pre-gate scores, rounded to the
-- half-point). Note that surface lands exactly where v1.1 had put it: the
-- stopgap was the right number for the wrong reason, and this is the same
-- number for the right one. The reason is what a later reader needs.
-- ===========================================================================
update public.model_versions
   set thresholds = thresholds
       || jsonb_build_object('surface', 4.0, 'strongPick', 7.5)
       || jsonb_build_object('anchoring', jsonb_build_object(
            'method',    'tier percentiles of pre-gate scores',
            'tier',      'fast',
            'surface',   'p50',
            'strongPick','p90',
            'sample',    jsonb_build_object(
               'at', '2026-09-14T02:26:00Z', 'considered', 794, 'skippedNoData', 0,
               'scoreP50', 4.2, 'scoreP90', 7.6, 'sepP50', 0.5, 'sepP90', 4.6,
               'newsHeld', true, 'universeStable', true))),
       notes = regexp_replace(notes, ' Thresholds anchored 2026-09-13.*$', '')
               || ' Thresholds re-anchored 2026-09-14 on the stable universe with complete '
               'histories (p50 4.2 -> surface 4.0, p90 7.6 -> strongPick 7.5); the 09-13 '
               'sample was finished games on truncated history. See thresholds.anchoring.'
 where version_label = 'v1.2'
   and status = 'draft';


-- ===== 20260823002500_desk_lifecycle.sql ===========================

-- ===========================================================================
-- The Decision Desk applies the same lifecycle rules as tier assignment.
--
-- WHY. The desk showed finished games. The view hid a market only when
-- resolved_at was set or close_time had passed. For an early finalization
-- our close_time is still the contractual deadline days out, resolved_at
-- lands only when the resolution job reaches the market -- behind a queue
-- of stale rows -- and the last score from before the market ended is still
-- its latest. A finished game, with a confident-looking score, on the desk.
--
-- Tier assignment already knows how to tell a live market from a dead one
-- (migration 2300). The desk now applies the same tests, plus one of its
-- own: the score must be fresh. A market whose latest score is older than
-- two hours is no longer being scored -- it left the fast tier, or scoring
-- is broken -- and either way the desk must not present it as current.
--
-- Same name, same columns, so the member app and my_decision_desk are
-- unchanged.
-- ===========================================================================
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
  case when ls.side = 'YES' then snap.price else 100 - snap.price end as side_price
from public.markets m
join public.latest_scores ls on ls.market_id = m.id
left join public.latest_snapshots snap on snap.market_id = m.id
where m.resolved_at is null
  -- Not ended, by the field Kalshi actually updates on early finalization.
  and coalesce(m.status, '') not in ('finalized', 'settled', 'closed')
  -- Still in the priced universe. 'excluded' covers settled, expired, stale,
  -- too-short and shards.
  and m.cadence_tier <> 'excluded'
  -- Not past the EARLIER of expected and actual close.
  and (m.close_time is null
       or least(coalesce(m.expected_close, m.close_time), m.close_time) > now())
  -- Scored recently. Fast tier scores every five minutes; slow hourly.
  and ls.ts > now() - interval '2 hours';


-- ===== 20260823002600_retention.sql ================================

-- ===========================================================================
-- Retention that matches the write rate.
--
-- WHY. The database hit its size limit. Snapshots and scores both kept 30
-- days, pruning ran once a day, and the platform was two weeks old -- so
-- nothing had ever been pruned, including the first days when ingestion
-- wrote 2,000 snapshots every five minutes across the whole book. Today the
-- fast tier alone produces ~230k snapshots and ~230k scores a day, and a
-- score row carries a JSON breakdown. Thirty days of that is gigabytes.
--
-- What each table is FOR decides how long it is kept:
--
--   market_snapshots   raw 5-minute prices. Drift reads a 6-hour window;
--                      backtests and charts read the DAILY rollup beyond a
--                      few days. Raw retention: 5 days, then rolled up.
--   scores             every pass's score. The newest per (version, market)
--                      lives in market_latest_scores; the labelled thesis at
--                      resolution carries the score and breakdown the
--                      learning loop needs. Raw retention: 3 days.
--   activity_log       operational trail. 14 days.
--   cron.job_run_details  pg_cron's own log, one row per run, never pruned
--                      by default. Thousands a day. 2 days.
--   edge_theses, universe_membership, resolutions, trades   permanent.
--
-- And the prune runs every six hours instead of once a day, so a bad day
-- cannot get a full day ahead of it.
--
-- Deleting does not shrink the file on disk; VACUUM FULL does. That is a
-- one-time manual step after the first prune, documented in the README.
-- ===========================================================================

insert into public.platform_settings (key, value) values
  ('snapshot_retention_days',   '5'::jsonb),
  ('score_retention_days',      '3'::jsonb),
  ('activity_retention_days',   '14'::jsonb),
  ('cron_log_retention_days',   '2'::jsonb)
on conflict (key) do update set value = excluded.value
  where public.platform_settings.key = 'snapshot_retention_days';  -- tighten the old default; others insert-only

create or replace function public.rollup_and_prune_snapshots()
returns integer
language plpgsql
security definer
set search_path = public, cron
set statement_timeout = '600s'
as $fn$
declare
  v_days      integer := public.setting_numeric('snapshot_retention_days', 5)::integer;
  v_score_d   integer := public.setting_numeric('score_retention_days', 3)::integer;
  v_act_d     integer := public.setting_numeric('activity_retention_days', 14)::integer;
  v_cron_d    integer := public.setting_numeric('cron_log_retention_days', 2)::integer;
  v_cutoff    timestamptz := now() - make_interval(days => v_days);
  n           integer := 0;
  n_scores    integer := 0;
  n_act       integer := 0;
  n_cron      integer := 0;
begin
  -- Roll up what is about to be deleted into the daily table first, so the
  -- history survives at day resolution.
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

  -- Scores: the newest per (version, market) is in market_latest_scores and
  -- the labelled thesis carries what the learning loop needs, so raw rows
  -- older than the window can go. A trade records its entry_score as a
  -- value, not a reference, so nothing here can blank out a position card.
  delete from public.scores s
   where s.ts < now() - make_interval(days => v_score_d)
     and not exists (select 1 from public.market_latest_scores l where l.score_id = s.id);
  get diagnostics n_scores = row_count;

  delete from public.activity_log where ts < now() - make_interval(days => v_act_d);
  get diagnostics n_act = row_count;

  -- pg_cron keeps every run's row forever unless told otherwise.
  delete from cron.job_run_details where end_time < now() - make_interval(days => v_cron_d);
  get diagnostics n_cron = row_count;

  insert into public.activity_log (event_type, detail, metadata)
  values ('maintenance.pruned',
          format('%s snapshots, %s scores, %s activity rows, %s cron rows', n, n_scores, n_act, n_cron),
          jsonb_build_object('snapshots', n, 'scores', n_scores, 'activity', n_act, 'cron', n_cron));

  return n;
end;
$fn$;

-- Every six hours, not once a day.
select cron.schedule(
  'oe-prune-snapshots', '30 */6 * * *',
  $cron$ select public.rollup_and_prune_snapshots(); $cron$
);


-- ===== 20260823002700_bloat_and_membership.sql =====================

-- ===========================================================================
-- Bloat control and membership compaction.
--
-- Measured at the size limit (546 MB):
--   markets              175 MB   for 284k rows -- bloat. Discovery upserts
--                                 ~120k rows every 40 minutes; each update
--                                 leaves a dead tuple and autovacuum's
--                                 defaults (20% of the table must be dead
--                                 before it runs) lose the race.
--   universe_membership  127 MB   debris from the tier-churn bug: every sweep
--                                 re-tiered 100k+ markets and logged each
--                                 transition. Rows for the 'excluded' tier
--                                 are ~95% of it and carry no backtest value:
--                                 a backtest asks what was PRICED and when,
--                                 and excluded means "was not".
--
-- Two changes here; the third (VACUUM FULL) is manual, see README.
-- ===========================================================================

-- Autovacuum: run early and often on the tables that churn. Scale factor 0
-- plus a fixed threshold means "after N dead rows", not "after 20% of the
-- table is dead" -- on a 284k-row table the default waits for 57k corpses.
alter table public.markets set (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold    = 5000,
  autovacuum_analyze_scale_factor = 0.02
);
alter table public.market_snapshots set (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold    = 20000
);
alter table public.scores set (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold    = 20000
);
alter table public.universe_membership set (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold    = 20000
);

-- Membership compaction, folded into the six-hourly prune. Closed rows for
-- the 'excluded' tier are dropped once they are a day old; every row for a
-- priced tier (fast, slow, archive) is kept forever, open or closed. That is
-- the point-in-time record a backtest actually needs.
create or replace function public.compact_universe_membership()
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '600s'
as $fn$
declare n integer;
begin
  delete from public.universe_membership
   where tier = 'excluded'
     and left_at is not null
     and left_at < now() - interval '1 day';
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- One-time: clear the churn-era debris now rather than waiting a day.
select public.compact_universe_membership();

-- Chain it into the prune so it runs every six hours with the rest.
create or replace function public.prune_all()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare a integer; b integer;
begin
  a := public.rollup_and_prune_snapshots();
  b := public.compact_universe_membership();
  return jsonb_build_object('snapshots', a, 'membership', b);
end;
$fn$;

select cron.schedule(
  'oe-prune-snapshots', '30 */6 * * *',
  $cron$ select public.prune_all(); $cron$
);


-- ===== 20260823002800_calibration.sql ==============================

-- ===========================================================================
-- Calibration: what the model actually gets right, net of fees.
--
-- The learning loop labels every scored market at resolution. This turns
-- those labels into the one table that decides whether the platform makes
-- money: for each tier and score band, how often the model's side won, with
-- a confidence interval, at what average entry price, and what that was
-- worth per contract after Kalshi's trading fee.
--
-- Three things are deliberate:
--
--   * The label is the SCORE'S SIDE versus the outcome. v1 theses carry no
--     direction (thesis_type 'none'), so thesis_correct is null on every
--     row; the model's call is payload.side, and that is what gets graded.
--   * Only labels since calibration_start count. Before the universe fix
--     (2026-09-14 01:22 UTC) the fast tier was mostly finished games; a label
--     on a market that was already over is not evidence about anything.
--   * The bar is BREAKEVEN, not 50%. At 60c a side must be right more than
--     61.4% of the time to make money after fees. Every bucket reports its
--     hit rate against the breakeven rate at its average price, and the
--     recommendation only counts a band as edge when the LOWER confidence
--     bound clears that bar with enough sample to mean it.
-- ===========================================================================

insert into public.platform_settings (key, value) values
  ('calibration_start',      '"2026-09-14T02:00:00Z"'::jsonb),
  ('calibration_min_sample', '30'::jsonb)
on conflict (key) do nothing;

-- Kalshi's general trading fee: 7% of price x (1 - price), per contract,
-- rounded up to the cent. Matches kalshiFeeCents in the shared package.
create or replace function public.kalshi_fee_cents(p_price integer, p_contracts integer default 1)
returns integer
language sql
immutable
as $fn$
  select ceil(0.07 * p_contracts * (p_price / 100.0) * (1 - p_price / 100.0) * 100)::integer;
$fn$;

-- --------------------------------------------------------------------------
-- One row per labelled thesis, with its economics.
-- --------------------------------------------------------------------------
create or replace view public.calibration_rows
with (security_invoker = true) as
select
  t.id                                          as thesis_id,
  t.market_id,
  t.model_version_id,
  t.created_at                                  as labelled_at,
  (t.payload->>'side')::public.market_side      as side,
  (t.payload->>'resolved_outcome')::public.market_side as outcome,
  (t.payload->>'score')::numeric                as score,
  floor((t.payload->>'score')::numeric)::int    as band,
  (t.payload->>'price')::int                    as price,
  -- Tier at the time: from the payload once the scorer records it; before
  -- that, the last priced tier in the point-in-time membership log.
  coalesce(t.payload->>'tier', um.tier::text)   as tier,
  coalesce(t.payload->>'category', m.category)  as category,
  (t.payload->>'side') = (t.payload->>'resolved_outcome') as hit,
  case
    when (t.payload->>'price') is null then null
    when (t.payload->>'side') = (t.payload->>'resolved_outcome')
      then 100 - (t.payload->>'price')::int - public.kalshi_fee_cents((t.payload->>'price')::int)
    else - (t.payload->>'price')::int - public.kalshi_fee_cents((t.payload->>'price')::int)
  end                                           as net_cents
from public.edge_theses t
join public.markets m on m.id = t.market_id
left join lateral (
  select u.tier from public.universe_membership u
   where u.market_id = t.market_id and u.tier <> 'excluded'
   order by u.entered_at desc limit 1
) um on true
where t.payload ? 'final_state'
  and t.payload ? 'side'
  and t.payload ? 'resolved_outcome'
  and t.created_at >= (
    select (value #>> '{}')::timestamptz from public.platform_settings where key = 'calibration_start'
  );

grant select on public.calibration_rows to authenticated;

-- --------------------------------------------------------------------------
-- Buckets: tier x score band (and optionally category).
-- --------------------------------------------------------------------------
create or replace function public.calibration_table(
  p_version uuid default null,
  p_by_category boolean default false
)
returns table (
  tier            text,
  category        text,
  band            integer,
  n               bigint,
  hits            bigint,
  hit_rate        numeric,
  ci_low          numeric,
  ci_high         numeric,
  avg_price       numeric,
  breakeven_rate  numeric,
  avg_net_cents   numeric,
  priced_n        bigint
)
language sql
security definer
set search_path = public
stable
as $fn$
  with rows as (
    select * from public.calibration_rows r
     where (p_version is null or r.model_version_id = p_version)
       and r.tier is not null
  ),
  g as (
    select
      r.tier,
      case when p_by_category then r.category else '*' end as category,
      r.band,
      count(*)::bigint                                      as n,
      count(*) filter (where r.hit)::bigint                 as hits,
      avg(r.price)                                          as avg_price,
      avg(r.net_cents)                                      as avg_net_cents,
      count(r.price)::bigint                                as priced_n
    from rows r
    group by 1, 2, 3
  ),
  w as (
    -- Wilson score interval, z = 1.96. Honest at small n where the naive
    -- p +/- 1.96*sqrt(p(1-p)/n) is not.
    select g.*,
      (hits::numeric / n) as p,
      1.96 as z
    from g
  )
  select
    w.tier, w.category, w.band, w.n, w.hits,
    round(w.p, 3) as hit_rate,
    round(( (w.p + w.z*w.z/(2*w.n)) - w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_low,
    round(( (w.p + w.z*w.z/(2*w.n)) + w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_high,
    round(w.avg_price, 1) as avg_price,
    case when w.avg_price is null then null
         else round((w.avg_price + public.kalshi_fee_cents(round(w.avg_price)::int)) / 100.0, 3) end as breakeven_rate,
    round(w.avg_net_cents, 2) as avg_net_cents,
    w.priced_n
  from w
  order by w.tier, w.category, w.band;
$fn$;

grant execute on function public.calibration_table(uuid, boolean) to authenticated;

-- --------------------------------------------------------------------------
-- Recommendations, derived from the buckets rather than from opinion.
--
-- A band is EDGE when its lower confidence bound on hit rate clears the
-- breakeven rate at its average price and the sample is at least
-- calibration_min_sample. Suggested surface = the lowest edge band in the
-- tier; suggested strongPick = the lowest band whose average net P&L per
-- contract is at least 5c with the same sample floor. Absent evidence, the
-- recommendation says so rather than guessing.
-- --------------------------------------------------------------------------
create or replace function public.calibration_recommendations(p_version uuid default null)
returns table (
  tier                text,
  labelled            bigint,
  edge_bands          integer[],
  suggested_surface   numeric,
  suggested_strong    numeric,
  verdict             text
)
language plpgsql
security definer
set search_path = public
stable
as $fn$
declare
  v_min integer := public.setting_numeric('calibration_min_sample', 30)::integer;
begin
  return query
  with t as (
    select * from public.calibration_table(p_version, false)
  ),
  judged as (
    select t.tier, t.band, t.n, t.avg_net_cents,
           (t.n >= v_min and t.breakeven_rate is not null and t.ci_low > t.breakeven_rate) as is_edge,
           (t.n >= v_min and t.avg_net_cents >= 5) as is_strong
    from t
  )
  select
    j.tier,
    sum(j.n)::bigint as labelled,
    coalesce(array_agg(j.band order by j.band) filter (where j.is_edge), '{}') as edge_bands,
    min(j.band) filter (where j.is_edge)::numeric as suggested_surface,
    min(j.band) filter (where j.is_strong)::numeric as suggested_strong,
    case
      when sum(j.n) < v_min then format('%s labels; need %s per band before this means anything', sum(j.n), v_min)
      when count(*) filter (where j.is_edge) = 0 then 'no band clears breakeven at its confidence floor yet'
      else format('edge in bands %s; surface at %s', array_agg(j.band order by j.band) filter (where j.is_edge), min(j.band) filter (where j.is_edge))
    end as verdict
  from judged j
  group by j.tier
  order by j.tier;
end;
$fn$;

grant execute on function public.calibration_recommendations(uuid) to authenticated;


-- ===== 20260823002900_digest_cron.sql ==============================

-- ===========================================================================
-- Weekly model review digest to admins.
--
-- Mondays 14:00 UTC (morning in the US), after the weekend's sports markets
-- have resolved and been labelled. The digest reports what the calibration
-- SQL concluded -- edge bands, suggested thresholds, or "not enough
-- evidence" -- and never changes anything: a version change is a decision.
-- ===========================================================================
select cron.schedule(
  'oe-model-review-digest', '0 14 * * 1',
  $cron$ select public.invoke_edge_function('model-review-digest'); $cron$
);


-- ===== 20260823003000_calibration_priced.sql =======================

-- ===========================================================================
-- Calibration: net and hit rate on the SAME population.
--
-- The first real digest showed band 5 at a 53% hit rate against a 55%
-- breakeven with net -21.8c per contract. Those numbers cannot both describe
-- the same rows: net is averaged over labels that carry an entry price --
-- only recorded since 2026-09-14 -- while hit rate covered every label. Two
-- populations in one row, and the smaller one silently drove the verdict.
--
-- Every bucket now reports the priced subset's own hit rate beside its net,
-- and the strong recommendation requires the priced sample to meet the same
-- floor as everything else. Until enough priced labels exist, net stays
-- informative-but-thin rather than authoritative.
-- ===========================================================================

drop function if exists public.calibration_table(uuid, boolean);

create or replace function public.calibration_table(
  p_version uuid default null,
  p_by_category boolean default false
)
returns table (
  tier            text,
  category        text,
  band            integer,
  n               bigint,
  hits            bigint,
  hit_rate        numeric,
  ci_low          numeric,
  ci_high         numeric,
  priced_n        bigint,
  priced_hit_rate numeric,
  avg_price       numeric,
  breakeven_rate  numeric,
  avg_net_cents   numeric
)
language sql
security definer
set search_path = public
stable
as $fn$
  with rows as (
    select * from public.calibration_rows r
     where (p_version is null or r.model_version_id = p_version)
       and r.tier is not null
  ),
  g as (
    select
      r.tier,
      case when p_by_category then r.category else '*' end as category,
      r.band,
      count(*)::bigint                                          as n,
      count(*) filter (where r.hit)::bigint                     as hits,
      count(r.price)::bigint                                    as priced_n,
      count(*) filter (where r.hit and r.price is not null)::bigint as priced_hits,
      avg(r.price)                                              as avg_price,
      avg(r.net_cents)                                          as avg_net_cents
    from rows r
    group by 1, 2, 3
  ),
  w as (
    select g.*, (hits::numeric / n) as p, 1.96 as z from g
  )
  select
    w.tier, w.category, w.band, w.n, w.hits,
    round(w.p, 3) as hit_rate,
    round(( (w.p + w.z*w.z/(2*w.n)) - w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_low,
    round(( (w.p + w.z*w.z/(2*w.n)) + w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_high,
    w.priced_n,
    case when w.priced_n = 0 then null else round(w.priced_hits::numeric / w.priced_n, 3) end as priced_hit_rate,
    round(w.avg_price, 1) as avg_price,
    case when w.avg_price is null then null
         else round((w.avg_price + public.kalshi_fee_cents(round(w.avg_price)::int)) / 100.0, 3) end as breakeven_rate,
    round(w.avg_net_cents, 2) as avg_net_cents
  from w
  order by w.tier, w.category, w.band;
$fn$;

grant execute on function public.calibration_table(uuid, boolean) to authenticated;

-- Return shape changes (adds `priced`), so the old definition has to go first.
drop function if exists public.calibration_recommendations(uuid);

create or replace function public.calibration_recommendations(p_version uuid default null)
returns table (
  tier                text,
  labelled            bigint,
  priced              bigint,
  edge_bands          integer[],
  suggested_surface   numeric,
  suggested_strong    numeric,
  verdict             text
)
language plpgsql
security definer
set search_path = public
stable
as $fn$
declare
  v_min integer := public.setting_numeric('calibration_min_sample', 30)::integer;
begin
  return query
  with t as (
    select * from public.calibration_table(p_version, false)
  ),
  judged as (
    select t.tier, t.band, t.n, t.priced_n, t.avg_net_cents,
           -- Edge: the hit rate's lower bound clears breakeven, on a full sample.
           (t.n >= v_min and t.breakeven_rate is not null and t.ci_low > t.breakeven_rate) as is_edge,
           -- Strong: at least 5c net per contract, on a PRICED sample that
           -- meets the same floor. Ten priced rows do not get to set a
           -- threshold members trade on.
           (t.priced_n >= v_min and t.avg_net_cents >= 5) as is_strong
    from t
  )
  select
    j.tier,
    sum(j.n)::bigint as labelled,
    sum(j.priced_n)::bigint as priced,
    coalesce(array_agg(j.band order by j.band) filter (where j.is_edge), '{}') as edge_bands,
    min(j.band) filter (where j.is_edge)::numeric as suggested_surface,
    min(j.band) filter (where j.is_strong)::numeric as suggested_strong,
    case
      when sum(j.n) < v_min then format('%s labels; need %s per band before this means anything', sum(j.n), v_min)
      when count(*) filter (where j.is_edge) = 0 and sum(j.priced_n) < v_min
        then format('no band clears breakeven at its confidence floor yet; %s of %s labels carry an entry price, so net is thin', sum(j.priced_n), sum(j.n))
      when count(*) filter (where j.is_edge) = 0 then 'no band clears breakeven at its confidence floor yet'
      else format('edge in bands %s; surface at %s', array_agg(j.band order by j.band) filter (where j.is_edge), min(j.band) filter (where j.is_edge))
    end as verdict
  from judged j
  group by j.tier
  order by j.tier;
end;
$fn$;

grant execute on function public.calibration_recommendations(uuid) to authenticated;


-- ===== 20260823003100_anchors.sql ==================================

-- ===========================================================================
-- Anchors (Edge Signals v2, section 1): an external probability.
--
-- Drift is the one lever the platform has had, and calibration shows it
-- carrying information in a narrow band and noise where the model is most
-- confident -- the markets where the move already happened. An anchor is the
-- lever that does not need the price to have moved: a forecast, from a
-- source that does not know the market exists.
--
-- First source: NWS daily max/min temperature forecasts, against Kalshi's
-- daily temperature markets. Each market is a station, a date and a strike
-- band ("75-76", "74 or below", "80 or above") on the recorded high or low.
-- The forecast plus a forecast-error distribution by lead time gives the
-- probability the recorded value lands in the band. That probability is a
-- CLAIM, and the point of this migration is to make it gradeable:
--
--   * every fetch is kept (anchor_history), so a backtest sees what the
--     anchor said at the time, not what it says now;
--   * the scorer stamps the anchor into each thesis, so the resolution label
--     carries it;
--   * anchor_calibration grades it: Brier score and reliability by bucket,
--     BESIDE the market's own price graded the same way. An anchor that does
--     not beat the market's Brier knows nothing the market does not.
--
-- The anchor is measured before it is allowed to move a score. Wiring it
-- into the blend is a later version, on this table's evidence.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Stations. Kalshi's rules name the resolution station by its NWS CLI code
-- ("at Los Angeles (CLILAX)"). Coordinates resolve to an NWS grid on first
-- use and are cached here. Unknown stations are logged, not guessed.
-- --------------------------------------------------------------------------
create table public.anchor_stations (
  code       text primary key,          -- CLILAX
  name       text not null,
  lat        numeric(8,4) not null,
  lon        numeric(8,4) not null,
  timezone   text,                      -- from NWS /points, cached
  grid_url   text,                      -- NWS forecastGridData URL, cached
  updated_at timestamptz not null default now()
);

insert into public.anchor_stations (code, name, lat, lon) values
  ('CLIATL', 'Atlanta (ATL)',            33.6407,  -84.4277),
  ('CLIAUS', 'Austin (AUS)',             30.1975,  -97.6664),
  ('CLIBOS', 'Boston (BOS)',             42.3656,  -71.0096),
  ('CLIDCA', 'Washington DC (DCA)',      38.8512,  -77.0402),
  ('CLIDEN', 'Denver (DEN)',             39.8561, -104.6737),
  ('CLIDFW', 'Dallas (DFW)',             32.8998,  -97.0403),
  ('CLIEWR', 'Newark (EWR)',             40.6895,  -74.1745),
  ('CLIHOU', 'Houston (HOU)',            29.6454,  -95.2789),
  ('CLILAS', 'Las Vegas (LAS)',          36.0840, -115.1537),
  ('CLILAX', 'Los Angeles (LAX)',        33.9425, -118.4081),
  ('CLIMDW', 'Chicago Midway (MDW)',     41.7868,  -87.7522),
  ('CLIMIA', 'Miami (MIA)',              25.7959,  -80.2870),
  ('CLIMSP', 'Minneapolis (MSP)',        44.8848,  -93.2223),
  ('CLIMSY', 'New Orleans (MSY)',        29.9934,  -90.2580),
  ('CLINYC', 'New York Central Park',    40.7789,  -73.9692),
  ('CLIOKC', 'Oklahoma City (OKC)',      35.3931,  -97.6007),
  ('CLIPHL', 'Philadelphia (PHL)',       39.8744,  -75.2424),
  ('CLIPHX', 'Phoenix (PHX)',            33.4373, -112.0078),
  ('CLISAN', 'San Diego (SAN)',          32.7338, -117.1933),
  ('CLISAT', 'San Antonio (SAT)',        29.5337,  -98.4698),
  ('CLISDF', 'Louisville (SDF)',         38.1744,  -85.7360),
  ('CLISEA', 'Seattle (SEA)',            47.4502, -122.3088),
  ('CLITTN', 'Trenton (TTN)',            40.2767,  -74.8135);

alter table public.anchor_stations enable row level security;
create policy anchor_stations_select on public.anchor_stations for select to authenticated using (true);

-- --------------------------------------------------------------------------
-- Latest anchor per market, and every fetch ever made.
-- --------------------------------------------------------------------------
create table public.market_anchors (
  market_id     text primary key references public.markets(id) on delete cascade,
  source        text not null,                 -- 'nws'
  station       text references public.anchor_stations(code),
  target_date   date not null,
  kind          text not null,                 -- 'high' | 'low'
  strike_type   text not null,                 -- 'less' | 'between' | 'greater'
  floor_strike  numeric(6,1),
  cap_strike    numeric(6,1),
  forecast_f    numeric(6,2) not null,         -- NWS forecast, degrees F
  sigma_f       numeric(5,2) not null,         -- assumed forecast error sd at this lead
  lead_hours    numeric(7,1) not null,
  prob_yes      numeric(6,4) not null,         -- P(recorded value in the band)
  forecast_issued_at timestamptz,
  fetched_at    timestamptz not null default now()
);

create index market_anchors_date_idx on public.market_anchors (target_date);

alter table public.market_anchors enable row level security;
create policy market_anchors_select on public.market_anchors for select to authenticated using (true);

create table public.anchor_history (
  id          bigserial primary key,
  market_id   text not null references public.markets(id) on delete cascade,
  source      text not null,
  forecast_f  numeric(6,2) not null,
  sigma_f     numeric(5,2) not null,
  lead_hours  numeric(7,1) not null,
  prob_yes    numeric(6,4) not null,
  fetched_at  timestamptz not null default now()
);
create index anchor_history_market_idx on public.anchor_history (market_id, fetched_at desc);
alter table public.anchor_history enable row level security;
create policy anchor_history_select on public.anchor_history for select to authenticated using (true);

-- --------------------------------------------------------------------------
-- Tunables (section 7). Forecast error by lead day: NWS daily high/low MAE
-- runs about 2F same-day rising to ~5F at four days. These are the STARTING
-- assumptions; anchor_calibration is what corrects them.
-- --------------------------------------------------------------------------
update public.model_versions
   set thresholds = thresholds || jsonb_build_object('anchors', jsonb_build_object(
     'enabled', true,
     'temperatureSigmaF', jsonb_build_array(2.2, 2.8, 3.5, 4.2, 5.0),
     'maxLeadDays', 5
   ))
 where not jsonb_exists(thresholds, 'anchors');

-- --------------------------------------------------------------------------
-- Grading the anchor: Brier and reliability, beside the market's own price.
--
-- Reads the anchor the scorer stamped into the thesis (anchor_prob, for
-- YES) and the market price at that moment (yesPrice). Outcome from the
-- resolution label. Bucketed by the anchor's own probability so the
-- reliability curve is readable: in the "60-70%" bucket, did ~65% resolve
-- YES?
-- --------------------------------------------------------------------------
create or replace view public.anchor_calibration
with (security_invoker = true) as
with rows as (
  select
    t.market_id,
    (t.payload->>'anchor_prob')::numeric              as p_anchor,
    (t.payload->>'yesPrice')::numeric / 100.0          as p_market,
    case when (t.payload->>'resolved_outcome') = 'YES' then 1 else 0 end as y
  from public.edge_theses t
  where t.payload ? 'final_state'
    and t.payload ? 'anchor_prob'
    and t.payload ? 'yesPrice'
    and t.payload ? 'resolved_outcome'
)
select
  width_bucket(p_anchor, 0, 1, 10)                       as bucket,        -- 1..10
  count(*)                                               as n,
  round(avg(p_anchor), 3)                                as anchor_mean,
  round(avg(p_market), 3)                                as market_mean,
  round(avg(y)::numeric, 3)                              as observed_yes,
  round(avg((p_anchor - y) ^ 2), 4)                      as anchor_brier,
  round(avg((p_market - y) ^ 2), 4)                      as market_brier
from rows
group by 1
order by 1;

grant select on public.anchor_calibration to authenticated;

-- Headline: does the anchor beat the market at all, over everything?
create or replace view public.anchor_summary
with (security_invoker = true) as
select
  count(*)                                              as n,
  round(avg(((t.payload->>'anchor_prob')::numeric - (case when t.payload->>'resolved_outcome' = 'YES' then 1 else 0 end)) ^ 2), 4) as anchor_brier,
  round(avg(((t.payload->>'yesPrice')::numeric / 100.0 - (case when t.payload->>'resolved_outcome' = 'YES' then 1 else 0 end)) ^ 2), 4) as market_brier
from public.edge_theses t
where t.payload ? 'final_state' and t.payload ? 'anchor_prob' and t.payload ? 'yesPrice' and t.payload ? 'resolved_outcome';

grant select on public.anchor_summary to authenticated;


-- ===== 20260823003200_anchors_cron.sql =============================

-- ===========================================================================
-- Anchor fetch, hourly.
--
-- NWS grids update a few times a day; hourly catches each update within the
-- hour and keeps lead_hours honest as expiry approaches. :18 sits clear of
-- the pricing, scoring and discovery minutes.
-- ===========================================================================
select cron.schedule(
  'oe-fetch-anchors', '18 * * * *',
  $cron$ select public.invoke_edge_function('fetch-anchors'); $cron$
);


-- ===== 20260823003300_anchor_station_sfo.sql =======================

-- The first live anchor run reported one unknown station. Kalshi's San
-- Francisco temperature markets resolve at CLISFO.
insert into public.anchor_stations (code, name, lat, lon) values
  ('CLISFO', 'San Francisco (SFO)', 37.6213, -122.3790)
on conflict (code) do nothing;


-- ===== 20260823003400_v1_3_draft.sql ===============================

-- ===========================================================================
-- Model v1.3 -- DRAFT. Soft saturation in the micro sub-score.
--
-- WHY. The Decision Desk showed a wall of identical 9.6s, all wearing the
-- strong badge, and the calibration table graded that top band at 47%. The
-- two are the same defect. Micro's momentum component clips at 8c of drift
-- and activity at 3x volume, so every liquid near-dated market that moved
-- anywhere from 8c to 30c lands in the same 0.56-point window at the top of
-- the scale: 0.83 x 10 + 0.17 x 7.5 = 9.6, whatever it actually did. The
-- scale was clipping, not measuring, and a ranking with ties at the top has
-- no information where members look first.
--
-- v1.3 opts into soft saturation (tanh momentum, 1 - exp activity):
-- monotonic, never pinned, 8c and 25c score differently, the same markets
-- spread across ~3 points. It is a version option, not a code change:
-- v1 through v1.2 keep hard clipping so their backtests reproduce what
-- members saw.
--
-- Thresholds are PROVISIONAL, inherited from v1.2. A rescaled score has a
-- new distribution; surface and strongPick get re-anchored as fast-tier
-- percentiles (thresholds.anchoring) from the first pre-gate report under
-- soft saturation, and checked against the backtest, before publish.
-- ===========================================================================
insert into public.model_versions
  (version_label, status, weights, thresholds, risk_limits, notes)
select
  'v1.3',
  'draft',
  weights,
  thresholds
    || jsonb_build_object('micro', jsonb_build_object(
         'saturation', 'soft',
         'momentumScaleCents', 10,
         'activityScale', 3))
    - 'anchoring',
  risk_limits,
  'Supersedes v1.2. Soft saturation in the micro sub-score: the desk showed a '
  'wall of identical 9.6s (every liquid market moving 8-30c scored the same) '
  'and calibration graded that band at 47%. Momentum now tanh(drift/10c), '
  'activity 1-exp(-(ratio-0.5)/3): monotonic, unpinned. Weights unchanged; '
  'news remains 0. Thresholds provisional pending re-anchoring on the soft '
  'distribution and a backtest against v1.2 on the same history.'
from public.model_versions
where version_label = 'v1.2'
  and not exists (select 1 from public.model_versions where version_label = 'v1.3');


-- ===== 20260823003500_v1_3_clear_anchoring.sql =====================

-- Migration 3400 meant to drop v1.2's anchoring record from the v1.3 draft
-- and did not: `thresholds || obj - 'anchoring'` binds the subtraction to
-- obj (jsonb `-` outranks `||`), so the merge put the record back. It
-- describes the hard-clipped distribution and would mislead whoever
-- re-anchors v1.3. Strip it here; the correct form is parenthesised.
update public.model_versions
   set thresholds = (thresholds - 'anchoring')
 where version_label = 'v1.3'
   and status = 'draft';


-- ===== record these migrations as applied =========================
create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version    text not null primary key,
  statements text[],
  name       text
);

insert into supabase_migrations.schema_migrations (version)
values
  ('20260823001500'),
  ('20260823001600'),
  ('20260823001700'),
  ('20260823001800'),
  ('20260823001900'),
  ('20260823002000'),
  ('20260823002100'),
  ('20260823002200'),
  ('20260823002300'),
  ('20260823002400'),
  ('20260823002500'),
  ('20260823002600'),
  ('20260823002700'),
  ('20260823002800'),
  ('20260823002900'),
  ('20260823003000'),
  ('20260823003100'),
  ('20260823003200'),
  ('20260823003300'),
  ('20260823003400'),
  ('20260823003500')
on conflict (version) do nothing;

commit;
