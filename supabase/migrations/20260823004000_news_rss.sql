-- ===========================================================================
-- News from RSS, in shadow mode.
--
-- The news signal went on hold on 2026-09-11 because the only source
-- (GDELT) could not be queried per market at the pace scoring runs. This
-- replaces the per-market search with a feed reader: a curated set of
-- outlet feeds is polled every five minutes into news_items, and a
-- fetcher matches the last three days of items against every priced
-- market and writes news_cache -- the row the scorer already reads. The
-- scorer itself never calls a news provider again.
--
-- Shadow: the live model's news weight stays at zero. The hold is lifted
-- so the scorer READS the signal and records the raw news sub-score on
-- every thesis, which is what the fitted-weights job grades. If news
-- carries information the price does not, the fit shows it and news earns
-- a weight through a published version. If not, we know instead of guess.
-- ===========================================================================

create table public.news_feeds (
  id              bigserial primary key,
  url             text not null unique,
  source          text not null,
  /** Informational: what the feed mostly covers. Matching is by subject, not category. */
  category        text,
  active          boolean not null default true,
  last_fetched_at timestamptz,
  last_status     text,
  last_items      integer
);

create table public.news_items (
  id            bigserial primary key,
  feed_id       bigint references public.news_feeds(id) on delete set null,
  url           text not null unique,
  title         text not null,
  summary       text,
  source        text,
  published_at  timestamptz,
  /** When we first saw it. Never restated. */
  first_seen_at timestamptz not null default now()
);

create index news_items_seen_idx on public.news_items (first_seen_at);

alter table public.news_feeds enable row level security;
alter table public.news_items enable row level security;

create policy "news_feeds admin" on public.news_feeds
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Headlines are public; the platform's read of them is not sensitive.
create policy "news_items read" on public.news_items
  for select to authenticated using (true);

-- Outlets with stable, official feeds. A feed that stops answering shows
-- its status here and is skipped, never fatal. Add or pause rows freely.
insert into public.news_feeds (url, source, category) values
  ('https://feeds.bbci.co.uk/news/world/rss.xml',                        'BBC News',        'World'),
  ('https://feeds.bbci.co.uk/news/business/rss.xml',                     'BBC Business',    'Economics'),
  ('https://feeds.npr.org/1001/rss.xml',                                 'NPR News',        'World'),
  ('https://feeds.npr.org/1014/rss.xml',                                 'NPR Politics',    'Politics'),
  ('https://rss.politico.com/politics-news.xml',                         'Politico',        'Politics'),
  ('https://thehill.com/feed/',                                          'The Hill',        'Politics'),
  ('https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',          'NYT Politics',    'Politics'),
  ('https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',          'NYT',             'World'),
  ('https://www.theguardian.com/us-news/rss',                            'Guardian US',     'Politics'),
  ('https://www.theguardian.com/world/rss',                              'Guardian World',  'World'),
  ('https://www.cnbc.com/id/100003114/device/rss/rss.html',              'CNBC',            'Economics'),
  ('https://www.cnbc.com/id/20910258/device/rss/rss.html',               'CNBC Economy',    'Economics'),
  ('https://www.federalreserve.gov/feeds/press_all.xml',                 'Federal Reserve', 'Economics'),
  ('https://www.coindesk.com/arc/outboundfeeds/rss/',                    'CoinDesk',        'Crypto'),
  ('https://cointelegraph.com/rss',                                      'Cointelegraph',   'Crypto'),
  ('https://www.espn.com/espn/rss/news',                                 'ESPN',            'Sports'),
  ('https://www.espn.com/espn/rss/nfl/news',                             'ESPN NFL',        'Sports'),
  ('https://www.espn.com/espn/rss/nba/news',                             'ESPN NBA',        'Sports'),
  ('https://www.espn.com/espn/rss/mlb/news',                             'ESPN MLB',        'Sports'),
  ('https://sports.yahoo.com/rss/',                                      'Yahoo Sports',    'Sports'),
  ('https://techcrunch.com/feed/',                                       'TechCrunch',      'Science and Technology'),
  ('https://www.theverge.com/rss/index.xml',                             'The Verge',       'Science and Technology'),
  ('https://variety.com/feed/',                                          'Variety',         'Entertainment')
on conflict (url) do nothing;

-- Lift the hold. The scorer reads news_cache again; the weight is still
-- zero in v1.2, so no score moves. See the header.
update public.signal_health
   set status          = 'healthy',
       disabled_until  = null,
       disabled_reason = null,
       hold_reason     = null,
       computed_at     = now()
 where signal = 'news';

-- Offset from ingest (*/5) and scoring (1-56/5): fetched at :03, read by
-- the scoring pass at :06.
select cron.schedule(
  'oe-fetch-news', '3-58/5 * * * *',
  $cron$ select public.invoke_edge_function('fetch-news'); $cron$
);
