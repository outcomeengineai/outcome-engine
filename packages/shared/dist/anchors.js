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
export function normalCdf(x) {
    const z = x / Math.SQRT2;
    const az = Math.abs(z);
    const t = 1 / (1 + 0.3275911 * az);
    const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
    const erf = 1 - poly * Math.exp(-az * az);
    return 0.5 * (1 + (z >= 0 ? erf : -erf));
}
// --------------------------------------------------------------------------
// Temperature (whole-degree recorded values)
// --------------------------------------------------------------------------
/**
 * P(the recorded whole-degree temperature satisfies the market), with the
 * forecast error normal around `forecastF` with sd `sigma`. Null when the
 * strike fields do not describe a band.
 */
export function temperatureBandProbability(strikeType, floor, cap, forecastF, sigma) {
    if (!Number.isFinite(forecastF) || !(sigma > 0))
        return null;
    const below = (x) => normalCdf((x - forecastF) / sigma);
    switch (strikeType) {
        // T < cap  <=>  T <= cap-1  <=>  continuous T < cap-0.5
        case 'less':
            return cap === null ? null : below(cap - 0.5);
        // T > floor  <=>  T >= floor+1  <=>  continuous T > floor+0.5
        case 'greater':
            return floor === null ? null : 1 - below(floor + 0.5);
        // floor <= T <= cap  <=>  continuous floor-0.5 < T < cap+0.5
        case 'between':
            return floor === null || cap === null ? null : below(cap + 0.5) - below(floor - 0.5);
        default:
            return null;
    }
}
// --------------------------------------------------------------------------
// Continuous prices (zero-drift lognormal)
// --------------------------------------------------------------------------
/**
 * P(S_T < strike) when log(S_T / spot) ~ N(-sigma^2/2, sigma^2). `sigma` is
 * the volatility over the horizon as a fraction (not annualised). Zero
 * drift: a prediction market is a bet, and the fair bet has no carry.
 */
export function probBelow(spot, strike, sigma) {
    if (!(spot > 0) || !(strike > 0) || !(sigma > 0))
        return NaN;
    return normalCdf((Math.log(strike / spot) + (sigma * sigma) / 2) / sigma);
}
/** P(the settlement price satisfies the market). Null when the strikes do not describe a band. */
export function priceBandProbability(strikeType, floor, cap, spot, sigma) {
    if (!(spot > 0) || !(sigma > 0))
        return null;
    switch (strikeType) {
        case 'less':
            return cap === null ? null : probBelow(spot, cap, sigma);
        case 'greater':
        case 'greater_or_equal':
            return floor === null ? null : 1 - probBelow(spot, floor, sigma);
        case 'between':
            return floor === null || cap === null ? null : probBelow(spot, cap, sigma) - probBelow(spot, floor, sigma);
        default:
            return null;
    }
}
/**
 * Sample standard deviation of log returns between consecutive closes,
 * in chronological order. Null below 20 observations: a volatility from a
 * handful of candles is a guess wearing a decimal point.
 */
export function logReturnSigma(closes) {
    const r = [];
    for (let i = 1; i < closes.length; i++) {
        const a = closes[i - 1], b = closes[i];
        if (a > 0 && b > 0)
            r.push(Math.log(b / a));
    }
    if (r.length < 20)
        return null;
    const mean = r.reduce((s, x) => s + x, 0) / r.length;
    const varr = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
    return Math.sqrt(varr);
}
/** Volatility over `steps` periods from a per-period volatility (square-root of time). */
export function scaleSigma(sigmaPerStep, steps) {
    return sigmaPerStep * Math.sqrt(Math.max(0, steps));
}
/** Per-step volatility equivalent to an annualised one, for a step of `stepSeconds`. */
export function annualToStepSigma(annual, stepSeconds) {
    return annual * Math.sqrt(stepSeconds / 31_536_000);
}
//# sourceMappingURL=anchors.js.map