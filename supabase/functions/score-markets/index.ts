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
import { forEachBatch, selectInBatches } from '../_shared/batch.ts';
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
const HISTORY_HOURS = 6;

/** Cap per pass so one invocation cannot run past the function time limit. */
const MAX_MARKETS_PER_PASS = 400;

interface MarketRow {
  id: string;
  question: string;
  category: string;
}

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
  const { data, error } = await db
    .from('resolved_positions')
    .select('category, side, outcome');

  const out = new Map<string, BaseRateStats>();
  if (error || !data) {
    if (error) console.warn('base rate load failed:', error.message);
    return out;
  }

  const tally = new Map<string, { wins: number; total: number }>();
  for (const row of data as Array<{ category: string; side: string; outcome: string }>) {
    const key = `${row.category}|${row.side}`;
    const t = tally.get(key) ?? { wins: 0, total: 0 };
    t.total++;
    if (row.outcome === 'win') t.wins++;
    tally.set(key, t);
  }

  for (const [key, t] of tally) {
    out.set(key, { sampleCount: t.total, winRate: t.total ? t.wins / t.total : 0.5 });
  }
  return out;
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);

  const body = await readJson<{ limit?: number; marketIds?: string[] }>(req);
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
  const since = new Date(Date.now() - HISTORY_HOURS * 3600_000).toISOString();
  const cap = Math.min(body.limit ?? MAX_MARKETS_PER_PASS, MAX_MARKETS_PER_PASS);

  let ids: string[];
  if (body.marketIds?.length) {
    ids = body.marketIds.slice(0, cap);
  } else {
    const { data: liquid, error: lErr } = await db
      .from('latest_snapshots')
      .select('market_id, volume')
      .gte('ts', since)
      .order('volume', { ascending: false })
      .limit(cap);
    if (lErr) throw new Error(`snapshot candidates failed: ${lErr.message}`);
    ids = (liquid ?? []).map((r: { market_id: string }) => r.market_id);
  }

  if (ids.length === 0) {
    return json({ ok: true, scored: 0, reason: 'no markets with recent snapshots' });
  }

  const now = new Date().toISOString();
  const markets = await selectInBatches<MarketRow>(
    ids,
    (batch) =>
      db
        .from('markets')
        .select('id, question, category')
        .in('id', batch)
        .is('resolved_at', null)
        .or(`close_time.is.null,close_time.gt.${now}`),
    { label: 'market load' },
  );

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
    ? { signals: new Map<string, NewsSignal>(), fetched: 0, cached: 0 }
    : await newsSignalsFor(db, markets);

  // ---- score --------------------------------------------------------------
  const scoreRows: Record<string, unknown>[] = [];
  const tagRows: Record<string, unknown>[] = [];
  const ts = new Date().toISOString();

  let skippedNoData = 0;
  let belowSurface = 0;

  for (const market of markets) {
    const hist = history.get(market.id) ?? [];
    const last = hist[hist.length - 1];
    if (!last) { skippedNoData++; continue; }

    const micro = microFeatures(hist);

    // Already resolved above; a market with no entry scores neutral, which is
    // not the same as scoring zero.
    const news: NewsSignal = newsResult.signals.get(market.id) ?? NEUTRAL_NEWS;

    const weights = weightsForCategory(weightConfig, market.category);
    const usable = activeWeights(weights, disabled);
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

    // A market that is weak on BOTH sides simply does not surface. There is
    // deliberately no third "no edge" state to render.
    if (!surfaces(winner.score, thresholds.surface ?? 5)) {
      belowSurface++;
      continue;
    }

    scoreRows.push({
      market_id: market.id,
      model_version_id: version.id,
      ts,
      side,
      score: winner.score,
      breakdown: winner.breakdown,
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

  const result = {
    ok: true,
    modelVersion: version.version_label,
    disabledSignals: disabled,
    considered: markets.length,
    candidates: ids.length,
    scored: scoreRows.length,
    tags: tagRows.length,
    belowSurface,
    skippedNoData,
    newsFetched: newsResult.fetched,
    newsCached: newsResult.cached,
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: 'scoring.completed',
    detail: `${result.scored} markets scored on ${version.version_label}`,
    metadata: result,
  });

  return json(result);
}));
