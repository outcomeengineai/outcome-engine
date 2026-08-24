/**
 * Environment access for Edge Functions (Deno).
 *
 * `require` throws on a missing variable rather than letting a function run
 * half-configured and fail later in a way that looks like a data problem.
 */

export function require(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

export function optional(name: string, fallback = ''): string {
  return Deno.env.get(name) ?? fallback;
}

export const SUPABASE_URL = () => require('SUPABASE_URL');
export const SERVICE_ROLE_KEY = () => require('SUPABASE_SERVICE_ROLE_KEY');
export const KALSHI_API_BASE = () =>
  optional('KALSHI_API_BASE', 'https://api.elections.kalshi.com/trade-api/v2');
export const CRON_SECRET = () => optional('CRON_SECRET');
