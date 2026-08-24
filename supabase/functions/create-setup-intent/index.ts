/**
 * Create a Stripe SetupIntent so the member app can collect a card.
 *
 * The app never sees a raw card number: Stripe's PaymentSheet takes the
 * details directly and returns only a payment method id, which the webhook
 * records. Cash App and Venmo debit cards work here because they present as
 * ordinary cards on the same rail.
 *
 * A card is required before LIVE trading. Paper mode never needs one.
 */

import { handler, json, requireUser, serviceClient } from '../_shared/http.ts';
import { ensureCustomer, stripe } from '../_shared/stripe.ts';
import { logActivity } from '../_shared/log.ts';

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  const user = await requireUser(req, db);

  const customerId = await ensureCustomer(db, user);
  const s = stripe();

  // An ephemeral key is what lets the mobile PaymentSheet act on behalf of
  // this customer without the app ever holding a secret key.
  const ephemeralKey = await s.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: '2024-12-18.acacia' },
  );

  const setupIntent = await s.setupIntents.create({
    customer: customerId,
    // off_session: the card is stored now and charged later by the monthly job
    // with nobody present to authenticate.
    usage: 'off_session',
    payment_method_types: ['card'],
    metadata: { outcome_user_id: user.id },
  });

  await logActivity(db, {
    userId: user.id,
    type: 'billing.setup_intent_created',
    detail: 'Started adding a payment method',
  });

  return json({
    ok: true,
    setupIntentClientSecret: setupIntent.client_secret,
    ephemeralKeySecret: ephemeralKey.secret,
    customerId,
    publishableKey: Deno.env.get('STRIPE_PUBLISHABLE_KEY') ?? null,
  });
}));
