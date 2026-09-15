import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
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
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<'code' | 'email' | 'sent'>('code');
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
      if (res.email) setEmail(res.email);
      setStep('email');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check that code.');
    } finally {
      setBusy(false);
    }
  }

  // The platform creates the account and sends the link. The app never
  // creates an account itself -- public signups are off -- so holding the
  // anon key is not enough to get in. See redeem-invite.
  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await callFunction<{ sent?: boolean; existing?: boolean }>('redeem-invite', {
        code: code.trim(),
        send: true,
        email: email.trim(),
        redirectTo: Linking.createURL('/auth-callback'),
      });
      if (res.existing) {
        router.push({ pathname: '/(onboarding)/auth', params: { email: email.trim() } });
        return;
      }
      setStep('sent');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your invite.');
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

        {step === 'code' ? (
          <>
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
          </>
        ) : null}

        {step === 'email' ? (
          <>
            <Text style={[s.h2, { marginBottom: 6 }]}>Where should we send your sign-in link?</Text>
            <Hint style={{ marginBottom: 16 }}>
              No passwords. We email you a link; open it on this phone and you are in.
            </Hint>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="you@example.com"
              placeholderTextColor={COLORS.faint}
              style={s.input}
            />
          </>
        ) : null}

        {step === 'sent' ? (
          <>
            <Text style={[s.h2, { marginBottom: 6 }]}>Check your email</Text>
            <Hint style={{ marginBottom: 18 }}>
              We sent a sign-in link to {email}. Open it on this device and you will land back here.
            </Hint>
          </>
        ) : null}

        {error ? (
          <View style={{ marginTop: 14 }}>
            <Banner tone="danger">{error}</Banner>
          </View>
        ) : null}

        {step === 'code' ? (
          <Button label="Continue" onPress={check} loading={busy} disabled={code.trim().length < 4} style={{ marginTop: 20 }} />
        ) : step === 'email' ? (
          <Button label="Send my link" onPress={send} loading={busy} disabled={!email.includes('@')} style={{ marginTop: 20 }} />
        ) : (
          <Button label="Use a different address" variant="secondary" onPress={() => setStep('email')} style={{ marginTop: 20 }} />
        )}

        {step === 'code' ? (
          <Button
            label="Already a member? Sign in"
            variant="secondary"
            onPress={() => router.push('/(onboarding)/auth')}
            style={{ marginTop: 12 }}
          />
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
