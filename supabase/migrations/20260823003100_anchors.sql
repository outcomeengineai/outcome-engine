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
