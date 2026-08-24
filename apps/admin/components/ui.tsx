import { formatUsd, scoreBand, BAND_COLORS, SIGNAL_COLORS, SIGNAL_LABELS } from '@outcome/shared';
import type { ScoreBreakdown, SignalKey } from '@outcome/shared';
import type { ReactNode } from 'react';

/** The signature score ring: 1–10, coloured by band. */
export function ScoreRing({ score, size = 52 }: { score: number; size?: number }) {
  const color = BAND_COLORS[scoreBand(score)];
  const stroke = size >= 72 ? 5 : 4;
  const r = (size - stroke * 2) / 2;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(10, score)) / 10) * circumference;

  return (
    <div style={{ position: 'relative', width: size, height: size, flex: `0 0 ${size}px` }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="var(--border)" strokeWidth={stroke}
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
        />
      </svg>
      <div
        style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--mono)',
          fontWeight: 600,
          fontSize: size >= 72 ? 22 : size >= 56 ? 17 : 14,
          letterSpacing: '-0.02em',
          color,
        }}
      >
        {score.toFixed(1)}
      </div>
    </div>
  );
}

/**
 * Per-signal contribution bars — the "Why this score" breakdown.
 * Widths are proportional to the final score, so the bars visibly add up to it.
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
    <div className="stack-sm">
      {keys.map((k) => {
        const value = Number(breakdown?.[k] ?? 0);
        const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
        return (
          <div key={k}>
            <div className="row-between" style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{SIGNAL_LABELS[k]}</span>
              <span className="num" style={{ fontSize: 12, color: 'var(--faint)' }}>
                {value.toFixed(1)}
              </span>
            </div>
            <div style={{ height: 5, borderRadius: 999, background: 'var(--border)' }}>
              <div
                style={{
                  height: '100%', width: `${pct}%`,
                  borderRadius: 999, background: SIGNAL_COLORS[k],
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type PillTone = 'green' | 'blue' | 'red' | 'gold' | 'muted' | 'purple';

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: PillTone }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/** Paper vs live must be unmistakable in every list. */
export function ModePill({ mode }: { mode: 'paper' | 'live' }) {
  return mode === 'live'
    ? <Pill tone="green"><span className="dot" />Live</Pill>
    : <Pill tone="purple">Paper</Pill>;
}

const ACCOUNT_TONES: Record<string, PillTone> = {
  active: 'green',
  grace: 'gold',
  paused: 'red',
  inactive: 'muted',
  removed: 'muted',
};

const ACCOUNT_LABELS: Record<string, string> = {
  active: 'Active',
  grace: 'Grace period',
  paused: 'Paused',
  inactive: 'Inactive',
  removed: 'Removed',
};

export function AccountStatusPill({ status }: { status: string }) {
  return <Pill tone={ACCOUNT_TONES[status] ?? 'muted'}>{ACCOUNT_LABELS[status] ?? status}</Pill>;
}

const BILLING_TONES: Record<string, PillTone> = {
  open: 'muted',
  invoiced: 'blue',
  paid: 'green',
  failed: 'red',
  grace: 'gold',
  waived: 'purple',
};

export function BillingStatusPill({ status }: { status: string }) {
  return <Pill tone={BILLING_TONES[status] ?? 'muted'}>{status}</Pill>;
}

export function SignalStatusPill({ status }: { status: string }) {
  const tone: PillTone =
    status === 'healthy' ? 'green' : status === 'degraded' ? 'gold' : 'red';
  return <Pill tone={tone}><span className="dot" />{status}</Pill>;
}

/** Money, always monospaced and sign-coloured. */
export function Money({
  cents,
  signed = false,
  className = '',
}: {
  cents: number | null | undefined;
  signed?: boolean;
  className?: string;
}) {
  if (cents === null || cents === undefined) {
    return <span className="num" style={{ color: 'var(--faint)' }}>—</span>;
  }
  const tone = cents > 0 ? 'pos' : cents < 0 ? 'neg' : '';
  return <span className={`num ${signed ? tone : ''} ${className}`}>{formatUsd(cents, { signed })}</span>;
}

export function Stat({
  label,
  value,
  hint,
  size = 'md',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${size === 'lg' ? 'lg' : size === 'sm' ? 'sm' : ''}`}>{value}</div>
      {hint ? <div className="hint" style={{ marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
