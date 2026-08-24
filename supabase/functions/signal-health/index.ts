/**
 * Signal health monitor — scheduled, hourly.
 *
 * Rolling win rate per signal over the last N resolved trades. A signal is
 * credited with a trade when it was the DOMINANT contributor to that trade's
 * entry score — the breakdown stored on the score row makes that attributable
 * after the fact, which is why breakdown values are contributions rather than
 * raw sub-scores.
 *
 * Auto-disable is deliberately conservative: it needs a minimum sample before
 * it will act at all, because disabling a signal on eight trades is noise
 * chasing, and a disabled signal changes every score on the platform.
 */

import { handler, json, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { logActivity, notifyAdmins } from '../_shared/log.ts';
import { SIGNAL_KEYS, type SignalKey } from '../_shared/outcome-shared.mjs';

interface Settings {
  windowSize: number;
  minWinRate: number;
  accuracyDropPct: number;
  cooldownHours: number;
  minSample: number;
}

async function loadSettings(db: ReturnType<typeof serviceClient>): Promise<Settings> {
  const { data } = await db
    .from('platform_settings')
    .select('key, value')
    .in('key', [
      'signal_window_size',
      'signal_min_win_rate',
      'signal_accuracy_drop_pct',
      'signal_cooldown_hours',
      'signal_min_sample',
    ]);

  const m = new Map((data ?? []).map((r: { key: string; value: unknown }) => [r.key, Number(r.value)]));
  return {
    windowSize: m.get('signal_window_size') ?? 100,
    minWinRate: m.get('signal_min_win_rate') ?? 0.48,
    accuracyDropPct: m.get('signal_accuracy_drop_pct') ?? 0.1,
    cooldownHours: m.get('signal_cooldown_hours') ?? 24,
    minSample: m.get('signal_min_sample') ?? 25,
  };
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);

  const cfg = await loadSettings(db);
  const now = new Date();

  // ---- the rolling window ------------------------------------------------
  // Resolved trades, newest first, joined to the score breakdown that was in
  // force at entry.
  const { data: resolved, error } = await db
    .from('trade_resolutions')
    .select('outcome, resolved_at, trades!inner(id, market_id, model_version_id, entry_score)')
    .order('resolved_at', { ascending: false })
    .limit(cfg.windowSize);

  if (error) throw new Error(`resolution load failed: ${error.message}`);

  const rows = (resolved ?? []) as Array<{
    outcome: 'win' | 'loss';
    trades: { id: string; market_id: string; model_version_id: string };
  }>;

  // Fetch the breakdowns for those trades' entry scores in one go.
  const marketIds = [...new Set(rows.map((r) => r.trades.market_id))];
  const { data: scoreRows } = marketIds.length
    ? await db
      .from('scores')
      .select('market_id, model_version_id, breakdown, ts')
      .in('market_id', marketIds)
      .order('ts', { ascending: true })
    : { data: [] };

  // Earliest score per (market, version) approximates the breakdown at entry.
  const breakdowns = new Map<string, Record<SignalKey, number>>();
  for (const s of (scoreRows ?? []) as Array<{
    market_id: string;
    model_version_id: string;
    breakdown: Record<SignalKey, number>;
  }>) {
    const key = `${s.market_id}|${s.model_version_id}`;
    if (!breakdowns.has(key)) breakdowns.set(key, s.breakdown);
  }

  // ---- attribute each trade to its dominant signal ------------------------
  const tally: Record<SignalKey, { wins: number; total: number }> = {
    micro: { wins: 0, total: 0 },
    news: { wins: 0, total: 0 },
    base: { wins: 0, total: 0 },
  };

  for (const r of rows) {
    const bd = breakdowns.get(`${r.trades.market_id}|${r.trades.model_version_id}`);
    if (!bd) continue;

    let dominant: SignalKey = 'micro';
    let best = -Infinity;
    for (const k of SIGNAL_KEYS) {
      const v = Number(bd[k] ?? 0);
      if (v > best) { best = v; dominant = k; }
    }
    if (best <= 0) continue; // signal contributed nothing; not its result to own

    tally[dominant].total++;
    if (r.outcome === 'win') tally[dominant].wins++;
  }

  // ---- evaluate ----------------------------------------------------------
  const { data: current } = await db.from('signal_health').select('*');
  const currentBySignal = new Map(
    (current ?? []).map((h: { signal: SignalKey }) => [h.signal, h]),
  );

  const updates: Record<string, unknown>[] = [];
  const historyRows: Record<string, unknown>[] = [];
  const disabledNow: SignalKey[] = [];

  for (const signal of SIGNAL_KEYS) {
    const t = tally[signal];
    const existing = currentBySignal.get(signal) as
      | { status: string; disabled_until: string | null; baseline_win_rate: number | null }
      | undefined;

    const winRate = t.total > 0 ? t.wins / t.total : null;

    // A cooling-off signal comes back on its own when the window expires.
    if (existing?.status === 'disabled') {
      const until = existing.disabled_until ? new Date(existing.disabled_until) : null;
      if (until && until > now) {
        historyRows.push({ signal, win_rate: winRate, sample_count: t.total, status: 'disabled' });
        continue;
      }
      updates.push({
        signal,
        window_size: cfg.windowSize,
        win_rate: winRate,
        sample_count: t.total,
        status: 'healthy',
        disabled_until: null,
        disabled_reason: null,
        computed_at: now.toISOString(),
      });
      historyRows.push({ signal, win_rate: winRate, sample_count: t.total, status: 'healthy' });

      await logActivity(db, {
        type: 'signal.reenabled',
        detail: `${signal} cooldown expired`,
        metadata: { signal },
      });
      continue;
    }

    // Below the minimum sample there is nothing trustworthy to say, so the
    // signal stays healthy rather than being judged on a handful of trades.
    if (winRate === null || t.total < cfg.minSample) {
      updates.push({
        signal,
        window_size: cfg.windowSize,
        win_rate: winRate,
        sample_count: t.total,
        status: 'healthy',
        computed_at: now.toISOString(),
      });
      historyRows.push({ signal, win_rate: winRate, sample_count: t.total, status: 'healthy' });
      continue;
    }

    const baseline = existing?.baseline_win_rate ?? null;
    const dropped = baseline !== null && baseline - winRate >= cfg.accuracyDropPct;
    const belowFloor = winRate < cfg.minWinRate;

    let status: 'healthy' | 'degraded' | 'disabled' = 'healthy';
    let reason: string | null = null;

    if (belowFloor && dropped) {
      // Both triggers at once: not drift, a break.
      status = 'disabled';
      reason = `Win rate ${(winRate * 100).toFixed(1)}% is below the ${(cfg.minWinRate * 100).toFixed(0)}% floor and has dropped ${((baseline! - winRate) * 100).toFixed(1)} points.`;
    } else if (belowFloor || dropped) {
      status = 'degraded';
      reason = belowFloor
        ? `Win rate ${(winRate * 100).toFixed(1)}% is below the ${(cfg.minWinRate * 100).toFixed(0)}% floor — will auto-disable if it drops further.`
        : `Accuracy has dropped ${((baseline! - winRate) * 100).toFixed(1)} points from baseline.`;
    }

    const row: Record<string, unknown> = {
      signal,
      window_size: cfg.windowSize,
      win_rate: winRate,
      sample_count: t.total,
      status,
      disabled_reason: reason,
      computed_at: now.toISOString(),
    };

    if (status === 'disabled') {
      row.disabled_until = new Date(now.getTime() + cfg.cooldownHours * 3600_000).toISOString();
      disabledNow.push(signal);
    } else {
      row.disabled_until = null;
      // Establish a baseline the first time a signal has enough history, and
      // ratchet it up on improvement. Never ratchet it down — a baseline that
      // follows a decline would make the drop test unable to ever fire.
      if (baseline === null || winRate > baseline) row.baseline_win_rate = winRate;
    }

    updates.push(row);
    historyRows.push({ signal, win_rate: winRate, sample_count: t.total, status });
  }

  if (updates.length) {
    const { error: uErr } = await db.from('signal_health').upsert(updates, { onConflict: 'signal' });
    if (uErr) throw new Error(`signal_health upsert failed: ${uErr.message}`);
  }
  if (historyRows.length) await db.from('signal_health_history').insert(historyRows);

  for (const signal of disabledNow) {
    const row = updates.find((u) => u.signal === signal)!;
    await notifyAdmins(db, {
      type: 'signal.disabled',
      title: `Signal auto-disabled: ${signal}`,
      body: String(row.disabled_reason ?? ''),
      payload: { signal, disabled_until: row.disabled_until },
    });
    await logActivity(db, {
      type: 'signal.disabled',
      detail: `${signal}: ${row.disabled_reason}`,
      metadata: { signal, win_rate: row.win_rate, sample_count: row.sample_count },
    });
  }

  return json({
    ok: true,
    windowSize: cfg.windowSize,
    evaluated: rows.length,
    attribution: tally,
    disabled: disabledNow,
    signals: updates.map((u) => ({
      signal: u.signal,
      status: u.status,
      winRate: u.win_rate,
      sampleCount: u.sample_count,
    })),
  });
}));
