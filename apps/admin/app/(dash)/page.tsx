import Link from 'next/link';
import { serverClient } from '@/lib/supabase';
import { Money, Pill, SignalStatusPill, Stat, relativeTime } from '@/components/ui';
import { formatUsd, SIGNAL_LABELS } from '@outcome/shared';
import type { SignalKey } from '@outcome/shared';

export const dynamic = 'force-dynamic';

/**
 * Admin Home — the platform-wide snapshot.
 *
 * Every number here is scoped to LIVE trades except where labelled, because
 * paper volume flatters the platform figures without meaning anything
 * financially.
 */
export default async function AdminHome() {
  const db = await serverClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();

  const [
    { data: settings },
    { data: users },
    { data: signals },
    { data: latestSnapshot },
    { data: resolved30d },
    { data: openPositions },
    { data: pendingBilling },
    { data: recentActivity },
    { data: modelVersion },
  ] = await Promise.all([
    db.from('platform_settings').select('key, value').in('key', ['kill_switch', 'trading_paused', 'fee_rate']),
    db.from('users').select('id, account_status, role').neq('account_status', 'removed'),
    db.from('signal_health').select('*'),
    db.from('market_snapshots').select('ts').order('ts', { ascending: false }).limit(1).maybeSingle(),
    db.from('resolved_positions').select('pnl, mode').eq('mode', 'live').gte('resolved_at', thirtyDaysAgo),
    db.from('open_positions').select('user_id, mode, stake_cents, unrealized_pnl'),
    db.from('billing_periods').select('fee_owed, status').in('status', ['invoiced', 'grace', 'failed']),
    db.from('activity_log').select('id, event_type, detail, ts, user_id').order('ts', { ascending: false }).limit(8),
    db.from('model_versions').select('version_label, published_at').eq('status', 'stable').order('published_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const setting = new Map((settings ?? []).map((s: { key: string; value: unknown }) => [s.key, s.value]));
  const killSwitch = setting.get('kill_switch') === true;
  const paused = setting.get('trading_paused') === true;

  const activeUsers = (users ?? []).filter((u: { account_status: string }) => u.account_status === 'active').length;
  const graceUsers = (users ?? []).filter((u: { account_status: string }) => u.account_status === 'grace').length;
  const pausedUsers = (users ?? []).filter((u: { account_status: string }) => u.account_status === 'paused').length;

  const platformPnl = (resolved30d ?? []).reduce((s: number, r: { pnl: number }) => s + r.pnl, 0);

  const liveOpen = (openPositions ?? []).filter((p: { mode: string }) => p.mode === 'live');
  const openExposure = liveOpen.reduce((s: number, p: { stake_cents: number }) => s + p.stake_cents, 0);
  const openUnrealized = liveOpen.reduce((s: number, p: { unrealized_pnl: number }) => s + Number(p.unrealized_pnl ?? 0), 0);

  const feesPending = (pendingBilling ?? []).reduce((s: number, b: { fee_owed: number }) => s + b.fee_owed, 0);

  // The feed is "live" if a snapshot landed within three ingestion ticks.
  const lastIngest = latestSnapshot?.ts ?? null;
  const feedAgeMin = lastIngest ? (Date.now() - new Date(lastIngest).getTime()) / 60000 : Infinity;
  const feedHealthy = feedAgeMin < 15;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Platform snapshot</div>
          <h1>Home</h1>
        </div>
        <div className="row">
          <Pill tone={feedHealthy ? 'green' : 'red'}>
            <span className="dot" />
            Kalshi feed {feedHealthy ? 'live' : 'stale'}
          </Pill>
          {modelVersion ? <Pill tone="blue">Model {modelVersion.version_label}</Pill> : null}
        </div>
      </div>

      {killSwitch ? (
        <div className="banner banner-danger">
          <strong>Kill switch is ON.</strong> All platform trading is halted. Existing positions are
          untouched and will still resolve. Turn it off in Settings.
        </div>
      ) : paused ? (
        <div className="banner banner-warn">
          <strong>Live trading is paused.</strong> Members can still take paper trades.
        </div>
      ) : null}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card hero">
          <Stat
            label="Platform net PnL · 30d"
            value={<span style={{ color: '#fff' }}>{formatUsd(platformPnl, { signed: true })}</span>}
            hint="Live trades only, across all members"
            size="lg"
          />
        </div>
        <div className="card">
          <Stat
            label="Fees pending"
            value={<Money cents={feesPending} />}
            hint={`${pendingBilling?.length ?? 0} unsettled period(s)`}
          />
        </div>
        <div className="card">
          <Stat
            label="Open exposure"
            value={<Money cents={openExposure} />}
            hint={
              <>
                {liveOpen.length} live position(s) ·{' '}
                <span className={openUnrealized >= 0 ? 'pos' : 'neg'}>
                  {formatUsd(openUnrealized, { signed: true })} unrealized
                </span>
              </>
            }
          />
        </div>
        <div className="card">
          <Stat
            label="Members"
            value={<span className="num">{activeUsers}</span>}
            hint={
              graceUsers + pausedUsers > 0
                ? `${graceUsers} in grace · ${pausedUsers} paused`
                : 'all in good standing'
            }
          />
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="row-between" style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>Signal health</h2>
            <Link href="/strategy" className="hint">Configure →</Link>
          </div>
          <div className="stack">
            {(signals ?? []).map((s: {
              signal: SignalKey;
              status: string;
              win_rate: number | null;
              sample_count: number;
              disabled_until: string | null;
            }) => (
              <div key={s.signal} className="row-between">
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{SIGNAL_LABELS[s.signal]}</div>
                  <div className="hint">
                    {s.sample_count > 0 && s.win_rate !== null
                      ? `${(Number(s.win_rate) * 100).toFixed(1)}% over ${s.sample_count} resolved`
                      : 'not enough resolved trades yet'}
                    {s.disabled_until ? ` · back ${relativeTime(s.disabled_until)}` : ''}
                  </div>
                </div>
                <SignalStatusPill status={s.status} />
              </div>
            ))}
            {!signals?.length ? <div className="empty">No signal data yet.</div> : null}
          </div>
        </div>

        <div className="card">
          <div className="row-between" style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>Recent activity</h2>
            <Link href="/activity" className="hint">Full log →</Link>
          </div>
          <div className="stack-sm">
            {(recentActivity ?? []).map((a: {
              id: number; event_type: string; detail: string | null; ts: string;
            }) => (
              <div key={a.id} className="row-between" style={{ alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="eyebrow">{a.event_type}</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>{a.detail ?? '—'}</div>
                </div>
                <span className="hint" style={{ whiteSpace: 'nowrap' }}>{relativeTime(a.ts)}</span>
              </div>
            ))}
            {!recentActivity?.length ? <div className="empty">Nothing yet.</div> : null}
          </div>
        </div>
      </div>
    </>
  );
}
