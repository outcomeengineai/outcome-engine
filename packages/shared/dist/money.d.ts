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
export declare const PAYOUT_PER_CONTRACT_CENTS = 100;
/** Default fee rate. Real value is read from platform_settings — never hardcode. */
export declare const DEFAULT_FEE_RATE = 0.2;
/** Round half away from zero, so -0.5 -> -1 rather than JS's Math.round -> -0. */
export declare function roundCents(value: number): number;
/**
 * Cost to open a position, in cents.
 * The price passed must already be the price of the side being bought.
 */
export declare function stakeCents(priceCents: number, contracts: number): number;
/**
 * Price of the side being traded, given the YES price.
 * NO is the complement: a 71c YES is a 29c NO.
 */
export declare function sidePriceCents(yesPriceCents: number, side: Side): number;
/** Gross payout if the position wins, in cents. */
export declare function payoutCents(contracts: number): number;
/** Profit if the position wins, in cents (payout minus what was put in). */
export declare function profitIfWinCents(priceCents: number, contracts: number): number;
/**
 * Realized PnL of a settled position, in cents.
 * A win returns payout - stake; a loss returns -stake.
 */
export declare function realizedPnlCents(priceCents: number, contracts: number, won: boolean): number;
/**
 * Unrealized PnL of an open position, in cents, marked to the current price
 * of the side held.
 */
export declare function unrealizedPnlCents(entryPriceCents: number, currentSidePriceCents: number, contracts: number): number;
/**
 * THE fee rule: 20% of NET profit for the billing period. Losses offset wins.
 * A period that nets zero or negative owes nothing — never a negative fee.
 *
 * This is the only function permitted to compute a fee. Both clients, the
 * billing job, and the admin dashboard all call it, so the number a member
 * sees while staking is derived the same way as the number on their invoice.
 */
export declare function feeOnNetPnlCents(netPnlCents: number, feeRate: number): number;
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
export declare function periodTotals(pnls: number[], feeRate: number): PeriodTotals;
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
export declare function allocateSettlementCents(totalCents: number, contractsPerTrade: readonly number[]): number[];
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
export declare function quoteStake(params: {
    priceCents: number;
    contracts: number;
    mode: TradeMode;
    feeRate: number;
}): StakeQuote;
/** Format integer cents as a dollar string: 128460 -> "$1,284.60". */
export declare function formatUsd(cents: number, opts?: {
    signed?: boolean;
    decimals?: number;
}): string;
/** Format a contract price for display: 71 -> "71¢". */
export declare function formatPriceCents(cents: number): string;
//# sourceMappingURL=money.d.ts.map