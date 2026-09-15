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
