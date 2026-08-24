-- ===========================================================================
-- Scheduled jobs.
--
-- pg_cron calls the Edge Functions over HTTP via pg_net. Two secrets have to
-- exist in Vault before these jobs will work — create them once per project:
--
--   select vault.create_secret('https://YOURPROJECT.supabase.co', 'project_url');
--   select vault.create_secret('<service-role-key>',              'service_role_key');
--   select vault.create_secret('<random-string>',                 'cron_secret');
--
-- The functions reject any request whose x-cron-secret header does not match,
-- so a leaked function URL is not by itself an invocation.
-- ===========================================================================

create extension if not exists pg_cron  with schema extensions;
create extension if not exists pg_net   with schema extensions;

create or replace function public.invoke_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url  text;
  v_key  text;
  v_cron text;
  v_id   bigint;
begin
  select decrypted_secret into v_url  from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key  from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into v_cron from vault.decrypted_secrets where name = 'cron_secret';

  if v_url is null or v_key is null then
    raise exception 'invoke_edge_function: project_url / service_role_key not present in Vault';
  end if;

  select net.http_post(
    url     := v_url || '/functions/v1/' || p_name,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'Authorization',  'Bearer ' || v_key,
      'x-cron-secret',  coalesce(v_cron, '')
    ),
    body    := p_body,
    timeout_milliseconds := 120000
  ) into v_id;

  return v_id;
end;
$$;

-- --------------------------------------------------------------------------
-- Schedules
-- --------------------------------------------------------------------------

-- Ingestion drives everything downstream, so it runs first and often. Five
-- minutes is comfortably inside Kalshi's rate limits for a few hundred
-- markets polled per-market rather than per-user.
select cron.schedule(
  'oe-ingest-markets', '*/5 * * * *',
  $$ select public.invoke_edge_function('ingest-markets'); $$
);

-- Scoring runs a minute behind ingestion so it reads fresh snapshots.
select cron.schedule(
  'oe-score-markets', '1-56/5 * * * *',
  $$ select public.invoke_edge_function('score-markets'); $$
);

-- Resolution sync: hourly is plenty; Kalshi settlement is not instantaneous.
select cron.schedule(
  'oe-sync-resolutions', '7 * * * *',
  $$ select public.invoke_edge_function('sync-resolutions'); $$
);

-- Signal health recomputes after resolutions have landed.
select cron.schedule(
  'oe-signal-health', '20 * * * *',
  $$ select public.invoke_edge_function('signal-health'); $$
);

-- Push/notification drain.
select cron.schedule(
  'oe-send-notifications', '*/2 * * * *',
  $$ select public.invoke_edge_function('send-notifications'); $$
);

-- Daily housekeeping, 09:10 UTC.
select cron.schedule(
  'oe-flag-inactive', '10 9 * * *',
  $$ select public.flag_inactive_accounts(); $$
);

select cron.schedule(
  'oe-deprecate-versions', '15 9 * * *',
  $$ select public.deprecate_expired_versions(); $$
);

select cron.schedule(
  'oe-prune-snapshots', '30 9 * * *',
  $$ select public.rollup_and_prune_snapshots(); $$
);

-- Billing: 02:00 UTC on the 1st, closing the month that just ended.
--
-- Leave this schedule UNSET until a full cycle has been reconciled by hand.
-- Verify the math on real data first, then enable:
--   select cron.schedule('oe-run-billing', '0 2 1 * *',
--     $$ select public.invoke_edge_function('run-billing'); $$);

-- Grace-period escalation runs daily regardless; it only acts on periods that
-- are already past their grace window.
select cron.schedule(
  'oe-billing-grace', '0 10 * * *',
  $$ select public.invoke_edge_function('run-billing', '{"mode":"grace_only"}'::jsonb); $$
);
