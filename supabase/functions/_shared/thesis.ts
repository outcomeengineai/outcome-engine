/**
 * Edge thesis generation and logging (Edge Signals v2 §9).
 *
 * Generated for EVERY scored market, traded or not. Restricting this to taken
 * trades would inherit whichever markets members happened to like and cap the
 * training set at trade volume instead of market volume — currently ~2,000
 * scored markets against a handful of trades. At resolution every row here
 * joins against the outcome regardless of whether anyone traded it.
 *
 * `none` is a valid and common outcome. A decent score with no concrete
 * mispricing driver has no thesis, and manufacturing one would be worse than
 * silence.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { selectInBatches } from './batch.ts';

export type ThesisType =
  | 'anchor_gap'
  | 'coherence'
  | 'informed_flow'
  | 'longshot_bias'
  | 'none';

export interface Thesis {
  marketId: string;
  scoreId?: string | null;
  thesisType: ThesisType;
  /** Side the thesis favours. Null when thesisType is 'none'. */
  direction?: 'YES' | 'NO' | null;
  /** Size of the claimed mispricing, in cents where that is meaningful. */
  magnitude?: number | null;
  payload?: Record<string, unknown>;
  renderedText?: string | null;
}

interface ExistingThesis {
  market_id: string;
  thesis_type: ThesisType;
  direction: 'YES' | 'NO' | null;
  magnitude: number | null;
  created_at: string;
}

/**
 * Smallest magnitude change worth a new row, in cents.
 *
 * Exact-magnitude dedupe looks right and is not: once anchors land, an
 * anchor gap drifts continuously (14.2 -> 14.1 -> 14.3) and would write a row
 * every scoring pass forever, turning a transition log into a sampling log.
 * A row is written when the TYPE or DIRECTION changes, or when the magnitude
 * has moved by at least this much.
 *
 * Tunable per model version as thresholds.thesisMagnitudeStep.
 */
export const DEFAULT_MAGNITUDE_STEP = 1.0;

/**
 * Has the thesis materially changed since the last row for this market?
 */
export function isMaterialChange(
  prev: ExistingThesis | undefined,
  next: Thesis,
  magnitudeStep: number,
): boolean {
  if (!prev) return true;
  if (prev.thesis_type !== next.thesisType) return true;
  if ((prev.direction ?? null) !== (next.direction ?? null)) return true;

  const before = prev.magnitude === null ? null : Number(prev.magnitude);
  const after = next.magnitude === undefined || next.magnitude === null
    ? null
    : Number(next.magnitude);

  // One side having a magnitude and the other not is a change.
  if ((before === null) !== (after === null)) return true;
  if (before === null || after === null) return false;

  return Math.abs(after - before) >= magnitudeStep;
}

/**
 * Write theses for a scoring pass, skipping markets whose thesis has not
 * materially changed.
 *
 * Returns how many rows were written and how many were suppressed, so the
 * scoring response shows whether the dedupe is behaving.
 */
export async function recordTheses(
  db: SupabaseClient,
  modelVersionId: string,
  theses: readonly Thesis[],
  magnitudeStep = DEFAULT_MAGNITUDE_STEP,
): Promise<{ written: number; unchanged: number }> {
  if (theses.length === 0) return { written: 0, unchanged: 0 };

  // Latest row per market for this version. DISTINCT ON is not available
  // through PostgREST, so order by recency and keep the first seen per market.
  const rows = await selectInBatches<ExistingThesis>(
    theses.map((t) => t.marketId),
    (batch) =>
      db
        .from('edge_theses')
        .select('market_id, thesis_type, direction, magnitude, created_at')
        .eq('model_version_id', modelVersionId)
        .in('market_id', batch)
        .order('created_at', { ascending: false }),
    { label: 'existing theses' },
  );

  const latest = new Map<string, ExistingThesis>();
  for (const r of rows) if (!latest.has(r.market_id)) latest.set(r.market_id, r);

  const toWrite = theses.filter((t) =>
    isMaterialChange(latest.get(t.marketId), t, magnitudeStep)
  );

  const CHUNK = 500;
  for (let i = 0; i < toWrite.length; i += CHUNK) {
    const { error } = await db.from('edge_theses').insert(
      toWrite.slice(i, i + CHUNK).map((t) => ({
        market_id: t.marketId,
        score_id: t.scoreId ?? null,
        model_version_id: modelVersionId,
        thesis_type: t.thesisType,
        direction: t.direction ?? null,
        magnitude: t.magnitude ?? null,
        payload: t.payload ?? {},
        rendered_text: t.renderedText ?? null,
      })),
    );
    if (error) {
      console.error('edge_theses write failed:', error.message);
      break;
    }
  }

  return { written: toWrite.length, unchanged: theses.length - toWrite.length };
}

/**
 * Stamp the final thesis for a market at resolution.
 *
 * Unconditional — it does NOT go through the dedupe above. The last
 * transition might have been days before resolution, which leaves the training
 * label ambiguous about what the platform believed at the end. This row says
 * so explicitly, and is the row the learning loop grades against the outcome.
 *
 * Marked in the payload so it can be told apart from a transition, and never
 * pruned.
 */
export async function stampFinalThesis(
  db: SupabaseClient,
  modelVersionId: string,
  marketId: string,
  outcome: 'YES' | 'NO',
): Promise<void> {
  const { data: prev } = await db
    .from('edge_theses')
    .select('thesis_type, direction, magnitude, payload')
    .eq('market_id', marketId)
    .eq('model_version_id', modelVersionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const type = (prev?.thesis_type ?? 'none') as ThesisType;
  const direction = (prev?.direction ?? null) as 'YES' | 'NO' | null;

  const { error } = await db.from('edge_theses').insert({
    market_id: marketId,
    model_version_id: modelVersionId,
    thesis_type: type,
    direction,
    magnitude: prev?.magnitude ?? null,
    payload: {
      ...(prev?.payload ?? {}),
      final_state: true,
      resolved_outcome: outcome,
      // The label: did the thesis point the way the market actually went?
      thesis_correct: direction === null ? null : direction === outcome,
    },
    rendered_text: null,
  });

  if (error) console.error(`final thesis stamp failed for ${marketId}:`, error.message);
}
