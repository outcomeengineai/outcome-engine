'use client';

import { usePathname } from 'next/navigation';

/**
 * Route-level error boundary for the dashboard.
 *
 * In production Next strips a server error's message before it reaches the
 * browser and leaves only a digest. That is right for a public site and
 * useless for a single-admin dashboard, where the person seeing the error
 * is the person who has to fix it. This cannot recover the message -- only
 * the Vercel runtime logs have it -- but it can say which route failed, show
 * the digest to match against those logs, and offer a retry, instead of a
 * blank paragraph of boilerplate.
 */
export default function DashError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="card" style={{ maxWidth: 640, margin: '40px auto' }}>
      <div className="eyebrow">Something failed while rendering</div>
      <h1 style={{ marginTop: 6 }}>{pathname}</h1>
      <p className="sub">
        The server hit an error building this page. Production hides the message; the
        Vercel runtime logs for the admin project have it, and the digest below matches
        the log line.
      </p>
      <pre className="mono" style={{ padding: 12, borderRadius: 8, overflowX: 'auto' }}>
        {`route:  ${pathname}\ndigest: ${error.digest ?? '(none)'}\n${
          process.env.NODE_ENV !== 'production' ? `message: ${error.message}` : ''
        }`}
      </pre>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => reset()}>Try again</button>
        <a className="btn btn-ghost" href="/">Home</a>
      </div>
    </div>
  );
}
