/**
 * The two public Supabase settings, read once and normalised.
 *
 * Accepts either the full project URL or the bare project ref. The
 * distinction is not obvious from the Supabase dashboard -- "Project URL" and
 * "Reference ID" sit on different settings pages -- and the bare ref pasted
 * into NEXT_PUBLIC_SUPABASE_URL took the whole admin site down with
 * "Invalid supabaseUrl". A 20-character lowercase ref is unambiguous, so
 * accept it and build the URL rather than fail on a paste that anyone could
 * make.
 *
 * Safe to import from server, browser and edge code: it touches nothing but
 * process.env.
 */

const REF = /^[a-z0-9]{20}$/;

/**
 * Trim, drop a trailing slash, and forgive the two most common paste
 * mistakes: wrapping quotes, and the whole `NAME=value` line from a .env
 * file pasted into the value field. The latter is exactly what production
 * had -- the URL was correct and carried its own variable name as a prefix.
 */
function clean(v: string | undefined): string {
  let s = (v ?? '').trim();
  s = s.replace(/^NEXT_PUBLIC_SUPABASE_(URL|ANON_KEY)\s*=\s*/, '');
  s = s.replace(/^["']|["']$/g, '').trim();
  return s.replace(/\/+$/, '');
}

export function supabaseUrl(): string {
  const raw = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (!raw) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  if (REF.test(raw)) return `https://${raw}.supabase.co`;
  if (/^https?:\/\//.test(raw)) return raw;
  throw new Error(
    `NEXT_PUBLIC_SUPABASE_URL must be the project URL (https://<ref>.supabase.co) ` +
    `or the bare project ref; got "${raw}"`,
  );
}

export function supabaseAnonKey(): string {
  const raw = clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!raw) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set');
  return raw;
}
