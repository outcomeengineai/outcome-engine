import { Stack } from 'expo-router';
import { COLORS } from '@outcome/shared';

/**
 * Onboarding runs as its own stack so the member cannot swipe back into the
 * app before the flow completes, and so each step keeps its own header.
 */
export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.bg },
        headerShadowVisible: false,
        headerTintColor: COLORS.text,
        headerTitleStyle: { fontSize: 15, fontWeight: '600' },
        contentStyle: { backgroundColor: COLORS.bg },
      }}
    >
      <Stack.Screen name="invite" options={{ headerShown: false }} />
      <Stack.Screen name="auth" options={{ title: 'Sign in' }} />
      <Stack.Screen name="explainer" options={{ title: 'How this works' }} />
      <Stack.Screen name="agreement" options={{ title: 'Before you start' }} />
      <Stack.Screen name="payment" options={{ title: 'Payment method' }} />
      <Stack.Screen name="kalshi" options={{ title: 'Connect Kalshi' }} />
    </Stack>
  );
}
