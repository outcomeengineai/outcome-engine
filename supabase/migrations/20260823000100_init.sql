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
