import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '@outcome/shared';
import { Banner, Button, Hint, monoFont, s } from '@/components/ui';
import { callFunction } from '@/lib/supabase';

/**
 * Step 1 — invite code.
 *
 * There is no public signup, so this is the front door. The code is validated
 * before an account exists, which is why redeem-invite runs unauthenticated
 * for this call and returns nothing but "usable or not".
 */
export default function InviteScreen() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await callFunction<{ valid: boolean; email: string | null }>('redeem-invite', {
        code: code.trim(),
      });
      if (!res.valid) throw new Error('That invite code is not valid.');
      router.push({
        pathname: '/(onboarding)/auth',
        params: { code: code.trim().toUpperCase(), email: res.email ?? '' },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check that code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, padding: 24, justifyContent: 'center' }}
      >
        <View style={{ marginBottom: 32 }}>
          <Text style={{ fontSize: 26, fontWeight: '700', letterSpacing: -0.5 }}>
            Outcome <Text style={{ color: COLORS.green }}>Engine</Text>
          </Text>
          <Text style={[s.eyebrow, { marginTop: 8 }]}>Invite only</Text>
        </View>

        <Text style={[s.h2, { marginBottom: 6 }]}>Enter your invite code</Text>
        <Hint style={{ marginBottom: 16 }}>
          Someone shared a code with you. It is not a password — it just proves you were invited.
        </Hint>

        <TextInput
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="ABCD2345"
          placeholderTextColor={COLORS.faint}
          maxLength={12}
          style={[s.input, monoFont, { fontSize: 20, letterSpacing: 4, textAlign: 'center' }]}
        />

        {error ? (
          <View style={{ marginTop: 14 }}>
            <Banner tone="danger">{error}</Banner>
          </View>
        ) : null}

        <Button
          label="Continue"
          onPress={check}
          loading={busy}
          disabled={code.trim().length < 4}
          style={{ marginTop: 20 }}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
