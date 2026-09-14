import { serverClient } from '@/lib/supabase';
import { Pill } from '@/components/ui';

/**
 * Model review: what the model is actually getting right, net of fees.
 *
 * Every row is a labelled thesis -- a scored market that has since resolved
 * -- bucketed by tier and score band. Two numbers matter per bucket, and
 * they are shown side by side on purpose: the hit rate with its confidence
 * interval, and the BREAKEVEN rate at that bucket's average entry price.
 * A hit rate above 50% means nothing; a lower confidence bound above
 * breakeven means edge. The recommendation is derived from that test, not
 * from opinion, and says "not enough evidence" when that is the truth.
 */

interface Bucket {
  tier: string;
  category: string;
  band: number;
  n: number;
  hits: number;
  hit_rate: number;
  ci_low: number;
  ci_high: number;
  avg_price: number | null;
  breakeven_rate: number | null;
  avg_net_cents: number | null;
  priced_n: number;
}

interface Rec {
  tier: string;
  labelled: number;
  edge_bands: number[];
  suggested_surface: number | null;
  suggested_strong: number | null;
  verdict: string;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
const cents = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}¢`;

export async function ModelReview() {
  const db = await serverClient();
  const [{ data: buckets }, { data: recs }, { data: settings }] = await Promise.all([
    db.rpc('calibration_table', { p_version: null, p_by_category: false }),
    db.rpc('calibration_recommendations', { p_version: null }),
    db.from('platform_settings').select('key, value').in('key', ['calibration_start', 'calibration_min_sample']),
  ]);

  const rows = (buckets ?? []) as Bucket[];
  const recommendations = (recs ?? []) as Rec[];
  const setting = new Map((settings ?? []).map((s: { key: string; value: unknown }) => [s.key, s.value]));
  const since = String(setting.get('calibration_start') ?? '').replace(/"/g, '').slice(0, 10);
  const minSample = Number(setting.get('calibration_min_sample') ?? 30);
  const total = rows.reduce((s, r) => s + Number(r.n), 0);

  const tiers = [...new Set(rows.map((r) => r.tier))].sort();

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="eyebrow">Model review · net of Kalshi fees</div>
          <h2 style={{ marginTop: 4 }}>What the model is getting right</h2>
          <div className="hint">
            {total.toLocaleString()} labelled calls since {since || 'the universe fix'}. A band counts as edge
            only when the lower bound of its hit rate clears breakeven at its average entry price with at
            least {minSample} labels.
          </div>
        </div>
      </div>

      {total === 0 ? (
        <div className="empty" style={{ marginTop: 16 }}>
          No labelled calls yet. Labels arrive as fast-tier markets resolve — typically within a day of
          scoring. Nothing to tune until then, and that is the honest state.
        </div>
      ) : (
        <>
          <div className="grid grid-3" style={{ marginTop: 16, gap: 12 }}>
            {recommendations.map((r) => (
              <div key={r.tier} className="card" style={{ margin: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <Pill tone="muted">{r.tier}</Pill>
                  <span className="hint">{Number(r.labelled).toLocaleString()} labels</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 13.5 }}>{r.verdict}</div>
                {r.suggested_surface !== null ? (
                  <div className="hint" style={{ marginTop: 6 }}>
                    Evidence supports surface ≥ {Number(r.suggested_surface).toFixed(1)}
                    {r.suggested_strong !== null ? ` · strong ≥ ${Number(r.suggested_strong).toFixed(1)}` : ''}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {tiers.map((tier) => (
            <div key={tier} style={{ marginTop: 18 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>{tier} tier · by score band</div>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Band</th>
                      <th>Labels</th>
                      <th>Hit rate</th>
                      <th>95% interval</th>
                      <th>Avg entry</th>
                      <th>Breakeven</th>
                      <th>Net / contract</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.filter((r) => r.tier === tier).map((r) => {
                      const enough = Number(r.n) >= minSample;
                      const edge = enough && r.breakeven_rate !== null && Number(r.ci_low) > Number(r.breakeven_rate);
                      const loss = enough && r.breakeven_rate !== null && Number(r.ci_high) < Number(r.breakeven_rate);
                      return (
                        <tr key={`${tier}-${r.band}`}>
                          <td className="num">{r.band}.0–{r.band}.9</td>
                          <td className="num">{Number(r.n)}</td>
                          <td className="num">{pct(r.hit_rate)}</td>
                          <td className="num hint">{pct(r.ci_low)} – {pct(r.ci_high)}</td>
                          <td className="num">{r.avg_price === null ? '—' : `${Number(r.avg_price).toFixed(0)}¢`}</td>
                          <td className="num">{pct(r.breakeven_rate)}</td>
                          <td className="num">{cents(r.avg_net_cents)}</td>
                          <td>
                            {!enough ? <Pill tone="muted">thin</Pill>
                              : edge ? <Pill tone="green">edge</Pill>
                              : loss ? <Pill tone="red">loses</Pill>
                              : <Pill tone="muted">unclear</Pill>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="hint" style={{ marginTop: 12 }}>
            Entry price is what the model&apos;s side cost at scoring time. Net per contract is the average
            realised outcome after the 7% × p × (1−p) trading fee. Rows without a recorded entry price
            (labels from before the scorer stored it) count toward hit rate but not toward net.
          </div>
        </>
      )}
    </div>
  );
}
