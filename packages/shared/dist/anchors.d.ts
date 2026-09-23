/**
 * Anchor probability math (Edge Signals v2, anchors).
 *
 * Pure functions, shared between the Deno anchor fetcher and the node test
 * suite, because the first version of this arithmetic lived inside the Edge
 * Function where nothing tested it, and it was off by one degree on every
 * "X or above" market. The strike convention below is verified against
 * live and settled Kalshi temperature markets on 2026-09-22:
 *
 *   ticker            strike_type  floor  cap   resolves YES when
 *   KXHIGHNY-…-T72    greater      72     —     max temp > 72   i.e. 73 or above
 *   KXHIGHNY-…-T65    less         —      65    max temp < 65   i.e. 64 or below
 *   KXHIGHNY-…-B71.5  between      71     72    71 <= max temp <= 72
 *
 * Recorded temperatures are whole degrees, so a strict inequality on an
 * integer strike is an inclusive bound one degree over, and the continuous
 * forecast-error model puts every band edge on a half degree.
 *
 * Crypto price markets (KXBTCD, KXBTC, KXETHD) settle on a continuous index
 * (the 60-second average of CF Benchmarks' BRTI/ERTI at 5pm Eastern), so
 * there is no half-degree adjustment: "above 95,249.99" is P(S_T > K)
 * under a zero-drift lognormal with the horizon volatility.
 */
/** Standard normal CDF via erf (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export declare function normalCdf(x: number): number;
export type StrikeType = 'greater' | 'less' | 'between';
/**
 * P(the recorded whole-degree temperature satisfies the market), with the
 * forecast error normal around `forecastF` with sd `sigma`. Null when the
 * strike fields do not describe a band.
 */
export declare function temperatureBandProbability(strikeType: string, floor: number | null, cap: number | null, forecastF: number, sigma: number): number | null;
/**
 * P(S_T < strike) when log(S_T / spot) ~ N(-sigma^2/2, sigma^2). `sigma` is
 * the volatility over the horizon as a fraction (not annualised). Zero
 * drift: a prediction market is a bet, and the fair bet has no carry.
 */
export declare function probBelow(spot: number, strike: number, sigma: number): number;
/** P(the settlement price satisfies the market). Null when the strikes do not describe a band. */
export declare function priceBandProbability(strikeType: string, floor: number | null, cap: number | null, spot: number, sigma: number): number | null;
/**
 * Sample standard deviation of log returns between consecutive closes,
 * in chronological order. Null below 20 observations: a volatility from a
 * handful of candles is a guess wearing a decimal point.
 */
export declare function logReturnSigma(closes: number[]): number | null;
/** Volatility over `steps` periods from a per-period volatility (square-root of time). */
export declare function scaleSigma(sigmaPerStep: number, steps: number): number;
/** Per-step volatility equivalent to an annualised one, for a step of `stepSeconds`. */
export declare function annualToStepSigma(annual: number, stepSeconds: number): number;
//# sourceMappingURL=anchors.d.ts.map