/**
 * Crypto price anchors — every five minutes. Source: Coinbase Exchange
 * (public, no key), one of the constituents of the CF Benchmarks index
 * these markets settle on.
 *
 * Kalshi's daily BTC/ETH markets (KXBTCD, KXBTC, KXETHD, KXETH) settle on
 * the 60-second average of BRTI/ERTI at 5pm Eastern, on a ladder of
 * strikes. For each open rung: the current spot, the time to settlement,
 * and the realised volatility of the last day of five-minute candles give
 * a fair probability under a zero-drift lognormal. That number is a claim;
 * the scorer stamps it into every thesis and anchor_calibration grades it
 * against the outcome beside the market's own price. Nothing here moves a
 * score.
 *
 * Why five minutes and not hourly like weather: spot moves. An hour-old
 * anchor on a market that settles in ninety minutes is not a claim about
 * anything.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { getMarketsByTickers, type KalshiMarket } from '../_shared/kalshi.ts';
import { logActivity } from '../_shared/log.ts';
import { selectPaged } from '../_shared/batch.ts';
import {
  annualToStepSigma,
  logReturnSigma,
  priceBandProbability,
  scaleSigma,
} from '../_shared/outcome-shared.mjs';

export interface CryptoSettings {
  enabled: boolean;
  /** Hours of five-minute candles behind the realised volatility. */
  lookbackHours: number;
  /** Volatility never assumed below this annualised figure; a quiet day is not a zero-risk day. */
  volFloorAnnual: number;
  /** Inside this window the 60-second settlement average is a lottery; withdraw. */
  minLeadMinutes: number;
  /** anchor_history gets a row when the probability moves this much, or hourly. */
  historyDeltaProb: number;
}

export const CRYPTO_DEFAULTS: CryptoSettings = {
  enabled: true,
  lookbackHours: 24,
  volFloorAnnual: 0.3,
  minLeadMinutes: 2,
  historyDeltaProb: 0.02,
};

/** KXBTCD-26SEP2417-T95249.99, KXBTC-26SEP2417-B95125, KXETHD-26SEP2417-T3459.99. Not KXBTC15M. */
const CRYPTO_TICKER = /^KX(BTC|ETH)D?-(\d{2})([A-Z]{3})(\d{2})(\d{2})-/;
const PRODUCTS: Record<string, string> = { BTC: 'BTC-USD', ETH: 'ETH-USD' };
const CANDLE_SECONDS = 300;
const HISTORY_RETENTION_DAYS = 14;
const REQUEST_TIMEOUT_MS = 8_000;

interface AssetQuote {
  product: string;
  spot: number;
  quotedAt: string;
  /** Per-five-minute log-return sd, floored. */
  sigmaStep: number;
  candles: number;
  floored: boolean;
}

async function coinbase<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.exchange.coinbase.com${path}`, {
    headers: { 'User-Agent': 'outcome-engine/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Coinbase ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function runCryptoAnchors(db: SupabaseClient, settings: CryptoSettings) {
  const started = Date.now();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // ---- candidate markets: open BTC/ETH price markets being priced --------
  const candidates = await selectPaged<{ id: string }>(
    (from, to) =>
      db
        .from('markets')
        .select('id')
        .is('resolved_at', null)
        .in('cadence_tier', ['fast', 'slow'])
        .or('id.like.KXBTC%,id.like.KXETH%')
        .order('id')
        .range(from, to),
    { max: 3000, label: 'crypto candidates' },
  );
  const tickers = candidates.map((c) => c.id).filter((t) => CRYPTO_TICKER.test(t));
  if (tickers.length === 0) return { ok: true, source: 'coinbase', markets: 0, reason: 'no open crypto price markets in the priced tiers' };

  const details = await getMarketsByTickers(tickers);
  const byTicker = new Map<string, KalshiMarket & Record<string, unknown>>();
  for (const m of details) if (m.ticker) byTicker.set(m.ticker, m as KalshiMarket & Record<string, unknown>);

  // ---- one quote per asset ---------------------------------------------------
  const quotes = new Map<string, AssetQuote>();
  const floorStep = annualToStepSigma(settings.volFloorAnnual, CANDLE_SECONDS);
  async function quoteFor(sym: string): Promise<AssetQuote> {
    const cached = quotes.get(sym);
    if (cached) return cached;
    const product = PRODUCTS[sym]!;
    const [ticker, candles] = await Promise.all([
      coinbase<{ price: string; time: string }>(`/products/${product}/ticker`),
      coinbase<Array<[number, number, number, number, number, number]>>(`/products/${product}/candles?granularity=${CANDLE_SECONDS}`),
    ]);
    // Coinbase returns [time, low, high, open, close, volume], newest first.
    const want = Math.round((settings.lookbackHours * 3600) / CANDLE_SECONDS);
    const closes = [...candles]
      .sort((a, b) => a[0] - b[0])
      .slice(-want)
      .map((c) => Number(c[4]));
    const realised = logReturnSigma(closes);
    const sigmaStep = Math.max(realised ?? 0, floorStep);
    const q: AssetQuote = {
      product,
      spot: Number(ticker.price),
      quotedAt: ticker.time,
      sigmaStep,
      candles: closes.length,
      floored: (realised ?? 0) < floorStep,
    };
    if (!(q.spot > 0)) throw new Error(`Coinbase ${product}: bad spot ${ticker.price}`);
    quotes.set(sym, q);
    return q;
  }

  // ---- what we said last time, for the history rule ------------------------
  const previous = new Map<string, { prob_yes: number; fetched_at: string }>();
  for (let i = 0; i < tickers.length; i += 200) {
    const { data } = await db
      .from('market_anchors')
      .select('market_id, prob_yes, fetched_at')
      .in('market_id', tickers.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ market_id: string; prob_yes: number; fetched_at: string }>) {
      previous.set(r.market_id, { prob_yes: Number(r.prob_yes), fetched_at: r.fetched_at });
    }
  }

  // ---- per market -------------------------------------------------------------
  let anchored = 0, skippedNoQuote = 0, skippedNoDetail = 0, skippedBand = 0, withdrawn = 0;
  const upserts: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  const withdrawals: string[] = [];
  const hourAgo = now - 3600_000;

  for (const ticker of tickers) {
    const m = byTicker.get(ticker);
    if (!m) { skippedNoDetail++; continue; }
    const sym = CRYPTO_TICKER.exec(ticker)![1]!;

    let q: AssetQuote;
    try { q = await quoteFor(sym); }
    catch (err) { console.warn(err instanceof Error ? err.message : err); skippedNoQuote++; continue; }

    const closeMs = Date.parse(String(m.close_time ?? ''));
    if (!Number.isFinite(closeMs)) { skippedNoDetail++; continue; }
    const leadMinutes = (closeMs - now) / 60_000;
    if (leadMinutes < settings.minLeadMinutes) {
      if (previous.has(ticker)) withdrawals.push(ticker);
      withdrawn++;
      continue;
    }

    const steps = (closeMs - now) / 1000 / CANDLE_SECONDS;
    const sigma = scaleSigma(q.sigmaStep, steps);
    const floor = m.floor_strike === undefined || m.floor_strike === null ? null : Number(m.floor_strike);
    const cap = m.cap_strike === undefined || m.cap_strike === null ? null : Number(m.cap_strike);
    const prob = priceBandProbability(String(m.strike_type ?? ''), floor, cap, q.spot, sigma);
    if (prob === null) { skippedBand++; continue; }

    const probYes = Number(Math.min(0.999, Math.max(0.001, prob)).toFixed(4));
    const row = {
      market_id: ticker,
      source: 'coinbase',
      station: null,
      target_date: new Date(closeMs).toISOString().slice(0, 10),
      kind: 'price',
      strike_type: String(m.strike_type),
      floor_strike: floor,
      cap_strike: cap,
      forecast_f: Number(q.spot.toFixed(2)),          // spot, in dollars
      sigma_f: Number((q.spot * sigma).toFixed(2)),   // horizon sd, in dollars
      lead_hours: Number((leadMinutes / 60).toFixed(1)),
      prob_yes: probYes,
      forecast_issued_at: q.quotedAt,
      fetched_at: nowIso,
    };
    upserts.push(row);

    const prev = previous.get(ticker);
    if (!prev || Math.abs(prev.prob_yes - probYes) >= settings.historyDeltaProb || Date.parse(prev.fetched_at) < hourAgo) {
      history.push({
        market_id: ticker, source: 'coinbase', forecast_f: row.forecast_f, sigma_f: row.sigma_f,
        lead_hours: row.lead_hours, prob_yes: probYes, fetched_at: nowIso,
      });
    }
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
  for (let i = 0; i < withdrawals.length; i += 200) {
    const { error } = await db.from('market_anchors').delete().in('market_id', withdrawals.slice(i, i + 200));
    if (error) console.warn('anchor withdrawal failed:', error.message);
  }
  // History retention, both sources. Small table, cheap delete.
  await db.from('anchor_history').delete().lt('fetched_at', new Date(now - HISTORY_RETENTION_DAYS * 86_400_000).toISOString());

  const result = {
    ok: true,
    source: 'coinbase',
    candidates: tickers.length,
    anchored,
    withdrawn,
    skippedNoQuote,
    skippedNoDetail,
    skippedBand,
    historyRows: history.length,
    quotes: Object.fromEntries([...quotes].map(([k, v]) => [k, { spot: v.spot, sigmaStep: Number(v.sigmaStep.toFixed(6)), candles: v.candles, floored: v.floored }])),
    ms: Date.now() - started,
  };
  await logActivity(db, {
    type: 'anchors.crypto',
    detail: `${anchored} of ${tickers.length} crypto price markets anchored from Coinbase spot` +
      (withdrawn ? `; ${withdrawn} inside the settlement window` : ''),
    metadata: result,
  });
  return result;
}
