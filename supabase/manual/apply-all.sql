-- =========================================================================
-- GENERATED — do not edit. Rebuild: npm run build:manual-sql
--
-- Every migration except the pg_cron one, concatenated in order and wrapped
-- in a single transaction. Paste the whole thing into the Supabase SQL
-- editor and Run. It is all-or-nothing: if any statement fails, nothing is
-- applied and you can fix and re-run from a clean slate.
--
-- FOR A FRESH DATABASE. Every statement assumes nothing exists yet, so
-- re-running this against a populated database fails on the first CREATE.
-- To apply a single later migration, run that file on its own instead.
--
-- Run apply-cron.sql afterwards, once the Vault secrets exist.
-- =========================================================================

begin;


-- ===== 20260823000100_init.sql =====================================

-- ===========================================================================
-- Outcome Engine — core schema
--
-- Unit discipline: every money/PnL column is INTEGER CENTS (bigint).
-- Contract prices are whole cents 1..99 (smallint). No floats for money.
-- ===========================================================================

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "supabase_vault" with schema vault;

-- --------------------------------------------------------------------------
-- Enums
-- --------------------------------------------------------------------------
create type public.user_role          as enum ('admin', 'member');
create type public.account_status     as enum ('active', 'grace', 'paused', 'inactive', 'removed');
create type public.connection_status  as enum ('connected', 'error', 'revoked');
create type public.model_status       as enum ('draft', 'stable', 'deprecated');
create type public.trade_mode         as enum ('paper', 'live');
create type public.market_side        as enum ('YES', 'NO');
create type public.trade_status       as enum ('pending', 'open', 'resolved', 'failed');
create type public.trade_outcome      as enum ('win', 'loss');
create type public.tag_severity       as enum ('info', 'caution');
create type public.tag_source         as enum ('auto', 'manual');
create type public.signal_key         as enum ('micro', 'news', 'base');
create type public.signal_status      as enum ('healthy', 'degraded', 'disabled');
create type public.billing_status     as enum ('open', 'invoiced', 'paid', 'failed', 'grace', 'waived');
create type public.payment_method_kind as enum ('stripe', 'manual');

-- --------------------------------------------------------------------------
-- users — profile row mirroring auth.users, carrying role and status
-- --------------------------------------------------------------------------
create table public.users (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text not null,
  display_name      text,
  role              public.user_role not null default 'member',
  account_status    public.account_status not null default 'active',
  last_trade_at     timestamptz,
  -- During a model transition window a member may pin the previous stable
  -- version. Null means "whatever is stable right now".
  preferred_model_version_id uuid,
  agreed_at         timestamptz,
  onboarded_at      timestamptz,
  created_at        timestamptz not null default now()
);

create index users_role_idx on public.users (role);
create index users_status_idx on public.users (account_status);

-- --------------------------------------------------------------------------
-- invites — there is no public signup; every account starts from a code
-- --------------------------------------------------------------------------
create table public.invites (
  code        text primary key,
  email       text,
  created_by  uuid references public.users(id) on delete set null,
  redeemed_by uuid references public.users(id) on delete set null,
  redeemed_at timestamptz,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index invites_email_idx on public.invites (lower(email));

-- --------------------------------------------------------------------------
-- kalshi_connections — the key itself lives in Vault; this row holds only a
-- reference to it. vault_secret_ref is a vault.secrets.id, never a key.
-- --------------------------------------------------------------------------
create table public.kalshi_connections (
  user_id          uuid primary key references public.users(id) on delete cascade,
  vault_secret_ref uuid not null,
  kalshi_key_id    text not null,
  kalshi_username  text,
  permission_scope text[] not null default array['trade'],
  status           public.connection_status not null default 'connected',
  last_error       text,
  last_verified_at timestamptz,
  connected_at     timestamptz not null default now()
);

comment on column public.kalshi_connections.vault_secret_ref is
  'vault.secrets.id holding the user''s Kalshi RSA private key. Service role only. Never returned to a client.';

-- --------------------------------------------------------------------------
-- payment_methods
-- --------------------------------------------------------------------------
create table public.payment_methods (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_pm_id       text not null,
  brand              text,
  last4              text,
  is_primary         boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (user_id, stripe_pm_id)
);

create unique index payment_methods_one_primary_idx
  on public.payment_methods (user_id) where is_primary;

-- --------------------------------------------------------------------------
-- devices — Expo push targets
-- --------------------------------------------------------------------------
create table public.devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  expo_push_token text not null,
  platform        text,
  last_seen_at    timestamptz not null default now(),
  unique (user_id, expo_push_token)
);

-- --------------------------------------------------------------------------
-- model_versions
-- --------------------------------------------------------------------------
create table public.model_versions (
  id                 uuid primary key default gen_random_uuid(),
  version_label      text not null unique,
  status             public.model_status not null default 'draft',
  weights            jsonb not null,
  thresholds         jsonb not null,
  risk_limits        jsonb not null,
  notes              text,
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  published_at       timestamptz,
  deprecated_at      timestamptz,
  -- While in the future, members may still pin this version after a newer
  -- one is published. Past it, the version auto-deprecates.
  transition_ends_at timestamptz
);

-- At most one version may be the current stable at a time. Older stables are
-- moved to 'deprecated' by the publish flow once their transition window ends.
create index model_versions_status_idx on public.model_versions (status, published_at desc);

alter table public.users
  add constraint users_preferred_model_fk
  foreign key (preferred_model_version_id)
  references public.model_versions(id) on delete set null;

-- --------------------------------------------------------------------------
-- markets
-- --------------------------------------------------------------------------
create table public.markets (
  id          text primary key,            -- Kalshi ticker
  event_ticker text,
  question    text not null,
  category    text not null default 'Other',
  close_time  timestamptz,
  status      text,
  resolved_at timestamptz,
  outcome     public.market_side,
  first_seen_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index markets_open_idx on public.markets (close_time) where resolved_at is null;
create index markets_category_idx on public.markets (category);

-- --------------------------------------------------------------------------
-- market_snapshots — time series. Raw rows pruned after
-- platform_settings.snapshot_retention_days, rolled up into daily aggregates.
-- --------------------------------------------------------------------------
create table public.market_snapshots (
  market_id     text not null references public.markets(id) on delete cascade,
  ts            timestamptz not null default now(),
  price         smallint not null check (price between 0 and 100),
  volume        bigint not null default 0,
  spread        smallint not null default 0,
  open_interest bigint not null default 0,
  liquidity     bigint not null default 0,
  primary key (market_id, ts)
);

create index market_snapshots_ts_idx on public.market_snapshots (ts);

create table public.market_snapshots_daily (
  market_id     text not null references public.markets(id) on delete cascade,
  day           date not null,
  open_price    smallint,
  close_price   smallint,
  high_price    smallint,
  low_price     smallint,
  avg_spread    numeric(6,2),
  volume        bigint,
  open_interest bigint,
  sample_count  integer,
  primary key (market_id, day)
);

-- --------------------------------------------------------------------------
-- scores
-- --------------------------------------------------------------------------
create table public.scores (
  id               uuid primary key default gen_random_uuid(),
  market_id        text not null references public.markets(id) on delete cascade,
  model_version_id uuid not null references public.model_versions(id),
  ts               timestamptz not null default now(),
  side             public.market_side not null,
  score            numeric(3,1) not null check (score >= 0 and score <= 10),
  breakdown        jsonb not null
);

create index scores_market_ts_idx on public.scores (market_id, ts desc);
create index scores_version_idx on public.scores (model_version_id, ts desc);

-- Fast "current score per market for a given model version".
create index scores_latest_idx on public.scores (model_version_id, market_id, ts desc);

-- --------------------------------------------------------------------------
-- trades
--
-- INVARIANT: model_version_id and entry_score are frozen at open time and are
-- never backfilled on retune. Together with trade_resolutions these rows are
-- the calibration dataset, so rewriting them would destroy the only honest
-- record of what the model actually said when the money went in.
-- --------------------------------------------------------------------------
create table public.trades (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  market_id        text not null references public.markets(id),
  model_version_id uuid not null references public.model_versions(id),
  mode             public.trade_mode not null,
  side             public.market_side not null,
  entry_price      smallint not null check (entry_price between 1 and 99),
  contracts        integer not null check (contracts > 0),
  entry_score      numeric(3,1) not null,
  stake_cents      bigint not null check (stake_cents >= 0),
  kalshi_order_id  text,
  status           public.trade_status not null default 'pending',
  failure_reason   text,
  opened_at        timestamptz not null default now(),
  confirmed_at     timestamptz
);

create index trades_user_idx on public.trades (user_id, opened_at desc);
create index trades_market_idx on public.trades (market_id);
create index trades_open_idx on public.trades (status) where status in ('pending', 'open');
create index trades_billing_idx on public.trades (user_id, mode, opened_at);

-- --------------------------------------------------------------------------
-- trade_resolutions
-- --------------------------------------------------------------------------
create table public.trade_resolutions (
  trade_id    uuid primary key references public.trades(id) on delete cascade,
  outcome     public.trade_outcome not null,
  pnl         bigint not null,   -- integer cents; negative for a loss
  settled_via text,              -- 'kalshi' | 'market_outcome' (paper)
  resolved_at timestamptz not null default now()
);

create index trade_resolutions_resolved_idx on public.trade_resolutions (resolved_at);

-- --------------------------------------------------------------------------
-- tags — market-level (pre-trade) OR trade-level; at least one FK set
-- --------------------------------------------------------------------------
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  market_id  text references public.markets(id) on delete cascade,
  trade_id   uuid references public.trades(id) on delete cascade,
  tag_type   text not null,
  severity   public.tag_severity not null default 'info',
  text       text not null,
  source     public.tag_source not null default 'auto',
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tags_target_present check (market_id is not null or trade_id is not null)
);

create index tags_market_idx on public.tags (market_id, created_at desc);
create index tags_trade_idx on public.tags (trade_id);

-- Auto tags are refreshed by DELETE-then-INSERT in the scoring pass rather than
-- upserted: a partial unique index cannot be inferred by an ON CONFLICT that
-- does not repeat its predicate, and re-inserting is also what lets a tag
-- DISAPPEAR when the condition that produced it no longer holds.
create index tags_auto_market_idx
  on public.tags (market_id, source) where market_id is not null;

-- --------------------------------------------------------------------------
-- billing_periods
-- --------------------------------------------------------------------------
create table public.billing_periods (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  period_start      timestamptz not null,
  period_end        timestamptz not null,
  gross_wins        bigint not null default 0,
  gross_losses      bigint not null default 0,
  net_pnl           bigint not null default 0,
  fee_owed          bigint not null default 0 check (fee_owed >= 0),
  fee_rate          numeric(5,4) not null,
  stripe_invoice_id text,
  status            public.billing_status not null default 'open',
  grace_until       timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  unique (user_id, period_start)
);

create index billing_periods_user_idx on public.billing_periods (user_id, period_start desc);
create index billing_periods_status_idx on public.billing_periods (status);

-- --------------------------------------------------------------------------
-- payments
-- --------------------------------------------------------------------------
create table public.payments (
  id                uuid primary key default gen_random_uuid(),
  billing_period_id uuid not null references public.billing_periods(id) on delete cascade,
  amount            bigint not null,
  method            public.payment_method_kind not null,
  status            text not null,
  note              text,
  paid_at           timestamptz,
  marked_by         uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index payments_period_idx on public.payments (billing_period_id);

-- --------------------------------------------------------------------------
-- notifications
-- --------------------------------------------------------------------------
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  read_at    timestamptz
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unsent_idx on public.notifications (created_at) where sent_at is null;

-- --------------------------------------------------------------------------
-- signal_health
-- --------------------------------------------------------------------------
create table public.signal_health (
  signal         public.signal_key primary key,
  window_size    integer not null,
  win_rate       numeric(5,4),
  sample_count   integer not null default 0,
  baseline_win_rate numeric(5,4),
  status         public.signal_status not null default 'healthy',
  disabled_until timestamptz,
  disabled_reason text,
  computed_at    timestamptz not null default now()
);

create table public.signal_health_history (
  id           bigserial primary key,
  signal       public.signal_key not null,
  win_rate     numeric(5,4),
  sample_count integer not null,
  status       public.signal_status not null,
  computed_at  timestamptz not null default now()
);

create index signal_health_history_idx on public.signal_health_history (signal, computed_at desc);

-- --------------------------------------------------------------------------
-- platform_settings — single-row-per-key config. Never hardcode these values.
-- --------------------------------------------------------------------------
create table public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- activity_log
-- --------------------------------------------------------------------------
create table public.activity_log (
  id         bigserial primary key,
  user_id    uuid references public.users(id) on delete set null,
  event_type text not null,
  detail     text,
  metadata   jsonb not null default '{}'::jsonb,
  ts         timestamptz not null default now()
);

create index activity_log_ts_idx on public.activity_log (ts desc);
create index activity_log_user_idx on public.activity_log (user_id, ts desc);
create index activity_log_type_idx on public.activity_log (event_type, ts desc);

-- --------------------------------------------------------------------------
-- backtest_runs — Simulate tab results
-- --------------------------------------------------------------------------
create table public.backtest_runs (
  id                uuid primary key default gen_random_uuid(),
  model_version_id  uuid not null references public.model_versions(id) on delete cascade,
  compare_version_id uuid references public.model_versions(id) on delete set null,
  range_start       timestamptz not null,
  range_end         timestamptz not null,
  status            text not null default 'running',
  simulated_pnl     bigint,
  max_drawdown      bigint,
  trade_count       integer,
  equity_curve      jsonb,
  compare_curve     jsonb,
  error             text,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);

-- --------------------------------------------------------------------------
-- Triggers
-- --------------------------------------------------------------------------

-- Create the profile row whenever an auth user appears. The very first user to
-- sign up becomes the admin; everyone after is a member.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_first boolean;
begin
  select count(*) = 0 into is_first from public.users;

  insert into public.users (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    case when is_first then 'admin'::public.user_role else 'member'::public.user_role end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Keep users.last_trade_at fresh; the inactivity job reads it.
create or replace function public.touch_last_trade_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users
     set last_trade_at = greatest(coalesce(last_trade_at, new.opened_at), new.opened_at)
   where id = new.user_id;
  return new;
end;
$$;

create trigger trades_touch_last_trade_at
  after insert on public.trades
  for each row execute function public.touch_last_trade_at();

-- A trade's model version and entry score are the calibration record. Block
-- any update to them at the database level rather than trusting callers.
create or replace function public.freeze_trade_provenance()
returns trigger
language plpgsql
as $$
begin
  -- The model version and the score it produced are frozen from the moment the
  -- trade exists. This is the invariant that keeps the calibration dataset
  -- honest: a retune must never rewrite what the model said at entry.
  if new.model_version_id is distinct from old.model_version_id
     or new.entry_score is distinct from old.entry_score
     or new.mode is distinct from old.mode then
    raise exception
      'trade % provenance is immutable (model_version_id, entry_score, mode)', old.id;
  end if;

  -- Fill details stay writable only while the trade is still pending, so the
  -- execution function can record what Kalshi ACTUALLY filled (a partial fill
  -- is fewer contracts than were asked for). Once open, they are fixed too.
  if old.status <> 'pending' then
    if new.side is distinct from old.side
       or new.entry_price is distinct from old.entry_price
       or new.contracts is distinct from old.contracts
       or new.stake_cents is distinct from old.stake_cents then
      raise exception
        'trade % fill details are immutable once it is no longer pending', old.id;
    end if;
  end if;

  return new;
end;
$$;

create trigger trades_freeze_provenance
  before update on public.trades
  for each row execute function public.freeze_trade_provenance();

create or replace function public.touch_markets_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger markets_touch_updated_at
  before update on public.markets
  for each row execute function public.touch_markets_updated_at();


-- ===== 20260823000200_rls.sql ======================================

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


-- ===== 20260823000300_functions.sql ================================

-- ===========================================================================
-- Server-side helpers: settings access, model-version resolution, billing
-- math, snapshot retention, and the views the clients actually read.
--
-- The fee formula lives in TWO places by necessity — here (so the monthly job
-- is one transaction) and in packages/shared/src/money.ts (so the stake card
-- can quote it). The shared-package tests and close_billing_period() below use
-- the same rule: 20% of max(0, net). If one changes, change both.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- platform_settings accessors
-- --------------------------------------------------------------------------
create or replace function public.setting(p_key text, p_default jsonb default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.platform_settings where key = p_key), p_default);
$$;

create or replace function public.setting_numeric(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::numeric from public.platform_settings where key = p_key), p_default);
$$;

create or replace function public.setting_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::boolean from public.platform_settings where key = p_key), p_default);
$$;

create or replace function public.fee_rate()
returns numeric
language sql
stable
as $$
  select public.setting_numeric('fee_rate', 0.20);
$$;

grant execute on function public.setting(text, jsonb) to authenticated;
grant execute on function public.setting_numeric(text, numeric) to authenticated;
grant execute on function public.setting_bool(text, boolean) to authenticated;
grant execute on function public.fee_rate() to authenticated;

-- --------------------------------------------------------------------------
-- Model version resolution
-- --------------------------------------------------------------------------

-- The version the scoring engine writes against: the most recently published
-- stable version.
create or replace function public.current_stable_version()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.model_versions
   where status = 'stable'
   order by published_at desc nulls last
   limit 1;
$$;

-- The version a given member's view is scored by. Honours a pinned preference
-- while that version's transition window is still open, then falls back to
-- current stable. This is why the transition window needs no separate job to
-- unpin people: an expired window simply stops being honoured.
create or replace function public.effective_version_for(p_user uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select mv.id
       from public.users u
       join public.model_versions mv on mv.id = u.preferred_model_version_id
      where u.id = p_user
        and mv.status in ('stable', 'deprecated')
        and mv.transition_ends_at is not null
        and mv.transition_ends_at > now()),
    public.current_stable_version()
  );
$$;

grant execute on function public.current_stable_version() to authenticated;
grant execute on function public.effective_version_for(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- Publishing a model version.
--
-- Publishing does not delete the old stable — it opens a transition window on
-- it. Members pinned to it keep their scores until the window closes, after
-- which effective_version_for() stops honouring the pin and deprecate_expired_
-- versions() marks it deprecated.
-- --------------------------------------------------------------------------
create or replace function public.publish_model_version(p_version uuid)
returns public.model_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_days integer;
  v_row public.model_versions;
begin
  if not public.is_admin() then
    raise exception 'only an admin may publish a model version';
  end if;

  v_window_days := public.setting_numeric('transition_window_days', 14)::integer;

  update public.model_versions
     set status = 'stable',
         transition_ends_at = now() + make_interval(days => v_window_days)
   where status = 'stable'
     and id <> p_version;

  update public.model_versions
     set status = 'stable',
         published_at = coalesce(published_at, now()),
         transition_ends_at = null
   where id = p_version
  returning * into v_row;

  if v_row.id is null then
    raise exception 'model version % not found', p_version;
  end if;

  insert into public.activity_log (user_id, event_type, detail, metadata)
  values (auth.uid(), 'model.published',
          format('Published %s', v_row.version_label),
          jsonb_build_object('model_version_id', v_row.id, 'label', v_row.version_label));

  return v_row;
end;
$$;

grant execute on function public.publish_model_version(uuid) to authenticated;

create or replace function public.deprecate_expired_versions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.model_versions
     set status = 'deprecated', deprecated_at = now()
   where status = 'stable'
     and transition_ends_at is not null
     and transition_ends_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- --------------------------------------------------------------------------
-- Billing
-- --------------------------------------------------------------------------

-- Open the current period for a user if one is not already open.
create or replace function public.ensure_open_billing_period(p_user uuid, p_at timestamptz default now())
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz := date_trunc('month', p_at);
  v_end   timestamptz := date_trunc('month', p_at) + interval '1 month';
  v_row   public.billing_periods;
begin
  select * into v_row
    from public.billing_periods
   where user_id = p_user and period_start = v_start;

  if v_row.id is null then
    insert into public.billing_periods (user_id, period_start, period_end, fee_rate, status)
    values (p_user, v_start, v_end, public.fee_rate(), 'open')
    on conflict (user_id, period_start) do nothing
    returning * into v_row;

    if v_row.id is null then
      select * into v_row from public.billing_periods
       where user_id = p_user and period_start = v_start;
    end if;
  end if;

  return v_row;
end;
$$;

-- Recompute a period's totals from its LIVE resolved trades.
--
-- Paper trades are excluded by the `mode = 'live'` filter, which is the single
-- point where that invariant is enforced for billing. Trades are attributed to
-- a period by RESOLUTION time, not open time: you are billed on profit when it
-- is realized.
create or replace function public.recompute_billing_period(p_period uuid)
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.billing_periods;
  v_wins   bigint := 0;
  v_losses bigint := 0;
  v_net    bigint := 0;
begin
  select * into v_row from public.billing_periods where id = p_period for update;
  if v_row.id is null then
    raise exception 'billing period % not found', p_period;
  end if;

  select
    coalesce(sum(case when r.pnl >= 0 then r.pnl else 0 end), 0),
    coalesce(sum(case when r.pnl <  0 then -r.pnl else 0 end), 0)
  into v_wins, v_losses
  from public.trade_resolutions r
  join public.trades t on t.id = r.trade_id
  where t.user_id = v_row.user_id
    and t.mode = 'live'
    and r.resolved_at >= v_row.period_start
    and r.resolved_at <  v_row.period_end;

  v_net := v_wins - v_losses;

  update public.billing_periods
     set gross_wins = v_wins,
         gross_losses = v_losses,
         net_pnl = v_net,
         -- THE fee rule. Losses offset wins; a losing period owes nothing.
         fee_owed = round(greatest(0, v_net) * v_row.fee_rate)
   where id = p_period
  returning * into v_row;

  return v_row;
end;
$$;

-- Close a period: freeze totals and hand it to the invoicing step.
create or replace function public.close_billing_period(p_period uuid)
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.billing_periods;
begin
  v_row := public.recompute_billing_period(p_period);

  if v_row.status <> 'open' then
    return v_row;
  end if;

  update public.billing_periods
     set closed_at = now(),
         -- Nothing owed means nothing to invoice; settle it immediately so it
         -- does not sit in the admin's "pending" queue forever.
         status = case when v_row.fee_owed = 0 then 'paid' else 'invoiced' end
   where id = p_period
  returning * into v_row;

  insert into public.activity_log (user_id, event_type, detail, metadata)
  values (v_row.user_id, 'billing.period_closed',
          format('Period closed: net %s, fee %s',
                 (v_row.net_pnl / 100.0)::numeric(12,2),
                 (v_row.fee_owed / 100.0)::numeric(12,2)),
          jsonb_build_object('billing_period_id', v_row.id,
                             'net_pnl', v_row.net_pnl,
                             'fee_owed', v_row.fee_owed));

  return v_row;
end;
$$;

-- Admin override for a payment that arrived outside Stripe (rare P2P balance).
create or replace function public.mark_period_paid(p_period uuid, p_note text default null)
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.billing_periods;
begin
  if not public.is_admin() then
    raise exception 'only an admin may mark a period paid';
  end if;

  update public.billing_periods
     set status = 'paid', grace_until = null
   where id = p_period
  returning * into v_row;

  if v_row.id is null then
    raise exception 'billing period % not found', p_period;
  end if;

  insert into public.payments (billing_period_id, amount, method, status, note, paid_at, marked_by)
  values (p_period, v_row.fee_owed, 'manual', 'succeeded', p_note, now(), auth.uid());

  -- Paying clears the reason the account was restricted.
  update public.users
     set account_status = 'active'
   where id = v_row.user_id
     and account_status in ('grace', 'paused');

  insert into public.activity_log (user_id, event_type, detail, metadata)
  values (v_row.user_id, 'billing.marked_paid',
          coalesce(p_note, 'Marked paid by admin'),
          jsonb_build_object('billing_period_id', p_period, 'admin_id', auth.uid()));

  return v_row;
end;
$$;

create or replace function public.waive_period(p_period uuid, p_note text default null)
returns public.billing_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.billing_periods;
begin
  if not public.is_admin() then
    raise exception 'only an admin may waive a period';
  end if;

  update public.billing_periods
     set status = 'waived', grace_until = null
   where id = p_period
  returning * into v_row;

  update public.users
     set account_status = 'active'
   where id = v_row.user_id
     and account_status in ('grace', 'paused');

  insert into public.activity_log (user_id, event_type, detail, metadata)
  values (v_row.user_id, 'billing.waived', coalesce(p_note, 'Waived by admin'),
          jsonb_build_object('billing_period_id', p_period, 'admin_id', auth.uid()));

  return v_row;
end;
$$;

grant execute on function public.mark_period_paid(uuid, text) to authenticated;
grant execute on function public.waive_period(uuid, text) to authenticated;
grant execute on function public.publish_model_version(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- Inactivity flagging. Flags only — removal is always a manual admin action,
-- so this never touches 'removed'.
-- --------------------------------------------------------------------------
create or replace function public.flag_inactive_accounts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer := public.setting_numeric('inactivity_threshold_days', 30)::integer;
  n integer;
begin
  update public.users u
     set account_status = 'inactive'
   where u.role = 'member'
     and u.account_status = 'active'
     and coalesce(u.last_trade_at, u.created_at) < now() - make_interval(days => v_days);
  get diagnostics n = row_count;

  -- Someone who traded again is no longer inactive.
  update public.users u
     set account_status = 'active'
   where u.account_status = 'inactive'
     and coalesce(u.last_trade_at, u.created_at) >= now() - make_interval(days => v_days);

  return n;
end;
$$;

-- --------------------------------------------------------------------------
-- Snapshot retention: roll raw rows into daily aggregates, then prune.
-- --------------------------------------------------------------------------
create or replace function public.rollup_and_prune_snapshots()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer := public.setting_numeric('snapshot_retention_days', 30)::integer;
  v_cutoff timestamptz := now() - make_interval(days => v_days);
  n integer;
begin
  insert into public.market_snapshots_daily as d
    (market_id, day, open_price, close_price, high_price, low_price,
     avg_spread, volume, open_interest, sample_count)
  select
    s.market_id,
    (s.ts at time zone 'UTC')::date as day,
    (array_agg(s.price order by s.ts asc))[1],
    (array_agg(s.price order by s.ts desc))[1],
    max(s.price),
    min(s.price),
    avg(s.spread)::numeric(6,2),
    max(s.volume),
    max(s.open_interest),
    count(*)::integer
  from public.market_snapshots s
  where s.ts < v_cutoff
  group by s.market_id, (s.ts at time zone 'UTC')::date
  on conflict (market_id, day) do update
    set open_price = excluded.open_price,
        close_price = excluded.close_price,
        high_price = excluded.high_price,
        low_price = excluded.low_price,
        avg_spread = excluded.avg_spread,
        volume = excluded.volume,
        open_interest = excluded.open_interest,
        sample_count = excluded.sample_count;

  delete from public.market_snapshots where ts < v_cutoff;
  get diagnostics n = row_count;

  -- Scores are written every scoring pass, so they grow far faster than
  -- snapshots: a few hundred markets every five minutes is millions of rows a
  -- month, and latest_scores (a DISTINCT ON) degrades with every one of them.
  --
  -- Keep everything recent, and keep the newest row per (market, version)
  -- forever regardless of age — that row is what a historical trade's card
  -- still renders from, and deleting it would blank out old positions.
  delete from public.scores s
   where s.ts < v_cutoff
     and s.id not in (
       select distinct on (market_id, model_version_id) id
         from public.scores
        order by market_id, model_version_id, ts desc
     );

  return n;
end;
$$;

-- --------------------------------------------------------------------------
-- Views the clients read
-- --------------------------------------------------------------------------

-- The newest score per (market, model version). security_invoker keeps the
-- caller's RLS in force rather than the view owner's.
create or replace view public.latest_scores
with (security_invoker = true) as
select distinct on (s.model_version_id, s.market_id)
  s.id, s.market_id, s.model_version_id, s.ts, s.side, s.score, s.breakdown
from public.scores s
order by s.model_version_id, s.market_id, s.ts desc;

-- The newest snapshot per market.
create or replace view public.latest_snapshots
with (security_invoker = true) as
select distinct on (s.market_id)
  s.market_id, s.ts, s.price, s.volume, s.spread, s.open_interest, s.liquidity
from public.market_snapshots s
order by s.market_id, s.ts desc;

-- Everything the Decision Desk needs for one card, already joined.
create or replace view public.decision_desk
with (security_invoker = true) as
select
  m.id            as market_id,
  m.question,
  m.category,
  m.close_time,
  ls.model_version_id,
  ls.side,
  ls.score,
  ls.breakdown,
  ls.ts           as scored_at,
  snap.price      as yes_price,
  snap.volume,
  snap.spread,
  snap.liquidity,
  -- Price of the side the model picked, which is what the stake card quotes.
  case when ls.side = 'YES' then snap.price else 100 - snap.price end as side_price
from public.markets m
join public.latest_scores ls on ls.market_id = m.id
left join public.latest_snapshots snap on snap.market_id = m.id
where m.resolved_at is null
  and (m.close_time is null or m.close_time > now());

-- Open positions with live mark-to-market. Unrealized PnL uses the current
-- price of the side HELD, matching unrealizedPnlCents() in the shared package.
create or replace view public.open_positions
with (security_invoker = true) as
select
  t.id            as trade_id,
  t.user_id,
  t.market_id,
  m.question,
  m.category,
  t.mode,
  t.side,
  t.entry_price,
  t.contracts,
  t.stake_cents,
  t.entry_score,
  t.model_version_id,
  mv.version_label as entry_model_label,
  t.opened_at,
  case when t.side = 'YES' then snap.price else 100 - snap.price end as current_price,
  (
    (case when t.side = 'YES' then snap.price else 100 - snap.price end)::bigint
    - t.entry_price::bigint
  ) * t.contracts as unrealized_pnl
from public.trades t
join public.markets m on m.id = t.market_id
join public.model_versions mv on mv.id = t.model_version_id
left join public.latest_snapshots snap on snap.market_id = t.market_id
where t.status = 'open';

-- Resolved trades with their realized PnL.
create or replace view public.resolved_positions
with (security_invoker = true) as
select
  t.id as trade_id,
  t.user_id,
  t.market_id,
  m.question,
  m.category,
  t.mode,
  t.side,
  t.entry_price,
  t.contracts,
  t.stake_cents,
  t.entry_score,
  mv.version_label as entry_model_label,
  t.opened_at,
  r.outcome,
  r.pnl,
  r.resolved_at,
  extract(epoch from (r.resolved_at - t.opened_at)) as hold_seconds
from public.trades t
join public.trade_resolutions r on r.trade_id = t.id
join public.markets m on m.id = t.market_id
join public.model_versions mv on mv.id = t.model_version_id;

grant select on public.latest_scores, public.latest_snapshots, public.decision_desk,
                public.open_positions, public.resolved_positions to authenticated;


-- ===== 20260823000400_seed.sql =====================================

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


-- ===== 20260823000600_vault_rpc.sql ================================

-- ===========================================================================
-- Vault wrappers.
--
-- PostgREST cannot reach the `vault` schema directly, so the Edge Functions
-- go through these three SECURITY DEFINER wrappers instead. Execute is granted
-- to service_role ONLY — never to authenticated — so a member's JWT cannot
-- reach a Kalshi key even with a valid secret id in hand.
-- ===========================================================================

create or replace function public.vault_create_secret(
  p_secret      text,
  p_name        text,
  p_description text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
begin
  select vault.create_secret(p_secret, p_name, p_description) into v_id;
  return v_id;
end;
$$;

create or replace function public.vault_read_secret(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where id = p_id;
  return v_secret;
end;
$$;

create or replace function public.vault_delete_secret(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  delete from vault.secrets where id = p_id;
end;
$$;

-- Lock these down hard. The default grant to PUBLIC on a new function is
-- exactly the mistake that would make the whole Vault design decorative.
revoke all on function public.vault_create_secret(text, text, text) from public, anon, authenticated;
revoke all on function public.vault_read_secret(uuid)              from public, anon, authenticated;
revoke all on function public.vault_delete_secret(uuid)            from public, anon, authenticated;

grant execute on function public.vault_create_secret(text, text, text) to service_role;
grant execute on function public.vault_read_secret(uuid)               to service_role;
grant execute on function public.vault_delete_secret(uuid)             to service_role;

-- Deleting a connection row should not orphan its secret in Vault.
create or replace function public.cleanup_kalshi_secret()
returns trigger
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  delete from vault.secrets where id = old.vault_secret_ref;
  return old;
end;
$$;

create trigger kalshi_connections_cleanup_secret
  after delete on public.kalshi_connections
  for each row execute function public.cleanup_kalshi_secret();


-- ===== 20260823000700_news_cache.sql ===============================

-- ===========================================================================
-- News signal cache.
--
-- Keyed by market, not by user: the news for "Will the Fed cut in September?"
-- is the same news for all twenty members, and fetching it per viewer would
-- burn a NewsAPI quota in an afternoon.
-- ===========================================================================

create table public.news_cache (
  market_id  text primary key references public.markets(id) on delete cascade,
  query      text not null,
  volume     integer not null default 0,
  sentiment  numeric(4,3) not null default 0 check (sentiment between -1 and 1),
  coverage   numeric(4,3) not null default 0 check (coverage between 0 and 1),
  fetched_at timestamptz not null default now()
);

create index news_cache_fetched_idx on public.news_cache (fetched_at);

alter table public.news_cache enable row level security;

-- Readable so the market detail screen can show why the news bar looks the way
-- it does. Written only by the scoring pass (service role).
create policy news_cache_select on public.news_cache
  for select to authenticated using (true);


-- ===== 20260823000800_revoke_anon_news_cache.sql ===================

-- ===========================================================================
-- Close an ordering gap in the anon revoke.
--
-- 20260823000200_rls.sql ends with:
--
--   revoke all on all tables in schema public from anon;
--
-- That statement applies to tables existing AT THAT MOMENT. news_cache is
-- created two migrations later, so it never lost its anon grant — confirmed
-- against the live database, where every other table returns 42501 to an
-- anonymous caller and news_cache returned 200 with an empty array.
--
-- No data was exposed: RLS is enabled on news_cache and its only policy grants
-- to `authenticated`, so anonymous reads were already filtered to nothing. But
-- the revoke is the second layer precisely so a policy mistake is not the only
-- thing standing between anon and the data, and news_cache was missing it.
-- ===========================================================================

revoke all on public.news_cache from anon;

-- Same for anything added later: revoking by default means a new table has to
-- be granted access deliberately rather than inheriting it.
alter default privileges in schema public revoke all on tables from anon;


-- ===== 20260823000900_ingest_events_setting.sql ====================

-- ===========================================================================
-- Ingestion now walks EVENTS, not the flat markets listing, so the budget is
-- counted in events rather than markets.
--
-- Measured against the live API: 400 events yields ~2,800 markets and ~2,700
-- snapshots. 300 is a comfortable default for a platform serving ~20 people
-- and stays well inside Kalshi's public rate limits at a 5-minute cadence.
-- ===========================================================================

insert into public.platform_settings (key, value)
values ('ingest_max_events', '300'::jsonb)
on conflict (key) do nothing;

-- The old key counted markets from an endpoint we no longer poll.
delete from public.platform_settings where key = 'ingest_max_markets';


-- ===== 20260823001000_side_separation_threshold.sql ================

-- ===========================================================================
-- Add minSideSeparation to model v1's thresholds.
--
-- The first 15 live scores were ALL side=YES. Cause: news is neutral for both
-- sides without coverage, and baseRateScore keys off min(price, 100 - price)
-- so it is symmetric by construction. Drift is the only input that can
-- separate the sides, and a market that has not moved ties exactly — with
-- pickSide breaking toward YES every time.
--
-- Surfacing a coin flip with a side badge implies a directional view the model
-- does not hold. This is the minimum gap between the two sides' scores before
-- a market may surface. 0.5 is the smallest gap visible at the one decimal
-- place scores are stored and displayed at.
-- ===========================================================================

update public.model_versions
   set thresholds = thresholds || jsonb_build_object('minSideSeparation', 0.5)
 where version_label = 'v1'
   and not (thresholds ? 'minSideSeparation');


-- ===== 20260823001100_day_one_logging.sql ==========================

-- ===========================================================================
-- Day-one logging (Edge Signals v2, sections 4b / 9 / 10 / 11c / 11e).
--
-- These tables carry no features yet. They exist now because the data they
-- hold cannot be reconstructed later:
--
--   * the model portfolio is only a benchmark if its history is long
--   * own-flow exclusion needs a record of platform orders BEFORE the flow
--     detector can be trusted not to hear its own echo
--   * point-in-time discipline means first-seen values are never restated,
--     so anything not captured at the time is gone
--
-- Every feature built on top of these can wait. The accumulation cannot.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. execution_mode on trades  (§4b, §10)
--
-- Distinguishes a member's own decision from an automated one and from the
-- synthetic benchmark account. Performance and Benchmarks both slice on this,
-- and billing must never see model_portfolio rows.
-- --------------------------------------------------------------------------
create type public.execution_mode as enum ('manual', 'auto_flow', 'model_portfolio');

alter table public.trades
  add column execution_mode public.execution_mode not null default 'manual';

create index trades_execution_mode_idx on public.trades (execution_mode, opened_at desc);

comment on column public.trades.execution_mode is
  'manual = the member chose it. auto_flow = automated on a graduated flow signal. '
  'model_portfolio = the synthetic benchmark account, excluded from billing.';

-- The freeze trigger already protects mode; execution_mode is equally a
-- permanent property of how the trade came to exist.
create or replace function public.freeze_trade_provenance()
returns trigger
language plpgsql
as $$
begin
  if new.model_version_id is distinct from old.model_version_id
     or new.entry_score is distinct from old.entry_score
     or new.mode is distinct from old.mode
     or new.execution_mode is distinct from old.execution_mode then
    raise exception
      'trade % provenance is immutable (model_version_id, entry_score, mode, execution_mode)', old.id;
  end if;

  if old.status <> 'pending' then
    if new.side is distinct from old.side
       or new.entry_price is distinct from old.entry_price
       or new.contracts is distinct from old.contracts
       or new.stake_cents is distinct from old.stake_cents then
      raise exception
        'trade % fill details are immutable once it is no longer pending', old.id;
    end if;
  end if;

  return new;
end;
$$;

-- --------------------------------------------------------------------------
-- 2. platform_flow  (§11c)
--
-- Every order this platform originates, so its own volume can be SUBTRACTED
-- from the flow signal's inputs.
--
-- Members act on the same score, in the same direction, within minutes of each
-- other, on books thin enough to move. Without this the flow detector reads
-- the platform's own members as informed flow and feeds itself. A signal that
-- can hear its own echo is not a signal.
--
-- Paper trades are logged too, and marked: they never touch a real book, so
-- the exclusion query filters to mode='live'. Logging both makes the
-- distinction auditable rather than assumed.
-- --------------------------------------------------------------------------
create table public.platform_flow (
  id            bigserial primary key,
  market_id     text not null references public.markets(id) on delete cascade,
  trade_id      uuid references public.trades(id) on delete set null,
  user_id       uuid references public.users(id) on delete set null,
  side          public.market_side not null,
  contracts     integer not null check (contracts > 0),
  price         smallint not null check (price between 1 and 99),
  mode          public.trade_mode not null,
  execution_mode public.execution_mode not null default 'manual',
  ts            timestamptz not null default now()
);

create index platform_flow_market_ts_idx on public.platform_flow (market_id, ts desc);
create index platform_flow_live_idx on public.platform_flow (market_id, ts desc) where mode = 'live';

-- --------------------------------------------------------------------------
-- 3. edge_theses  (§9)
--
-- Logged for EVERY scored market, traded or not.
--
-- Restricting this to taken trades would inherit whichever markets members
-- happened to like and cap the training set at trade volume instead of market
-- volume. At ~2,000 scored markets against a handful of trades, that is three
-- orders of magnitude of labelled examples discarded. At resolution every row
-- here joins against the outcome, whether anyone traded it or not.
--
-- Never pruned. One row per market per thesis change is small enough to keep
-- forever, and it is the substrate the self-tuning roadmap learns from.
-- --------------------------------------------------------------------------
create type public.thesis_type as enum (
  'anchor_gap',
  'coherence',
  'informed_flow',
  'longshot_bias',
  'none'
);

create table public.edge_theses (
  id               uuid primary key default gen_random_uuid(),
  market_id        text not null references public.markets(id) on delete cascade,
  score_id         uuid references public.scores(id) on delete set null,
  model_version_id uuid not null references public.model_versions(id),
  thesis_type      public.thesis_type not null,
  /** Which side the thesis favours. Null when thesis_type = 'none'. */
  direction        public.market_side,
  /** Size of the claimed mispricing, in cents where that is meaningful. */
  magnitude        numeric(6,3),
  payload          jsonb not null default '{}'::jsonb,
  rendered_text    text,
  created_at       timestamptz not null default now()
);

create index edge_theses_market_idx on public.edge_theses (market_id, created_at desc);
create index edge_theses_type_idx on public.edge_theses (thesis_type, created_at desc);

-- Supports the dedupe-on-unchanged read: the writer compares against the
-- newest row for this market and version before inserting.
create index edge_theses_latest_idx
  on public.edge_theses (market_id, model_version_id, created_at desc);

comment on table public.edge_theses is
  'One row per scoring pass where the thesis CHANGED, for every scored market '
  'whether traded or not. thesis_type = none is a valid and common outcome.';

-- Stamped on the trade so per-thesis PnL is measurable on the traded subset,
-- alongside the full-market view above.
alter table public.trades
  add column thesis_type public.thesis_type,
  add column thesis_payload jsonb;

-- --------------------------------------------------------------------------
-- 4. news_articles  (§5, §11e)
--
-- Replaces news_cache, which had market_id as its PRIMARY KEY and therefore
-- overwrote on every fetch. That is incompatible with point-in-time
-- discipline: it destroyed the record of what was known when.
--
-- This table is append-only. first_seen_at is set once and never updated;
-- published_at comes from the source. The priced-in join (§5) needs both, and
-- the backtest harness may only read rows timestamped before the simulated
-- decision.
-- --------------------------------------------------------------------------
create table public.news_articles (
  id            uuid primary key default gen_random_uuid(),
  market_id     text not null references public.markets(id) on delete cascade,
  url           text,
  title         text not null,
  source        text,
  /** From the provider. Null when it does not supply one. */
  published_at  timestamptz,
  /** When WE first saw it. Never updated — this is the point-in-time anchor. */
  first_seen_at timestamptz not null default now(),
  matched_terms text[],
  /** -1..1 lean, or null when not yet assessed. */
  direction_est numeric(4,3),
  /** Did price move within the window after publication? Null until checked. */
  priced_in            boolean,
  priced_in_checked_at timestamptz
);

create index news_articles_market_idx on public.news_articles (market_id, published_at desc nulls last);
create index news_articles_unpriced_idx on public.news_articles (market_id) where priced_in is null;

-- Same article seen on a later pass must not create a second row.
create unique index news_articles_dedupe_idx
  on public.news_articles (market_id, url) where url is not null;

-- --------------------------------------------------------------------------
-- RLS
--
-- All four are platform-internal. Members read theses and articles because
-- both surface on the market detail screen; platform_flow is admin-only, since
-- it reveals what other members are doing.
-- --------------------------------------------------------------------------
alter table public.platform_flow enable row level security;
alter table public.edge_theses   enable row level security;
alter table public.news_articles enable row level security;

create policy platform_flow_admin_read on public.platform_flow
  for select to authenticated using (public.is_admin());

create policy edge_theses_select on public.edge_theses
  for select to authenticated using (true);

create policy news_articles_select on public.news_articles
  for select to authenticated using (true);

revoke all on public.platform_flow, public.edge_theses, public.news_articles from anon;


-- ===== 20260823001200_v1_1_drift_stopgap.sql =======================

-- ===========================================================================
-- Model v1.1 — lower the surface threshold to 4.0.
--
-- A NEW VERSION rather than an edit to v1, per the addendum's section 7: every
-- tunable change is versioned so scores either side of it stay distinguishable
-- and comparable. v1's existing scores keep their model_version_id and remain
-- exactly what v1 said.
--
-- WHY, from measurement rather than judgement. One scoring pass over 394
-- markets with ~5.5 hours of price history reported:
--
--     scoreP50 4.0    scoreP90 4.3    scoreMax 4.8
--     sepP50   0      sepMax   1.1
--
-- Two things follow.
--
-- The 5.0 surface threshold was UNREACHABLE. The single best-scoring market on
-- the platform sat at 4.8, so nothing could ever surface. 5.0 had been
-- calibrated against inflated scores — before 20260823001000 fixed a bug where
-- untraded markets were credited with a 3x volume spike, which added roughly
-- 1.8 points to every micro contribution.
--
-- And the median separation between the two sides is ZERO. Half of all markets
-- score identically on YES and NO, because drift is the only side-aware input
-- v1 has and most markets simply do not move. Since
--
--     delta_score = 0.45 x drift x quality
--
-- a sepMax of 1.1 means the MOST-moved market of 394 drifted about 2.7 cents in
-- six hours.
--
-- THIS IS A STOPGAP, NOT A TUNING IMPROVEMENT. Lowering the threshold does not
-- make a 2-cent move into an edge; it makes a thin desk visible instead of an
-- empty one, so paper trading and the execution path can be exercised while
-- anchors are built. minSideSeparation stays at 0.5, which is what stops this
-- from re-admitting the coin flips 20260823001000 removed.
--
-- The real fix is the addendum's section 1: an NWS forecast of 78% against a
-- 64c market is a directional edge that exists whether or not the price has
-- moved, and is therefore immune to precisely the weakness measured above.
-- ===========================================================================

insert into public.model_versions
  (version_label, status, weights, thresholds, risk_limits, notes)
select
  'v1.1',
  'draft',
  weights,
  thresholds || jsonb_build_object('surface', 4.0),
  risk_limits,
  'Drift-only stopgap. Surface threshold 5.0 -> 4.0 because scoreMax across '
  || '394 markets was 4.8, making 5.0 unreachable. Separation median was 0 and '
  || 'max 1.1, i.e. the most-moved market drifted ~2.7c in six hours. This '
  || 'makes a thin desk visible; it does not make the signal stronger. '
  || 'Superseded once anchors land.'
from public.model_versions
where version_label = 'v1'
  and not exists (select 1 from public.model_versions where version_label = 'v1.1');

-- Mirror publish_model_version(): the outgoing stable enters its transition
-- window rather than being deprecated outright, so anyone pinned to v1 keeps
-- its scores until the window closes.
update public.model_versions
   set status = 'stable',
       transition_ends_at = now() + make_interval(
         days => public.setting_numeric('transition_window_days', 14)::integer)
 where version_label = 'v1'
   and status = 'stable';

update public.model_versions
   set status = 'stable',
       published_at = now(),
       transition_ends_at = null
 where version_label = 'v1.1';

insert into public.activity_log (event_type, detail, metadata)
values (
  'model.published',
  'Published v1.1 — surface threshold 4.0 (drift-only stopgap)',
  jsonb_build_object(
    'label', 'v1.1',
    'reason', 'surface 5.0 unreachable: scoreMax 4.8 across 394 markets',
    'evidence', jsonb_build_object(
      'scoreP50', 4.0, 'scoreP90', 4.3, 'scoreMax', 4.8,
      'sepP50', 0, 'sepMax', 1.1, 'markets', 394)
  )
);


-- ===== 20260823001300_universe_tiers.sql ===========================

-- ===========================================================================
-- Market universe: families, cadence tiers, and point-in-time membership.
--
-- WHY. Ingestion took the first 300 events Kalshi happened to return and
-- priced whatever was in them. Measured against the full book:
--
--                    ingested        full book
--   median horizon   1,217 days      90 days
--   resolving <=7d   0.0%            26.5%
--   weather markets  5               718
--   coverage         2.7%
--
-- The platform was scoring contracts resolving in 2029. That is the entire
-- explanation for a median side-separation of zero: those markets do not move
-- because nothing has happened yet and will not for years. The drift signal
-- was never weak, it was pointed at the wrong markets.
--
-- Discovery now sees the whole book. Tiers are how pricing cost stays bounded
-- without going blind to the long tail.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Families
--
-- Grounded in the live API rather than guessed. Across 6,000 events:
--   * 1,869 (31%) carry mutually_exclusive; 1,164 of those have >2 legs and
--     are outright/bracket shapes — "Who will the next Pope be?" (7 legs),
--     "Next DNC Chair" (34), 653 in Sports.
--   * Multi-variate-event shards NEVER overlap that set (0 of them), so the
--     two families cannot be confused.
--
-- multi_stage is called out because it is a thesis family of its own:
-- staged-probability mispricing, where the market prices "wins it all" and
-- the trade is "advances a round". Tagged now so section 3's calibration
-- buckets can measure it later.
-- --------------------------------------------------------------------------
create type public.market_family as enum ('standard', 'multi_stage', 'mve_shard');

-- --------------------------------------------------------------------------
-- Cadence tiers
--
-- Not in-or-out. A 7-day horizon filter would amputate the multi-leg family
-- entirely (p10 51 days, median 135), losing exactly the early tail-entry
-- opportunities that are worth having — and losing the price history that
-- makes them scoreable later.
--
--   fast    priced every 5 minutes  — near-dated and liquid
--   slow    priced hourly           — long-dated but still worth tracking
--   archive priced daily            — very long-dated; history accumulates
--   excluded  never priced          — shards, no book at all
-- --------------------------------------------------------------------------
create type public.cadence_tier as enum ('fast', 'slow', 'archive', 'excluded');

alter table public.markets
  add column family       public.market_family not null default 'standard',
  add column cadence_tier public.cadence_tier  not null default 'slow',
  add column tier_reason  text,
  /** True when a category has an external anchor source available. */
  add column anchorable    boolean not null default false,
  add column last_priced_at timestamptz;

create index markets_tier_idx on public.markets (cadence_tier, last_priced_at nulls first)
  where resolved_at is null;
create index markets_family_idx on public.markets (family);

comment on column public.markets.cadence_tier is
  'How often this market is priced. Assigned by discover-markets from the '
  'selection thresholds on the stable model version.';

-- --------------------------------------------------------------------------
-- Universe membership, point-in-time
--
-- A backtest cannot be honest about what the platform could have seen without
-- knowing which markets were in the priced universe at that moment, and why.
-- Rows are append-only: a market leaving a tier closes its row rather than
-- deleting it (section 11e — never restate history).
-- --------------------------------------------------------------------------
create table public.universe_membership (
  id          bigserial primary key,
  market_id   text not null references public.markets(id) on delete cascade,
  tier        public.cadence_tier not null,
  family      public.market_family not null,
  /** Why the tier was assigned — horizon, liquidity, cap, category. */
  reason      text not null,
  /** Rank at entry, for auditing how the cap was applied. */
  rank_score  numeric(8,3),
  entered_at  timestamptz not null default now(),
  /** Null while current. Set when the market leaves this tier. */
  left_at     timestamptz
);

create index universe_membership_market_idx
  on public.universe_membership (market_id, entered_at desc);
create index universe_membership_current_idx
  on public.universe_membership (tier) where left_at is null;

-- One open row per market at a time.
create unique index universe_membership_open_idx
  on public.universe_membership (market_id) where left_at is null;

alter table public.universe_membership enable row level security;

create policy universe_membership_select on public.universe_membership
  for select to authenticated using (true);

revoke all on public.universe_membership from anon;

-- --------------------------------------------------------------------------
-- Selection tunables (section 7: every knob lives on the model version).
--
-- Deliberately NOT hardcoded in the discovery function. Which markets the
-- platform looks at is a modelling decision — it determines what can ever be
-- scored, surfaced or traded — so it is versioned, backtestable and
-- comparable like any other.
-- --------------------------------------------------------------------------
update public.model_versions
   set thresholds = thresholds || jsonb_build_object(
     'selection', jsonb_build_object(
       -- Horizon boundaries between cadence tiers, in days.
       'fastHorizonDays',   14,
       'slowHorizonDays',   365,
       -- Book quality required for the fast tier.
       'maxSpreadCents',    12,
       'requireTwoSidedBook', true,
       -- Hard caps on how many markets each tier prices. Fast tier is the
       -- expensive one: 5-minute cadence against Kalshi.
       'fastCap',           800,
       'slowCap',           2500,
       'archiveCap',        5000,
       -- Ranking within a cap: liquidity, plus a boost for categories where
       -- an external anchor exists, since those can be scored on more than
       -- price movement.
       'anchorableCategories', jsonb_build_array('Weather', 'Economics'),
       'anchorRankBoost',   0.25,
       -- Legs required before a mutually-exclusive event counts as
       -- multi_stage rather than a plain binary pair.
       'multiStageMinLegs', 3
     ))
 where version_label in ('v1', 'v1.1')
   and not (thresholds ? 'selection');


-- ===== 20260823001400_tiered_cron.sql ==============================

-- ===========================================================================
-- Tiered ingestion schedules.
--
-- Replaces the single 5-minute "ingest everything we happen to have" job with
-- the discovery/pricing split:
--
--   discover-markets   hourly   pages the whole book, assigns cadence tiers,
--                               records point-in-time universe membership
--   ingest fast        5 min    near-dated, two-sided book
--   ingest slow        hourly   long-dated but still tracked
--   ingest archive     daily    very long-dated; history only
--
-- Pricing is now exact-set (?tickers=), so the fast tier costs ~6 requests per
-- pass instead of the ~60 a full sweep took. Measured against the live API:
-- 200 tickers in one 5KB URL, 149ms.
-- ===========================================================================

-- The old job priced whatever markets existed, in no particular order. Drop it
-- by name rather than by id, and tolerate it already being gone so this
-- migration is safe to re-run.
do $$
begin
  perform cron.unschedule('oe-ingest-markets');
exception when others then
  null;
end;
$$;

-- --------------------------------------------------------------------------
-- Discovery
--
-- Hourly. A full 60-page pass measured ~11s against Kalshi at 3.8 req/s with
-- zero throttling, so the cost is trivial; the reason not to run it more often
-- is that tier assignment should be stable enough for price history to mean
-- something, not that the pass is expensive.
--
-- Offset to :40 so it lands between the hourly slow-tier pricing and the top
-- of the next hour.
-- --------------------------------------------------------------------------
select cron.schedule(
  'oe-discover-markets', '40 * * * *',
  $$ select public.invoke_edge_function('discover-markets'); $$
);

-- --------------------------------------------------------------------------
-- Pricing, per tier
-- --------------------------------------------------------------------------

-- Fast: the markets that can actually move within a member's decision window.
select cron.schedule(
  'oe-ingest-fast', '*/5 * * * *',
  $$ select public.invoke_edge_function('ingest-markets', '{"tier":"fast"}'::jsonb); $$
);

-- Slow: hourly. These are the tail-entry candidates — tournament outrights,
-- election longs, multi-stage events. Priced rarely, but priced, so that when
-- one of them becomes interesting there is history behind it rather than a
-- cold start.
select cron.schedule(
  'oe-ingest-slow', '10 * * * *',
  $$ select public.invoke_edge_function('ingest-markets', '{"tier":"slow"}'::jsonb); $$
);

-- Archive: daily, 08:25 UTC — before the snapshot prune at 09:30 so the day's
-- point lands inside the window that gets rolled up.
select cron.schedule(
  'oe-ingest-archive', '25 8 * * *',
  $$ select public.invoke_edge_function('ingest-markets', '{"tier":"archive"}'::jsonb); $$
);


-- ===== 20260823001500_discovery_chunked.sql ========================

-- ===========================================================================
-- Chunked discovery, and tier assignment in SQL.
--
-- WHY. The first discovery build paged the whole book into an array and then
-- classified it. Measured against the live API that is 235 MB of JSON and
-- ~110,000 market objects held at once, against a 256 MB function limit, so it
-- died with WORKER_RESOURCE_LIMIT before writing a single row. Wall clock was
-- never the problem (~10s); retention was.
--
-- Two consequences, both structural rather than a tuning fix:
--
--   * Discovery now processes one page at a time and persists a cursor, so a
--     sweep spans several invocations and peak memory is one page.
--   * Ranking and caps move here. Choosing the top N of 110,000 markets is a
--     sort, which is what a database is for; doing it in a worker meant
--     holding every candidate in memory purely to order them.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Discovery-time book quality.
--
-- Tier assignment needs volume and spread, but those live in snapshots, which
-- only exist for markets already being priced -- a market cannot earn its way
-- into the universe using data it can only have once it is in the universe.
-- So discovery records what it saw at the moment it looked.
-- --------------------------------------------------------------------------
alter table public.markets
  add column disc_volume    bigint  not null default 0,
  add column disc_spread    smallint,
  add column disc_two_sided boolean not null default false,
  add column disc_seen_at   timestamptz;

-- A market should not be priced until something has deliberately tiered it.
-- The old default put every newly discovered market straight into the hourly
-- slow tier, which is how the universe drifted in the first place.
alter table public.markets alter column cadence_tier set default 'excluded';

-- --------------------------------------------------------------------------
-- Sweep cursor
--
-- Single row. The Kalshi cursor is opaque and position-dependent, so a sweep
-- that stops halfway has to resume from exactly where it left off rather than
-- restart -- restarting would re-page the head of the book forever and never
-- reach the tail.
-- --------------------------------------------------------------------------
create table public.discovery_state (
  id                 boolean primary key default true check (id),
  cursor             text,
  pages_done         integer not null default 0,
  markets_seen       integer not null default 0,
  sweep_started_at   timestamptz,
  last_completed_at  timestamptz,
  last_sweep_pages   integer,
  last_sweep_markets integer
);

insert into public.discovery_state (id) values (true) on conflict do nothing;

alter table public.discovery_state enable row level security;
revoke all on public.discovery_state from anon, authenticated;

-- --------------------------------------------------------------------------
-- Tier assignment
--
-- Runs once per completed sweep, over everything discovery has recorded.
--
-- Caps DEMOTE rather than exclude: a market that misses the fast cap falls to
-- slow, and one that misses slow falls to archive. Excluding on overflow would
-- silently blind the platform to the tail, which is the failure this whole
-- change exists to fix.
-- --------------------------------------------------------------------------
create or replace function public.assign_cadence_tiers()
returns jsonb
language plpgsql
security definer
set search_path = public
-- Measured at 10.2s over a 120,000-market book on first assignment and 3.4s
-- in steady state. That is comfortably inside this ceiling but NOT inside the
-- default PostgREST statement timeout, and a timeout here would be quiet in
-- the worst way: the sweep would report success while every market kept the
-- tier it already had.
set statement_timeout = '120s'
as $fn$
declare
  sel        jsonb;
  v_fast_h   numeric;
  v_slow_h   numeric;
  v_spread   integer;
  v_two      boolean;
  v_fast_cap integer;
  v_slow_cap integer;
  v_arch_cap integer;
  v_boost    numeric;
  v_now      timestamptz := now();
  v_result   jsonb;
begin
  select thresholds->'selection' into sel
    from public.model_versions
   where id = public.current_stable_version();

  if sel is null then
    raise exception 'assign_cadence_tiers: stable model version has no selection tunables';
  end if;

  v_fast_h   := (sel->>'fastHorizonDays')::numeric;
  v_slow_h   := (sel->>'slowHorizonDays')::numeric;
  v_spread   := (sel->>'maxSpreadCents')::integer;
  v_two      := coalesce((sel->>'requireTwoSidedBook')::boolean, true);
  v_fast_cap := (sel->>'fastCap')::integer;
  v_slow_cap := (sel->>'slowCap')::integer;
  v_arch_cap := (sel->>'archiveCap')::integer;
  v_boost    := coalesce((sel->>'anchorRankBoost')::numeric, 0);

  create temp table _tier on commit drop as
  with base as (
    select
      m.id,
      m.family,
      m.anchorable,
      extract(epoch from (m.close_time - v_now)) / 86400.0 as horizon,
      coalesce(m.disc_spread, 100)      as spread,
      coalesce(m.disc_two_sided, false) as two_sided,
      -- Liquidity on a log scale: the gap between 100 and 1,000 contracts
      -- matters, the gap between 100,000 and 101,000 does not.
      log(10, greatest(coalesce(m.disc_volume, 0), 1)::numeric)
        + case when m.anchorable then v_boost else 0 end as rank_score
    from public.markets m
    where m.resolved_at is null
  ),
  classified as (
    select b.*,
      case
        when b.family = 'mve_shard'                  then 'excluded'
        when b.horizon is null                       then 'archive'
        when b.horizon < 0                           then 'excluded'
        when b.horizon <= v_fast_h
         and (not v_two or b.two_sided)
         and b.spread <= v_spread                    then 'fast'
        when b.horizon <= v_slow_h                   then 'slow'
        else                                              'archive'
      end as want
    from base b
  ),
  fast_pick as (
    select c.id from classified c
     where c.want = 'fast'
     order by c.rank_score desc
     limit v_fast_cap
  ),
  slow_pool as (
    select c.* from classified c
     where c.want = 'slow'
        or (c.want = 'fast' and c.id not in (select f.id from fast_pick f))
  ),
  slow_pick as (
    select s.id from slow_pool s order by s.rank_score desc limit v_slow_cap
  ),
  arch_pool as (
    select c.* from classified c
     where c.want = 'archive'
        or (c.id in (select s.id from slow_pool s)
            and c.id not in (select s.id from slow_pick s))
  ),
  arch_pick as (
    select a.id from arch_pool a order by a.rank_score desc limit v_arch_cap
  ),
  final as (
    select
      c.id,
      c.family,
      round(c.rank_score::numeric, 3) as rank_score,
      c.want,
      (case
         when c.id in (select f.id from fast_pick f) then 'fast'
         when c.id in (select s.id from slow_pick s) then 'slow'
         when c.id in (select a.id from arch_pick a) then 'archive'
         else 'excluded'
       end)::public.cadence_tier as tier
    from classified c
  )
  -- Reason records both what the market qualified for and whether a cap moved
  -- it, so universe_membership explains itself without re-deriving the rules.
  select
    f.id,
    f.family,
    f.rank_score,
    f.want,
    f.tier,
    case
      when f.tier::text = f.want then 'qualified: ' || f.want
      else 'demoted from ' || f.want || ' (cap)'
    end as reason
  from final f;

  -- Close membership rows whose tier no longer holds. Rows are never deleted;
  -- a backtest has to be able to see what was visible at the time.
  update public.universe_membership um
     set left_at = v_now
    from _tier t
   where um.market_id = t.id
     and um.left_at is null
     and um.tier is distinct from t.tier;

  insert into public.universe_membership (market_id, tier, family, reason, rank_score)
  select t.id, t.tier, t.family, t.reason, t.rank_score
    from _tier t
   where not exists (
     select 1 from public.universe_membership um
      where um.market_id = t.id and um.left_at is null
   );

  update public.markets m
     set cadence_tier = t.tier,
         tier_reason  = t.reason
    from _tier t
   where m.id = t.id
     and (m.cadence_tier is distinct from t.tier
       or m.tier_reason is distinct from t.reason);

  select jsonb_build_object(
    'fast',     count(*) filter (where tier = 'fast'),
    'slow',     count(*) filter (where tier = 'slow'),
    'archive',  count(*) filter (where tier = 'archive'),
    'excluded', count(*) filter (where tier = 'excluded'),
    'demoted',  count(*) filter (where tier::text is distinct from want),
    'total',    count(*)
  ) into v_result from _tier;

  return v_result;
end;
$fn$;

revoke all on function public.assign_cadence_tiers() from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- Discovery now runs in chunks, so it needs to run more often than hourly.
-- Roughly eight invocations complete a full sweep; every five minutes gives a
-- sweep about every 40 minutes.
-- --------------------------------------------------------------------------
select cron.schedule(
  'oe-discover-markets', '2-57/5 * * * *',
  $cron$ select public.invoke_edge_function('discover-markets'); $cron$
);


-- ===== 20260823001600_base_rate_stats.sql ==========================

-- ===========================================================================
-- Base rates aggregated in SQL.
--
-- WHY. The scorer loaded every resolved position as a row and tallied wins per
-- (category, side) in the function. PostgREST caps any response at 1,000 rows
-- and says nothing, so once members had accumulated more than a thousand
-- resolved trades the base rates would have been computed from an arbitrary
-- subset -- and base rates feed every score. That is a silent, growing bias,
-- found while fixing the same truncation in the slow pricing tier.
--
-- A tally is a GROUP BY. It belongs here, where the result is a few dozen
-- rows regardless of how many trades exist.
-- ===========================================================================
create or replace view public.base_rate_stats
with (security_invoker = true) as
select
  category,
  side,
  count(*) filter (where outcome = 'win') as wins,
  count(*)                                as total
from public.resolved_positions
group by category, side;

comment on view public.base_rate_stats is
  'Win tallies per (category, side) over all resolved positions, paper and '
  'live. Paper is included on purpose: the question is whether the model was '
  'right, not who owes what, and excluding paper would discard most early '
  'evidence.';


-- ===== 20260823001700_tiered_scoring_cron.sql ======================

-- ===========================================================================
-- Scoring runs per cadence tier, like pricing.
--
-- WHY. The first pass over the tiered universe scored 82 of the 800 fast-tier
-- markets. The scorer filled its slots by volume across every snapshot, so
-- 300 of 400 went to long-dated slow markets that out-rank near-dated ones on
-- volume -- undoing the tiering it was meant to read.
--
-- The scorer now takes a tier and scores that tier's candidates, with a
-- history window scaled to the tier's pricing cadence. Schedules follow the
-- pricing jobs by a minute or two so each pass reads fresh snapshots.
-- ===========================================================================

do $$
begin
  perform cron.unschedule('oe-score-markets');
exception when others then
  null;
end;
$$;

-- Fast: every 5 minutes, one minute behind fast pricing. The tier members act
-- on; the whole cap is scored every pass.
select cron.schedule(
  'oe-score-fast', '1-56/5 * * * *',
  $cron$ select public.invoke_edge_function('score-markets', '{"tier":"fast"}'::jsonb); $cron$
);

-- Slow: hourly, two minutes behind slow pricing (:10). Drift on hourly
-- snapshots needs three active intervals, so this tier only starts producing
-- directions a few hours after a market enters it -- expected, not a fault.
select cron.schedule(
  'oe-score-slow', '12 * * * *',
  $cron$ select public.invoke_edge_function('score-markets', '{"tier":"slow"}'::jsonb); $cron$
);

-- Archive: daily, after archive pricing (08:25). History only for now; a
-- score here is a long-dated tail-entry candidate, not a desk item.
select cron.schedule(
  'oe-score-archive', '40 8 * * *',
  $cron$ select public.invoke_edge_function('score-markets', '{"tier":"archive"}'::jsonb); $cron$
);


-- ===== 20260823001800_v1_2_draft.sql ===============================

-- ===========================================================================
-- Model v1.2 -- DRAFT. Supersedes the v1.1 drift-only stopgap.
--
-- Inserted as a draft, not published. Publishing is a section 7 act that
-- needs the full-cap fast-tier distribution behind it; this migration puts
-- the version on the table with its reasoning recorded, so publishing is a
-- one-line decision when the evidence lands, not a rushed edit.
--
-- WHAT CHANGES, and why each part:
--
--   1. surface 4.0 -> 5.0.  v1.1 lowered it because "scoreMax 4.8 across 394
--      markets". Those 394 had a median horizon of 1,217 days. On the tiered
--      universe the fast tier sits at score p50 5.1 / p90 6.5 after fifty
--      minutes of history: 5.0 is the median, not a ceiling. The v1.1 premise
--      was a correct response to a fact measured on the wrong universe.
--      PROVISIONAL until the full-cap distribution confirms it.
--
--   2. news weight -> 0 (default 0.28, Weather 0.08).  GDELT has been
--      unreachable on every pass (newsAborted: true). The signal contributed a
--      neutral value at full weight, compressing every score toward the
--      middle and damping the one signal that works. Zero until a real source
--      exists. combineSignals normalises by the weight total, so micro and
--      base scale up in their existing 5:1 ratio; the shared package tests
--      pin that behaviour.
--
--   3. selection is part of the contract, deliberately. v1 and v1.1 had the
--      block stamped on after the fact. v1.2 is the first version published
--      knowing what it can see.
--
-- WHAT DOES NOT CHANGE: minSideSeparation 0.5 (it gated 45 of 82 fast-tier
-- markets that had no direction -- doing its job); micro:base ratio; risk
-- limits; strongPick. No anchors: those add a signal (section 1) and belong
-- to a later version.
--
-- Evidence recorded for the notes, first tiered pass, 2026-09-11 17:01 UTC,
-- ~50 min of fast-tier history:
--   fast  considered 82  scored 36 (44%)  scoreP50 5.1  scoreP90 6.5  sepP90 3.6
--   slow  considered 300 scored 1 (0.3%)  scoreP50 3.7  belowSurface 247
--   old universe (v1.1 basis): scored 6 of ~394 (1.5%)  scoreMax 4.8
-- ===========================================================================

insert into public.model_versions
  (version_label, status, weights, thresholds, risk_limits, notes)
select
  'v1.2',
  'draft',
  jsonb_build_object(
    'default',   jsonb_build_object('micro', 0.60, 'news', 0, 'base', 0.12),
    'overrides', jsonb_build_object(
      'Weather', jsonb_build_object('micro', 0.70, 'news', 0, 'base', 0.22)
    )
  ),
  thresholds || jsonb_build_object('surface', 5.0),
  risk_limits,
  'Supersedes v1.1 (drift-only stopgap). The stopgap lowered surface to 4.0 '
  'because 5.0 was unreachable on a universe with a 1,217-day median horizon. '
  'On the tiered universe the fast tier scores p50 5.1 / p90 6.5, so 5.0 is '
  'restored. News weight zeroed until a reachable source exists: GDELT aborted '
  'on every pass and was diluting live signals at full weight. Selection '
  'tunables are part of this version by design. Evidence: first tiered pass '
  '2026-09-11 17:01Z, fast 36/82 directional (44%) vs slow 1/300 (0.3%) vs '
  'old universe 6/394 (1.5%). Surface value provisional until the full-cap '
  'distribution is read.'
from public.model_versions
where version_label = 'v1.1'
  and not exists (select 1 from public.model_versions where version_label = 'v1.2');

-- Not published here. When the distribution confirms:
--   select public.publish_model_version(
--     (select id from public.model_versions where version_label = 'v1.2'));
-- or publish from the admin dashboard, which calls the same function.


-- ===== 20260823001900_latest_denormalized.sql ======================

-- ===========================================================================
-- "Latest" is a column, not a sort.
--
-- WHY. latest_snapshots was DISTINCT ON over the entire market_snapshots
-- table, with no index that supports the ordering. Every Decision Desk and
-- Positions load sorted every snapshot ever written to find the newest per
-- market. Measured on three days of realistic volume (871k snapshots):
--
--   latest_snapshots alone      445 ms
--   decision_desk (Desk tab)    708 ms
--
-- on a laptop, growing linearly with history -- ~300k rows a day. That is the
-- multi-second tab switch in the admin dashboard, and it would only get
-- worse. latest_scores had the same shape over scores (89 ms and growing).
--
-- The newest snapshot per market is now six columns on markets, and the
-- newest score per (version, market) is a small table, both maintained by
-- statement-level triggers on insert. The views keep their names and exact
-- column lists, so every consumer -- admin, member app, scorer -- is
-- unchanged. The Desk gets a view that resolves the caller's effective
-- version itself, turning three sequential round-trips into one.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Newest snapshot, on the market row
-- --------------------------------------------------------------------------
alter table public.markets
  add column last_price         smallint,
  add column last_volume        bigint,
  add column last_spread        smallint,
  add column last_open_interest bigint,
  add column last_liquidity     bigint,
  add column last_snapshot_at   timestamptz;

create or replace function public.markets_apply_latest_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- One UPDATE per statement, not per row: ingestion inserts in 500-row
  -- chunks, and the newest row per market within the chunk is all that
  -- matters. Never move backwards if an older snapshot arrives late.
  update public.markets m
     set last_price         = n.price,
         last_volume        = n.volume,
         last_spread        = n.spread,
         last_open_interest = n.open_interest,
         last_liquidity     = n.liquidity,
         last_snapshot_at   = n.ts
    from (
      select distinct on (market_id) market_id, ts, price, volume, spread, open_interest, liquidity
        from inserted
       order by market_id, ts desc
    ) n
   where m.id = n.market_id
     and (m.last_snapshot_at is null or n.ts >= m.last_snapshot_at);
  return null;
end;
$fn$;

create trigger market_snapshots_apply_latest
  after insert on public.market_snapshots
  referencing new table as inserted
  for each statement execute function public.markets_apply_latest_snapshot();

-- Backfill from what exists. One-time cost of the sort this migration removes.
update public.markets m
   set last_price = s.price, last_volume = s.volume, last_spread = s.spread,
       last_open_interest = s.open_interest, last_liquidity = s.liquidity, last_snapshot_at = s.ts
  from (
    select distinct on (market_id) market_id, ts, price, volume, spread, open_interest, liquidity
      from public.market_snapshots
     order by market_id, ts desc
  ) s
 where m.id = s.market_id;

-- Same name, same columns, same types. Consumers do not change.
create or replace view public.latest_snapshots
with (security_invoker = true) as
select
  m.id                 as market_id,
  m.last_snapshot_at   as ts,
  m.last_price         as price,
  m.last_volume        as volume,
  m.last_spread        as spread,
  m.last_open_interest as open_interest,
  m.last_liquidity     as liquidity
from public.markets m
where m.last_snapshot_at is not null;

-- --------------------------------------------------------------------------
-- Newest score per (version, market)
-- --------------------------------------------------------------------------
create table public.market_latest_scores (
  model_version_id uuid not null references public.model_versions(id) on delete cascade,
  market_id        text not null references public.markets(id) on delete cascade,
  score_id         uuid not null,
  ts               timestamptz not null,
  side             public.market_side not null,
  score            numeric(3,1) not null,
  breakdown        jsonb not null,
  primary key (model_version_id, market_id)
);

create index market_latest_scores_version_score_idx
  on public.market_latest_scores (model_version_id, score desc);

alter table public.market_latest_scores enable row level security;
create policy market_latest_scores_select on public.market_latest_scores
  for select to authenticated using (true);
revoke all on public.market_latest_scores from anon;

create or replace function public.scores_apply_latest()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.market_latest_scores
    (model_version_id, market_id, score_id, ts, side, score, breakdown)
  select distinct on (model_version_id, market_id)
         model_version_id, market_id, id, ts, side, score, breakdown
    from inserted
   order by model_version_id, market_id, ts desc
  on conflict (model_version_id, market_id) do update
     set score_id  = excluded.score_id,
         ts        = excluded.ts,
         side      = excluded.side,
         score     = excluded.score,
         breakdown = excluded.breakdown
   where excluded.ts >= market_latest_scores.ts;
  return null;
end;
$fn$;

create trigger scores_apply_latest
  after insert on public.scores
  referencing new table as inserted
  for each statement execute function public.scores_apply_latest();

insert into public.market_latest_scores
  (model_version_id, market_id, score_id, ts, side, score, breakdown)
select distinct on (model_version_id, market_id)
       model_version_id, market_id, id, ts, side, score, breakdown
  from public.scores
 order by model_version_id, market_id, ts desc
on conflict do nothing;

create or replace view public.latest_scores
with (security_invoker = true) as
select
  l.score_id as id,
  l.market_id,
  l.model_version_id,
  l.ts,
  l.side,
  l.score,
  l.breakdown
from public.market_latest_scores l;

-- --------------------------------------------------------------------------
-- The Desk in one round-trip
--
-- The page used to call getUser(), then effective_version_for(), then query
-- decision_desk with the result, then model_versions for the label and
-- thresholds -- four sequential network hops before rendering. The view
-- resolves the caller's version itself and carries the version fields along.
-- --------------------------------------------------------------------------
create or replace view public.my_decision_desk
with (security_invoker = true) as
select
  d.*,
  mv.version_label,
  mv.thresholds
from public.decision_desk d
join public.model_versions mv on mv.id = d.model_version_id
where d.model_version_id = public.effective_version_for(auth.uid());

grant select on public.my_decision_desk to authenticated;


-- ===== 20260823002000_signal_hold.sql ==============================

-- ===========================================================================
-- Manual signal holds, and the news signal put on one.
--
-- WHY. signal_health knows two ways for a signal to be off: a performance
-- break (auto-disabled on hit rate) and a cooldown (disabled_until). A signal
-- that is UNAVAILABLE is neither. A disabled row with no disabled_until reads
-- as an expired cooldown and is flipped back to healthy within the hour.
--
-- News is unavailable. Measured directly against GDELT:
--
--   * one request permitted every five seconds (HTTP 429 otherwise)
--   * ~12 seconds per response when permitted
--
-- The scorer fired 60 concurrent requests with a 2.5s timeout, failing on both
-- counts every pass -- and kept doing so every five minutes, collecting 429s
-- from a free public service for nothing. Done politely it is still hopeless:
-- 800 fast-tier markets at one request per five seconds is 67 minutes per
-- pass against a 5-minute cadence. The per-market article search that the
-- signal was designed around cannot run on this source at all.
--
-- A hold is set by a person, states why, and is lifted by a person. The
-- health job leaves held signals alone; the scorer treats them as disabled
-- and does not fetch.
-- ===========================================================================
alter table public.signal_health
  add column hold_reason text;

comment on column public.signal_health.hold_reason is
  'Non-null puts the signal on a manual hold: treated as disabled by the '
  'scorer, never auto-re-enabled by signal-health. For unavailability, not '
  'performance -- performance is what the automatic breaker is for.';

update public.signal_health
   set status          = 'disabled',
       disabled_until  = null,
       disabled_reason = 'Held: source unavailable (see hold_reason).',
       hold_reason     =
         'GDELT permits one request per five seconds and answers in ~12s; '
         'per-market article search cannot run at 800 markets per 5-minute '
         'pass. Held until a viable news source exists. Set by migration '
         '20260823002000 on 2026-09-11.',
       computed_at     = now()
 where signal = 'news';

insert into public.activity_log (event_type, detail, metadata)
values (
  'signal.held',
  'news held: GDELT rate-limited to 1 req/5s with ~12s latency; unusable at platform scale',
  jsonb_build_object('signal', 'news', 'source', 'GDELT', 'rate_limit', '1/5s', 'latency_s', 12)
);


-- ===== 20260823002100_v1_2_thresholds_anchored.sql =================

-- ===========================================================================
-- v1.2 draft: thresholds anchored to the fast-tier distribution, and how.
--
-- The score is a RANKING, not a probability (addendum decision 1). A
-- ranking's thresholds only mean something relative to the distribution they
-- cut, so they are set as tier percentiles of the UNFILTERED scores -- the
-- scorer's own pre-gate report, not the surfaced set, which would be the
-- model grading its own homework.
--
-- Why it matters now: when the news signal was held, activeWeights
-- renormalised and micro went from 60% of the score to 83%. Micro saturates
-- (8c drift, 3x volume, tight book -- routine for near-dated markets), so the
-- ceiling moved from 8.3 to 9.6 and a third of the desk cleared v1.1's
-- absolute strongPick of 7.0. The rank did not change; the labels broke.
-- Percentile anchoring is robust to exactly this: any hold or auto-disable
-- shifts the scale, and absolute thresholds silently break while percentile
-- ones do not.
--
-- Sample: score-markets fast-tier pre-gate report, 2026-09-13 02:41 UTC,
-- news held: scoreP50 4.8, scoreP90 7.1 over 152 considered.
--   surface    = p50 -> 5.0   (rounded to the half-point)
--   strongPick = p90 -> 7.0
-- These are v1's original values. v1.1 lowered surface to 4.0 on a sample
-- with a 1,217-day median horizon; on the tiered universe the original
-- numbers are where the distribution actually sits.
--
-- To redo after any change to weights, holds or selection: read the latest
-- fast-tier byTier block and set surface = round2(scoreP50), strongPick =
-- round2(scoreP90), where round2 rounds to the nearest 0.5.
-- ===========================================================================
update public.model_versions
   set thresholds = thresholds
       || jsonb_build_object('surface', 5.0, 'strongPick', 7.0)
       || jsonb_build_object('anchoring', jsonb_build_object(
            'method',    'tier percentiles of pre-gate scores',
            'tier',      'fast',
            'surface',   'p50',
            'strongPick','p90',
            'sample',    jsonb_build_object(
               'at', '2026-09-13T02:41:00Z', 'considered', 152,
               'scoreP50', 4.8, 'scoreP90', 7.1, 'newsHeld', true))),
       notes = notes || ' Thresholds anchored 2026-09-13 as fast-tier percentiles '
               'of pre-gate scores (p50 4.8 -> surface 5.0, p90 7.1 -> strongPick 7.0); '
               'see thresholds.anchoring for the sample and method.'
 where version_label = 'v1.2'
   and status = 'draft';


-- ===== 20260823002200_horizon_runway_incumbency.sql ================

-- ===========================================================================
-- Horizon from expected expiry; minimum runway; incumbency.
--
-- WHY. The fast tier turned over almost entirely every sweep: 11,890
-- departures in 12 hours against a cap of 800. 9,258 of them left as
-- "settled" with a median of 50 hours still on their close_time. Traced to
-- the source: KXMLBSPREAD-26SEP11... is a game played on September 11 with a
-- close_time of September 14. close_time is a contractual deadline; Kalshi
-- finalizes the market when the game ends and rewrites close_time to the
-- actual close -- but a finalized market leaves the open-events feed, so
-- discovery never sees the correction. expected_expiration_time, which the
-- feed does carry, said September 11 all along.
--
-- Ranking by cumulative volume made it worse: finished games have the most
-- volume, so the tier filled with markets that were already over, ranked
-- to the top precisely because they were over. Each sweep promoted the next
-- batch of corpses. None accumulated the three snapshots drift needs.
--
-- Three changes, all selection tunables on the model version (section 7):
--   * horizon is measured to expected_expiration_time, falling back to
--     close_time only when the expected value is absent;
--   * a market must have fastMinHorizonHours of runway to be PROMOTED to
--     fast -- 15-minute crypto contracts and games in the ninth inning are
--     not worth a slot they cannot use;
--   * an incumbent in the fast tier receives incumbentRankBoost, so it holds
--     its slot until it expires rather than being reshuffled out by a
--     marginally higher-volume newcomer. Stability is what lets history
--     accumulate, which was the point of the tiers.
-- ===========================================================================

alter table public.markets
  add column expected_close timestamptz;

comment on column public.markets.expected_close is
  'Kalshi expected_expiration_time: when the market is expected to actually '
  'end. close_time is a contractual deadline that can sit days later. Horizon '
  'is measured to this.';

update public.model_versions
   set thresholds = jsonb_set(
     thresholds, '{selection}',
     (thresholds->'selection')
       || jsonb_build_object('fastMinHorizonHours', 3, 'incumbentRankBoost', 0.5)
   )
 where jsonb_exists(thresholds, 'selection')
   and not jsonb_exists(thresholds->'selection', 'fastMinHorizonHours');

create or replace function public.assign_cadence_tiers()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $fn$
declare
  sel        jsonb;
  v_fast_h   numeric;
  v_slow_h   numeric;
  v_min_h    numeric;   -- hours of runway required for promotion to fast
  v_spread   integer;
  v_two      boolean;
  v_fast_cap integer;
  v_slow_cap integer;
  v_arch_cap integer;
  v_boost    numeric;
  v_incumb   numeric;
  v_now      timestamptz := now();
  v_result   jsonb;
begin
  select thresholds->'selection' into sel
    from public.model_versions
   where id = public.current_stable_version();

  if sel is null then
    raise exception 'assign_cadence_tiers: stable model version has no selection tunables';
  end if;

  v_fast_h   := (sel->>'fastHorizonDays')::numeric;
  v_slow_h   := (sel->>'slowHorizonDays')::numeric;
  v_min_h    := coalesce((sel->>'fastMinHorizonHours')::numeric, 3);
  v_spread   := (sel->>'maxSpreadCents')::integer;
  v_two      := coalesce((sel->>'requireTwoSidedBook')::boolean, true);
  v_fast_cap := (sel->>'fastCap')::integer;
  v_slow_cap := (sel->>'slowCap')::integer;
  v_arch_cap := (sel->>'archiveCap')::integer;
  v_boost    := coalesce((sel->>'anchorRankBoost')::numeric, 0);
  v_incumb   := coalesce((sel->>'incumbentRankBoost')::numeric, 0);

  create temp table _tier on commit drop as
  with base as (
    select
      m.id,
      m.family,
      m.anchorable,
      m.cadence_tier as current_tier,
      -- Days to the EXPECTED end, not the contractual deadline.
      extract(epoch from (coalesce(m.expected_close, m.close_time) - v_now)) / 86400.0 as horizon,
      coalesce(m.disc_spread, 100)      as spread,
      coalesce(m.disc_two_sided, false) as two_sided,
      log(10, greatest(coalesce(m.disc_volume, 0), 1)::numeric)
        + case when m.anchorable then v_boost else 0 end
        + case when m.cadence_tier = 'fast' then v_incumb else 0 end as rank_score
    from public.markets m
    where m.resolved_at is null
  ),
  classified as (
    select b.*,
      case
        when b.family = 'mve_shard'                       then 'excluded'
        when b.horizon is null                            then 'archive'
        when b.horizon < 0                                then 'excluded'
        -- Fast: near-dated, tradeable book, and either enough runway to be
        -- worth promoting or already in the tier (an incumbent rides its
        -- slot to expiry; it is not re-promoted, it is retained).
        when b.horizon <= v_fast_h
         and (not v_two or b.two_sided)
         and b.spread <= v_spread
         and (b.horizon * 24 >= v_min_h or b.current_tier = 'fast') then 'fast'
        -- Too short to track at any cadence: expires before history exists.
        when b.horizon * 24 < v_min_h                     then 'excluded'
        when b.horizon <= v_slow_h                        then 'slow'
        else                                                   'archive'
      end as want
    from base b
  ),
  fast_pick as (
    select c.id from classified c
     where c.want = 'fast'
     order by c.rank_score desc
     limit v_fast_cap
  ),
  slow_pool as (
    select c.* from classified c
     where c.want = 'slow'
        or (c.want = 'fast' and c.id not in (select f.id from fast_pick f))
  ),
  slow_pick as (
    select s.id from slow_pool s order by s.rank_score desc limit v_slow_cap
  ),
  arch_pool as (
    select c.* from classified c
     where c.want = 'archive'
        or (c.id in (select s.id from slow_pool s)
            and c.id not in (select s.id from slow_pick s))
  ),
  arch_pick as (
    select a.id from arch_pool a order by a.rank_score desc limit v_arch_cap
  ),
  final as (
    select
      c.id,
      c.family,
      round(c.rank_score::numeric, 3) as rank_score,
      c.want,
      c.horizon,
      (case
         when c.id in (select f.id from fast_pick f) then 'fast'
         when c.id in (select s.id from slow_pick s) then 'slow'
         when c.id in (select a.id from arch_pick a) then 'archive'
         else 'excluded'
       end)::public.cadence_tier as tier
    from classified c
  )
  select
    f.id,
    f.family,
    f.rank_score,
    f.want,
    f.tier,
    case
      when f.tier::text = f.want and f.want = 'excluded' and f.horizon < 0
        then 'expired'
      when f.tier::text = f.want and f.want = 'excluded' and f.horizon * 24 < v_min_h
        then 'too short to track'
      when f.tier::text = f.want then 'qualified: ' || f.want
      else 'demoted from ' || f.want || ' (cap)'
    end as reason
  from final f;

  update public.universe_membership um
     set left_at = v_now
    from _tier t
   where um.market_id = t.id
     and um.left_at is null
     and um.tier is distinct from t.tier;

  insert into public.universe_membership (market_id, tier, family, reason, rank_score)
  select t.id, t.tier, t.family, t.reason, t.rank_score
    from _tier t
   where not exists (
     select 1 from public.universe_membership um
      where um.market_id = t.id and um.left_at is null
   );

  update public.markets m
     set cadence_tier = t.tier,
         tier_reason  = t.reason
    from _tier t
   where m.id = t.id
     and (m.cadence_tier is distinct from t.tier
       or m.tier_reason is distinct from t.reason);

  select jsonb_build_object(
    'fast',     count(*) filter (where tier = 'fast'),
    'slow',     count(*) filter (where tier = 'slow'),
    'archive',  count(*) filter (where tier = 'archive'),
    'excluded', count(*) filter (where tier = 'excluded'),
    'tooShort', count(*) filter (where reason = 'too short to track'),
    'demoted',  count(*) filter (where tier::text is distinct from want),
    'total',    count(*)
  ) into v_result from _tier;

  return v_result;
end;
$fn$;


-- ===== 20260823002300_status_and_freshness.sql =====================

-- ===========================================================================
-- Tier eligibility: status, actual close, and freshness.
--
-- WHY. After migration 2200 the tier still emptied: assignment picked 800,
-- and 1,440 of them were marked settled after an average of THREE MINUTES in
-- the tier, with 21 hours of runway by expected_close. They were finalized
-- before promotion. Tested against the live API:
--
--   * Kalshi does not update expected_expiration_time on an early
--     finalization. It updates close_time (to the moment of finalization)
--     and status. A retirement market finalized on 2026-09-09 still reports
--     an expected expiry in 2031.
--   * The events feed carries status on nested markets, and open EVENTS
--     contain finalized MARKETS. Discovery writes that status; assignment
--     never read it.
--   * 246,122 unresolved rows in the table against ~120,000 in the open
--     feed: markets that left the feed (finalized) still carry the future
--     dates of their last sighting, and were eligible on paper.
--
-- Three rules, all cheap, all from data already stored:
--   1. status in (finalized, settled, closed) is not eligible for anything.
--   2. horizon runs to the EARLIER of expected_close and close_time. For a
--      live market close_time is the later contractual deadline, so expected
--      wins; for an early finalization close_time has been rewritten to the
--      past, so it wins.
--   3. a market discovery has not seen within discoveryFreshnessHours is not
--      in the open feed, whatever its dates say. Not eligible.
-- ===========================================================================

update public.model_versions
   set thresholds = jsonb_set(
     thresholds, '{selection}',
     (thresholds->'selection') || jsonb_build_object('discoveryFreshnessHours', 2)
   )
 where jsonb_exists(thresholds, 'selection')
   and not jsonb_exists(thresholds->'selection', 'discoveryFreshnessHours');

create index if not exists markets_disc_seen_idx on public.markets (disc_seen_at)
  where resolved_at is null;

create or replace function public.assign_cadence_tiers()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $fn$
declare
  sel        jsonb;
  v_fast_h   numeric;
  v_slow_h   numeric;
  v_min_h    numeric;
  v_fresh_h  numeric;
  v_spread   integer;
  v_two      boolean;
  v_fast_cap integer;
  v_slow_cap integer;
  v_arch_cap integer;
  v_boost    numeric;
  v_incumb   numeric;
  v_now      timestamptz := now();
  v_result   jsonb;
begin
  select thresholds->'selection' into sel
    from public.model_versions
   where id = public.current_stable_version();

  if sel is null then
    raise exception 'assign_cadence_tiers: stable model version has no selection tunables';
  end if;

  v_fast_h   := (sel->>'fastHorizonDays')::numeric;
  v_slow_h   := (sel->>'slowHorizonDays')::numeric;
  v_min_h    := coalesce((sel->>'fastMinHorizonHours')::numeric, 3);
  v_fresh_h  := coalesce((sel->>'discoveryFreshnessHours')::numeric, 2);
  v_spread   := (sel->>'maxSpreadCents')::integer;
  v_two      := coalesce((sel->>'requireTwoSidedBook')::boolean, true);
  v_fast_cap := (sel->>'fastCap')::integer;
  v_slow_cap := (sel->>'slowCap')::integer;
  v_arch_cap := (sel->>'archiveCap')::integer;
  v_boost    := coalesce((sel->>'anchorRankBoost')::numeric, 0);
  v_incumb   := coalesce((sel->>'incumbentRankBoost')::numeric, 0);

  create temp table _tier on commit drop as
  with base as (
    select
      m.id,
      m.family,
      m.anchorable,
      m.cadence_tier as current_tier,
      coalesce(m.status, '') in ('finalized', 'settled', 'closed')       as ended,
      m.disc_seen_at is null
        or m.disc_seen_at < v_now - make_interval(hours => v_fresh_h::int) as stale,
      -- The EARLIER of expected and actual close. See header.
      extract(epoch from (least(coalesce(m.expected_close, m.close_time), m.close_time) - v_now))
        / 86400.0 as horizon,
      coalesce(m.disc_spread, 100)      as spread,
      coalesce(m.disc_two_sided, false) as two_sided,
      log(10, greatest(coalesce(m.disc_volume, 0), 1)::numeric)
        + case when m.anchorable then v_boost else 0 end
        + case when m.cadence_tier = 'fast' then v_incumb else 0 end as rank_score
    from public.markets m
    where m.resolved_at is null
  ),
  classified as (
    select b.*,
      case
        when b.ended                                      then 'excluded'
        when b.stale                                      then 'excluded'
        when b.family = 'mve_shard'                       then 'excluded'
        when b.horizon is null                            then 'archive'
        when b.horizon < 0                                then 'excluded'
        when b.horizon <= v_fast_h
         and (not v_two or b.two_sided)
         and b.spread <= v_spread
         and (b.horizon * 24 >= v_min_h or b.current_tier = 'fast') then 'fast'
        when b.horizon * 24 < v_min_h                     then 'excluded'
        when b.horizon <= v_slow_h                        then 'slow'
        else                                                   'archive'
      end as want
    from base b
  ),
  fast_pick as (
    select c.id from classified c
     where c.want = 'fast'
     order by c.rank_score desc
     limit v_fast_cap
  ),
  slow_pool as (
    select c.* from classified c
     where c.want = 'slow'
        or (c.want = 'fast' and c.id not in (select f.id from fast_pick f))
  ),
  slow_pick as (
    select s.id from slow_pool s order by s.rank_score desc limit v_slow_cap
  ),
  arch_pool as (
    select c.* from classified c
     where c.want = 'archive'
        or (c.id in (select s.id from slow_pool s)
            and c.id not in (select s.id from slow_pick s))
  ),
  arch_pick as (
    select a.id from arch_pool a order by a.rank_score desc limit v_arch_cap
  ),
  final as (
    select
      c.id, c.family, c.ended, c.stale, c.horizon,
      round(c.rank_score::numeric, 3) as rank_score,
      c.want,
      (case
         when c.id in (select f.id from fast_pick f) then 'fast'
         when c.id in (select s.id from slow_pick s) then 'slow'
         when c.id in (select a.id from arch_pick a) then 'archive'
         else 'excluded'
       end)::public.cadence_tier as tier
    from classified c
  )
  select
    f.id, f.family, f.rank_score, f.want, f.tier,
    case
      when f.tier::text = f.want and f.want = 'excluded' and f.ended               then 'finalized'
      when f.tier::text = f.want and f.want = 'excluded' and f.stale               then 'not in open feed'
      when f.tier::text = f.want and f.want = 'excluded' and f.horizon < 0         then 'expired'
      when f.tier::text = f.want and f.want = 'excluded' and f.horizon * 24 < v_min_h then 'too short to track'
      when f.tier::text = f.want then 'qualified: ' || f.want
      else 'demoted from ' || f.want || ' (cap)'
    end as reason
  from final f;

  update public.universe_membership um
     set left_at = v_now
    from _tier t
   where um.market_id = t.id
     and um.left_at is null
     and um.tier is distinct from t.tier;

  insert into public.universe_membership (market_id, tier, family, reason, rank_score)
  select t.id, t.tier, t.family, t.reason, t.rank_score
    from _tier t
   where not exists (
     select 1 from public.universe_membership um
      where um.market_id = t.id and um.left_at is null
   );

  update public.markets m
     set cadence_tier = t.tier,
         tier_reason  = t.reason
    from _tier t
   where m.id = t.id
     and (m.cadence_tier is distinct from t.tier
       or m.tier_reason is distinct from t.reason);

  select jsonb_build_object(
    'fast',      count(*) filter (where tier = 'fast'),
    'slow',      count(*) filter (where tier = 'slow'),
    'archive',   count(*) filter (where tier = 'archive'),
    'excluded',  count(*) filter (where tier = 'excluded'),
    'finalized', count(*) filter (where reason = 'finalized'),
    'stale',     count(*) filter (where reason = 'not in open feed'),
    'tooShort',  count(*) filter (where reason = 'too short to track'),
    'demoted',   count(*) filter (where tier::text is distinct from want),
    'total',     count(*)
  ) into v_result from _tier;

  return v_result;
end;
$fn$;


-- ===== 20260823002400_v1_2_reanchored.sql ==========================

-- ===========================================================================
-- v1.2 draft: thresholds re-anchored on the stable universe.
--
-- The 2026-09-13 anchoring (surface 5.0 / strongPick 7.0) was measured on a
-- fast tier that was mostly finished games, with price histories truncated
-- to the oldest 1,000 rows per batch. Neither fact was known at the time.
-- Both are fixed (migrations 2200-2300, and the paged history load), and
-- the tier has now held stable -- ~790 markets, single-digit churn per
-- sweep -- for several hours with complete histories.
--
-- Sample: score-markets fast-tier pre-gate report, 2026-09-14 02:26 UTC,
-- news held, skippedNoData 0, 794 considered:
--   scoreP50 4.2 -> surface    4.0
--   scoreP90 7.6 -> strongPick 7.5
--   sepP50 0.5, sepP90 4.6, sepMax 5.0; 362 scored with a direction.
--
-- Same method as before (tier percentiles of pre-gate scores, rounded to the
-- half-point). Note that surface lands exactly where v1.1 had put it: the
-- stopgap was the right number for the wrong reason, and this is the same
-- number for the right one. The reason is what a later reader needs.
-- ===========================================================================
update public.model_versions
   set thresholds = thresholds
       || jsonb_build_object('surface', 4.0, 'strongPick', 7.5)
       || jsonb_build_object('anchoring', jsonb_build_object(
            'method',    'tier percentiles of pre-gate scores',
            'tier',      'fast',
            'surface',   'p50',
            'strongPick','p90',
            'sample',    jsonb_build_object(
               'at', '2026-09-14T02:26:00Z', 'considered', 794, 'skippedNoData', 0,
               'scoreP50', 4.2, 'scoreP90', 7.6, 'sepP50', 0.5, 'sepP90', 4.6,
               'newsHeld', true, 'universeStable', true))),
       notes = regexp_replace(notes, ' Thresholds anchored 2026-09-13.*$', '')
               || ' Thresholds re-anchored 2026-09-14 on the stable universe with complete '
               'histories (p50 4.2 -> surface 4.0, p90 7.6 -> strongPick 7.5); the 09-13 '
               'sample was finished games on truncated history. See thresholds.anchoring.'
 where version_label = 'v1.2'
   and status = 'draft';


-- ===== 20260823002500_desk_lifecycle.sql ===========================

-- ===========================================================================
-- The Decision Desk applies the same lifecycle rules as tier assignment.
--
-- WHY. The desk showed finished games. The view hid a market only when
-- resolved_at was set or close_time had passed. For an early finalization
-- our close_time is still the contractual deadline days out, resolved_at
-- lands only when the resolution job reaches the market -- behind a queue
-- of stale rows -- and the last score from before the market ended is still
-- its latest. A finished game, with a confident-looking score, on the desk.
--
-- Tier assignment already knows how to tell a live market from a dead one
-- (migration 2300). The desk now applies the same tests, plus one of its
-- own: the score must be fresh. A market whose latest score is older than
-- two hours is no longer being scored -- it left the fast tier, or scoring
-- is broken -- and either way the desk must not present it as current.
--
-- Same name, same columns, so the member app and my_decision_desk are
-- unchanged.
-- ===========================================================================
create or replace view public.decision_desk
with (security_invoker = true) as
select
  m.id            as market_id,
  m.question,
  m.category,
  m.close_time,
  ls.model_version_id,
  ls.side,
  ls.score,
  ls.breakdown,
  ls.ts           as scored_at,
  snap.price      as yes_price,
  snap.volume,
  snap.spread,
  snap.liquidity,
  case when ls.side = 'YES' then snap.price else 100 - snap.price end as side_price
from public.markets m
join public.latest_scores ls on ls.market_id = m.id
left join public.latest_snapshots snap on snap.market_id = m.id
where m.resolved_at is null
  -- Not ended, by the field Kalshi actually updates on early finalization.
  and coalesce(m.status, '') not in ('finalized', 'settled', 'closed')
  -- Still in the priced universe. 'excluded' covers settled, expired, stale,
  -- too-short and shards.
  and m.cadence_tier <> 'excluded'
  -- Not past the EARLIER of expected and actual close.
  and (m.close_time is null
       or least(coalesce(m.expected_close, m.close_time), m.close_time) > now())
  -- Scored recently. Fast tier scores every five minutes; slow hourly.
  and ls.ts > now() - interval '2 hours';


-- ===== 20260823002600_retention.sql ================================

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


-- ===== 20260823002700_bloat_and_membership.sql =====================

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


-- ===== 20260823002800_calibration.sql ==============================

-- ===========================================================================
-- Calibration: what the model actually gets right, net of fees.
--
-- The learning loop labels every scored market at resolution. This turns
-- those labels into the one table that decides whether the platform makes
-- money: for each tier and score band, how often the model's side won, with
-- a confidence interval, at what average entry price, and what that was
-- worth per contract after Kalshi's trading fee.
--
-- Three things are deliberate:
--
--   * The label is the SCORE'S SIDE versus the outcome. v1 theses carry no
--     direction (thesis_type 'none'), so thesis_correct is null on every
--     row; the model's call is payload.side, and that is what gets graded.
--   * Only labels since calibration_start count. Before the universe fix
--     (2026-09-14 01:22 UTC) the fast tier was mostly finished games; a label
--     on a market that was already over is not evidence about anything.
--   * The bar is BREAKEVEN, not 50%. At 60c a side must be right more than
--     61.4% of the time to make money after fees. Every bucket reports its
--     hit rate against the breakeven rate at its average price, and the
--     recommendation only counts a band as edge when the LOWER confidence
--     bound clears that bar with enough sample to mean it.
-- ===========================================================================

insert into public.platform_settings (key, value) values
  ('calibration_start',      '"2026-09-14T02:00:00Z"'::jsonb),
  ('calibration_min_sample', '30'::jsonb)
on conflict (key) do nothing;

-- Kalshi's general trading fee: 7% of price x (1 - price), per contract,
-- rounded up to the cent. Matches kalshiFeeCents in the shared package.
create or replace function public.kalshi_fee_cents(p_price integer, p_contracts integer default 1)
returns integer
language sql
immutable
as $fn$
  select ceil(0.07 * p_contracts * (p_price / 100.0) * (1 - p_price / 100.0) * 100)::integer;
$fn$;

-- --------------------------------------------------------------------------
-- One row per labelled thesis, with its economics.
-- --------------------------------------------------------------------------
create or replace view public.calibration_rows
with (security_invoker = true) as
select
  t.id                                          as thesis_id,
  t.market_id,
  t.model_version_id,
  t.created_at                                  as labelled_at,
  (t.payload->>'side')::public.market_side      as side,
  (t.payload->>'resolved_outcome')::public.market_side as outcome,
  (t.payload->>'score')::numeric                as score,
  floor((t.payload->>'score')::numeric)::int    as band,
  (t.payload->>'price')::int                    as price,
  -- Tier at the time: from the payload once the scorer records it; before
  -- that, the last priced tier in the point-in-time membership log.
  coalesce(t.payload->>'tier', um.tier::text)   as tier,
  coalesce(t.payload->>'category', m.category)  as category,
  (t.payload->>'side') = (t.payload->>'resolved_outcome') as hit,
  case
    when (t.payload->>'price') is null then null
    when (t.payload->>'side') = (t.payload->>'resolved_outcome')
      then 100 - (t.payload->>'price')::int - public.kalshi_fee_cents((t.payload->>'price')::int)
    else - (t.payload->>'price')::int - public.kalshi_fee_cents((t.payload->>'price')::int)
  end                                           as net_cents
from public.edge_theses t
join public.markets m on m.id = t.market_id
left join lateral (
  select u.tier from public.universe_membership u
   where u.market_id = t.market_id and u.tier <> 'excluded'
   order by u.entered_at desc limit 1
) um on true
where t.payload ? 'final_state'
  and t.payload ? 'side'
  and t.payload ? 'resolved_outcome'
  and t.created_at >= (
    select (value #>> '{}')::timestamptz from public.platform_settings where key = 'calibration_start'
  );

grant select on public.calibration_rows to authenticated;

-- --------------------------------------------------------------------------
-- Buckets: tier x score band (and optionally category).
-- --------------------------------------------------------------------------
create or replace function public.calibration_table(
  p_version uuid default null,
  p_by_category boolean default false
)
returns table (
  tier            text,
  category        text,
  band            integer,
  n               bigint,
  hits            bigint,
  hit_rate        numeric,
  ci_low          numeric,
  ci_high         numeric,
  avg_price       numeric,
  breakeven_rate  numeric,
  avg_net_cents   numeric,
  priced_n        bigint
)
language sql
security definer
set search_path = public
stable
as $fn$
  with rows as (
    select * from public.calibration_rows r
     where (p_version is null or r.model_version_id = p_version)
       and r.tier is not null
  ),
  g as (
    select
      r.tier,
      case when p_by_category then r.category else '*' end as category,
      r.band,
      count(*)::bigint                                      as n,
      count(*) filter (where r.hit)::bigint                 as hits,
      avg(r.price)                                          as avg_price,
      avg(r.net_cents)                                      as avg_net_cents,
      count(r.price)::bigint                                as priced_n
    from rows r
    group by 1, 2, 3
  ),
  w as (
    -- Wilson score interval, z = 1.96. Honest at small n where the naive
    -- p +/- 1.96*sqrt(p(1-p)/n) is not.
    select g.*,
      (hits::numeric / n) as p,
      1.96 as z
    from g
  )
  select
    w.tier, w.category, w.band, w.n, w.hits,
    round(w.p, 3) as hit_rate,
    round(( (w.p + w.z*w.z/(2*w.n)) - w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_low,
    round(( (w.p + w.z*w.z/(2*w.n)) + w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_high,
    round(w.avg_price, 1) as avg_price,
    case when w.avg_price is null then null
         else round((w.avg_price + public.kalshi_fee_cents(round(w.avg_price)::int)) / 100.0, 3) end as breakeven_rate,
    round(w.avg_net_cents, 2) as avg_net_cents,
    w.priced_n
  from w
  order by w.tier, w.category, w.band;
$fn$;

grant execute on function public.calibration_table(uuid, boolean) to authenticated;

-- --------------------------------------------------------------------------
-- Recommendations, derived from the buckets rather than from opinion.
--
-- A band is EDGE when its lower confidence bound on hit rate clears the
-- breakeven rate at its average price and the sample is at least
-- calibration_min_sample. Suggested surface = the lowest edge band in the
-- tier; suggested strongPick = the lowest band whose average net P&L per
-- contract is at least 5c with the same sample floor. Absent evidence, the
-- recommendation says so rather than guessing.
-- --------------------------------------------------------------------------
create or replace function public.calibration_recommendations(p_version uuid default null)
returns table (
  tier                text,
  labelled            bigint,
  edge_bands          integer[],
  suggested_surface   numeric,
  suggested_strong    numeric,
  verdict             text
)
language plpgsql
security definer
set search_path = public
stable
as $fn$
declare
  v_min integer := public.setting_numeric('calibration_min_sample', 30)::integer;
begin
  return query
  with t as (
    select * from public.calibration_table(p_version, false)
  ),
  judged as (
    select t.tier, t.band, t.n, t.avg_net_cents,
           (t.n >= v_min and t.breakeven_rate is not null and t.ci_low > t.breakeven_rate) as is_edge,
           (t.n >= v_min and t.avg_net_cents >= 5) as is_strong
    from t
  )
  select
    j.tier,
    sum(j.n)::bigint as labelled,
    coalesce(array_agg(j.band order by j.band) filter (where j.is_edge), '{}') as edge_bands,
    min(j.band) filter (where j.is_edge)::numeric as suggested_surface,
    min(j.band) filter (where j.is_strong)::numeric as suggested_strong,
    case
      when sum(j.n) < v_min then format('%s labels; need %s per band before this means anything', sum(j.n), v_min)
      when count(*) filter (where j.is_edge) = 0 then 'no band clears breakeven at its confidence floor yet'
      else format('edge in bands %s; surface at %s', array_agg(j.band order by j.band) filter (where j.is_edge), min(j.band) filter (where j.is_edge))
    end as verdict
  from judged j
  group by j.tier
  order by j.tier;
end;
$fn$;

grant execute on function public.calibration_recommendations(uuid) to authenticated;


-- ===== 20260823002900_digest_cron.sql ==============================

-- ===========================================================================
-- Weekly model review digest to admins.
--
-- Mondays 14:00 UTC (morning in the US), after the weekend's sports markets
-- have resolved and been labelled. The digest reports what the calibration
-- SQL concluded -- edge bands, suggested thresholds, or "not enough
-- evidence" -- and never changes anything: a version change is a decision.
-- ===========================================================================
select cron.schedule(
  'oe-model-review-digest', '0 14 * * 1',
  $cron$ select public.invoke_edge_function('model-review-digest'); $cron$
);


-- ===== 20260823003000_calibration_priced.sql =======================

-- ===========================================================================
-- Calibration: net and hit rate on the SAME population.
--
-- The first real digest showed band 5 at a 53% hit rate against a 55%
-- breakeven with net -21.8c per contract. Those numbers cannot both describe
-- the same rows: net is averaged over labels that carry an entry price --
-- only recorded since 2026-09-14 -- while hit rate covered every label. Two
-- populations in one row, and the smaller one silently drove the verdict.
--
-- Every bucket now reports the priced subset's own hit rate beside its net,
-- and the strong recommendation requires the priced sample to meet the same
-- floor as everything else. Until enough priced labels exist, net stays
-- informative-but-thin rather than authoritative.
-- ===========================================================================

drop function if exists public.calibration_table(uuid, boolean);

create or replace function public.calibration_table(
  p_version uuid default null,
  p_by_category boolean default false
)
returns table (
  tier            text,
  category        text,
  band            integer,
  n               bigint,
  hits            bigint,
  hit_rate        numeric,
  ci_low          numeric,
  ci_high         numeric,
  priced_n        bigint,
  priced_hit_rate numeric,
  avg_price       numeric,
  breakeven_rate  numeric,
  avg_net_cents   numeric
)
language sql
security definer
set search_path = public
stable
as $fn$
  with rows as (
    select * from public.calibration_rows r
     where (p_version is null or r.model_version_id = p_version)
       and r.tier is not null
  ),
  g as (
    select
      r.tier,
      case when p_by_category then r.category else '*' end as category,
      r.band,
      count(*)::bigint                                          as n,
      count(*) filter (where r.hit)::bigint                     as hits,
      count(r.price)::bigint                                    as priced_n,
      count(*) filter (where r.hit and r.price is not null)::bigint as priced_hits,
      avg(r.price)                                              as avg_price,
      avg(r.net_cents)                                          as avg_net_cents
    from rows r
    group by 1, 2, 3
  ),
  w as (
    select g.*, (hits::numeric / n) as p, 1.96 as z from g
  )
  select
    w.tier, w.category, w.band, w.n, w.hits,
    round(w.p, 3) as hit_rate,
    round(( (w.p + w.z*w.z/(2*w.n)) - w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_low,
    round(( (w.p + w.z*w.z/(2*w.n)) + w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_high,
    w.priced_n,
    case when w.priced_n = 0 then null else round(w.priced_hits::numeric / w.priced_n, 3) end as priced_hit_rate,
    round(w.avg_price, 1) as avg_price,
    case when w.avg_price is null then null
         else round((w.avg_price + public.kalshi_fee_cents(round(w.avg_price)::int)) / 100.0, 3) end as breakeven_rate,
    round(w.avg_net_cents, 2) as avg_net_cents
  from w
  order by w.tier, w.category, w.band;
$fn$;

grant execute on function public.calibration_table(uuid, boolean) to authenticated;

-- Return shape changes (adds `priced`), so the old definition has to go first.
drop function if exists public.calibration_recommendations(uuid);

create or replace function public.calibration_recommendations(p_version uuid default null)
returns table (
  tier                text,
  labelled            bigint,
  priced              bigint,
  edge_bands          integer[],
  suggested_surface   numeric,
  suggested_strong    numeric,
  verdict             text
)
language plpgsql
security definer
set search_path = public
stable
as $fn$
declare
  v_min integer := public.setting_numeric('calibration_min_sample', 30)::integer;
begin
  return query
  with t as (
    select * from public.calibration_table(p_version, false)
  ),
  judged as (
    select t.tier, t.band, t.n, t.priced_n, t.avg_net_cents,
           -- Edge: the hit rate's lower bound clears breakeven, on a full sample.
           (t.n >= v_min and t.breakeven_rate is not null and t.ci_low > t.breakeven_rate) as is_edge,
           -- Strong: at least 5c net per contract, on a PRICED sample that
           -- meets the same floor. Ten priced rows do not get to set a
           -- threshold members trade on.
           (t.priced_n >= v_min and t.avg_net_cents >= 5) as is_strong
    from t
  )
  select
    j.tier,
    sum(j.n)::bigint as labelled,
    sum(j.priced_n)::bigint as priced,
    coalesce(array_agg(j.band order by j.band) filter (where j.is_edge), '{}') as edge_bands,
    min(j.band) filter (where j.is_edge)::numeric as suggested_surface,
    min(j.band) filter (where j.is_strong)::numeric as suggested_strong,
    case
      when sum(j.n) < v_min then format('%s labels; need %s per band before this means anything', sum(j.n), v_min)
      when count(*) filter (where j.is_edge) = 0 and sum(j.priced_n) < v_min
        then format('no band clears breakeven at its confidence floor yet; %s of %s labels carry an entry price, so net is thin', sum(j.priced_n), sum(j.n))
      when count(*) filter (where j.is_edge) = 0 then 'no band clears breakeven at its confidence floor yet'
      else format('edge in bands %s; surface at %s', array_agg(j.band order by j.band) filter (where j.is_edge), min(j.band) filter (where j.is_edge))
    end as verdict
  from judged j
  group by j.tier
  order by j.tier;
end;
$fn$;

grant execute on function public.calibration_recommendations(uuid) to authenticated;


-- ===== 20260823003100_anchors.sql ==================================

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


-- ===== 20260823003200_anchors_cron.sql =============================

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


-- ===== record these migrations as applied =========================
create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version    text not null primary key,
  statements text[],
  name       text
);

insert into supabase_migrations.schema_migrations (version)
values
  ('20260823000100'),
  ('20260823000200'),
  ('20260823000300'),
  ('20260823000400'),
  ('20260823000600'),
  ('20260823000700'),
  ('20260823000800'),
  ('20260823000900'),
  ('20260823001000'),
  ('20260823001100'),
  ('20260823001200'),
  ('20260823001300'),
  ('20260823001400'),
  ('20260823001500'),
  ('20260823001600'),
  ('20260823001700'),
  ('20260823001800'),
  ('20260823001900'),
  ('20260823002000'),
  ('20260823002100'),
  ('20260823002200'),
  ('20260823002300'),
  ('20260823002400'),
  ('20260823002500'),
  ('20260823002600'),
  ('20260823002700'),
  ('20260823002800'),
  ('20260823002900'),
  ('20260823003000'),
  ('20260823003100'),
  ('20260823003200')
on conflict (version) do nothing;

commit;
