#!/usr/bin/env node
/**
 * Apply pending migrations through the Supabase Management API.
 *
 * WHY THIS EXISTS. `supabase db push` needs the database password, and the
 * database password failed with 28P01 across every attempt for weeks — fresh
 * passwords, session pooler, URL-encoding, whitespace trimming, an explicit
 * connection-string override. After that many rounds the password is not the
 * likely fault, and asking for it again is not a plan.
 *
 * The Management API executes SQL using the personal access token that has
 * deployed Edge Functions successfully on every run. Same token, no database
 * password anywhere. Migrations apply on push, and the hand-pasted
 * pending.sql routine ends.
 *
 * Bookkeeping uses the same table the CLI uses (supabase_migrations.
 * schema_migrations), so the two paths stay interchangeable if db push ever
 * starts working.
 *
 * Environment:
 *   SUPABASE_ACCESS_TOKEN   personal access token (sbp_...)
 *   SUPABASE_PROJECT_REF    project reference id
 *   MIGRATIONS_BASELINE     optional. Versions at or below this were applied
 *                           by hand before this script existed: RECORD them,
 *                           do not re-run them. Only honoured when the schema
 *                           is already initialised, so a fresh project still
 *                           runs everything from the start.
 */

import { readdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
const BASELINE = process.env.MIGRATIONS_BASELINE ?? '';
const MIGRATIONS_DIR = path.resolve('supabase/migrations');

if (!TOKEN || !REF) {
  console.error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required.');
  process.exit(1);
}

// Overridable so the script can be tested against a local stand-in for the
// endpoint. Production never sets this.
const API = process.env.SUPABASE_API_URL ?? 'https://api.supabase.com';
const ENDPOINT = `${API}/v1/projects/${REF}/database/query`;

/** Run SQL. Returns the rows of the final statement (empty for DDL). */
async function query(sql, label) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try { message = JSON.parse(text).message ?? text; } catch { /* keep raw */ }
    throw new Error(`${label}: HTTP ${res.status} — ${message}`);
  }
  try { return JSON.parse(text); } catch { return []; }
}

function versionOf(filename) {
  const m = /^(\d{14})_/.exec(filename);
  return m ? m[1] : null;
}

async function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, line + '\n');
  }
}

// ---------------------------------------------------------------------------

await query(
  `create schema if not exists supabase_migrations;
   create table if not exists supabase_migrations.schema_migrations (
     version    text not null primary key,
     statements text[],
     name       text
   );`,
  'ensure bookkeeping table',
);

// Record hand-applied history once, if the schema is already there.
if (BASELINE) {
  const [{ initialised }] = await query(
    `select to_regclass('public.markets') is not null as initialised;`,
    'check schema',
  );
  if (initialised) {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const baselineVersions = files.map(versionOf).filter((v) => v && v <= BASELINE);
    if (baselineVersions.length) {
      const values = baselineVersions.map((v) => `('${v}')`).join(',');
      await query(
        `insert into supabase_migrations.schema_migrations (version) values ${values}
         on conflict (version) do nothing;`,
        'record baseline',
      );
    }
  }
}

const appliedRows = await query(
  `select version from supabase_migrations.schema_migrations order by version;`,
  'list applied',
);
const applied = new Set(appliedRows.map((r) => r.version));

const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
const pending = files.filter((f) => {
  const v = versionOf(f);
  return v && !applied.has(v);
});

await summary('### Migrations');
await summary('');
await summary(`Already applied: ${applied.size}. Pending: ${pending.length}.`);
await summary('');

if (pending.length === 0) {
  await summary('Nothing to apply.');
  process.exit(0);
}

for (const file of pending) {
  const version = versionOf(file);
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

  // One transaction per file: the migration and its bookkeeping row land
  // together or not at all, so a failure is re-runnable rather than leaving
  // a half-applied file that then fails on its first CREATE.
  const wrapped = `begin;
${sql}
insert into supabase_migrations.schema_migrations (version, name)
values ('${version}', '${file.replace(/'/g, "''")}')
on conflict (version) do nothing;
commit;`;

  process.stdout.write(`applying ${file} ... `);
  try {
    await query(wrapped, file);
    console.log('ok');
    await summary(`- ✅ \`${file}\``);
  } catch (err) {
    console.log('FAILED');
    await summary(`- ❌ \`${file}\` — ${err.message}`);
    console.error('\n' + err.message);
    console.error('\nNothing after this file was attempted. Fix the SQL and re-run; ' +
                  'the failed file rolled back and will be retried.');
    process.exit(1);
  }
}

await summary('');
await summary(`Applied ${pending.length} migration(s).`);
