/**
 * Shared domain types. These mirror the Postgres schema in supabase/migrations.
 * Keep them in sync by hand — the row shapes are small and stable enough that a
 * generated client type would cost more than it saves at this scale.
 */

export type Role = 'admin' | 'member';

export type AccountStatus =
  | 'active'
  | 'grace'
  | 'paused'
  | 'inactive'
  | 'removed';

export type TradeMode = 'paper' | 'live';
export type Side = 'YES' | 'NO';

export type ModelStatus = 'draft' | 'stable' | 'deprecated';
export type ConnectionStatus = 'connected' | 'error' | 'revoked';
export type TradeStatus = 'pending' | 'open' | 'resolved' | 'failed';
export type TradeOutcome = 'win' | 'loss';
export type TagSeverity = 'info' | 'caution';
export type TagSource = 'auto' | 'manual';
export type SignalKey = 'micro' | 'news' | 'base';
export type SignalStatus = 'healthy' | 'degraded' | 'disabled';
export type PaymentMethodKind = 'stripe' | 'manual';

export type BillingStatus =
  | 'open'
  | 'invoiced'
  | 'paid'
  | 'failed'
  | 'grace'
  | 'waived';

/** Per-signal weights. Do not need to sum to 1 — the scorer normalizes. */
export interface SignalWeights {
  micro: number;
  news: number;
  base: number;
}

/**
 * A model version's weight configuration: one platform default plus optional
 * per-category overrides. A category absent from `overrides` uses `default`.
 */
export interface WeightConfig {
  default: SignalWeights;
  overrides: Record<string, SignalWeights>;
}

export interface Thresholds {
  /** Minimum score for a market to surface as a "Strong" pick. */
  strongPick: number;
  /** Below this, a market is not surfaced at all. */
  surface: number;
  autoTags: {
    volumeAnomaly: boolean;
    lowLiquidity: boolean;
    sentimentDivergence: boolean;
  };
}

export interface RiskLimits {
  dailyLossLimitCents: number;
  maxTradesPerDay: number;
  cooldownAfterLossMinutes: number;
  maxExposurePerMarketCents: number;
  lockedCategories: string[];
}

export interface ScoreBreakdown {
  micro: number;
  news: number;
  base: number;
}

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  account_status: AccountStatus;
  last_trade_at: string | null;
  created_at: string;
}

export interface ModelVersion {
  id: string;
  version_label: string;
  status: ModelStatus;
  weights: WeightConfig;
  thresholds: Thresholds;
  risk_limits: RiskLimits;
  created_at: string;
  published_at: string | null;
  deprecated_at: string | null;
  /** End of the window in which members may stay on this version. */
  transition_ends_at: string | null;
}

export interface Market {
  id: string;
  question: string;
  category: string;
  close_time: string | null;
  resolved_at: string | null;
  outcome: Side | null;
}

export interface MarketSnapshot {
  market_id: string;
  ts: string;
  /** Price of the YES side in whole cents, 1..99. */
  price: number;
  volume: number;
  spread: number;
  open_interest: number;
  liquidity: number;
}

export interface Score {
  id: string;
  market_id: string;
  model_version_id: string;
  ts: string;
  side: Side;
  score: number;
  breakdown: ScoreBreakdown;
}

export interface Tag {
  id: string;
  market_id: string | null;
  trade_id: string | null;
  tag_type: string;
  severity: TagSeverity;
  text: string;
  source: TagSource;
  created_by: string | null;
  created_at: string;
}

export interface Trade {
  id: string;
  user_id: string;
  market_id: string;
  model_version_id: string;
  mode: TradeMode;
  side: Side;
  /** Fill price of the chosen side in whole cents, 1..99. */
  entry_price: number;
  contracts: number;
  entry_score: number;
  kalshi_order_id: string | null;
  status: TradeStatus;
  failure_reason: string | null;
  opened_at: string;
}

export interface TradeResolution {
  trade_id: string;
  outcome: TradeOutcome;
  /** Realized profit/loss in cents. Negative for a loss. */
  pnl: number;
  resolved_at: string;
}

export interface BillingPeriod {
  id: string;
  user_id: string;
  period_start: string;
  period_end: string;
  gross_wins: number;
  gross_losses: number;
  net_pnl: number;
  fee_owed: number;
  stripe_invoice_id: string | null;
  status: BillingStatus;
  grace_until: string | null;
}

export interface SignalHealth {
  signal: SignalKey;
  window_size: number;
  win_rate: number;
  sample_count: number;
  status: SignalStatus;
  disabled_until: string | null;
  computed_at: string;
}

export interface PlatformSettings {
  fee_rate: number;
  inactivity_threshold_days: number;
  trading_paused: boolean;
  kill_switch: boolean;
  grace_period_days: number;
  transition_window_days: number;
  signal_window_size: number;
  signal_min_win_rate: number;
  signal_accuracy_drop_pct: number;
  signal_cooldown_hours: number;
  snapshot_retention_days: number;
}

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  micro: 'Market activity',
  news: 'News',
  base: 'Track record',
};

export const SIGNAL_KEYS: readonly SignalKey[] = ['micro', 'news', 'base'];
