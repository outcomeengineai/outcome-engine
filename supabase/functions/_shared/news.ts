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

/** In-memory cache for the life of one function invocation. */
const memo = new Map<string, NewsSignal>();

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

  const res = await fetch(url, { headers: { 'User-Agent': 'outcome-engine/0.1' } });
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

  const res = await fetch(url, { headers: { 'X-Api-Key': key } });
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
 * Fetch (or reuse) the news signal for one market.
 *
 * Cached in `news_cache` so a scoring pass over 400 markets costs at most 400
 * upstream calls per TTL window, and usually far fewer. Any provider failure
 * degrades to a neutral signal rather than failing the scoring pass — a market
 * with no news should score on its other signals, not vanish.
 */
export async function newsSignalFor(
  db: SupabaseClient,
  market: { id: string; question: string; category: string },
): Promise<NewsSignal> {
  const cached = memo.get(market.id);
  if (cached) return cached;

  const cutoff = new Date(Date.now() - CACHE_TTL_MINUTES * 60_000).toISOString();
  const { data: row } = await db
    .from('news_cache')
    .select('volume, sentiment, coverage, fetched_at')
    .eq('market_id', market.id)
    .gte('fetched_at', cutoff)
    .maybeSingle();

  if (row) {
    const signal: NewsSignal = {
      volume: row.volume,
      sentiment: Number(row.sentiment),
      coverage: Number(row.coverage),
      fetchedAt: row.fetched_at,
    };
    memo.set(market.id, signal);
    return signal;
  }

  const provider = optional('NEWS_PROVIDER', 'gdelt').toLowerCase();
  const query = keywordsFor(market.question, market.category);

  let articles: Article[] = [];
  try {
    if (provider === 'newsapi') {
      const key = optional('NEWSAPI_KEY');
      if (!key) throw new Error('NEWS_PROVIDER=newsapi but NEWSAPI_KEY is unset');
      articles = await fetchNewsApi(query, key);
    } else if (provider === 'gdelt') {
      articles = await fetchGdelt(query);
    } else {
      memo.set(market.id, NEUTRAL);
      return NEUTRAL;
    }
  } catch (err) {
    console.warn(`news fetch failed for ${market.id}:`, err instanceof Error ? err.message : err);
    memo.set(market.id, NEUTRAL);
    return NEUTRAL;
  }

  const { sentiment, matched } = scoreSentiment(articles);
  const signal: NewsSignal = {
    volume: articles.length,
    sentiment,
    coverage: articles.length === 0 ? 0 : matched / articles.length,
    fetchedAt: new Date().toISOString(),
  };

  await db.from('news_cache').upsert({
    market_id: market.id,
    query,
    volume: signal.volume,
    sentiment: signal.sentiment,
    coverage: signal.coverage,
    fetched_at: signal.fetchedAt,
  });

  memo.set(market.id, signal);
  return signal;
}
