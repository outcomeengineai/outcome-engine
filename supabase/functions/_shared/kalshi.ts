/**
 * Kalshi API v2 client.
 *
 * Auth model: API key id + RSA-PSS request signing. There is no bearer token
 * to expire and refresh — every request is signed independently over
 * `timestamp + METHOD + path`, so a signed request is valid only for the few
 * seconds Kalshi allows for clock skew. That removes the re-auth problem the
 * older session-token flow had, but it means the clock matters: a function
 * whose time has drifted will see 401s that look like bad credentials.
 *
 * Public market data needs no signature at all, which is why ingestion polls
 * per-MARKET with no credentials and every user fans out from that shared
 * data. Only trading and portfolio calls use a member's own key.
 */

import { KALSHI_API_BASE } from './env.ts';

export interface KalshiCredentials {
  keyId: string;
  privateKeyPem: string;
}

export class KalshiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
  ) {
    super(message ?? `Kalshi ${status}: ${body.slice(0, 300)}`);
  }

  /** 429 and 5xx are worth retrying; 4xx generally is not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

// --------------------------------------------------------------------------
// Signing
// --------------------------------------------------------------------------

const keyCache = new Map<string, CryptoKey>();

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cached = keyCache.get(pem);
  if (cached) return cached;

  if (!/BEGIN PRIVATE KEY/.test(pem)) {
    // Kalshi hands out PKCS#8. A PKCS#1 "BEGIN RSA PRIVATE KEY" block will not
    // import, and the resulting error is unhelpfully generic — say so here.
    throw new Error(
      'Kalshi private key must be PKCS#8 (-----BEGIN PRIVATE KEY-----). ' +
        'Convert PKCS#1 with: openssl pkcs8 -topk8 -nocrypt -in old.pem -out new.pem',
    );
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  keyCache.set(pem, key);
  return key;
}

/**
 * Sign `timestampMs + METHOD + path`. The path is the request path only —
 * no scheme, no host, and no query string.
 */
async function signRequest(
  creds: KalshiCredentials,
  method: string,
  path: string,
  timestampMs: string,
): Promise<string> {
  const key = await importPrivateKey(creds.privateKeyPem);
  const message = new TextEncoder().encode(`${timestampMs}${method.toUpperCase()}${path}`);
  const sig = await crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 }, // digest length for SHA-256
    key,
    message,
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  creds?: KalshiCredentials;
  /** Total attempts including the first. Backs off on 429/5xx only. */
  attempts?: number;
}

function buildQuery(query?: Record<string, string | number | undefined>): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One Kalshi call, with signing when credentials are supplied and exponential
 * backoff on 429s. Kalshi publishes per-key rate tiers; backing off rather
 * than hammering is the difference between a slow poll and a suspended key.
 */
export async function kalshiRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const attempts = opts.attempts ?? 4;
  const base = KALSHI_API_BASE();
  // The signature covers the full path including the API prefix, so derive it
  // from the configured base rather than assuming '/trade-api/v2'.
  const prefix = new URL(base).pathname.replace(/\/$/, '');
  const fullPath = `${prefix}${path}`;
  const url = `${base}${path}${buildQuery(opts.query)}`;

  let lastError: KalshiError | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    if (opts.creds) {
      const ts = Date.now().toString();
      headers['KALSHI-ACCESS-KEY'] = opts.creds.keyId;
      headers['KALSHI-ACCESS-TIMESTAMP'] = ts;
      headers['KALSHI-ACCESS-SIGNATURE'] = await signRequest(
        opts.creds,
        method,
        fullPath,
        ts,
      );
    }

    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }

    const body = await res.text();
    lastError = new KalshiError(res.status, body);

    if (!lastError.retryable || attempt === attempts - 1) throw lastError;

    // Honour Retry-After when Kalshi sends one; otherwise 500ms, 1s, 2s...
    const retryAfter = Number(res.headers.get('Retry-After'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 500 * 2 ** attempt;
    await sleep(delay);
  }

  throw lastError ?? new KalshiError(0, '', 'kalshi request failed');
}

// --------------------------------------------------------------------------
// Public market data — no credentials
// --------------------------------------------------------------------------

export interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  title: string;
  subtitle?: string;
  category?: string;
  status: string;
  close_time?: string;
  /** Cents, 1..99. */
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  previous_price?: number;
  volume?: number;
  volume_24h?: number;
  open_interest?: number;
  liquidity?: number;
  result?: string;
}

export async function listMarkets(params: {
  status?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ markets: KalshiMarket[]; cursor?: string }> {
  return await kalshiRequest('/markets', {
    query: { status: params.status, limit: params.limit ?? 200, cursor: params.cursor },
  });
}

/** Walk the cursor until `max` markets have been collected. */
export async function listAllMarkets(
  status: string,
  max: number,
): Promise<KalshiMarket[]> {
  const out: KalshiMarket[] = [];
  let cursor: string | undefined;

  while (out.length < max) {
    const page = await listMarkets({
      status,
      limit: Math.min(200, max - out.length),
      cursor,
    });
    const batch = page.markets ?? [];
    out.push(...batch);
    cursor = page.cursor;
    if (!cursor || batch.length === 0) break;
  }

  return out;
}

export async function getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
  return await kalshiRequest(`/markets/${encodeURIComponent(ticker)}`);
}

// --------------------------------------------------------------------------
// Authenticated — each call uses the CALLING USER's own key
// --------------------------------------------------------------------------

export interface KalshiBalance {
  /** Cents. */
  balance: number;
}

export async function getBalance(creds: KalshiCredentials): Promise<KalshiBalance> {
  return await kalshiRequest('/portfolio/balance', { creds });
}

export interface KalshiOrder {
  order_id: string;
  status: string;
  side: string;
  ticker: string;
  /** Contracts requested. */
  count?: number;
  /** Contracts actually filled — may be less than `count`. */
  taker_fill_count?: number;
  /** Cents. */
  taker_fill_cost?: number;
  yes_price?: number;
  no_price?: number;
}

/**
 * Place a limit order. Deliberately limit, not market: a market order on a
 * thin prediction market can fill far from the price the member was quoted,
 * and the stake card promised them a specific number.
 */
export async function createOrder(
  creds: KalshiCredentials,
  params: {
    ticker: string;
    side: 'yes' | 'no';
    count: number;
    /** Limit price in cents for the chosen side. */
    priceCents: number;
    clientOrderId: string;
  },
): Promise<{ order: KalshiOrder }> {
  const body: Record<string, unknown> = {
    ticker: params.ticker,
    client_order_id: params.clientOrderId,
    side: params.side,
    action: 'buy',
    count: params.count,
    type: 'limit',
  };
  if (params.side === 'yes') body.yes_price = params.priceCents;
  else body.no_price = params.priceCents;

  return await kalshiRequest('/portfolio/orders', {
    method: 'POST',
    body,
    creds,
    attempts: 1, // never retry an order — a retry could double-fill
  });
}

export async function getOrder(
  creds: KalshiCredentials,
  orderId: string,
): Promise<{ order: KalshiOrder }> {
  return await kalshiRequest(`/portfolio/orders/${encodeURIComponent(orderId)}`, { creds });
}

export interface KalshiSettlement {
  ticker: string;
  market_result: string;
  yes_count: number;
  no_count: number;
  /** Cents received on settlement. */
  revenue: number;
  /** Cents paid to enter. */
  cost?: number;
  settled_time: string;
}

export async function getSettlements(
  creds: KalshiCredentials,
  params: { limit?: number; cursor?: string; minTs?: number } = {},
): Promise<{ settlements: KalshiSettlement[]; cursor?: string }> {
  return await kalshiRequest('/portfolio/settlements', {
    creds,
    query: { limit: params.limit ?? 200, cursor: params.cursor, min_ts: params.minTs },
  });
}

/** Cheap credential check used by the connect flow. */
export async function verifyCredentials(
  creds: KalshiCredentials,
): Promise<{ ok: true; balanceCents: number } | { ok: false; reason: string }> {
  try {
    const { balance } = await getBalance(creds);
    return { ok: true, balanceCents: balance };
  } catch (err) {
    if (err instanceof KalshiError) {
      return {
        ok: false,
        reason: err.status === 401
          ? 'Kalshi rejected these credentials. Check the key id and that the key is active.'
          : `Kalshi returned ${err.status}.`,
      };
    }
    return { ok: false, reason: err instanceof Error ? err.message : 'unknown error' };
  }
}
