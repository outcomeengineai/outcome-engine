/**
 * Anchor fetch — scheduled, hourly. Source: NWS (api.weather.gov).
 *
 * For every open daily-temperature market on a known station: read the NWS
 * grid forecast for that station and date, and turn the market's strike band
 * into a probability using a forecast-error distribution by lead time.
 *
 * The probability is a claim. Every fetch is recorded, the scorer stamps the
 * current anchor into each thesis, and anchor_calibration grades the claim
 * against outcomes -- beside the market's own price graded the same way.
 * Nothing here moves a score. That comes later, on that table's evidence.
 *
 * NWS asks for an identifying User-Agent and is generous otherwise; one grid
 * fetch per station per run covers every market on that station.
 */

import { handler, json, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { getMarketsByTickers, type KalshiMarket } from '../_shared/kalshi.ts';
import { logActivity } from '../_shared/log.ts';
import { selectPaged } from '../_shared/batch.ts';

const NWS_HEADERS = {
  'User-Agent': 'outcome-engine (admin@outcomeengine.ai)',
  Accept: 'application/geo+json',
};

/** Daily temperature market tickers: KXHIGHNY-26SEP14-B75.5, KXLOWTCHI-26SEP14-T40. */
const TEMP_TICKER = /^KX(HIGH|LOW)[A-Z]*-(\d{2})([A-Z]{3})(\d{2})-[TB]/;
const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

interface Station {
  code: string;
  name: string;
  lat: number;
  lon: number;
  timezone: string | null;
  grid_url: string | null;
}

interface AnchorSettings {
  enabled: boolean;
  temperatureSigmaF: number[];
  maxLeadDays: number;
}

const DEFAULTS: AnchorSettings = { enabled: true, temperatureSigmaF: [2.2, 2.8, 3.5, 4.2, 5.0], maxLeadDays: 5 };

/**
 * Standard normal CDF via erf (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7).
 * Checked: phi(0) = 0.5, phi(1.96) = 0.975.
 */
function phi(x: number): number {
  const z = x / Math.SQRT2;
  const az = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * az);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-az * az);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

/**
 * P(recorded integer temperature lands in the band), treating the forecast
 * error as normal with sd sigma. Recorded values are whole degrees, so the
 * band edges sit on the half-degree: "74 or below" is T <= 74 is T < 74.5.
 */
function bandProbability(
  strikeType: string,
  floor: number | null,
  cap: number | null,
  forecastF: number,
  sigma: number,
): number | null {
  const below = (x: number) => phi((x - forecastF) / sigma);
  switch (strikeType) {
    case 'less':    return cap === null ? null : below(cap - 0.5);            // T <= cap-1
    case 'greater': return floor === null ? null : 1 - below(floor - 0.5);    // T >= floor
    case 'between': return floor === null || cap === null ? null : below(cap + 0.5) - below(floor - 0.5);
    default:        return null;
  }
}

function localDate(isoUtc: string, timezone: string | null): string {
  // YYYY-MM-DD of the instant in the station's zone.
  const d = new Date(isoUtc);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(d);
}

/** ISO-8601 duration as NWS emits it (PT13H, P1D, P1DT6H) -> milliseconds. */
function durationMs(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600_000 + Number(m[3] ?? 0) * 60_000;
}

/**
 * Which local calendar day an NWS max/min period belongs to: its MIDPOINT.
 * A daytime max runs ~8am-9pm local, midpoint midday -- that day. An
 * overnight min runs ~8pm-10am, midpoint ~3am -- the NEXT day, which is the
 * day whose recorded low it is. Using the period's start would file tonight's
 * low under today.
 */
function periodDay(validTime: string, timezone: string | null): string {
  const [start, dur] = validTime.split('/');
  const mid = new Date(new Date(start).getTime() + durationMs(dur ?? 'PT0H') / 2).toISOString();
  return localDate(mid, timezone);
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);
  const started = Date.now();

  const { data: versionId } = await db.rpc('current_stable_version');
  const { data: version } = versionId
    ? await db.from('model_versions').select('thresholds').eq('id', versionId).maybeSingle()
    : { data: null };
  const settings: AnchorSettings = {
    ...DEFAULTS,
    ...((version?.thresholds as { anchors?: Partial<AnchorSettings> })?.anchors ?? {}),
  };
  if (!settings.enabled) return json({ ok: true, skipped: 'anchors disabled on the stable version' });

  // ---- candidate markets: open daily-temperature markets being priced ----
  const candidates = await selectPaged<{ id: string; expected_close: string | null; close_time: string | null }>(
    (from, to) =>
      db
        .from('markets')
        .select('id, expected_close, close_time')
        .is('resolved_at', null)
        .in('cadence_tier', ['fast', 'slow'])
        .or('id.like.KXHIGH%,id.like.KXLOW%')
        .order('id')
        .range(from, to),
    { max: 3000, label: 'temperature candidates' },
  );
  const tickers = candidates.map((c) => c.id).filter((t) => TEMP_TICKER.test(t));
  if (tickers.length === 0) return json({ ok: true, markets: 0, reason: 'no open temperature markets in the priced tiers' });

  // Strike bands and rules come from the market object.
  const details = await getMarketsByTickers(tickers);
  const byTicker = new Map<string, KalshiMarket & Record<string, unknown>>();
  for (const m of details) if (m.ticker) byTicker.set(m.ticker, m as KalshiMarket & Record<string, unknown>);

  const { data: stationRows } = await db.from('anchor_stations').select('*');
  const stations = new Map<string, Station>();
  for (const s of (stationRows ?? []) as Station[]) stations.set(s.code, s);

  // ---- group by station, fetch each grid once ----------------------------
  const grids = new Map<string, { max: Map<string, number>; min: Map<string, number>; issued: string | null }>();
  const unknownStations = new Set<string>();
  const now = Date.now();

  async function gridFor(station: Station) {
    const cached = grids.get(station.code);
    if (cached) return cached;

    let gridUrl = station.grid_url;
    let timezone = station.timezone;
    if (!gridUrl) {
      const pts = await fetch(`https://api.weather.gov/points/${station.lat},${station.lon}`, { headers: NWS_HEADERS });
      if (!pts.ok) throw new Error(`NWS points ${station.code}: HTTP ${pts.status}`);
      const p = (await pts.json()).properties ?? {};
      gridUrl = p.forecastGridData;
      timezone = p.timeZone ?? null;
      await db.from('anchor_stations').update({ grid_url: gridUrl, timezone, updated_at: new Date().toISOString() }).eq('code', station.code);
      station.grid_url = gridUrl;
      station.timezone = timezone;
    }

    const res = await fetch(gridUrl!, { headers: NWS_HEADERS });
    if (!res.ok) throw new Error(`NWS grid ${station.code}: HTTP ${res.status}`);
    const gp = (await res.json()).properties ?? {};

    const series = (key: string) => {
      const out = new Map<string, number>();
      for (const v of (gp[key]?.values ?? []) as Array<{ validTime: string; value: number | null }>) {
        if (v.value === null || v.value === undefined) continue;
        const f = gp[key]?.uom === 'wmoUnit:degC' ? v.value * 9 / 5 + 32 : v.value;
        // First value wins for a date; NWS emits one max/min per local day.
        const day = periodDay(v.validTime, station.timezone);
        if (!out.has(day)) out.set(day, f);
      }
      return out;
    };

    const g = { max: series('maxTemperature'), min: series('minTemperature'), issued: gp.updateTime ?? null };
    grids.set(station.code, g);
    return g;
  }

  // ---- per market -----------------------------------------------------------
  let anchored = 0, skippedNoStation = 0, skippedNoForecast = 0, skippedLead = 0;
  const upserts: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];

  for (const ticker of tickers) {
    const m = byTicker.get(ticker);
    if (!m) continue;

    const tm = TEMP_TICKER.exec(ticker)!;
    const kind = tm[1] === 'HIGH' ? 'high' : 'low';
    const targetDate = `20${tm[2]}-${MONTHS[tm[3]] ?? '01'}-${tm[4]}`;

    const stationCode = ((m.rules_primary as string | undefined) ?? '').match(/\((CLI[A-Z0-9]+)\)/)?.[1];
    const station = stationCode ? stations.get(stationCode) : undefined;
    if (!station) { if (stationCode) unknownStations.add(stationCode); skippedNoStation++; continue; }

    let grid;
    try { grid = await gridFor(station); }
    catch (err) { console.warn(err instanceof Error ? err.message : err); skippedNoForecast++; continue; }

    const forecastF = (kind === 'high' ? grid.max : grid.min).get(targetDate);
    if (forecastF === undefined) { skippedNoForecast++; continue; }

    const expiry = (m.expected_expiration_time as string | undefined) ?? m.close_time;
    const leadHours = expiry ? (new Date(expiry).getTime() - now) / 3600_000 : 0;
    const leadDay = Math.max(0, Math.floor(leadHours / 24));
    if (leadDay > settings.maxLeadDays) { skippedLead++; continue; }
    const sigma = settings.temperatureSigmaF[Math.min(leadDay, settings.temperatureSigmaF.length - 1)];

    const floor = m.floor_strike === undefined || m.floor_strike === null ? null : Number(m.floor_strike);
    const cap = m.cap_strike === undefined || m.cap_strike === null ? null : Number(m.cap_strike);
    const prob = bandProbability(String(m.strike_type ?? ''), floor, cap, forecastF, sigma);
    if (prob === null) continue;

    const row = {
      market_id: ticker,
      source: 'nws',
      station: station.code,
      target_date: targetDate,
      kind,
      strike_type: String(m.strike_type),
      floor_strike: floor,
      cap_strike: cap,
      forecast_f: Number(forecastF.toFixed(2)),
      sigma_f: sigma,
      lead_hours: Number(leadHours.toFixed(1)),
      prob_yes: Number(Math.min(0.999, Math.max(0.001, prob)).toFixed(4)),
      forecast_issued_at: grid.issued,
      fetched_at: new Date().toISOString(),
    };
    upserts.push(row);
    history.push({
      market_id: ticker, source: 'nws', forecast_f: row.forecast_f, sigma_f: sigma,
      lead_hours: row.lead_hours, prob_yes: row.prob_yes, fetched_at: row.fetched_at,
    });
    anchored++;
  }

  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await db.from('market_anchors').upsert(upserts.slice(i, i + 500), { onConflict: 'market_id' });
    if (error) throw new Error(`anchor upsert failed: ${error.message}`);
  }
  for (let i = 0; i < history.length; i += 500) {
    const { error } = await db.from('anchor_history').insert(history.slice(i, i + 500));
    if (error) console.warn('anchor history insert failed:', error.message);
  }

  const result = {
    ok: true,
    candidates: tickers.length,
    anchored,
    stationsFetched: grids.size,
    skippedNoStation,
    skippedNoForecast,
    skippedLead,
    unknownStations: [...unknownStations],
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: 'anchors.completed',
    detail: `${anchored} of ${tickers.length} temperature markets anchored from ${grids.size} NWS grids` +
      (unknownStations.size ? `; unknown stations: ${[...unknownStations].join(', ')}` : ''),
    metadata: result,
  });

  return json(result);
}));
