/**
 * Money and fee math.
 *
 * Unit discipline, enforced everywhere in this codebase:
 *   - Contract prices are WHOLE CENTS, 1..99 (Kalshi's native unit).
 *   - A winning contract settles at 100 cents. A losing one at 0.
 *   - All money and PnL values are INTEGER CENTS. Never floats, never dollars.
 *
 * The one place a fraction legitimately appears is `feeRate` (0.20), and the
 * result of applying it is rounded once, at the end, to whole cents.
 */

import type { Side, TradeMode } from './types.js';

export const PAYOUT_PER_CONTRACT_CENTS = 100;

/** Default fee rate. Real value is read from platform_settings — never hardcode. */
export const DEFAULT_FEE_RATE = 0.2;

/** Round half away from zero, so -0.5 -> -1 rather than JS's Math.round -> -0. */
export function roundCents(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Cost to open a position, in cents.
 * The price passed must already be the price of the side being bought.
 */
export function stakeCents(priceCents: number, contracts: number): number {
  return roundCents(priceCents * contracts);
}

/**
 * Price of the side being traded, given the YES price.
 * NO is the complement: a 71c YES is a 29c NO.
 */
export function sidePriceCents(yesPriceCents: number, side: Side): number {
  return side === 'YES' ? yesPriceCents : PAYOUT_PER_CONTRACT_CENTS - yesPriceCents;
}

/** Gross payout if the position wins, in cents. */
export function payoutCents(contracts: number): number {
  return contracts * PAYOUT_PER_CONTRACT_CENTS;
}

/** Profit if the position wins, in cents (payout minus what was put in). */
export function profitIfWinCents(priceCents: number, contracts: number): number {
  return payoutCents(contracts) - stakeCents(priceCents, contracts);
}

/**
 * Realized PnL of a settled position, in cents.
 * A win returns payout - stake; a loss returns -stake.
 */
export function realizedPnlCents(
  priceCents: number,
  contracts: number,
  won: boolean,
): number {
  const stake = stakeCents(priceCents, contracts);
  return won ? payoutCents(contracts) - stake : -stake;
}

/**
 * Unrealized PnL of an open position, in cents, marked to the current price
 * of the side held.
 */
export function unrealizedPnlCents(
  entryPriceCents: number,
  currentSidePriceCents: number,
  contracts: number,
): number {
  return roundCents((currentSidePriceCents - entryPriceCents) * contracts);
}

/**
 * THE fee rule: 20% of NET profit for the billing period. Losses offset wins.
 * A period that nets zero or negative owes nothing — never a negative fee.
 *
 * This is the only function permitted to compute a fee. Both clients, the
 * billing job, and the admin dashboard all call it, so the number a member
 * sees while staking is derived the same way as the number on their invoice.
 */
export function feeOnNetPnlCents(netPnlCents: number, feeRate: number): number {
  if (!(feeRate >= 0)) throw new Error(`invalid feeRate: ${feeRate}`);
  return roundCents(Math.max(0, netPnlCents) * feeRate);
}

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
export function periodTotals(pnls: number[], feeRate: number): PeriodTotals {
  let grossWins = 0;
  let grossLosses = 0;
  for (const pnl of pnls) {
    if (pnl >= 0) grossWins += pnl;
    else grossLosses += -pnl;
  }
  const netPnl = grossWins - grossLosses;
  return {
    grossWins,
    grossLosses,
    netPnl,
    feeOwed: feeOnNetPnlCents(netPnl, feeRate),
  };
}

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
export function allocateSettlementCents(
  totalCents: number,
  contractsPerTrade: readonly number[],
): number[] {
  if (contractsPerTrade.length === 0) return [];

  const totalContracts = contractsPerTrade.reduce((sum, c) => sum + c, 0);
  if (totalContracts <= 0) {
    throw new Error('cannot allocate a settlement across zero contracts');
  }

  const out: number[] = [];
  let allocated = 0;

  for (let i = 0; i < contractsPerTrade.length; i++) {
    if (i === contractsPerTrade.length - 1) {
      out.push(totalCents - allocated);
      break;
    }
    const share = roundCents((totalCents * contractsPerTrade[i]!) / totalContracts);
    allocated += share;
    out.push(share);
  }

  return out;
}

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
export function quoteStake(params: {
  priceCents: number;
  contracts: number;
  mode: TradeMode;
  feeRate: number;
}): StakeQuote {
  const { priceCents, contracts, mode, feeRate } = params;
  const stake = stakeCents(priceCents, contracts);
  const payout = payoutCents(contracts);
  const profitIfWin = payout - stake;
  const estimatedFee =
    mode === 'live' ? feeOnNetPnlCents(profitIfWin, feeRate) : 0;
  return {
    mode,
    priceCents,
    contracts,
    stake,
    payout,
    profitIfWin,
    estimatedFee,
    youdKeep: profitIfWin - estimatedFee,
  };
}

/** Format integer cents as a dollar string: 128460 -> "$1,284.60". */
export function formatUsd(
  cents: number,
  opts: { signed?: boolean; decimals?: number } = {},
): string {
  const decimals = opts.decimals ?? 2;
  const negative = cents < 0;
  const abs = Math.abs(cents) / 100;
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sign = negative ? '-' : opts.signed ? '+' : '';
  return `${sign}$${body}`;
}

/** Format a contract price for display: 71 -> "71¢". */
export function formatPriceCents(cents: number): string {
  return `${Math.round(cents)}¢`;
}
