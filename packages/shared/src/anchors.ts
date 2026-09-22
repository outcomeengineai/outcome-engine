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
 */

/** Standard normal CDF via erf (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const z = x / Math.SQRT2;
  const az = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * az);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-az * az);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

export type StrikeType = 'greater' | 'less' | 'between';

/**
 * P(the recorded whole-degree temperature satisfies the market), with the
 * forecast error normal around `forecastF` with sd `sigma`. Null when the
 * strike fields do not describe a band.
 */
export function temperatureBandProbability(
  strikeType: string,
  floor: number | null,
  cap: number | null,
  forecastF: number,
  sigma: number,
): number | null {
  if (!Number.isFinite(forecastF) || !(sigma > 0)) return null;
  const below = (x: number) => normalCdf((x - forecastF) / sigma);
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
