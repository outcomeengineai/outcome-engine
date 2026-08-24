-- ===========================================================================
-- Row Level Security
--
-- Model:
--   member  -> reads and writes ONLY rows keyed to their own auth.uid()
--   admin   -> reads everything, writes the platform-level tables
--   service -> the Edge Functions; bypasses RLS by virtue of the service role
--
-- Anything a member must not be able to forge (trades, scores, billing totals,
-- resolutions) has NO member-facing insert/update policy at all. Those writes
-- go through an Edge Function so validation cannot be skipped by talking to
-- PostgREST directly.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Role helper. SECURITY DEFINER so it can read public.users without being
-- re-filtered by the very policies that call it (which would recurse).
-- --------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
     where id = auth.uid()
       and role = 'admin'
       and account_status <> 'removed'
  );
$$;

revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Members lose the ability to act (not to look) when paused, in grace, or
-- removed. Used by the few member-writable tables.
create or replace function public.can_act()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
     where id = auth.uid()
       and account_status in ('active', 'inactive')
  );
$$;

revoke execute on function public.can_act() from public;
grant execute on function public.can_act() to authenticated;

-- The caller's own privileged columns, read WITHOUT re-entering RLS.
--
-- These exist because a policy on public.users cannot contain a subquery
-- against public.users: evaluating the subquery re-triggers the same policy
-- and Postgres raises 42P17 (infinite recursion). SECURITY DEFINER reads the
-- row as the function owner, which breaks the cycle.
create or replace function public.caller_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid();
$$;

create or replace function public.caller_account_status()
returns public.account_status
language sql
stable
security definer
set search_path = public
as $$
  select account_status from public.users where id = auth.uid();
$$;

revoke execute on function public.caller_role() from public;
revoke execute on function public.caller_account_status() from public;
grant execute on function public.caller_role() to authenticated;
grant execute on function public.caller_account_status() to authenticated;

-- --------------------------------------------------------------------------
alter table public.users                  enable row level security;
alter table public.invites                enable row level security;
alter table public.kalshi_connections     enable row level security;
alter table public.payment_methods        enable row level security;
alter table public.devices                enable row level security;
alter table public.model_versions         enable row level security;
alter table public.markets                enable row level security;
alter table public.market_snapshots       enable row level security;
alter table public.market_snapshots_daily enable row level security;
alter table public.scores                 enable row level security;
alter table public.trades                 enable row level security;
alter table public.trade_resolutions      enable row level security;
alter table public.tags                   enable row level security;
alter table public.billing_periods        enable row level security;
alter table public.payments               enable row level security;
alter table public.notifications          enable row level security;
alter table public.signal_health          enable row level security;
alter table public.signal_health_history  enable row level security;
alter table public.platform_settings      enable row level security;
alter table public.activity_log           enable row level security;
alter table public.backtest_runs          enable row level security;

-- --------------------------------------------------------------------------
-- users
-- --------------------------------------------------------------------------
create policy users_select_self on public.users
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- A member may edit their display name and their pinned model version.
-- role and account_status are NOT member-editable; the check pins them to
-- their current values so an UPDATE cannot escalate.
--
-- The comparison goes through caller_role() / caller_account_status() rather
-- than an inline subquery: a subquery on public.users inside a policy ON
-- public.users recurses (42P17).
create policy users_update_self on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = public.caller_role()
    and account_status = public.caller_account_status()
  );

create policy users_admin_update on public.users
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --------------------------------------------------------------------------
-- invites — admins manage them. Redemption happens in an Edge Function
-- (service role), because an unauthenticated caller must be able to validate
-- a code before an account exists.
-- --------------------------------------------------------------------------
create policy invites_admin_all on public.invites
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --------------------------------------------------------------------------
-- kalshi_connections — a member may see the STATUS of their connection and
-- delete it (disconnect). They may never insert or update it directly: the
-- connect flow posts the key to an Edge Function, which is the only thing
-- that ever touches Vault.
--
-- Note vault_secret_ref is in this table but the key is not; the ref is
-- useless without service-role access to vault.decrypted_secrets.
-- --------------------------------------------------------------------------
create policy kalshi_select_self on public.kalshi_connections
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy kalshi_delete_self on public.kalshi_connections
  for delete to authenticated
  using (user_id = auth.uid());

-- --------------------------------------------------------------------------
-- payment_methods — readable by owner; written by the Stripe webhook.
-- --------------------------------------------------------------------------
create policy payment_methods_select_self on public.payment_methods
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy payment_methods_delete_self on public.payment_methods
  for delete to authenticated
  using (user_id = auth.uid());

-- --------------------------------------------------------------------------
-- devices — the app registers its own push token.
-- --------------------------------------------------------------------------
create policy devices_all_self on public.devices
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --------------------------------------------------------------------------
-- model_versions — everyone reads published versions (a member needs the
-- thresholds to render); only admins see drafts and only admins write.
-- --------------------------------------------------------------------------
create policy model_versions_select on public.model_versions
  for select to authenticated
  using (status in ('stable', 'deprecated') or public.is_admin());

create policy model_versions_admin_write on public.model_versions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --------------------------------------------------------------------------
-- Shared market data — readable by any signed-in user, written by ingestion.
-- --------------------------------------------------------------------------
create policy markets_select on public.markets
  for select to authenticated using (true);

create policy market_snapshots_select on public.market_snapshots
  for select to authenticated using (true);

create policy market_snapshots_daily_select on public.market_snapshots_daily
  for select to authenticated using (true);

-- Scores from deprecated versions stay readable so historical trades can still
-- show the score they were opened on.
create policy scores_select on public.scores
  for select to authenticated using (true);

-- --------------------------------------------------------------------------
-- trades — read your own. No member INSERT/UPDATE policy on purpose: every
-- trade is created by the execute-trade function after it has checked the
-- kill switch, pause flag, account status, risk limits and Kalshi balance.
-- --------------------------------------------------------------------------
create policy trades_select_self on public.trades
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy trade_resolutions_select_self on public.trade_resolutions
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.trades t
       where t.id = trade_resolutions.trade_id
         and t.user_id = auth.uid()
    )
  );

-- --------------------------------------------------------------------------
-- tags — market tags are public to members; trade tags follow the trade.
-- Only admins write tags manually (the Tag review screen).
-- --------------------------------------------------------------------------
create policy tags_select on public.tags
  for select to authenticated
  using (
    public.is_admin()
    or market_id is not null
    or exists (
      select 1 from public.trades t
       where t.id = tags.trade_id
         and t.user_id = auth.uid()
    )
  );

create policy tags_admin_write on public.tags
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --------------------------------------------------------------------------
-- billing — members read their own; nobody but the billing job writes.
-- --------------------------------------------------------------------------
create policy billing_periods_select_self on public.billing_periods
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy payments_select_self on public.payments
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.billing_periods b
       where b.id = payments.billing_period_id
         and b.user_id = auth.uid()
    )
  );

-- --------------------------------------------------------------------------
-- notifications — read your own, and mark them read.
-- --------------------------------------------------------------------------
create policy notifications_select_self on public.notifications
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy notifications_update_self on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --------------------------------------------------------------------------
-- signal_health — members see it (it explains why a signal vanished from a
-- breakdown); admins configure it via Edge Functions.
-- --------------------------------------------------------------------------
create policy signal_health_select on public.signal_health
  for select to authenticated using (true);

create policy signal_health_history_select on public.signal_health_history
  for select to authenticated using (true);

-- --------------------------------------------------------------------------
-- platform_settings — readable by all (the clients need fee_rate and the
-- pause flags); writable by admins only.
-- --------------------------------------------------------------------------
create policy platform_settings_select on public.platform_settings
  for select to authenticated using (true);

create policy platform_settings_admin_write on public.platform_settings
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --------------------------------------------------------------------------
-- activity_log — members see only their own events; admins see the full log.
-- Writes come from the functions.
-- --------------------------------------------------------------------------
create policy activity_log_select_self on public.activity_log
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- --------------------------------------------------------------------------
-- backtest_runs — admin only, top to bottom.
-- --------------------------------------------------------------------------
create policy backtest_runs_admin_all on public.backtest_runs
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --------------------------------------------------------------------------
-- Belt and braces: no anonymous access to anything in public.
-- --------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
