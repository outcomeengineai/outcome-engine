/**
 * News from RSS — scheduled every five minutes.
 *
 * Reads a curated set of outlet feeds (news_feeds), keeps each new item once
 * (news_items, by URL), then matches the last three days of items against
 * every market in a priced tier and writes the per-market news signal to
 * news_cache -- the same row the scoring pass reads. The scorer never
 * fetches upstream itself: that is what killed it with GDELT (one request
 * per five seconds, twelve seconds each, 800 markets a pass).
 *
 * SHADOW MODE. The live model carries a news weight of zero, so nothing
 * here moves a score. What it does is put a real news sub-score on every
 * thesis, which the fitted-weights job grades against outcomes. News earns
 * a weight the way every lever does: by being right, measured, first.
 */

import { handler, json, readJson, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { logActivity } from '../_shared/log.ts';
import { selectPaged } from '../_shared/batch.ts';
import { scoreSentiment } from '../_shared/news.ts';
import { marketTerms, matchesTerms, parseFeed, tokenSet, type FeedItem } from '../_shared/outcome-shared.mjs';

const FEED_TIMEOUT_MS = 8_000;
const FEED_CONCURRENCY = 5;
/** Items this recent count toward a market's signal (GDELT used 3 days). */
const WINDOW_HOURS = 72;
/** Raw items are kept this long; matched ones live on in news_articles. */
const ITEM_RETENTION_DAYS = 7;
/** An unchanged signal is re-stamped this often, inside the scorer's 45-minute cache TTL. */
const CACHE_REFRESH_MINUTES = 30;
/** Per-article rows are written only for items first seen this recently. */
const ARTICLE_WINDOW_HOURS = 24;

interface Feed { id: number; url: string; source: string }
interface ItemRow {
  id: number;
  feed_id: number | null;
  url: string;
  title: string;
  summary: string | null;
  source: string | null;
  published_at: string | null;
  first_seen_at: string;
}
interface CacheRow { market_id: string; volume: number; sentiment: number; coverage: number; fetched_at: string }

async function fetchFeed(feed: Feed): Promise<{ feed: Feed; items: FeedItem[]; error?: string }> {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'outcome-engine/0.1 (+rss reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!res.ok) return { feed, items: [], error: `HTTP ${res.status}` };
    const text = await res.text();
    const items = parseFeed(text);
    if (items.length === 0) return { feed, items, error: 'no items parsed' };
    return { feed, items };
  } catch (err) {
    return { feed, items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);
  const body = await readJson<{ dryRun?: boolean }>(req);
  const now = new Date();
  const nowIso = now.toISOString();

  // ---- 1. feeds -----------------------------------------------------------
  const { data: feedRows, error: feedErr } = await db.from('news_feeds').select('id, url, source').eq('active', true);
  if (feedErr) throw new Error(`feeds load failed: ${feedErr.message}`);
  const feeds = (feedRows ?? []) as Feed[];

  const results: Array<{ feed: Feed; items: FeedItem[]; error?: string }> = [];
  for (let i = 0; i < feeds.length; i += FEED_CONCURRENCY) {
    results.push(...(await Promise.all(feeds.slice(i, i + FEED_CONCURRENCY).map(fetchFeed))));
  }

  const itemRows: Record<string, unknown>[] = [];
  const seenUrl = new Set<string>();
  for (const r of results) {
    for (const it of r.items) {
      if (!it.url || seenUrl.has(it.url)) continue;
      seenUrl.add(it.url);
      itemRows.push({
        feed_id: r.feed.id,
        url: it.url,
        title: it.title,
        summary: it.summary || null,
        source: r.feed.source,
        published_at: it.publishedAt,
      });
    }
  }

  let newItems = 0;
  if (itemRows.length && !body.dryRun) {
    // Count what is genuinely new by asking which URLs already exist. One
    // query, then an insert that ignores the rest.
    const existing = new Set<string>();
    for (let i = 0; i < itemRows.length; i += 200) {
      const urls = itemRows.slice(i, i + 200).map((r) => r.url as string);
      const { data } = await db.from('news_items').select('url').in('url', urls);
      for (const row of (data ?? []) as Array<{ url: string }>) existing.add(row.url);
    }
    const fresh = itemRows.filter((r) => !existing.has(r.url as string));
    newItems = fresh.length;
    if (fresh.length) {
      const { error } = await db.from('news_items').upsert(fresh, { onConflict: 'url', ignoreDuplicates: true });
      if (error) console.warn('news_items write failed:', error.message);
    }
  }

  if (!body.dryRun) {
    for (const r of results) {
      await db
        .from('news_feeds')
        .update({ last_fetched_at: nowIso, last_status: r.error ?? 'ok', last_items: r.items.length })
        .eq('id', r.feed.id);
    }
  }

  // ---- 2. the corpus: the last three days of items -------------------------
  const since = new Date(now.getTime() - WINDOW_HOURS * 3600_000).toISOString();
  const items = await selectPaged<ItemRow>(
    (from, to) =>
      db
        .from('news_items')
        .select('id, feed_id, url, title, summary, source, published_at, first_seen_at')
        .gte('first_seen_at', since)
        .order('id')
        .range(from, to),
    { max: 20_000, label: 'news items' },
  );
  const corpus = items.map((it) => ({ item: it, tokens: tokenSet(`${it.title} ${it.summary ?? ''}`) }));

  // ---- 3. markets in a priced tier ----------------------------------------
  const markets = await selectPaged<{ id: string; question: string; category: string }>(
    (from, to) =>
      db
        .from('markets')
        .select('id, question, category')
        .in('cadence_tier', ['fast', 'slow'])
        .order('id')
        .range(from, to),
    { max: 20_000, label: 'tracked markets' },
  );

  // ---- 4. match and score ---------------------------------------------------
  const articleCutoff = now.getTime() - ARTICLE_WINDOW_HOURS * 3600_000;
  const signals = new Map<string, { query: string; volume: number; sentiment: number; coverage: number }>();
  const articleRows: Record<string, unknown>[] = [];
  let withNews = 0;

  for (const m of markets) {
    const terms = marketTerms(m.id, m.question ?? '', m.category ?? '');
    const matched = corpus.filter((c) => matchesTerms(c.tokens, terms));
    const query = terms.all.join(' ');

    if (matched.length === 0) {
      signals.set(m.id, { query, volume: 0, sentiment: 0, coverage: 0 });
      continue;
    }
    withNews++;
    const { sentiment, matched: withLean } = scoreSentiment(
      matched.map((c) => ({ title: c.item.title, description: c.item.summary ?? undefined })),
    );
    signals.set(m.id, {
      query,
      volume: matched.length,
      sentiment,
      coverage: withLean / matched.length,
    });

    for (const c of matched) {
      if (new Date(c.item.first_seen_at).getTime() < articleCutoff) continue;
      articleRows.push({
        market_id: m.id,
        url: c.item.url,
        title: c.item.title,
        source: c.item.source,
        published_at: c.item.published_at,
        matched_terms: terms.subject.length ? terms.subject : terms.all,
      });
    }
  }

  // ---- 5. write the cache, only where something changed --------------------
  const current = new Map<string, CacheRow>();
  const cacheRows = await selectPaged<CacheRow>(
    (from, to) =>
      db.from('news_cache').select('market_id, volume, sentiment, coverage, fetched_at').order('market_id').range(from, to),
    { max: 20_000, label: 'news cache' },
  );
  for (const r of cacheRows) current.set(r.market_id, r);

  const refreshBefore = now.getTime() - CACHE_REFRESH_MINUTES * 60_000;
  const writes: Record<string, unknown>[] = [];
  for (const [id, s] of signals) {
    const c = current.get(id);
    const changed =
      !c ||
      c.volume !== s.volume ||
      Math.abs(Number(c.sentiment) - s.sentiment) > 0.0005 ||
      Math.abs(Number(c.coverage) - s.coverage) > 0.0005 ||
      new Date(c.fetched_at).getTime() < refreshBefore;
    if (!changed) continue;
    writes.push({
      market_id: id,
      query: s.query,
      volume: s.volume,
      sentiment: Number(s.sentiment.toFixed(3)),
      coverage: Number(s.coverage.toFixed(3)),
      fetched_at: nowIso,
    });
  }

  if (!body.dryRun) {
    for (let i = 0; i < writes.length; i += 500) {
      const { error } = await db.from('news_cache').upsert(writes.slice(i, i + 500), { onConflict: 'market_id' });
      if (error) console.warn('news_cache write failed:', error.message);
    }
    // Append-only per-article record (Edge Signals v2 §5). ignoreDuplicates
    // without a target: the dedupe index is partial and PostgREST cannot
    // name it. See _shared/news.ts.
    for (let i = 0; i < articleRows.length; i += 500) {
      const { error } = await db.from('news_articles').upsert(articleRows.slice(i, i + 500), { ignoreDuplicates: true });
      if (error) console.warn('news_articles write failed:', error.message);
    }
    // ---- 6. retention ------------------------------------------------------
    const keepAfter = new Date(now.getTime() - ITEM_RETENTION_DAYS * 86_400_000).toISOString();
    await db.from('news_items').delete().lt('first_seen_at', keepAfter);
  }

  const failed = results.filter((r) => r.error).map((r) => `${r.feed.source}: ${r.error}`);
  const result = {
    ok: true,
    dryRun: !!body.dryRun,
    feeds: feeds.length,
    feedsFailed: failed.length,
    failed,
    newItems,
    corpus: items.length,
    markets: markets.length,
    withNews,
    cacheWrites: writes.length,
    articleRows: articleRows.length,
    ms: Date.now() - now.getTime(),
  };
  await logActivity(db, {
    type: failed.length === feeds.length && feeds.length > 0 ? 'news.failed' : 'news.fetched',
    detail: `${newItems} new items from ${feeds.length - failed.length}/${feeds.length} feeds; ${withNews} of ${markets.length} markets have news`,
    metadata: result,
  });
  return json(result);
}));
