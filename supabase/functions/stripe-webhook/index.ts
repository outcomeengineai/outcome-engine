/**
 * Stripe webhook.
 *
 * Stripe is the source of truth for money, so this endpoint reconciles our
 * billing_periods to whatever Stripe says actually happened — including
 * payments that land outside our monthly job, such as a member paying a failed
 * invoice from the emailed link days later.
 *
 * The signature check is not optional. Without it anyone who learns the URL
 * can mark any period paid.
 */

import { handler, json, serviceClient } from '../_shared/http.ts';
import { require } from '../_shared/env.ts';
import { stripe } from '../_shared/stripe.ts';
import { logActivity, notify } from '../_shared/log.ts';
import { formatUsd } from '../_shared/outcome-shared.mjs';
import type Stripe from 'npm:stripe@17';

Deno.serve(handler(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return json({ error: 'missing stripe-signature' }, 400);

  // The RAW body is required — parsing it first would invalidate the signature.
  const raw = await req.text();
  const s = stripe();

  let event: Stripe.Event;
  try {
    event = await s.webhooks.constructEventAsync(
      raw,
      signature,
      require('STRIPE_WEBHOOK_SECRET'),
    );
  } catch (err) {
    console.error('webhook signature verification failed:', err instanceof Error ? err.message : err);
    return json({ error: 'invalid signature' }, 400);
  }

  const db = serviceClient();

  switch (event.type) {
    // ---- a card was saved during onboarding -----------------------------
    case 'setup_intent.succeeded': {
      const si = event.data.object as Stripe.SetupIntent;
      const customerId = typeof si.customer === 'string' ? si.customer : si.customer?.id;
      const pmId = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
      if (!customerId || !pmId) break;

      const userId = await userIdForCustomer(s, customerId);
      if (!userId) break;

      const pm = await s.paymentMethods.retrieve(pmId);

      // Make this the default for future invoices, otherwise the monthly
      // charge has no card to draw on.
      await s.customers.update(customerId, {
        invoice_settings: { default_payment_method: pmId },
      });

      // Only one primary per user (enforced by a partial unique index), so
      // demote any previous card before inserting.
      await db.from('payment_methods').update({ is_primary: false }).eq('user_id', userId);

      await db.from('payment_methods').upsert(
        {
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_pm_id: pmId,
          brand: pm.card?.brand ?? null,
          last4: pm.card?.last4 ?? null,
          is_primary: true,
        },
        { onConflict: 'user_id,stripe_pm_id' },
      );

      await logActivity(db, {
        userId,
        type: 'billing.card_added',
        detail: `${pm.card?.brand ?? 'Card'} ending ${pm.card?.last4 ?? '????'}`,
      });
      break;
    }

    // ---- an invoice was paid --------------------------------------------
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const periodId = invoice.metadata?.billing_period_id;
      if (!periodId) break;

      const { data: period } = await db
        .from('billing_periods')
        .select('id, user_id, fee_owed, status')
        .eq('id', periodId)
        .maybeSingle();
      if (!period) break;

      // Idempotent: Stripe retries webhooks, and a period already marked paid
      // must not accumulate duplicate payment rows.
      if (period.status === 'paid') break;

      await db
        .from('billing_periods')
        .update({ status: 'paid', grace_until: null, stripe_invoice_id: invoice.id })
        .eq('id', periodId);

      await db.from('payments').insert({
        billing_period_id: periodId,
        amount: invoice.amount_paid,
        method: 'stripe',
        status: 'succeeded',
        paid_at: new Date().toISOString(),
      });

      // Paying is what lifts the restriction — whether it happened through our
      // job or through Stripe's own dunning email.
      await db
        .from('users')
        .update({ account_status: 'active' })
        .eq('id', period.user_id)
        .in('account_status', ['grace', 'paused']);

      await notify(db, {
        userId: period.user_id,
        type: 'billing.paid',
        title: 'Payment received',
        body: `${formatUsd(invoice.amount_paid)} — your account is in good standing.`,
        payload: { billing_period_id: periodId, invoice_id: invoice.id },
      });

      await logActivity(db, {
        userId: period.user_id,
        type: 'billing.paid',
        detail: `Invoice ${invoice.id} paid`,
        metadata: { billing_period_id: periodId, amount: invoice.amount_paid },
      });
      break;
    }

    // ---- a charge failed --------------------------------------------------
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const periodId = invoice.metadata?.billing_period_id;
      if (!periodId) break;

      const { data: period } = await db
        .from('billing_periods')
        .select('id, user_id, status, grace_until')
        .eq('id', periodId)
        .maybeSingle();
      if (!period || period.status === 'paid' || period.status === 'waived') break;

      const { data: graceRow } = await db
        .from('platform_settings')
        .select('value')
        .eq('key', 'grace_period_days')
        .maybeSingle();
      const graceDays = Number(graceRow?.value ?? 7);

      // Preserve the ORIGINAL grace deadline across retries. Extending it on
      // every failed attempt would make the window unbounded.
      const graceUntil = period.grace_until ??
        new Date(Date.now() + graceDays * 86400_000).toISOString();

      await db
        .from('billing_periods')
        .update({ status: 'grace', grace_until: graceUntil, stripe_invoice_id: invoice.id })
        .eq('id', periodId);

      await db
        .from('users')
        .update({ account_status: 'grace' })
        .eq('id', period.user_id)
        .eq('account_status', 'active');

      await notify(db, {
        userId: period.user_id,
        type: 'billing.failed',
        title: 'Payment failed',
        body: `We could not charge ${formatUsd(invoice.amount_due)}. Update your card to keep trading.`,
        payload: { billing_period_id: periodId, grace_until: graceUntil },
      });
      break;
    }

    default:
      // Everything else is acknowledged and ignored, so Stripe stops retrying.
      break;
  }

  return json({ received: true });
}));

/** Map a Stripe customer back to our user via the metadata set at creation. */
async function userIdForCustomer(
  s: Stripe,
  customerId: string,
): Promise<string | null> {
  const customer = await s.customers.retrieve(customerId);
  if (customer.deleted) return null;
  return (customer as Stripe.Customer).metadata?.outcome_user_id ?? null;
}
