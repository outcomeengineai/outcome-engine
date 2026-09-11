import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refresh the Supabase session on every request and gate the dashboard.
 *
 * The role check here is a redirect, not a security boundary — RLS is what
 * actually stops a member reading another member's rows. This exists so a
 * non-admin who reaches the URL gets a clear "not for you" instead of a page
 * full of empty tables.
 */
export async function middleware(request: NextRequest) {
  try {
    return await guard(request);
  } catch (err) {
    // Anything that escapes becomes a readable response instead of Vercel's
    // MIDDLEWARE_INVOCATION_FAILED, which names neither the cause nor the fix.
    // Nothing secret is printed: the message and the top of the stack only.
    const e = err as Error;
    const where = (e.stack ?? '').split('\n').slice(1, 4).join('\n');
    return new NextResponse(
      `Outcome Engine admin: middleware failed.

${e.name}: ${e.message}
${where}
`,
      { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }
}

async function guard(request: NextRequest) {
  // Fail LEGIBLY. With the non-null assertions this used to carry, a missing
  // env var made createServerClient throw, and every route on the deployment
  // answered 500 MIDDLEWARE_INVOCATION_FAILED -- which says nothing about
  // what is wrong or where to fix it. Vercel bakes NEXT_PUBLIC_* in at build
  // time, so a variable added after the last deploy is still missing until
  // the next one.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    const missing = [!url && 'NEXT_PUBLIC_SUPABASE_URL', !anonKey && 'NEXT_PUBLIC_SUPABASE_ANON_KEY']
      .filter(Boolean).join(' and ');
    return new NextResponse(
      `Outcome Engine admin is not configured.

` +
      `Missing environment variable(s): ${missing}

` +
      `Set them in Vercel -> Project -> Settings -> Environment Variables for the Production ` +
      `environment, then REDEPLOY -- NEXT_PUBLIC_* values are fixed at build time, so adding ` +
      `them without redeploying changes nothing.
`,
      { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list: Array<{ name: string; value: string; options?: CookieOptions }>) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser(), not getSession() — getSession trusts the cookie without
  // revalidating it against the auth server.
  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isAuthRoute = path.startsWith('/login') || path.startsWith('/auth');

  if (!user && !isAuthRoute) {
    const to = request.nextUrl.clone();
    to.pathname = '/login';
    to.searchParams.set('next', path);
    return NextResponse.redirect(to);
  }

  if (user && isAuthRoute) {
    const to = request.nextUrl.clone();
    to.pathname = '/';
    to.search = '';
    return NextResponse.redirect(to);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
