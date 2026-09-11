import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeWeights,
  combineSignals,
  hasOverride,
  pickSide,
  retuneRecommendation,
  scoreBand,
  scoreChangedMaterially,
  surfaces,
  weightsForCategory,
} from '../dist/index.js';

const CONFIG = {
  default: { micro: 0.55, news: 0.3, base: 0.15 },
  overrides: { Weather: { micro: 0.7, news: 0.1, base: 0.2 } },
};

test('score bands match the ring colours', () => {
  assert.equal(scoreBand(8.4), 'strong');
  assert.equal(scoreBand(7), 'strong');
  assert.equal(scoreBand(6.9), 'moderate');
  assert.equal(scoreBand(4.5), 'moderate');
  assert.equal(scoreBand(4.4), 'weak');
});

test('category override wins, default otherwise', () => {
  assert.deepEqual(weightsForCategory(CONFIG, 'Weather'), CONFIG.overrides.Weather);
  assert.deepEqual(weightsForCategory(CONFIG, 'Economics'), CONFIG.default);
  assert.deepEqual(weightsForCategory(CONFIG, null), CONFIG.default);
  assert.equal(hasOverride(CONFIG, 'Weather'), true);
  assert.equal(hasOverride(CONFIG, 'Economics'), false);
});

test('breakdown contributions sum to the score', () => {
  const { score, breakdown } = combineSignals(
    { micro: 9, news: 6, base: 5 },
    CONFIG.default,
  );
  const sum = breakdown.micro + breakdown.news + breakdown.base;
  assert.ok(Math.abs(sum - score) < 0.11, `${sum} vs ${score}`);
  assert.equal(score, 7.5);
});

test('disabling a signal renormalizes the remaining weights', () => {
  const w = activeWeights(CONFIG.default, ['news']);
  assert.equal(w.news, 0);
  // micro:base ratio is preserved, and the total is unchanged.
  const total = w.micro + w.news + w.base;
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(Math.abs(w.micro / w.base - 0.55 / 0.15) < 1e-9);
});

test('all signals disabled means no score at all', () => {
  assert.equal(activeWeights(CONFIG.default, ['micro', 'news', 'base']), null);
});

test('the model commits to one side, ties resolve to YES', () => {
  assert.equal(pickSide(8.4, 3.1), 'YES');
  assert.equal(pickSide(3.1, 8.4), 'NO');
  assert.equal(pickSide(5, 5), 'YES');
});

test('weak markets simply do not surface', () => {
  assert.equal(surfaces(6.2, 5.5), true);
  assert.equal(surfaces(4.9, 5.5), false);
});

test('retune notifications fire on a material move only', () => {
  assert.equal(scoreChangedMaterially(8.4, 8.2), false);
  assert.equal(scoreChangedMaterially(8.4, 7.6), true);
  assert.equal(retuneRecommendation(7.8, 7), 'hold');
  assert.equal(retuneRecommendation(5.5, 7), 'review');
  assert.equal(retuneRecommendation(3.2, 7), 'consider_exit');
});

test('a zero news weight renormalises onto the live signals, not toward the middle', () => {
  // v1.2 zeroes news until a real source exists. With news at 0.28 and a
  // neutral 5.0 sub-score, a strong micro signal was being dragged toward 5;
  // with news at 0, the same inputs must score on micro and base alone.
  const sub = { micro: 8, news: 5, base: 6 };
  const withNews = combineSignals(sub, { micro: 0.6, news: 0.28, base: 0.12 });
  const without = combineSignals(sub, { micro: 0.6, news: 0, base: 0.12 });
  assert.equal(without.breakdown.news, 0);
  assert.ok(without.score > withNews.score, `${without.score} should exceed ${withNews.score}`);
  // 0.6/0.72 * 8 + 0.12/0.72 * 6 = 6.667 + 1.0
  assert.equal(without.score, 7.7);
});

test('an unavailable signal disabled for the pass renormalises the same way', () => {
  const w = activeWeights({ micro: 0.6, news: 0.28, base: 0.12 }, ['news']);
  assert.equal(w.news, 0);
  assert.ok(Math.abs(w.micro + w.base - 1.0) < 1e-9);
  assert.ok(Math.abs(w.micro / w.base - 5) < 1e-9); // 0.6 : 0.12 ratio preserved
});
