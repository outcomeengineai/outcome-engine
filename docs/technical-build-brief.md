# Outcome Engine — Technical Build Brief

Companion to [design-brief.md](./design-brief.md) (product/screen spec). This
document covers stack, data model, architecture, and build order. Where they
conflict, the design brief wins on UX; this wins on architecture.

## What we're building

Two clients, one backend:

- **Member app:** React Native (Expo) — iOS/Android. Trading experience.
- **Admin dashboard:** React (Next.js) on Vercel. Management surface.
- **Backend:** Supabase (Postgres, Auth, Row-Level Security, scheduled Edge
  Functions, Vault for secrets) + Stripe (billing/invoices).

Scale target: ~20 invited users. Optimize for correctness and simplicity, not
scale.

## Stack decisions (already made — don't re-litigate)

- **Supabase:** managed Postgres, built-in auth (email/magic link), RLS for
  member-vs-admin data scoping, scheduled functions for ingestion, Vault for
  Kalshi API keys
- **Vercel:** hosts the Next.js admin dashboard
- **Expo/React Native:** member app; push notifications via Expo's push service
- **Stripe:** card on file, monthly invoicing (use Stripe Billing/Invoicing
  rather than hand-rolling invoice records). Cash App/Venmo debit cards run
  through the same card rail. Rare P2P-balance payments handled by an admin
  "mark as paid" override
- **Kalshi API v2:** REST + WebSocket. Auth is API-key + RSA-PSS request
  signing; tokens expire ~30 min, so server-side auth must handle re-auth.
  Public market data needs no auth; trading/portfolio calls use each USER'S OWN
  key
- **Shared TypeScript package** for logic used by both clients (fee math, score
  display rules, types)

## Non-negotiable security rules

- Each user supplies their OWN Kalshi API key. Never route multiple users
  through one master key (Kalshi's developer agreement prohibits sublicensing).
- Kalshi keys live in Supabase Vault (or app-layer encryption with the key held
  outside the DB). Never in a plain table column, never logged, never sent to
  clients after entry.
- Keys are used server-side only (Edge Functions). The mobile app never holds a
  Kalshi key after the connect flow submits it.
- Request minimum scope. Trading requires trade permission; never
  request/withdrawal scope beyond what's needed.
- RLS on every table: members read/write only their own rows; admin role reads
  all. Roles: `admin`, `member` (role-based so co-admins can be added later).

## Data model (Postgres)

Types/columns are directional — refine as needed, but keep every entity and
relationship.

```
users: id (=auth.uid), email, display_name, role ('admin'|'member'),
       account_status ('active'|'grace'|'paused'|'inactive'|'removed'),
       last_trade_at, created_at

kalshi_connections: user_id FK, vault_secret_ref, kalshi_username,
       permission_scope, status ('connected'|'error'|'revoked'), connected_at

payment_methods: user_id FK, stripe_customer_id, stripe_pm_id, is_primary

model_versions: id, version_label ('v1','v2',...), status ('draft'|'stable'|'deprecated'),
       weights JSONB  -- { default: {micro,news,base}, overrides: { Economics: {...}, ... } }
       thresholds JSONB, risk_limits JSONB, created_at, published_at, deprecated_at

markets: id (kalshi ticker), question, category, close_time, resolved_at, outcome

market_snapshots: market_id FK, ts, price, volume, spread, open_interest, liquidity
       -- time-series; see retention policy

scores: id, market_id FK, model_version_id FK, ts, side ('YES'|'NO'),
       score NUMERIC(3,1), breakdown JSONB {micro,news,base}

tags: id, market_id FK NULL, trade_id FK NULL, tag_type, severity ('info'|'caution'),
       text, source ('auto'|'manual'), created_by FK NULL, created_at
       -- market-level (pre-trade) OR trade-level; at least one FK set

trades: id, user_id FK, market_id FK, model_version_id FK, mode ('paper'|'live'),
       side, entry_price, contracts, entry_score, kalshi_order_id,
       status ('pending'|'open'|'resolved'|'failed'), opened_at

trade_resolutions: trade_id FK, outcome ('win'|'loss'), pnl, resolved_at

billing_periods: user_id FK, period_start, period_end, gross_wins, gross_losses,
       net_pnl, fee_owed, stripe_invoice_id,
       status ('open'|'invoiced'|'paid'|'failed'|'grace'|'waived')

payments: billing_period_id FK, amount, method ('stripe'|'manual'), status, paid_at,
       marked_by FK NULL  -- admin id for manual mark-as-paid

notifications: user_id FK, type, payload JSONB, sent_at, read_at

signal_health: signal ('micro'|'news'|'base'), window_size, win_rate, sample_count,
       status ('healthy'|'degraded'|'disabled'), disabled_until, computed_at

platform_settings: key, value JSONB  -- inactivity_threshold_days, trading_paused,
       kill_switch, fee_rate (0.20), etc.

activity_log: id, user_id FK NULL, event_type, detail, metadata JSONB, ts
```

### Invariants

- Every trade permanently keeps its `model_version_id` and `entry_score` —
  never backfill on retune. This is the backtest/calibration dataset.
- `mode='paper'` rows NEVER enter billing calculations.
- Fee = 20% × max(0, net_pnl) per billing period (net-profit basis; losses
  offset wins). Rate read from `platform_settings`, not hardcoded.

## Core services (Supabase Edge Functions / scheduled jobs)

### 1. Market ingestion (scheduled, every few minutes)

- Poll ACTIVE Kalshi markets (public endpoints, no user key needed) → insert
  `market_snapshots`
- Poll per-MARKET, not per-user; users fan out from shared market data
- Respect Kalshi rate limits; back off on 429s
- Retention: raw snapshots kept 30 days, then rolled up to daily aggregates
  (scheduled pruning job)

### 2. Scoring engine (runs after ingestion)

- For each active market, compute per-signal sub-scores (microstructure, news,
  base rate), apply the STABLE model_version's weights (category override if
  present, else default), pick the stronger side (YES/NO), write to `scores`
- v1 weighting: microstructure heaviest; news moderate (directional
  confirmation); base rate light until enough resolved history exists
- News signal: news API (NewsAPI or GDELT) keyword-matched per market; cache per
  market, don't fetch per user
- Rule-based auto-tagging in the same pass (volume spike w/o news, low
  liquidity, sentiment/price divergence). Tags carry severity `info|caution`
- If both sides score weakly, the market simply falls below the surfacing
  threshold — no third "no edge" state

### 3. Trade execution (invoked from member app)

- Validate: user active, not paused, kill switch off, live-mode stake ≤ Kalshi
  balance
- Paper: record trade locally, no Kalshi call
- Live: place order via the user's own key (from Vault), store
  `kalshi_order_id`, handle partial fills/failures explicitly — a trade is
  `pending` until confirmed; failed orders must surface to the user, never
  silently swallowed

### 4. Resolution sync (scheduled)

- Detect resolved markets; for each affected live trade, pull settlement from
  the user's Kalshi account, write `trade_resolutions` with real PnL; resolve
  paper trades against market outcome
- Update `signal_health` rolling stats and per-category calibration data

### 5. Billing (scheduled, monthly)

- Close each user's billing_period: sum live-trade PnL, fee = 20% × max(0, net)
- Create Stripe invoice, auto-charge card; on failure → status `grace`, notify,
  and after the grace window (configurable) set `account_status` `paused`
- Admin can `mark as paid` (manual payment) or `waive`

### 6. Signal health monitor (scheduled)

- Rolling win-rate per signal over last N resolved trades (default 100)
- Auto-disable a signal when rules trip (accuracy drop >10%, below min win rate,
  drawdown, correlation spike) with a cooldown (default 24h); notify admin;
  scoring engine excludes disabled signals and renormalizes weights

### 7. Inactivity flagging (scheduled, daily)

- `account_status` `inactive` flag when `now - last_trade_at >
  inactivity_threshold_days`
- Flag only; removal is always a manual admin action

### 8. Notifications

Expo push + in-app notification rows for: model version published (incl.
re-scored open trades + recommendation), trade resolved, billing events, grace
period, admin alerts (signal disabled, payment failures, execution failures)

## Model versioning behavior

- Publishing a new version: previous stable enters a transition window (default
  2 weeks) during which each user can pick which stable version scores their
  view; after expiry, old version auto-deprecates
- Retune notifications: any OPEN trade whose market's score materially changed
  under the new version → notify with new score + recommendation
- Simulate/backtest: run a draft version against historical snapshots + resolved
  outcomes; compare equity curves vs live version; "promote to live" = publish
  flow (admin confirm)

## Build order

1. Supabase project setup: schema, RLS policies, roles, Vault
2. Ingestion job + verify snapshots landing (testable before any UI)
3. Scoring engine v1 + auto-tagging; sanity-check scores against live markets
4. Next.js admin shell: auth, Accounts, Activity, Settings (incl. pause/kill
   switch), Strategy Config (weights + per-category overrides), Signal Health
   (read-only first)
5. Expo member app: onboarding flow (invite → auth → explainer → agreement →
   Stripe → Kalshi connect), Home, Decision Desk (paper mode first)
6. Trade execution: paper end-to-end, then live with a single test account (the
   owner's) before anyone else
7. Resolution sync + Positions/Performance
8. Billing: Stripe integration, monthly job, invoices, grace/pause flow —
   verify math manually for a full cycle before enabling auto-charge
9. Notifications, Simulate/backtest, tag review UI, inactivity flagging
10. Beta: invite 2–3 friends first, watch a full billing cycle, then the rest

## Env/secrets checklist (owner provides; never commit)

- Supabase URL + anon key + service role key
- Stripe secret key + webhook secret
- News API key
- Owner's Kalshi API key (for testing) — users add their own via the app
- Expo push credentials

## Deferred (do NOT build in v1)

- Model comparison dashboard beyond Simulate's two-curve overlay
- Auto-adjusting weights (v1 is manual retune only; later: system proposes →
  admin approves; autonomous much later)
- Per-category signal health
- Usage tiers / tier-discounted fee rates
- Polymarket integration

---

## Implementation notes (added during the build)

Deviations and decisions worth knowing, each made for a stated reason:

**Kalshi auth needs no re-auth loop.** The brief anticipates ~30-minute token
expiry. API-key + RSA-PSS signing has no session token at all — each request is
signed independently over `timestamp + METHOD + path`. What matters instead is
clock drift: a function whose time has slipped sees 401s that look like bad
credentials.

**Three tables were added.** `invites` (the onboarding flow starts from a code,
so the codes have to live somewhere), `devices` (Expo push targets),
`news_cache` (keyed by market, which is what makes "cache per market, don't
fetch per user" real), plus `backtest_runs` and `signal_health_history` for the
Simulate and Signal Health screens.

**Auto tags are replaced, not upserted.** A partial unique index cannot be
inferred by PostgREST's `onConflict`, and — more importantly — replacing them
lets a tag *disappear* when its condition stops holding. Manual tags are exempt
so an admin's correction survives the next scoring pass.

**Fill details stay writable while a trade is `pending`.** The freeze trigger
protects `model_version_id`, `entry_score` and `mode` from the moment the row
exists, but a partial fill has to be recorded as the quantity that actually
filled. Once the trade leaves `pending`, everything is frozen.

**Scores are pruned alongside snapshots.** Writing a score per market per
five-minute pass is millions of rows a month, and `latest_scores` is a
`DISTINCT ON`. The retention job keeps everything recent plus the newest row per
(market, version) forever — that row is what a historical trade's card renders
from.

---

## Findings from the first live scoring runs (2026-09-01)

Recorded for the v2 retune. **Not fixed in v1** — deliberately, since the
model is being replaced rather than tuned.

### Every pick came out YES

First 15 scores, all side=YES. At roughly 1-in-33,000 odds under a symmetric
model, that is structural, not chance.

Observed breakdowns:

```
score 6.0  { micro: 4.2, news: 1.4, base: 0.4 }
score 6.2  { micro: 4.2, news: 1.4, base: 0.6 }
score 6.5  { micro: 4.2, news: 1.4, base: 0.9 }
```

Three things combine:

1. **`news` is a flat 1.4 on every row** — that is `5 x 0.28`, the neutral
   score times its weight. GDELT was unreachable, so news contributed an
   identical constant to both sides and to every market.
2. **`baseRateScore` is symmetric by construction.** It keys off
   `min(price, 100 - price)`, which is identical for YES and NO, so it can
   never distinguish the sides either.
3. That leaves **`drift` as the only asymmetric input**. When a market has not
   moved, YES and NO score identically and `pickSide` breaks the tie toward
   YES.

The `micro` values cluster tightly at 3.7–4.2 rather than spreading, which is
what a saturated activity term with zero momentum looks like: high volume, no
direction.

### Why it matters beyond cosmetics

The comment on `pickSide` claims a tie is harmless because "the surface
threshold will filter it out anyway." That reasoning is wrong. Volume alone
pushes `micro` high enough to clear 5.0, so no-edge markets surface with a
confident-looking 6.1 and a side badge implying a directional view the model
does not hold.

### What v2 should account for

- A market with no directional separation between its sides should not
  surface, regardless of how liquid it is. Consider requiring a minimum gap
  between the YES and NO scores rather than only a minimum absolute score.
- If a signal can never distinguish the sides — as `base` currently cannot —
  it inflates the score without informing the choice. Either make it
  side-aware or account for it separately from the side decision.
- A dead signal should not contribute a constant. Neutral-times-weight is
  still a floor under every score; renormalising over the surviving signals
  (as `activeWeights` already does for *disabled* signals) would be more
  honest than treating "no data" as a mid-range opinion.
