import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { COLORS, formatUsd } from '@outcome/shared';
import { Button, Card, Hint, Pill, ScoreRing, s } from '@/components/ui';
import { useSession } from '@/lib/session';

/**
 * Step 3 — the short explainer.
 *
 * Three things a member has to understand before they can consent to anything:
 * what the score is, what paper vs live means, and how the fee works. Kept to
 * three, because a wall of text at this point is a wall nobody reads.
 */
export default function ExplainerScreen() {
  const router = useRouter();
  const { settings } = useSession();
  const feePct = Math.round(settings.feeRate * 100);

  // A worked example beats a formula: wins minus losses, then the percentage.
  const exampleWins = 40000;
  const exampleLosses = 15000;
  const exampleNet = exampleWins - exampleLosses;
  const exampleFee = Math.round(exampleNet * settings.feeRate);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 14 }}
    >
      <Card>
        <View style={[s.row, { gap: 14, marginBottom: 12 }]}>
          <ScoreRing score={8.4} size={58} />
          <View style={{ flex: 1 }}>
            <Text style={s.h2}>The score is a ranking, not a promise</Text>
            <Hint style={{ marginTop: 4 }}>
              Every market gets 1–10 from a weighted model, and the model commits to one side —
              YES or NO, never both. Higher means a better setup by our measures. It does not mean
              certain.
            </Hint>
          </View>
        </View>
        <Hint>
          You decide every trade. Nothing is placed automatically, and nothing is pooled — trades
          go through your own Kalshi account.
        </Hint>
      </Card>

      <Card>
        <View style={[s.row, { gap: 8, marginBottom: 10 }]}>
          <Pill tone="purple">PAPER</Pill>
          <Pill tone="green">● LIVE</Pill>
        </View>
        <Text style={s.h2}>Start in paper mode</Text>
        <Hint style={{ marginTop: 4 }}>
          Paper trades are practice. No real money moves, and they never generate a fee. You will
          land in paper mode and can switch to live whenever you are ready — the toggle is always
          visible so you always know which one you are in.
        </Hint>
      </Card>

      <Card>
        <Text style={s.h2}>The fee: {feePct}% of net profit</Text>
        <Hint style={{ marginTop: 4, marginBottom: 12 }}>
          Charged monthly, on profit only. Losses in the same month offset your wins before the
          fee is calculated — and it is never taken out of your Kalshi balance.
        </Hint>

        <View style={{ backgroundColor: COLORS.surfaceMuted, borderRadius: 10, padding: 13, gap: 7 }}>
          <View style={s.rowBetween}>
            <Hint>Wins this month</Hint>
            <Text style={{ color: COLORS.greenDark, fontWeight: '600' }}>
              {formatUsd(exampleWins, { signed: true })}
            </Text>
          </View>
          <View style={s.rowBetween}>
            <Hint>Losses this month</Hint>
            <Text style={{ color: COLORS.red, fontWeight: '600' }}>
              {formatUsd(-exampleLosses, { signed: true })}
            </Text>
          </View>
          <View style={{ height: 1, backgroundColor: COLORS.border }} />
          <View style={s.rowBetween}>
            <Hint>Net profit</Hint>
            <Text style={{ fontWeight: '600' }}>{formatUsd(exampleNet)}</Text>
          </View>
          <View style={s.rowBetween}>
            <Text style={{ fontSize: 13, fontWeight: '600' }}>Your fee ({feePct}%)</Text>
            <Text style={{ fontWeight: '700', color: COLORS.text }}>{formatUsd(exampleFee)}</Text>
          </View>
        </View>

        <Hint style={{ marginTop: 10 }}>
          A month where you finish down costs you nothing. There is no subscription and no minimum.
        </Hint>
      </Card>

      <Button label="Got it" onPress={() => router.push('/(onboarding)/agreement')} />
    </ScrollView>
  );
}
