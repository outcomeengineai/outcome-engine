/**
 * Scoring rules shared by the engine (which writes scores) and both clients
 * (which display them). Keeping the weighting maths here means a score shown
 * on a card is arithmetically the same object the engine persisted.
 */
import { SIGNAL_KEYS, } from './types.js';
export const SCORE_MIN = 1;
export const SCORE_MAX = 10;
export function scoreBand(score) {
    if (score >= 7)
        return 'strong';
    if (score >= 4.5)
        return 'moderate';
    return 'weak';
}
/** Scores are shown to one decimal place everywhere. */
export function formatScore(score) {
    return score.toFixed(1);
}
/** Round a score to the single decimal the schema stores (NUMERIC(3,1)). */
export function roundScore(score) {
    return Math.round(score * 10) / 10;
}
export function clampScore(score) {
    return Math.min(SCORE_MAX, Math.max(SCORE_MIN, score));
}
/**
 * Pick the weights for a category: its override if one exists, else the
 * platform default. Categories are matched exactly, as stored on markets.
 */
export function weightsForCategory(config, category) {
    if (category && config.overrides && config.overrides[category]) {
        return config.overrides[category];
    }
    return config.default;
}
export function hasOverride(config, category) {
    return Boolean(config.overrides && config.overrides[category]);
}
/**
 * Drop disabled signals and renormalize the rest so the weights still sum to
 * their original total. If every signal is disabled there is nothing to score
 * with, so this returns null and the caller must skip the market rather than
 * emit a meaningless score.
 */
export function activeWeights(weights, disabled) {
    const live = SIGNAL_KEYS.filter((k) => !disabled.includes(k));
    if (live.length === 0)
        return null;
    const originalTotal = SIGNAL_KEYS.reduce((sum, k) => sum + (weights[k] ?? 0), 0);
    const liveTotal = live.reduce((sum, k) => sum + (weights[k] ?? 0), 0);
    if (liveTotal <= 0)
        return null;
    const scale = originalTotal / liveTotal;
    const out = { micro: 0, news: 0, base: 0 };
    for (const k of live)
        out[k] = (weights[k] ?? 0) * scale;
    return out;
}
/**
 * Combine per-signal sub-scores (each on the 0..10 scale) into a final 1..10
 * score, and record each signal's weighted contribution as the breakdown the
 * "Why this score" bars render.
 *
 * The breakdown values are contributions, not raw sub-scores, so they sum to
 * the final score — that is what makes the stacked bars honest.
 */
export function combineSignals(subScores, weights) {
    const total = SIGNAL_KEYS.reduce((sum, k) => sum + (weights[k] ?? 0), 0);
    if (total <= 0) {
        return { score: SCORE_MIN, breakdown: { micro: 0, news: 0, base: 0 } };
    }
    const breakdown = { micro: 0, news: 0, base: 0 };
    let raw = 0;
    for (const k of SIGNAL_KEYS) {
        const contribution = ((weights[k] ?? 0) / total) * (subScores[k] ?? 0);
        breakdown[k] = roundScore(contribution);
        raw += contribution;
    }
    return { score: roundScore(clampScore(raw)), breakdown };
}
/**
 * The model commits to ONE side per market. Given each side's score, return
 * the stronger. Ties resolve to YES so the choice is deterministic — a tie
 * means the signals are symmetric and neither side has an edge, which the
 * surface threshold will filter out anyway.
 */
export function pickSide(yesScore, noScore) {
    return noScore > yesScore ? 'NO' : 'YES';
}
/**
 * A market surfaces only if its winning side clears the surface threshold.
 * There is deliberately no third "no edge" state: a market that scores weakly
 * on both sides simply does not appear.
 */
export function surfaces(score, surfaceThreshold) {
    return score >= surfaceThreshold;
}
export function isStrongPick(score, strongThreshold) {
    return score >= strongThreshold;
}
/**
 * Whether a retune moved a score enough to be worth notifying an open trade's
 * owner about. Half a point is the smallest change visible at one decimal
 * place that also crosses a meaningful fraction of a band.
 */
export const MATERIAL_SCORE_DELTA = 0.5;
export function scoreChangedMaterially(before, after) {
    return Math.abs(after - before) >= MATERIAL_SCORE_DELTA;
}
export function retuneRecommendation(newScore, strongThreshold) {
    if (newScore >= strongThreshold)
        return 'hold';
    if (newScore >= 4.5)
        return 'review';
    return 'consider_exit';
}
//# sourceMappingURL=score.js.map