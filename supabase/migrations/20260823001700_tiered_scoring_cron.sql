-- ===========================================================================
-- Scoring runs per cadence tier, like pricing.
--
-- WHY. The first pass over the tiered universe scored 82 of the 800 fast-tier
-- markets. The scorer filled its slots by volume across every snapshot, so
-- 300 of 400 went to long-dated slow markets that out-rank near-dated ones on
-- volume -- undoing the tiering it was meant to read.
--
-- The scorer now takes a tier and scores that tier's candidates, with a
-- history window scaled to the tier's pricing cadence. Schedules follow the
-- pricing jobs by a minute or two so each pass reads fresh snapshots.
-- ===========================================================================

do $$
begin
  perform cron.unschedule('oe-score-markets');
exception when others then
  null;
end;
$$;

-- Fast: every 5 minutes, one minute behind fast pricing. The tier members act
-- on; the whole cap is scored every pass.
select cron.schedule(
  'oe-score-fast', '1-56/5 * * * *',
  $cron$ select public.invoke_edge_function('score-markets', '{"tier":"fast"}'::jsonb); $cron$
);

-- Slow: hourly, two minutes behind slow pricing (:10). Drift on hourly
-- snapshots needs three active intervals, so this tier only starts producing
-- directions a few hours after a market enters it -- expected, not a fault.
select cron.schedule(
  'oe-score-slow', '12 * * * *',
  $cron$ select public.invoke_edge_function('score-markets', '{"tier":"slow"}'::jsonb); $cron$
);

-- Archive: daily, after archive pricing (08:25). History only for now; a
-- score here is a long-dated tail-entry candidate, not a desk item.
select cron.schedule(
  'oe-score-archive', '40 8 * * *',
  $cron$ select public.invoke_edge_function('score-markets', '{"tier":"archive"}'::jsonb); $cron$
);
