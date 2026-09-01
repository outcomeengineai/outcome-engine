/**
 * Market discovery — scheduled, chunked.
 *
 * Sees the whole Kalshi book and records what each market IS, so that tier
 * assignment (which decides what gets priced, and how often) has the full
 * field to work from.
 *
 * CHUNKED, because the first version was not. It paged the entire book into an
 * array and then classified it: 235 MB of JSON and ~110,000 market objects
 * held at once, against a 256 MB worker limit. It died with
 * WORKER_RESOURCE_LIMIT before writing a single row. Wall clock was never the
 * problem (~10s for the whole sweep) — retention was.
 *
 * So this never holds more than one page. Each page is projected to compact
 * rows, written, and dropped. A cursor persists between invocations, so a
 * sweep spans several runs and resumes exactly where it stopped — restarting
 * would re-page the head of the book forever and never reach the tail.
 *
 * Ranking and caps deliberately live in SQL (assign_cadence_tiers). Choosing
 * the top N of 110,000 markets is a sort; doing it here would mean holding
 * every candidate in memory purely to order them, which is the bug above.
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

type Family = 'standard' | 'multi_stage' | 'mve_shard';

/**
 * Pages per invocation.
 *
 * Peak memory is one page (~3 MB of JSON), since each is released before the
 * next is fetched. Ten leaves a wide margin under the worker limit and
 * finishes a full ~80-page sweep in eight runs — under 40 minutes at the
 * 5-minute cadence.
 */
const PAGES_PER_RUN = 10;

/** Safety stop: a cursor that never terminates must not sweep forever. */
const MAX_SWEEP_PAGES = 150;

interface Selection {
  anchorableCategories: string[];
  multiStageMinLegs: number;
}

const DEFAULTS: Selection = {
  anchorableCategories: ['Weather', 'Economics'],
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

interface State {
  cursor: string | null;
  pages_done: number;
  markets_seen: number;
  sweep_started_at: string | null;
}

const EMPTY_STATE: State = {
  cursor: null,
  pages_done: 0,
  markets_seen: 0,
  sweep_started_at: null,
};

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);
  const started = Date.now();
  const body = await readJson<{ pages?: number; restart?: boolean }>(req);

  // Selection lives on the stable model version, per section 7. Discovery
  // reads only the two knobs describing what a market IS; the ones deciding
  // what gets priced are read by assign_cadence_tiers, in SQL.
  const { data: versionId } = await db.rpc('current_stable_version');
  const { data: version } = versionId
    ? await db.from('model_versions').select('thresholds').eq('id', versionId).maybeSingle()
    : { data: null };

  const sel: Selection = {
    ...DEFAULTS,
    ...((version?.thresholds as { selection?: Partial<Selection> })?.selection ?? {}),
  };
  const anchorableCats = new Set(sel.anchorableCategories);

  // ---- resume where the last run stopped ---------------------------------
  const { data: stateRow } = await db
    .from('discovery_state')
    .select('cursor, pages_done, markets_seen, sweep_started_at')
    .eq('id', true)
    .maybeSingle();

  const state: State = body.restart ? EMPTY_STATE : ((stateRow as State | null) ?? EMPTY_STATE);

  const sweepStartedAt = state.sweep_started_at ?? new Date().toISOString();
  const pagesThisRun = Math.min(body.pages ?? PAGES_PER_RUN, PAGES_PER_RUN);

  let cursor = state.cursor ?? undefined;
  let pagesDone = state.pages_done;
  let marketsSeen = state.markets_seen;
  let pagesRun = 0;
  let wrote = 0;
  let sweepComplete = false;

  // ---- page, project, write, drop ----------------------------------------
  try {
    while (pagesRun < pagesThisRun) {
      const page = await listEventsWithMarkets({ status: 'open', limit: 200, cursor });
      const events = page.events ?? [];
      pagesRun++;
      pagesDone++;

      const now = new Date().toISOString();
      const rows: Record<string, unknown>[] = [];

      for (const event of events) {
        const category = normalizeCategory(event);
        const isAnchorable = anchorableCats.has(category);

        for (const m of event.markets ?? []) {
          if (!m.ticker) continue;

          const bid = dollarsToCents(m.yes_bid_dollars);
          const ask = dollarsToCents(m.yes_ask_dollars);
          const twoSided = bid > 0 && ask > 0;

          rows.push({
            id: m.ticker,
            event_ticker: m.event_ticker ?? event.event_ticker ?? null,
            question: (m.title ?? '').trim() || event.title || m.ticker,
            category,
            close_time: m.close_time ?? null,
            status: m.status ?? null,
            family: classifyFamily(event, m, sel),
            anchorable: isAnchorable,
            disc_volume: fixedToInt(m.volume_fp),
            disc_spread: twoSided ? Math.max(0, ask - bid) : 100,
            disc_two_sided: twoSided,
            disc_seen_at: now,
            updated_at: now,
          });
        }
      }

      marketsSeen += rows.length;

      // Write this page before fetching the next, so nothing accumulates.
      // cadence_tier is deliberately NOT in the payload: an upsert must never
      // reset a tier that assign_cadence_tiers already decided.
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { error } = await db.from('markets').upsert(slice, { onConflict: 'id' });
        if (error) throw new Error(`market upsert failed: ${error.message}`);
        wrote += slice.length;
      }

      cursor = page.cursor;
      if (!cursor || events.length === 0 || pagesDone >= MAX_SWEEP_PAGES) {
        sweepComplete = true;
        break;
      }
    }
  } catch (err) {
    const rateLimited = err instanceof KalshiError && err.status === 429;

    // Persist progress even on failure, so the next run resumes rather than
    // starting the sweep over.
    await db.from('discovery_state').update({
      cursor: cursor ?? null,
      pages_done: pagesDone,
      markets_seen: marketsSeen,
      sweep_started_at: sweepStartedAt,
    }).eq('id', true);

    await logActivity(db, {
      type: rateLimited ? 'discovery.rate_limited' : 'discovery.failed',
      detail: `after ${pagesDone} pages: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { pages_done: pagesDone, markets_seen: marketsSeen },
    });

    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err), pagesDone, marketsSeen },
      rateLimited ? 429 : 502,
    );
  }

  // ---- assign tiers, but only on a COMPLETE sweep ------------------------
  // Assigning from a partial sweep would apply caps to whatever fraction of
  // the book happened to be visible, so a market's tier would depend on which
  // page it landed on. Caps are only meaningful against the whole field.
  let assignment: unknown = null;

  if (sweepComplete) {
    const { data, error } = await db.rpc('assign_cadence_tiers');
    if (error) throw new Error(`tier assignment failed: ${error.message}`);
    assignment = data;

    await db.from('discovery_state').update({
      cursor: null,
      pages_done: 0,
      markets_seen: 0,
      sweep_started_at: null,
      last_completed_at: new Date().toISOString(),
      last_sweep_pages: pagesDone,
      last_sweep_markets: marketsSeen,
    }).eq('id', true);
  } else {
    await db.from('discovery_state').update({
      cursor: cursor ?? null,
      pages_done: pagesDone,
      markets_seen: marketsSeen,
      sweep_started_at: sweepStartedAt,
    }).eq('id', true);
  }

  const result = {
    ok: true,
    pagesThisRun: pagesRun,
    pagesDone,
    marketsThisRun: wrote,
    marketsSeen,
    sweepComplete,
    assignment,
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: sweepComplete ? 'discovery.sweep_completed' : 'discovery.progress',
    detail: sweepComplete
      ? `sweep complete: ${pagesDone} pages, ${marketsSeen} markets, tiers ${JSON.stringify(assignment)}`
      : `${pagesRun} pages this run (${pagesDone} so far, ${marketsSeen} markets)`,
    metadata: result,
  });

  return json(result);
}));
