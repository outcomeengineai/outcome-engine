import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { COLORS, formatPriceCents } from '@outcome/shared';
import {
  Card, Empty, Hint, Loading, ModePill, Money, Pill, Stat, relativeTime, s,
} from '@/components/ui';
import { usePositions } from '@/lib/data';

export default function PositionsScreen() {
  const router = useRouter();
  const { data, loading, reload } = usePositions();
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const [refreshing, setRefreshing] = useState(false);

  if (loading && !data) return <Loading />;

  const open = data?.open ?? [];
  const resolved = data?.resolved ?? [];

  const totalOpen = open.reduce((s, p) => s + p.stake_cents, 0);
  const largest = open.reduce((m, p) => Math.max(m, p.stake_cents), 0);
  const largestPct = totalOpen > 0 ? (largest / totalOpen) * 100 : 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => { setRefreshing(true); await reload(); setRefreshing(false); }}
        />
      }
    >
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Stat label="Total open" value={<Money cents={totalOpen} size={18} />} />
          <Stat
            label="Positions"
            value={<Text style={{ fontSize: 18, fontWeight: '600' }}>{open.length}</Text>}
          />
          <Stat
            label="Largest"
            value={<Money cents={largest} size={18} />}
            hint={totalOpen > 0 ? `${largestPct.toFixed(0)}% of book` : undefined}
          />
        </View>
      </Card>

      <View
        style={{
          flexDirection: 'row',
          backgroundColor: COLORS.surfaceMuted,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: COLORS.border,
          padding: 3,
        }}
      >
        {([['open', `Open ${open.length}`], ['resolved', `Resolved ${resolved.length}`]] as const).map(
          ([key, label]) => (
            <Pressable
              key={key}
              onPress={() => setTab(key)}
              style={{
                flex: 1, paddingVertical: 8, borderRadius: 999, alignItems: 'center',
                backgroundColor: tab === key ? COLORS.surface : 'transparent',
              }}
            >
              <Text
                style={{
                  fontSize: 13.5, fontWeight: '600',
                  color: tab === key ? COLORS.text : COLORS.faint,
                }}
              >
                {label}
              </Text>
            </Pressable>
          ),
        )}
      </View>

      {tab === 'open' ? (
        open.length === 0 ? (
          <Card><Empty>No open positions. Take one from the Decision Desk.</Empty></Card>
        ) : (
          open.map((p) => (
            <Pressable
              key={p.trade_id}
              onPress={() => router.push(`/market/${encodeURIComponent(p.market_id)}`)}
            >
              <Card>
                <View style={[s.row, { gap: 6, marginBottom: 7, flexWrap: 'wrap' }]}>
                  <ModePill mode={p.mode} />
                  <Pill tone={p.side === 'YES' ? 'green' : 'blue'}>{p.side}</Pill>
                  <Pill tone="muted">{p.category}</Pill>
                </View>

                <Text style={{ fontSize: 14, lineHeight: 19.5, fontWeight: '500' }} numberOfLines={2}>
                  {p.question}
                </Text>

                <View style={[s.rowBetween, { marginTop: 12 }]}>
                  <View>
                    <Hint>Entry → now</Hint>
                    <Text style={{ fontSize: 14, fontWeight: '600', marginTop: 2 }}>
                      {formatPriceCents(p.entry_price)} →{' '}
                      {p.current_price !== null ? formatPriceCents(p.current_price) : '—'}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Hint>Unrealized</Hint>
                    <Money cents={p.unrealized_pnl} signed size={16} />
                  </View>
                </View>

                <Hint style={{ marginTop: 10 }}>
                  {p.contracts} contracts · scored {p.entry_score.toFixed(1)} on{' '}
                  {p.entry_model_label} · opened {relativeTime(p.opened_at)}
                </Hint>
              </Card>
            </Pressable>
          ))
        )
      ) : resolved.length === 0 ? (
        <Card><Empty>Nothing has resolved yet.</Empty></Card>
      ) : (
        resolved.map((r) => (
          <Card key={r.trade_id}>
            <View style={s.rowBetween}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <View style={[s.row, { gap: 6, marginBottom: 6, flexWrap: 'wrap' }]}>
                  <ModePill mode={r.mode} />
                  <Pill tone={r.outcome === 'win' ? 'green' : 'red'}>
                    {r.outcome === 'win' ? '✓ WIN' : '✕ LOSS'}
                  </Pill>
                </View>
                <Text style={{ fontSize: 13.5, lineHeight: 19 }} numberOfLines={2}>
                  {r.question}
                </Text>
                <Hint style={{ marginTop: 5 }}>
                  {r.side} at {formatPriceCents(r.entry_price)} · {r.entry_model_label} ·{' '}
                  {relativeTime(r.resolved_at)}
                </Hint>
              </View>
              <Money cents={r.pnl} signed size={17} />
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}
