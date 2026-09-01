-- ===========================================================================
-- Tiered ingestion schedules.
--
-- Replaces the single 5-minute "ingest everything we happen to have" job with
-- the discovery/pricing split:
--
--   discover-markets   hourly   pages the whole book, assigns cadence tiers,
--                               records point-in-time universe membership
--   ingest fast        5 min    near-dated, two-sided book
--   ingest slow        hourly   long-dated but still tracked
--   ingest archive     daily    very long-dated; history only
--
-- Pricing is now exact-set (?tickers=), so the fast tier costs ~6 requests per
-- pass instead of the ~60 a full sweep took. Measured against the live API:
-- 200 tickers in one 5KB URL, 149ms.
-- ===========================================================================

-- The old job priced whatever markets existed, in no particular order. Drop it
-- by name rather than by id, and tolerate it already being gone so this
-- migration is safe to re-run.
do $$
begin
  perform cron.unschedule('oe-ingest-markets');
exception when others then
  null;
end;
$$;

-- --------------------------------------------------------------------------
-- Discovery
--
-- Hourly. A full 60-page pass measured ~11s against Kalshi at 3.8 req/s with
-- zero throttling, so the cost is trivial; the reason not to run it more often
-- is that tier assignment should be stable enough for price history to mean
-- something, not that the pass is expensive.
--
-- Offset to :40 so it lands between the hourly slow-tier pricing and the top
-- of the next hour.
-- --------------------------------------------------------------------------
select cron.schedule(
  'oe-discover-markets', '40 * * * *',
  $$ select public.invoke_edge_function('discover-markets'); $$
);

-- --------------------------------------------------------------------------
-- Pricing, per tier
-- --------------------------------------------------------------------------

-- Fast: the markets that can actually move within a member's decision window.
select cron.schedule(
  'oe-ingest-fast', '*/5 * * * *',
  $$ select public.invoke_edge_function('ingest-markets', '{"tier":"fast"}'::jsonb); $$
);

-- Slow: hourly. These are the tail-entry candidates — tournament outrights,
-- election longs, multi-stage events. Priced rarely, but priced, so that when
-- one of them becomes interesting there is history behind it rather than a
-- cold start.
select cron.schedule(
  'oe-ingest-slow', '10 * * * *',
  $$ select public.invoke_edge_function('ingest-markets', '{"tier":"slow"}'::jsonb); $$
);

-- Archive: daily, 08:25 UTC — before the snapshot prune at 09:30 so the day's
-- point lands inside the window that gets rolled up.
select cron.schedule(
  'oe-ingest-archive', '25 8 * * *',
  $$ select public.invoke_edge_function('ingest-markets', '{"tier":"archive"}'::jsonb); $$
);
