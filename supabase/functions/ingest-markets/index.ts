/**
 * Market pricing — scheduled per cadence tier.
 *
 * Prices a universe that discover-markets has already chosen, rather than
 * discovering and pricing in one pass. The split matters because the two have
 * opposite economics: discovery must see everything but rarely; pricing must
 * be frequent but only for markets worth polling that often.
 *
 * Doing both together is what produced a platform scoring contracts resolving
 * in 2029 — it took the first 300 events Kalshi returned, which covered 2.7%
 * of the book at a median horizon of 1,217 days.
 *
 *   fast     every 5 minutes  — near-dated, two-sided book
 *   slow     hourly           — long-dated but still tracked, so tail entries
 *                               stay visible and accumulate history
 *   archive  daily            — very long-dated; history only
 *
 * Uses exact-set ticker fetching, so pricing 800 markets is ~6 requests rather
 * than the ~60 a full sweep would cost.
 */

import { handler, json, readJson, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import {
  dollarsToCents,
  fixedToInt,
  getMarketsByTickers,
  KalshiError,
  type KalshiMarket,
} from '../_shared/kalshi.ts';
import { logActivity } from '../_shared/log.ts';
import { forEachBatch } from '../_shared/batch.ts';

type Tier = 'fast' | 'slow' | 'archive';

/** Ceiling per pass, so one tier cannot run the function to its time limit. */
const MAX_PER_PASS: Record<Tier, number> = {
  fast: 1200,
  slow: 3000,
  archive: 6000,
};

/**
 * Best available YES price, in whole cents.
 *
 * Prefers the midpoint of the book over last price: last price is whatever
 * happened to trade most recently, which on a thin market can be minutes stale
 * and several cents from what a member would actually pay now.
 */
function yesPriceCents(m: KalshiMarket): number | null {
  const bid = dollarsToCents(m.yes_bid_dollars);
  const ask = dollarsToCents(m.yes_ask_dollars);
  if (bid > 0 && ask > 0) return Math.round((bid + ask) / 2);

  const last = dollarsToCents(m.last_price_dollars);
  if (last > 0) return last;
  if (bid > 0) return bid;
  if (ask > 0) return ask;
  return null;
}

function spreadCents(m: KalshiMarket): number {
  const bid = dollarsToCents(m.yes_bid_dollars);
  const ask = dollarsToCents(m.yes_ask_dollars);
  return bid > 0 && ask > 0 ? Math.max(0, ask - bid) : 100;
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);
  const started = Date.now();

  const body = await readJson<{ tier?: Tier; limit?: number }>(req);
  const tier: Tier = body.tier ?? 'fast';
  const cap = Math.min(body.limit ?? MAX_PER_PASS[tier], MAX_PER_PASS[tier]);

  // ---- the universe for this tier ----------------------------------------
  // Oldest-priced first, so a cap degrades into a rotation rather than
  // permanently starving the tail of the tier.
  const { data: rows, error: mErr } = await db
    .from('markets')
    .select('id')
    .eq('cadence_tier', tier)
    .is('resolved_at', null)
    .order('last_priced_at', { ascending: true, nullsFirst: true })
    .limit(cap);

  if (mErr) throw new Error(`universe load failed: ${mErr.message}`);
  const tickers = (rows ?? []).map((r: { id: string }) => r.id);

  if (tickers.length === 0) {
    return json({
      ok: true,
      tier,
      markets: 0,
      snapshots: 0,
      reason: 'no markets in this tier — has discover-markets run?',
    });
  }

  // ---- price them ---------------------------------------------------------
  let fetched: KalshiMarket[];
  try {
    fetched = await getMarketsByTickers(tickers);
  } catch (err) {
    const rateLimited = err instanceof KalshiError && err.status === 429;
    await logActivity(db, {
      type: rateLimited ? 'ingest.rate_limited' : 'ingest.failed',
      detail: `tier ${tier}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return json(
      { ok: false, tier, error: err instanceof Error ? err.message : String(err) },
      rateLimited ? 429 : 502,
    );
  }

  const now = new Date().toISOString();
  const snapshotRows: Record<string, unknown>[] = [];
  const resolvedNow: string[] = [];
  let skippedNoPrice = 0;

  for (const m of fetched) {
    if (!m.ticker) continue;

    // A market that settled between discovery passes should stop being priced.
    if (m.status === 'settled' || m.status === 'finalized') {
      resolvedNow.push(m.ticker);
      continue;
    }

    const price = yesPriceCents(m);
    if (price === null) {
      skippedNoPrice++;
      continue;
    }

    snapshotRows.push({
      market_id: m.ticker,
      ts: now,
      price,
      volume: fixedToInt(m.volume_fp),
      spread: spreadCents(m),
      open_interest: fixedToInt(m.open_interest_fp),
      liquidity: dollarsToCents(m.liquidity_dollars),
    });
  }

  const CHUNK = 500;
  for (let i = 0; i < snapshotRows.length; i += CHUNK) {
    const { error } = await db
      .from('market_snapshots')
      .upsert(snapshotRows.slice(i, i + CHUNK), { onConflict: 'market_id,ts' });
    if (error) throw new Error(`snapshot insert failed: ${error.message}`);
  }

  // Mark what we priced, so the next pass rotates rather than repeating.
  const priced = snapshotRows.map((r) => r.market_id as string);
  const touch = await forEachBatch(priced, (batch) =>
    db.from('markets').update({ last_priced_at: now }).in('id', batch));
  if (touch.error) console.warn('last_priced_at update failed:', touch.error);

  // Settled markets leave the priced universe; sync-resolutions handles the
  // trades. Membership is closed so the point-in-time record stays honest.
  if (resolvedNow.length) {
    await forEachBatch(resolvedNow, (batch) =>
      db.from('markets').update({ cadence_tier: 'excluded', tier_reason: 'settled' }).in('id', batch));
    await forEachBatch(resolvedNow, (batch) =>
      db.from('universe_membership').update({ left_at: now }).is('left_at', null).in('market_id', batch));
  }

  const result = {
    ok: true,
    tier,
    requested: tickers.length,
    returned: fetched.length,
    snapshots: snapshotRows.length,
    skippedNoPrice,
    settled: resolvedNow.length,
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: 'ingest.completed',
    detail:
      `${tier}: ${result.snapshots} snapshots of ${result.requested} requested ` +
      `(${skippedNoPrice} unpriced, ${resolvedNow.length} settled)`,
    metadata: result,
  });

  return json(result);
}));
