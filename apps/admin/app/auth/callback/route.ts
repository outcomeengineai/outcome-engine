import { NextResponse, type NextRequest } from 'next/server';
import { serverClient } from '@/lib/supabase';

/**
 * Magic-link landing route. Exchanges the code for a session cookie, then
 * sends the user on. A failed exchange goes back to /login with a reason
 * rather than a blank screen.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const db = await serverClient();
  const { error } = await db.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`,
    );
  }

  // Only ever redirect to a path on this origin — an open redirect here would
  // hand a freshly-minted session to whoever crafted the link.
  const safeNext = next.startsWith('/') ? next : '/';
  return NextResponse.redirect(`${origin}${safeNext}`);
}
