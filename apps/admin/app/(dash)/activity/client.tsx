'use client';

import { useMemo, useState } from 'react';
import { Pill, relativeTime } from '@/components/ui';

interface Event {
  id: number;
  event_type: string;
  detail: string | null;
  ts: string;
  who: string;
}

/** Colour by event family, so a page of text is scannable. */
function toneFor(type: string) {
  if (type.startsWith('trade.failed') || type.includes('failed') || type.includes('kill_switch_on')) return 'red' as const;
  if (type.startsWith('billing')) return 'gold' as const;
  if (type.startsWith('trade')) return 'green' as const;
  if (type.startsWith('model') || type.startsWith('signal')) return 'purple' as const;
  if (type.startsWith('ingest') || type.startsWith('scoring') || type.startsWith('resolution')) return 'blue' as const;
  return 'muted' as const;
}

export function ActivityLog({ events }: { events: Event[] }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [who, setWho] = useState('all');

  const families = useMemo(() => {
    const set = new Set(events.map((e) => e.event_type.split('.')[0]));
    return ['all', ...[...set].sort()];
  }, [events]);

  const people = useMemo(() => {
    const set = new Set(events.map((e) => e.who));
    return ['all', ...[...set].sort()];
  }, [events]);

  const filtered = events.filter((e) => {
    if (type !== 'all' && !e.event_type.startsWith(type)) return false;
    if (who !== 'all' && e.who !== who) return false;
    if (query) {
      const hay = `${e.event_type} ${e.detail ?? ''} ${e.who}`.toLowerCase();
      if (!hay.includes(query.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{filtered.length} of {events.length} events</div>
          <h1>Activity</h1>
        </div>
      </div>

      <div className="card card-tight" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Search events…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 300 }}
          />
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 180 }}>
            {families.map((f) => <option key={f} value={f}>{f === 'all' ? 'All event types' : f}</option>)}
          </select>
          <select value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 220 }}>
            {people.map((p) => <option key={p} value={p}>{p === 'all' ? 'All users' : p}</option>)}
          </select>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>Event</th>
                <th>Detail</th>
                <th>User</th>
                <th style={{ paddingRight: 18 }}>When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td style={{ paddingLeft: 18 }}>
                    <Pill tone={toneFor(e.event_type)}>{e.event_type}</Pill>
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
                    {e.detail ?? '—'}
                  </td>
                  <td className="hint">{e.who}</td>
                  <td className="hint" style={{ paddingRight: 18, whiteSpace: 'nowrap' }}>
                    {relativeTime(e.ts)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 ? <div className="empty">No events match.</div> : null}
        </div>
      </div>
    </>
  );
}
