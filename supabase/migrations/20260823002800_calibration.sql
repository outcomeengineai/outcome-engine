-- ===========================================================================
-- Calibration: what the model actually gets right, net of fees.
--
-- The learning loop labels every scored market at resolution. This turns
-- those labels into the one table that decides whether the platform makes
-- money: for each tier and score band, how often the model's side won, with
-- a confidence interval, at what average entry price, and what that was
-- worth per contract after Kalshi's trading fee.
--
-- Three things are deliberate:
--
--   * The label is the SCORE'S SIDE versus the outcome. v1 theses carry no
--     direction (thesis_type 'none'), so thesis_correct is null on every
--     row; the model's call is payload.side, and that is what gets graded.
--   * Only labels since calibration_start count. Before the universe fix
--     (2026-09-14 01:22 UTC) the fast tier was mostly finished games; a label
--     on a market that was already over is not evidence about anything.
--   * The bar is BREAKEVEN, not 50%. At 60c a side must be right more than
--     61.4% of the time to make money after fees. Every bucket reports its
--     hit rate against the breakeven rate at its average price, and the
--     recommendation only counts a band as edge when the LOWER confidence
--     bound clears that bar with enough sample to mean it.
-- ===========================================================================

insert into public.platform_settings (key, value) values
  ('calibration_start',      '"2026-09-14T02:00:00Z"'::jsonb),
  ('calibration_min_sample', '30'::jsonb)
on conflict (key) do nothing;

-- Kalshi's general trading fee: 7% of price x (1 - price), per contract,
-- rounded up to the cent. Matches kalshiFeeCents in the shared package.
create or replace function public.kalshi_fee_cents(p_price integer, p_contracts integer default 1)
returns integer
language sql
immutable
as $fn$
  select ceil(0.07 * p_contracts * (p_price / 100.0) * (1 - p_price / 100.0) * 100)::integer;
$fn$;

-- --------------------------------------------------------------------------
-- One row per labelled thesis, with its economics.
-- --------------------------------------------------------------------------
create or replace view public.calibration_rows
with (security_invoker = true) as
select
  t.id                                          as thesis_id,
  t.market_id,
  t.model_version_id,
  t.created_at                                  as labelled_at,
  (t.payload->>'side')::public.market_side      as side,
  (t.payload->>'resolved_outcome')::public.market_side as outcome,
  (t.payload->>'score')::numeric                as score,
  floor((t.payload->>'score')::numeric)::int    as band,
  (t.payload->>'price')::int                    as price,
  -- Tier at the time: from the payload once the scorer records it; before
  -- that, the last priced tier in the point-in-time membership log.
  coalesce(t.payload->>'tier', um.tier::text)   as tier,
  coalesce(t.payload->>'category', m.category)  as category,
  (t.payload->>'side') = (t.payload->>'resolved_outcome') as hit,
  case
    when (t.payload->>'price') is null then null
    when (t.payload->>'side') = (t.payload->>'resolved_outcome')
      then 100 - (t.payload->>'price')::int - public.kalshi_fee_cents((t.payload->>'price')::int)
    else - (t.payload->>'price')::int - public.kalshi_fee_cents((t.payload->>'price')::int)
  end                                           as net_cents
from public.edge_theses t
join public.markets m on m.id = t.market_id
left join lateral (
  select u.tier from public.universe_membership u
   where u.market_id = t.market_id and u.tier <> 'excluded'
   order by u.entered_at desc limit 1
) um on true
where t.payload ? 'final_state'
  and t.payload ? 'side'
  and t.payload ? 'resolved_outcome'
  and t.created_at >= (
    select (value #>> '{}')::timestamptz from public.platform_settings where key = 'calibration_start'
  );

grant select on public.calibration_rows to authenticated;

-- --------------------------------------------------------------------------
-- Buckets: tier x score band (and optionally category).
-- --------------------------------------------------------------------------
create or replace function public.calibration_table(
  p_version uuid default null,
  p_by_category boolean default false
)
returns table (
  tier            text,
  category        text,
  band            integer,
  n               bigint,
  hits            bigint,
  hit_rate        numeric,
  ci_low          numeric,
  ci_high         numeric,
  avg_price       numeric,
  breakeven_rate  numeric,
  avg_net_cents   numeric,
  priced_n        bigint
)
language sql
security definer
set search_path = public
stable
as $fn$
  with rows as (
    select * from public.calibration_rows r
     where (p_version is null or r.model_version_id = p_version)
       and r.tier is not null
  ),
  g as (
    select
      r.tier,
      case when p_by_category then r.category else '*' end as category,
      r.band,
      count(*)::bigint                                      as n,
      count(*) filter (where r.hit)::bigint                 as hits,
      avg(r.price)                                          as avg_price,
      avg(r.net_cents)                                      as avg_net_cents,
      count(r.price)::bigint                                as priced_n
    from rows r
    group by 1, 2, 3
  ),
  w as (
    -- Wilson score interval, z = 1.96. Honest at small n where the naive
    -- p +/- 1.96*sqrt(p(1-p)/n) is not.
    select g.*,
      (hits::numeric / n) as p,
      1.96 as z
    from g
  )
  select
    w.tier, w.category, w.band, w.n, w.hits,
    round(w.p, 3) as hit_rate,
    round(( (w.p + w.z*w.z/(2*w.n)) - w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_low,
    round(( (w.p + w.z*w.z/(2*w.n)) + w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_high,
    round(w.avg_price, 1) as avg_price,
    case when w.avg_price is null then null
         else round((w.avg_price + public.kalshi_fee_cents(round(w.avg_price)::int)) / 100.0, 3) end as breakeven_rate,
    round(w.avg_net_cents, 2) as avg_net_cents,
    w.priced_n
  from w
  order by w.tier, w.category, w.band;
$fn$;

grant execute on function public.calibration_table(uuid, boolean) to authenticated;

-- --------------------------------------------------------------------------
-- Recommendations, derived from the buckets rather than from opinion.
--
-- A band is EDGE when its lower confidence bound on hit rate clears the
-- breakeven rate at its average price and the sample is at least
-- calibration_min_sample. Suggested surface = the lowest edge band in the
-- tier; suggested strongPick = the lowest band whose average net P&L per
-- contract is at least 5c with the same sample floor. Absent evidence, the
-- recommendation says so rather than guessing.
-- --------------------------------------------------------------------------
create or replace function public.calibration_recommendations(p_version uuid default null)
returns table (
  tier                text,
  labelled            bigint,
  edge_bands          integer[],
  suggested_surface   numeric,
  suggested_strong    numeric,
  verdict             text
)
language plpgsql
security definer
set search_path = public
stable
as $fn$
declare
  v_min integer := public.setting_numeric('calibration_min_sample', 30)::integer;
begin
  return query
  with t as (
    select * from public.calibration_table(p_version, false)
  ),
  judged as (
    select t.tier, t.band, t.n, t.avg_net_cents,
           (t.n >= v_min and t.breakeven_rate is not null and t.ci_low > t.breakeven_rate) as is_edge,
           (t.n >= v_min and t.avg_net_cents >= 5) as is_strong
    from t
  )
  select
    j.tier,
    sum(j.n)::bigint as labelled,
    coalesce(array_agg(j.band order by j.band) filter (where j.is_edge), '{}') as edge_bands,
    min(j.band) filter (where j.is_edge)::numeric as suggested_surface,
    min(j.band) filter (where j.is_strong)::numeric as suggested_strong,
    case
      when sum(j.n) < v_min then format('%s labels; need %s per band before this means anything', sum(j.n), v_min)
      when count(*) filter (where j.is_edge) = 0 then 'no band clears breakeven at its confidence floor yet'
      else format('edge in bands %s; surface at %s', array_agg(j.band order by j.band) filter (where j.is_edge), min(j.band) filter (where j.is_edge))
    end as verdict
  from judged j
  group by j.tier
  order by j.tier;
end;
$fn$;

grant execute on function public.calibration_recommendations(uuid) to authenticated;
