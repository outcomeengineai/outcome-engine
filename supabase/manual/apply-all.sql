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
  ('20260823000800')
on conflict (version) do nothing;

commit;
