# Backend

Postgres schema, RLS policies, and 14 Edge Functions.

## Deploying

Pushing any change under `supabase/` runs the **Deploy to Supabase** workflow,
which applies migrations and deploys functions. You can also trigger it by hand
from Actions → Deploy to Supabase → Run workflow.

Adding or changing a GitHub secret does **not** trigger a run on its own — a
workflow only starts from a push or an explicit dispatch.

### Required repo secrets

| Secret | What it is | Where it comes from |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | `sbp_…` management token | Supabase **account menu** → Access Tokens |
| `SUPABASE_DB_PASSWORD` | database password | set when the project was created |
| `SUPABASE_PROJECT_REF` | project reference id | Project Settings → General, or the dashboard URL |

`SUPABASE_ACCESS_TOKEN` is **not** the service role / secret key. The service
role key never goes near GitHub — it belongs in Vault, set through the SQL
editor. Confusing the two puts a full-database credential in the wrong place.

## Applying migrations by hand

If the workflow is blocked, the SQL editor works and needs no tokens. Run these
in order — each depends on the ones before it:

1. `20260823000100_init.sql` — tables, enums, indexes, triggers
2. `20260823000200_rls.sql` — policies and the SECURITY DEFINER helpers
3. `20260823000300_functions.sql` — billing math, model versions, views
4. `20260823000400_seed.sql` — platform settings and model v1
5. `20260823000600_vault_rpc.sql` — Vault wrappers
6. `20260823000700_news_cache.sql` — news cache
7. `20260823000500_cron.sql` — **last**, and only once the Vault secrets exist

Two consequences of doing it this way: Edge Functions still need the workflow
(the SQL editor cannot deploy them), and Supabase's migration-tracking table
stays empty, so a later `supabase db push` would try to re-apply everything.

## Vault

Three secrets must exist before the scheduled jobs work:

```sql
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret');
select vault.create_secret('https://YOURREF.supabase.co', 'project_url');
select vault.create_secret('paste-service-role-key', 'service_role_key');
```

`cron_secret` must also be set as the `CRON_SECRET` Edge Function secret — Vault
is what pg_cron sends, the function secret is what the function checks it
against.

## Verifying a deploy landed

The schema is live once this returns something other than `PGRST205`:

```
curl "https://YOURREF.supabase.co/rest/v1/platform_settings?select=key" \
  -H "apikey: YOUR_PUBLISHABLE_KEY"
```

An empty array `[]` means the table exists and RLS is correctly hiding rows from
an anonymous caller. `PGRST205 Could not find the table` means the migrations
have not run.
