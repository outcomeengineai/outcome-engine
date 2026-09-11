-- ===========================================================================
-- "Latest" is a column, not a sort.
--
-- WHY. latest_snapshots was DISTINCT ON over the entire market_snapshots
-- table, with no index that supports the ordering. Every Decision Desk and
-- Positions load sorted every snapshot ever written to find the newest per
-- market. Measured on three days of realistic volume (871k snapshots):
--
--   latest_snapshots alone      445 ms
--   decision_desk (Desk tab)    708 ms
--
-- on a laptop, growing linearly with history -- ~300k rows a day. That is the
-- multi-second tab switch in the admin dashboard, and it would only get
-- worse. latest_scores had the same shape over scores (89 ms and growing).
--
-- The newest snapshot per market is now six columns on markets, and the
-- newest score per (version, market) is a small table, both maintained by
-- statement-level triggers on insert. The views keep their names and exact
-- column lists, so every consumer -- admin, member app, scorer -- is
-- unchanged. The Desk gets a view that resolves the caller's effective
-- version itself, turning three sequential round-trips into one.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Newest snapshot, on the market row
-- --------------------------------------------------------------------------
alter table public.markets
  add column last_price         smallint,
  add column last_volume        bigint,
  add column last_spread        smallint,
  add column last_open_interest bigint,
  add column last_liquidity     bigint,
  add column last_snapshot_at   timestamptz;

create or replace function public.markets_apply_latest_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- One UPDATE per statement, not per row: ingestion inserts in 500-row
  -- chunks, and the newest row per market within the chunk is all that
  -- matters. Never move backwards if an older snapshot arrives late.
  update public.markets m
     set last_price         = n.price,
         last_volume        = n.volume,
         last_spread        = n.spread,
         last_open_interest = n.open_interest,
         last_liquidity     = n.liquidity,
         last_snapshot_at   = n.ts
    from (
      select distinct on (market_id) market_id, ts, price, volume, spread, open_interest, liquidity
        from inserted
       order by market_id, ts desc
    ) n
   where m.id = n.market_id
     and (m.last_snapshot_at is null or n.ts >= m.last_snapshot_at);
  return null;
end;
$fn$;

create trigger market_snapshots_apply_latest
  after insert on public.market_snapshots
  referencing new table as inserted
  for each statement execute function public.markets_apply_latest_snapshot();

-- Backfill from what exists. One-time cost of the sort this migration removes.
update public.markets m
   set last_price = s.price, last_volume = s.volume, last_spread = s.spread,
       last_open_interest = s.open_interest, last_liquidity = s.liquidity, last_snapshot_at = s.ts
  from (
    select distinct on (market_id) market_id, ts, price, volume, spread, open_interest, liquidity
      from public.market_snapshots
     order by market_id, ts desc
  ) s
 where m.id = s.market_id;

-- Same name, same columns, same types. Consumers do not change.
create or replace view public.latest_snapshots
with (security_invoker = true) as
select
  m.id                 as market_id,
  m.last_snapshot_at   as ts,
  m.last_price         as price,
  m.last_volume        as volume,
  m.last_spread        as spread,
  m.last_open_interest as open_interest,
  m.last_liquidity     as liquidity
from public.markets m
where m.last_snapshot_at is not null;

-- --------------------------------------------------------------------------
-- Newest score per (version, market)
-- --------------------------------------------------------------------------
create table public.market_latest_scores (
  model_version_id uuid not null references public.model_versions(id) on delete cascade,
  market_id        text not null references public.markets(id) on delete cascade,
  score_id         uuid not null,
  ts               timestamptz not null,
  side             public.market_side not null,
  score            numeric(3,1) not null,
  breakdown        jsonb not null,
  primary key (model_version_id, market_id)
);

create index market_latest_scores_version_score_idx
  on public.market_latest_scores (model_version_id, score desc);

alter table public.market_latest_scores enable row level security;
create policy market_latest_scores_select on public.market_latest_scores
  for select to authenticated using (true);
revoke all on public.market_latest_scores from anon;

create or replace function public.scores_apply_latest()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.market_latest_scores
    (model_version_id, market_id, score_id, ts, side, score, breakdown)
  select distinct on (model_version_id, market_id)
         model_version_id, market_id, id, ts, side, score, breakdown
    from inserted
   order by model_version_id, market_id, ts desc
  on conflict (model_version_id, market_id) do update
     set score_id  = excluded.score_id,
         ts        = excluded.ts,
         side      = excluded.side,
         score     = excluded.score,
         breakdown = excluded.breakdown
   where excluded.ts >= market_latest_scores.ts;
  return null;
end;
$fn$;

create trigger scores_apply_latest
  after insert on public.scores
  referencing new table as inserted
  for each statement execute function public.scores_apply_latest();

insert into public.market_latest_scores
  (model_version_id, market_id, score_id, ts, side, score, breakdown)
select distinct on (model_version_id, market_id)
       model_version_id, market_id, id, ts, side, score, breakdown
  from public.scores
 order by model_version_id, market_id, ts desc
on conflict do nothing;

create or replace view public.latest_scores
with (security_invoker = true) as
select
  l.score_id as id,
  l.market_id,
  l.model_version_id,
  l.ts,
  l.side,
  l.score,
  l.breakdown
from public.market_latest_scores l;

-- --------------------------------------------------------------------------
-- The Desk in one round-trip
--
-- The page used to call getUser(), then effective_version_for(), then query
-- decision_desk with the result, then model_versions for the label and
-- thresholds -- four sequential network hops before rendering. The view
-- resolves the caller's version itself and carries the version fields along.
-- --------------------------------------------------------------------------
create or replace view public.my_decision_desk
with (security_invoker = true) as
select
  d.*,
  mv.version_label,
  mv.thresholds
from public.decision_desk d
join public.model_versions mv on mv.id = d.model_version_id
where d.model_version_id = public.effective_version_for(auth.uid());

grant select on public.my_decision_desk to authenticated;
