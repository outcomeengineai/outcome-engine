/**
 * Fitted weights (Edge Signals v2, section 7 -- evidence before publish).
 *
 * The blend weights were guessed. This fits them. A logistic regression
 * predicts "the model's side won" from the raw sub-scores and the entry
 * price, on labelled calls, WALK-FORWARD: train on the past, test on the
 * next slice, never the reverse. Every number reported here is out of
 * sample by construction.
 *
 * What it does not do: publish anything. It produces a proposal -- fitted
 * coefficients, the blend weights they imply, and the out-of-sample net
 * P&L of following the fitted model versus following the live one on the
 * same holdout rows. A person compares and decides. That is the contract.
 *
 * Pure functions, no I/O, deterministic. Small enough to read in one
 * sitting, which matters more here than a library would.
 */
export interface LabelledCall {
    /** When the call was labelled (resolution time); orders the walk-forward. */
    at: string;
    /** Raw 0-10 sub-scores for the winning side, before the blend. */
    subs: {
        micro: number;
        news: number;
        base: number;
    };
    /** What the model's side cost at scoring time, in cents. */
    price: number;
    /** The live model's blended score for that call. */
    score: number;
    /** Did the model's side win? */
    hit: boolean;
}
export declare const FEATURE_NAMES: readonly ["bias", "micro", "news", "base", "price"];
/** Feature vector: bias, sub-scores on 0-1, price centred on 50c and on 0-1. */
export declare function features(c: LabelledCall): number[];
export interface FitOptions {
    /** L2 penalty on non-bias weights. Keeps small samples from going wild. */
    l2?: number;
    iterations?: number;
    learningRate?: number;
}
/**
 * Batch gradient descent on the regularised log-loss. No randomness: the
 * same rows give the same weights, which is what makes a proposal
 * reproducible by whoever reviews it.
 */
export declare function fitLogistic(X: number[][], y: number[], opts?: FitOptions): number[];
export declare function predictProb(w: number[], x: number[]): number;
export interface PolicyResult {
    /** Calls the policy would have taken on the holdout. */
    taken: number;
    /** Of those, how many won. */
    hits: number;
    /** Average net P&L per contract over the taken calls, after fees. */
    netPerContractCents: number;
    /** Total net over the taken calls, one contract each. */
    totalNetCents: number;
}
export interface WalkForwardReport {
    rows: number;
    folds: number;
    /** Out-of-sample rows actually scored (everything after the first fold). */
    holdout: number;
    /** Mean squared error of the fitted probability against the outcome. */
    fittedBrier: number;
    /** Brier of always predicting the training base rate: the bar to beat. */
    baseRateBrier: number;
    /** Fitted coefficients from the final (largest) training window. */
    coefficients: Record<(typeof FEATURE_NAMES)[number], number>;
    /** Following the fitted model: take a call when P(hit) clears breakeven + margin. */
    fittedPolicy: PolicyResult;
    /** Following the live model: take a call when its score clears the live surface. */
    livePolicy: PolicyResult;
    /** Taking every holdout call, for scale. */
    takeAll: PolicyResult;
}
export interface WalkForwardOptions extends FitOptions {
    folds?: number;
    /** Live surface threshold, so the live policy is what members actually saw. */
    liveSurface: number;
    /** Extra hit-rate margin over breakeven before the fitted policy takes a call. */
    margin?: number;
}
/**
 * Expanding-window walk-forward. Rows sorted by `at`, split into `folds`
 * equal chunks; for k = 1..folds-1, fit on chunks [0, k) and predict chunk k.
 * The first chunk is never scored (nothing to train on yet). Predictions
 * are therefore honest: each one was made from strictly earlier labels.
 */
export declare function walkForward(calls: LabelledCall[], opts: WalkForwardOptions): WalkForwardReport;
/**
 * The blend weights a set of coefficients implies: the positive
 * sub-score coefficients, normalised. A signal with a non-positive
 * coefficient gets zero -- the data says it does not help, or hurts.
 * Returns null when nothing is positive, which is a finding, not a bug.
 */
export declare function impliedBlendWeights(coefficients: WalkForwardReport['coefficients']): {
    micro: number;
    news: number;
    base: number;
} | null;
//# sourceMappingURL=fit.d.ts.map