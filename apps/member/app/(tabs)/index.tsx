import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { COLORS, feeOnNetPnlCents, formatPriceCents, formatUsd } from '@outcome/shared';
import {
  Banner, Button, Card, Empty, Eyebrow, Hint, Loading, ModePill, Money,
  Pill, ScoreRing, Stat, relativeTime, s,
} from '@/components/ui';
import { useCurrentPeriod, useDesk, usePositions } from '@/lib/data';
import { useSession } from '@/lib/session';

/**
 * Home — the glance screen.
 *
 * Everything here answers one of three questions: how am I doing, what is
 * open, and what should I look at next.
 */
export default function HomeScreen() {
  const router = useRouter();
  const { profile, settings, mode } = useSession();

  const desk = useDesk(profile?.id);
  const positions = usePositions();
  const period = useCurrentPeriod(profile?.id);
  const [refreshing, setRefreshing] = useState(false);

  if (positions.loading && !positions.data) return <Loading />;

  const open = positions.data?.open ?? [];
  const openInMode = open.filter((p) => p.mode === mode);
  const exposure = openInMode.reduce((sum, p) => sum + p.stake_cents, 0);
  const unrealized = openInMode.reduce((sum, p) => sum + p.unrealized_pnl, 0);
  const largest = openInMode.reduce((m, p) => Math.max(m, p.stake_cents), 0);

  // Live figures come from the billing period; paper has no billing, so its
  // "period" is simply the resolved paper PnL this month.
  const netPnl = mode === 'live'
    ? Number(period.data?.net_pnl ?? 0)
    : (positions.data?.resolved ?? [])
      .filter((r) => r.mode === 'paper')
      .reduce((sum, r) => sum + r.pnl, 0);

  const feeAccruing = mode === 'live' ? feeOnNetPnlCents(netPnl, settings.feeRate) : 0;

  const topPicks = (desk.data?.markets ?? []).slice(0, 3);

  async function refreshAll() {
    setRefreshing(true);
    await Promise.all([desk.reload(), positions.reload(), period.reload()]);
    setRefreshing(false);
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} />}
    >
      {profile?.account_status === 'grace' ? (
        <Banner tone="warn" title="Payment failed">
          We could not charge your card for last month&rsquo;s fee. Update it in Billing to keep
          trading live — your open positions are unaffected.
        </Banner>
      ) : null}

      {profile?.account_status === 'paused' ? (
        <Banner tone="danger" title="Account paused">
          An unpaid fee has passed its grace period. Settle it in Billing to resume.
        </Banner>
      ) : null}

      {settings.killSwitch ? (
        <Banner tone="danger" title="Trading halted">
          The admin has paused all platform trading. Your open positions are untouched and will
          still resolve.
        </Banner>
      ) : null}

      {/* --- hero: period PnL ------------------------------------------- */}
      <View
        style={{
          borderRadius: 16,
          padding: 20,
          backgroundColor: COLORS.blue,
          overflow: 'hidden',
        }}
      >
        {/* A flat blue-to-green feel without a gradient dependency: the green
            block reads as the second stop of the brand gradient. */}
        <View
          style={{
            position: 'absolute', right: -40, top: -40,
            width: 220, height: 220, borderRadius: 999,
            backgroundColor: COLORS.green, opacity: 0.85,
          }}
        />
        <View style={[s.rowBetween, { marginBottom: 14 }]}>
          <Eyebrow>
            <Text style={{ color: 'rgba(255,255,255,0.8)' }}>This period</Text>
          </Eyebrow>
          <ModePill mode={mode} />
        </View>

        <Text style={{ color: '#fff', fontSize: 34, fontWeight: '700', letterSpacing: -1 }}>
          {formatUsd(netPnl, { signed: true })}
        </Text>

        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12.5, marginTop: 6 }}>
          {mode === 'live'
            ? feeAccruing > 0
              ? `${formatUsd(feeAccruing)} fee accruing · ${Math.round(settings.feeRate * 100)}% of net profit`
              : 'No fee — you are not in net profit this period'
            : 'Paper mode — practice only, never billed'}
        </Text>
      </View>

      {/* --- exposure ---------------------------------------------------- */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Stat label="Open" value={<Money cents={exposure} size={18} />} />
          <Stat
            label="Unrealized"
            value={<Money cents={unrealized} signed size={18} />}
          />
          <Stat
            label="Positions"
            value={<Text style={{ fontSize: 18, fontWeight: '600' }}>{openInMode.length}</Text>}
          />
          <Stat label="Largest" value={<Money cents={largest} size={18} />} />
        </View>
      </Card>

      {/* --- top picks --------------------------------------------------- */}
      <View>
        <View style={[s.rowBetween, { marginBottom: 8 }]}>
          <Text style={s.h2}>Top picks</Text>
          <Pressable onPress={() => router.push('/(tabs)/desk')}>
            <Text style={{ color: COLORS.greenDark, fontSize: 13, fontWeight: '600' }}>
              Decision Desk →
            </Text>
          </Pressable>
        </View>

        {desk.loading && !desk.data ? (
          <Card><Hint>Loading scores…</Hint></Card>
        ) : topPicks.length === 0 ? (
          <Card>
            <Empty>
              Nothing above the surfacing threshold right now. Scores refresh every few minutes.
            </Empty>
          </Card>
        ) : (
          <View style={{ gap: 10 }}>
            {topPicks.map((m) => (
              <Pressable
                key={m.market_id}
                onPress={() => router.push(`/market/${encodeURIComponent(m.market_id)}`)}
              >
                <Card>
                  <View style={[s.row, { gap: 13, alignItems: 'flex-start' }]}>
                    <ScoreRing score={m.score} size={48} />
                    <View style={{ flex: 1 }}>
                      <View style={[s.row, { gap: 6, marginBottom: 5 }]}>
                        <Pill tone="muted">{m.category}</Pill>
                        <Pill tone={m.side === 'YES' ? 'green' : 'blue'}>{m.side}</Pill>
                      </View>
                      <Text style={{ fontSize: 14, lineHeight: 19, fontWeight: '500' }} numberOfLines={2}>
                        {m.question}
                      </Text>
                      <Hint style={{ marginTop: 4 }}>
                        {m.side_price !== null ? formatPriceCents(m.side_price) : '—'}
                      </Hint>
                    </View>
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* --- recent activity --------------------------------------------- */}
      <View>
        <View style={[s.rowBetween, { marginBottom: 8 }]}>
          <Text style={s.h2}>Recent</Text>
          <Pressable onPress={() => router.push('/activity')}>
            <Text style={{ color: COLORS.greenDark, fontSize: 13, fontWeight: '600' }}>All →</Text>
          </Pressable>
        </View>

        <Card style={{ gap: 12 }}>
          {(positions.data?.resolved ?? []).slice(0, 3).map((r) => (
            <View key={r.trade_id} style={s.rowBetween}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={{ fontSize: 13 }} numberOfLines={1}>{r.question}</Text>
                <View style={[s.row, { gap: 6, marginTop: 3 }]}>
                  <ModePill mode={r.mode} />
                  <Hint>{relativeTime(r.resolved_at)}</Hint>
                </View>
              </View>
              <Money cents={r.pnl} signed size={14} />
            </View>
          ))}
          {(positions.data?.resolved ?? []).length === 0 ? (
            <Empty>Nothing resolved yet.</Empty>
          ) : null}
        </Card>
      </View>

      {/* --- shortcuts ---------------------------------------------------- */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button
          label="Billing"
          variant="secondary"
          onPress={() => router.push('/billing')}
          style={{ flex: 1 }}
        />
        <Button
          label="Notifications"
          variant="secondary"
          onPress={() => router.push('/notifications')}
          style={{ flex: 1 }}
        />
        <Button
          label="Settings"
          variant="secondary"
          onPress={() => router.push('/settings')}
          style={{ flex: 1 }}
        />
      </View>
    </ScrollView>
  );
}
