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


-- ===== 20260823000800_revoke_anon_news_cache.sql ===================

-- ===========================================================================
-- Close an ordering gap in the anon revoke.
--
-- 20260823000200_rls.sql ends with:
--
--   revoke all on all tables in schema public from anon;
--
-- That statement applies to tables existing AT THAT MOMENT. news_cache is
-- created two migrations later, so it never lost its anon grant — confirmed
-- against the live database, where every other table returns 42501 to an
-- anonymous caller and news_cache returned 200 with an empty array.
--
-- No data was exposed: RLS is enabled on news_cache and its only policy grants
-- to `authenticated`, so anonymous reads were already filtered to nothing. But
-- the revoke is the second layer precisely so a policy mistake is not the only
-- thing standing between anon and the data, and news_cache was missing it.
-- ===========================================================================

revoke all on public.news_cache from anon;

-- Same for anything added later: revoking by default means a new table has to
-- be granted access deliberately rather than inheriting it.
alter default privileges in schema public revoke all on tables from anon;


-- ===== 20260823000900_ingest_events_setting.sql ====================

-- ===========================================================================
-- Ingestion now walks EVENTS, not the flat markets listing, so the budget is
-- counted in events rather than markets.
--
-- Measured against the live API: 400 events yields ~2,800 markets and ~2,700
-- snapshots. 300 is a comfortable default for a platform serving ~20 people
-- and stays well inside Kalshi's public rate limits at a 5-minute cadence.
-- ===========================================================================

insert into public.platform_settings (key, value)
values ('ingest_max_events', '300'::jsonb)
on conflict (key) do nothing;

-- The old key counted markets from an endpoint we no longer poll.
delete from public.platform_settings where key = 'ingest_max_markets';


-- ===== 20260823001000_side_separation_threshold.sql ================

-- ===========================================================================
-- Add minSideSeparation to model v1's thresholds.
--
-- The first 15 live scores were ALL side=YES. Cause: news is neutral for both
-- sides without coverage, and baseRateScore keys off min(price, 100 - price)
-- so it is symmetric by construction. Drift is the only input that can
-- separate the sides, and a market that has not moved ties exactly — with
-- pickSide breaking toward YES every time.
--
-- Surfacing a coin flip with a side badge implies a directional view the model
-- does not hold. This is the minimum gap between the two sides' scores before
-- a market may surface. 0.5 is the smallest gap visible at the one decimal
-- place scores are stored and displayed at.
-- ===========================================================================

update public.model_versions
   set thresholds = thresholds || jsonb_build_object('minSideSeparation', 0.5)
 where version_label = 'v1'
   and not (thresholds ? 'minSideSeparation');


-- ===== 20260823001100_day_one_logging.sql ==========================

-- ===========================================================================
-- Day-one logging (Edge Signals v2, sections 4b / 9 / 10 / 11c / 11e).
--
-- These tables carry no features yet. They exist now because the data they
-- hold cannot be reconstructed later:
--
--   * the model portfolio is only a benchmark if its history is long
--   * own-flow exclusion needs a record of platform orders BEFORE the flow
--     detector can be trusted not to hear its own echo
--   * point-in-time discipline means first-seen values are never restated,
--     so anything not captured at the time is gone
--
-- Every feature built on top of these can wait. The accumulation cannot.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. execution_mode on trades  (§4b, §10)
--
-- Distinguishes a member's own decision from an automated one and from the
-- synthetic benchmark account. Performance and Benchmarks both slice on this,
-- and billing must never see model_portfolio rows.
-- --------------------------------------------------------------------------
create type public.execution_mode as enum ('manual', 'auto_flow', 'model_portfolio');

alter table public.trades
  add column execution_mode public.execution_mode not null default 'manual';

create index trades_execution_mode_idx on public.trades (execution_mode, opened_at desc);

comment on column public.trades.execution_mode is
  'manual = the member chose it. auto_flow = automated on a graduated flow signal. '
  'model_portfolio = the synthetic benchmark account, excluded from billing.';

-- The freeze trigger already protects mode; execution_mode is equally a
-- permanent property of how the trade came to exist.
create or replace function public.freeze_trade_provenance()
returns trigger
language plpgsql
as $$
begin
  if new.model_version_id is distinct from old.model_version_id
     or new.entry_score is distinct from old.entry_score
     or new.mode is distinct from old.mode
     or new.execution_mode is distinct from old.execution_mode then
    raise exception
      'trade % provenance is immutable (model_version_id, entry_score, mode, execution_mode)', old.id;
  end if;

  if old.status <> 'pending' then
    if new.side is distinct from old.side
       or new.entry_price is distinct from old.entry_price
       or new.contracts is distinct from old.contracts
       or new.stake_cents is distinct from old.stake_cents then
      raise exception
        'trade % fill details are immutable once it is no longer pending', old.id;
    end if;
  end if;

  return new;
end;
$$;

-- --------------------------------------------------------------------------
-- 2. platform_flow  (§11c)
--
-- Every order this platform originates, so its own volume can be SUBTRACTED
-- from the flow signal's inputs.
--
-- Members act on the same score, in the same direction, within minutes of each
-- other, on books thin enough to move. Without this the flow detector reads
-- the platform's own members as informed flow and feeds itself. A signal that
-- can hear its own echo is not a signal.
--
-- Paper trades are logged too, and marked: they never touch a real book, so
-- the exclusion query filters to mode='live'. Logging both makes the
-- distinction auditable rather than assumed.
-- --------------------------------------------------------------------------
create table public.platform_flow (
  id            bigserial primary key,
  market_id     text not null references public.markets(id) on delete cascade,
  trade_id      uuid references public.trades(id) on delete set null,
  user_id       uuid references public.users(id) on delete set null,
  side          public.market_side not null,
  contracts     integer not null check (contracts > 0),
  price         smallint not null check (price between 1 and 99),
  mode          public.trade_mode not null,
  execution_mode public.execution_mode not null default 'manual',
  ts            timestamptz not null default now()
);

create index platform_flow_market_ts_idx on public.platform_flow (market_id, ts desc);
create index platform_flow_live_idx on public.platform_flow (market_id, ts desc) where mode = 'live';

-- --------------------------------------------------------------------------
-- 3. edge_theses  (§9)
--
-- Logged for EVERY scored market, traded or not.
--
-- Restricting this to taken trades would inherit whichever markets members
-- happened to like and cap the training set at trade volume instead of market
-- volume. At ~2,000 scored markets against a handful of trades, that is three
-- orders of magnitude of labelled examples discarded. At resolution every row
-- here joins against the outcome, whether anyone traded it or not.
--
-- Never pruned. One row per market per thesis change is small enough to keep
-- forever, and it is the substrate the self-tuning roadmap learns from.
-- --------------------------------------------------------------------------
create type public.thesis_type as enum (
  'anchor_gap',
  'coherence',
  'informed_flow',
  'longshot_bias',
  'none'
);

create table public.edge_theses (
  id               uuid primary key default gen_random_uuid(),
  market_id        text not null references public.markets(id) on delete cascade,
  score_id         uuid references public.scores(id) on delete set null,
  model_version_id uuid not null references public.model_versions(id),
  thesis_type      public.thesis_type not null,
  /** Which side the thesis favours. Null when thesis_type = 'none'. */
  direction        public.market_side,
  /** Size of the claimed mispricing, in cents where that is meaningful. */
  magnitude        numeric(6,3),
  payload          jsonb not null default '{}'::jsonb,
  rendered_text    text,
  created_at       timestamptz not null default now()
);

create index edge_theses_market_idx on public.edge_theses (market_id, created_at desc);
create index edge_theses_type_idx on public.edge_theses (thesis_type, created_at desc);

-- Supports the dedupe-on-unchanged read: the writer compares against the
-- newest row for this market and version before inserting.
create index edge_theses_latest_idx
  on public.edge_theses (market_id, model_version_id, created_at desc);

comment on table public.edge_theses is
  'One row per scoring pass where the thesis CHANGED, for every scored market '
  'whether traded or not. thesis_type = none is a valid and common outcome.';

-- Stamped on the trade so per-thesis PnL is measurable on the traded subset,
-- alongside the full-market view above.
alter table public.trades
  add column thesis_type public.thesis_type,
  add column thesis_payload jsonb;

-- --------------------------------------------------------------------------
-- 4. news_articles  (§5, §11e)
--
-- Replaces news_cache, which had market_id as its PRIMARY KEY and therefore
-- overwrote on every fetch. That is incompatible with point-in-time
-- discipline: it destroyed the record of what was known when.
--
-- This table is append-only. first_seen_at is set once and never updated;
-- published_at comes from the source. The priced-in join (§5) needs both, and
-- the backtest harness may only read rows timestamped before the simulated
-- decision.
-- --------------------------------------------------------------------------
create table public.news_articles (
  id            uuid primary key default gen_random_uuid(),
  market_id     text not null references public.markets(id) on delete cascade,
  url           text,
  title         text not null,
  source        text,
  /** From the provider. Null when it does not supply one. */
  published_at  timestamptz,
  /** When WE first saw it. Never updated — this is the point-in-time anchor. */
  first_seen_at timestamptz not null default now(),
  matched_terms text[],
  /** -1..1 lean, or null when not yet assessed. */
  direction_est numeric(4,3),
  /** Did price move within the window after publication? Null until checked. */
  priced_in            boolean,
  priced_in_checked_at timestamptz
);

create index news_articles_market_idx on public.news_articles (market_id, published_at desc nulls last);
create index news_articles_unpriced_idx on public.news_articles (market_id) where priced_in is null;

-- Same article seen on a later pass must not create a second row.
create unique index news_articles_dedupe_idx
  on public.news_articles (market_id, url) where url is not null;

-- --------------------------------------------------------------------------
-- RLS
--
-- All four are platform-internal. Members read theses and articles because
-- both surface on the market detail screen; platform_flow is admin-only, since
-- it reveals what other members are doing.
-- --------------------------------------------------------------------------
alter table public.platform_flow enable row level security;
alter table public.edge_theses   enable row level security;
alter table public.news_articles enable row level security;

create policy platform_flow_admin_read on public.platform_flow
  for select to authenticated using (public.is_admin());

create policy edge_theses_select on public.edge_theses
  for select to authenticated using (true);

create policy news_articles_select on public.news_articles
  for select to authenticated using (true);

revoke all on public.platform_flow, public.edge_theses, public.news_articles from anon;


-- ===== record these migrations as applied =========================
create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version    text not null primary key,
  statements text[],
  name       text
);

insert into supabase_migrations.schema_migrations (version)
values
  ('20260823000800'),
  ('20260823000900'),
  ('20260823001000'),
  ('20260823001100')
on conflict (version) do nothing;

commit;
