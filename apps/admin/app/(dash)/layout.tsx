import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { currentProfile } from '@/lib/supabase';
import { SidebarNav, SidebarNavWithBadges } from './sidebar-nav';

export const dynamic = 'force-dynamic';

/**
 * Dashboard shell.
 *
 * The nav is a desktop sidebar, not a mobile tab bar with extra entries — this
 * surface is for sit-down work at 1440px, and the member app is the one built
 * for glances.
 */
export default async function DashLayout({ children }: { children: ReactNode }) {
  const profile = await currentProfile();
  if (!profile) redirect('/login');

  if (profile.role !== 'admin') {
    return (
      <div className="main" style={{ maxWidth: 560, margin: '80px auto' }}>
        <div className="card">
          <h1>Members use the app</h1>
          <p className="sub">
            This dashboard is for platform admins. Your account ({profile.email}) is a member —
            everything you need is in the Outcome Engine mobile app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" style={{ color: 'inherit' }}>
          <div className="wordmark">Outcome <span>Engine</span></div>
        </Link>
        <div className="eyebrow" style={{ marginTop: 5 }}>Admin</div>

        {/* The two badges are the only data the shell needs, and the shell
            should never wait on them: Suspense streams them in after the nav
            has painted, so a tab click shows the frame immediately. */}
        <Suspense fallback={<SidebarNav />}>
          <SidebarNavWithBadges />
        </Suspense>

        <div className="divider" />
        <div className="hint">
          {profile.display_name ?? profile.email}
          <br />
          <span className="eyebrow">Admin</span>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
