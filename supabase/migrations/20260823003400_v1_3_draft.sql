-- ===========================================================================
-- Model v1.3 -- DRAFT. Soft saturation in the micro sub-score.
--
-- WHY. The Decision Desk showed a wall of identical 9.6s, all wearing the
-- strong badge, and the calibration table graded that top band at 47%. The
-- two are the same defect. Micro's momentum component clips at 8c of drift
-- and activity at 3x volume, so every liquid near-dated market that moved
-- anywhere from 8c to 30c lands in the same 0.56-point window at the top of
-- the scale: 0.83 x 10 + 0.17 x 7.5 = 9.6, whatever it actually did. The
-- scale was clipping, not measuring, and a ranking with ties at the top has
-- no information where members look first.
--
-- v1.3 opts into soft saturation (tanh momentum, 1 - exp activity):
-- monotonic, never pinned, 8c and 25c score differently, the same markets
-- spread across ~3 points. It is a version option, not a code change:
-- v1 through v1.2 keep hard clipping so their backtests reproduce what
-- members saw.
--
-- Thresholds are PROVISIONAL, inherited from v1.2. A rescaled score has a
-- new distribution; surface and strongPick get re-anchored as fast-tier
-- percentiles (thresholds.anchoring) from the first pre-gate report under
-- soft saturation, and checked against the backtest, before publish.
-- ===========================================================================
insert into public.model_versions
  (version_label, status, weights, thresholds, risk_limits, notes)
select
  'v1.3',
  'draft',
  weights,
  thresholds
    || jsonb_build_object('micro', jsonb_build_object(
         'saturation', 'soft',
         'momentumScaleCents', 10,
         'activityScale', 3))
    - 'anchoring',
  risk_limits,
  'Supersedes v1.2. Soft saturation in the micro sub-score: the desk showed a '
  'wall of identical 9.6s (every liquid market moving 8-30c scored the same) '
  'and calibration graded that band at 47%. Momentum now tanh(drift/10c), '
  'activity 1-exp(-(ratio-0.5)/3): monotonic, unpinned. Weights unchanged; '
  'news remains 0. Thresholds provisional pending re-anchoring on the soft '
  'distribution and a backtest against v1.2 on the same history.'
from public.model_versions
where version_label = 'v1.2'
  and not exists (select 1 from public.model_versions where version_label = 'v1.3');
