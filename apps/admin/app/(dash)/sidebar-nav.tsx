import { serverClient } from '@/lib/supabase';
import { NavItem } from './nav';

/**
 * The nav, in two flavours.
 *
 * SidebarNav is static and renders instantly. SidebarNavWithBadges is the
 * same nav after two small queries for the badges. The layout renders the
 * static one as the Suspense fallback and streams the badged one in, so the
 * frame of the dashboard never waits on the database -- which was the point
 * where every tab click used to hang.
 */
export function SidebarNav({
  degraded,
  pendingFees,
  failingJobs,
}: {
  degraded?: number;
  pendingFees?: number;
  failingJobs?: number;
} = {}) {
  return (
    <nav className="nav">
      <NavItem href="/">Home</NavItem>
      <NavItem href="/desk">Decision Desk</NavItem>
      <NavItem href="/positions">Positions</NavItem>

      <div className="nav-group eyebrow">Model</div>
      <NavItem href="/strategy" badge={degraded || undefined}>
        Strategy
      </NavItem>
      <NavItem href="/simulate">Simulate</NavItem>
      <NavItem href="/tags">Tag review</NavItem>

      <div className="nav-group eyebrow">Platform</div>
      <NavItem href="/accounts" badge={pendingFees || undefined}>
        Accounts
      </NavItem>
      <NavItem href="/activity">Activity</NavItem>
      <NavItem href="/health" badge={failingJobs || undefined}>
        Health
      </NavItem>
      <NavItem href="/settings">Settings</NavItem>
    </nav>
  );
}

export async function SidebarNavWithBadges() {
  const db = await serverClient();
  const [{ count: pendingFees }, { data: degraded }, { data: cron }] = await Promise.all([
    db
      .from('billing_periods')
      .select('id', { count: 'exact', head: true })
      .in('status', ['invoiced', 'grace', 'failed']),
    db.from('signal_health').select('signal').neq('status', 'healthy'),
    // A job failing twice in a row is a badge on the nav, not a line in a
    // log. The prune job failed for a week once; that is why.
    db.rpc('cron_health'),
  ]);
  const failingJobs = ((cron ?? []) as Array<{ consecutive_failures: number }>).filter(
    (j) => j.consecutive_failures >= 2,
  ).length;

  return (
    <SidebarNav
      degraded={degraded?.length ?? 0}
      pendingFees={pendingFees ?? 0}
      failingJobs={failingJobs}
    />
  );
}
