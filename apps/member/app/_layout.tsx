import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { COLORS } from '@outcome/shared';
import { SessionProvider, useSession } from '@/lib/session';
import { registerForPush } from '@/lib/push';
import { supabase } from '@/lib/supabase';
import { Loading } from '@/components/ui';

/**
 * Routing gate.
 *
 * Three states, checked in order: signed out -> onboarding -> the app. Doing
 * this in one place means no individual screen has to guard itself, and there
 * is no window where a half-onboarded member sees the Decision Desk.
 */
function Gate() {
  const { loading, session, onboarding } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const group = segments[0];
    const inOnboarding = group === '(onboarding)';

    if (!session) {
      if (!inOnboarding) router.replace('/(onboarding)/invite');
      return;
    }

    if (!onboarding.complete) {
      // Signed in but not through the flow — resume where they stopped rather
      // than restarting from the invite screen.
      if (!inOnboarding) router.replace('/(onboarding)/explainer');
      return;
    }

    if (inOnboarding) router.replace('/(tabs)');
  }, [loading, session, onboarding.complete, segments, router]);

  useEffect(() => {
    if (session) registerForPush().catch(() => { /* push is optional */ });
  }, [session]);

  if (loading) return <Loading label="Loading…" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.bg },
        headerShadowVisible: false,
        headerTintColor: COLORS.text,
        headerTitleStyle: { fontSize: 16, fontWeight: '600' },
        contentStyle: { backgroundColor: COLORS.bg },
      }}
    >
      <Stack.Screen name="(onboarding)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="market/[id]" options={{ title: 'Market' }} />
      <Stack.Screen name="billing" options={{ title: 'Billing' }} />
      <Stack.Screen name="activity" options={{ title: 'Activity' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
    </Stack>
  );
}

export default function RootLayout() {
  // Magic links arrive as a deep link rather than a browser redirect, so the
  // session has to be established by hand from the URL fragment.
  useEffect(() => {
    const handle = async (url: string) => {
      const parsed = Linking.parse(url);
      const params = (parsed.queryParams ?? {}) as Record<string, string>;
      const fragment = url.includes('#') ? url.split('#')[1] : '';
      const frag = Object.fromEntries(new URLSearchParams(fragment));

      const access_token = params.access_token ?? frag.access_token;
      const refresh_token = params.refresh_token ?? frag.refresh_token;

      if (access_token && refresh_token) {
        await supabase.auth.setSession({ access_token, refresh_token });
      } else if (params.code) {
        await supabase.auth.exchangeCodeForSession(params.code);
      }
    };

    Linking.getInitialURL().then((url) => { if (url) handle(url); });
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <Gate />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
