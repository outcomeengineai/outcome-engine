import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  COLORS, feeOnNetPnlCents, formatPriceCents, formatUsd, isStrongPick,
} from '@outcome/shared';
import {
  Banner, Card, Empty, Hint, Loading, Money, Pill, ScoreRing, relativeTime, s,
} from '@/components/ui';
import { ModeToggle } from '@/components/ModeToggle';
import { useCurrentPeriod, useDesk } from '@/lib/data';
import { liveBlockedReason, useSession } from '@/lib/session';

/**
 * Decision Desk — the core screen.
 *
 * One card per market. The model has already committed to a side, so a member
 * never sees the same question twice arguing both ways.
 */
export default function DeskScreen() {
  const router = useRouter();
  const session = useSession();
  const { profile, mode, setMode, settings } = session;

  const desk = useDesk(profile?.id);
  const period = useCurrentPeriod(profile?.id);

  const [strongOnly, setStrongOnly] = useState(true); // brief: default to Strong
  const [refreshing, setRefreshing] = useState(false);

  const blocked = liveBlockedReason(session);
  const threshold = desk.data?.strongThreshold ?? 7;
  const all = desk.data?.markets ?? [];
  const shown = strongOnly ? all.filter((m) => isStrongPick(m.score, threshold)) : all;

  const netPnl = Number(period.data?.net_pnl ?? 0);
  const feeAccruing = feeOnNetPnlCents(netPnl, settings.feeRate);

  if (desk.loading && !desk.data) return <Loading label="Scoring markets…" />;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await Promise.all([desk.reload(), period.reload()]);
            setRefreshing(false);
          }}
        />
      }
    >
      <ModeToggle mode={mode} onChange={setMode} liveBlockedReason={blocked} />

      {mode === 'live' && !blocked ? (
        <Card style={{ paddingVertical: 13 }}>
          <View style={s.rowBetween}>
            <View>
              <Hint>This period</Hint>
              <Money cents={netPnl} signed size={17} />
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Hint>Fee accruing</Hint>
              <Text style={{ fontSize: 17, fontWeight: '600', color: COLORS.gold }}>
                {formatUsd(feeAccruing)}
              </Text>
            </View>
          </View>
        </Card>
      ) : null}

      {settings.killSwitch ? (
        <Banner tone="danger" title="Trading halted">
          No new trades can be opened right now, in either mode.
        </Banner>
      ) : null}

      {/* --- filter ------------------------------------------------------ */}
      <View style={[s.rowBetween]}>
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
          {([
            ['Strong', true],
            ['All', false],
          ] as const).map(([label, value]) => (
            <Pressable
              key={label}
              onPress={() => setStrongOnly(value)}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 16,
                borderRadius: 999,
                backgroundColor: strongOnly === value ? COLORS.surface : 'transparent',
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: '600',
                  color: strongOnly === value ? COLORS.text : COLORS.faint,
                }}
              >
                {label}
                {value ? ` ${threshold.toFixed(0)}+` : ''}
              </Text>
            </Pressable>
          ))}
        </View>

        <Hint>{desk.data?.versionLabel}</Hint>
      </View>

      {/* --- cards -------------------------------------------------------- */}
      {shown.length === 0 ? (
        <Card>
          <Empty>
            {all.length === 0
              ? 'No markets are scoring above the surfacing threshold right now. Scores refresh every few minutes.'
              : `Nothing at ${threshold.toFixed(1)}+ right now. Switch to All to see everything that surfaced.`}
          </Empty>
        </Card>
      ) : (
        shown.map((m) => {
          const topTag = m.tags[0];
          return (
            <Pressable
              key={m.market_id}
              onPress={() => router.push(`/market/${encodeURIComponent(m.market_id)}`)}
            >
              <Card>
                <View style={[s.row, { gap: 14, alignItems: 'flex-start' }]}>
                  <ScoreRing score={m.score} size={54} />

                  <View style={{ flex: 1 }}>
                    <View style={[s.row, { gap: 6, marginBottom: 6, flexWrap: 'wrap' }]}>
                      <Pill tone="muted">{m.category}</Pill>
                      <Pill tone={m.side === 'YES' ? 'green' : 'blue'}>{m.side}</Pill>
                      {isStrongPick(m.score, threshold) ? <Pill tone="green">STRONG</Pill> : null}
                    </View>

                    <Text style={{ fontSize: 14.5, lineHeight: 20, fontWeight: '500' }}>
                      {m.question}
                    </Text>

                    <Hint style={{ marginTop: 5 }}>
                      {m.side_price !== null ? formatPriceCents(m.side_price) : '—'}
                      {m.close_time
                        ? ` · closes ${new Date(m.close_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                        : ''}
                      {` · scored ${relativeTime(m.scored_at)}`}
                    </Hint>

                    {topTag ? (
                      <Text
                        style={{
                          marginTop: 8,
                          fontSize: 12,
                          lineHeight: 17,
                          color: topTag.severity === 'caution' ? COLORS.gold : COLORS.blue,
                        }}
                      >
                        {topTag.text}
                        {m.tags.length > 1 ? `  +${m.tags.length - 1}` : ''}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </Card>
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}
