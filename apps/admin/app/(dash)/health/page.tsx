import { serverClient } from '@/lib/supabase';
import { Pill, Stat, relativeTime } from '@/components/ui';
import type { PillTone } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Platform health: every cron job's last run and failure streak, and where
 * the database's space is going.
 *
 * This page exists because the prune job failed on every run for a week and
 * the only record was a log nobody opened. pg_cron keeps that log; this is
 * the platform reading it back to the person who can act on it.
 */

interface CronRow {
  jobname: string;
  schedule: string;
  active: boolean;
  last_run: string | null;
  last_status: string | null;
  last_message: string | null;
  runs_24h: number;
  failures_24h: number;
  consecutive_failures: number;
}

interface StorageRow {
  db_size_mb: number;
  alert_mb: number;
  tables: Array<{ name: string; mb: number; live: number; dead: number; last_autovacuum: string | null }>;
  snapshots_oldest: string | null;
  scores_oldest: string | null;
  last_prune: { ts: string; detail: string } | null;
}

function jobTone(j: CronRow): { tone: PillTone; label: string } {
  if (!j.active) return { tone: 'muted', label: 'paused' };
  if (j.consecutive_failures >= 2) return { tone: 'red', label: `failing ×${j.consecutive_failures}` };
  if (j.last_status === 'failed') return { tone: 'gold', label: 'failed once' };
  if (j.last_status === 'succeeded') return { tone: 'green', label: 'ok' };
  return { tone: 'muted', label: 'never ran' };
}

function daysAgo(iso: string | null): string {
  if (!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  return d < 1 ? `${Math.round(d * 24)}h` : `${d.toFixed(1)}d`;
}

export default async function HealthPage() {
  const db = await serverClient();
  const [{ data: cronData, error: cronErr }, { data: storageData, error: storageErr }] = await Promise.all([
    db.rpc('cron_health'),
    db.rpc('storage_health'),
  ]);

  const jobs = (cronData ?? []) as CronRow[];
  const storage = (storageData ?? null) as StorageRow | null;
  const failing = jobs.filter((j) => j.consecutive_failures >= 2);
  const overLine = storage ? storage.db_size_mb > storage.alert_mb : false;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {failing.length === 0 ? 'every job on schedule' : `${failing.length} job${failing.length > 1 ? 's' : ''} failing`}
            {storage ? ` · ${storage.db_size_mb} MB` : ''}
          </div>
          <h1>Health</h1>
        </div>
        <div className="hint" style={{ maxWidth: 360, textAlign: 'right' }}>
          What pg_cron and Postgres know about themselves. A job that fails twice in a row, or a
          database over the alert line, also notifies every admin once a day.
        </div>
      </div>

      {cronErr || storageErr ? (
        <div className="banner banner-danger">
          {cronErr?.message ?? storageErr?.message}. If this says the function does not exist, the
          latest migration has not applied yet.
        </div>
      ) : null}

      {failing.length > 0 ? (
        <div className="banner banner-danger">
          {failing.map((j) => (
            <div key={j.jobname}>
              <strong>{j.jobname}</strong> has failed {j.consecutive_failures} runs in a row
              {j.last_message ? `: ${j.last_message}` : ''}
            </div>
          ))}
        </div>
      ) : null}

      {storage ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 16 }}
          >
            <Stat
              label="Database"
              value={
                <span className={overLine ? 'neg' : undefined}>
                  {storage.db_size_mb} MB
                </span>
              }
              hint={`alert line ${storage.alert_mb} MB`}
            />
            <Stat
              label="Oldest snapshot"
              value={daysAgo(storage.snapshots_oldest)}
              hint="retention is 5 days"
            />
            <Stat label="Oldest score" value={daysAgo(storage.scores_oldest)} hint="retention is 3 days" />
            <Stat
              label="Last prune"
              value={storage.last_prune ? relativeTime(storage.last_prune.ts) : 'never'}
              hint={storage.last_prune?.detail ?? 'no maintenance.pruned event yet'}
            />
          </div>
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row-between" style={{ marginBottom: 8 }}>
          <div className="eyebrow">Scheduled jobs</div>
          <div className="hint">{jobs.length} jobs</div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Schedule</th>
                <th>Last run</th>
                <th>Status</th>
                <th className="num">Runs 24h</th>
                <th className="num">Failed 24h</th>
                <th>Last message</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const t = jobTone(j);
                return (
                  <tr key={j.jobname}>
                    <td>{j.jobname}</td>
                    <td className="sub">{j.schedule}</td>
                    <td className="sub">{relativeTime(j.last_run)}</td>
                    <td>
                      <Pill tone={t.tone}>{t.label}</Pill>
                    </td>
                    <td className="num">{j.runs_24h}</td>
                    <td className={`num ${j.failures_24h > 0 ? 'neg' : ''}`}>{j.failures_24h}</td>
                    <td className="sub" style={{ maxWidth: 420, whiteSpace: 'normal' }}>
                      {j.last_status === 'failed' ? j.last_message ?? '' : ''}
                    </td>
                  </tr>
                );
              })}
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty">
                    No jobs reported.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {storage ? (
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            Largest tables
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th className="num">MB</th>
                  <th className="num">Live rows</th>
                  <th className="num">Dead rows</th>
                  <th>Last autovacuum</th>
                </tr>
              </thead>
              <tbody>
                {storage.tables.map((t) => (
                  <tr key={t.name}>
                    <td>{t.name}</td>
                    <td className="num">{t.mb}</td>
                    <td className="num">{t.live.toLocaleString()}</td>
                    <td className={`num ${t.dead > t.live * 0.2 ? 'neg' : ''}`}>{t.dead.toLocaleString()}</td>
                    <td className="sub">{relativeTime(t.last_autovacuum)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Deleting rows does not shrink a table on disk. When dead rows stay high after a prune,
            run <code>vacuum full</code> on that table from the SQL editor.
          </div>
        </div>
      ) : null}
    </>
  );
}
