/**
 * Monthly billing — scheduled on the 1st, plus a daily grace-only pass.
 *
 * Sequence per member:
 *   1. close the period that just ended (totals frozen in SQL)
 *   2. fee = 20% x max(0, net) — computed by close_billing_period(), not here
 *   3. nothing owed -> settled, no invoice, no charge
 *   4. something owed -> Stripe invoice, auto-charge the card on file
 *   5. charge fails -> status 'grace', member notified, account -> 'grace'
 *   6. grace window expires -> account_status 'paused'
 *
 * DO NOT enable the 1st-of-month cron until a full cycle has been reconciled
 * by hand against Kalshi settlements. The grace-only mode is safe to run from
 * day one because it never creates a charge.
 */

import { handler, json, readJson, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { ensureCustomer, invoicePeriod } from '../_shared/stripe.ts';
import { logActivity, notify, notifyAdmins } from '../_shared/log.ts';
import { formatUsd } from '../_shared/outcome-shared.mjs';

interface Body {
  /** 'full' closes and invoices; 'grace_only' just escalates expired grace. */
  mode?: 'full' | 'grace_only';
  /** Compute and report without creating a Stripe invoice. */
  dryRun?: boolean;
  /** Restrict to one user — used when reconciling a single account. */
  userId?: string;
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);

  const body = await readJson<Body>(req);
  const mode = body.mode ?? 'full';
  const dryRun = body.dryRun ?? false;
  const now = new Date();

  const results: Record<string, unknown>[] = [];

  // =========================================================================
  // Grace escalation — runs in BOTH modes.
  // =========================================================================
  const { data: expiredGrace } = await db
    .from('billing_periods')
    .select('id, user_id, fee_owed, grace_until')
    .eq('status', 'grace')
    .lt('grace_until', now.toISOString());

  let paused = 0;
  for (const p of (expiredGrace ?? []) as Array<{ id: string; user_id: string; fee_owed: number }>) {
    await db.from('users').update({ account_status: 'paused' }).eq('id', p.user_id);

    await notify(db, {
      userId: p.user_id,
      type: 'billing.paused',
      title: 'Account paused',
      body: `Your ${formatUsd(p.fee_owed)} platform fee is still unpaid. Update your card or contact the admin to restore access.`,
      payload: { billing_period_id: p.id },
    });

    await logActivity(db, {
      userId: p.user_id,
      type: 'billing.grace_expired',
      detail: `Grace period expired with ${formatUsd(p.fee_owed)} outstanding`,
      metadata: { billing_period_id: p.id },
    });
    paused++;
  }

  await notifyAdminsIfAny(db, paused);

  if (mode === 'grace_only') {
    return json({ ok: true, mode, paused });
  }

  // =========================================================================
  // Close and invoice the period that just ended.
  // =========================================================================
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  let userQuery = db
    .from('users')
    .select('id, email, display_name, account_status')
    .neq('account_status', 'removed');
  if (body.userId) userQuery = userQuery.eq('id', body.userId);

  const { data: users, error: uErr } = await userQuery;
  if (uErr) throw new Error(`user load failed: ${uErr.message}`);

  const { data: graceDaysRow } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'grace_period_days')
    .maybeSingle();
  const graceDays = Number(graceDaysRow?.value ?? 7);

  for (const user of (users ?? []) as Array<{ id: string; email: string; display_name: string | null }>) {
    const { data: period } = await db
      .from('billing_periods')
      .select('*')
      .eq('user_id', user.id)
      .eq('period_start', periodStart.toISOString())
      .maybeSingle();

    // No period row means the member opened no trades that month. Nothing to
    // close and nothing to charge.
    if (!period) continue;
    if (period.status !== 'open') {
      results.push({ userId: user.id, skipped: `already ${period.status}` });
      continue;
    }

    if (dryRun) {
      const { data: preview } = await db.rpc('recompute_billing_period', { p_period: period.id });
      results.push({
        userId: user.id,
        email: user.email,
        dryRun: true,
        netPnl: preview?.net_pnl,
        feeOwed: preview?.fee_owed,
      });
      continue;
    }

    // close_billing_period recomputes, freezes and marks 'paid' when the fee
    // is zero, so the branch below only ever sees a real amount due.
    const { data: closed, error: cErr } = await db.rpc('close_billing_period', {
      p_period: period.id,
    });
    if (cErr) {
      results.push({ userId: user.id, error: cErr.message });
      continue;
    }

    if (!closed || closed.fee_owed === 0) {
      results.push({
        userId: user.id,
        email: user.email,
        netPnl: closed?.net_pnl ?? 0,
        feeOwed: 0,
        outcome: 'nothing owed',
      });
      // A losing or break-even month is still worth telling someone about,
      // because "no invoice" should not look like a bug.
      await notify(db, {
        userId: user.id,
        type: 'billing.no_fee',
        title: 'No platform fee this month',
        body: closed && closed.net_pnl < 0
          ? `You finished the period down ${formatUsd(Math.abs(closed.net_pnl))}. Losses offset wins, so nothing is owed.`
          : 'You had no net profit this period, so there is nothing to bill.',
        payload: { billing_period_id: period.id, net_pnl: closed?.net_pnl ?? 0 },
      });
      continue;
    }

    // ---- charge ----------------------------------------------------------
    try {
      const customerId = await ensureCustomer(db, user);
      const charge = await invoicePeriod({
        customerId,
        amountCents: closed.fee_owed,
        periodStart: closed.period_start,
        periodEnd: closed.period_end,
        netPnlCents: closed.net_pnl,
        feeRate: Number(closed.fee_rate),
        billingPeriodId: closed.id,
      });

      if (charge.paid) {
        await db
          .from('billing_periods')
          .update({ status: 'paid', stripe_invoice_id: charge.invoiceId })
          .eq('id', closed.id);

        await db.from('payments').insert({
          billing_period_id: closed.id,
          amount: closed.fee_owed,
          method: 'stripe',
          status: 'succeeded',
          paid_at: new Date().toISOString(),
        });

        await notify(db, {
          userId: user.id,
          type: 'billing.charged',
          title: `Platform fee charged: ${formatUsd(closed.fee_owed)}`,
          body: `20% of ${formatUsd(closed.net_pnl)} net profit for the period.`,
          payload: { billing_period_id: closed.id, invoice_id: charge.invoiceId },
        });

        results.push({ userId: user.id, feeOwed: closed.fee_owed, outcome: 'paid' });
      } else {
        const graceUntil = new Date(now.getTime() + graceDays * 86400_000).toISOString();

        await db
          .from('billing_periods')
          .update({ status: 'grace', stripe_invoice_id: charge.invoiceId, grace_until: graceUntil })
          .eq('id', closed.id);

        await db.from('payments').insert({
          billing_period_id: closed.id,
          amount: closed.fee_owed,
          method: 'stripe',
          status: 'failed',
        });

        // Grace restricts trading but does not lock the member out of their
        // own data, and never touches their Kalshi positions.
        await db.from('users').update({ account_status: 'grace' }).eq('id', user.id);

        await notify(db, {
          userId: user.id,
          type: 'billing.failed',
          title: 'Payment failed',
          body: `We could not charge ${formatUsd(closed.fee_owed)}. Update your card within ${graceDays} days to keep trading.`,
          payload: {
            billing_period_id: closed.id,
            invoice_id: charge.invoiceId,
            grace_until: graceUntil,
          },
        });

        await notifyAdmins(db, {
          type: 'billing.payment_failed',
          title: 'Payment failed',
          body: `${user.email}: ${formatUsd(closed.fee_owed)} — in grace until ${graceUntil.slice(0, 10)}.`,
          payload: { user_id: user.id, billing_period_id: closed.id },
        });

        results.push({ userId: user.id, feeOwed: closed.fee_owed, outcome: 'grace' });
      }
    } catch (err) {
      // A Stripe outage must not leave the period looking settled.
      const message = err instanceof Error ? err.message : String(err);
      await db.from('billing_periods').update({ status: 'failed' }).eq('id', closed.id);

      await notifyAdmins(db, {
        type: 'billing.error',
        title: 'Billing error',
        body: `${user.email}: ${message}`,
        payload: { user_id: user.id, billing_period_id: closed.id },
      });

      results.push({ userId: user.id, error: message, outcome: 'failed' });
    }
  }

  await logActivity(db, {
    type: 'billing.run_completed',
    detail: `${results.length} accounts processed${dryRun ? ' (dry run)' : ''}`,
    metadata: { mode, dryRun, paused, results },
  });

  return json({ ok: true, mode, dryRun, paused, period: periodStart.toISOString(), results });
}));

async function notifyAdminsIfAny(db: ReturnType<typeof serviceClient>, paused: number) {
  if (paused === 0) return;
  await notifyAdmins(db, {
    type: 'billing.accounts_paused',
    title: `${paused} account(s) paused`,
    body: 'Grace period expired with fees outstanding.',
    payload: { count: paused },
  });
}
