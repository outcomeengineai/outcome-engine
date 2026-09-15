-- ===========================================================================
-- Fitted-weights proposal, weekly.
--
-- Tuesdays 14:00 UTC, the day after the model review digest, so the two
-- arrive as a pair: Monday says how the live model is doing net of fees;
-- Tuesday, if the evidence supports it, puts a fitted alternative on the
-- table as a DRAFT with its out-of-sample comparison in the notes. Neither
-- publishes anything. Below the sample floor the job reports "insufficient"
-- and does nothing else.
-- ===========================================================================
select cron.schedule(
  'oe-fit-weights', '0 14 * * 2',
  $cron$ select public.invoke_edge_function('fit-weights', '{"tier":"fast"}'::jsonb); $cron$
);
