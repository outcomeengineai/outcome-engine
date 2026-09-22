-- ===========================================================================
-- The dead-market prune timed out at 50k rows per run (2026-09-22), and the
-- one-off cleanup job's long deletes starved discovery of the markets table
-- (upsert statement timeouts). Cause: market_latest_scores references
-- markets ON DELETE CASCADE, but its primary key is (model_version_id,
-- market_id), so the cascade could not use it and scanned the table once
-- per deleted market. Index it, and take smaller bites per run.
-- ===========================================================================

create index if not exists market_latest_scores_market_idx
  on public.market_latest_scores (market_id);

create or replace function public.prune_dead_markets(p_limit integer default 20000)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare n integer;
begin
  delete from public.markets m
   where m.id in (
     select m2.id
       from public.markets m2
      where m2.cadence_tier = 'excluded'
        and (m2.status in ('finalized', 'settled', 'closed')
             or coalesce(m2.disc_seen_at, m2.first_seen_at) < now() - interval '7 days')
        and not exists (select 1 from public.market_snapshots       s where s.market_id = m2.id)
        and not exists (select 1 from public.market_snapshots_daily d where d.market_id = m2.id)
        and not exists (select 1 from public.edge_theses            t where t.market_id = m2.id)
        and not exists (select 1 from public.scores                 c where c.market_id = m2.id)
        and not exists (select 1 from public.trades                 r where r.market_id = m2.id)
      limit p_limit
   );
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- The owner's temporary catch-up job, if it is still scheduled: every ten
-- minutes is enough once each run is short, and leaves room for discovery.
select cron.alter_job(jobid, schedule => '*/10 * * * *')
  from cron.job where jobname = 'oe-cleanup-once';
