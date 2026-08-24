import { useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { COLORS } from '@outcome/shared';
import { Banner, Button, Card, Hint, Pill, s } from '@/components/ui';
import { callFunction } from '@/lib/supabase';
import { useSession } from '@/lib/session';

/**
 * Step 5 — payment method.
 *
 * Skippable, and that is deliberate: a card is required for LIVE trading, not
 * for entering the app. Making it mandatory here would force someone to hand
 * over a card before they have seen a single score.
 *
 * The card itself is collected by Stripe. This app never sees a card number —
 * it requests a SetupIntent, hands it to Stripe's sheet, and the webhook
 * records the resulting payment method.
 */
export default function PaymentScreen() {
  const router = useRouter();
  const { onboarding, refresh } = useSession();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addCard() {
    setBusy(true);
    setError(null);
    try {
      const intent = await callFunction<{
        setupIntentClientSecret: string;
        ephemeralKeySecret: string;
        customerId: string;
        publishableKey: string | null;
      }>('create-setup-intent');

      // ---------------------------------------------------------------
      // Wire up @stripe/stripe-react-native here:
      //
      //   await initPaymentSheet({
      //     merchantDisplayName: 'Outcome Engine',
      //     customerId: intent.customerId,
      //     customerEphemeralKeySecret: intent.ephemeralKeySecret,
      //     setupIntentClientSecret: intent.setupIntentClientSecret,
      //   });
      //   const { error } = await presentPaymentSheet();
      //
      // It is left out of this build because the Stripe SDK needs a native
      // rebuild (it does not run in Expo Go), and the rest of the app has to
      // be runnable before that step. The SetupIntent above is real — only
      // the sheet presentation is missing.
      // ---------------------------------------------------------------

      throw new Error(
        'Card entry needs the Stripe SDK, which requires a development build. ' +
          'Skip for now — you can add a card any time from Billing, and paper mode does not need one.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start card setup.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 14 }}
    >
      <Text style={s.h2}>Add a payment method</Text>
      <Hint style={{ marginTop: -6 }}>
        Needed before you trade live, so we can bill the monthly fee. Paper mode works without one.
      </Hint>

      <Card>
        {onboarding.hasPaymentMethod ? (
          <View style={[s.rowBetween]}>
            <View>
              <Text style={{ fontSize: 14, fontWeight: '600' }}>Card on file</Text>
              <Hint style={{ marginTop: 2 }}>You are set up for live trading.</Hint>
            </View>
            <Pill tone="green">● added</Pill>
          </View>
        ) : (
          <>
            <Text style={{ fontSize: 14, fontWeight: '600', marginBottom: 6 }}>
              Debit or credit card
            </Text>
            <Hint>
              Cash App and Venmo debit cards work here too — they run on the same card rail. Your
              card details go straight to Stripe; we never see or store them.
            </Hint>
            <Button label="Add card" onPress={addCard} loading={busy} style={{ marginTop: 14 }} />
          </>
        )}
      </Card>

      {error ? <Banner tone="warn" title="Not available in this build">{error}</Banner> : null}

      <Card>
        <Text style={{ fontSize: 13.5, fontWeight: '600', marginBottom: 6 }}>What gets charged</Text>
        <Hint>
          Once a month, 20% of your net profit for that month — wins minus losses. A losing month
          costs nothing. The fee is charged to this card and never deducted from your Kalshi
          balance.
        </Hint>
      </Card>

      <View style={{ gap: 10 }}>
        <Button
          label={onboarding.hasPaymentMethod ? 'Continue' : 'Skip for now — I will start in paper'}
          variant={onboarding.hasPaymentMethod ? 'primary' : 'secondary'}
          onPress={() => router.push('/(onboarding)/kalshi')}
        />
        <Hint style={{ textAlign: 'center' }}>
          You can add a card any time from Billing.
        </Hint>
      </View>
    </ScrollView>
  );
}
