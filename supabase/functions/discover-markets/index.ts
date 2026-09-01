/**
 * Market discovery — scheduled, hourly.
 *
 * Split out from ingestion because the two jobs have opposite economics.
 * Discovery needs to see EVERYTHING (deep-paging the whole book, ~11s and 60
 * requests) but only needs to run occasionally. Pricing needs to run every few
 * minutes but only for markets worth pricing that often.
 *
 * Doing both in one job is what produced a platform that scored contracts
 * resolving in 2029: taking the first 300 events Kalshi returned covered 2.7%
 * of the book with a median horizon of 1,217 days, and missed 713 of the 718
 * weather markets outright.
 *
 * This job assigns every market a family and a cadence tier, and records each
 * transition so a backtest can reconstruct what the platform could see at any
 * past moment.
 */

import { handler, json, readJson, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import {
  dollarsToCents,
  fixedToInt,
  KalshiError,
  listEventsWithMarkets,
  type KalshiEvent,
  type KalshiMarket,
} from '../_shared/kalshi.ts';
import { logActivity } from '../_shared/log.ts';
import { forEachBatch, selectInBatches } from '../_shared/batch.ts';

/**
 * Pages of 200 events. Measured at ~185ms each with no throttling over a
 * 20-request burst, so a full sweep is ~11s. Capped rather than unbounded so a
 * pathological cursor cannot run the function to its wall-clock limit.
 */
const MAX_PAGES = 80;

type Family = 'standard' | 'multi_stage' | 'mve_shard';
type Tier = 'fast' | 'slow' | 'archive' | 'excluded';

interface Selection {
  fastHorizonDays: number;
  slowHorizonDays: number;
  maxSpreadCents: number;
  requireTwoSidedBook: boolean;
  fastCap: number;
  slowCap: number;
  archiveCap: number;
  anchorableCategories: string[];
  anchorRankBoost: number;
  multiStageMinLegs: number;
}

const DEFAULTS: Selection = {
  fastHorizonDays: 14,
  slowHorizonDays: 365,
  maxSpreadCents: 12,
  requireTwoSidedBook: true,
  fastCap: 800,
  slowCap: 2500,
  archiveCap: 5000,
  anchorableCategories: ['Weather', 'Economics'],
  anchorRankBoost: 0.25,
  multiStageMinLegs: 3,
};

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
 * Family classification, from fields Kalshi actually returns.
 *
 * `mve_collection_ticker` marks multi-variate-event shards — synthetic legs
 * with no order book that nobody can trade.
 *
 * `mutually_exclusive` on the EVENT plus several legs is the outright/bracket
 * shape: "Who will the next Pope be?", "Next DNC Chair". Verified against the
 * live API that shards never carry it, so the two never collide.
 */
function classifyFamily(event: KalshiEvent, market: KalshiMarket, sel: Selection): Family {
  if (market.mve_collection_ticker) return 'mve_shard';
  const legs = event.markets?.length ?? 0;
  if ((event as { mutually_exclusive?: boolean }).mutually_exclusive && legs >= sel.multiStageMinLegs) {
    return 'multi_stage';
  }
  return 'standard';
}

function daysUntil(closeTime: string | undefined): number | null {
  if (!closeTime) return null;
  const ms = new Date(closeTime).getTime() - Date.now();
  return Number.isFinite(ms) ? ms / 86_400_000 : null;
}

interface Candidate {
  id: string;
  eventTicker: string;
  question: string;
  category: string;
  closeTime: string | null;
  status: string | null;
  family: Family;
  anchorable: boolean;
  horizonDays: number | null;
  spread: number;
  volume: number;
  twoSided: boolean;
  rank: number;
  tier: Tier;
  reason: string;
}

/**
 * Provisional tier from the market's own properties, before caps are applied.
 *
 * Horizon drives it, because horizon is what determines whether a market can
 * move on a timescale the platform can observe. Book quality gates the FAST
 * tier only: a wide-spread market is still worth tracking hourly, it is just
 * not worth polling every five minutes.
 */
function provisionalTier(c: Omit<Candidate, 'tier' | 'reason' | 'rank'>, sel: Selection): {
  tier: Tier;
  reason: string;
} {
  if (c.family === 'mve_shard') return { tier: 'excluded', reason: 'mve shard, no order book' };
  if (c.horizonDays === null) return { tier: 'slow', reason: 'no close time' };
  if (c.horizonDays < 0) return { tier: 'excluded', reason: 'past close' };

  if (c.horizonDays <= sel.fastHorizonDays) {
    if (sel.requireTwoSidedBook && !c.twoSided) {
      return { tier: 'slow', reason: `near-dated but no two-sided book` };
    }
    if (c.spread > sel.maxSpreadCents) {
      return { tier: 'slow', reason: `near-dated but ${c.spread}c spread` };
    }
    return { tier: 'fast', reason: `closes in ${c.horizonDays.toFixed(1)}d` };
  }

  if (c.horizonDays <= sel.slowHorizonDays) {
    return { tier: 'slow', reason: `closes in ${Math.round(c.horizonDays)}d` };
  }
  return { tier: 'archive', reason: `closes in ${Math.round(c.horizonDays)}d` };
}

/**
 * Rank for cap application: liquidity, with a boost for categories that have
 * an external anchor.
 *
 * Anchorable markets can be scored on more than price movement, so when a cap
 * forces a choice they are worth more than a marginally more liquid market
 * the model can only guess at.
 */
function rankOf(c: Omit<Candidate, 'tier' | 'reason' | 'rank'>, sel: Selection): number {
  const liquidity = Math.log10(Math.max(1, c.volume));
  const boost = c.anchorable ? sel.anchorRankBoost * 10 : 0;
  return liquidity + boost;
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);
  const started = Date.now();
  const body = await readJson<{ maxPages?: number }>(req);

  // Selection lives on the stable model version, per section 7.
  const { data: versionId } = await db.rpc('current_stable_version');
  const { data: version } = versionId
    ? await db.from('model_versions').select('thresholds').eq('id', versionId).maybeSingle()
    : { data: null };

  const sel: Selection = {
    ...DEFAULTS,
    ...((version?.thresholds as { selection?: Partial<Selection> })?.selection ?? {}),
  };

  // ---- 1. sweep the whole book -------------------------------------------
  const events: KalshiEvent[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = Math.min(body.maxPages ?? MAX_PAGES, MAX_PAGES);

  try {
    while (pages < maxPages) {
      const page = await listEventsWithMarkets({ status: 'open', limit: 200, cursor });
      const batch = page.events ?? [];
      events.push(...batch);
      cursor = page.cursor;
      pages++;
      if (!cursor || batch.length === 0) break;
    }
  } catch (err) {
    const rateLimited = err instanceof KalshiError && err.status === 429;
    await logActivity(db, {
      type: rateLimited ? 'discovery.rate_limited' : 'discovery.failed',
      detail: `after ${pages} pages: ${err instanceof Error ? err.message : String(err)}`,
    });
    // Partial sweeps are usable — tier what we saw rather than discarding it.
    if (events.length === 0) {
      return json({ ok: false, error: 'discovery failed before any page returned' }, 502);
    }
  }

  // ---- 2. classify ---------------------------------------------------------
  const candidates: Candidate[] = [];

  for (const event of events) {
    const category = normalizeCategory(event);
    const anchorable = sel.anchorableCategories.includes(category);

    for (const m of event.markets ?? []) {
      if (!m.ticker) continue;

      const bid = dollarsToCents(m.yes_bid_dollars);
      const ask = dollarsToCents(m.yes_ask_dollars);
      const base = {
        id: m.ticker,
        eventTicker: m.event_ticker ?? event.event_ticker,
        question: m.title ?? event.title ?? m.ticker,
        category,
        closeTime: m.close_time ?? null,
        status: m.status ?? null,
        family: classifyFamily(event, m, sel),
        anchorable,
        horizonDays: daysUntil(m.close_time),
        spread: bid > 0 && ask > 0 ? Math.max(0, ask - bid) : 100,
        volume: fixedToInt(m.volume_fp),
        twoSided: bid > 0 && ask > 0,
      };

      const { tier, reason } = provisionalTier(base, sel);
      candidates.push({ ...base, tier, reason, rank: rankOf(base, sel) });
    }
  }

  // ---- 3. apply caps -------------------------------------------------------
  // Within each tier, keep the highest-ranked up to its cap and demote the
  // rest one tier down. Demotion rather than exclusion: a market that loses a
  // fast slot is still worth hourly tracking, and its history still
  // accumulates for when it becomes near-dated.
  const caps: Record<Tier, number> = {
    fast: sel.fastCap,
    slow: sel.slowCap,
    archive: sel.archiveCap,
    excluded: Number.MAX_SAFE_INTEGER,
  };
  const demoteTo: Record<string, Tier> = { fast: 'slow', slow: 'archive', archive: 'excluded' };

  for (const tier of ['fast', 'slow', 'archive'] as const) {
    const inTier = candidates.filter((c) => c.tier === tier).sort((a, b) => b.rank - a.rank);
    for (const c of inTier.slice(caps[tier])) {
      c.tier = demoteTo[tier]!;
      c.reason = `${tier} cap of ${caps[tier]} reached`;
    }
  }

  // ---- 4. persist ----------------------------------------------------------
  const now = new Date().toISOString();
  const CHUNK = 500;

  for (let i = 0; i < candidates.length; i += CHUNK) {
    const { error } = await db.from('markets').upsert(
      candidates.slice(i, i + CHUNK).map((c) => ({
        id: c.id,
        event_ticker: c.eventTicker,
        question: c.question,
        category: c.category,
        close_time: c.closeTime,
        status: c.status,
        family: c.family,
        cadence_tier: c.tier,
        tier_reason: c.reason,
        anchorable: c.anchorable,
        updated_at: now,
      })),
      { onConflict: 'id' },
    );
    if (error) throw new Error(`market upsert failed: ${error.message}`);
  }

  // ---- 5. record membership transitions ------------------------------------
  // Point-in-time (section 11e): a market leaving a tier CLOSES its row rather
  // than being deleted, so a backtest can ask what was visible, and why, at
  // any past moment.
  const open = await selectInBatches<{ id: number; market_id: string; tier: Tier }>(
    candidates.map((c) => c.id),
    (batch) =>
      db
        .from('universe_membership')
        .select('id, market_id, tier')
        .is('left_at', null)
        .in('market_id', batch),
    { label: 'open membership' },
  );

  const currentTier = new Map(open.map((r) => [r.market_id, r.tier]));
  const changed = candidates.filter((c) => currentTier.get(c.id) !== c.tier);

  const closing = changed.filter((c) => currentTier.has(c.id)).map((c) => c.id);
  const closeResult = await forEachBatch(closing, (batch) =>
    db.from('universe_membership').update({ left_at: now }).is('left_at', null).in('market_id', batch));
  if (closeResult.error) console.warn('membership close failed:', closeResult.error);

  for (let i = 0; i < changed.length; i += CHUNK) {
    const { error } = await db.from('universe_membership').insert(
      changed.slice(i, i + CHUNK).map((c) => ({
        market_id: c.id,
        tier: c.tier,
        family: c.family,
        reason: c.reason,
        rank_score: Number(c.rank.toFixed(3)),
        entered_at: now,
      })),
    );
    if (error) {
      console.error('membership insert failed:', error.message);
      break;
    }
  }

  const byTier = (t: Tier) => candidates.filter((c) => c.tier === t).length;
  const byFamily = (f: Family) => candidates.filter((c) => c.family === f).length;

  const result = {
    ok: true,
    pages,
    events: events.length,
    markets: candidates.length,
    tiers: { fast: byTier('fast'), slow: byTier('slow'), archive: byTier('archive'), excluded: byTier('excluded') },
    families: { standard: byFamily('standard'), multi_stage: byFamily('multi_stage'), mve_shard: byFamily('mve_shard') },
    anchorable: candidates.filter((c) => c.anchorable && c.tier !== 'excluded').length,
    transitions: changed.length,
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: 'discovery.completed',
    detail:
      `${result.markets} markets from ${result.events} events — ` +
      `fast ${result.tiers.fast}, slow ${result.tiers.slow}, archive ${result.tiers.archive}, ` +
      `${result.transitions} tier changes`,
    metadata: result,
  });

  return json(result);
}));
