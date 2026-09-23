-- ===========================================================================
-- Crypto price anchors (second anchor source), and grading by source.
--
-- The first fitted-weights report and the band-by-band calibration read
-- (2026-09-22/23) agree: micro and base carry no edge net of fees against
-- Kalshi's prices. Edge has to come from information the price does not
-- already hold, which is what anchors are. Kalshi's daily BTC/ETH markets
-- settle on a continuous index at a fixed time, so a fair probability per
-- strike follows from spot, time to settlement, and realised volatility.
-- fetch-anchors {source: crypto} computes it every five minutes from
-- Coinbase's public API and writes market_anchors like the weather source.
--
-- The anchor tables were sized for degrees Fahrenheit. Dollars need wider
-- columns. And the calibration views now grade each source separately: a
-- good crypto anchor must not hide a bad weather one, or the reverse.
-- ===========================================================================

alter table public.market_anchors
  alter column floor_strike type numeric(14,2),
  alter column cap_strike   type numeric(14,2),
  alter column forecast_f   type numeric(14,2),
  alter column sigma_f      type numeric(14,2);

alter table public.anchor_history
  alter column forecast_f type numeric(14,2),
  alter column sigma_f    type numeric(14,2);

comment on column public.market_anchors.forecast_f is
  'The source''s central value: NWS forecast in degrees F for temperature, Coinbase spot in dollars for price.';
comment on column public.market_anchors.sigma_f is
  'Assumed sd of the settlement value around forecast_f, same units as forecast_f.';

-- Tunables on the version (section 7). Absent keys fall back to the same
-- defaults in code; present keys are what a person can change.
update public.model_versions
   set thresholds = jsonb_set(thresholds, '{anchors,crypto}', jsonb_build_object(
     'enabled', true,
     'lookbackHours', 24,
     'volFloorAnnual', 0.3,
     'minLeadMinutes', 2,
     'historyDeltaProb', 0.02
   ))
 where thresholds ? 'anchors'
   and not (thresholds->'anchors' ? 'crypto');

-- Grading, by source. `source` is appended so CREATE OR REPLACE is legal.
create or replace view public.anchor_calibration
with (security_invoker = true) as
with rows as (
  select
    t.market_id,
    coalesce(t.payload->>'anchor_source', 'nws')          as source,
    (t.payload->>'anchor_prob')::numeric                  as p_anchor,
    (t.payload->>'yesPrice')::numeric / 100.0              as p_market,
    case when (t.payload->>'resolved_outcome') = 'YES' then 1 else 0 end as y
  from public.edge_theses t
  where t.payload ? 'final_state'
    and t.payload ? 'anchor_prob'
    and t.payload ? 'yesPrice'
    and t.payload ? 'resolved_outcome'
)
select
  width_bucket(p_anchor, 0, 1, 10)                       as bucket,
  count(*)                                               as n,
  round(avg(p_anchor), 3)                                as anchor_mean,
  round(avg(p_market), 3)                                as market_mean,
  round(avg(y)::numeric, 3)                              as observed_yes,
  round(avg((p_anchor - y) ^ 2), 4)                      as anchor_brier,
  round(avg((p_market - y) ^ 2), 4)                      as market_brier,
  source
from rows
group by source, 1
order by source, 1;

create or replace view public.anchor_summary
with (security_invoker = true) as
select
  count(*)                                              as n,
  round(avg(((t.payload->>'anchor_prob')::numeric - (case when t.payload->>'resolved_outcome' = 'YES' then 1 else 0 end)) ^ 2), 4) as anchor_brier,
  round(avg(((t.payload->>'yesPrice')::numeric / 100.0 - (case when t.payload->>'resolved_outcome' = 'YES' then 1 else 0 end)) ^ 2), 4) as market_brier,
  coalesce(t.payload->>'anchor_source', 'nws')          as source
from public.edge_theses t
where t.payload ? 'final_state' and t.payload ? 'anchor_prob' and t.payload ? 'yesPrice' and t.payload ? 'resolved_outcome'
group by 4;

-- Every five minutes, offset from ingest (*/5), scoring (1-56/5), news (3-58/5).
select cron.schedule(
  'oe-fetch-crypto-anchors', '4-59/5 * * * *',
  $cron$ select public.invoke_edge_function('fetch-anchors', '{"source":"crypto"}'::jsonb); $cron$
);
