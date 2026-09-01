-- ===========================================================================
-- Model v1.1 — lower the surface threshold to 4.0.
--
-- A NEW VERSION rather than an edit to v1, per the addendum's section 7: every
-- tunable change is versioned so scores either side of it stay distinguishable
-- and comparable. v1's existing scores keep their model_version_id and remain
-- exactly what v1 said.
--
-- WHY, from measurement rather than judgement. One scoring pass over 394
-- markets with ~5.5 hours of price history reported:
--
--     scoreP50 4.0    scoreP90 4.3    scoreMax 4.8
--     sepP50   0      sepMax   1.1
--
-- Two things follow.
--
-- The 5.0 surface threshold was UNREACHABLE. The single best-scoring market on
-- the platform sat at 4.8, so nothing could ever surface. 5.0 had been
-- calibrated against inflated scores — before 20260823001000 fixed a bug where
-- untraded markets were credited with a 3x volume spike, which added roughly
-- 1.8 points to every micro contribution.
--
-- And the median separation between the two sides is ZERO. Half of all markets
-- score identically on YES and NO, because drift is the only side-aware input
-- v1 has and most markets simply do not move. Since
--
--     delta_score = 0.45 x drift x quality
--
-- a sepMax of 1.1 means the MOST-moved market of 394 drifted about 2.7 cents in
-- six hours.
--
-- THIS IS A STOPGAP, NOT A TUNING IMPROVEMENT. Lowering the threshold does not
-- make a 2-cent move into an edge; it makes a thin desk visible instead of an
-- empty one, so paper trading and the execution path can be exercised while
-- anchors are built. minSideSeparation stays at 0.5, which is what stops this
-- from re-admitting the coin flips 20260823001000 removed.
--
-- The real fix is the addendum's section 1: an NWS forecast of 78% against a
-- 64c market is a directional edge that exists whether or not the price has
-- moved, and is therefore immune to precisely the weakness measured above.
-- ===========================================================================

insert into public.model_versions
  (version_label, status, weights, thresholds, risk_limits, notes)
select
  'v1.1',
  'draft',
  weights,
  thresholds || jsonb_build_object('surface', 4.0),
  risk_limits,
  'Drift-only stopgap. Surface threshold 5.0 -> 4.0 because scoreMax across '
  || '394 markets was 4.8, making 5.0 unreachable. Separation median was 0 and '
  || 'max 1.1, i.e. the most-moved market drifted ~2.7c in six hours. This '
  || 'makes a thin desk visible; it does not make the signal stronger. '
  || 'Superseded once anchors land.'
from public.model_versions
where version_label = 'v1'
  and not exists (select 1 from public.model_versions where version_label = 'v1.1');

-- Mirror publish_model_version(): the outgoing stable enters its transition
-- window rather than being deprecated outright, so anyone pinned to v1 keeps
-- its scores until the window closes.
update public.model_versions
   set status = 'stable',
       transition_ends_at = now() + make_interval(
         days => public.setting_numeric('transition_window_days', 14)::integer)
 where version_label = 'v1'
   and status = 'stable';

update public.model_versions
   set status = 'stable',
       published_at = now(),
       transition_ends_at = null
 where version_label = 'v1.1';

insert into public.activity_log (event_type, detail, metadata)
values (
  'model.published',
  'Published v1.1 — surface threshold 4.0 (drift-only stopgap)',
  jsonb_build_object(
    'label', 'v1.1',
    'reason', 'surface 5.0 unreachable: scoreMax 4.8 across 394 markets',
    'evidence', jsonb_build_object(
      'scoreP50', 4.0, 'scoreP90', 4.3, 'scoreMax', 4.8,
      'sepP50', 0, 'sepMax', 1.1, 'markets', 394)
  )
);
