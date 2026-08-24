import { serverClient } from '@/lib/supabase';
import { Pill, relativeTime } from '@/components/ui';
import { EmergencyControls, SettingsForm } from './client';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const db = await serverClient();

  const [{ data: rows }, { data: lastSnapshot }, { data: recentIngest }, { data: connections }] =
    await Promise.all([
      db.from('platform_settings').select('key, value, updated_at'),
      db.from('market_snapshots').select('ts').order('ts', { ascending: false }).limit(1).maybeSingle(),
      db.from('activity_log')
        .select('detail, ts, metadata')
        .in('event_type', ['ingest.completed', 'ingest.rate_limited', 'ingest.failed'])
        .order('ts', { ascending: false })
        .limit(5),
      db.from('kalshi_connections').select('status'),
    ]);

  const settings = Object.fromEntries(
    (rows ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]),
  ) as Record<string, unknown>;

  const feedAgeMin = lastSnapshot?.ts
    ? (Date.now() - new Date(lastSnapshot.ts).getTime()) / 60000
    : Infinity;

  const rateLimited = (recentIngest ?? []).some(
    (a: { detail: string | null }) => a.detail?.includes('429') || a.detail?.includes('rate'),
  );

  const connected = (connections ?? []).filter((c: { status: string }) => c.status === 'connected').length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Platform</div>
          <h1>Settings</h1>
        </div>
      </div>

      <EmergencyControls
        killSwitch={settings.kill_switch === true}
        tradingPaused={settings.trading_paused === true}
      />

      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <h2>API integration</h2>

          <div className="row-between" style={{ marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>Kalshi market data</div>
              <div className="hint">
                Public endpoints, polled per market · last snapshot{' '}
                {lastSnapshot?.ts ? relativeTime(lastSnapshot.ts) : 'never'}
              </div>
            </div>
            <Pill tone={feedAgeMin < 15 ? 'green' : 'red'}>
              <span className="dot" />{feedAgeMin < 15 ? 'live' : 'stale'}
            </Pill>
          </div>

          <div className="row-between" style={{ marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>Rate limit</div>
              <div className="hint">
                {rateLimited
                  ? 'Backed off on a 429 in the last few runs'
                  : 'No throttling in recent runs'}
              </div>
            </div>
            <Pill tone={rateLimited ? 'gold' : 'green'}>{rateLimited ? 'throttled' : 'headroom'}</Pill>
          </div>

          <div className="row-between" style={{ marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>Member trading keys</div>
              <div className="hint">
                {connected} connected · each member uses their own key, held in Vault
              </div>
            </div>
            <Pill tone="green">per-user</Pill>
          </div>

          <div className="divider" />

          <div className="row-between">
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--faint)' }}>Polymarket</div>
              <div className="hint">Planned as a second data source. Not connected.</div>
            </div>
            <Pill tone="muted">planned</Pill>
          </div>
        </div>

        <SettingsForm settings={settings} />
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h2>Recent ingestion runs</h2>
        <div className="stack-sm">
          {(recentIngest ?? []).map((a: { detail: string | null; ts: string }, i: number) => (
            <div key={i} className="row-between">
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>{a.detail ?? '—'}</span>
              <span className="hint">{relativeTime(a.ts)}</span>
            </div>
          ))}
          {!recentIngest?.length ? <div className="empty">No ingestion runs logged yet.</div> : null}
        </div>
      </div>
    </>
  );
}
