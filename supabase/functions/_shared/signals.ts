/**
 * Per-signal sub-scores.
 *
 * Each function returns a 0..10 score for ONE side of a market. The weighting
 * and combination live in packages/shared/src/score.ts so the clients compute
 * the same arithmetic; only the raw signal derivation is here, because it
 * needs snapshot history the clients never see.
 *
 * A note on what these are NOT: none of these is a probability estimate. They
 * are heuristics that rank markets against each other. The score's job is to
 * decide what surfaces and in what order — the member still decides.
 */

import type { NewsSignal } from './news.ts';

export interface Snapshot {
  ts: string;
  price: number;        // YES price, cents
  volume: number;
  spread: number;
  open_interest: number;
  liquidity: number;
}

export type Side = 'YES' | 'NO';

/** Price of the given side, in cents, from the YES price. */
export function sidePrice(yesPrice: number, side: Side): number {
  return side === 'YES' ? yesPrice : 100 - yesPrice;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function toScore(unit: number): number {
  return Math.min(10, Math.max(0, unit * 10));
}

// --------------------------------------------------------------------------
// Microstructure
// --------------------------------------------------------------------------

/**
 * Intervals that must show real volume before a volume RATIO means anything.
 * Below this there is no baseline to compare against, only noise.
 */
const MIN_ACTIVE_INTERVALS = 3;

export interface MicroFeatures {
  /** Cents moved over the window, signed toward YES. */
  drift: number;
  /** Ratio of recent volume to the window's median. 1 = normal. */
  volumeRatio: number;
  /** Current spread in cents. */
  spread: number;
  openInterest: number;
  samples: number;
}

export function microFeatures(history: Snapshot[]): MicroFeatures {
  if (history.length === 0) {
    return { drift: 0, volumeRatio: 1, spread: 100, openInterest: 0, samples: 0 };
  }

  const sorted = [...history].sort((a, b) => a.ts.localeCompare(b.ts));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  // Volume is cumulative on Kalshi, so per-interval volume is the difference
  // between consecutive snapshots. Using the raw figure would make every
  // long-lived market look like a volume spike.
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    deltas.push(Math.max(0, sorted[i]!.volume - sorted[i - 1]!.volume));
  }

  const recent = deltas.slice(-3);
  const recentAvg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const median = deltas.length ? [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)]! : 0;

  // A market that trades in only a couple of intervals has a median delta of
  // zero. The previous fallback asserted 3x in that case — which is exactly
  // the value that saturates the activity term — so the LEAST traded markets
  // scored as though they had a volume spike, and flat untraded markets
  // surfaced at ~6.0. Absence of trading is not evidence of unusual trading:
  // without enough active intervals to form a baseline, the ratio is 1.
  const activeIntervals = deltas.filter((d) => d > 0).length;
  const hasBaseline = median > 0 && activeIntervals >= MIN_ACTIVE_INTERVALS;

  return {
    drift: last.price - first.price,
    volumeRatio: hasBaseline ? recentAvg / median : 1,
    spread: last.spread,
    openInterest: last.open_interest,
    samples: sorted.length,
  };
}

/**
 * Microstructure sub-score for one side.
 *
 * Three components, each in [0,1]:
 *   momentum  — price drifting toward this side
 *   activity  — volume above the market's own baseline
 *   quality   — tight spread and real open interest
 *
 * Quality is a multiplier rather than an addend: a market nobody can actually
 * trade at a sane price should not score well no matter how it is drifting.
 */
export function microScore(f: MicroFeatures, side: Side): number {
  if (f.samples < 2) return 3; // not enough history to say anything; stay neutral-low

  const signedDrift = side === 'YES' ? f.drift : -f.drift;
  // 8 cents of drift over the window is a strong move on a 0-100 scale.
  const momentum = clamp01(0.5 + signedDrift / 16);

  // 3x normal volume saturates.
  const activity = clamp01((f.volumeRatio - 0.5) / 2.5);

  // A 1c spread is excellent, 8c+ is unusable.
  const spreadQuality = clamp01((8 - f.spread) / 7);
  const depth = clamp01(Math.log10(Math.max(1, f.openInterest)) / 4); // 10k OI saturates
  const quality = clamp01(0.35 + 0.65 * (0.6 * spreadQuality + 0.4 * depth));

  return toScore((0.6 * momentum + 0.4 * activity) * quality);
}

// --------------------------------------------------------------------------
// News
// --------------------------------------------------------------------------

/**
 * News sub-score for one side.
 *
 * Confirmation only: news that leans this way raises the score, news that
 * leans against it lowers it, and no news at all lands at neutral rather than
 * zero. Scoring "no news" as zero would silently penalise every quiet market,
 * which is not the same thing as evidence against a side.
 */
export function newsScore(news: NewsSignal, side: Side): number {
  if (news.volume === 0) return 5;

  const signed = side === 'YES' ? news.sentiment : -news.sentiment;

  // Confidence grows with corpus size and with how much of it actually matched.
  const volumeConfidence = clamp01(news.volume / 20);
  const confidence = clamp01(0.3 + 0.7 * volumeConfidence * clamp01(news.coverage + 0.2));

  // Pull away from neutral in proportion to confidence.
  return toScore(clamp01(0.5 + 0.5 * signed * confidence));
}

// --------------------------------------------------------------------------
// Base rate
// --------------------------------------------------------------------------

export interface BaseRateInput {
  /** Resolved trades in this category on this side. */
  sampleCount: number;
  /** Historical win rate for that slice, 0..1. */
  winRate: number;
  /** Current price of the side, cents — the market's own implied probability. */
  sidePriceCents: number;
}

/**
 * Base-rate sub-score.
 *
 * Two ideas, blended by how much history exists:
 *   - with history: how the category's realised win rate compares to 50/50
 *   - without history: a mild preference for prices in the tradeable middle,
 *     since 3c and 97c contracts offer almost no edge either way
 *
 * The shrinkage toward the price-only view is what keeps a category with four
 * resolved trades from claiming a 100% win rate. Model v1 weights this signal
 * lightly for the same reason.
 */
export function baseRateScore(input: BaseRateInput): number {
  const { sampleCount, winRate, sidePriceCents } = input;

  // Prices in the 20-80 band are where a mispricing is worth acting on.
  const distanceFromEdge = clamp01((Math.min(sidePriceCents, 100 - sidePriceCents) - 3) / 22);
  const priceView = 0.35 + 0.4 * distanceFromEdge;

  if (sampleCount <= 0) return toScore(priceView);

  const historyView = clamp01(0.5 + (winRate - 0.5) * 1.5);

  // Full confidence in history at 40 resolved trades.
  const confidence = clamp01(sampleCount / 40);
  return toScore(confidence * historyView + (1 - confidence) * priceView);
}

// --------------------------------------------------------------------------
// Auto-tagging
// --------------------------------------------------------------------------

export interface AutoTag {
  tag_type: string;
  severity: 'info' | 'caution';
  text: string;
}

/**
 * Rule-based tags, generated in the same pass as scoring.
 *
 * These annotate a score rather than change it. The point is to surface the
 * specific reason a member might want to distrust an otherwise strong number —
 * which is also the feedback loop the admin Tag review screen spot-checks.
 */
export function autoTags(params: {
  micro: MicroFeatures;
  news: NewsSignal;
  yesPrice: number;
  side: Side;
  enabled: { volumeAnomaly: boolean; lowLiquidity: boolean; sentimentDivergence: boolean };
}): AutoTag[] {
  const { micro, news, yesPrice, side, enabled } = params;
  const tags: AutoTag[] = [];

  if (enabled.volumeAnomaly && micro.volumeRatio >= 3 && news.volume === 0) {
    tags.push({
      tag_type: 'volume_no_news',
      severity: 'caution',
      text: 'Unusual volume with no matching news',
    });
  }

  if (enabled.lowLiquidity && (micro.spread >= 6 || micro.openInterest < 500)) {
    tags.push({
      tag_type: 'low_liquidity',
      severity: 'caution',
      text: `Thin market — ${micro.spread}¢ spread, ${micro.openInterest.toLocaleString()} open interest`,
    });
  }

  if (enabled.sentimentDivergence && news.volume >= 5) {
    const signedSentiment = side === 'YES' ? news.sentiment : -news.sentiment;
    const signedDrift = side === 'YES' ? micro.drift : -micro.drift;

    if (signedSentiment > 0.35 && signedDrift <= 0) {
      tags.push({
        tag_type: 'news_ahead_of_price',
        severity: 'info',
        text: "News is one-sided but price hasn't moved yet",
      });
    } else if (signedSentiment < -0.35 && signedDrift > 2) {
      tags.push({
        tag_type: 'price_against_news',
        severity: 'caution',
        text: 'Price is moving against the news flow',
      });
    }
  }

  // A market pinned near an edge is cheap to be wrong about but offers almost
  // no room to be right.
  const price = sidePrice(yesPrice, side);
  if (price >= 95) {
    tags.push({
      tag_type: 'near_certain',
      severity: 'info',
      text: `Already priced at ${price}¢ — limited upside`,
    });
  }

  return tags;
}
