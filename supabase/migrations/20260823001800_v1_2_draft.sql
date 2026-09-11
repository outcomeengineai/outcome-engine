-- ===========================================================================
-- Model v1.2 -- DRAFT. Supersedes the v1.1 drift-only stopgap.
--
-- Inserted as a draft, not published. Publishing is a section 7 act that
-- needs the full-cap fast-tier distribution behind it; this migration puts
-- the version on the table with its reasoning recorded, so publishing is a
-- one-line decision when the evidence lands, not a rushed edit.
--
-- WHAT CHANGES, and why each part:
--
--   1. surface 4.0 -> 5.0.  v1.1 lowered it because "scoreMax 4.8 across 394
--      markets". Those 394 had a median horizon of 1,217 days. On the tiered
--      universe the fast tier sits at score p50 5.1 / p90 6.5 after fifty
--      minutes of history: 5.0 is the median, not a ceiling. The v1.1 premise
--      was a correct response to a fact measured on the wrong universe.
--      PROVISIONAL until the full-cap distribution confirms it.
--
--   2. news weight -> 0 (default 0.28, Weather 0.08).  GDELT has been
--      unreachable on every pass (newsAborted: true). The signal contributed a
--      neutral value at full weight, compressing every score toward the
--      middle and damping the one signal that works. Zero until a real source
--      exists. combineSignals normalises by the weight total, so micro and
--      base scale up in their existing 5:1 ratio; the shared package tests
--      pin that behaviour.
--
--   3. selection is part of the contract, deliberately. v1 and v1.1 had the
--      block stamped on after the fact. v1.2 is the first version published
--      knowing what it can see.
--
-- WHAT DOES NOT CHANGE: minSideSeparation 0.5 (it gated 45 of 82 fast-tier
-- markets that had no direction -- doing its job); micro:base ratio; risk
-- limits; strongPick. No anchors: those add a signal (section 1) and belong
-- to a later version.
--
-- Evidence recorded for the notes, first tiered pass, 2026-09-11 17:01 UTC,
-- ~50 min of fast-tier history:
--   fast  considered 82  scored 36 (44%)  scoreP50 5.1  scoreP90 6.5  sepP90 3.6
--   slow  considered 300 scored 1 (0.3%)  scoreP50 3.7  belowSurface 247
--   old universe (v1.1 basis): scored 6 of ~394 (1.5%)  scoreMax 4.8
-- ===========================================================================

insert into public.model_versions
  (version_label, status, weights, thresholds, risk_limits, notes)
select
  'v1.2',
  'draft',
  jsonb_build_object(
    'default',   jsonb_build_object('micro', 0.60, 'news', 0, 'base', 0.12),
    'overrides', jsonb_build_object(
      'Weather', jsonb_build_object('micro', 0.70, 'news', 0, 'base', 0.22)
    )
  ),
  thresholds || jsonb_build_object('surface', 5.0),
  risk_limits,
  'Supersedes v1.1 (drift-only stopgap). The stopgap lowered surface to 4.0 '
  'because 5.0 was unreachable on a universe with a 1,217-day median horizon. '
  'On the tiered universe the fast tier scores p50 5.1 / p90 6.5, so 5.0 is '
  'restored. News weight zeroed until a reachable source exists: GDELT aborted '
  'on every pass and was diluting live signals at full weight. Selection '
  'tunables are part of this version by design. Evidence: first tiered pass '
  '2026-09-11 17:01Z, fast 36/82 directional (44%) vs slow 1/300 (0.3%) vs '
  'old universe 6/394 (1.5%). Surface value provisional until the full-cap '
  'distribution is read.'
from public.model_versions
where version_label = 'v1.1'
  and not exists (select 1 from public.model_versions where version_label = 'v1.2');

-- Not published here. When the distribution confirms:
--   select public.publish_model_version(
--     (select id from public.model_versions where version_label = 'v1.2'));
-- or publish from the admin dashboard, which calls the same function.
