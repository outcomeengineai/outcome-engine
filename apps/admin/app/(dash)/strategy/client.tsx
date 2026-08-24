'use client';

import { useMemo, useState, useTransition } from 'react';
import { SIGNAL_COLORS, SIGNAL_LABELS } from '@outcome/shared';
import type {
  ModelVersion,
  RiskLimits,
  SignalKey,
  SignalWeights,
  Thresholds,
  WeightConfig,
} from '@outcome/shared';
import { Pill, SignalStatusPill, relativeTime } from '@/components/ui';
import {
  deleteDraft,
  publishVersion,
  saveDraft,
  setSignalStatus,
  updateSignalRules,
} from './actions';

const SIGNALS: SignalKey[] = ['micro', 'news', 'base'];
const DEFAULT_KEY = 'All markets';

const FALLBACK: { weights: WeightConfig; thresholds: Thresholds; riskLimits: RiskLimits } = {
  weights: { default: { micro: 0.6, news: 0.28, base: 0.12 }, overrides: {} },
  thresholds: {
    strongPick: 7,
    surface: 5,
    autoTags: { volumeAnomaly: true, lowLiquidity: true, sentimentDivergence: true },
  },
  riskLimits: {
    dailyLossLimitCents: 50000,
    maxTradesPerDay: 10,
    cooldownAfterLossMinutes: 30,
    maxExposurePerMarketCents: 100000,
    lockedCategories: [],
  },
};

const STEPS = ['Signal weights', 'Score thresholds', 'Risk limits', 'Review & publish'];

export function StrategyWorkspace({
  stable,
  drafts,
  allVersions,
  signals,
  signalHistory,
  rules,
  categories,
}: {
  stable: ModelVersion | null;
  drafts: ModelVersion[];
  allVersions: ModelVersion[];
  signals: Array<Record<string, any>>;
  signalHistory: Array<{ signal: string; win_rate: number | null; computed_at: string }>;
  rules: Record<string, number>;
  categories: string[];
}) {
  const [tab, setTab] = useState<'configure' | 'health'>('configure');
  const unhealthy = signals.filter((s) => s.status !== 'healthy').length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            {stable ? `Live: ${stable.version_label}` : 'No published version'}
          </div>
          <h1>Strategy</h1>
        </div>
        <div className="tabs">
          <button className="tab" data-active={tab === 'configure'} onClick={() => setTab('configure')}>
            Configure
          </button>
          <button className="tab" data-active={tab === 'health'} onClick={() => setTab('health')}>
            Signal health {unhealthy ? <span className="pill pill-gold" style={{ marginLeft: 6 }}>{unhealthy}</span> : null}
          </button>
        </div>
      </div>

      {tab === 'configure' ? (
        <ConfigureFlow
          stable={stable}
          drafts={drafts}
          allVersions={allVersions}
          categories={categories}
        />
      ) : (
        <SignalHealthPanel signals={signals} history={signalHistory} rules={rules} />
      )}
    </>
  );
}

// ===========================================================================
// Configure — four steps, not one giant form
// ===========================================================================

function ConfigureFlow({
  stable,
  drafts,
  allVersions,
  categories,
}: {
  stable: ModelVersion | null;
  drafts: ModelVersion[];
  allVersions: ModelVersion[];
  categories: string[];
}) {
  const base = stable ?? drafts[0] ?? null;

  const [step, setStep] = useState(0);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState(DEFAULT_KEY);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [weights, setWeights] = useState<WeightConfig>(
    (base?.weights as WeightConfig) ?? FALLBACK.weights,
  );
  const [thresholds, setThresholds] = useState<Thresholds>(
    (base?.thresholds as Thresholds) ?? FALLBACK.thresholds,
  );
  const [risk, setRisk] = useState<RiskLimits>(
    (base?.risk_limits as RiskLimits) ?? FALLBACK.riskLimits,
  );

  const isOverridden = activeCategory !== DEFAULT_KEY && Boolean(weights.overrides[activeCategory]);
  const active: SignalWeights = isOverridden ? weights.overrides[activeCategory]! : weights.default;
  const overrideCount = Object.keys(weights.overrides).length;

  function setWeight(key: SignalKey, value: number) {
    if (activeCategory === DEFAULT_KEY) {
      setWeights({ ...weights, default: { ...weights.default, [key]: value } });
    } else {
      setWeights({
        ...weights,
        overrides: {
          ...weights.overrides,
          [activeCategory]: { ...active, [key]: value },
        },
      });
    }
  }

  function enableOverride() {
    setWeights({
      ...weights,
      overrides: { ...weights.overrides, [activeCategory]: { ...weights.default } },
    });
  }

  function clearOverride() {
    const next = { ...weights.overrides };
    delete next[activeCategory];
    setWeights({ ...weights, overrides: next });
  }

  const total = SIGNALS.reduce((s, k) => s + (active[k] ?? 0), 0);

  function persist(): Promise<any> {
    return saveDraft({
      weights,
      thresholds,
      riskLimits: risk,
      draftId: draftId ?? undefined,
    }).then((row) => {
      setDraftId(row.id);
      return row;
    });
  }

  return (
    <>
      {error ? <div className="banner banner-danger">{error}</div> : null}
      {message ? <div className="banner banner-info">{message}</div> : null}

      <div className="card">
        <div className="row-between" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>{STEPS[step]}</h2>
          <span className="num hint">{step + 1} / {STEPS.length}</span>
        </div>
        <div className="steps">
          {STEPS.map((s, i) => <div key={s} className="step-bar" data-done={i <= step} />)}
        </div>

        {/* ---------------- step 1: weights ---------------- */}
        {step === 0 ? (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
              {[DEFAULT_KEY, ...categories].map((c) => {
                const has = c !== DEFAULT_KEY && Boolean(weights.overrides[c]);
                return (
                  <button
                    key={c}
                    className="btn btn-sm"
                    style={
                      activeCategory === c
                        ? { borderColor: 'var(--green)', color: 'var(--green-dark)', background: '#e8f7f1' }
                        : undefined
                    }
                    onClick={() => setActiveCategory(c)}
                  >
                    {c}
                    {has ? (
                      <span
                        className="dot"
                        style={{ background: 'var(--green)', marginLeft: 2 }}
                        aria-label="has override"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>

            {activeCategory !== DEFAULT_KEY && !isOverridden ? (
              <div className="banner banner-info">
                <div>
                  <strong>{activeCategory}</strong> uses the platform default.
                  <div className="hint" style={{ marginTop: 3 }}>
                    Customize only when a category genuinely behaves differently — every override is
                    another thing to keep tuned.
                  </div>
                </div>
                <div className="spacer" />
                <button className="btn btn-sm" onClick={enableOverride}>Customize</button>
              </div>
            ) : null}

            {isOverridden ? (
              <div className="row-between" style={{ marginBottom: 12 }}>
                <Pill tone="green"><span className="dot" />Override active for {activeCategory}</Pill>
                <button className="btn btn-sm" onClick={clearOverride}>Revert to default</button>
              </div>
            ) : null}

            <div className="stack">
              {SIGNALS.map((k) => {
                const value = active[k] ?? 0;
                const share = total > 0 ? (value / total) * 100 : 0;
                return (
                  <div key={k}>
                    <div className="row-between" style={{ marginBottom: 6 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 500 }}>{SIGNAL_LABELS[k]}</span>
                      <span className="num hint">
                        {value.toFixed(2)} · {share.toFixed(0)}% of score
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={value}
                      style={{ color: SIGNAL_COLORS[k] }}
                      onChange={(e) => setWeight(k, Number(e.target.value))}
                    />
                  </div>
                );
              })}
            </div>

            <p className="hint" style={{ marginTop: 14 }}>
              Weights do not have to add to 1 — the scorer normalizes them. What matters is their
              ratio to each other. If a signal is auto-disabled, the rest are renormalized so the
              score keeps the same scale.
            </p>
          </>
        ) : null}

        {/* ---------------- step 2: thresholds ---------------- */}
        {step === 1 ? (
          <>
            <div className="row-between" style={{ marginBottom: 6 }}>
              <label style={{ margin: 0 }}>Strong pick threshold</label>
              <span className="num" style={{ fontWeight: 600 }}>{thresholds.strongPick.toFixed(1)}</span>
            </div>
            <input
              type="range" min={5} max={9.5} step={0.1}
              value={thresholds.strongPick}
              style={{ color: 'var(--green)' }}
              onChange={(e) => setThresholds({ ...thresholds, strongPick: Number(e.target.value) })}
            />
            <p className="hint" style={{ marginTop: 6 }}>
              The Decision Desk defaults to the &ldquo;Strong&rdquo; filter, so this is the number
              that decides what most members see first.
            </p>

            <div className="divider" />

            <div className="row-between" style={{ marginBottom: 6 }}>
              <label style={{ margin: 0 }}>Surface threshold</label>
              <span className="num" style={{ fontWeight: 600 }}>{thresholds.surface.toFixed(1)}</span>
            </div>
            <input
              type="range" min={1} max={7} step={0.1}
              value={thresholds.surface}
              style={{ color: 'var(--blue)' }}
              onChange={(e) => setThresholds({ ...thresholds, surface: Number(e.target.value) })}
            />
            <p className="hint" style={{ marginTop: 6 }}>
              Below this a market simply does not appear. A market that scores weakly on both sides
              falls off the desk entirely — there is no &ldquo;no edge&rdquo; card.
            </p>

            <div className="divider" />

            <h3>Auto-tagging</h3>
            {([
              ['volumeAnomaly', 'Volume anomalies', 'Flags unusual volume with no matching news'],
              ['lowLiquidity', 'Low liquidity', 'Flags wide spreads and thin open interest'],
              ['sentimentDivergence', 'Sentiment divergence', 'Flags news and price pointing opposite ways'],
            ] as const).map(([key, label, hint]) => (
              <label key={key} className="row-between" style={{ marginBottom: 10, cursor: 'pointer' }}>
                <span>
                  <span style={{ fontSize: 13.5, fontWeight: 500 }}>{label}</span>
                  <div className="hint">{hint}</div>
                </span>
                <input
                  type="checkbox"
                  style={{ width: 18, height: 18 }}
                  checked={thresholds.autoTags[key]}
                  onChange={(e) =>
                    setThresholds({
                      ...thresholds,
                      autoTags: { ...thresholds.autoTags, [key]: e.target.checked },
                    })
                  }
                />
              </label>
            ))}
          </>
        ) : null}

        {/* ---------------- step 3: risk ---------------- */}
        {step === 2 ? (
          <div className="grid grid-2">
            {([
              ['dailyLossLimitCents', 'Daily loss limit (cents)', 'Realized losses per member per day'],
              ['maxTradesPerDay', 'Max trades per day', 'Per member, per mode'],
              ['cooldownAfterLossMinutes', 'Cooldown after a loss (min)', 'Enforced from the last resolved loss'],
              ['maxExposurePerMarketCents', 'Max exposure per market (cents)', 'Per member, per market, per day'],
            ] as const).map(([key, label, hint]) => (
              <div key={key}>
                <label htmlFor={key}>{label}</label>
                <input
                  id={key}
                  type="number"
                  value={risk[key]}
                  onChange={(e) => setRisk({ ...risk, [key]: Number(e.target.value) })}
                />
                <div className="hint" style={{ marginTop: 4 }}>{hint}</div>
              </div>
            ))}
          </div>
        ) : null}

        {/* ---------------- step 4: review ---------------- */}
        {step === 3 ? (
          <>
            <div className="grid grid-3" style={{ marginBottom: 16 }}>
              <div>
                <div className="stat-label">Default weights</div>
                {SIGNALS.map((k) => (
                  <div key={k} className="row-between" style={{ fontSize: 13 }}>
                    <span style={{ color: 'var(--muted)' }}>{SIGNAL_LABELS[k]}</span>
                    <span className="num">{(weights.default[k] ?? 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="stat-label">Thresholds</div>
                <div className="row-between" style={{ fontSize: 13 }}>
                  <span style={{ color: 'var(--muted)' }}>Strong pick</span>
                  <span className="num">{thresholds.strongPick.toFixed(1)}</span>
                </div>
                <div className="row-between" style={{ fontSize: 13 }}>
                  <span style={{ color: 'var(--muted)' }}>Surface</span>
                  <span className="num">{thresholds.surface.toFixed(1)}</span>
                </div>
              </div>
              <div>
                <div className="stat-label">Category overrides</div>
                {overrideCount === 0 ? (
                  <div className="hint">None — every category uses the default.</div>
                ) : (
                  Object.keys(weights.overrides).map((c) => (
                    <div key={c} className="row" style={{ fontSize: 13, gap: 6 }}>
                      <span className="dot" style={{ background: 'var(--green)' }} />
                      <span>{c}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="banner banner-info">
              <div>
                <strong>Publishing opens a transition window.</strong>
                <div className="hint" style={{ marginTop: 3 }}>
                  {stable?.version_label ?? 'The current version'} stays available to members who
                  pin it, until the window closes and it auto-deprecates. Open trades keep the
                  score and version they were opened on — nothing is backfilled. Anyone whose open
                  trade moves materially gets a notification with the new score.
                </div>
              </div>
            </div>

            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    try {
                      const row = await persist();
                      setMessage(`Saved as draft ${row.version_label}.`);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  })
                }
              >
                Save as draft
              </button>

              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    try {
                      const row = await persist();
                      if (!confirm(`Publish ${row.version_label}? Members are notified and all open markets are re-scored.`)) return;
                      const result = await publishVersion(row.id);
                      setMessage(
                        `Published ${row.version_label}. ${result.materiallyChanged} open trade(s) changed materially; ${result.notified} notification(s) sent.`,
                      );
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  })
                }
              >
                {pending ? 'Working…' : 'Publish'}
              </button>
            </div>
          </>
        ) : null}

        <div className="divider" />
        <div className="row-between">
          <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          <button
            className="btn"
            disabled={step === STEPS.length - 1}
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h2>Versions</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Published</th>
                <th>Transition ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {allVersions.map((v) => (
                <tr key={v.id}>
                  <td className="num" style={{ fontWeight: 600 }}>{v.version_label}</td>
                  <td>
                    <Pill tone={v.status === 'stable' ? 'green' : v.status === 'draft' ? 'blue' : 'muted'}>
                      {v.status}
                    </Pill>
                  </td>
                  <td className="hint">{v.published_at ? relativeTime(v.published_at) : '—'}</td>
                  <td className="hint">
                    {v.transition_ends_at
                      ? new Date(v.transition_ends_at).toLocaleDateString()
                      : '—'}
                  </td>
                  <td>
                    {v.status === 'draft' ? (
                      <div className="row" style={{ gap: 4 }}>
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={pending}
                          onClick={() =>
                            start(async () => {
                              if (!confirm(`Publish ${v.version_label}?`)) return;
                              try {
                                const r = await publishVersion(v.id);
                                setMessage(`Published ${v.version_label}. ${r.notified} notification(s) sent.`);
                              } catch (e) {
                                setError(e instanceof Error ? e.message : String(e));
                              }
                            })
                          }
                        >
                          Publish
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={pending}
                          onClick={() => start(() => deleteDraft(v.id))}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ===========================================================================
// Signal health
// ===========================================================================

function Sparkline({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) return <div className="hint">no trend yet</div>;

  const w = 108;
  const h = 26;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;

  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

const RULE_FIELDS: Array<{ key: string; label: string; hint: string; step?: number }> = [
  { key: 'signal_window_size', label: 'Rolling window', hint: 'Resolved trades considered' },
  { key: 'signal_min_sample', label: 'Minimum sample', hint: 'Below this, no judgement is made' },
  { key: 'signal_min_win_rate', label: 'Minimum win rate', hint: '0.48 = 48%', step: 0.01 },
  { key: 'signal_accuracy_drop_pct', label: 'Accuracy drop trigger', hint: '0.10 = 10 points below baseline', step: 0.01 },
  { key: 'signal_cooldown_hours', label: 'Cooldown (hours)', hint: 'How long a disabled signal stays off' },
];

function SignalHealthPanel({
  signals,
  history,
  rules,
}: {
  signals: Array<Record<string, any>>;
  history: Array<{ signal: string; win_rate: number | null; computed_at: string }>;
  rules: Record<string, number>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(RULE_FIELDS.map((f) => [f.key, String(rules[f.key] ?? '')])),
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const trends = useMemo(() => {
    const byKey = new Map<string, number[]>();
    for (const h of history) {
      if (h.win_rate === null) continue;
      byKey.set(h.signal, [...(byKey.get(h.signal) ?? []), Number(h.win_rate)]);
    }
    return byKey;
  }, [history]);

  return (
    <>
      {error ? <div className="banner banner-danger">{error}</div> : null}

      <div className="stack" style={{ marginBottom: 18 }}>
        {signals.map((s) => {
          const key = s.signal as SignalKey;
          const disabled = s.status === 'disabled';
          const degraded = s.status === 'degraded';

          return (
            <div
              key={s.signal}
              className="card"
              style={{
                borderColor: disabled ? 'var(--red)' : degraded ? 'var(--gold)' : 'var(--border)',
              }}
            >
              <div className="row-between">
                <div className="row" style={{ gap: 12 }}>
                  <span
                    className="dot"
                    style={{ background: SIGNAL_COLORS[key], width: 9, height: 9 }}
                  />
                  <div>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>{SIGNAL_LABELS[key]}</div>
                    <div className="hint">
                      {s.sample_count > 0 && s.win_rate !== null
                        ? `${(Number(s.win_rate) * 100).toFixed(1)}% win rate over ${s.sample_count} resolved trade(s)`
                        : 'Not enough resolved trades to judge yet.'}
                      {s.baseline_win_rate
                        ? ` · baseline ${(Number(s.baseline_win_rate) * 100).toFixed(1)}%`
                        : ''}
                    </div>
                  </div>
                </div>

                <div className="row" style={{ gap: 14 }}>
                  <Sparkline points={trends.get(s.signal) ?? []} color={SIGNAL_COLORS[key]} />
                  <SignalStatusPill status={s.status} />
                  <button
                    className="btn btn-sm"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        try {
                          await setSignalStatus(s.signal, disabled ? 'healthy' : 'disabled');
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        }
                      })
                    }
                  >
                    {disabled ? 'Re-enable' : 'Disable'}
                  </button>
                </div>
              </div>

              {degraded ? (
                <div className="banner banner-warn" style={{ margin: '12px 0 0' }}>
                  {s.disabled_reason ?? 'Below target — will auto-disable if it drops further.'}
                </div>
              ) : null}

              {disabled ? (
                <div className="banner banner-danger" style={{ margin: '12px 0 0' }}>
                  <div>
                    {s.disabled_reason ?? 'Auto-disabled.'}
                    {s.disabled_until ? (
                      <div className="hint" style={{ marginTop: 3 }}>
                        Cooldown ends {relativeTime(s.disabled_until)}. While disabled, its weight is
                        redistributed across the remaining signals.
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>Auto-disable rules</h2>
        <div className="grid grid-3" style={{ gap: 12 }}>
          {RULE_FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={f.key}>{f.label}</label>
              <input
                id={f.key}
                type="number"
                step={f.step ?? 1}
                value={draft[f.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
              <div className="hint" style={{ marginTop: 4 }}>{f.hint}</div>
            </div>
          ))}
        </div>

        <p className="hint" style={{ marginTop: 12 }}>
          A signal is disabled only when it is <em>both</em> below the minimum win rate <em>and</em>{' '}
          has dropped from its baseline. Either alone marks it degraded. Baselines ratchet up on
          improvement and never down, so a slow decline still trips the drop test.
        </p>

        <button
          className="btn btn-primary"
          style={{ marginTop: 12 }}
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const payload: Record<string, number> = {};
              for (const f of RULE_FIELDS) {
                const n = Number(draft[f.key]);
                if (!Number.isFinite(n)) { setError(`${f.label} must be a number.`); return; }
                payload[f.key] = n;
              }
              try { await updateSignalRules(payload); }
              catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            })
          }
        >
          {pending ? 'Saving…' : 'Save rules'}
        </button>
      </div>
    </>
  );
}
