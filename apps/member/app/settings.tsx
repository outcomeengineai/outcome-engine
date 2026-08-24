import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { COLORS } from '@outcome/shared';
import type { ModelVersion } from '@outcome/shared';
import { Banner, Button, Card, Hint, Money, Pill, s } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { useKalshiConnection } from '@/lib/data';

/**
 * Settings.
 *
 * The interesting part is the model-version picker: during a transition window
 * a member may stay on the previous stable version. Once the window closes the
 * pin simply stops being honoured — there is no job that has to remember to
 * unpin anyone.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const { profile, signOut, refresh } = useSession();
  const connection = useKalshiConnection(profile?.id);

  const [versions, setVersions] = useState<ModelVersion[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('model_versions')
        .select('*')
        .in('status', ['stable', 'deprecated'])
        .order('published_at', { ascending: false })
        .limit(5);
      setVersions((data ?? []) as ModelVersion[]);
    })();
  }, []);

  const current = versions?.find((v) => v.status === 'stable' && !v.transition_ends_at) ?? null;

  // Only versions whose transition window is still open may be pinned.
  const pinnable = (versions ?? []).filter(
    (v) => v.transition_ends_at && new Date(v.transition_ends_at) > new Date(),
  );

  async function pinVersion(id: string | null) {
    if (!profile) return;
    setBusy(true);
    try {
      await supabase.from('users').update({ preferred_model_version_id: id }).eq('id', profile.id);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function disconnectKalshi() {
    if (!profile) return;
    Alert.alert(
      'Disconnect Kalshi?',
      'Your stored API key is deleted. Open positions stay in your Kalshi account and will still resolve, but the app can no longer settle them automatically or place live trades.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('kalshi_connections').delete().eq('user_id', profile.id);
            await Promise.all([connection.reload(), refresh()]);
          },
        },
      ],
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
    >
      <Card>
        <Text style={s.h2}>{profile?.display_name ?? profile?.email}</Text>
        <Hint style={{ marginTop: 3 }}>{profile?.email}</Hint>
        <View style={[s.row, { gap: 6, marginTop: 10 }]}>
          <Pill tone={profile?.role === 'admin' ? 'blue' : 'muted'}>{profile?.role}</Pill>
          <Pill
            tone={
              profile?.account_status === 'active' ? 'green'
                : profile?.account_status === 'grace' ? 'gold'
                  : profile?.account_status === 'paused' ? 'red' : 'muted'
            }
          >
            {profile?.account_status}
          </Pill>
        </View>
      </Card>

      {/* --- Kalshi ------------------------------------------------------- */}
      <Card>
        <View style={s.rowBetween}>
          <View>
            <Text style={s.h2}>Kalshi account</Text>
            <Hint style={{ marginTop: 3 }}>
              {connection.data?.status === 'connected'
                ? 'Connected with your own API key.'
                : connection.data?.status === 'error'
                  ? 'Your key was rejected. Reconnect to trade live.'
                  : 'Not connected — live trading is unavailable.'}
            </Hint>
          </View>
          <Pill
            tone={
              connection.data?.status === 'connected' ? 'green'
                : connection.data?.status === 'error' ? 'red' : 'muted'
            }
          >
            {connection.data?.status ?? 'none'}
          </Pill>
        </View>

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          <Button
            label={connection.data?.status ? 'Reconnect' : 'Connect'}
            variant="secondary"
            onPress={() => router.push('/(onboarding)/kalshi')}
            style={{ flex: 1 }}
          />
          {connection.data?.status ? (
            <Button label="Disconnect" variant="ghost" onPress={disconnectKalshi} style={{ flex: 1 }} />
          ) : null}
        </View>

        <Hint style={{ marginTop: 10 }}>
          Your key is stored encrypted server-side and used only to place your own trades. It is
          never on this phone and cannot be read back by the app.
        </Hint>
      </Card>

      {/* --- model version ------------------------------------------------ */}
      <Card>
        <Text style={[s.h2, { marginBottom: 4 }]}>Scoring model</Text>
        <Hint style={{ marginBottom: 12 }}>
          Which version scores the markets you see. Trades you have already opened always keep the
          version and score they were opened on.
        </Hint>

        {pinnable.length === 0 ? (
          <View style={s.rowBetween}>
            <Text style={{ fontSize: 14, fontWeight: '600' }}>
              {current?.version_label ?? '—'}
            </Text>
            <Pill tone="green">current</Pill>
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Pressable onPress={() => pinVersion(null)} disabled={busy}>
              <View
                style={{
                  borderWidth: 1, borderRadius: 10, padding: 12,
                  borderColor: !profile?.preferred_model_version_id ? COLORS.green : COLORS.border,
                  backgroundColor: !profile?.preferred_model_version_id ? '#E4F7EF' : 'transparent',
                }}
              >
                <View style={s.rowBetween}>
                  <Text style={{ fontSize: 14, fontWeight: '600' }}>
                    {current?.version_label ?? 'Latest'}
                  </Text>
                  <Pill tone="green">newest</Pill>
                </View>
              </View>
            </Pressable>

            {pinnable.map((v) => (
              <Pressable key={v.id} onPress={() => pinVersion(v.id)} disabled={busy}>
                <View
                  style={{
                    borderWidth: 1, borderRadius: 10, padding: 12,
                    borderColor: profile?.preferred_model_version_id === v.id ? COLORS.green : COLORS.border,
                    backgroundColor: profile?.preferred_model_version_id === v.id ? '#E4F7EF' : 'transparent',
                  }}
                >
                  <View style={s.rowBetween}>
                    <Text style={{ fontSize: 14, fontWeight: '600' }}>{v.version_label}</Text>
                    <Pill tone="gold">
                      until {new Date(v.transition_ends_at!).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric',
                      })}
                    </Pill>
                  </View>
                  <Hint style={{ marginTop: 4 }}>
                    Retires automatically when the window closes.
                  </Hint>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </Card>

      <Button label="Billing" variant="secondary" onPress={() => router.push('/billing')} />
      <Button label="Activity" variant="secondary" onPress={() => router.push('/activity')} />
      <Button label="Sign out" variant="ghost" onPress={signOut} />
    </ScrollView>
  );
}
