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
