/**
 * Publish a model version — admin action from Strategy > Review & publish,
 * and the "Promote to live" button on Simulate.
 *
 * Publishing does three things:
 *   1. flips the draft to stable and opens a transition window on the version
 *      it replaces (SQL: publish_model_version)
 *   2. re-scores every open market under the new weights
 *   3. tells anyone holding an OPEN trade whose score moved materially, with
 *      the new number and a recommendation
 *
 * What it does NOT do is touch the trades themselves. Their model_version_id
 * and entry_score are frozen by a database trigger. A retune changes what the
 * platform would say TODAY; it never rewrites what it said when the member
 * committed money, because that record is the only honest basis for
 * calibration later.
 */

import {
  badRequest,
  handler,
  json,
  readJson,
  requireAdmin,
  serviceClient,
} from '../_shared/http.ts';
import { logActivity, notifyMany } from '../_shared/log.ts';
import {
  formatScore,
  retuneRecommendation,
  scoreChangedMaterially,
  type Thresholds,
} from '../_shared/outcome-shared.mjs';

const RECOMMENDATION_TEXT: Record<string, string> = {
  hold: 'Still a strong pick — no action suggested.',
  review: 'Worth a look before it resolves.',
  consider_exit: 'The model no longer likes this one.',
};

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') badRequest('POST only');

  const db = serviceClient();
  const admin = await requireAdmin(req, db);
  const body = await readJson<{ modelVersionId: string }>(req);

  if (!body.modelVersionId) badRequest('modelVersionId is required');

  // ---- capture the BEFORE picture ---------------------------------------
  // Must happen before publishing: afterwards, effective_version_for() would
  // already be pointing at the new version.
  const { data: previousVersionId } = await db.rpc('current_stable_version');

  const { data: openTrades } = await db
    .from('trades')
    .select('id, user_id, market_id, entry_score, side, markets(question)')
    .eq('status', 'open');

  const trades = (openTrades ?? []) as Array<{
    id: string;
    user_id: string;
    market_id: string;
    entry_score: number;
    side: string;
    markets: { question: string } | null;
  }>;

  const priorScores = new Map<string, number>();
  if (previousVersionId && trades.length) {
    const { data: prior } = await db
      .from('latest_scores')
      .select('market_id, score')
      .eq('model_version_id', previousVersionId)
      .in('market_id', [...new Set(trades.map((t) => t.market_id))]);

    for (const s of (prior ?? []) as Array<{ market_id: string; score: number }>) {
      priorScores.set(s.market_id, Number(s.score));
    }
  }

  // ---- publish -----------------------------------------------------------
  // The SQL function re-checks admin rights itself, so this is not the only
  // gate — it is the convenient one.
  const { data: published, error: pErr } = await db.rpc('publish_model_version', {
    p_version: body.modelVersionId,
  });
  if (pErr) throw new Error(`publish failed: ${pErr.message}`);
  if (!published) badRequest('model version not found');

  // ---- re-score under the new weights ------------------------------------
  const scoreRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/score-markets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'x-cron-secret': Deno.env.get('CRON_SECRET') ?? '',
    },
    body: JSON.stringify({}),
  });

  const scoreResult = scoreRes.ok
    ? await scoreRes.json()
    : { ok: false, error: await scoreRes.text() };

  // ---- notify holders of materially-changed open trades ------------------
  const thresholds = (published.thresholds ?? {}) as Thresholds;
  const strong = thresholds.strongPick ?? 7;

  const notifications: Array<{
    userId: string;
    type: string;
    title: string;
    body: string;
    payload: Record<string, unknown>;
  }> = [];

  if (trades.length) {
    const { data: fresh } = await db
      .from('latest_scores')
      .select('market_id, score, side')
      .eq('model_version_id', published.id)
      .in('market_id', [...new Set(trades.map((t) => t.market_id))]);

    const newScores = new Map(
      (fresh ?? []).map((s: { market_id: string; score: number }) => [s.market_id, Number(s.score)]),
    );

    for (const trade of trades) {
      const after = newScores.get(trade.market_id);
      // A market that no longer surfaces at all has no new score to report.
      // Silence is the wrong answer, so fall back to the entry score as the
      // comparison point and let the recommendation speak.
      const before = priorScores.get(trade.market_id) ?? Number(trade.entry_score);
      if (after === undefined) continue;
      if (!scoreChangedMaterially(before, after)) continue;

      const rec = retuneRecommendation(after, strong);
      const direction = after > before ? 'up' : 'down';

      notifications.push({
        userId: trade.user_id,
        type: 'model.retuned',
        title: `${published.version_label}: score moved ${direction}`,
        body:
          `${trade.markets?.question ?? trade.market_id} — ` +
          `${formatScore(before)} → ${formatScore(after)}. ${RECOMMENDATION_TEXT[rec]}`,
        payload: {
          trade_id: trade.id,
          market_id: trade.market_id,
          previous_score: before,
          new_score: after,
          recommendation: rec,
          model_version_id: published.id,
          entry_score: Number(trade.entry_score),
        },
      });
    }
  }

  // Everyone hears that a new version exists, whether or not they hold
  // anything affected — the transition window is only useful if they know
  // it has started.
  const { data: members } = await db
    .from('users')
    .select('id')
    .neq('account_status', 'removed');

  const affectedUsers = new Set(notifications.map((n) => n.userId));
  for (const m of (members ?? []) as Array<{ id: string }>) {
    if (affectedUsers.has(m.id)) continue;
    notifications.push({
      userId: m.id,
      type: 'model.published',
      title: `New model version: ${published.version_label}`,
      body: 'Scores have been recalculated. You can stay on the previous version for a short while from Settings.',
      payload: { model_version_id: published.id, label: published.version_label },
    });
  }

  await notifyMany(db, notifications);

  await logActivity(db, {
    userId: admin.id,
    type: 'model.published',
    detail: `${published.version_label} published; ${affectedUsers.size} open trades materially changed`,
    metadata: {
      model_version_id: published.id,
      previous_version_id: previousVersionId,
      affected_trades: affectedUsers.size,
      rescore: scoreResult,
    },
  });

  return json({
    ok: true,
    version: published,
    previousVersionId,
    rescore: scoreResult,
    notified: notifications.length,
    materiallyChanged: affectedUsers.size,
  });
}));
