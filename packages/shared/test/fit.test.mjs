import test from 'node:test';
import assert from 'node:assert/strict';
import { walkForward, fitLogistic, predictProb, features, impliedBlendWeights, breakevenHitRate } from '../dist/index.js';

// Deterministic pseudo-random so the synthetic world is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * A synthetic world where ONLY micro carries information: P(hit) rises with
 * micro, news and base are noise, and price is uninformative beyond what it
 * says about breakeven. Labels are drawn from that probability.
 */
function world({ n, informative, seed = 7 }) {
  const r = rng(seed);
  const calls = [];
  for (let i = 0; i < n; i++) {
    const micro = 2 + r() * 8;               // 2..10
    const news = 2 + r() * 8;
    const base = 3 + r() * 5;
    const price = Math.round(35 + r() * 30);  // 35..65c
    // Informative: hit probability rises with micro. Uninformative: an
    // EFFICIENT market -- the side wins exactly as often as its price implies,
    // so no policy can make money after fees. (A flat 52% hit rate on 40c
    // calls would be real edge, not noise; the first draft of this test got
    // that wrong.)
    const p = informative ? 1 / (1 + Math.exp(-(-1.2 + 0.35 * micro))) : price / 100;
    const hit = r() < p;
    // The "live" score is a hand blend that leans on micro, so the live
    // policy is not stupid -- the fitted one has to actually beat it.
    const score = 0.6 * micro + 0.28 * news + 0.12 * base;
    calls.push({ at: new Date(Date.UTC(2026, 8, 1) + i * 3600_000).toISOString(), subs: { micro, news, base }, price, score, hit });
  }
  return calls;
}

test('logistic fit recovers a positive coefficient on the signal that matters', () => {
  const calls = world({ n: 1500, informative: true });
  const w = fitLogistic(calls.map(features), calls.map((c) => (c.hit ? 1 : 0)));
  const [, micro, news, base] = w;
  assert.ok(micro > 1.0, `micro coefficient should be strongly positive, got ${micro}`);
  assert.ok(Math.abs(news) < micro / 3, `news should be near zero, got ${news}`);
  assert.ok(Math.abs(base) < micro / 3, `base should be near zero, got ${base}`);
});

test('walk-forward is out of sample and beats the base rate when a signal exists', () => {
  const report = walkForward(world({ n: 2000, informative: true }), { liveSurface: 5.0, folds: 5 });
  assert.equal(report.holdout, 2000 - 400, 'first fold is never scored');
  assert.ok(report.fittedBrier < report.baseRateBrier, `fitted ${report.fittedBrier} should beat base ${report.baseRateBrier}`);
  assert.ok(report.fittedPolicy.taken > 50, 'fitted policy takes calls when there is edge');
  assert.ok(report.fittedPolicy.netPerContractCents > 0, `fitted policy should make money net of fees: ${report.fittedPolicy.netPerContractCents}`);
});

test('with no signal, the fitted policy declines to claim edge', () => {
  const report = walkForward(world({ n: 2000, informative: false, seed: 11 }), { liveSurface: 5.0, folds: 5 });
  // Fitted probabilities hover near the base rate; almost nothing clears
  // breakeven + margin, so the policy takes few calls and reports no edge.
  assert.ok(report.fittedPolicy.taken < report.holdout * 0.2, `should take few calls on noise, took ${report.fittedPolicy.taken} of ${report.holdout}`);
  assert.ok(Math.abs(report.fittedBrier - report.baseRateBrier) < 0.01, 'no better than the base rate on noise');
});

test('implied blend weights drop signals the data says do not help', () => {
  assert.deepEqual(impliedBlendWeights({ bias: 0, micro: 2.0, news: -0.3, base: 0.5, price: 0 }), { micro: 0.8, news: 0, base: 0.2 });
  assert.equal(impliedBlendWeights({ bias: 0, micro: -1, news: -1, base: 0, price: 0 }), null);
});

test('policy threshold is breakeven at the entry price, not 50%', () => {
  // At 60c the bar is ~61.4%; a fitted probability of 0.6 must NOT take the call.
  const be = breakevenHitRate(60);
  assert.ok(be > 0.6);
  const w = [0, 0, 0, 0, 0]; // predicts exactly 0.5 everywhere
  assert.equal(predictProb(w, [1, 0.5, 0.5, 0.5, 0]), 0.5);
});
