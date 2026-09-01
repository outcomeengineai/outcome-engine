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
import { newsSignalFor, type NewsSignal } from '../_shared/news.ts';
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
  let marketQuery = db
    .from('markets')
    .select('id, question, category')
    .is('resolved_at', null)
    .limit(Math.min(body.limit ?? MAX_MARKETS_PER_PASS, MAX_MARKETS_PER_PASS));

  if (body.marketIds?.length) marketQuery = marketQuery.in('id', body.marketIds);
  else marketQuery = marketQuery.or(`close_time.is.null,close_time.gt.${new Date().toISOString()}`);

  const { data: markets, error: mErr } = await marketQuery;
  if (mErr) throw new Error(`market load failed: ${mErr.message}`);
  if (!markets?.length) return json({ ok: true, scored: 0, reason: 'no open markets' });

  const ids = (markets as MarketRow[]).map((m) => m.id);

  // ---- snapshot history, one query for the whole batch -------------------
  const since = new Date(Date.now() - HISTORY_HOURS * 3600_000).toISOString();

  // Batched: 400 tickers in one .in() produced a ~12KB URL, which PostgREST
  // refused to send at all. See _shared/batch.ts.
  const snaps = await selectInBatches<Snapshot & { market_id: string }>(
    ids,
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

  // ---- score --------------------------------------------------------------
  const scoreRows: Record<string, unknown>[] = [];
  const tagRows: Record<string, unknown>[] = [];
  const ts = new Date().toISOString();

  let skippedNoData = 0;
  let belowSurface = 0;

  for (const market of markets as MarketRow[]) {
    const hist = history.get(market.id) ?? [];
    const last = hist[hist.length - 1];
    if (!last) { skippedNoData++; continue; }

    const micro = microFeatures(hist);

    let news: NewsSignal;
    if (disabled.includes('news')) {
      // Do not spend an upstream call on a signal that is about to be
      // multiplied by a zero weight.
      news = { volume: 0, sentiment: 0, coverage: 0, fetchedAt: ts };
    } else {
      news = await newsSignalFor(db, market);
    }

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
    scored: scoreRows.length,
    tags: tagRows.length,
    belowSurface,
    skippedNoData,
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: 'scoring.completed',
    detail: `${result.scored} markets scored on ${version.version_label}`,
    metadata: result,
  });

  return json(result);
}));
