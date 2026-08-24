'use client';

import { useState, useTransition } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatUsd } from '@outcome/shared';
import { Pill, Stat, relativeTime } from '@/components/ui';
import { publishVersion } from '../strategy/actions';
import { runBacktest } from './actions';

interface Version { id: string; version_label: string; status: string }
interface Point { t: string; equity: number }

interface Result {
  runId: string;
  draft: { label: string; pnl: number; maxDrawdown: number; tradeCount: number; winRate: number | null; curve: Point[] };
  compare: { label: string; pnl: number; maxDrawdown: number; tradeCount: number; winRate: number | null; curve: Point[] } | null;
  universeSize: number;
}

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

export function SimulateWorkspace({
  versions,
  runs,
}: {
  versions: Version[];
  runs: Array<Record<string, any>>;
}) {
  const drafts = versions.filter((v) => v.status === 'draft');
  const live = versions.find((v) => v.status === 'stable');

  const [modelVersionId, setModelVersionId] = useState(drafts[0]?.id ?? versions[0]?.id ?? '');
  const [rangeStart, setRangeStart] = useState(isoDaysAgo(30));
  const [rangeEnd, setRangeEnd] = useState(isoDaysAgo(0));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // One chart with two lines, not two charts — comparing curves side by side
  // makes small differences look large and large ones look small.
  const merged: Array<{ t: string; draft?: number; live?: number }> = [];
  if (result) {
    const byDate = new Map<string, { t: string; draft?: number; live?: number }>();
    for (const p of result.draft.curve) {
      const day = p.t.slice(0, 10);
      byDate.set(day, { ...(byDate.get(day) ?? { t: day }), draft: p.equity / 100 });
    }
    for (const p of result.compare?.curve ?? []) {
      const day = p.t.slice(0, 10);
      byDate.set(day, { ...(byDate.get(day) ?? { t: day }), live: p.equity / 100 });
    }
    merged.push(...[...byDate.values()].sort((a, b) => a.t.localeCompare(b.t)));
  }

  const selected = versions.find((v) => v.id === modelVersionId);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Backtest</div>
          <h1>Simulate</h1>
        </div>
      </div>

      {error ? <div className="banner banner-danger">{error}</div> : null}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 220 }}>
            <label htmlFor="version">Strategy version</label>
            <select
              id="version"
              value={modelVersionId}
              onChange={(e) => setModelVersionId(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.version_label} ({v.status})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="from">From</label>
            <input id="from" type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
          </div>
          <div>
            <label htmlFor="to">To</label>
            <input id="to" type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
          </div>
          <button
            className="btn btn-primary"
            disabled={pending || !modelVersionId}
            onClick={() =>
              start(async () => {
                setError(null);
                setResult(null);
                try {
                  const r = await runBacktest({
                    modelVersionId,
                    rangeStart: new Date(rangeStart).toISOString(),
                    rangeEnd: new Date(`${rangeEnd}T23:59:59Z`).toISOString(),
                  });
                  if (r.tradeCount === 0 && !r.draft) {
                    setError(r.note ?? 'No resolved markets in that range.');
                    return;
                  }
                  setResult(r as Result);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              })
            }
          >
            {pending ? 'Running…' : 'Run simulation'}
          </button>
        </div>

        <p className="hint" style={{ marginTop: 12 }}>
          Replays stored snapshots against markets that actually resolved in the window, entering
          at the price a few ticks in rather than the last one — scoring on the final snapshot
          would be reading the answer. Fills are assumed at mid, and every simulated position is
          the same size, so this measures the model&rsquo;s hit rate, not anyone&rsquo;s staking.
          Raw snapshots are retained for 30 days by default, which bounds how far back it can look.
        </p>
      </div>

      {result ? (
        <>
          <div className="grid grid-4" style={{ marginBottom: 18 }}>
            <div className="card">
              <Stat
                label={`Simulated PnL · ${result.draft.label}`}
                value={
                  <span className={result.draft.pnl >= 0 ? 'pos' : 'neg'}>
                    {formatUsd(result.draft.pnl, { signed: true })}
                  </span>
                }
              />
            </div>
            <div className="card">
              <Stat label="Max drawdown" value={<span className="neg">{formatUsd(result.draft.maxDrawdown)}</span>} />
            </div>
            <div className="card">
              <Stat
                label="Trades"
                value={<span className="num">{result.draft.tradeCount}</span>}
                hint={`from ${result.universeSize} resolved markets`}
              />
            </div>
            <div className="card">
              <Stat
                label="Win rate"
                value={
                  <span className="num">
                    {result.draft.winRate !== null ? `${(result.draft.winRate * 100).toFixed(1)}%` : '—'}
                  </span>
                }
              />
            </div>
          </div>

          <div className="card">
            <div className="row-between" style={{ marginBottom: 14 }}>
              <h2 style={{ margin: 0 }}>Equity curve</h2>
              <div className="row" style={{ gap: 8 }}>
                <Pill tone="green">{result.draft.label} (simulated)</Pill>
                {result.compare ? <Pill tone="blue">{result.compare.label} (live)</Pill> : null}
              </div>
            </div>

            {merged.length > 1 ? (
              <div style={{ height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={merged} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="t"
                      tick={{ fontSize: 11, fill: 'var(--faint)', fontFamily: 'var(--mono)' }}
                      tickLine={false} axisLine={false} minTickGap={40}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'var(--faint)', fontFamily: 'var(--mono)' }}
                      tickLine={false} axisLine={false}
                      tickFormatter={(v) => `$${v}`}
                    />
                    <Tooltip
                      formatter={(v: number) => `$${v.toFixed(2)}`}
                      contentStyle={{
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                        fontFamily: 'var(--mono)',
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="monotone" dataKey="draft" name={result.draft.label}
                      stroke="var(--green)" strokeWidth={2} dot={false} connectNulls
                    />
                    {result.compare ? (
                      <Line
                        type="monotone" dataKey="live" name={result.compare.label}
                        stroke="var(--blue)" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls
                      />
                    ) : null}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="empty">Not enough simulated trades to plot a curve.</div>
            )}

            {selected?.status === 'draft' ? (
              <>
                <div className="divider" />
                <div className="row-between">
                  <div className="hint" style={{ maxWidth: 560 }}>
                    Promoting publishes this draft as the live version: every open market is
                    re-scored, members are notified, and the current version enters its transition
                    window.
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        if (!confirm(`Promote ${selected.version_label} to live?`)) return;
                        try { await publishVersion(selected.id); }
                        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
                      })
                    }
                  >
                    Promote to live
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="card" style={{ marginTop: 18 }}>
        <h2>Recent runs</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Range</th>
                <th>Status</th>
                <th className="right">PnL</th>
                <th className="right">Drawdown</th>
                <th className="right">Trades</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="num">
                    {String(r.range_start).slice(0, 10)} → {String(r.range_end).slice(0, 10)}
                  </td>
                  <td>
                    <Pill tone={r.status === 'complete' ? 'green' : r.status === 'failed' ? 'red' : 'muted'}>
                      {r.status}
                    </Pill>
                  </td>
                  <td className="right num">{r.simulated_pnl !== null ? formatUsd(r.simulated_pnl, { signed: true }) : '—'}</td>
                  <td className="right num">{r.max_drawdown !== null ? formatUsd(r.max_drawdown) : '—'}</td>
                  <td className="right num">{r.trade_count ?? '—'}</td>
                  <td className="hint">{relativeTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </div>
      </div>
    </>
  );
}
