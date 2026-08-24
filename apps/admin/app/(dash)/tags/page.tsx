import { serverClient } from '@/lib/supabase';
import { TagReview } from './client';

export const dynamic = 'force-dynamic';

/**
 * Tag review — the feedback loop on the auto-tagging rules.
 *
 * Auto tags are generated in the scoring pass; spot-checking them here is how
 * bad rules get found. Manual edits are the admin's judgement and are never
 * overwritten by a later scoring run (the auto upsert is keyed on
 * source='auto').
 */
export default async function TagsPage() {
  const db = await serverClient();

  const [{ data: tags }, { data: markets }, { data: scores }] = await Promise.all([
    db.from('tags').select('*').order('created_at', { ascending: false }).limit(120),
    db.from('markets').select('id, question, category, resolved_at, outcome').limit(600),
    db.from('latest_scores').select('market_id, score, side').limit(600),
  ]);

  type MarketInfo = {
    question: string;
    category: string;
    resolved_at: string | null;
    outcome: string | null;
  };
  type ScoreInfo = { score: number; side: string };

  const marketById = new Map<string, MarketInfo>(
    ((markets ?? []) as Array<Record<string, any>>).map((m) => [
      m.id as string,
      {
        question: m.question as string,
        category: m.category as string,
        resolved_at: (m.resolved_at ?? null) as string | null,
        outcome: (m.outcome ?? null) as string | null,
      },
    ]),
  );

  const scoreById = new Map<string, ScoreInfo>(
    ((scores ?? []) as Array<Record<string, any>>).map((s) => [
      s.market_id as string,
      { score: Number(s.score), side: s.side as string },
    ]),
  );

  const rows = ((tags ?? []) as Array<Record<string, any>>).map((t) => ({
    id: t.id as string,
    market_id: (t.market_id ?? null) as string | null,
    trade_id: (t.trade_id ?? null) as string | null,
    tag_type: t.tag_type as string,
    severity: t.severity as 'info' | 'caution',
    text: t.text as string,
    source: t.source as 'auto' | 'manual',
    created_at: t.created_at as string,
    market: t.market_id ? marketById.get(t.market_id) ?? null : null,
    score: t.market_id ? scoreById.get(t.market_id) ?? null : null,
  }));

  return <TagReview rows={rows} />;
}
