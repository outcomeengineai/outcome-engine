/**
 * Market ingestion — scheduled, every 5 minutes.
 *
 * Polls Kalshi's PUBLIC endpoints, so it uses no credentials and costs nothing
 * against any member's rate limit. Every user's view fans out from these shared
 * rows; nothing here is per-user, and it must stay that way or twenty members
 * become twenty times the API load for identical data.
 *
 * Reads EVENTS with nested markets rather than the flat /markets listing. That
 * listing is dominated by multi-variate-event shards carrying no order book —
 * 1,200 consecutive results with every price at zero — and it does not return
 * a category at all. Events carry the tradeable contracts and the category.
 */

import { handler, json, readJson, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import {
  dollarsToCents,
  fixedToInt,
  KalshiError,
  listAllEventsWithMarkets,
  type KalshiEvent,
  type KalshiMarket,
} from '../_shared/kalshi.ts';
import { logActivity } from '../_shared/log.ts';

/**
 * Kalshi's own categories, mapped onto the shorter names the strategy screen
 * offers per-category weight overrides for. Anything unrecognised passes
 * through unchanged rather than being flattened into 'Other', so a new Kalshi
 * category shows up in the admin UI instead of disappearing.
 */
const CATEGORY_MAP: Record<string, string> = {
  'Climate and Weather': 'Weather',
  'Science and Technology': 'Science',
  'Elections': 'Politics',
  'Companies': 'Financials',
};

function normalizeCategory(event: KalshiEvent): string {
  const raw = (event.category ?? '').trim();
  if (!raw) return 'Other';
  return CATEGORY_MAP[raw] ?? raw;
}

/**
 * Best available YES price, in whole cents.
 *
 * Prefers the midpoint of the book over last price: last price is whatever
 * happened to trade most recently, which on a thin market can be minutes stale
 * and several cents from what a member would actually pay now.
 *
 * Returns null when there is no price at all — a real market with no book yet,
 * which is worth recording as a market but has nothing honest to snapshot.
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

  const body = await readJson<{ maxEvents?: number }>(req);
  const started = Date.now();

  const { data: maxSetting } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'ingest_max_events')
    .maybeSingle();

  const maxEvents = body.maxEvents ?? Number(maxSetting?.value ?? 300);

  let events: KalshiEvent[];
  try {
    events = await listAllEventsWithMarkets('open', maxEvents);
  } catch (err) {
    // A rate limit is transient, not worth alarming on — the next tick in five
    // minutes picks up where this left off.
    const rateLimited = err instanceof KalshiError && err.status === 429;
    await logActivity(db, {
      type: rateLimited ? 'ingest.rate_limited' : 'ingest.failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      rateLimited ? 429 : 502,
    );
  }

  const marketRows: Record<string, unknown>[] = [];
  const snapshotRows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  let seen = 0;
  let skippedNoPrice = 0;
  let skippedShard = 0;

  for (const event of events) {
    const category = normalizeCategory(event);

    for (const m of event.markets ?? []) {
      if (!m.ticker) continue;
      seen++;

      // Multi-variate-event shards are synthetic legs with no book. They exist
      // in the API but nobody can trade them, so they would only ever dilute
      // the desk.
      if (m.mve_collection_ticker) {
        skippedShard++;
        continue;
      }

      marketRows.push({
        id: m.ticker,
        event_ticker: m.event_ticker ?? event.event_ticker,
        question: m.title ?? event.title ?? m.ticker,
        category,
        close_time: m.close_time ?? null,
        status: m.status ?? null,
        updated_at: now,
      });

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
  }

  // Markets first — snapshots carry an FK to them.
  const CHUNK = 500;
  for (let i = 0; i < marketRows.length; i += CHUNK) {
    const { error } = await db
      .from('markets')
      .upsert(marketRows.slice(i, i + CHUNK), { onConflict: 'id' });
    if (error) throw new Error(`market upsert failed: ${error.message}`);
  }

  for (let i = 0; i < snapshotRows.length; i += CHUNK) {
    const { error } = await db
      .from('market_snapshots')
      .upsert(snapshotRows.slice(i, i + CHUNK), { onConflict: 'market_id,ts' });
    if (error) throw new Error(`snapshot insert failed: ${error.message}`);
  }

  const result = {
    ok: true,
    events: events.length,
    marketsSeen: seen,
    markets: marketRows.length,
    snapshots: snapshotRows.length,
    skippedShard,
    skippedNoPrice,
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: 'ingest.completed',
    detail:
      `${result.snapshots} snapshots across ${result.markets} markets ` +
      `from ${result.events} events (${skippedShard} shards, ${skippedNoPrice} unpriced)`,
    metadata: result,
  });

  return json(result);
}));
