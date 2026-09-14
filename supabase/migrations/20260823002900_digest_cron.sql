-- ===========================================================================
-- Weekly model review digest to admins.
--
-- Mondays 14:00 UTC (morning in the US), after the weekend's sports markets
-- have resolved and been labelled. The digest reports what the calibration
-- SQL concluded -- edge bands, suggested thresholds, or "not enough
-- evidence" -- and never changes anything: a version change is a decision.
-- ===========================================================================
select cron.schedule(
  'oe-model-review-digest', '0 14 * * 1',
  $cron$ select public.invoke_edge_function('model-review-digest'); $cron$
);
