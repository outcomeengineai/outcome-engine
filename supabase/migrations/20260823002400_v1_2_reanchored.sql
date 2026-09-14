-- ===========================================================================
-- v1.2 draft: thresholds re-anchored on the stable universe.
--
-- The 2026-09-13 anchoring (surface 5.0 / strongPick 7.0) was measured on a
-- fast tier that was mostly finished games, with price histories truncated
-- to the oldest 1,000 rows per batch. Neither fact was known at the time.
-- Both are fixed (migrations 2200-2300, and the paged history load), and
-- the tier has now held stable -- ~790 markets, single-digit churn per
-- sweep -- for several hours with complete histories.
--
-- Sample: score-markets fast-tier pre-gate report, 2026-09-14 02:26 UTC,
-- news held, skippedNoData 0, 794 considered:
--   scoreP50 4.2 -> surface    4.0
--   scoreP90 7.6 -> strongPick 7.5
--   sepP50 0.5, sepP90 4.6, sepMax 5.0; 362 scored with a direction.
--
-- Same method as before (tier percentiles of pre-gate scores, rounded to the
-- half-point). Note that surface lands exactly where v1.1 had put it: the
-- stopgap was the right number for the wrong reason, and this is the same
-- number for the right one. The reason is what a later reader needs.
-- ===========================================================================
update public.model_versions
   set thresholds = thresholds
       || jsonb_build_object('surface', 4.0, 'strongPick', 7.5)
       || jsonb_build_object('anchoring', jsonb_build_object(
            'method',    'tier percentiles of pre-gate scores',
            'tier',      'fast',
            'surface',   'p50',
            'strongPick','p90',
            'sample',    jsonb_build_object(
               'at', '2026-09-14T02:26:00Z', 'considered', 794, 'skippedNoData', 0,
               'scoreP50', 4.2, 'scoreP90', 7.6, 'sepP50', 0.5, 'sepP90', 4.6,
               'newsHeld', true, 'universeStable', true))),
       notes = regexp_replace(notes, ' Thresholds anchored 2026-09-13.*$', '')
               || ' Thresholds re-anchored 2026-09-14 on the stable universe with complete '
               'histories (p50 4.2 -> surface 4.0, p90 7.6 -> strongPick 7.5); the 09-13 '
               'sample was finished games on truncated history. See thresholds.anchoring.'
 where version_label = 'v1.2'
   and status = 'draft';
