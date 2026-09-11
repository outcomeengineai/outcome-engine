/**
 * Scoring engine — scheduled, one minute behind ingestion.
 *
 * For each open market: derive the three sub-scores, apply the STABLE model
 * version's weights (per-category override if one exists, else the default),
 * commit to the stronger side, and write a `scores` row plus any auto-tags.
 *
 * Disabled signals are excluded and the remaining weights renormalised, so a
 * degraded news feed reduces the model to microstructure + base rate rather
 * than poisoning every score with a signal known to be broken.
 */

import { handler, json, readJson, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { newsSignalsFor, NEUTRAL_NEWS, type NewsSignal } from '../_shared/news.ts';
import {
  autoTags,
  baseRateScore,
  microFeatures,
  microScore,
  newsScore,
  sidePrice,
  type Snapshot,
} from '../_shared/signals.ts';
import { logActivity } from '../_shared/log.ts';
import { forEachBatch, selectInBatches, selectPaged } from '../_shared/batch.ts';
import { DEFAULT_MAGNITUDE_STEP, recordTheses, type Thesis } from '../_shared/thesis.ts';
import {
  activeWeights,
  combineSignals,
  pickSide,
  surfaces,
  weightsForCategory,
  type ScoreBreakdown,
  type SignalKey,
  type Thresholds,
  type WeightConfig,
} from '../_shared/outcome-shared.mjs';

/** How far back the microstructure window looks. */
/**
 * Price history window, per tier. Drift needs at least three ACTIVE
 * intervals to register, so the window has to hold more than three snapshots
 * at that tier's cadence: fast is priced every 5 minutes, slow hourly,
 * archive daily. One window for all three either starves the slow tiers or
 * drags weeks of noise into the fast one.
 */
const HISTORY_HOURS: Record<ScoreTier, number> = { fast: 6, slow: 72, archive: 24 * 21 };

/** Cap per pass so one invocation cannot run past the function time limit. */
/**
 * Markets per pass, per tier. Fast covers its whole cap in one pass -- it is
 * the tier members actually act on, and a pass that scores 82 of 800 because
 * long-dated markets out-ranked them on volume undoes the tiering. Slow and
 * archive are scored in volume order up to the cap.
 */
type ScoreTier = 'fast' | 'slow' | 'archive';
const MAX_MARKETS_PER_PASS: Record<ScoreTier, number> = { fast: 900, slow: 1000, archive: 1000 };

interface MarketRow {
  id: string;
  question: string;
  category: string;
  cadence_tier: 'fast' | 'slow' | 'archive' | 'excluded';
}

/**
 * Per-tier accounting, so the diagnostic can answer the question that
 * matters: does drift recover on NEAR-DATED markets, or is it thin everywhere?
 * An aggregate sepP50 over a mix of tiers cannot tell those apart.
 */
interface TierStats {
  considered: number;
  skippedNoData: number;
  belowSurface: number;
  noDirection: number;
  scored: number;
  scores: number[];
  seps: number[];
}
const newTierStats = (): TierStats =>
  ({ considered: 0, skippedNoData: 0, belowSurface: 0, noDirection: 0, scored: 0, scores: [], seps: [] });

export interface BaseRateStats {
  sampleCount: number;
  winRate: number;
}

/**
 * Realised win rate per (category, side) from resolved LIVE and PAPER trades.
 *
 * Paper trades count here — unlike in billing — because this is a question
 * about whether the model was right, not about who owes what. Excluding paper
 * would throw away most of the early evidence for no benefit.
 */
async function loadBaseRates(
  db: ReturnType<typeof serviceClient>,
): Promise<Map<string, BaseRateStats>> {
  // Aggregated in SQL (base_rate_stats view). The previous version pulled
  // every resolved position as a row and tallied here, which PostgREST
  // silently truncates at 1,000 rows -- an arbitrary subset feeding every
  // score once members had traded enough. A GROUP BY returns a few dozen
  // rows no matter how many trades exist.
  const { data, error } = await db
    .from('base_rate_stats')
    .select('category, side, wins, total');

  const out = new Map<string, BaseRateStats>();
  if (error || !data) {
    if (error) console.warn('base rate load failed:', error.message);
    return out;
  }

  for (const row of data as Array<{ category: string; side: string; wins: number; total: number }>) {
    const total = Number(row.total);
    const wins = Number(row.wins);
    out.set(`${row.category}|${row.side}`, {
      sampleCount: total,
      winRate: total ? wins / total : 0.5,
    });
  }
  return out;
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);

  const body = await readJson<{ limit?: number; marketIds?: string[]; tier?: ScoreTier }>(req);
  const tier: ScoreTier = body.tier ?? 'fast';
  const started = Date.now();

  // ---- the model version to score against --------------------------------
  const { data: versionId, error: vErr } = await db.rpc('current_stable_version');
  if (vErr) throw new Error(`version lookup failed: ${vErr.message}`);
  if (!versionId) {
    return json({ ok: false, error: 'no stable model version published' }, 409);
  }

  const { data: version, error: mvErr } = await db
    .from('model_versions')
    .select('id, version_label, weights, thresholds')
    .eq('id', versionId)
    .single();
  if (mvErr || !version) throw new Error(`model version load failed: ${mvErr?.message}`);

  const weightConfig = version.weights as WeightConfig;
  const thresholds = version.thresholds as Thresholds;

  // ---- which signals are currently usable --------------------------------
  const { data: health } = await db
    .from('signal_health')
    .select('signal, status, disabled_until');

  const disabled: SignalKey[] = (health ?? [])
    .filter((h: { status: string; disabled_until: string | null }) =>
      h.status === 'disabled' &&
      (!h.disabled_until || new Date(h.disabled_until) > new Date())
    )
    .map((h: { signal: SignalKey }) => h.signal);

  // ---- markets to score --------------------------------------------------
  //
  // Chosen from the SNAPSHOT side, not the markets table. Selecting from
  // markets with a bare LIMIT and no ORDER BY returns an arbitrary slice, and
  // it reliably picked 400 stale rows with no price history — every pass
  // reported scored:0, skippedNoData:400 while thousands of fresh snapshots
  // sat unused.
  //
  // Starting from latest_snapshots guarantees every candidate HAS data, and
  // ordering by volume means the markets members actually trade are the ones
  // that get scored when there are more than a pass can hold.
  const since = new Date(Date.now() - HISTORY_HOURS[tier] * 3600_000).toISOString();
  const cap = Math.min(body.limit ?? MAX_MARKETS_PER_PASS[tier], MAX_MARKETS_PER_PASS[tier]);
  const now = new Date().toISOString();

  // Candidates come from the TIER, not from a volume ranking over every
  // snapshot. The first tiered pass showed why: ranking by volume filled 300
  // of 400 slots with long-dated slow markets and scored 82 of the 800
  // fast-tier markets the tiering exists to prioritise. Selecting by tier
  // also keeps 'excluded' out -- a market that settled between passes stays
  // tiered 'excluded' until resolution sync marks it, and was being scored
  // in the gap.
  let markets: MarketRow[];
  if (body.marketIds?.length) {
    markets = await selectInBatches<MarketRow>(
      body.marketIds.slice(0, cap),
      (batch) =>
        db
          .from('markets')
          .select('id, question, category, cadence_tier')
          .in('id', batch)
          .is('resolved_at', null)
          .neq('cadence_tier', 'excluded')
          .or(`close_time.is.null,close_time.gt.${now}`),
      { label: 'market load' },
    );
  } else {
    markets = await selectPaged<MarketRow>(
      (from, to) =>
        db
          .from('markets')
          .select('id, question, category, cadence_tier')
          .eq('cadence_tier', tier)
          .is('resolved_at', null)
          .or(`close_time.is.null,close_time.gt.${now}`)
          .order('disc_volume', { ascending: false })
          .order('id')
          .range(from, to),
      { max: cap, label: `${tier} tier candidates` },
    );
  }
  const ids = markets.map((m) => m.id);

  if (markets.length === 0) {
    return json({ ok: true, scored: 0, reason: 'no open markets among candidates' });
  }

  // Batched: 400 tickers in one .in() produced a ~12KB URL, which PostgREST
  // refused to send at all. See _shared/batch.ts.
  const snaps = await selectInBatches<Snapshot & { market_id: string }>(
    markets.map((m) => m.id),
    (batch) =>
      db
        .from('market_snapshots')
        .select('market_id, ts, price, volume, spread, open_interest, liquidity')
        .in('market_id', batch)
        .gte('ts', since)
        .order('ts', { ascending: true }),
    { label: 'snapshot load' },
  );

  const history = new Map<string, Snapshot[]>();
  for (const s of snaps) {
    const arr = history.get(s.market_id) ?? [];
    arr.push(s);
    history.set(s.market_id, arr);
  }
  // selectInBatches concatenates batches, so per-market ordering is not
  // guaranteed across them. microFeatures() depends on chronological order.
  for (const arr of history.values()) arr.sort((a, b) => a.ts.localeCompare(b.ts));

  const baseRates = await loadBaseRates(db);

  // News for the whole pass in one budgeted, concurrent step. Fetching
  // per-market inside the loop below is what killed this function: 400
  // sequential upstream calls, no response at all.
  const newsResult = disabled.includes('news')
    ? { signals: new Map<string, NewsSignal>(), fetched: 0, cached: 0, aborted: false }
    : await newsSignalsFor(db, markets);

  // An UNREACHABLE signal is disabled for this pass, whatever the health table
  // says. The circuit breaker in signal-health trips on hit rate -- a signal
  // that predicts badly -- not on availability, so news being down never
  // registered as failure: it contributed a neutral value at full weight on
  // every pass, compressing every score toward the middle and damping the one
  // signal that was working. Renormalising here means no version can be
  // quietly diluted by a source that is not there.
  const newsUnavailable = !disabled.includes('news') &&
    (newsResult.aborted || (newsResult.fetched === 0 && newsResult.cached === 0));
  const passDisabled: SignalKey[] = newsUnavailable ? [...disabled, 'news'] : disabled;

  // ---- score --------------------------------------------------------------
  const scoreRows: Record<string, unknown>[] = [];
  const tagRows: Record<string, unknown>[] = [];
  const theses: Thesis[] = [];
  const ts = new Date().toISOString();

  let skippedNoData = 0;
  let belowSurface = 0;
  let noDirection = 0;

  // Every winning-side score, surfaced or not. "belowSurface: 394" says
  // nothing about whether those markets sit at 4.9 or 2.1, which is the
  // difference between a threshold that is slightly off and scoring that is
  // broken. Report the distribution so the threshold can be set from evidence.
  const allScores: number[] = [];
  const allSeparations: number[] = [];
  const byTier = new Map<string, TierStats>();
  const tierOf = (m: MarketRow) => {
    const key = m.cadence_tier ?? 'unknown';
    let t = byTier.get(key);
    if (!t) { t = newTierStats(); byTier.set(key, t); }
    return t;
  };

  /**
   * Minimum gap between the two sides' scores before a market may surface.
   * Tunable per model version; 0.5 is the smallest gap visible at the one
   * decimal place scores are stored and displayed at.
   */
  const minSeparation = Number(
    (thresholds as { minSideSeparation?: number }).minSideSeparation ?? 0.5,
  );

  for (const market of markets) {
    const tier = tierOf(market);
    tier.considered++;
    const hist = history.get(market.id) ?? [];
    const last = hist[hist.length - 1];
    if (!last) { skippedNoData++; tier.skippedNoData++; continue; }

    const micro = microFeatures(hist);

    // Already resolved above; a market with no entry scores neutral, which is
    // not the same as scoring zero.
    const news: NewsSignal = newsResult.signals.get(market.id) ?? NEUTRAL_NEWS;

    const weights = weightsForCategory(weightConfig, market.category);
    const usable = activeWeights(weights, passDisabled);
    if (!usable) {
      // Every signal disabled: there is nothing to score with, and emitting a
      // number anyway would be a lie with a decimal point on it.
      skippedNoData++;
      continue;
    }

    const evaluate = (side: 'YES' | 'NO') => {
      const price = sidePrice(last.price, side);
      const stats = baseRates.get(`${market.category}|${side}`);
      const subs: ScoreBreakdown = {
        micro: microScore(micro, side),
        news: newsScore(news, side),
        base: baseRateScore({
          sampleCount: stats?.sampleCount ?? 0,
          winRate: stats?.winRate ?? 0.5,
          sidePriceCents: price,
        }),
      };
      return combineSignals(subs, usable);
    };

    const yes = evaluate('YES');
    const no = evaluate('NO');
    const side = pickSide(yes.score, no.score);
    const winner = side === 'YES' ? yes : no;

    allScores.push(winner.score);
    allSeparations.push(Math.abs(yes.score - no.score));
    tier.scores.push(winner.score);
    tier.seps.push(Math.abs(yes.score - no.score));

    // A market that is weak on BOTH sides simply does not surface. There is
    // deliberately no third "no edge" state to render.
    if (!surfaces(winner.score, thresholds.surface ?? 5)) {
      belowSurface++;
      tier.belowSurface++;
      continue;
    }

    // The score must also express a DIRECTION, not just an opinion that the
    // market is interesting.
    //
    // news is neutral for both sides when there is no coverage, and
    // baseRateScore keys off min(price, 100 - price) so it is symmetric by
    // construction. Drift is therefore the only input that can separate the
    // sides — and when a market has not moved, both sides score identically
    // and pickSide breaks the tie toward YES. Every one of the first 15 live
    // scores came out YES that way.
    //
    // Surfacing a coin-flip with a side badge implies a view the model does
    // not hold, so require real separation before showing one.
    const separation = Math.abs(yes.score - no.score);
    if (separation < minSeparation) {
      noDirection++;
      tier.noDirection++;
      continue;
    }

    tier.scored++;
    scoreRows.push({
      market_id: market.id,
      model_version_id: version.id,
      ts,
      side,
      score: winner.score,
      breakdown: winner.breakdown,
    });

    // Every scored market gets a thesis, traded or not. Until anchors,
    // coherence and flow detection land there is no concrete mispricing
    // driver to name, so this is 'none' — which is a real answer, and still a
    // labelled example once the market resolves.
    theses.push({
      marketId: market.id,
      thesisType: 'none',
      direction: null,
      magnitude: null,
      payload: {
        score: winner.score,
        side,
        separation: Number(separation.toFixed(2)),
        breakdown: winner.breakdown,
      },
    });

    for (const tag of autoTags({
      micro,
      news,
      yesPrice: last.price,
      side,
      enabled: thresholds.autoTags ?? {
        volumeAnomaly: true,
        lowLiquidity: true,
        sentimentDivergence: true,
      },
    })) {
      tagRows.push({ market_id: market.id, source: 'auto', ...tag });
    }
  }

  // ---- persist ------------------------------------------------------------
  const CHUNK = 500;
  for (let i = 0; i < scoreRows.length; i += CHUNK) {
    const { error } = await db.from('scores').insert(scoreRows.slice(i, i + CHUNK));
    if (error) throw new Error(`score insert failed: ${error.message}`);
  }

  // Auto tags are replaced wholesale for the markets this pass scored: clear
  // then insert. That keeps them from stacking up, and — more importantly —
  // lets a tag disappear once its condition stops holding, which an upsert
  // would never do. Manual tags are left alone; an admin's correction must
  // survive the next scoring run.
  const scoredIds = scoreRows.map((r) => r.market_id as string);
  const cleanup = await forEachBatch(scoredIds, (batch) =>
    db.from('tags').delete().eq('source', 'auto').in('market_id', batch));
  if (cleanup.error) console.warn('stale tag cleanup failed:', cleanup.error);

  for (let i = 0; i < tagRows.length; i += CHUNK) {
    const { error } = await db.from('tags').insert(tagRows.slice(i, i + CHUNK));
    if (error) console.warn('tag insert failed:', error.message);
  }

  const thesisResult = await recordTheses(
    db,
    version.id,
    theses,
    Number((thresholds as { thesisMagnitudeStep?: number }).thesisMagnitudeStep
      ?? DEFAULT_MAGNITUDE_STEP),
  );

  const pct = (xs: number[], p: number) => {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  };

  const result = {
    ok: true,
    tier,
    modelVersion: version.version_label,
    disabledSignals: passDisabled,
    newsUnavailable,
    considered: markets.length,
    candidates: ids.length,
    scored: scoreRows.length,
    tags: tagRows.length,
    belowSurface,
    noDirection,
    skippedNoData,
    // What the scores actually look like, so thresholds can be tuned on data.
    scoreP50: pct(allScores, 0.5),
    scoreP90: pct(allScores, 0.9),
    scoreMax: allScores.length ? Math.max(...allScores) : null,
    sepP50: pct(allSeparations, 0.5),
    sepMax: allSeparations.length ? Math.max(...allSeparations) : null,
    // The split that decides whether v1.1 stands or is superseded.
    byTier: Object.fromEntries(
      [...byTier.entries()].map(([k, t]) => [k, {
        considered: t.considered,
        skippedNoData: t.skippedNoData,
        belowSurface: t.belowSurface,
        noDirection: t.noDirection,
        scored: t.scored,
        scoreP50: pct(t.scores, 0.5),
        scoreP90: pct(t.scores, 0.9),
        sepP50: pct(t.seps, 0.5),
        sepP90: pct(t.seps, 0.9),
        sepMax: t.seps.length ? Math.max(...t.seps) : null,
      }]),
    ),
    thesesWritten: thesisResult.written,
    thesesUnchanged: thesisResult.unchanged,
    newsFetched: newsResult.fetched,
    newsCached: newsResult.cached,
    newsAborted: newsResult.aborted,
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: 'scoring.completed',
    detail: `${result.scored} markets scored on ${version.version_label}`,
    metadata: result,
  });

  return json(result);
}));
