-- ===========================================================================
-- Calibration: net and hit rate on the SAME population.
--
-- The first real digest showed band 5 at a 53% hit rate against a 55%
-- breakeven with net -21.8c per contract. Those numbers cannot both describe
-- the same rows: net is averaged over labels that carry an entry price --
-- only recorded since 2026-09-14 -- while hit rate covered every label. Two
-- populations in one row, and the smaller one silently drove the verdict.
--
-- Every bucket now reports the priced subset's own hit rate beside its net,
-- and the strong recommendation requires the priced sample to meet the same
-- floor as everything else. Until enough priced labels exist, net stays
-- informative-but-thin rather than authoritative.
-- ===========================================================================

drop function if exists public.calibration_table(uuid, boolean);

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
  priced_n        bigint,
  priced_hit_rate numeric,
  avg_price       numeric,
  breakeven_rate  numeric,
  avg_net_cents   numeric
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
      count(*)::bigint                                          as n,
      count(*) filter (where r.hit)::bigint                     as hits,
      count(r.price)::bigint                                    as priced_n,
      count(*) filter (where r.hit and r.price is not null)::bigint as priced_hits,
      avg(r.price)                                              as avg_price,
      avg(r.net_cents)                                          as avg_net_cents
    from rows r
    group by 1, 2, 3
  ),
  w as (
    select g.*, (hits::numeric / n) as p, 1.96 as z from g
  )
  select
    w.tier, w.category, w.band, w.n, w.hits,
    round(w.p, 3) as hit_rate,
    round(( (w.p + w.z*w.z/(2*w.n)) - w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_low,
    round(( (w.p + w.z*w.z/(2*w.n)) + w.z * sqrt( (w.p*(1-w.p) + w.z*w.z/(4*w.n)) / w.n ) ) / (1 + w.z*w.z/w.n), 3) as ci_high,
    w.priced_n,
    case when w.priced_n = 0 then null else round(w.priced_hits::numeric / w.priced_n, 3) end as priced_hit_rate,
    round(w.avg_price, 1) as avg_price,
    case when w.avg_price is null then null
         else round((w.avg_price + public.kalshi_fee_cents(round(w.avg_price)::int)) / 100.0, 3) end as breakeven_rate,
    round(w.avg_net_cents, 2) as avg_net_cents
  from w
  order by w.tier, w.category, w.band;
$fn$;

grant execute on function public.calibration_table(uuid, boolean) to authenticated;

-- Return shape changes (adds `priced`), so the old definition has to go first.
drop function if exists public.calibration_recommendations(uuid);

create or replace function public.calibration_recommendations(p_version uuid default null)
returns table (
  tier                text,
  labelled            bigint,
  priced              bigint,
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
    select t.tier, t.band, t.n, t.priced_n, t.avg_net_cents,
           -- Edge: the hit rate's lower bound clears breakeven, on a full sample.
           (t.n >= v_min and t.breakeven_rate is not null and t.ci_low > t.breakeven_rate) as is_edge,
           -- Strong: at least 5c net per contract, on a PRICED sample that
           -- meets the same floor. Ten priced rows do not get to set a
           -- threshold members trade on.
           (t.priced_n >= v_min and t.avg_net_cents >= 5) as is_strong
    from t
  )
  select
    j.tier,
    sum(j.n)::bigint as labelled,
    sum(j.priced_n)::bigint as priced,
    coalesce(array_agg(j.band order by j.band) filter (where j.is_edge), '{}') as edge_bands,
    min(j.band) filter (where j.is_edge)::numeric as suggested_surface,
    min(j.band) filter (where j.is_strong)::numeric as suggested_strong,
    case
      when sum(j.n) < v_min then format('%s labels; need %s per band before this means anything', sum(j.n), v_min)
      when count(*) filter (where j.is_edge) = 0 and sum(j.priced_n) < v_min
        then format('no band clears breakeven at its confidence floor yet; %s of %s labels carry an entry price, so net is thin', sum(j.priced_n), sum(j.n))
      when count(*) filter (where j.is_edge) = 0 then 'no band clears breakeven at its confidence floor yet'
      else format('edge in bands %s; surface at %s', array_agg(j.band order by j.band) filter (where j.is_edge), min(j.band) filter (where j.is_edge))
    end as verdict
  from judged j
  group by j.tier
  order by j.tier;
end;
$fn$;

grant execute on function public.calibration_recommendations(uuid) to authenticated;
