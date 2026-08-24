/**
 * Shared domain types. These mirror the Postgres schema in supabase/migrations.
 * Keep them in sync by hand — the row shapes are small and stable enough that a
 * generated client type would cost more than it saves at this scale.
 */
export type Role = "admin" | "member";
export type AccountStatus = "active" | "grace" | "paused" | "inactive" | "removed";
export type TradeMode = "paper" | "live";
export type Side = "YES" | "NO";
export type ModelStatus = "draft" | "stable" | "deprecated";
export type ConnectionStatus = "connected" | "error" | "revoked";
export type TradeStatus = "pending" | "open" | "resolved" | "failed";
export type TradeOutcome = "win" | "loss";
export type TagSeverity = "info" | "caution";
export type TagSource = "auto" | "manual";
export type SignalKey = "micro" | "news" | "base";
export type SignalStatus = "healthy" | "degraded" | "disabled";
export type PaymentMethodKind = "stripe" | "manual";
export type BillingStatus = "open" | "invoiced" | "paid" | "failed" | "grace" | "waived";
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
export declare const SIGNAL_LABELS: Record<SignalKey, string>;
export declare const SIGNAL_KEYS: readonly SignalKey[];
export declare const PAYOUT_PER_CONTRACT_CENTS = 100;
/** Default fee rate. Real value is read from platform_settings — never hardcode. */
export declare const DEFAULT_FEE_RATE = 0.2;
/** Round half away from zero, so -0.5 -> -1 rather than JS's Math.round -> -0. */
export declare function roundCents(value: number): number;
/**
 * Cost to open a position, in cents.
 * The price passed must already be the price of the side being bought.
 */
export declare function stakeCents(priceCents: number, contracts: number): number;
/**
 * Price of the side being traded, given the YES price.
 * NO is the complement: a 71c YES is a 29c NO.
 */
export declare function sidePriceCents(yesPriceCents: number, side: Side): number;
/** Gross payout if the position wins, in cents. */
export declare function payoutCents(contracts: number): number;
/** Profit if the position wins, in cents (payout minus what was put in). */
export declare function profitIfWinCents(priceCents: number, contracts: number): number;
/**
 * Realized PnL of a settled position, in cents.
 * A win returns payout - stake; a loss returns -stake.
 */
export declare function realizedPnlCents(priceCents: number, contracts: number, won: boolean): number;
/**
 * Unrealized PnL of an open position, in cents, marked to the current price
 * of the side held.
 */
export declare function unrealizedPnlCents(entryPriceCents: number, currentSidePriceCents: number, contracts: number): number;
/**
 * THE fee rule: 20% of NET profit for the billing period. Losses offset wins.
 * A period that nets zero or negative owes nothing — never a negative fee.
 *
 * This is the only function permitted to compute a fee. Both clients, the
 * billing job, and the admin dashboard all call it, so the number a member
 * sees while staking is derived the same way as the number on their invoice.
 */
export declare function feeOnNetPnlCents(netPnlCents: number, feeRate: number): number;
export interface PeriodTotals {
	grossWins: number;
	grossLosses: number;
	netPnl: number;
	feeOwed: number;
}
/**
 * Roll a period's realized PnL values into the totals stored on billing_periods.
 * `pnls` must contain LIVE trades only — paper trades never enter billing.
 */
export declare function periodTotals(pnls: number[], feeRate: number): PeriodTotals;
/**
 * Split an aggregate settlement across the trades that make it up.
 *
 * Kalshi settles per MARKET: one record covering a member's whole position in
 * a ticker. Our trades are finer-grained, so a member holding two trades on
 * one market must have that single revenue figure divided between them —
 * giving each the full amount would double-count it into their PnL and their
 * fee.
 *
 * Allocation is proportional to contracts, with the rounding remainder going
 * to the last part so the pieces sum to EXACTLY the amount received. That
 * exactness is the point: the sum of per-trade PnL has to equal the member's
 * real market PnL, or billing drifts from reality.
 */
export declare function allocateSettlementCents(totalCents: number, contractsPerTrade: readonly number[]): number[];
export interface StakeQuote {
	mode: TradeMode;
	priceCents: number;
	contracts: number;
	/** What the member puts in. */
	stake: number;
	/** Gross payout if it hits. */
	payout: number;
	/** Payout minus stake. */
	profitIfWin: number;
	/**
	 * Fee on this trade alone, if it wins. Always 0 in paper mode.
	 * This is an ESTIMATE shown at stake time: the real bill nets this trade
	 * against every other live trade in the same billing period.
	 */
	estimatedFee: number;
	/** profitIfWin - estimatedFee. */
	youdKeep: number;
}
/**
 * The numbers behind the stake card. Deliberately returns the fee as an
 * isolated field so the UI can label it as an estimate rather than implying
 * a per-trade charge.
 */
export declare function quoteStake(params: {
	priceCents: number;
	contracts: number;
	mode: TradeMode;
	feeRate: number;
}): StakeQuote;
/** Format integer cents as a dollar string: 128460 -> "$1,284.60". */
export declare function formatUsd(cents: number, opts?: {
	signed?: boolean;
	decimals?: number;
}): string;
/** Format a contract price for display: 71 -> "71¢". */
export declare function formatPriceCents(cents: number): string;
export declare const SCORE_MIN = 1;
export declare const SCORE_MAX = 10;
/** The score-ring colour bands from the design brief. */
export type ScoreBand = "strong" | "moderate" | "weak";
export declare function scoreBand(score: number): ScoreBand;
/** Scores are shown to one decimal place everywhere. */
export declare function formatScore(score: number): string;
/** Round a score to the single decimal the schema stores (NUMERIC(3,1)). */
export declare function roundScore(score: number): number;
export declare function clampScore(score: number): number;
/**
 * Pick the weights for a category: its override if one exists, else the
 * platform default. Categories are matched exactly, as stored on markets.
 */
export declare function weightsForCategory(config: WeightConfig, category: string | null | undefined): SignalWeights;
export declare function hasOverride(config: WeightConfig, category: string): boolean;
/**
 * Drop disabled signals and renormalize the rest so the weights still sum to
 * their original total. If every signal is disabled there is nothing to score
 * with, so this returns null and the caller must skip the market rather than
 * emit a meaningless score.
 */
export declare function activeWeights(weights: SignalWeights, disabled: readonly SignalKey[]): SignalWeights | null;
/**
 * Combine per-signal sub-scores (each on the 0..10 scale) into a final 1..10
 * score, and record each signal's weighted contribution as the breakdown the
 * "Why this score" bars render.
 *
 * The breakdown values are contributions, not raw sub-scores, so they sum to
 * the final score — that is what makes the stacked bars honest.
 */
export declare function combineSignals(subScores: ScoreBreakdown, weights: SignalWeights): {
	score: number;
	breakdown: ScoreBreakdown;
};
/**
 * The model commits to ONE side per market. Given each side's score, return
 * the stronger. Ties resolve to YES so the choice is deterministic — a tie
 * means the signals are symmetric and neither side has an edge, which the
 * surface threshold will filter out anyway.
 */
export declare function pickSide(yesScore: number, noScore: number): Side;
/**
 * A market surfaces only if its winning side clears the surface threshold.
 * There is deliberately no third "no edge" state: a market that scores weakly
 * on both sides simply does not appear.
 */
export declare function surfaces(score: number, surfaceThreshold: number): boolean;
export declare function isStrongPick(score: number, strongThreshold: number): boolean;
/**
 * Whether a retune moved a score enough to be worth notifying an open trade's
 * owner about. Half a point is the smallest change visible at one decimal
 * place that also crosses a meaningful fraction of a band.
 */
export declare const MATERIAL_SCORE_DELTA = 0.5;
export declare function scoreChangedMaterially(before: number, after: number): boolean;
/**
 * The recommendation shown alongside a retuned score for an OPEN trade.
 * Advisory only — the member always decides.
 */
export type RetuneRecommendation = "hold" | "review" | "consider_exit";
export declare function retuneRecommendation(newScore: number, strongThreshold: number): RetuneRecommendation;
/**
 * Design tokens, lifted from the Claude Design canvas and the mockup in
 * design/uploads/outcome engine/outcome-engine-app.jsx so both clients render
 * the same palette. Plain values, no framework — React Native and the web
 * dashboard both consume these directly.
 */
export declare const COLORS: {
	readonly bg: "#F1F3F5";
	readonly surface: "#FFFFFF";
	readonly surfaceMuted: "#F7F8FA";
	readonly border: "#E3E6EA";
	readonly text: "#161B22";
	readonly muted: "#69707C";
	readonly faint: "#9AA1AC";
	readonly green: "#1FBE87";
	readonly greenDark: "#149A6D";
	readonly blue: "#3E7BFA";
	readonly red: "#E2544F";
	readonly gold: "#DE9F35";
	readonly purple: "#8B6FD8";
};
export declare const GRADIENT_STOPS: readonly [
	"#3E7BFA",
	"#1FBE87"
];
export declare const GRADIENT_CSS: string;
/** Per-signal accent colours for the breakdown bars. */
export declare const SIGNAL_COLORS: {
	readonly micro: "#1FBE87";
	readonly news: "#3E7BFA";
	readonly base: "#8B6FD8";
};
/** Score-ring colour, keyed off the same bands as `scoreBand`. */
export declare const BAND_COLORS: {
	readonly strong: "#1FBE87";
	readonly moderate: "#DE9F35";
	readonly weak: "#E2544F";
};
export declare const SEVERITY_COLORS: {
	readonly info: "#3E7BFA";
	readonly caution: "#DE9F35";
};
export declare const FONTS: {
	readonly sans: "Inter";
	readonly mono: "JetBrains Mono";
};

export {};
