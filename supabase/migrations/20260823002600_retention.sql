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
