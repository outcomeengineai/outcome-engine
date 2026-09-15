/**
 * Model review digest — scheduled, weekly.
 *
 * Puts the calibration verdicts in front of every admin without anyone
 * opening the dashboard: per tier, how many calls have been labelled, which
 * score bands clear breakeven at their confidence floor, and what the
 * evidence supports for the surface and strong thresholds.
 *
 * It reports what the SQL concluded; it does not conclude anything itself.
 * When the evidence is thin it says so, because a digest that manufactured a
 * recommendation from twelve labels would be worse than silence.
 */

import { handler, json, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { logActivity, notifyAdmins } from '../_shared/log.ts';

interface Rec {
  tier: string;
  labelled: number;
  priced: number;
  edge_bands: number[];
  suggested_surface: number | null;
  suggested_strong: number | null;
  verdict: string;
}

interface Bucket {
  tier: string;
  band: number;
  n: number;
  hit_rate: number;
  ci_low: number;
  priced_n: number;
  priced_hit_rate: number | null;
  breakeven_rate: number | null;
  avg_net_cents: number | null;
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);

  const [{ data: recs, error: rErr }, { data: buckets, error: bErr }, { data: stable }] = await Promise.all([
    db.rpc('calibration_recommendations', { p_version: null }),
    db.rpc('calibration_table', { p_version: null, p_by_category: false }),
    db.rpc('current_stable_version'),
  ]);
  if (rErr) throw new Error(`recommendations failed: ${rErr.message}`);
  if (bErr) throw new Error(`calibration table failed: ${bErr.message}`);

  const recommendations = (recs ?? []) as Rec[];
  const rows = (buckets ?? []) as Bucket[];
  const total = recommendations.reduce((s, r) => s + Number(r.labelled), 0);

  const { data: version } = stable
    ? await db.from('model_versions').select('version_label, thresholds').eq('id', stable).maybeSingle()
    : { data: null };
  const thresholds = (version?.thresholds ?? {}) as { surface?: number; strongPick?: number };

  // ---- compose ------------------------------------------------------------
  const lines: string[] = [];
  lines.push(`${total.toLocaleString()} labelled calls, net of Kalshi fees. Live: ${version?.version_label ?? '?'} ` +
    `(surface ${thresholds.surface ?? '?'}, strong ${thresholds.strongPick ?? '?'}).`);

  for (const r of recommendations) {
    lines.push('');
    lines.push(`${r.tier.toUpperCase()} — ${Number(r.labelled).toLocaleString()} labels: ${r.verdict}`);
    const tierRows = rows.filter((b) => b.tier === r.tier).sort((a, b) => a.band - b.band);
    for (const b of tierRows) {
      const be = b.breakeven_rate === null ? '—' : `${(Number(b.breakeven_rate) * 100).toFixed(0)}%`;
      const net = b.avg_net_cents === null ? '—' : `${Number(b.avg_net_cents) >= 0 ? '+' : ''}${Number(b.avg_net_cents).toFixed(1)}¢`;
      // Net and the hit rate beside it describe the SAME rows: the priced
      // subset. The full-sample hit rate is reported separately so a small
      // priced sample cannot masquerade as the band's verdict.
      const priced = Number(b.priced_n) === 0
        ? 'no entry prices yet'
        : `priced n=${b.priced_n} hit ${(Number(b.priced_hit_rate) * 100).toFixed(0)}% breakeven ${be} net ${net}`;
      lines.push(`  ${b.band}.x  n=${b.n}  hit ${(Number(b.hit_rate) * 100).toFixed(0)}% (floor ${(Number(b.ci_low) * 100).toFixed(0)}%)  |  ${priced}`);
    }
    if (r.suggested_surface !== null && thresholds.surface !== undefined &&
        Number(r.suggested_surface) !== Number(thresholds.surface)) {
      lines.push(`  → evidence supports surface ${Number(r.suggested_surface).toFixed(1)}; live is ${thresholds.surface}. A version change is a decision, not an automation.`);
    }
  }

  if (total === 0) {
    lines.push('');
    lines.push('No labelled calls yet. Labels arrive as scored markets resolve.');
  }

  const body = lines.join('\n');

  await notifyAdmins(db, {
    type: 'model.review_digest',
    title: `Model review: ${total.toLocaleString()} labelled calls`,
    body,
    payload: { recommendations, live: version?.version_label ?? null },
  });

  await logActivity(db, {
    type: 'model.review_digest',
    detail: `digest sent to admins: ${total} labels across ${recommendations.length} tier(s)`,
    metadata: { total, tiers: recommendations.map((r) => r.tier) },
  });

  return json({ ok: true, total, recommendations, body });
}));
