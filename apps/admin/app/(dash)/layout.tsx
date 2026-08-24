import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentProfile, serverClient } from '@/lib/supabase';
import { NavItem } from './nav';

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

  // Two badges the admin should never have to go looking for.
  const db = await serverClient();
  const [{ count: pendingFees }, { data: degraded }] = await Promise.all([
    db
      .from('billing_periods')
      .select('id', { count: 'exact', head: true })
      .in('status', ['invoiced', 'grace', 'failed']),
    db.from('signal_health').select('signal').neq('status', 'healthy'),
  ]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" style={{ color: 'inherit' }}>
          <div className="wordmark">Outcome <span>Engine</span></div>
        </Link>
        <div className="eyebrow" style={{ marginTop: 5 }}>Admin</div>

        <nav className="nav">
          <NavItem href="/">Home</NavItem>
          <NavItem href="/desk">Decision Desk</NavItem>
          <NavItem href="/positions">Positions</NavItem>

          <div className="nav-group eyebrow">Model</div>
          <NavItem href="/strategy" badge={degraded?.length ? degraded.length : undefined}>
            Strategy
          </NavItem>
          <NavItem href="/simulate">Simulate</NavItem>
          <NavItem href="/tags">Tag review</NavItem>

          <div className="nav-group eyebrow">Platform</div>
          <NavItem href="/accounts" badge={pendingFees || undefined}>Accounts</NavItem>
          <NavItem href="/activity">Activity</NavItem>
          <NavItem href="/settings">Settings</NavItem>
        </nav>

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
