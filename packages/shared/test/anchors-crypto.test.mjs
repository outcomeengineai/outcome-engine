import test from 'node:test';
import assert from 'node:assert/strict';
import { probBelow, priceBandProbability, logReturnSigma, scaleSigma, annualToStepSigma, normalCdf } from '../dist/index.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('zero-drift lognormal: the median sits just below spot', () => {
  // P(S_T < spot) = Phi(sigma/2): a hair over one half.
  const p = probBelow(84_000, 84_000, 0.02);
  assert.ok(close(p, normalCdf(0.01), 1e-9));
  assert.ok(p > 0.5 && p < 0.51);
});

test('a ladder of contiguous price bands sums to one', () => {
  const spot = 84_286.62, sigma = 0.018;
  const total =
    priceBandProbability('less', null, 80_000, spot, sigma) +
    priceBandProbability('between', 80_000, 85_000, spot, sigma) +
    priceBandProbability('between', 85_000, 90_000, spot, sigma) +
    priceBandProbability('greater', 90_000, null, spot, sigma);
  assert.ok(close(total, 1, 1e-9), `sums to ${total}`);
});

test('greater and greater_or_equal are the same claim on a continuous price', () => {
  const a = priceBandProbability('greater', 85_000, null, 84_000, 0.02);
  const b = priceBandProbability('greater_or_equal', 85_000, null, 84_000, 0.02);
  assert.equal(a, b);
  assert.ok(a < 0.5, 'a strike above spot is less likely than not');
});

test('far strikes and short horizons go to the corners', () => {
  assert.ok(priceBandProbability('greater', 95_000, null, 84_000, 0.005) < 1e-6);
  assert.ok(priceBandProbability('less', null, 95_000, 84_000, 0.005) > 1 - 1e-6);
});

test('bad inputs yield null', () => {
  assert.equal(priceBandProbability('greater', null, null, 84_000, 0.02), null);
  assert.equal(priceBandProbability('between', 80_000, null, 84_000, 0.02), null);
  assert.equal(priceBandProbability('greater', 85_000, null, 0, 0.02), null);
  assert.equal(priceBandProbability('greater', 85_000, null, 84_000, 0), null);
  assert.equal(priceBandProbability('odd', 85_000, 86_000, 84_000, 0.02), null);
});

test('realised volatility from closes, and its scaling', () => {
  // Alternating +1% / -1% moves: log-return sd close to 0.01.
  const closes = [100];
  for (let i = 1; i <= 60; i++) closes.push(closes[i - 1] * (i % 2 ? 1.01 : 1 / 1.01));
  const s = logReturnSigma(closes);
  assert.ok(close(s, Math.log(1.01), 1e-4), `sigma ${s}`);

  assert.equal(logReturnSigma([100, 101, 102]), null, 'too few observations');
  assert.equal(logReturnSigma(new Array(30).fill(100)), 0, 'a flat series has zero volatility');

  assert.ok(close(scaleSigma(0.001, 288), 0.001 * Math.sqrt(288)));
  // 30% annual over a 5-minute step.
  assert.ok(close(annualToStepSigma(0.3, 300), 0.3 * Math.sqrt(300 / 31_536_000)));
});
