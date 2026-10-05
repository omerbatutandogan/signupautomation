'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Boxes, LayoutDashboard, ListOrdered, Map, UserCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/scan', label: 'Scan map', icon: Map },
  { href: '/dashboard/accounts', label: 'Accounts', icon: UserCheck },
  { href: '/dashboard/queue', label: 'Queue', icon: ListOrdered },
  { href: '/dashboard/products', label: 'Products', icon: Boxes },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = href === '/dashboard' ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              active && 'bg-muted font-medium text-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
