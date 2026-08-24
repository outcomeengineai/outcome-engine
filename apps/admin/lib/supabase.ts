import 'server-only';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Supabase clients for the admin dashboard.
 *
 * Server-side only — `browserClient` lives in lib/supabase-browser.ts, because
 * `next/headers` cannot be bundled into a Client Component.
 *
 * Both use the ANON key and therefore run under RLS — the dashboard has no
 * service-role escape hatch. "Admin sees everything" is a property of the
 * policies (is_admin()), not of a privileged key sitting in the web app, so a
 * compromised dashboard session is bounded by what that account may already do.
 */

const url = () => {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!v) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  return v;
};

const anonKey = () => {
  const v = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!v) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set');
  return v;
};

export async function serverClient() {
  const store = await cookies();
  return createServerClient(url(), anonKey(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: Array<{ name: string; value: string; options?: CookieOptions }>) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

export interface AdminProfile {
  id: string;
  email: string;
  display_name: string | null;
  role: 'admin' | 'member';
  account_status: string;
}

/**
 * Load the signed-in profile, or null. Pages call `requireAdmin` instead;
 * this exists for the layout, which must render for members too (an admin is
 * also a member of their own platform).
 */
export async function currentProfile(): Promise<AdminProfile | null> {
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;

  const { data } = await db
    .from('users')
    .select('id, email, display_name, role, account_status')
    .eq('id', user.id)
    .single();

  return (data as AdminProfile) ?? null;
}
