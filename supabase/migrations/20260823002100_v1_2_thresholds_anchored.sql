-- ===========================================================================
-- v1.2 draft: thresholds anchored to the fast-tier distribution, and how.
--
-- The score is a RANKING, not a probability (addendum decision 1). A
-- ranking's thresholds only mean something relative to the distribution they
-- cut, so they are set as tier percentiles of the UNFILTERED scores -- the
-- scorer's own pre-gate report, not the surfaced set, which would be the
-- model grading its own homework.
--
-- Why it matters now: when the news signal was held, activeWeights
-- renormalised and micro went from 60% of the score to 83%. Micro saturates
-- (8c drift, 3x volume, tight book -- routine for near-dated markets), so the
-- ceiling moved from 8.3 to 9.6 and a third of the desk cleared v1.1's
-- absolute strongPick of 7.0. The rank did not change; the labels broke.
-- Percentile anchoring is robust to exactly this: any hold or auto-disable
-- shifts the scale, and absolute thresholds silently break while percentile
-- ones do not.
--
-- Sample: score-markets fast-tier pre-gate report, 2026-09-13 02:41 UTC,
-- news held: scoreP50 4.8, scoreP90 7.1 over 152 considered.
--   surface    = p50 -> 5.0   (rounded to the half-point)
--   strongPick = p90 -> 7.0
-- These are v1's original values. v1.1 lowered surface to 4.0 on a sample
-- with a 1,217-day median horizon; on the tiered universe the original
-- numbers are where the distribution actually sits.
--
-- To redo after any change to weights, holds or selection: read the latest
-- fast-tier byTier block and set surface = round2(scoreP50), strongPick =
-- round2(scoreP90), where round2 rounds to the nearest 0.5.
-- ===========================================================================
update public.model_versions
   set thresholds = thresholds
       || jsonb_build_object('surface', 5.0, 'strongPick', 7.0)
       || jsonb_build_object('anchoring', jsonb_build_object(
            'method',    'tier percentiles of pre-gate scores',
            'tier',      'fast',
            'surface',   'p50',
            'strongPick','p90',
            'sample',    jsonb_build_object(
               'at', '2026-09-13T02:41:00Z', 'considered', 152,
               'scoreP50', 4.8, 'scoreP90', 7.1, 'newsHeld', true))),
       notes = notes || ' Thresholds anchored 2026-09-13 as fast-tier percentiles '
               'of pre-gate scores (p50 4.8 -> surface 5.0, p90 7.1 -> strongPick 7.0); '
               'see thresholds.anchoring for the sample and method.'
 where version_label = 'v1.2'
   and status = 'draft';
