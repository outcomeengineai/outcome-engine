import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { COLORS } from '@outcome/shared';
import { Banner, Button, Card, Hint, s } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';

/**
 * Step 4 — explicit acknowledgment.
 *
 * Four separate checkboxes rather than one blanket "I agree", because each is
 * a distinct thing a member could reasonably misunderstand, and ticking them
 * individually is what makes the consent meaningful rather than decorative.
 */
const POINTS = [
  {
    key: 'risk',
    text: 'I can lose money. Prediction markets are real trades and a high score is not a guarantee.',
  },
  {
    key: 'decisions',
    text: 'Every trade is my decision. Outcome Engine recommends; it never trades for me.',
  },
  {
    key: 'fee',
    text: 'I will be charged 20% of my net profit each month, automatically, on the card I add.',
  },
  {
    key: 'account',
    text: 'Trades run through my own Kalshi account, using an API key I generate myself.',
  },
] as const;

export default function AgreementScreen() {
  const router = useRouter();
  const { profile, refresh } = useSession();

  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allChecked = POINTS.every((p) => checked[p.key]);

  async function agree() {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase
        .from('users')
        .update({ agreed_at: new Date().toISOString() })
        .eq('id', profile.id);
      if (error) throw error;

      await refresh();
      router.push('/(onboarding)/payment');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 14 }}
    >
      <Text style={s.h2}>Please confirm you understand</Text>
      <Hint style={{ marginTop: -6 }}>
        Tap each one. Plain English on purpose — if any of it is a surprise, stop here and ask.
      </Hint>

      <Card style={{ gap: 4 }}>
        {POINTS.map((p) => {
          const on = Boolean(checked[p.key]);
          return (
            <Pressable
              key={p.key}
              onPress={() => setChecked({ ...checked, [p.key]: !on })}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  gap: 12,
                  paddingVertical: 13,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  borderWidth: 2,
                  borderColor: on ? COLORS.green : COLORS.border,
                  backgroundColor: on ? COLORS.green : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 1,
                }}
              >
                {on ? <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>✓</Text> : null}
              </View>
              <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: COLORS.text }}>
                {p.text}
              </Text>
            </Pressable>
          );
        })}
      </Card>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Button label="I agree" onPress={agree} disabled={!allChecked} loading={busy} />
    </ScrollView>
  );
}
