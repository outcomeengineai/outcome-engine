import test from 'node:test';
import assert from 'node:assert/strict';
import { normalCdf, temperatureBandProbability } from '../dist/index.js';

const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test('normal CDF sanity', () => {
  assert.ok(close(normalCdf(0), 0.5));
  assert.ok(close(normalCdf(1.96), 0.975));
  assert.ok(close(normalCdf(-1.96), 0.025));
});

// Verified Kalshi convention (2026-09-22): T72 greater = "73 or above",
// T65 less = "64 or below", B71.5 between = "71 to 72".
test('"greater" floor 72 means 73 or above', () => {
  // Forecast exactly 72.5: T>=73 is the half above the mean.
  assert.ok(close(temperatureBandProbability('greater', 72, null, 72.5, 2.2), 0.5));
  // Forecast 72.0: 73-or-above is less than half.
  const p = temperatureBandProbability('greater', 72, null, 72.0, 2.2);
  assert.ok(p < 0.5 && p > 0.35, `got ${p}`);
});

test('"less" cap 65 means 64 or below', () => {
  assert.ok(close(temperatureBandProbability('less', null, 65, 64.5, 2.2), 0.5));
});

test('"between" 71/72 is the two whole degrees, inclusive', () => {
  const p = temperatureBandProbability('between', 71, 72, 71.5, 2.2);
  const expected = normalCdf(1 / 2.2) - normalCdf(-1 / 2.2);
  assert.ok(close(p, expected));
});

test('a full ladder of markets sums to one', () => {
  // Kalshi lists: <65, 65-66, 67-68, 69-70, 71-72, >72 -- exhaustive and disjoint.
  const f = 68.3, s = 2.8;
  const total =
    temperatureBandProbability('less', null, 65, f, s) +
    temperatureBandProbability('between', 65, 66, f, s) +
    temperatureBandProbability('between', 67, 68, f, s) +
    temperatureBandProbability('between', 69, 70, f, s) +
    temperatureBandProbability('between', 71, 72, f, s) +
    temperatureBandProbability('greater', 72, null, f, s);
  assert.ok(close(total, 1, 1e-6), `ladder sums to ${total}`);
});

test('bad inputs yield null, never a number', () => {
  assert.equal(temperatureBandProbability('greater', null, null, 70, 2), null);
  assert.equal(temperatureBandProbability('between', 70, null, 70, 2), null);
  assert.equal(temperatureBandProbability('weird', 70, 71, 70, 2), null);
  assert.equal(temperatureBandProbability('less', null, 70, NaN, 2), null);
  assert.equal(temperatureBandProbability('less', null, 70, 70, 0), null);
});
