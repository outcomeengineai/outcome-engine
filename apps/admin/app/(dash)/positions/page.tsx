import { serverClient } from '@/lib/supabase';
import { ModePill, Money, Pill, Stat, relativeTime } from '@/components/ui';
import { formatPriceCents } from '@outcome/shared';

export const dynamic = 'force-dynamic';

/**
 * Platform-wide positions. An admin sees every member's, which is what makes
 * "open exposure across users" on Home meaningful.
 */
export default async function PositionsPage() {
  const db = await serverClient();

  const [{ data: open }, { data: resolved }, { data: users }, { data: pendingFailed }] =
    await Promise.all([
      db.from('open_positions').select('*').order('opened_at', { ascending: false }),
      db.from('resolved_positions').select('*').order('resolved_at', { ascending: false }).limit(80),
      db.from('users').select('id, email, display_name'),
      db.from('trades')
        .select('id, user_id, market_id, status, failure_reason, opened_at, mode')
        .in('status', ['pending', 'failed'])
        .order('opened_at', { ascending: false })
        .limit(25),
    ]);

  const nameById = new Map(
    (users ?? []).map((u: { id: string; email: string; display_name: string | null }) => [
      u.id, u.display_name ?? u.email.split('@')[0],
    ]),
  );

  const openRows = (open ?? []) as Array<Record<string, any>>;
  const liveOpen = openRows.filter((p) => p.mode === 'live');

  const exposure = liveOpen.reduce((s, p) => s + Number(p.stake_cents), 0);
  const unrealized = liveOpen.reduce((s, p) => s + Number(p.unrealized_pnl ?? 0), 0);
  const largest = liveOpen.reduce((m, p) => Math.max(m, Number(p.stake_cents)), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">All members</div>
          <h1>Positions</h1>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <div className="card"><Stat label="Open exposure (live)" value={<Money cents={exposure} />} /></div>
        <div className="card"><Stat label="Unrealized" value={<Money cents={unrealized} signed />} /></div>
        <div className="card">
          <Stat
            label="Open positions"
            value={<span className="num">{openRows.length}</span>}
            hint={`${liveOpen.length} live · ${openRows.length - liveOpen.length} paper`}
          />
        </div>
        <div className="card"><Stat label="Largest position" value={<Money cents={largest} />} /></div>
      </div>

      {pendingFailed?.length ? (
        <div className="card" style={{ marginBottom: 18, borderColor: 'var(--red)' }}>
          <h2>Needs attention</h2>
          <p className="hint" style={{ marginTop: -4 }}>
            Trades that did not confirm. A failed order was never filled and nothing was charged —
            these are shown so nothing is silently swallowed.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Member</th><th>Market</th><th>Mode</th><th>Status</th><th>Reason</th><th>When</th></tr>
              </thead>
              <tbody>
                {(pendingFailed as Array<Record<string, any>>).map((t) => (
                  <tr key={t.id}>
                    <td>{nameById.get(t.user_id) ?? '—'}</td>
                    <td className="num" style={{ fontSize: 12 }}>{t.market_id}</td>
                    <td><ModePill mode={t.mode} /></td>
                    <td><Pill tone={t.status === 'failed' ? 'red' : 'gold'}>{t.status}</Pill></td>
                    <td className="hint" style={{ maxWidth: 320 }}>{t.failure_reason ?? '—'}</td>
                    <td className="hint">{relativeTime(t.opened_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card" style={{ padding: 0, marginBottom: 18 }}>
        <h2 style={{ padding: '18px 18px 0' }}>Open</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>Member</th>
                <th>Market</th>
                <th>Mode</th>
                <th>Side</th>
                <th className="right">Entry → now</th>
                <th className="right">Stake</th>
                <th className="right">Unrealized</th>
                <th>Model</th>
                <th style={{ paddingRight: 18 }}>Opened</th>
              </tr>
            </thead>
            <tbody>
              {openRows.map((p) => (
                <tr key={p.trade_id}>
                  <td style={{ paddingLeft: 18 }}>{nameById.get(p.user_id) ?? '—'}</td>
                  <td style={{ maxWidth: 300, fontSize: 13 }}>{p.question}</td>
                  <td><ModePill mode={p.mode} /></td>
                  <td><Pill tone={p.side === 'YES' ? 'green' : 'blue'}>{p.side}</Pill></td>
                  <td className="right num">
                    {formatPriceCents(p.entry_price)} →{' '}
                    {p.current_price !== null ? formatPriceCents(p.current_price) : '—'}
                  </td>
                  <td className="right"><Money cents={Number(p.stake_cents)} /></td>
                  <td className="right"><Money cents={Number(p.unrealized_pnl ?? 0)} signed /></td>
                  <td>
                    <span className="eyebrow">{p.entry_model_label}</span>
                    <div className="hint">entry {Number(p.entry_score).toFixed(1)}</div>
                  </td>
                  <td className="hint" style={{ paddingRight: 18 }}>{relativeTime(p.opened_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {openRows.length === 0 ? <div className="empty">No open positions.</div> : null}
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ padding: '18px 18px 0' }}>Resolved</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>Member</th>
                <th>Market</th>
                <th>Mode</th>
                <th>Result</th>
                <th className="right">PnL</th>
                <th>Model</th>
                <th style={{ paddingRight: 18 }}>Resolved</th>
              </tr>
            </thead>
            <tbody>
              {(resolved ?? []).map((r: Record<string, any>) => (
                <tr key={r.trade_id}>
                  <td style={{ paddingLeft: 18 }}>{nameById.get(r.user_id) ?? '—'}</td>
                  <td style={{ maxWidth: 300, fontSize: 13 }}>{r.question}</td>
                  <td><ModePill mode={r.mode} /></td>
                  <td>
                    <Pill tone={r.outcome === 'win' ? 'green' : 'red'}>{r.outcome}</Pill>
                  </td>
                  <td className="right"><Money cents={Number(r.pnl)} signed /></td>
                  <td><span className="eyebrow">{r.entry_model_label}</span></td>
                  <td className="hint" style={{ paddingRight: 18 }}>{relativeTime(r.resolved_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!resolved?.length ? <div className="empty">Nothing resolved yet.</div> : null}
        </div>
      </div>
    </>
  );
}
