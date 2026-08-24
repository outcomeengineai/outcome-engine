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
 * Scheduled functions accept either the cron shared secret or an admin
 * session, so an operator can trigger a job by hand from the dashboard.
 *
 * If CRON_SECRET is unset the header check is skipped — acceptable only
 * because these functions still sit behind Supabase's own JWT gate.
 */
export async function requireCronOrAdmin(req: Request, db: SupabaseClient) {
  const expected = CRON_SECRET();
  const provided = req.headers.get('x-cron-secret') ?? '';
  if (expected && provided && timingSafeEqual(expected, provided)) return { via: 'cron' as const };
  if (!expected) return { via: 'cron' as const };
  await requireAdmin(req, db);
  return { via: 'admin' as const };
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
