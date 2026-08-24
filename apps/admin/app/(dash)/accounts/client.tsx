'use client';

import { useState, useTransition } from 'react';
import { formatUsd } from '@outcome/shared';
import { BillingStatusPill } from '@/components/ui';
import {
  createInvite,
  markPeriodPaid,
  recomputePeriod,
  setAccountStatus,
  setRole,
  waivePeriod,
} from './actions';

export function InviteForm() {
  const [code, setCode] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [pending, start] = useTransition();

  return (
    <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
      {code ? (
        <div className="card card-tight" style={{ background: '#e4f7ef', borderColor: '#b9e8d5' }}>
          <div className="eyebrow">Invite code</div>
          <div className="num" style={{ fontSize: 17, fontWeight: 600, letterSpacing: '0.08em' }}>
            {code}
          </div>
          <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setCode(null)}>
            New invite
          </button>
        </div>
      ) : (
        <form
          action={(fd) => start(async () => setCode(await createInvite(fd)))}
          className="row"
          style={{ alignItems: 'flex-end' }}
        >
          <div style={{ width: 220 }}>
            <label htmlFor="invite-email">Invite (email optional)</label>
            <input
              id="invite-email"
              name="email"
              type="email"
              placeholder="friend@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create invite'}
          </button>
        </form>
      )}
    </div>
  );
}

interface Period {
  id: string;
  period_start: string;
  net_pnl: number;
  fee_owed: number;
  status: string;
  stripe_invoice_id: string | null;
}

export function AccountActions({
  user,
  periods,
}: {
  user: { id: string; email: string; role: 'admin' | 'member'; status: string };
  periods: Period[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError(null);
      try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });

  return (
    <>
      <button className="btn btn-sm" onClick={() => setOpen(true)}>Manage</button>

      {open ? (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <div className="row-between" style={{ marginBottom: 4 }}>
              <h2 style={{ margin: 0 }}>{user.email}</h2>
              <button className="btn btn-sm" onClick={() => setOpen(false)}>Close</button>
            </div>

            {error ? <div className="banner banner-danger">{error}</div> : null}

            <div className="divider" />

            <h3>Account status</h3>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {['active', 'paused', 'inactive', 'removed'].map((s) => (
                <button
                  key={s}
                  className={`btn btn-sm ${s === 'removed' ? 'btn-danger' : ''}`}
                  disabled={pending || user.status === s}
                  onClick={() => {
                    // Removal is the one destructive action here, and the brief
                    // is explicit that it is always a deliberate manual step.
                    if (s === 'removed' && !confirm(`Remove ${user.email}? They lose access immediately. Their trade history is kept.`)) return;
                    run(() => setAccountStatus(user.id, s));
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="hint">
              Inactivity is flagged automatically; removal is never automatic. Pausing stops new
              trades but never touches open Kalshi positions.
            </p>

            <div className="divider" />

            <h3>Role</h3>
            <div className="row" style={{ gap: 6 }}>
              {(['member', 'admin'] as const).map((r) => (
                <button
                  key={r}
                  className="btn btn-sm"
                  disabled={pending || user.role === r}
                  onClick={() => run(() => setRole(user.id, r))}
                >
                  {r}
                </button>
              ))}
            </div>

            <div className="divider" />

            <h3>Billing periods</h3>
            {periods.length === 0 ? (
              <div className="empty">No billing periods yet.</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th className="right">Net</th>
                      <th className="right">Fee</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((p) => (
                      <tr key={p.id}>
                        <td className="num">
                          {new Date(p.period_start).toLocaleDateString('en-US', {
                            month: 'short', year: '2-digit', timeZone: 'UTC',
                          })}
                        </td>
                        <td className="right num">{formatUsd(p.net_pnl, { signed: true })}</td>
                        <td className="right num">{formatUsd(p.fee_owed)}</td>
                        <td><BillingStatusPill status={p.status} /></td>
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            {p.status === 'open' ? (
                              <button
                                className="btn btn-sm"
                                disabled={pending}
                                onClick={() => run(() => recomputePeriod(p.id))}
                              >
                                Recompute
                              </button>
                            ) : null}
                            {['invoiced', 'grace', 'failed'].includes(p.status) ? (
                              <>
                                <button
                                  className="btn btn-sm btn-primary"
                                  disabled={pending}
                                  onClick={() => run(() => markPeriodPaid(p.id, 'Paid outside Stripe'))}
                                >
                                  Mark paid
                                </button>
                                <button
                                  className="btn btn-sm"
                                  disabled={pending}
                                  onClick={() => run(() => waivePeriod(p.id))}
                                >
                                  Waive
                                </button>
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint" style={{ marginTop: 10 }}>
              &ldquo;Mark paid&rdquo; is for payments that arrived outside Stripe. It records a manual
              payment against the period and restores access.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
