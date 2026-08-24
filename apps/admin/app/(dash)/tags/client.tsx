'use client';

import { useMemo, useState, useTransition } from 'react';
import { Pill, ScoreRing, relativeTime } from '@/components/ui';
import { deleteTag, updateTag } from './actions';

interface Row {
  id: string;
  market_id: string | null;
  trade_id: string | null;
  tag_type: string;
  severity: 'info' | 'caution';
  text: string;
  source: 'auto' | 'manual';
  created_at: string;
  market: { question: string; category: string; resolved_at: string | null; outcome: string | null } | null;
  score: { score: number; side: string } | null;
}

export function TagReview({ rows }: { rows: Row[] }) {
  const [filter, setFilter] = useState<'all' | 'auto' | 'manual' | 'caution'>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.tag_type, (counts.get(r.tag_type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filtered = rows.filter((r) => {
    if (filter === 'auto' && r.source !== 'auto') return false;
    if (filter === 'manual' && r.source !== 'manual') return false;
    if (filter === 'caution' && r.severity !== 'caution') return false;
    if (query) {
      const hay = `${r.text} ${r.tag_type} ${r.market?.question ?? ''}`.toLowerCase();
      if (!hay.includes(query.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{rows.length} recent tags</div>
          <h1>Tag review</h1>
        </div>
      </div>

      {error ? <div className="banner banner-danger">{error}</div> : null}

      <div className="card card-tight" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="tabs">
            {(['all', 'auto', 'manual', 'caution'] as const).map((f) => (
              <button key={f} className="tab" data-active={filter === f} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="Search tags and questions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <div className="spacer" />
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {types.slice(0, 5).map(([t, n]) => (
              <Pill key={t} tone="muted">{t} · {n}</Pill>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18, width: 62 }}>Score</th>
                <th>Market</th>
                <th>Tag</th>
                <th>Type</th>
                <th>Source</th>
                <th>Outcome</th>
                <th>Added</th>
                <th style={{ paddingRight: 18 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td style={{ paddingLeft: 18 }}>
                    {r.score ? <ScoreRing score={Number(r.score.score)} size={40} /> : <span className="hint">—</span>}
                  </td>
                  <td style={{ maxWidth: 320 }}>
                    <div style={{ fontSize: 13 }}>{r.market?.question ?? r.market_id ?? '(trade tag)'}</div>
                    {r.market ? <div className="hint">{r.market.category}</div> : null}
                  </td>
                  <td style={{ maxWidth: 300 }}>
                    {editing === r.id ? (
                      <input
                        type="text"
                        value={draftText}
                        autoFocus
                        onChange={(e) => setDraftText(e.target.value)}
                      />
                    ) : (
                      <span
                        style={{
                          fontSize: 13,
                          color: r.severity === 'caution' ? 'var(--gold)' : 'var(--blue)',
                        }}
                      >
                        {r.text}
                      </span>
                    )}
                  </td>
                  <td><span className="eyebrow">{r.tag_type}</span></td>
                  <td>
                    <Pill tone={r.source === 'auto' ? 'muted' : 'purple'}>{r.source}</Pill>
                  </td>
                  <td>
                    {r.market?.resolved_at ? (
                      <Pill tone={r.market.outcome === r.score?.side ? 'green' : 'red'}>
                        {r.market.outcome === r.score?.side ? 'model right' : 'model wrong'}
                      </Pill>
                    ) : (
                      <span className="hint">open</span>
                    )}
                  </td>
                  <td className="hint">{relativeTime(r.created_at)}</td>
                  <td style={{ paddingRight: 18 }}>
                    <div className="row" style={{ gap: 4 }}>
                      {editing === r.id ? (
                        <>
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={pending}
                            onClick={() =>
                              start(async () => {
                                try {
                                  await updateTag(r.id, { text: draftText });
                                  setEditing(null);
                                } catch (e) {
                                  setError(e instanceof Error ? e.message : String(e));
                                }
                              })
                            }
                          >
                            Save
                          </button>
                          <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn btn-sm"
                            onClick={() => { setEditing(r.id); setDraftText(r.text); }}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={pending}
                            onClick={() =>
                              start(async () => {
                                try {
                                  await updateTag(r.id, {
                                    severity: r.severity === 'caution' ? 'info' : 'caution',
                                  });
                                } catch (e) {
                                  setError(e instanceof Error ? e.message : String(e));
                                }
                              })
                            }
                          >
                            {r.severity === 'caution' ? '→ info' : '→ caution'}
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={pending}
                            onClick={() => start(() => deleteTag(r.id))}
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 ? <div className="empty">No tags match.</div> : null}
        </div>
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        The &ldquo;Outcome&rdquo; column compares the model&rsquo;s chosen side against how the
        market actually resolved. A tag type that keeps appearing on markets the model got wrong is
        a rule worth revisiting. Editing an auto tag converts it to manual so the next scoring pass
        will not overwrite your wording.
      </p>
    </>
  );
}
