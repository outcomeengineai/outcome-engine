-- ===========================================================================
-- The Decision Desk applies the same lifecycle rules as tier assignment.
--
-- WHY. The desk showed finished games. The view hid a market only when
-- resolved_at was set or close_time had passed. For an early finalization
-- our close_time is still the contractual deadline days out, resolved_at
-- lands only when the resolution job reaches the market -- behind a queue
-- of stale rows -- and the last score from before the market ended is still
-- its latest. A finished game, with a confident-looking score, on the desk.
--
-- Tier assignment already knows how to tell a live market from a dead one
-- (migration 2300). The desk now applies the same tests, plus one of its
-- own: the score must be fresh. A market whose latest score is older than
-- two hours is no longer being scored -- it left the fast tier, or scoring
-- is broken -- and either way the desk must not present it as current.
--
-- Same name, same columns, so the member app and my_decision_desk are
-- unchanged.
-- ===========================================================================
create or replace view public.decision_desk
with (security_invoker = true) as
select
  m.id            as market_id,
  m.question,
  m.category,
  m.close_time,
  ls.model_version_id,
  ls.side,
  ls.score,
  ls.breakdown,
  ls.ts           as scored_at,
  snap.price      as yes_price,
  snap.volume,
  snap.spread,
  snap.liquidity,
  case when ls.side = 'YES' then snap.price else 100 - snap.price end as side_price
from public.markets m
join public.latest_scores ls on ls.market_id = m.id
left join public.latest_snapshots snap on snap.market_id = m.id
where m.resolved_at is null
  -- Not ended, by the field Kalshi actually updates on early finalization.
  and coalesce(m.status, '') not in ('finalized', 'settled', 'closed')
  -- Still in the priced universe. 'excluded' covers settled, expired, stale,
  -- too-short and shards.
  and m.cadence_tier <> 'excluded'
  -- Not past the EARLIER of expected and actual close.
  and (m.close_time is null
       or least(coalesce(m.expected_close, m.close_time), m.close_time) > now())
  -- Scored recently. Fast tier scores every five minutes; slow hourly.
  and ls.ts > now() - interval '2 hours';
