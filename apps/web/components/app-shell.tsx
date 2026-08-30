'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { Button, Spinner } from './ui/button';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Projects', icon: <GridIcon /> },
  { href: '/jobs', label: 'Job queue', icon: <QueueIcon /> },
  { href: '/templates', label: 'Templates', icon: <LayersIcon /> },
  { href: '/api-keys', label: 'API management', icon: <KeyIcon /> },
  { href: '/admin', label: 'Admin', icon: <ChartIcon />, adminOnly: true },
];

/**
 * Authenticated chrome. Every page inside it is guarded: an unauthenticated
 * visitor is redirected to sign-in rather than shown an empty shell.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-ink-muted" />
      </div>
    );
  }

  if (!user) return null;

  const items = NAV.filter((item) => !item.adminOnly || user.role === 'admin');

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-line px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-xs font-bold text-white">
            AE
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">AI Auto Editor</p>
            <p className="text-[10px] uppercase tracking-widest text-ink-faint">Pro</p>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 p-2" aria-label="Primary">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-brand-subtle text-ink'
                    : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                )}
              >
                <span className={cn('shrink-0', active ? 'text-brand' : 'text-ink-faint')}>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line p-3">
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-hover text-xs font-medium text-ink-muted">
              {(user.name ?? user.email).slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-ink">{user.name ?? 'Producer'}</p>
              <p className="truncate text-[11px] text-ink-faint">{user.email}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-canvas/85 px-4 backdrop-blur md:hidden">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-xs font-bold text-white">
            AE
          </div>
          <nav className="flex flex-1 gap-1 overflow-x-auto" aria-label="Primary">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs',
                  pathname.startsWith(item.href) ? 'bg-brand-subtle text-ink' : 'text-ink-muted',
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m12 3 9 5-9 5-9-5 9-5Z" strokeLinejoin="round" />
      <path d="m3 14 9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="8" cy="14" r="4" />
      <path d="m11 11 9-9 2 2-2 2 2 2-3 3-2-2-2 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeLinecap="round" />
    </svg>
  );
}
