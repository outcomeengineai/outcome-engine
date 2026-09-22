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
import { selectInBatchesPaged } from '../_shared/batch.ts';
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
  // Batched — see _shared/batch.ts. A long .in() list overflows the URL.
  // Paged within each batch: a market accumulates a score every five minutes
  // for as long as it is in the fast tier, so a batch of held markets can be
  // thousands of rows and PostgREST caps a response at 1,000 in silence.
  const scoreRows = await selectInBatchesPaged<{
    market_id: string;
    model_version_id: string;
    breakdown: Record<SignalKey, number>;
    ts: string;
  }>(
    marketIds,
    (batch, from, to) =>
      db
        .from('scores')
        .select('market_id, model_version_id, breakdown, ts')
        .in('market_id', batch)
        .order('market_id', { ascending: true })
        .order('ts', { ascending: true })
        .range(from, to),
    { label: 'score load' },
  );
  scoreRows.sort((a, b) => a.ts.localeCompare(b.ts));

  // Earliest score per (market, version) approximates the breakdown at entry.
  const breakdowns = new Map<string, Record<SignalKey, number>>();
  for (const s of scoreRows) {
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
      | { status: string; disabled_until: string | null; baseline_win_rate: number | null; hold_reason: string | null }
      | undefined;

    const winRate = t.total > 0 ? t.wins / t.total : null;

    // A manual hold is not a cooldown. It says the source is unavailable, it
    // was set by a person with a reason, and it is lifted by a person. This
    // job records the window and otherwise leaves the row alone -- without
    // this, a held signal read as an expired cooldown and came back on within
    // the hour. See migration 20260823002000.
    if (existing?.hold_reason) {
      historyRows.push({ signal, win_rate: winRate, sample_count: t.total, status: 'disabled' });
      continue;
    }

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

  // ---- platform health: the cron log and storage ---------------------------
  // pg_cron records every run. Nobody read that log for a week while the
  // prune job failed on every run and the database tripled. Two failures in
  // a row is the bar (one "job startup timeout" is weather); one
  // notification per finding per day is the budget, so a persistent fault
  // is a daily reminder and not a flood.
  const ops: string[] = [];
  try {
    const [{ data: cronRows }, { data: storageRow }] = await Promise.all([
      db.rpc('cron_health'),
      db.rpc('storage_health'),
    ]);
    const failing = ((cronRows ?? []) as Array<{
      jobname: string;
      consecutive_failures: number;
      last_message: string | null;
    }>).filter((j) => j.consecutive_failures >= 2);
    const st = (storageRow ?? {}) as { db_size_mb?: number; alert_mb?: number };
    const storageHigh = Number(st.db_size_mb ?? 0) > Number(st.alert_mb ?? Number.POSITIVE_INFINITY);

    const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const { data: recent } = await db
      .from('activity_log')
      .select('event_type, metadata')
      .in('event_type', ['ops.cron_failing', 'ops.storage_high'])
      .gte('ts', dayAgo);
    const alreadyToday = new Set(
      ((recent ?? []) as Array<{ event_type: string; metadata: { job?: string } | null }>).map(
        (r) => `${r.event_type}|${r.metadata?.job ?? ''}`,
      ),
    );

    for (const j of failing) {
      if (alreadyToday.has(`ops.cron_failing|${j.jobname}`)) continue;
      const detail = `${j.jobname} has failed ${j.consecutive_failures} runs in a row: ${j.last_message ?? 'no message'}`;
      await notifyAdmins(db, {
        type: 'ops.cron_failing',
        title: `Cron job failing: ${j.jobname}`,
        body: `${detail}. See the Health tab.`,
        payload: { job: j.jobname, consecutive: j.consecutive_failures },
      });
      await logActivity(db, {
        type: 'ops.cron_failing',
        detail,
        metadata: { job: j.jobname, consecutive: j.consecutive_failures },
      });
      ops.push(j.jobname);
    }

    if (storageHigh && !alreadyToday.has('ops.storage_high|')) {
      const detail = `Database is ${st.db_size_mb} MB, above the ${st.alert_mb} MB alert line.`;
      await notifyAdmins(db, {
        type: 'ops.storage_high',
        title: 'Database size above the alert line',
        body: `${detail} See the Health tab.`,
        payload: { db_size_mb: st.db_size_mb, alert_mb: st.alert_mb },
      });
      await logActivity(db, { type: 'ops.storage_high', detail, metadata: { db_size_mb: st.db_size_mb } });
      ops.push('storage');
    }
  } catch (err) {
    // The health read must never take the signal evaluation down with it.
    console.error('platform health check failed:', err instanceof Error ? err.message : String(err));
  }

  return json({
    ok: true,
    ops,
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
