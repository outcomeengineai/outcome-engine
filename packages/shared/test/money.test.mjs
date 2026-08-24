import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSettlementCents,
  DEFAULT_FEE_RATE,
  feeOnNetPnlCents,
  formatUsd,
  periodTotals,
  quoteStake,
  realizedPnlCents,
  sidePriceCents,
  stakeCents,
  unrealizedPnlCents,
} from '../dist/index.js';

test('NO price is the complement of the YES price', () => {
  assert.equal(sidePriceCents(71, 'YES'), 71);
  assert.equal(sidePriceCents(71, 'NO'), 29);
});

test('stake and payout use whole cents', () => {
  assert.equal(stakeCents(71, 50), 3550);
  const q = quoteStake({ priceCents: 71, contracts: 50, mode: 'live', feeRate: 0.2 });
  assert.equal(q.stake, 3550);
  assert.equal(q.payout, 5000);
  assert.equal(q.profitIfWin, 1450);
  assert.equal(q.estimatedFee, 290); // 20% of 1450
  assert.equal(q.youdKeep, 1160);
});

test('paper mode never quotes a fee', () => {
  const q = quoteStake({ priceCents: 71, contracts: 50, mode: 'paper', feeRate: 0.2 });
  assert.equal(q.estimatedFee, 0);
  assert.equal(q.youdKeep, q.profitIfWin);
});

test('realized PnL: a loss costs exactly the stake', () => {
  assert.equal(realizedPnlCents(71, 50, true), 1450);
  assert.equal(realizedPnlCents(71, 50, false), -3550);
});

test('unrealized PnL marks to the current price of the side held', () => {
  assert.equal(unrealizedPnlCents(71, 78, 50), 350);
  assert.equal(unrealizedPnlCents(71, 64, 50), -350);
});

test('fee is 20% of net profit and never negative', () => {
  assert.equal(feeOnNetPnlCents(10000, DEFAULT_FEE_RATE), 2000);
  assert.equal(feeOnNetPnlCents(0, DEFAULT_FEE_RATE), 0);
  assert.equal(feeOnNetPnlCents(-10000, DEFAULT_FEE_RATE), 0);
});

test('losses offset wins within a billing period', () => {
  // Two wins of $30 and $20, one loss of $40 -> net $10 -> fee $2.
  const totals = periodTotals([3000, 2000, -4000], 0.2);
  assert.equal(totals.grossWins, 5000);
  assert.equal(totals.grossLosses, 4000);
  assert.equal(totals.netPnl, 1000);
  assert.equal(totals.feeOwed, 200);
});

test('a losing period owes nothing', () => {
  const totals = periodTotals([1000, -5000], 0.2);
  assert.equal(totals.netPnl, -4000);
  assert.equal(totals.feeOwed, 0);
});

test('fee rate is a parameter, not a constant', () => {
  assert.equal(periodTotals([1000], 0.1).feeOwed, 100);
  assert.equal(periodTotals([1000], 0.25).feeOwed, 250);
});

test('formatUsd', () => {
  assert.equal(formatUsd(128460), '$1,284.60');
  assert.equal(formatUsd(-350), '-$3.50');
  assert.equal(formatUsd(350, { signed: true }), '+$3.50');
});

// --- settlement allocation ------------------------------------------------
// Kalshi settles per market; we hold per-trade positions. These guard the
// arithmetic that keeps a member's billed PnL equal to their real PnL.

test('a single trade receives the whole settlement', () => {
  assert.deepEqual(allocateSettlementCents(5000, [50]), [5000]);
});

test('two trades on one market split the settlement, never duplicate it', () => {
  const parts = allocateSettlementCents(5000, [30, 20]);
  assert.deepEqual(parts, [3000, 2000]);
  // The bug this replaces gave each trade the full 5000.
  assert.equal(parts.reduce((a, b) => a + b, 0), 5000);
});

test('allocation always sums to exactly the amount received', () => {
  for (const [total, splits] of [
    [3333, [1, 1, 1]],
    [10000, [7, 3]],
    [1, [1, 1]],
    [9999, [33, 33, 34]],
    [12345, [5, 11, 3, 7]],
  ]) {
    const parts = allocateSettlementCents(total, splits);
    assert.equal(
      parts.reduce((a, b) => a + b, 0),
      total,
      `${total} across ${splits.join('/')} -> ${parts.join('/')}`,
    );
    assert.equal(parts.length, splits.length);
  }
});

test('allocation refuses a zero-contract group rather than dividing by zero', () => {
  assert.throws(() => allocateSettlementCents(5000, [0, 0]));
  assert.deepEqual(allocateSettlementCents(5000, []), []);
});

test('end to end: two trades on one market bill on their combined real PnL', () => {
  // 30 contracts at 60c and 20 at 70c, both YES, market resolves YES.
  // Kalshi pays out 50 contracts x 100c = 5000c total.
  const stakeA = stakeCents(60, 30); // 1800
  const stakeB = stakeCents(70, 20); // 1400
  const [revA, revB] = allocateSettlementCents(5000, [30, 20]);

  const pnlA = revA - stakeA;
  const pnlB = revB - stakeB;

  assert.equal(pnlA, 1200);
  assert.equal(pnlB, 600);

  // Combined PnL matches settling the position as a whole: 5000 - 3200.
  assert.equal(pnlA + pnlB, 5000 - (stakeA + stakeB));

  // And the fee follows from that combined figure, not a doubled one.
  assert.equal(periodTotals([pnlA, pnlB], 0.2).feeOwed, 360);
});
