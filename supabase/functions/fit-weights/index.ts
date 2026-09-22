/**
 * Fitted weights — scheduled weekly, or run by an admin.
 *
 * Fits a logistic model to the labelled calls (raw sub-scores + entry price
 * -> did the model's side win), walk-forward, and compares following the
 * fitted model against following the live one on the same out-of-sample
 * rows, net of Kalshi fees. If the fitted policy makes more per contract on
 * enough calls, it writes a DRAFT model version carrying the implied blend
 * weights and the full report in its notes. It never publishes.
 *
 * Evidence before publish (section 7): the report is the argument, a person
 * makes the decision from the dashboard, and the version records why.
 */

import { handler, json, readJson, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { logActivity, notifyAdmins } from '../_shared/log.ts';
import { selectPaged } from '../_shared/batch.ts';
import {
  impliedBlendWeights,
  walkForward,
  type LabelledCall,
  type WalkForwardReport,
} from '../_shared/outcome-shared.mjs';

/** Labels with raw sub-scores AND an entry price, before a fit means anything. */
const MIN_ROWS = 300;
/** Out-of-sample calls the fitted policy must take before its edge counts. */
const MIN_TAKEN = 30;

interface ThesisRow {
  market_id: string;
  created_at: string;
  payload: {
    subs?: { micro: number; news: number; base: number };
    price?: number;
    score?: number;
    side?: string;
    resolved_outcome?: string;
    tier?: string;
  };
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);
  const body = await readJson<{ dryRun?: boolean; tier?: string }>(req);
  const tier = body.tier ?? 'fast';

  const { data: startRow } = await db.from('platform_settings').select('value').eq('key', 'calibration_start').maybeSingle();
  const since = String(startRow?.value ?? '"2026-09-14T02:00:00Z"').replace(/"/g, '');

  const { data: stableId } = await db.rpc('current_stable_version');
  const { data: live } = stableId
    ? await db.from('model_versions').select('id, version_label, weights, thresholds, risk_limits').eq('id', stableId).maybeSingle()
    : { data: null };
  if (!live) return json({ ok: false, error: 'no stable version' }, 409);
  const liveSurface = Number((live.thresholds as { surface?: number })?.surface ?? 5);

  // ---- labelled calls with everything a fit needs -------------------------
  const rows = await selectPaged<ThesisRow>(
    (from, to) =>
      db
        .from('edge_theses')
        .select('market_id, created_at, payload')
        .gte('created_at', since)
        .contains('payload', { final_state: true })
        // Only rows that carry raw sub-scores. Without this the page window
        // fills with the oldest labels, which predate subs, and the job
        // reports "insufficient" while thousands of usable rows sit past it.
        .not('payload->subs', 'is', null)
        .order('created_at', { ascending: true })
        .order('id')
        .range(from, to),
    { max: 50_000, label: 'labelled theses' },
  );

  const calls: LabelledCall[] = [];
  for (const r of rows) {
    const p = r.payload;
    if (!p.subs || p.price === undefined || p.score === undefined || !p.side || !p.resolved_outcome) continue;
    if ((p.tier ?? 'fast') !== tier) continue;
    calls.push({
      at: r.created_at,
      subs: { micro: Number(p.subs.micro), news: Number(p.subs.news), base: Number(p.subs.base) },
      price: Number(p.price),
      score: Number(p.score),
      hit: p.side === p.resolved_outcome,
    });
  }

  if (calls.length < MIN_ROWS) {
    const result = { ok: true, fitted: false, reason: `${calls.length} usable labels; need ${MIN_ROWS}`, tier, labelled: rows.length, usable: calls.length };
    await logActivity(db, { type: 'fit.insufficient', detail: result.reason, metadata: result });
    return json(result);
  }

  // ---- fit, walk-forward ---------------------------------------------------
  const report: WalkForwardReport = walkForward(calls, { liveSurface, folds: 5 });
  const implied = impliedBlendWeights(report.coefficients);

  const fittedBetter =
    report.fittedPolicy.taken >= MIN_TAKEN &&
    report.fittedPolicy.netPerContractCents > report.livePolicy.netPerContractCents &&
    report.fittedPolicy.netPerContractCents > 0;

  const summary =
    `${tier}: ${calls.length} labelled calls, ${report.holdout} out of sample. ` +
    `Fitted Brier ${report.fittedBrier} vs base-rate ${report.baseRateBrier}. ` +
    `Fitted policy: ${report.fittedPolicy.taken} calls, ${report.fittedPolicy.netPerContractCents.toFixed(1)}c/contract. ` +
    `Live (${live.version_label}, surface ${liveSurface}): ${report.livePolicy.taken} calls, ${report.livePolicy.netPerContractCents.toFixed(1)}c/contract. ` +
    `Implied weights ${implied ? JSON.stringify(implied) : 'none positive'}.`;

  if (!fittedBetter || !implied || body.dryRun) {
    const result = { ok: true, fitted: true, drafted: false, tier, reason: body.dryRun ? 'dry run' : 'fitted policy does not beat live out of sample', report, implied, summary };
    await logActivity(db, { type: 'fit.no_change', detail: summary, metadata: { report, implied } });
    return json(result);
  }

  // ---- write the proposal as a DRAFT ------------------------------------
  const { data: existing } = await db.from('model_versions').select('version_label').order('created_at', { ascending: false });
  const labels = ((existing ?? []) as Array<{ version_label: string }>).map((v) => v.version_label);
  let n = 1;
  while (labels.includes(`fit-${n}`)) n++;
  const label = `fit-${n}`;

  const weights = { ...(live.weights as Record<string, unknown>), default: implied };
  const notes =
    `Fitted proposal from ${calls.length} labelled ${tier}-tier calls, walk-forward (5 folds), ` +
    `out of sample net of fees. ${summary} Coefficients ${JSON.stringify(report.coefficients)}. ` +
    `Thresholds inherited from ${live.version_label} and should be re-anchored before publish. ` +
    `Generated by fit-weights; not published.`;

  const { data: draft, error } = await db
    .from('model_versions')
    .insert({
      version_label: label,
      status: 'draft',
      weights,
      thresholds: live.thresholds,
      risk_limits: live.risk_limits,
      notes,
    })
    .select('id, version_label')
    .single();
  if (error) throw new Error(`draft insert failed: ${error.message}`);

  await notifyAdmins(db, {
    type: 'model.fit_proposal',
    title: `Fitted weights proposal: ${label}`,
    body: summary + ' Review it on the Strategy page; nothing is published.',
    payload: { version_label: label, report, implied },
  });
  await logActivity(db, { type: 'fit.drafted', detail: `${label}: ${summary}`, metadata: { version_id: draft.id, report, implied } });

  return json({ ok: true, fitted: true, drafted: true, version: draft, report, implied, summary });
}));
