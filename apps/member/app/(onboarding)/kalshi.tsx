import { useState } from 'react';
import { Linking, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { COLORS, formatUsd } from '@outcome/shared';
import { Banner, Button, Card, Hint, Pill, s } from '@/components/ui';
import { callFunction } from '@/lib/supabase';
import { useSession } from '@/lib/session';

const STEPS = [
  'Sign in to Kalshi and open Account → API Keys.',
  'Create a key with trading permission. Do not grant withdrawal access — this app never needs it.',
  'Kalshi shows the private key once. Download it and copy the whole file, including the BEGIN and END lines.',
  'Paste the Key ID and the private key below.',
];

/**
 * Step 6 — connect Kalshi.
 *
 * The member generates their OWN key on their OWN account. There is no master
 * key and no shared credential: Kalshi's developer agreement forbids
 * sublicensing, and one key per member is what keeps each person's trading
 * genuinely their own.
 *
 * The key is posted once, verified against Kalshi, and written to Vault
 * server-side. This screen is the only place it ever exists on the device, and
 * it is gone from memory as soon as the request completes — there is no
 * endpoint that can read it back.
 */
export default function KalshiScreen() {
  const router = useRouter();
  const { onboarding, refresh } = useSession();

  const [keyId, setKeyId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await callFunction<{ connected: boolean; balanceCents: number }>(
        'connect-kalshi',
        { keyId: keyId.trim(), privateKey },
      );
      setBalance(res.balanceCents);
      // Clear the key from component state the moment it is no longer needed.
      setPrivateKey('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect that key.');
    } finally {
      setBusy(false);
    }
  }

  const connected = onboarding.kalshiConnected || balance !== null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 14 }}
    >
      {connected ? (
        <>
          <Card>
            <View style={s.rowBetween}>
              <View>
                <Text style={s.h2}>Kalshi connected</Text>
                {balance !== null ? (
                  <Hint style={{ marginTop: 3 }}>Balance {formatUsd(balance)}</Hint>
                ) : null}
              </View>
              <Pill tone="green">● connected</Pill>
            </View>
          </Card>

          <Button label="Start trading" onPress={() => router.replace('/(tabs)')} />
        </>
      ) : (
        <>
          <Text style={s.h2}>Connect your Kalshi account</Text>
          <Hint style={{ marginTop: -6 }}>
            Trades are placed on your own account with a key you generate. Needed for live trading
            only — paper mode works without it.
          </Hint>

          <Card style={{ gap: 12 }}>
            {STEPS.map((step, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 11 }}>
                <View
                  style={{
                    width: 22, height: 22, borderRadius: 999,
                    backgroundColor: COLORS.surfaceMuted,
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: COLORS.muted }}>{i + 1}</Text>
                </View>
                <Text style={{ flex: 1, fontSize: 13.5, lineHeight: 19.5, color: COLORS.text }}>
                  {step}
                </Text>
              </View>
            ))}

            <Button
              label="Open Kalshi API settings"
              variant="secondary"
              onPress={() => Linking.openURL('https://kalshi.com/account/api')}
            />
          </Card>

          <Card>
            <Text style={{ fontSize: 12, fontWeight: '600', marginBottom: 6 }}>Key ID</Text>
            <TextInput
              value={keyId}
              onChangeText={setKeyId}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="00000000-0000-0000-0000-000000000000"
              placeholderTextColor={COLORS.faint}
              style={s.input}
            />

            <Text style={{ fontSize: 12, fontWeight: '600', marginTop: 14, marginBottom: 6 }}>
              Private key
            </Text>
            <TextInput
              value={privateKey}
              onChangeText={setPrivateKey}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              numberOfLines={6}
              placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
              placeholderTextColor={COLORS.faint}
              style={[s.input, { minHeight: 130, textAlignVertical: 'top', fontSize: 12 }]}
            />

            <Hint style={{ marginTop: 10 }}>
              Encrypted and stored server-side the moment you submit. It is never saved on this
              phone, never logged, and there is no way for the app to read it back.
            </Hint>
          </Card>

          {error ? <Banner tone="danger" title="Could not connect">{error}</Banner> : null}

          <Button
            label="Connect"
            onPress={connect}
            loading={busy}
            disabled={!keyId.trim() || !privateKey.includes('PRIVATE KEY')}
          />

          <Button
            label="Skip — start in paper mode"
            variant="ghost"
            onPress={() => router.replace('/(tabs)')}
          />
        </>
      )}
    </ScrollView>
  );
}
