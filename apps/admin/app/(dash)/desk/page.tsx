import { serverClient } from '@/lib/supabase';
import { BreakdownBars, Pill, ScoreRing, relativeTime } from '@/components/ui';
import { formatPriceCents, isStrongPick } from '@outcome/shared';
import type { ScoreBreakdown, Thresholds } from '@outcome/shared';

export const dynamic = 'force-dynamic';

/**
 * The admin's own Decision Desk — an admin is a member of their own platform.
 * Read-only here: taking a trade happens in the member app, which is where the
 * stake card and its balance checks live.
 */
export default async function DeskPage() {
  const db = await serverClient();

  // One round-trip for the desk. my_decision_desk resolves the caller's
  // effective version in SQL and carries version_label + thresholds on every
  // row, replacing getUser -> effective_version_for -> decision_desk ->
  // model_versions: four sequential hops, each a Vercel-to-Supabase call.
  const [{ data: rows }, { data: tags }] = await Promise.all([
    db.from('my_decision_desk')
      .select('*')
      .order('score', { ascending: false })
      .limit(60),
    db.from('tags').select('market_id, text, severity').not('market_id', 'is', null).limit(400),
  ]);

  const first = (rows ?? [])[0] as { version_label?: string; thresholds?: Thresholds } | undefined;
  const version = first ? { version_label: first.version_label, thresholds: first.thresholds } : null;
  const thresholds = (version?.thresholds ?? { strongPick: 7 }) as Thresholds;

  const tagsByMarket = new Map<string, Array<{ text: string; severity: string }>>();
  for (const t of (tags ?? []) as Array<{ market_id: string; text: string; severity: string }>) {
    tagsByMarket.set(t.market_id, [...(tagsByMarket.get(t.market_id) ?? []), t]);
  }

  const markets = (rows ?? []) as Array<{
    market_id: string;
    question: string;
    category: string;
    side: 'YES' | 'NO';
    score: number;
    breakdown: ScoreBreakdown;
    side_price: number | null;
    scored_at: string;
    close_time: string | null;
  }>;

  const strong = markets.filter((m) => isStrongPick(Number(m.score), thresholds.strongPick ?? 7));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {version?.version_label ?? 'no version'} · {strong.length} strong of {markets.length} surfaced
          </div>
          <h1>Decision Desk</h1>
        </div>
        <div className="hint" style={{ maxWidth: 340, textAlign: 'right' }}>
          One card per market — the model commits to a single side. Trades are taken in the member
          app.
        </div>
      </div>

      {markets.length === 0 ? (
        <div className="card">
          <div className="empty">
            Nothing scored yet. Run ingestion, then scoring, and markets above the surface
            threshold will appear here.
          </div>
        </div>
      ) : (
        <div className="grid grid-3">
          {markets.map((m) => {
            const marketTags = tagsByMarket.get(m.market_id) ?? [];
            const top = marketTags[0];

            return (
              <div key={m.market_id} className="card">
                <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
                  <ScoreRing score={Number(m.score)} size={56} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                      <Pill tone="muted">{m.category}</Pill>
                      <Pill tone={m.side === 'YES' ? 'green' : 'blue'}>{m.side}</Pill>
                      {isStrongPick(Number(m.score), thresholds.strongPick ?? 7) ? (
                        <Pill tone="green">strong</Pill>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 13.5, lineHeight: 1.4, fontWeight: 500 }}>
                      {m.question}
                    </div>
                    <div className="hint" style={{ marginTop: 5 }}>
                      {m.side_price !== null ? formatPriceCents(m.side_price) : '—'} ·{' '}
                      scored {relativeTime(m.scored_at)}
                      {m.close_time
                        ? ` · closes ${new Date(m.close_time).toLocaleDateString()}`
                        : ''}
                    </div>
                  </div>
                </div>

                <div className="divider" style={{ margin: '14px 0' }} />
                <BreakdownBars breakdown={m.breakdown} total={Number(m.score)} />

                {top ? (
                  <div
                    className="hint"
                    style={{
                      marginTop: 12,
                      color: top.severity === 'caution' ? 'var(--gold)' : 'var(--blue)',
                    }}
                  >
                    {top.text}
                    {marketTags.length > 1 ? ` · +${marketTags.length - 1} more` : ''}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
