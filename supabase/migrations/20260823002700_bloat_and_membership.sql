-- ===========================================================================
-- Bloat control and membership compaction.
--
-- Measured at the size limit (546 MB):
--   markets              175 MB   for 284k rows -- bloat. Discovery upserts
--                                 ~120k rows every 40 minutes; each update
--                                 leaves a dead tuple and autovacuum's
--                                 defaults (20% of the table must be dead
--                                 before it runs) lose the race.
--   universe_membership  127 MB   debris from the tier-churn bug: every sweep
--                                 re-tiered 100k+ markets and logged each
--                                 transition. Rows for the 'excluded' tier
--                                 are ~95% of it and carry no backtest value:
--                                 a backtest asks what was PRICED and when,
--                                 and excluded means "was not".
--
-- Two changes here; the third (VACUUM FULL) is manual, see README.
-- ===========================================================================

-- Autovacuum: run early and often on the tables that churn. Scale factor 0
-- plus a fixed threshold means "after N dead rows", not "after 20% of the
-- table is dead" -- on a 284k-row table the default waits for 57k corpses.
alter table public.markets set (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold    = 5000,
  autovacuum_analyze_scale_factor = 0.02
);
alter table public.market_snapshots set (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold    = 20000
);
alter table public.scores set (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold    = 20000
);
alter table public.universe_membership set (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold    = 20000
);

-- Membership compaction, folded into the six-hourly prune. Closed rows for
-- the 'excluded' tier are dropped once they are a day old; every row for a
-- priced tier (fast, slow, archive) is kept forever, open or closed. That is
-- the point-in-time record a backtest actually needs.
create or replace function public.compact_universe_membership()
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '600s'
as $fn$
declare n integer;
begin
  delete from public.universe_membership
   where tier = 'excluded'
     and left_at is not null
     and left_at < now() - interval '1 day';
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- One-time: clear the churn-era debris now rather than waiting a day.
select public.compact_universe_membership();

-- Chain it into the prune so it runs every six hours with the rest.
create or replace function public.prune_all()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare a integer; b integer;
begin
  a := public.rollup_and_prune_snapshots();
  b := public.compact_universe_membership();
  return jsonb_build_object('snapshots', a, 'membership', b);
end;
$fn$;

select cron.schedule(
  'oe-prune-snapshots', '30 */6 * * *',
  $cron$ select public.prune_all(); $cron$
);
