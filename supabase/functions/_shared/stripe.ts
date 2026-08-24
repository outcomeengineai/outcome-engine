/**
 * Stripe access.
 *
 * Billing and Invoicing do the work — invoice records, PDFs, receipts, dunning
 * emails and payment history all live on Stripe's side rather than in tables
 * here. `billing_periods` records what we CHARGED and why; Stripe records the
 * money. Hand-rolling invoice records would mean maintaining a second ledger
 * that can silently disagree with the first.
 */

import Stripe from 'npm:stripe@17';
import { require } from './env.ts';

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!client) {
    client = new Stripe(require('STRIPE_SECRET_KEY'), {
      apiVersion: '2024-12-18.acacia',
      httpClient: Stripe.createFetchHttpClient(),
    });
  }
  return client;
}

/** Find or create the Stripe customer for a member. */
export async function ensureCustomer(
  db: { from: (t: string) => any },
  user: { id: string; email: string; display_name: string | null },
): Promise<string> {
  const { data: existing } = await db
    .from('payment_methods')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const customer = await stripe().customers.create({
    email: user.email,
    name: user.display_name ?? undefined,
    // The link back to our user id is what lets the webhook attribute an
    // event without a lookup table.
    metadata: { outcome_user_id: user.id },
  });

  return customer.id;
}

/**
 * Invoice a closed billing period and attempt to charge the card on file.
 *
 * One invoice item, one invoice, charged automatically. The description spells
 * out the net-profit basis so the line on a member's statement matches the
 * explanation they agreed to at onboarding.
 */
export async function invoicePeriod(params: {
  customerId: string;
  amountCents: number;
  periodStart: string;
  periodEnd: string;
  netPnlCents: number;
  feeRate: number;
  billingPeriodId: string;
}): Promise<{ invoiceId: string; status: string; paid: boolean }> {
  const s = stripe();
  const month = new Date(params.periodStart).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const invoice = await s.invoices.create({
    customer: params.customerId,
    collection_method: 'charge_automatically',
    auto_advance: false, // finalize explicitly, so the item is attached first
    description:
      `Outcome Engine platform fee — ${month}. ` +
      `${(params.feeRate * 100).toFixed(0)}% of net profit ` +
      `($${(params.netPnlCents / 100).toFixed(2)} net across all live trades resolved this period).`,
    metadata: {
      billing_period_id: params.billingPeriodId,
      net_pnl_cents: String(params.netPnlCents),
    },
  });

  await s.invoiceItems.create({
    customer: params.customerId,
    invoice: invoice.id,
    amount: params.amountCents,
    currency: 'usd',
    description: `Platform fee (${(params.feeRate * 100).toFixed(0)}% of $${(params.netPnlCents / 100).toFixed(2)} net profit)`,
  });

  const finalized = await s.invoices.finalizeInvoice(invoice.id);

  try {
    const paid = await s.invoices.pay(finalized.id);
    return { invoiceId: paid.id, status: paid.status ?? 'unknown', paid: paid.status === 'paid' };
  } catch {
    // A declined card is an expected outcome, not an exception. The caller
    // moves the period into grace and notifies the member.
    const current = await s.invoices.retrieve(finalized.id);
    return {
      invoiceId: current.id,
      status: current.status ?? 'open',
      paid: current.status === 'paid',
    };
  }
}
