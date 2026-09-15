import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { COLORS } from '@outcome/shared';
import { Banner, Button, Hint, s } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';

/**
 * Step 2 — account creation by magic link.
 *
 * No passwords anywhere in the product. Once the link lands and a session
 * exists, the invite is redeemed against the now-real account, which is the
 * point at which the code is consumed.
 */
export default function AuthScreen() {
  const router = useRouter();
  const { email: prefilled } = useLocalSearchParams<{ email: string }>();
  const { session } = useSession();

  const [email, setEmail] = useState(prefilled ?? '');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Invites are redeemed server-side when the account is created (see
  // redeem-invite and the auth trigger), so there is nothing to finish here.
  // This screen is for people who already have an account. The deep-link
  // handler in _layout establishes the session; this reacts to it appearing.
  useEffect(() => {
    if (session) router.replace('/(onboarding)/explainer');
  }, [session, router]);

  async function sendLink() {
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        // shouldCreateUser: false -- the app never creates accounts. Public
        // signups are off on the project as well; this is belt and braces.
        options: { emailRedirectTo: Linking.createURL('/auth-callback'), shouldCreateUser: false },
      });
      if (error) throw error;
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the link.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, padding: 24, backgroundColor: COLORS.bg }}
    >
      {sent ? (
        <>
          <Text style={[s.h2, { marginBottom: 6 }]}>Check your email</Text>
          <Hint style={{ marginBottom: 18 }}>
            We sent a sign-in link to {email}. Open it on this device and you will land back here.
          </Hint>
          <Button label="Use a different address" variant="secondary" onPress={() => setSent(false)} />
        </>
      ) : (
        <>
          <Text style={[s.h2, { marginBottom: 6 }]}>What is your email?</Text>
          <Hint style={{ marginBottom: 16 }}>
            We will send a sign-in link. No password to remember.
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

          {error ? (
            <View style={{ marginTop: 14 }}>
              <Banner tone="danger">{error}</Banner>
            </View>
          ) : null}

          <Button
            label="Send sign-in link"
            onPress={sendLink}
            loading={busy}
            disabled={!email.includes('@')}
            style={{ marginTop: 20 }}
          />
        </>
      )}
    </KeyboardAvoidingView>
  );
}
