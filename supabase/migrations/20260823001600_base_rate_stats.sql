-- ===========================================================================
-- Base rates aggregated in SQL.
--
-- WHY. The scorer loaded every resolved position as a row and tallied wins per
-- (category, side) in the function. PostgREST caps any response at 1,000 rows
-- and says nothing, so once members had accumulated more than a thousand
-- resolved trades the base rates would have been computed from an arbitrary
-- subset -- and base rates feed every score. That is a silent, growing bias,
-- found while fixing the same truncation in the slow pricing tier.
--
-- A tally is a GROUP BY. It belongs here, where the result is a few dozen
-- rows regardless of how many trades exist.
-- ===========================================================================
create or replace view public.base_rate_stats
with (security_invoker = true) as
select
  category,
  side,
  count(*) filter (where outcome = 'win') as wins,
  count(*)                                as total
from public.resolved_positions
group by category, side;

comment on view public.base_rate_stats is
  'Win tallies per (category, side) over all resolved positions, paper and '
  'live. Paper is included on purpose: the question is whether the model was '
  'right, not who owes what, and excluding paper would discard most early '
  'evidence.';
