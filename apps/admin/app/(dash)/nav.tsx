'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavItem({
  href,
  children,
  badge,
}: {
  href: string;
  children: ReactNode;
  badge?: number;
}) {
  const pathname = usePathname();
  // Exact match for the root, prefix match elsewhere, so /accounts/<id> keeps
  // Accounts highlighted.
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <Link href={href} className="nav-item" data-active={active}>
      <span>{children}</span>
      {badge ? <span className="pill pill-gold">{badge}</span> : null}
    </Link>
  );
}
