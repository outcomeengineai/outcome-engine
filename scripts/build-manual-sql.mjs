import fs from 'node:fs';
import path from 'node:path';

/**
 * Generate single-paste SQL bundles for the Supabase SQL editor.
 *
 * These exist so the schema can be applied from a browser, with no CLI and no
 * database password. Postgres reports errors directly in the editor, which is
 * a much shorter feedback loop than round-tripping through CI logs.
 *
 *   npm run build:manual-sql
 */

const MIGRATIONS = 'supabase/migrations';
const OUT = 'supabase/manual';

// Everything except the cron migration: that one needs the Vault secrets to
// already exist, and pg_cron/pg_net may need enabling from the dashboard.
const CRON = '20260823000500_cron.sql';

const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const main = all.filter((f) => f !== CRON);

/**
 * The CLI's bookkeeping table, created here if absent.
 *
 * `supabase db push` creates supabase_migrations.schema_migrations on its
 * first successful run. Applying by hand means it may not exist yet, so
 * inserting into it blind fails with 42P01 — which is exactly what happened
 * the first time. Create it to the shape the CLI expects, then record these
 * versions so a later `db push` treats them as applied instead of re-running
 * everything.
 */
function bookkeeping(files) {
  const versions = files.map((f) => f.split('_')[0]);
  return `
-- ===== record these migrations as applied =========================
create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version    text not null primary key,
  statements text[],
  name       text
);

insert into supabase_migrations.schema_migrations (version)
values
${versions.map((v) => `  ('${v}')`).join(',\n')}
on conflict (version) do nothing;
`;
}

const header = `-- =========================================================================
-- GENERATED — do not edit. Rebuild: npm run build:manual-sql
--
-- Every migration except the pg_cron one, concatenated in order and wrapped
-- in a single transaction. Paste the whole thing into the Supabase SQL
-- editor and Run. It is all-or-nothing: if any statement fails, nothing is
-- applied and you can fix and re-run from a clean slate.
--
-- Run apply-cron.sql afterwards, once the Vault secrets exist.
-- =========================================================================

begin;
`;

let out = header;
for (const f of main) {
  out += `\n\n-- ===== ${f} ${'='.repeat(Math.max(0, 60 - f.length))}\n\n`;
  out += fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
}
out += `\n${bookkeeping(main)}\ncommit;\n`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'apply-all.sql'), out);

const cron = `-- GENERATED — do not edit. Rebuild: npm run build:manual-sql
--
-- Run LAST, after the three Vault secrets exist. Deliberately NOT wrapped in
-- a transaction: pg_cron and pg_net may need enabling from Database ->
-- Extensions first, and a failure here should not roll back anything else.

${fs.readFileSync(path.join(MIGRATIONS, CRON), 'utf8')}
${bookkeeping([CRON])}`;

fs.writeFileSync(path.join(OUT, 'apply-cron.sql'), cron);

console.log(`apply-all.sql  ${main.length} migrations, ${out.split('\n').length} lines`);
console.log(`apply-cron.sql written`);
