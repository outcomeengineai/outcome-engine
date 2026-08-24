import { useEffect } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { COLORS, formatScore } from '@outcome/shared';
import { Card, Empty, Hint, Loading, Pill, relativeTime, s } from '@/components/ui';
import { useNotifications } from '@/lib/data';
import { supabase } from '@/lib/supabase';

const TONE: Record<string, 'green' | 'gold' | 'red' | 'blue' | 'purple' | 'muted'> = {
  'trade.resolved': 'green',
  'trade.partial_fill': 'gold',
  'billing.charged': 'blue',
  'billing.paid': 'green',
  'billing.failed': 'red',
  'billing.paused': 'red',
  'billing.no_fee': 'muted',
  'model.published': 'purple',
  'model.retuned': 'purple',
};

const RECOMMENDATION_LABEL: Record<string, string> = {
  hold: 'Hold',
  review: 'Worth a look',
  consider_exit: 'Consider exiting',
};

export default function NotificationsScreen() {
  const router = useRouter();
  const { data, loading } = useNotifications();

  // Opening the centre is the read receipt. Marking each one individually
  // would be busywork for the member and extra writes for no benefit.
  useEffect(() => {
    if (!data?.length) return;
    const unread = data.filter((n) => !n.read_at).map((n) => n.id);
    if (unread.length === 0) return;
    supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .in('id', unread)
      .then(() => { /* best effort */ });
  }, [data]);

  if (loading && !data) return <Loading />;

  const rows = data ?? [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 10 }}
    >
      {rows.length === 0 ? (
        <Card><Empty>Nothing yet.</Empty></Card>
      ) : (
        rows.map((n) => {
          const payload = (n.payload ?? {}) as Record<string, any>;
          const isRetune = n.type === 'model.retuned';
          const marketId = payload.market_id as string | undefined;

          const body = (
            <Card style={!n.read_at ? { borderColor: COLORS.green } : undefined}>
              <View style={[s.rowBetween, { marginBottom: 6 }]}>
                <Pill tone={TONE[n.type] ?? 'muted'}>{n.type.split('.')[1] ?? n.type}</Pill>
                <Hint>{relativeTime(n.created_at)}</Hint>
              </View>

              <Text style={{ fontSize: 14.5, fontWeight: '600' }}>{n.title}</Text>
              {n.body ? (
                <Text style={{ fontSize: 13, lineHeight: 19, color: COLORS.muted, marginTop: 4 }}>
                  {n.body}
                </Text>
              ) : null}

              {isRetune ? (
                <View
                  style={{
                    marginTop: 11,
                    padding: 11,
                    borderRadius: 10,
                    backgroundColor: COLORS.surfaceMuted,
                    gap: 6,
                  }}
                >
                  <View style={s.rowBetween}>
                    <Hint>Score at entry</Hint>
                    <Text style={{ fontSize: 13, fontWeight: '600' }}>
                      {formatScore(Number(payload.entry_score ?? 0))}
                    </Text>
                  </View>
                  <View style={s.rowBetween}>
                    <Hint>New score</Hint>
                    <Text style={{ fontSize: 13, fontWeight: '600' }}>
                      {formatScore(Number(payload.new_score ?? 0))}
                    </Text>
                  </View>
                  <View style={s.rowBetween}>
                    <Hint>Platform view</Hint>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: COLORS.text }}>
                      {RECOMMENDATION_LABEL[payload.recommendation as string] ?? '—'}
                    </Text>
                  </View>
                  <Hint style={{ marginTop: 2 }}>
                    Your trade keeps the score and version it was opened on — nothing was
                    rewritten. This is only what the new model would say today.
                  </Hint>
                </View>
              ) : null}
            </Card>
          );

          return marketId ? (
            <Pressable
              key={n.id}
              onPress={() => router.push(`/market/${encodeURIComponent(marketId)}`)}
            >
              {body}
            </Pressable>
          ) : (
            <View key={n.id}>{body}</View>
          );
        })
      )}
    </ScrollView>
  );
}
