import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

/**
 * Supabase client for the member app.
 *
 * Anon key only. Everything the app can see is what RLS lets this member see,
 * and everything that must be validated before it is written — trades,
 * billing, scores — goes through an Edge Function rather than PostgREST.
 *
 * The session lives in AsyncStorage. Note what is NOT stored on the device:
 * the Kalshi private key. It is posted once during the connect flow and lives
 * in Vault thereafter; the app never holds it again and has no way to read it
 * back.
 */

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set. ' +
      'Copy .env.example to .env and fill them in.',
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // React Native has no URL bar for the magic link to land in; deep links
    // are handled explicitly in app/_layout.tsx instead.
    detectSessionInUrl: false,
  },
});

export const FUNCTIONS_URL = `${url}/functions/v1`;

/**
 * Call an Edge Function with the member's session attached.
 *
 * Errors come back as thrown Errors carrying the function's own message and
 * code, because those messages are written for the member to read — "Not
 * enough in your Kalshi account", not "400".
 */
export class ApiError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number) {
    super(message);
  }
}

export async function callFunction<T = any>(
  name: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();

  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey!,
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

  let payload: any = null;
  try { payload = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    throw new ApiError(
      payload?.error ?? `Request failed (${res.status})`,
      payload?.code ?? null,
      res.status,
    );
  }

  return payload as T;
}
