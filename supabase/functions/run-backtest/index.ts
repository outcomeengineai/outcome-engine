/**
 * Backtest a draft model version — the Simulate screen.
 *
 * Replays a draft's weights over stored snapshots and RESOLVED market
 * outcomes, and returns two equity curves for the overlay chart: the draft
 * against the currently-live version over the same window.
 *
 * Honest limits, worth stating because a backtest that looks precise invites
 * more trust than it has earned:
 *   - It assumes a fill at the snapshot mid price. Real fills cross a spread.
 *   - It sizes every simulated trade identically, so it measures the model's
 *     hit rate, not any member's actual staking.
 *   - It can only reach back as far as raw snapshots are retained (30 days by
 *     default); beyond that only daily aggregates survive.
 */

import {
  badRequest,
  handler,
  json,
  readJson,
  requireAdmin,
  serviceClient,
} from '../_shared/http.ts';
import { logActivity } from '../_shared/log.ts';
import {
  activeWeights,
  combineSignals,
  pickSide,
  realizedPnlCents,
  surfaces,
  weightsForCategory,
  type ScoreBreakdown,
  type Thresholds,
  type WeightConfig,
} from '../_shared/outcome-shared.mjs';
import {
  baseRateScore,
  microFeatures,
  microScore,
  newsScore,
  sidePrice,
  type Snapshot,
} from '../_shared/signals.ts';

/** Every simulated position is the same size, so results compare like for like. */
const SIM_CONTRACTS = 50;

interface Body {
  modelVersionId: string;
  compareVersionId?: string;
  rangeStart: string;
  rangeEnd: string;
}

interface Point { t: string; equity: number }

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') badRequest('POST only');

  const db = serviceClient();
  const admin = await requireAdmin(req, db);
  const body = await readJson<Body>(req);

  if (!body.modelVersionId) badRequest('modelVersionId is required');
  if (!body.rangeStart || !body.rangeEnd) badRequest('rangeStart and rangeEnd are required');

  const { data: liveVersionId } = await db.rpc('current_stable_version');
  const compareId = body.compareVersionId ?? liveVersionId ?? null;

  const { data: run, error: runErr } = await db
    .from('backtest_runs')
    .insert({
      model_version_id: body.modelVersionId,
      compare_version_id: compareId,
      range_start: body.rangeStart,
      range_end: body.rangeEnd,
      status: 'running',
      created_by: admin.id,
    })
    .select()
    .single();
  if (runErr || !run) throw new Error(`could not start run: ${runErr?.message}`);

  try {
    const ids = [body.modelVersionId, compareId].filter(Boolean) as string[];
    const { data: versions } = await db
      .from('model_versions')
      .select('id, version_label, weights, thresholds')
      .in('id', ids);

    const draft = (versions ?? []).find((v: { id: string }) => v.id === body.modelVersionId);
    if (!draft) badRequest('model version not found');
    const compare = (versions ?? []).find((v: { id: string }) => v.id === compareId);

    // ---- the universe: markets that RESOLVED inside the window -----------
    // Only resolved markets can be scored for correctness. An open market has
    // no answer to check the model against.
    const { data: markets, error: mErr } = await db
      .from('markets')
      .select('id, question, category, outcome, resolved_at')
      .not('resolved_at', 'is', null)
      .gte('resolved_at', body.rangeStart)
      .lte('resolved_at', body.rangeEnd)
      .limit(1000);
    if (mErr) throw new Error(`market load failed: ${mErr.message}`);

    const universe = (markets ?? []) as Array<{
      id: string;
      category: string;
      outcome: 'YES' | 'NO' | null;
      resolved_at: string;
    }>;

    if (universe.length === 0) {
      await db
        .from('backtest_runs')
        .update({
          status: 'complete',
          simulated_pnl: 0,
          max_drawdown: 0,
          trade_count: 0,
          equity_curve: [],
          compare_curve: [],
          error: 'No markets resolved in this range. Snapshots are retained for 30 days by default.',
          completed_at: new Date().toISOString(),
        })
        .eq('id', run.id);

      return json({ ok: true, run: run.id, tradeCount: 0, note: 'no resolved markets in range' });
    }

    // ---- snapshot history for the whole universe -------------------------
    const { data: snaps } = await db
      .from('market_snapshots')
      .select('market_id, ts, price, volume, spread, open_interest, liquidity')
      .in('market_id', universe.map((m) => m.id))
      .gte('ts', body.rangeStart)
      .lte('ts', body.rangeEnd)
      .order('ts', { ascending: true });

    const history = new Map<string, Snapshot[]>();
    for (const s of (snaps ?? []) as Array<Snapshot & { market_id: string }>) {
      history.set(s.market_id, [...(history.get(s.market_id) ?? []), s]);
    }

    // ---- cached news, if any survives for these markets -------------------
    const { data: newsRows } = await db
      .from('news_cache')
      .select('market_id, volume, sentiment, coverage, fetched_at')
      .in('market_id', universe.map((m) => m.id));

    const newsByMarket = new Map(
      (newsRows ?? []).map((n: {
        market_id: string;
        volume: number;
        sentiment: number;
        coverage: number;
        fetched_at: string;
      }) => [n.market_id, {
        volume: n.volume,
        sentiment: Number(n.sentiment),
        coverage: Number(n.coverage),
        fetchedAt: n.fetched_at,
      }]),
    );

    // ---- simulate one version --------------------------------------------
    const simulate = (version: { weights: WeightConfig; thresholds: Thresholds }) => {
      const weightConfig = version.weights;
      const thresholds = version.thresholds ?? { surface: 5, strongPick: 7 };
      const trades: Array<{ resolvedAt: string; pnl: number }> = [];

      for (const market of universe) {
        if (!market.outcome) continue;

        const hist = history.get(market.id) ?? [];
        if (hist.length < 2) continue;

        // Score at the FIRST snapshot in the window, using only what was known
        // at that moment. Scoring on the last snapshot would be lookahead —
        // the price by then already reflects the outcome.
        const entryIndex = Math.min(3, hist.length - 1);
        const entrySnap = hist[entryIndex]!;
        const priorHistory = hist.slice(0, entryIndex + 1);

        const micro = microFeatures(priorHistory);
        const news = newsByMarket.get(market.id) ??
          { volume: 0, sentiment: 0, coverage: 0, fetchedAt: entrySnap.ts };

        const weights = weightsForCategory(weightConfig, market.category);
        const usable = activeWeights(weights, []);
        if (!usable) continue;

        const evaluate = (side: 'YES' | 'NO') => {
          const price = sidePrice(entrySnap.price, side);
          const subs: ScoreBreakdown = {
            micro: microScore(micro, side),
            news: newsScore(news, side),
            // No historical base rate is replayed: reconstructing what the
            // track record looked like at each past moment is a bigger job
            // than this screen justifies, and using TODAY's win rates would
            // leak the future into the past.
            base: baseRateScore({ sampleCount: 0, winRate: 0.5, sidePriceCents: price }),
          };
          return combineSignals(subs, usable);
        };

        const yes = evaluate('YES');
        const no = evaluate('NO');
        const side = pickSide(yes.score, no.score);
        const winner = side === 'YES' ? yes : no;

        if (!surfaces(winner.score, thresholds.surface ?? 5)) continue;
        if (winner.score < (thresholds.strongPick ?? 7)) continue; // simulate the picks a member would see

        const entryPrice = sidePrice(entrySnap.price, side);
        if (entryPrice < 1 || entryPrice > 99) continue;

        trades.push({
          resolvedAt: market.resolved_at,
          pnl: realizedPnlCents(entryPrice, SIM_CONTRACTS, side === market.outcome),
        });
      }

      trades.sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt));

      const curve: Point[] = [];
      let equity = 0;
      let peak = 0;
      let maxDrawdown = 0;

      for (const t of trades) {
        equity += t.pnl;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, peak - equity);
        curve.push({ t: t.resolvedAt, equity });
      }

      return {
        pnl: equity,
        maxDrawdown,
        tradeCount: trades.length,
        wins: trades.filter((t) => t.pnl > 0).length,
        curve,
      };
    };

    const draftResult = simulate(draft as { weights: WeightConfig; thresholds: Thresholds });
    const compareResult = compare
      ? simulate(compare as { weights: WeightConfig; thresholds: Thresholds })
      : null;

    await db
      .from('backtest_runs')
      .update({
        status: 'complete',
        simulated_pnl: draftResult.pnl,
        max_drawdown: draftResult.maxDrawdown,
        trade_count: draftResult.tradeCount,
        equity_curve: draftResult.curve,
        compare_curve: compareResult?.curve ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id);

    await logActivity(db, {
      userId: admin.id,
      type: 'backtest.completed',
      detail: `${draftResult.tradeCount} simulated trades, PnL ${(draftResult.pnl / 100).toFixed(2)}`,
      metadata: { run_id: run.id, model_version_id: body.modelVersionId },
    });

    return json({
      ok: true,
      runId: run.id,
      draft: {
        label: (draft as { version_label: string }).version_label,
        pnl: draftResult.pnl,
        maxDrawdown: draftResult.maxDrawdown,
        tradeCount: draftResult.tradeCount,
        winRate: draftResult.tradeCount ? draftResult.wins / draftResult.tradeCount : null,
        curve: draftResult.curve,
      },
      compare: compareResult && compare
        ? {
          label: (compare as { version_label: string }).version_label,
          pnl: compareResult.pnl,
          maxDrawdown: compareResult.maxDrawdown,
          tradeCount: compareResult.tradeCount,
          winRate: compareResult.tradeCount ? compareResult.wins / compareResult.tradeCount : null,
          curve: compareResult.curve,
        }
        : null,
      universeSize: universe.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from('backtest_runs')
      .update({ status: 'failed', error: message, completed_at: new Date().toISOString() })
      .eq('id', run.id);
    throw err;
  }
}));
