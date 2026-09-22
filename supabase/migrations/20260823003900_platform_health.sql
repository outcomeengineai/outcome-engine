-- ===========================================================================
-- Platform health: the cron log and storage, readable from the dashboard and
-- checked by the hourly signal-health job.
--
-- pg_cron records every run in cron.job_run_details. Nobody read it for a
-- week while the prune job failed on every run, and the database tripled.
-- The log was right there; the platform never looked. Now it does:
--
--   cron_health()     one row per job: last run, its status and message,
--                     runs and failures in 24h, and how many failures in a
--                     row sit at the head of its history. Two in a row is
--                     the alert bar -- a single "job startup timeout" is
--                     weather, not a fault.
--   storage_health()  database size, the ten largest tables with live and
--                     dead tuples, the oldest snapshot and score (retention
--                     made visible), the last prune, and the alert line.
--
-- Both are security definer because cron.* and pg_stat_* need it, and both
-- refuse a signed-in non-admin. The service role (no auth.uid) passes, which
-- is how the hourly job reads them.
-- ===========================================================================

insert into public.platform_settings (key, value)
values ('storage_alert_mb', '1500'::jsonb)
on conflict (key) do nothing;

create or replace function public.cron_health()
returns table (
  jobname               text,
  schedule              text,
  active                boolean,
  last_run              timestamptz,
  last_status           text,
  last_message          text,
  runs_24h              bigint,
  failures_24h          bigint,
  consecutive_failures  integer
)
language plpgsql
stable
security definer
set search_path = public, cron
as $fn$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'admin only';
  end if;

  return query
  with runs as (
    select d.jobid, d.status, d.end_time, d.return_message,
           row_number() over (partition by d.jobid order by d.end_time desc nulls last) as rn
      from cron.job_run_details d
     where d.status in ('succeeded', 'failed')
  ),
  head_failures as (
    -- Failures newer than the most recent success, per job.
    select r.jobid, count(*)::integer as n
      from runs r
     where r.status = 'failed'
       and r.rn < coalesce(
             (select min(s.rn) from runs s where s.jobid = r.jobid and s.status = 'succeeded'),
             2147483647)
     group by r.jobid
  )
  select j.jobname::text,
         j.schedule::text,
         j.active,
         l.end_time,
         l.status::text,
         left(l.return_message, 200),
         (select count(*) from runs r where r.jobid = j.jobid and r.end_time > now() - interval '24 hours'),
         (select count(*) from runs r where r.jobid = j.jobid and r.status = 'failed' and r.end_time > now() - interval '24 hours'),
         coalesce(h.n, 0)
    from cron.job j
    left join runs l on l.jobid = j.jobid and l.rn = 1
    left join head_failures h on h.jobid = j.jobid
   order by coalesce(h.n, 0) desc, j.jobname;
end;
$fn$;

revoke execute on function public.cron_health() from public;
grant execute on function public.cron_health() to authenticated, service_role;

create or replace function public.storage_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'admin only';
  end if;

  return jsonb_build_object(
    'db_size_mb', round(pg_database_size(current_database()) / 1048576.0),
    'alert_mb', public.setting_numeric('storage_alert_mb', 1500),
    'tables', (
      select jsonb_agg(jsonb_build_object(
               'name', t.relname, 'mb', t.mb, 'live', t.n_live_tup, 'dead', t.n_dead_tup,
               'last_autovacuum', t.last_autovacuum) order by t.mb desc)
        from (select relname,
                     round(pg_total_relation_size(relid) / 1048576.0, 1) as mb,
                     n_live_tup, n_dead_tup, last_autovacuum
                from pg_stat_user_tables
               where schemaname = 'public'
               order by pg_total_relation_size(relid) desc
               limit 10) t),
    'snapshots_oldest', (select min(ts) from public.market_snapshots),
    'scores_oldest',    (select min(ts) from public.scores),
    'last_prune', (
      select jsonb_build_object('ts', a.ts, 'detail', a.detail)
        from public.activity_log a
       where a.event_type = 'maintenance.pruned'
       order by a.ts desc
       limit 1)
  );
end;
$fn$;

revoke execute on function public.storage_health() from public;
grant execute on function public.storage_health() to authenticated, service_role;
