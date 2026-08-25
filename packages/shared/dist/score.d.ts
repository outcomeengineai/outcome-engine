/**
 * Scoring rules shared by the engine (which writes scores) and both clients
 * (which display them). Keeping the weighting maths here means a score shown
 * on a card is arithmetically the same object the engine persisted.
 */
import { type ScoreBreakdown, type Side, type SignalKey, type SignalWeights, type WeightConfig } from './types.js';
export declare const SCORE_MIN = 1;
export declare const SCORE_MAX = 10;
/** The score-ring colour bands from the design brief. */
export type ScoreBand = 'strong' | 'moderate' | 'weak';
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
export type RetuneRecommendation = 'hold' | 'review' | 'consider_exit';
export declare function retuneRecommendation(newScore: number, strongThreshold: number): RetuneRecommendation;
//# sourceMappingURL=score.d.ts.map