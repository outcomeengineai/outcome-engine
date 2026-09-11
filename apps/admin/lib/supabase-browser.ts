'use client';

import { createBrowserClient } from '@supabase/ssr';
import { supabaseAnonKey, supabaseUrl } from './supabase-env';

/**
 * Browser-side Supabase client.
 *
 * Deliberately in its own module: `lib/supabase.ts` imports `next/headers`,
 * which cannot be pulled into a Client Component bundle. Keeping the two
 * apart means importing one never drags in the other.
 */
export function browserClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}
