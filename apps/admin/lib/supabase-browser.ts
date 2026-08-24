'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-side Supabase client.
 *
 * Deliberately in its own module: `lib/supabase.ts` imports `next/headers`,
 * which cannot be pulled into a Client Component bundle. Keeping the two
 * apart means importing one never drags in the other.
 */
export function browserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set');
  }
  return createBrowserClient(url, key);
}
