import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

/**
 * Expo push registration.
 *
 * Entirely optional: a member who declines notifications still sees everything
 * in the in-app notification centre, and send-notifications marks rows as sent
 * when there is no device to push to rather than retrying them forever.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPush(): Promise<string | null> {
  // Simulators cannot receive push, and asking there produces a confusing
  // permission dialog that can never succeed.
  if (!Device.isDevice) return null;

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;

  if (status !== 'granted') {
    const asked = await Notifications.requestPermissionsAsync();
    status = asked.status;
  }
  if (status !== 'granted') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Outcome Engine',
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: '#1FBE87',
    });
  }

  // getExpoPushTokenAsync THROWS without a project id — it cannot mint a token
  // that Expo's service would route. Check first and degrade to "push off"
  // rather than letting an exception escape into the sign-in path.
  //
  // `eas init` writes this into app.json as extra.eas.projectId. Until then
  // push is simply unavailable; the notification centre in the app still shows
  // everything, and send-notifications marks rows delivered for members with
  // no registered device instead of retrying them forever.
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as any)?.easConfig?.projectId;

  if (!projectId) {
    console.warn(
      '[push] disabled: no EAS project id. Run `eas init` in apps/member to enable ' +
        'push notifications. In-app notifications are unaffected.',
    );
    return null;
  }

  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch (err) {
    // A misconfigured project, a revoked credential, or no network. None of
    // these should break the app — they only mean no push.
    console.warn('[push] could not obtain a token:', err instanceof Error ? err.message : err);
    return null;
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return token;

  // Upsert keyed on (user_id, expo_push_token): reinstalls issue a new token,
  // and stale ones are pruned by the send job when Expo reports them dead.
  await supabase.from('devices').upsert(
    {
      user_id: user.id,
      expo_push_token: token,
      platform: Platform.OS,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,expo_push_token' },
  );

  return token;
}
