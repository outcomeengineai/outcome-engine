/**
 * Request/response plumbing shared by every function: CORS, JSON helpers,
 * caller authentication, and a wrapper that turns a thrown error into a
 * logged 4xx/5xx instead of an opaque 500.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { CRON_SECRET, SERVICE_ROLE_KEY, SUPABASE_URL } from './env.ts';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** An error that carries the status code it should surface as. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function badRequest(message: string, code?: string): never {
  throw new HttpError(400, message, code);
}

export function forbidden(message: string, code?: string): never {
  throw new HttpError(403, message, code);
}

/** Service-role client. Bypasses RLS — only ever constructed server-side. */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL(), SERVICE_ROLE_KEY(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolve the calling member from their bearer token, then load their profile
 * with the service client. Two steps on purpose: the token proves identity,
 * the service client reads role/status without depending on RLS being right.
 */
export async function requireUser(req: Request, db: SupabaseClient) {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError(401, 'missing bearer token');

  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'invalid session');

  const { data: profile, error: pErr } = await db
    .from('users')
    .select('*')
    .eq('id', data.user.id)
    .single();
  if (pErr || !profile) throw new HttpError(403, 'no profile for this account');
  if (profile.account_status === 'removed') throw new HttpError(403, 'account removed');

  return profile;
}

export async function requireAdmin(req: Request, db: SupabaseClient) {
  const user = await requireUser(req, db);
  if (user.role !== 'admin') forbidden('admin only');
  return user;
}

/**
 * Who may invoke a scheduled function.
 *
 * Three ways in, checked cheapest first:
 *
 *   1. The bearer token IS the service role key. pg_cron already sends this
 *      in the Authorization header, so machine invocation needs no second
 *      credential. This is not a weakening: anyone holding the service role
 *      key can already do anything to the database directly, so requiring an
 *      additional shared secret alongside it protected nothing while adding
 *      a value that has to be kept in sync in two places — and drifted.
 *
 *   2. The x-cron-secret header matches CRON_SECRET. Kept for deployments
 *      that prefer a narrower credential than the service role key.
 *
 *   3. An admin session, so an operator can trigger a job by hand.
 */
export async function requireCronOrAdmin(req: Request, db: SupabaseClient) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token && isServiceRoleToken(token)) {
    return { via: 'service_role' as const };
  }

  const expected = CRON_SECRET();
  const provided = req.headers.get('x-cron-secret') ?? '';
  if (expected && provided && timingSafeEqual(expected, provided)) {
    return { via: 'cron' as const };
  }

  await requireAdmin(req, db);
  return { via: 'admin' as const };
}

/**
 * Does this bearer token carry service-role authority for this project?
 *
 * SECURITY: this reads the JWT's claims WITHOUT verifying its signature, and
 * that is only sound because Supabase's gateway already did. Every function
 * using this has `verify_jwt = true` in supabase/config.toml, so the platform
 * validates the signature against the project's JWT secret before the function
 * is invoked at all. A token that reaches this code is already known-authentic.
 * If a function is ever switched to verify_jwt = false, this check becomes
 * forgeable and must not be relied on.
 *
 * Why not just compare against SUPABASE_SERVICE_ROLE_KEY? Because the two
 * sides can hold different REPRESENTATIONS of the same authority — a legacy
 * 219-character JWT versus the newer sb_secret_ format — so string equality
 * fails even when both are valid. That mismatch is what kept every scheduled
 * call returning 401 while pg_cron reported success.
 */
function isServiceRoleToken(token: string): boolean {
  // Exact match first: cheapest, and correct whenever both sides agree on form.
  try {
    if (timingSafeEqual(token, SERVICE_ROLE_KEY())) return true;
  } catch {
    // SUPABASE_SERVICE_ROLE_KEY unset in this environment; fall through.
  }

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  try {
    let b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64)) as { role?: string };
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Wrap a handler: CORS preflight, error-to-status mapping, and a guarantee
 * that nothing throws past the edge as an unlabelled 500.
 */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, code: err.code ?? null }, err.status);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('unhandled function error:', message, err);
      return json({ error: message }, 500);
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
