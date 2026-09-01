-- ===========================================================================
-- Add minSideSeparation to model v1's thresholds.
--
-- The first 15 live scores were ALL side=YES. Cause: news is neutral for both
-- sides without coverage, and baseRateScore keys off min(price, 100 - price)
-- so it is symmetric by construction. Drift is the only input that can
-- separate the sides, and a market that has not moved ties exactly — with
-- pickSide breaking toward YES every time.
--
-- Surfacing a coin flip with a side badge implies a directional view the model
-- does not hold. This is the minimum gap between the two sides' scores before
-- a market may surface. 0.5 is the smallest gap visible at the one decimal
-- place scores are stored and displayed at.
-- ===========================================================================

update public.model_versions
   set thresholds = thresholds || jsonb_build_object('minSideSeparation', 0.5)
 where version_label = 'v1'
   and not (thresholds ? 'minSideSeparation');
