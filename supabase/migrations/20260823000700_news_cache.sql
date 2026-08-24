-- ===========================================================================
-- News signal cache.
--
-- Keyed by market, not by user: the news for "Will the Fed cut in September?"
-- is the same news for all twenty members, and fetching it per viewer would
-- burn a NewsAPI quota in an afternoon.
-- ===========================================================================

create table public.news_cache (
  market_id  text primary key references public.markets(id) on delete cascade,
  query      text not null,
  volume     integer not null default 0,
  sentiment  numeric(4,3) not null default 0 check (sentiment between -1 and 1),
  coverage   numeric(4,3) not null default 0 check (coverage between 0 and 1),
  fetched_at timestamptz not null default now()
);

create index news_cache_fetched_idx on public.news_cache (fetched_at);

alter table public.news_cache enable row level security;

-- Readable so the market detail screen can show why the news bar looks the way
-- it does. Written only by the scoring pass (service role).
create policy news_cache_select on public.news_cache
  for select to authenticated using (true);
