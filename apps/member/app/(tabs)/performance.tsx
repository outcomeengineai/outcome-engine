import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Svg, { Path, Line as SvgLine } from 'react-native-svg';
import { COLORS, formatUsd } from '@outcome/shared';
import { Card, Empty, Hint, Loading, Money, Stat, s } from '@/components/ui';
import { usePositions } from '@/lib/data';
import { useSession } from '@/lib/session';
import type { ResolvedPosition } from '@/lib/data';

const RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 },
  { key: 'all', label: 'All', days: null },
] as const;

/**
 * Equity curve.
 *
 * Cumulative realized PnL in resolution order — deliberately not
 * mark-to-market, because an unrealized swing is not performance yet and
 * plotting it makes a quiet month look dramatic.
 */
function EquityCurve({ points }: { points: number[] }) {
  const width = 320;
  const height = 130;

  if (points.length < 2) {
    return <Empty>Not enough resolved trades to plot a curve yet.</Empty>;
  }

  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const span = max - min || 1;

  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => height - ((v - min) / span) * height;

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const last = points[points.length - 1]!;
  const stroke = last >= 0 ? COLORS.green : COLORS.red;

  return (
    <View>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        {/* the break-even line, so a curve below it is unmistakable */}
        <SvgLine
          x1={0} y1={y(0)} x2={width} y2={y(0)}
          stroke={COLORS.border} strokeWidth={1} strokeDasharray="4 3"
        />
        <Path d={d} stroke={stroke} strokeWidth={2} fill="none" strokeLinejoin="round" />
      </Svg>
      <View style={[s.rowBetween, { marginTop: 6 }]}>
        <Hint>{formatUsd(min)}</Hint>
        <Hint>{formatUsd(max)}</Hint>
      </View>
    </View>
  );
}

export default function PerformanceScreen() {
  const { mode } = useSession();
  const { data, loading } = usePositions();
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('30d');

  const stats = useMemo(() => {
    const all = (data?.resolved ?? []).filter((r) => r.mode === mode);
    const cfg = RANGES.find((r) => r.key === range)!;

    const cutoff = cfg.days === null ? 0 : Date.now() - cfg.days * 86400_000;
    const rows = all
      .filter((r) => new Date(r.resolved_at).getTime() >= cutoff)
      .sort((a, b) => a.resolved_at.localeCompare(b.resolved_at));

    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    const curve: number[] = [];

    for (const r of rows) {
      equity += r.pnl;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
      curve.push(equity);
    }

    const wins = rows.filter((r) => r.outcome === 'win').length;
    const holdSeconds = rows.reduce((sum, r) => sum + r.hold_seconds, 0);

    const byCategory = new Map<string, { pnl: number; count: number }>();
    for (const r of rows) {
      const c = byCategory.get(r.category) ?? { pnl: 0, count: 0 };
      c.pnl += r.pnl;
      c.count++;
      byCategory.set(r.category, c);
    }

    return {
      rows,
      totalPnl: equity,
      maxDrawdown,
      winRate: rows.length ? wins / rows.length : null,
      avgHoldHours: rows.length ? holdSeconds / rows.length / 3600 : 0,
      curve,
      categories: [...byCategory.entries()].sort((a, b) => b[1].pnl - a[1].pnl),
    };
  }, [data, range, mode]);

  if (loading && !data) return <Loading />;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: COLORS.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
    >
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
        {RANGES.map((r) => (
          <Pressable
            key={r.key}
            onPress={() => setRange(r.key)}
            style={{
              flex: 1, paddingVertical: 7, borderRadius: 999, alignItems: 'center',
              backgroundColor: range === r.key ? COLORS.surface : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: 13, fontWeight: '600',
                color: range === r.key ? COLORS.text : COLORS.faint,
              }}
            >
              {r.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Card>
        <Stat
          label={`${mode === 'live' ? 'Live' : 'Paper'} PnL`}
          value={<Money cents={stats.totalPnl} signed size={30} weight="700" />}
          hint={`${stats.rows.length} resolved trade(s)`}
        />
        <View style={{ marginTop: 16 }}>
          <EquityCurve points={stats.curve} />
        </View>
      </Card>

      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Stat
            label="Win rate"
            value={
              <Text style={{ fontSize: 18, fontWeight: '600' }}>
                {stats.winRate !== null ? `${(stats.winRate * 100).toFixed(0)}%` : '—'}
              </Text>
            }
          />
          <Stat label="Max drawdown" value={<Money cents={-stats.maxDrawdown} size={18} />} />
          <Stat
            label="Avg hold"
            value={
              <Text style={{ fontSize: 18, fontWeight: '600' }}>
                {stats.rows.length ? `${stats.avgHoldHours.toFixed(1)}h` : '—'}
              </Text>
            }
          />
        </View>
      </Card>

      <Card>
        <Text style={[s.h2, { marginBottom: 12 }]}>By category</Text>
        {stats.categories.length === 0 ? (
          <Empty>Nothing resolved in this range.</Empty>
        ) : (
          <View style={{ gap: 11 }}>
            {stats.categories.map(([category, c]) => (
              <View key={category} style={s.rowBetween}>
                <View>
                  <Text style={{ fontSize: 13.5 }}>{category}</Text>
                  <Hint>{c.count} trade(s)</Hint>
                </View>
                <Money cents={c.pnl} signed size={14} />
              </View>
            ))}
          </View>
        )}
      </Card>

      {mode === 'paper' ? (
        <Hint style={{ textAlign: 'center' }}>
          Showing paper results. Switch to live on the Decision Desk to see real performance.
        </Hint>
      ) : null}
    </ScrollView>
  );
}
