import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import Svg, { Circle } from 'react-native-svg';
import {
  BAND_COLORS,
  COLORS,
  SIGNAL_COLORS,
  SIGNAL_LABELS,
  formatUsd,
  scoreBand,
} from '@outcome/shared';
import type { ScoreBreakdown, SignalKey, TradeMode } from '@outcome/shared';

export const T = {
  ...COLORS,
  mono: 'JetBrainsMono-Regular',
} as const;

/**
 * Numbers use a monospaced face everywhere — scores, prices, PnL. On a device
 * that has not loaded the custom font this falls back to the platform
 * monospace, which keeps digits aligned even if the face is different.
 */
export const monoFont = { fontVariant: ['tabular-nums' as const] };

// --------------------------------------------------------------------------

export function Card({ children, style }: { children: ReactNode; style?: any }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Screen({ children, style }: { children: ReactNode; style?: any }) {
  return <View style={[s.screen, style]}>{children}</View>;
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={s.center}>
      <ActivityIndicator color={COLORS.green} />
      {label ? <Text style={[s.hint, { marginTop: 10 }]}>{label}</Text> : null}
    </View>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={s.eyebrow}>{children}</Text>;
}

export function Hint({ children, style }: { children: ReactNode; style?: any }) {
  return <Text style={[s.hint, style]}>{children}</Text>;
}

// --------------------------------------------------------------------------

/** The signature score ring, coloured by band: green ≥7, gold 4.5–7, red <4.5. */
export function ScoreRing({ score, size = 52 }: { score: number; size?: number }) {
  const color = BAND_COLORS[scoreBand(score)];
  const stroke = size >= 72 ? 6 : 4;
  const r = (size - stroke * 2) / 2;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(10, score)) / 10) * circumference;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={COLORS.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2} cy={size / 2} r={r}
          stroke={color} strokeWidth={stroke} fill="none"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
        />
      </Svg>
      <Text
        style={[
          monoFont,
          {
            color,
            fontWeight: '600',
            fontSize: size >= 72 ? 26 : size >= 56 ? 18 : 15,
            letterSpacing: -0.5,
          },
        ]}
      >
        {score.toFixed(1)}
      </Text>
    </View>
  );
}

/**
 * "Why this score" — one bar per signal, widths proportional to the final
 * score so the three visibly add up to it.
 */
export function BreakdownBars({
  breakdown,
  total,
}: {
  breakdown: ScoreBreakdown;
  total: number;
}) {
  const keys: SignalKey[] = ['micro', 'news', 'base'];
  return (
    <View style={{ gap: 12 }}>
      {keys.map((k) => {
        const value = Number(breakdown?.[k] ?? 0);
        const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
        return (
          <View key={k}>
            <View style={s.rowBetween}>
              <Text style={{ fontSize: 13, color: COLORS.muted }}>{SIGNAL_LABELS[k]}</Text>
              <Text style={[monoFont, { fontSize: 12, color: COLORS.faint }]}>{value.toFixed(1)}</Text>
            </View>
            <View style={s.barTrack}>
              <View style={[s.barFill, { width: `${pct}%`, backgroundColor: SIGNAL_COLORS[k] }]} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

// --------------------------------------------------------------------------

export type Tone = 'green' | 'blue' | 'red' | 'gold' | 'muted' | 'purple';

const TONE_BG: Record<Tone, string> = {
  green: '#E4F7EF',
  blue: '#E8F0FF',
  red: '#FDECEB',
  gold: '#FDF2E0',
  muted: COLORS.surfaceMuted,
  purple: '#F0EBFB',
};

const TONE_FG: Record<Tone, string> = {
  green: COLORS.greenDark,
  blue: '#2C5FD0',
  red: '#B83C38',
  gold: '#9A6B16',
  muted: COLORS.muted,
  purple: '#6A4FC0',
};

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: Tone }) {
  return (
    <View style={[s.pill, { backgroundColor: TONE_BG[tone] }]}>
      <Text style={{ color: TONE_FG[tone], fontSize: 11, fontWeight: '600' }}>{children}</Text>
    </View>
  );
}

/**
 * Paper vs live must be unmistakable everywhere it appears — a member should
 * never have to work out which one they are looking at.
 */
export function ModePill({ mode }: { mode: TradeMode }) {
  return mode === 'live'
    ? <Pill tone="green">● LIVE</Pill>
    : <Pill tone="purple">PAPER</Pill>;
}

export function Money({
  cents,
  signed = false,
  size = 15,
  weight = '600',
}: {
  cents: number | null | undefined;
  signed?: boolean;
  size?: number;
  weight?: '400' | '500' | '600' | '700';
}) {
  if (cents === null || cents === undefined) {
    return <Text style={[monoFont, { color: COLORS.faint, fontSize: size }]}>—</Text>;
  }
  const color = !signed ? COLORS.text : cents > 0 ? COLORS.greenDark : cents < 0 ? COLORS.red : COLORS.text;
  return (
    <Text style={[monoFont, { color, fontSize: size, fontWeight: weight, letterSpacing: -0.3 }]}>
      {formatUsd(cents, { signed })}
    </Text>
  );
}

export function Stat({
  label,
  value,
  hint,
  light = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  light?: boolean;
}) {
  return (
    <View>
      <Text style={[s.eyebrow, light ? { color: 'rgba(255,255,255,0.78)' } : null]}>{label}</Text>
      <View style={{ marginTop: 4 }}>{value}</View>
      {hint ? (
        <Text style={[s.hint, light ? { color: 'rgba(255,255,255,0.78)' } : null, { marginTop: 3 }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: any;
}) {
  const bg =
    variant === 'primary' ? COLORS.green
      : variant === 'danger' ? COLORS.red
        : variant === 'ghost' ? 'transparent'
          : COLORS.surface;

  const fg = variant === 'primary' || variant === 'danger' ? '#fff' : COLORS.text;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        s.button,
        {
          backgroundColor: bg,
          borderColor: variant === 'ghost' ? 'transparent' : variant === 'secondary' ? COLORS.border : bg,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <Text style={{ color: fg, fontWeight: '600', fontSize: 15 }}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Banner({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'warn' | 'danger';
  title?: string;
  children: ReactNode;
}) {
  const palette = {
    info: { bg: '#EEF4FF', border: '#CDDCFB', fg: '#2B4F9E' },
    warn: { bg: '#FDF5E8', border: '#F2DDB6', fg: '#7D5610' },
    danger: { bg: '#FDECEB', border: '#F6CDCB', fg: '#8F2F2C' },
  }[tone];

  return (
    <View style={[s.banner, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      {title ? (
        <Text style={{ color: palette.fg, fontWeight: '700', fontSize: 13.5, marginBottom: 3 }}>
          {title}
        </Text>
      ) : null}
      <Text style={{ color: palette.fg, fontSize: 13, lineHeight: 19 }}>{children}</Text>
    </View>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <View style={{ paddingVertical: 44, alignItems: 'center' }}>
      <Text style={{ color: COLORS.faint, fontSize: 13, textAlign: 'center' }}>{children}</Text>
    </View>
  );
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },

  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
  },

  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },

  eyebrow: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: COLORS.faint,
  },

  hint: { fontSize: 12, color: COLORS.faint, lineHeight: 17 },

  h1: { fontSize: 24, fontWeight: '700', color: COLORS.text, letterSpacing: -0.4 },
  h2: { fontSize: 16, fontWeight: '600', color: COLORS.text },

  pill: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },

  barTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: COLORS.border,
    marginTop: 5,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 999 },

  button: {
    paddingVertical: 13,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },

  banner: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 13,
  },

  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.surface,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: COLORS.text,
  },
});
