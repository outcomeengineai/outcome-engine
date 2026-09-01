-- ===========================================================================
-- Market universe: families, cadence tiers, and point-in-time membership.
--
-- WHY. Ingestion took the first 300 events Kalshi happened to return and
-- priced whatever was in them. Measured against the full book:
--
--                    ingested        full book
--   median horizon   1,217 days      90 days
--   resolving <=7d   0.0%            26.5%
--   weather markets  5               718
--   coverage         2.7%
--
-- The platform was scoring contracts resolving in 2029. That is the entire
-- explanation for a median side-separation of zero: those markets do not move
-- because nothing has happened yet and will not for years. The drift signal
-- was never weak, it was pointed at the wrong markets.
--
-- Discovery now sees the whole book. Tiers are how pricing cost stays bounded
-- without going blind to the long tail.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Families
--
-- Grounded in the live API rather than guessed. Across 6,000 events:
--   * 1,869 (31%) carry mutually_exclusive; 1,164 of those have >2 legs and
--     are outright/bracket shapes — "Who will the next Pope be?" (7 legs),
--     "Next DNC Chair" (34), 653 in Sports.
--   * Multi-variate-event shards NEVER overlap that set (0 of them), so the
--     two families cannot be confused.
--
-- multi_stage is called out because it is a thesis family of its own:
-- staged-probability mispricing, where the market prices "wins it all" and
-- the trade is "advances a round". Tagged now so section 3's calibration
-- buckets can measure it later.
-- --------------------------------------------------------------------------
create type public.market_family as enum ('standard', 'multi_stage', 'mve_shard');

-- --------------------------------------------------------------------------
-- Cadence tiers
--
-- Not in-or-out. A 7-day horizon filter would amputate the multi-leg family
-- entirely (p10 51 days, median 135), losing exactly the early tail-entry
-- opportunities that are worth having — and losing the price history that
-- makes them scoreable later.
--
--   fast    priced every 5 minutes  — near-dated and liquid
--   slow    priced hourly           — long-dated but still worth tracking
--   archive priced daily            — very long-dated; history accumulates
--   excluded  never priced          — shards, no book at all
-- --------------------------------------------------------------------------
create type public.cadence_tier as enum ('fast', 'slow', 'archive', 'excluded');

alter table public.markets
  add column family       public.market_family not null default 'standard',
  add column cadence_tier public.cadence_tier  not null default 'slow',
  add column tier_reason  text,
  /** True when a category has an external anchor source available. */
  add column anchorable    boolean not null default false,
  add column last_priced_at timestamptz;

create index markets_tier_idx on public.markets (cadence_tier, last_priced_at nulls first)
  where resolved_at is null;
create index markets_family_idx on public.markets (family);

comment on column public.markets.cadence_tier is
  'How often this market is priced. Assigned by discover-markets from the '
  'selection thresholds on the stable model version.';

-- --------------------------------------------------------------------------
-- Universe membership, point-in-time
--
-- A backtest cannot be honest about what the platform could have seen without
-- knowing which markets were in the priced universe at that moment, and why.
-- Rows are append-only: a market leaving a tier closes its row rather than
-- deleting it (section 11e — never restate history).
-- --------------------------------------------------------------------------
create table public.universe_membership (
  id          bigserial primary key,
  market_id   text not null references public.markets(id) on delete cascade,
  tier        public.cadence_tier not null,
  family      public.market_family not null,
  /** Why the tier was assigned — horizon, liquidity, cap, category. */
  reason      text not null,
  /** Rank at entry, for auditing how the cap was applied. */
  rank_score  numeric(8,3),
  entered_at  timestamptz not null default now(),
  /** Null while current. Set when the market leaves this tier. */
  left_at     timestamptz
);

create index universe_membership_market_idx
  on public.universe_membership (market_id, entered_at desc);
create index universe_membership_current_idx
  on public.universe_membership (tier) where left_at is null;

-- One open row per market at a time.
create unique index universe_membership_open_idx
  on public.universe_membership (market_id) where left_at is null;

alter table public.universe_membership enable row level security;

create policy universe_membership_select on public.universe_membership
  for select to authenticated using (true);

revoke all on public.universe_membership from anon;

-- --------------------------------------------------------------------------
-- Selection tunables (section 7: every knob lives on the model version).
--
-- Deliberately NOT hardcoded in the discovery function. Which markets the
-- platform looks at is a modelling decision — it determines what can ever be
-- scored, surfaced or traded — so it is versioned, backtestable and
-- comparable like any other.
-- --------------------------------------------------------------------------
update public.model_versions
   set thresholds = thresholds || jsonb_build_object(
     'selection', jsonb_build_object(
       -- Horizon boundaries between cadence tiers, in days.
       'fastHorizonDays',   14,
       'slowHorizonDays',   365,
       -- Book quality required for the fast tier.
       'maxSpreadCents',    12,
       'requireTwoSidedBook', true,
       -- Hard caps on how many markets each tier prices. Fast tier is the
       -- expensive one: 5-minute cadence against Kalshi.
       'fastCap',           800,
       'slowCap',           2500,
       'archiveCap',        5000,
       -- Ranking within a cap: liquidity, plus a boost for categories where
       -- an external anchor exists, since those can be scored on more than
       -- price movement.
       'anchorableCategories', jsonb_build_array('Weather', 'Economics'),
       'anchorRankBoost',   0.25,
       -- Legs required before a mutually-exclusive event counts as
       -- multi_stage rather than a plain binary pair.
       'multiStageMinLegs', 3
     ))
 where version_label in ('v1', 'v1.1')
   and not (thresholds ? 'selection');
