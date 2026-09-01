# Outcome Engine

Scores Kalshi prediction markets 1–10, lets ~20 invited members take those
trades through **their own** Kalshi accounts, tracks wins and losses, and bills
20% of net profit monthly.

Score + human decides. Not automated trading, not pooled capital.

```
apps/admin      Next.js 15 dashboard (Vercel)      — model tuning, accounts, billing
apps/member     Expo / React Native app            — the trading experience
packages/shared TypeScript                          — fee math, score rules, types
supabase/       Postgres + RLS + Edge Functions     — the whole backend
design/         imported from Claude Design         — canvas artboards + brief
docs/           the two source briefs
```

## Quick start

Node 22+ is required, and not only because `@supabase/supabase-js` dropped
Node 20. The test runner behaves differently: `node --test` takes a glob on
Node 22 and a bare directory on Node 20, so running the suite on Node 20 does
not fail loudly — it fails to run the right thing. CI pins Node 22; match it
locally or the results are not comparable.

```bash
npm install
npm run build:shared
```

Then per surface:

```bash
supabase db reset          # applies migrations/ in order
npm run dev:admin          # http://localhost:3000
npm run dev:member         # Expo
```

### Environment

Three templates, one per destination — there is no shared root env file,
because the three sets of values must not end up in the same place.

| Template | Copy to | Loaded by |
|---|---|---|
| `supabase/.env.example` | `supabase/.env` | `supabase secrets set --env-file supabase/.env` (prod) / `functions serve` (local) |
| `apps/admin/.env.example` | `apps/admin/.env.local` | Next.js — and Vercel project env vars in prod |
| `apps/member/.env.example` | `apps/member/.env` | Expo, inlined into the bundle at build time |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
**not** in any template: Supabase injects them into every Edge Function
automatically and rejects secrets named `SUPABASE_*`.

Only one value is required to get the backend running: `CRON_SECRET`. Stripe
keys are needed at step 8, and nothing else is mandatory.

### Setting credentials without local file access

Every genuinely secret value has a web-dashboard home. Nothing secret has to
live in a file, and nothing secret needs to be typed into a terminal — which
matters, because a shell command containing a key is recorded in scrollback and
session transcripts just as surely as a chat message is.

**Public — safe anywhere, shipped in client bundles by design:**
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`. The anon key is
meant to be public; RLS is what protects the data.

**Secret — dashboard only, never a file, never a chat message, never a shell
command:** the service role key, `CRON_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, and each member's Kalshi private key.

| Value | Goes in | How |
|---|---|---|
| `project_url`, `service_role_key`, `cron_secret` | Supabase **Vault** | SQL editor, `vault.create_secret(...)` |
| `CRON_SECRET`, `STRIPE_*`, `NEWSAPI_KEY` | Supabase **Edge Function secrets** | Dashboard UI — no file, no CLI |
| `NEXT_PUBLIC_*` | **Vercel** env vars | Dashboard UI |
| `EXPO_PUBLIC_*` | `apps/member/.env`, or EAS env vars | Either — these are public |
| Kalshi private key | Supabase Vault | Entered in the member app's connect screen; goes straight to Vault |

`supabase/.env` and the `supabase secrets set --env-file` flow in
`supabase/.env.example` are the *alternative* for people working locally. If you
are configuring from a browser, use the dashboard and skip that file entirely.

**Generating `CRON_SECRET` without it ever leaving Supabase** — run this in the
SQL editor, then copy the printed value into the Edge Function secrets UI in the
same browser session:

```sql
select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'cron_secret'
);

select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret';
```

The value has to exist in both places: Vault is what `invoke_edge_function()`
reads when pg_cron fires, and the Edge Function secret is what the function
compares the incoming header against.

### Deploying the admin dashboard (Vercel)

Set the project's **Root Directory to the repository root (`.`)**, not
`apps/admin`. Two reasons, and they bite together:

- npm has to install from the root or the `@outcome/shared` workspace link
  never forms
- `packages/shared/dist` is generated, not committed, so it has to be built
  before `next build` can import it

`vercel.json` handles both once the root directory is right. Getting it wrong
fails with `Module not found: Can't resolve '@outcome/shared'`.

Note that `vercel.json` cannot carry comments — Vercel's schema rejects
unknown keys, including the `//` convention — which is why this explanation
lives here instead.

Environment variables go in Vercel's dashboard, not a file:
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Both public.

### v1's directional signal is drift-only

Expect low surfaced counts, and do not read that as a broken pipeline.

A market only surfaces when the two sides' scores differ by at least
`thresholds.minSideSeparation`. Of the three v1 signals, only one can create
that difference:

| signal | can it distinguish YES from NO? |
|---|---|
| `micro` | **yes** — via price drift over the window |
| `news` | no — neutral for both sides without coverage, and identical for both when there is coverage of unknown direction |
| `base` | no — keys off `min(price, 100 - price)`, symmetric by construction |

So v1 can only form a directional view on markets whose **price has actually
moved**. A market that is liquid, tight and interesting but flat produces a
coin flip, and a coin flip with a side badge would imply a view the model does
not hold. Those markets are counted as `noDirection` in the scoring response
rather than surfaced.

This is why the first fifteen live scores were all YES: with drift at zero the
sides tied exactly and the tie-break went one way every time. Fixed in
20260823001000, but the underlying limitation is structural, not a bug.

Anchors (Edge Signals v2, section 1) are what removes it. An NWS forecast of
78% against a market price of 64c is a directional edge that needs no price
movement at all, so anchored categories will surface on day one instead of
waiting for momentum to build.

## The five things that matter

**1. Money is integer cents, everywhere.** Contract prices are whole cents 1–99
(Kalshi's own unit), a winning contract settles at 100, and no float ever holds
a dollar amount. `packages/shared/src/money.ts` is the only place that does fee
arithmetic, and `close_billing_period()` in SQL applies the identical rule so
the estimate on a stake card and the number on an invoice cannot drift.

**2. Fee = 20% × max(0, net PnL) per period.** Losses offset wins. A losing
month owes nothing. The rate is read from `platform_settings`, never hardcoded.
Paper trades never enter billing — enforced in exactly one place, the
`mode = 'live'` filter in `recompute_billing_period()`.

**3. Every trade keeps its model version and entry score, forever.** A database
trigger rejects any update to `model_version_id` or `entry_score`. Publishing a
retune re-scores markets and notifies affected members; it never rewrites
history. Those frozen rows are the calibration dataset — the only honest record
of what the model said when the money went in.

**4. Each member supplies their own Kalshi key.** Keys live in Supabase Vault,
reachable only through three `SECURITY DEFINER` wrappers granted to
`service_role` alone. The key crosses the wire once, at connect time, and is
never returned to a client, logged, or stored on the device. There is no master
key — Kalshi's developer agreement prohibits sublicensing.

**5. RLS is the security boundary, not the UI.** Members read and write only
their own rows; admins read everything. Tables a member must not be able to
forge — `trades`, `scores`, `billing_periods`, `trade_resolutions` — have **no**
member-facing INSERT policy at all. Those writes go through Edge Functions, so
validation cannot be skipped by talking to PostgREST directly. The admin
dashboard uses the anon key and runs under RLS like everyone else.

## Backend

Seven migrations, applied in filename order:

| | |
|---|---|
| `…000100_init` | tables, enums, indexes, triggers |
| `…000200_rls` | every policy, plus `is_admin()` / `can_act()` / caller accessors |
| `…000300_functions` | settings, model versions, billing math, retention, views |
| `…000400_seed` | platform settings + model v1 |
| `…000500_cron` | pg_cron schedules |
| `…000600_vault_rpc` | the three Vault wrappers |
| `…000700_news_cache` | per-market news cache |

Fourteen Edge Functions:

| Function | Trigger | Does |
|---|---|---|
| `ingest-markets` | every 5 min | polls **public** Kalshi endpoints → snapshots |
| `score-markets` | every 5 min, offset | sub-scores → weights → one side per market |
| `execute-trade` | member app | validates, places the order, records the fill |
| `sync-resolutions` | hourly | settles paper from outcome, live from Kalshi |
| `signal-health` | hourly | rolling win rate, auto-disable with cooldown |
| `run-billing` | monthly + daily grace pass | closes periods, invoices via Stripe |
| `send-notifications` | every 2 min | drains the queue to Expo push |
| `publish-model` | admin | publishes, re-scores, notifies |
| `run-backtest` | admin | replays a draft over resolved markets |
| `connect-kalshi` | onboarding | verifies a key, writes it to Vault |
| `kalshi-balance` | member app | balance for the stake card's warning |
| `create-setup-intent` | onboarding | Stripe SetupIntent for the card sheet |
| `stripe-webhook` | Stripe | reconciles payments to billing periods |
| `redeem-invite` | onboarding | validates, then atomically claims a code |

Ingestion polls **per market, not per user**. Twenty members watching the same
Fed market is one API call, not twenty, and it needs no credentials at all.

### Before deploying

```sql
select vault.create_secret('https://YOURPROJECT.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>',              'service_role_key');
select vault.create_secret('<random-string>',                 'cron_secret');
```

The scheduled jobs call functions over HTTP and read those three from Vault.

## Verification status

What has actually been run, not just written:

- ✅ `packages/shared` — 23 tests pass (fee rule, losses offsetting wins,
  settlement allocation across trades on one market, score bands, weight
  renormalization, side selection, retune thresholds)
- ✅ All 7 migrations parse under **libpg_query** (real Postgres grammar), as do
  all 10 `language sql` function bodies
- ✅ Kalshi RSA-PSS signing round-trips against Node's WebCrypto: signature
  verifies, a tampered message is rejected, a PKCS#1 key is refused with a
  useful message
- ✅ All 22 Edge Function sources parse as TypeScript
- ✅ `apps/admin` builds — 11 routes, no type errors
- ✅ `apps/member` typechecks clean

**Not** verified, because it needs credentials and a live project:

- No migration has been applied to a real Postgres (no Docker/CLI available
  here), so RLS policies and PL/pgSQL bodies are unexecuted
- No Kalshi, Stripe, news, or Expo call has been made against a real endpoint
- The Expo app has not been run on a device or simulator

## Known gaps

**Push is off until `eas init` runs.** `app.json` has an empty `extra.eas`
block waiting for a project id. Without one, `registerForPush` logs a warning
and returns null rather than throwing — the notification centre still works,
and `send-notifications` marks rows delivered for members with no registered
device instead of retrying them forever.

**Stripe card entry is stubbed.** `create-setup-intent` is real and returns a
usable SetupIntent, ephemeral key and customer id. Presenting the sheet needs
`@stripe/stripe-react-native`, which requires a development build rather than
Expo Go — the call site in `app/(onboarding)/payment.tsx` marks exactly where it
goes. Everything downstream (webhook, billing, grace, invoices) is complete.

**Signup is not gated at the auth layer.** Invite codes are enforced in the app,
but Supabase auth itself will create a user for any email that requests a magic
link. With twenty invited friends this is mostly cosmetic — an uninvited account
gets a member row with no connection, no card and no data beyond public market
prices. Tighten it with an auth hook or an email allowlist before opening up.

**The news signal is a keyword lexicon.** It will misread sarcasm, negation, and
headlines about the losing side. That is why model v1 weights it at 0.28 and why
the divergence auto-tag exists: the cases where it disagrees loudly with price
are flagged for a human rather than trusted.

**Backtests assume mid-price fills and uniform sizing.** They measure the
model's hit rate, not anyone's actual staking, and reach back only as far as raw
snapshots are retained (30 days by default).

## Sequencing the rollout

Follow the build brief's order — it is right, and step 8 in particular:

1. Ingestion, verify snapshots land
2. Scoring, sanity-check scores against live markets by eye
3. Admin dashboard against real data
4. Member app, **paper mode end to end first**
5. Live trading with the owner's account only
6. Resolution sync
7. **Billing — reconcile a full cycle by hand before enabling auto-charge.**
   The monthly cron is deliberately left unscheduled in `…000500_cron.sql`;
   the daily grace-only pass is safe from day one because it never creates a
   charge. Use `run-billing` with `{"dryRun": true}` to see the numbers without
   touching Stripe.
8. Invite 2–3 friends, watch a billing cycle, then the rest

## Deferred (not built, per the brief)

Model comparison beyond Simulate's two-curve overlay · auto-adjusting weights ·
per-category signal health · usage tiers · Polymarket.
