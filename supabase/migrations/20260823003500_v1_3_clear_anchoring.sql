-- Migration 3400 meant to drop v1.2's anchoring record from the v1.3 draft
-- and did not: `thresholds || obj - 'anchoring'` binds the subtraction to
-- obj (jsonb `-` outranks `||`), so the merge put the record back. It
-- describes the hard-clipped distribution and would mislead whoever
-- re-anchors v1.3. Strip it here; the correct form is parenthesised.
update public.model_versions
   set thresholds = (thresholds - 'anchoring')
 where version_label = 'v1.3'
   and status = 'draft';
