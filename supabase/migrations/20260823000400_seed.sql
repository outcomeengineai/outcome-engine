-- ===========================================================================
-- Baseline configuration. Idempotent: safe to re-run against an existing DB.
-- ===========================================================================

insert into public.platform_settings (key, value) values
  -- THE fee rate. Read from here, never hardcoded in application code.
  ('fee_rate',                  '0.20'::jsonb),
  ('inactivity_threshold_days', '30'::jsonb),
  ('grace_period_days',         '7'::jsonb),
  ('transition_window_days',    '14'::jsonb),

  -- Emergency controls. trading_paused blocks new LIVE orders; kill_switch
  -- blocks all platform trading. Neither closes an existing position.
  ('trading_paused',            'false'::jsonb),
  ('kill_switch',               'false'::jsonb),

  -- Signal health auto-disable rules.
  ('signal_window_size',        '100'::jsonb),
  ('signal_min_win_rate',       '0.48'::jsonb),
  ('signal_accuracy_drop_pct',  '0.10'::jsonb),
  ('signal_cooldown_hours',     '24'::jsonb),
  ('signal_min_sample',         '25'::jsonb),

  -- Ingestion + retention.
  ('snapshot_retention_days',   '30'::jsonb),
  ('ingest_max_markets',        '400'::jsonb),

  -- Platform-wide risk.
  ('daily_loss_limit_cents',    '50000'::jsonb),
  ('max_exposure_per_market_cents', '100000'::jsonb),
  ('locked_categories',         '[]'::jsonb)
on conflict (key) do nothing;

-- --------------------------------------------------------------------------
-- Model v1.
--
-- Microstructure is heaviest because it is the only signal with a real-time,
-- market-priced input. News is moderate: it confirms direction but is noisy.
-- Base rate stays light until there is enough resolved history for the
-- per-category win rates to mean anything — raise it on a later retune, do
-- not raise it now on faith.
-- --------------------------------------------------------------------------
insert into public.model_versions
  (version_label, status, weights, thresholds, risk_limits, notes, published_at)
values (
  'v1',
  'stable',
  jsonb_build_object(
    'default', jsonb_build_object('micro', 0.60, 'news', 0.28, 'base', 0.12),
    'overrides', jsonb_build_object(
      -- Weather resolves on measurable outcomes and has almost no useful news
      -- flow, so it leans harder on price action and its own track record.
      'Weather', jsonb_build_object('micro', 0.70, 'news', 0.08, 'base', 0.22)
    )
  ),
  jsonb_build_object(
    'strongPick', 7.0,
    'surface', 5.0,
    'autoTags', jsonb_build_object(
      'volumeAnomaly', true,
      'lowLiquidity', true,
      'sentimentDivergence', true
    )
  ),
  jsonb_build_object(
    'dailyLossLimitCents', 50000,
    'maxTradesPerDay', 10,
    'cooldownAfterLossMinutes', 30,
    'maxExposurePerMarketCents', 100000,
    'lockedCategories', jsonb_build_array()
  ),
  'Initial model. Microstructure-led; base rate deliberately light until resolved history accumulates.',
  now()
)
on conflict (version_label) do nothing;

-- --------------------------------------------------------------------------
-- Signal health starts healthy with no samples. The monitor fills these in
-- once trades begin resolving.
-- --------------------------------------------------------------------------
insert into public.signal_health (signal, window_size, sample_count, status)
values
  ('micro', 100, 0, 'healthy'),
  ('news',  100, 0, 'healthy'),
  ('base',  100, 0, 'healthy')
on conflict (signal) do nothing;
