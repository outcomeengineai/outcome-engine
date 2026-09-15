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

import { breakevenHitRate, netIfHitCents, netIfMissCents } from './money.js';

export interface LabelledCall {
  /** When the call was labelled (resolution time); orders the walk-forward. */
  at: string;
  /** Raw 0-10 sub-scores for the winning side, before the blend. */
  subs: { micro: number; news: number; base: number };
  /** What the model's side cost at scoring time, in cents. */
  price: number;
  /** The live model's blended score for that call. */
  score: number;
  /** Did the model's side win? */
  hit: boolean;
}

export const FEATURE_NAMES = ['bias', 'micro', 'news', 'base', 'price'] as const;

/** Feature vector: bias, sub-scores on 0-1, price centred on 50c and on 0-1. */
export function features(c: LabelledCall): number[] {
  return [1, c.subs.micro / 10, c.subs.news / 10, c.subs.base / 10, (c.price - 50) / 50];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

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
export function fitLogistic(X: number[][], y: number[], opts: FitOptions = {}): number[] {
  const l2 = opts.l2 ?? 1e-2;
  const iterations = opts.iterations ?? 800;
  const lr = opts.learningRate ?? 0.3;
  const n = X.length;
  if (n === 0) return [];
  const d = X[0]!.length;
  const w = new Array<number>(d).fill(0);

  for (let it = 0; it < iterations; it++) {
    const grad = new Array<number>(d).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j]! * xi[j]!;
      const err = sigmoid(z) - y[i]!;
      for (let j = 0; j < d; j++) grad[j]! += err * xi[j]!;
    }
    for (let j = 0; j < d; j++) {
      const reg = j === 0 ? 0 : l2 * w[j]!;
      w[j] = w[j]! - lr * (grad[j]! / n + reg);
    }
  }
  return w;
}

export function predictProb(w: number[], x: number[]): number {
  let z = 0;
  for (let j = 0; j < w.length; j++) z += w[j]! * x[j]!;
  return sigmoid(z);
}

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

function evaluatePolicy(rows: LabelledCall[], take: (c: LabelledCall, i: number) => boolean): PolicyResult {
  let taken = 0, hits = 0, total = 0;
  rows.forEach((c, i) => {
    if (!take(c, i)) return;
    taken++;
    if (c.hit) { hits++; total += netIfHitCents(c.price); } else { total += netIfMissCents(c.price); }
  });
  return { taken, hits, netPerContractCents: taken ? total / taken : 0, totalNetCents: total };
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
export function walkForward(calls: LabelledCall[], opts: WalkForwardOptions): WalkForwardReport {
  const folds = Math.max(2, opts.folds ?? 5);
  const margin = opts.margin ?? 0.02;
  const sorted = [...calls].sort((a, b) => a.at.localeCompare(b.at));
  const n = sorted.length;
  const size = Math.floor(n / folds);

  const oosRows: LabelledCall[] = [];
  const oosProb: number[] = [];
  const oosBase: number[] = [];
  let lastW: number[] = [];

  for (let k = 1; k < folds; k++) {
    const train = sorted.slice(0, k * size);
    const test = k === folds - 1 ? sorted.slice(k * size) : sorted.slice(k * size, (k + 1) * size);
    if (train.length === 0 || test.length === 0) continue;
    const w = fitLogistic(train.map(features), train.map((c) => (c.hit ? 1 : 0)), opts);
    lastW = w;
    const base = train.filter((c) => c.hit).length / train.length;
    for (const c of test) {
      oosRows.push(c);
      oosProb.push(predictProb(w, features(c)));
      oosBase.push(base);
    }
  }

  const brier = (p: number[]) =>
    oosRows.length ? p.reduce((s, pi, i) => s + (pi - (oosRows[i]!.hit ? 1 : 0)) ** 2, 0) / oosRows.length : NaN;

  const coefficients = Object.fromEntries(
    FEATURE_NAMES.map((name, j) => [name, Number((lastW[j] ?? 0).toFixed(4))]),
  ) as WalkForwardReport['coefficients'];

  return {
    rows: n,
    folds,
    holdout: oosRows.length,
    fittedBrier: Number(brier(oosProb).toFixed(4)),
    baseRateBrier: Number(brier(oosBase).toFixed(4)),
    coefficients,
    fittedPolicy: evaluatePolicy(oosRows, (c, i) => oosProb[i]! >= breakevenHitRate(c.price) + margin),
    livePolicy: evaluatePolicy(oosRows, (c) => c.score >= opts.liveSurface),
    takeAll: evaluatePolicy(oosRows, () => true),
  };
}

/**
 * The blend weights a set of coefficients implies: the positive
 * sub-score coefficients, normalised. A signal with a non-positive
 * coefficient gets zero -- the data says it does not help, or hurts.
 * Returns null when nothing is positive, which is a finding, not a bug.
 */
export function impliedBlendWeights(
  coefficients: WalkForwardReport['coefficients'],
): { micro: number; news: number; base: number } | null {
  const raw = {
    micro: Math.max(0, coefficients.micro),
    news: Math.max(0, coefficients.news),
    base: Math.max(0, coefficients.base),
  };
  const total = raw.micro + raw.news + raw.base;
  if (total <= 0) return null;
  return {
    micro: Number((raw.micro / total).toFixed(3)),
    news: Number((raw.news / total).toFixed(3)),
    base: Number((raw.base / total).toFixed(3)),
  };
}
