#!/usr/bin/env node
/**
 * Platform status, read-only, through the Management API.
 *
 * WHY. The only way to see how the platform is doing was to paste SQL into
 * the Supabase editor and paste the result back into a chat. This runs the
 * same checks with the access token the deploy workflow already holds and
 * writes them to the GitHub job summary: one click, no SQL, no credentials
 * outside GitHub secrets.
 *
 * Every query here is a SELECT. Nothing is written.
 */

import { appendFile } from 'node:fs/promises';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
const API = process.env.SUPABASE_API_URL ?? 'https://api.supabase.com';

if (!TOKEN || !REF) {
  console.error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required.');
  process.exit(1);
}

async function query(sql) {
  const res = await fetch(`${API}/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const SECTIONS = [
  {
    title: 'Universe (discovery and tiers)',
    sql: `
      select
        (select last_completed_at from public.discovery_state)::text                                   as last_sweep_completed,
        (select pages_done from public.discovery_state)                                                as sweep_in_progress_pages,
        (select count(*) from public.markets where cadence_tier = 'fast')                              as fast_total,
        (select count(*) from public.markets where cadence_tier = 'slow')                              as slow_total,
        (select count(*) from public.markets where cadence_tier = 'archive')                           as archive_total,
        (select count(*) from public.markets where cadence_tier = 'fast' and expected_close is null)   as fast_missing_expected_close,
        (select count(*) from public.universe_membership where tier = 'fast'
           and left_at > now() - interval '2 hours')                                                   as left_fast_last_2h,
        (select count(*) from public.markets where tier_reason = 'too short to track')                 as too_short_excluded,
        (select round(percentile_cont(0.5) within group
           (order by extract(epoch from (expected_close - now())) / 3600))::int
           from public.markets where cadence_tier = 'fast')                                            as fast_median_hours_runway;`,
  },
  {
    title: 'Pricing (last 15 minutes)',
    sql: `
      select
        (select count(*) from public.market_snapshots s join public.markets m on m.id = s.market_id
           where m.cadence_tier = 'fast' and s.ts > now() - interval '15 minutes')                     as fast_snapshots_15m,
        (select count(distinct s.market_id) from public.market_snapshots s join public.markets m on m.id = s.market_id
           where m.cadence_tier = 'fast' and s.ts > now() - interval '15 minutes')                     as fast_markets_priced_15m,
        (select left(detail, 140) from public.activity_log
           where event_type like 'ingest.%' and detail like 'slow%' order by ts desc limit 1)          as last_slow_run;`,
  },
  {
    title: 'Scoring (latest fast-tier pass, pre-gate)',
    sql: `
      select created::text                                       as at,
             content::jsonb -> 'byTier' -> 'fast'                 as fast,
             content::jsonb ->> 'disabledSignals'                 as disabled_signals,
             content::jsonb ->> 'modelVersion'                    as model_version
        from net._http_response
       where content like '%"tier":"fast"%' and content like '%"byTier"%'
       order by created desc limit 1;`,
  },
  {
    title: 'Learning loop (resolution and labels)',
    sql: `
      select
        (select count(*) from public.markets where resolved_at > now() - interval '24 hours')          as markets_resolved_24h,
        (select count(*) from public.edge_theses where payload ? 'final_state')                        as labelled_theses_total,
        (select count(*) filter (where (payload->>'thesis_correct')::boolean) || ' / ' ||
                count(*) filter (where payload->>'thesis_correct' is not null)
           from public.edge_theses where payload ? 'final_state')                                      as directional_correct_of_labelled,
        (select left(detail, 140) from public.activity_log
           where event_type = 'resolution.completed' order by ts desc limit 1)                         as last_resolution_run;`,
  },
  {
    title: 'Recent failures (last 6 hours)',
    sql: `
      select ts::text as at, event_type, left(detail, 160) as detail
        from public.activity_log
       where ts > now() - interval '6 hours'
         and (event_type like '%.failed' or event_type like '%.rate_limited')
       order by ts desc limit 10;`,
  },
];

function table(rows) {
  if (!rows.length) return '_no rows_\n';
  const cols = Object.keys(rows[0]);
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? '`' + JSON.stringify(v) + '`' : String(v));
  return [
    '| ' + cols.join(' | ') + ' |',
    '| ' + cols.map(() => '---').join(' | ') + ' |',
    ...rows.map((r) => '| ' + cols.map((c) => cell(r[c])).join(' | ') + ' |'),
  ].join('\n') + '\n';
}

let out = `## Outcome Engine — platform status\n\n_${new Date().toISOString()}_\n\n`;
for (const s of SECTIONS) {
  out += `### ${s.title}\n\n`;
  try {
    out += table(await query(s.sql));
  } catch (err) {
    out += `⚠️ ${err.message}\n`;
  }
  out += '\n';
}

console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, out);
