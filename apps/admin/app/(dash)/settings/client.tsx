'use client';

import { useState, useTransition } from 'react';
import { setKillSwitch, setTradingPaused, updateSettings } from './actions';

export function EmergencyControls({
  killSwitch,
  tradingPaused,
}: {
  killSwitch: boolean;
  tradingPaused: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  return (
    <div className="card" style={{ borderColor: killSwitch ? 'var(--red)' : 'var(--border)' }}>
      <h2>Emergency controls</h2>

      <div className="row-between" style={{ marginBottom: 14 }}>
        <div style={{ maxWidth: 520 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Pause live trading</div>
          <p className="hint" style={{ margin: '3px 0 0' }}>
            Blocks new live orders across the platform. Paper mode keeps working, and open
            positions are untouched.
          </p>
        </div>
        <button
          className={`btn ${tradingPaused ? '' : 'btn-warn'}`}
          disabled={pending}
          onClick={() => start(() => setTradingPaused(!tradingPaused))}
        >
          {tradingPaused ? 'Resume live trading' : 'Pause trading'}
        </button>
      </div>

      <div className="divider" />

      <div className="row-between">
        <div style={{ maxWidth: 520 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--red)' }}>
            Global kill switch
          </div>
          <p className="hint" style={{ margin: '3px 0 0' }}>
            Halts <strong>all</strong> platform trading, paper included. It does{' '}
            <strong>not</strong> close existing positions — those live in members&rsquo; own Kalshi
            accounts and will resolve normally.
          </p>
        </div>
        <button
          className={`btn ${killSwitch ? '' : 'btn-danger'}`}
          disabled={pending}
          onClick={() => (killSwitch ? start(() => setKillSwitch(false)) : setConfirming(true))}
        >
          {killSwitch ? 'Release kill switch' : 'Engage kill switch'}
        </button>
      </div>

      {confirming ? (
        <div className="modal-backdrop" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ color: 'var(--red)' }}>Engage the global kill switch?</h2>
            <p className="sub">
              Every member loses the ability to open a trade, in both paper and live mode, until
              you release it.
            </p>
            <p className="sub">
              Open positions are <strong>not</strong> closed. They stay in members&rsquo; Kalshi
              accounts and settle as normal.
            </p>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
              <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={pending}
                onClick={() => start(async () => { await setKillSwitch(true); setConfirming(false); })}
              >
                {pending ? 'Engaging…' : 'Engage kill switch'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const NUMERIC_FIELDS: Array<{ key: string; label: string; hint: string; step?: number }> = [
  { key: 'fee_rate', label: 'Platform fee rate', hint: '0.20 = 20% of net profit per period', step: 0.01 },
  { key: 'inactivity_threshold_days', label: 'Inactivity threshold (days)', hint: 'Flag only — removal stays manual' },
  { key: 'grace_period_days', label: 'Grace period (days)', hint: 'After a failed charge, before the account pauses' },
  { key: 'transition_window_days', label: 'Model transition window (days)', hint: 'How long members may stay on the previous version' },
  { key: 'daily_loss_limit_cents', label: 'Daily loss cap (cents)', hint: 'Platform-wide default, per member per day' },
  { key: 'max_exposure_per_market_cents', label: 'Max exposure per market (cents)', hint: 'Per member, per market, per day' },
  { key: 'snapshot_retention_days', label: 'Snapshot retention (days)', hint: 'Raw rows are rolled into daily aggregates after this' },
  { key: 'ingest_max_events', label: 'Events per ingestion run', hint: '~300 events yields ~2,700 markets. Higher costs more Kalshi calls per tick' },
];

export function SettingsForm({ settings }: { settings: Record<string, unknown> }) {
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(NUMERIC_FIELDS.map((f) => [f.key, String(settings[f.key] ?? '')])),
  );
  const [locked, setLocked] = useState<string>(
    Array.isArray(settings.locked_categories) ? (settings.locked_categories as string[]).join(', ') : '',
  );
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    NUMERIC_FIELDS.some((f) => draft[f.key] !== String(settings[f.key] ?? '')) ||
    locked !== (Array.isArray(settings.locked_categories) ? (settings.locked_categories as string[]).join(', ') : '');

  function save() {
    setError(null);
    const payload: Record<string, number | string[]> = {};

    for (const f of NUMERIC_FIELDS) {
      const n = Number(draft[f.key]);
      if (!Number.isFinite(n)) {
        setError(`${f.label} must be a number.`);
        return;
      }
      payload[f.key] = n;
    }
    payload.locked_categories = locked.split(',').map((s) => s.trim()).filter(Boolean);

    start(async () => {
      try {
        await updateSettings(payload);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="card">
      <h2>Platform configuration</h2>
      {error ? <div className="banner banner-danger">{error}</div> : null}

      <div className="grid grid-2" style={{ gap: 12 }}>
        {NUMERIC_FIELDS.map((f) => (
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

      <div style={{ marginTop: 12 }}>
        <label htmlFor="locked">Locked categories</label>
        <input
          id="locked"
          type="text"
          placeholder="Politics, Sports"
          value={locked}
          onChange={(e) => setLocked(e.target.value)}
        />
        <div className="hint" style={{ marginTop: 4 }}>
          Comma-separated. Members cannot open trades in a locked category.
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" disabled={pending || !dirty} onClick={save}>
          {pending ? 'Saving…' : 'Save settings'}
        </button>
        {saved ? <span className="hint" style={{ color: 'var(--green-dark)' }}>Saved</span> : null}
      </div>
    </div>
  );
}
