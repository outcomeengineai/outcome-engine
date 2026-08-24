import { serverClient } from '@/lib/supabase';
import {
  AccountStatusPill,
  BillingStatusPill,
  Money,
  ModePill,
  Pill,
  relativeTime,
} from '@/components/ui';
import { AccountActions, InviteForm } from './client';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  email: string;
  display_name: string | null;
  role: 'admin' | 'member';
  account_status: string;
  last_trade_at: string | null;
  created_at: string;
}

export default async function AccountsPage() {
  const db = await serverClient();

  const [
    { data: users },
    { data: connections },
    { data: periods },
    { data: resolved },
    { data: openTrades },
    { data: invites },
    { data: inactivityDays },
  ] = await Promise.all([
    db.from('users').select('*').neq('account_status', 'removed').order('created_at'),
    db.from('kalshi_connections').select('user_id, status, kalshi_username'),
    db.from('billing_periods').select('*').order('period_start', { ascending: false }),
    db.from('resolved_positions').select('user_id, mode, pnl'),
    db.from('open_positions').select('user_id, mode'),
    db.from('invites').select('*').is('redeemed_by', null).order('created_at', { ascending: false }),
    db.from('platform_settings').select('value').eq('key', 'inactivity_threshold_days').maybeSingle(),
  ]);

  const connByUser = new Map(
    (connections ?? []).map((c: { user_id: string; status: string; kalshi_username: string | null }) => [c.user_id, c]),
  );

  // Per-user rollups. Live and paper are tallied separately and only the live
  // figure feeds the fee column — a member's paper record must never look like
  // money they owe on.
  const stats = new Map<string, { livePnl: number; liveTrades: number; paperTrades: number; openCount: number }>();
  const bump = (id: string) =>
    stats.get(id) ?? { livePnl: 0, liveTrades: 0, paperTrades: 0, openCount: 0 };

  for (const r of (resolved ?? []) as Array<{ user_id: string; mode: string; pnl: number }>) {
    const s = bump(r.user_id);
    if (r.mode === 'live') { s.livePnl += r.pnl; s.liveTrades++; } else { s.paperTrades++; }
    stats.set(r.user_id, s);
  }
  for (const o of (openTrades ?? []) as Array<{ user_id: string; mode: string }>) {
    const s = bump(o.user_id);
    s.openCount++;
    stats.set(o.user_id, s);
  }

  const owedByUser = new Map<string, number>();
  const periodsByUser = new Map<string, Array<Record<string, any>>>();
  for (const p of (periods ?? []) as Array<Record<string, any>>) {
    periodsByUser.set(p.user_id, [...(periodsByUser.get(p.user_id) ?? []), p]);
    if (['invoiced', 'grace', 'failed'].includes(p.status)) {
      owedByUser.set(p.user_id, (owedByUser.get(p.user_id) ?? 0) + p.fee_owed);
    }
  }

  const threshold = Number(inactivityDays?.value ?? 30);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{users?.length ?? 0} accounts</div>
          <h1>Accounts</h1>
        </div>
        <InviteForm />
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 18 }}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>Member</th>
                <th>Role</th>
                <th>Kalshi</th>
                <th>Status</th>
                <th className="right">Live PnL</th>
                <th className="right">Trades</th>
                <th className="right">Fee owed</th>
                <th>Last trade</th>
                <th style={{ paddingRight: 18 }} />
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u: Row) => {
                const conn = connByUser.get(u.id);
                const s = stats.get(u.id) ?? { livePnl: 0, liveTrades: 0, paperTrades: 0, openCount: 0 };
                const owed = owedByUser.get(u.id) ?? 0;

                return (
                  <tr key={u.id}>
                    <td style={{ paddingLeft: 18 }}>
                      <div style={{ fontWeight: 500 }}>{u.display_name ?? u.email.split('@')[0]}</div>
                      <div className="hint">{u.email}</div>
                    </td>
                    <td>
                      <Pill tone={u.role === 'admin' ? 'blue' : 'muted'}>{u.role}</Pill>
                    </td>
                    <td>
                      {conn?.status === 'connected'
                        ? <Pill tone="green"><span className="dot" />connected</Pill>
                        : conn?.status === 'error'
                          ? <Pill tone="red">error</Pill>
                          : <Pill tone="muted">not connected</Pill>}
                    </td>
                    <td>
                      <AccountStatusPill status={u.account_status} />
                      {u.account_status === 'inactive' ? (
                        <div className="hint" style={{ marginTop: 3 }}>
                          no trade in {threshold}d
                        </div>
                      ) : null}
                    </td>
                    <td className="right"><Money cents={s.livePnl} signed /></td>
                    <td className="right">
                      <span className="num">{s.liveTrades}</span>
                      <span className="hint"> live</span>
                      {s.paperTrades ? (
                        <div className="hint">{s.paperTrades} paper</div>
                      ) : null}
                    </td>
                    <td className="right">
                      {owed > 0
                        ? <span className="num" style={{ color: 'var(--gold)', fontWeight: 600 }}><Money cents={owed} /></span>
                        : <span className="hint">—</span>}
                    </td>
                    <td className="hint">{relativeTime(u.last_trade_at)}</td>
                    <td style={{ paddingRight: 18 }}>
                      <AccountActions
                        user={{ id: u.id, email: u.email, role: u.role, status: u.account_status }}
                        periods={(periodsByUser.get(u.id) ?? []).map((p) => ({
                          id: p.id,
                          period_start: p.period_start,
                          net_pnl: p.net_pnl,
                          fee_owed: p.fee_owed,
                          status: p.status,
                          stripe_invoice_id: p.stripe_invoice_id,
                        }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2>Open invites</h2>
          {invites?.length ? (
            <div className="stack-sm">
              {(invites as Array<{ code: string; email: string | null; expires_at: string | null }>).map((i) => (
                <div key={i.code} className="row-between">
                  <div>
                    <span className="num" style={{ fontWeight: 600, letterSpacing: '0.06em' }}>{i.code}</span>
                    {i.email ? <span className="hint"> · {i.email}</span> : null}
                  </div>
                  <span className="hint">
                    {i.expires_at ? `expires ${new Date(i.expires_at).toLocaleDateString()}` : 'no expiry'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">No unredeemed invites.</div>
          )}
        </div>

        <div className="card">
          <h2>Recent billing periods</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="right">Net PnL</th>
                  <th className="right">Fee</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(periods ?? []).slice(0, 8).map((p: Record<string, any>) => (
                  <tr key={p.id}>
                    <td className="num">
                      {new Date(p.period_start).toLocaleDateString('en-US', {
                        month: 'short', year: 'numeric', timeZone: 'UTC',
                      })}
                    </td>
                    <td className="right"><Money cents={p.net_pnl} signed /></td>
                    <td className="right"><Money cents={p.fee_owed} /></td>
                    <td><BillingStatusPill status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!periods?.length ? <div className="empty">No billing periods yet.</div> : null}
          </div>
        </div>
      </div>
    </>
  );
}
