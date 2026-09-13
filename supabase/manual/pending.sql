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
  ('20260823002300')
on conflict (version) do nothing;

commit;
