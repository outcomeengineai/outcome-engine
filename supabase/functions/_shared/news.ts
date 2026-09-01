/**
 * News signal input.
 *
 * Fetched per MARKET and cached, never per user — twenty members looking at
 * the same market must not become twenty news API calls. GDELT is the default
 * because it needs no key and has no hard quota; NewsAPI is supported for a
 * cleaner corpus when a key is available.
 *
 * What this produces is deliberately crude: a volume figure and a sentiment
 * lean in [-1, 1]. It is a directional confirmation signal, not a language
 * model, and the weighting in model v1 reflects that.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { optional } from './env.ts';

export interface NewsSignal {
  /** Article count in the lookback window. */
  volume: number;
  /** -1 (strongly favours NO) .. +1 (strongly favours YES). */
  sentiment: number;
  /** 0..1 — how much of the corpus actually matched the market's terms. */
  coverage: number;
  fetchedAt: string;
}

const NEUTRAL: NewsSignal = {
  volume: 0,
  sentiment: 0,
  coverage: 0,
  fetchedAt: new Date(0).toISOString(),
};

/** How stale a cached news signal may be before it is refetched. */
const CACHE_TTL_MINUTES = 45;

/**
 * Reduce a market question to searchable terms. Question text is long and
 * full of scaffolding ("Will ... by ...?"), so strip the scaffolding and keep
 * the proper nouns and numbers that actually identify the subject.
 */
export function keywordsFor(question: string, category: string): string {
  const stop = new Set([
    'will', 'the', 'a', 'an', 'be', 'is', 'are', 'to', 'of', 'in', 'on', 'at',
    'by', 'for', 'and', 'or', 'above', 'below', 'before', 'after', 'than',
    'this', 'that', 'it', 'its', 'come', 'more', 'less', 'least', 'most',
    'any', 'have', 'has', 'do', 'does', 'if', 'when', 'what', 'which',
  ]);
  const words = question
    .replace(/[?"'`.,;:!()\[\]]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w.toLowerCase()));

  // Capitalised words and numbers carry the identity of the market.
  const salient = words.filter((w) => /^[A-Z]/.test(w) || /\d/.test(w));
  const chosen = (salient.length >= 2 ? salient : words).slice(0, 6);
  return chosen.length ? chosen.join(' ') : category;
}

// --------------------------------------------------------------------------
// Providers
// --------------------------------------------------------------------------

interface Article {
  title: string;
  description?: string;
  seendate?: string;
  tone?: number;
}

async function fetchGdelt(query: string): Promise<Article[]> {
  const url =
    'https://api.gdeltproject.org/api/v2/doc/doc' +
    `?query=${encodeURIComponent(query)}` +
    '&mode=artlist&format=json&maxrecords=50&timespan=3d&sort=datedesc';

  const res = await fetch(url, {
    headers: { 'User-Agent': 'outcome-engine/0.1' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GDELT ${res.status}`);

  // GDELT occasionally answers 200 with an HTML error page.
  const text = await res.text();
  if (!text.trim().startsWith('{')) return [];

  const body = JSON.parse(text) as { articles?: Array<{ title: string; seendate?: string }> };
  return (body.articles ?? []).map((a) => ({ title: a.title, seendate: a.seendate }));
}

async function fetchNewsApi(query: string, key: string): Promise<Article[]> {
  const from = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
  const url =
    'https://newsapi.org/v2/everything' +
    `?q=${encodeURIComponent(query)}&from=${from}` +
    '&language=en&sortBy=publishedAt&pageSize=50';

  const res = await fetch(url, {
    headers: { 'X-Api-Key': key },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`NewsAPI ${res.status}`);

  const body = await res.json() as {
    articles?: Array<{ title: string; description?: string }>;
  };
  return (body.articles ?? []).map((a) => ({
    title: a.title,
    description: a.description ?? undefined,
  }));
}

// --------------------------------------------------------------------------
// Sentiment
// --------------------------------------------------------------------------

const POSITIVE = [
  'rise', 'rises', 'rising', 'surge', 'surges', 'gain', 'gains', 'up',
  'higher', 'beat', 'beats', 'exceed', 'exceeds', 'approve', 'approved',
  'confirm', 'confirms', 'confirmed', 'likely', 'expected', 'boost', 'strong',
  'wins', 'win', 'advance', 'advances', 'record', 'accelerate',
];

const NEGATIVE = [
  'fall', 'falls', 'falling', 'drop', 'drops', 'plunge', 'plunges', 'down',
  'lower', 'miss', 'misses', 'reject', 'rejected', 'deny', 'denies', 'denied',
  'unlikely', 'delay', 'delayed', 'weak', 'loses', 'lose', 'retreat',
  'cut', 'cuts', 'slow', 'slows', 'stall', 'stalls',
];

/**
 * Count directional words across headlines and normalise to [-1, 1].
 *
 * Lexicon matching is blunt and will misread sarcasm, negation and headlines
 * about the opposite side of a market. It earns its place only because the
 * news weight is low and because the divergence auto-tag flags the cases where
 * this disagrees loudly with price — which is precisely where a human should
 * look rather than trust the number.
 */
export function scoreSentiment(articles: Article[]): { sentiment: number; matched: number } {
  let pos = 0;
  let neg = 0;
  let matched = 0;

  for (const a of articles) {
    const text = `${a.title} ${a.description ?? ''}`.toLowerCase();
    let hit = false;
    for (const w of POSITIVE) {
      if (text.includes(w)) { pos++; hit = true; }
    }
    for (const w of NEGATIVE) {
      if (text.includes(w)) { neg++; hit = true; }
    }
    if (hit) matched++;
  }

  const total = pos + neg;
  return { sentiment: total === 0 ? 0 : (pos - neg) / total, matched };
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

/**
 * News signals for a whole scoring pass.
 *
 * Three rules, learned the hard way — the naive per-market version killed the
 * scoring function outright (no response at all, request timed out):
 *
 *   1. Read the cache for every market in ONE batched query, not one per
 *      market. 400 round trips to Postgres is already too many.
 *   2. Only fetch upstream for a BUDGETED number of cache misses per pass.
 *      The rest get a neutral signal now and real data on a later tick — a
 *      slightly stale news weight is worth far more than a scoring pass that
 *      never completes.
 *   3. Fetch those concurrently, each with its own timeout, so one slow
 *      provider response cannot stall the pass.
 *
 * With a 60-market budget every five minutes, a cold cache of 400 markets is
 * fully warm inside ~35 minutes, comfortably within the cache TTL.
 */

/** Cache misses to resolve upstream per pass. */
const FETCH_BUDGET = 60;

/** Concurrent upstream requests. */
const CONCURRENCY = 6;

/** Per-request timeout. GDELT is occasionally very slow. */
const REQUEST_TIMEOUT_MS = 4000;

export const NEUTRAL_NEWS: NewsSignal = NEUTRAL;

export async function newsSignalsFor(
  db: SupabaseClient,
  markets: ReadonlyArray<{ id: string; question: string; category: string }>,
): Promise<{ signals: Map<string, NewsSignal>; fetched: number; cached: number }> {
  const signals = new Map<string, NewsSignal>();
  if (markets.length === 0) return { signals, fetched: 0, cached: 0 };

  // ---- 1. one batched cache read ----------------------------------------
  const cutoff = new Date(Date.now() - CACHE_TTL_MINUTES * 60_000).toISOString();
  const ids = markets.map((m) => m.id);
  const CHUNK = 100;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await db
      .from('news_cache')
      .select('market_id, volume, sentiment, coverage, fetched_at')
      .in('market_id', ids.slice(i, i + CHUNK))
      .gte('fetched_at', cutoff);

    for (const row of (data ?? []) as Array<{
      market_id: string;
      volume: number;
      sentiment: number;
      coverage: number;
      fetched_at: string;
    }>) {
      signals.set(row.market_id, {
        volume: row.volume,
        sentiment: Number(row.sentiment),
        coverage: Number(row.coverage),
        fetchedAt: row.fetched_at,
      });
    }
  }

  const cached = signals.size;

  // ---- 2. budgeted upstream fetches --------------------------------------
  const provider = optional('NEWS_PROVIDER', 'gdelt').toLowerCase();
  if (provider === 'none') {
    for (const m of markets) if (!signals.has(m.id)) signals.set(m.id, NEUTRAL);
    return { signals, fetched: 0, cached };
  }

  const misses = markets.filter((m) => !signals.has(m.id)).slice(0, FETCH_BUDGET);
  const rows: Record<string, unknown>[] = [];
  let fetched = 0;

  // ---- 3. concurrently, with a timeout each ------------------------------
  for (let i = 0; i < misses.length; i += CONCURRENCY) {
    const slice = misses.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(async (m) => {
      const query = keywordsFor(m.question, m.category);
      try {
        const articles = provider === 'newsapi'
          ? await fetchNewsApi(query, optional('NEWSAPI_KEY'))
          : await fetchGdelt(query);
        const { sentiment, matched } = scoreSentiment(articles);
        return {
          id: m.id,
          query,
          signal: {
            volume: articles.length,
            sentiment,
            coverage: articles.length === 0 ? 0 : matched / articles.length,
            fetchedAt: new Date().toISOString(),
          } as NewsSignal,
        };
      } catch {
        // A provider failure degrades this market to neutral for this pass.
        // It must never fail the scoring run.
        return null;
      }
    }));

    for (const r of results) {
      if (!r) continue;
      signals.set(r.id, r.signal);
      rows.push({
        market_id: r.id,
        query: r.query,
        volume: r.signal.volume,
        sentiment: r.signal.sentiment,
        coverage: r.signal.coverage,
        fetched_at: r.signal.fetchedAt,
      });
      fetched++;
    }
  }

  if (rows.length) {
    const { error } = await db.from('news_cache').upsert(rows, { onConflict: 'market_id' });
    if (error) console.warn('news cache write failed:', error.message);
  }

  // Anything still unresolved scores neutral this pass, not zero: no news is
  // not evidence against a side.
  for (const m of markets) if (!signals.has(m.id)) signals.set(m.id, NEUTRAL);

  return { signals, fetched, cached };
}
