/**
 * Market ingestion — scheduled, every 5 minutes.
 *
 * Polls Kalshi's PUBLIC market endpoints, so it uses no credentials at all and
 * costs nothing against any member's rate limit. Every user's view fans out
 * from these shared rows; nothing here is per-user, and it must stay that way
 * or twenty members become twenty times the API load for identical data.
 *
 * Writes markets + market_snapshots. Scoring runs separately, a minute behind.
 */

import { handler, json, readJson, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { KalshiError, listAllMarkets, type KalshiMarket } from '../_shared/kalshi.ts';
import { logActivity } from '../_shared/log.ts';

/**
 * Kalshi's category field is inconsistent and sometimes absent. Normalise to
 * the small set the strategy screen offers per-category weight overrides for,
 * because an override keyed to a category string that never appears is an
 * override that silently does nothing.
 */
function normalizeCategory(m: KalshiMarket): string {
  const raw = (m.category ?? '').trim();
  const t = `${raw} ${m.title ?? ''}`.toLowerCase();

  if (/\b(fed|cpi|inflation|gdp|jobs|unemployment|rate|economic)/.test(t)) return 'Economics';
  if (/\b(election|senate|congress|president|poll|nomin|politic)/.test(t)) return 'Politics';
  if (/\b(temperature|rain|snow|hurricane|weather|degrees)/.test(t)) return 'Weather';
  if (/\b(bitcoin|ethereum|crypto|nasdaq|s&p|stock|index)/.test(t)) return 'Financials';
  if (/\b(oscar|grammy|box office|award|rotten tomatoes)/.test(t)) return 'Entertainment';
  if (/\b(nfl|nba|mlb|soccer|match|game|championship)/.test(t)) return 'Sports';

  return raw || 'Other';
}

/**
 * Best available YES price in cents.
 *
 * Prefer the midpoint of the book over last_price: last_price is whatever
 * happened to trade most recently, which on a thin market can be minutes stale
 * and several cents off what a member would actually pay right now.
 */
function yesPriceCents(m: KalshiMarket): number | null {
  const bid = m.yes_bid ?? 0;
  const ask = m.yes_ask ?? 0;
  if (bid > 0 && ask > 0) return Math.round((bid + ask) / 2);
  if (m.last_price && m.last_price > 0) return m.last_price;
  if (bid > 0) return bid;
  if (ask > 0) return ask;
  return null;
}

function spreadCents(m: KalshiMarket): number {
  const bid = m.yes_bid ?? 0;
  const ask = m.yes_ask ?? 0;
  return bid > 0 && ask > 0 ? Math.max(0, ask - bid) : 100;
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);

  const body = await readJson<{ maxMarkets?: number }>(req);
  const started = Date.now();

  const { data: maxSetting } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'ingest_max_markets')
    .maybeSingle();

  const max = body.maxMarkets ?? Number(maxSetting?.value ?? 400);

  let markets: KalshiMarket[];
  try {
    markets = await listAllMarkets('open', max);
  } catch (err) {
    // A rate limit is a transient condition, not a failure worth alarming on —
    // the next tick in five minutes will pick up where this left off.
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
  let skippedNoPrice = 0;

  for (const m of markets) {
    if (!m.ticker) continue;

    marketRows.push({
      id: m.ticker,
      event_ticker: m.event_ticker ?? null,
      question: m.title ?? m.ticker,
      category: normalizeCategory(m),
      close_time: m.close_time ?? null,
      status: m.status ?? null,
      updated_at: now,
    });

    const price = yesPriceCents(m);
    if (price === null) {
      // A market with no two-sided book yet is real, but there is nothing
      // honest to snapshot. Record the market, skip the price row.
      skippedNoPrice++;
      continue;
    }

    snapshotRows.push({
      market_id: m.ticker,
      ts: now,
      price,
      volume: m.volume ?? 0,
      spread: spreadCents(m),
      open_interest: m.open_interest ?? 0,
      liquidity: m.liquidity ?? 0,
    });
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
    fetched: markets.length,
    markets: marketRows.length,
    snapshots: snapshotRows.length,
    skippedNoPrice,
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: 'ingest.completed',
    detail: `${result.snapshots} snapshots across ${result.markets} markets`,
    metadata: result,
  });

  return json(result);
}));
