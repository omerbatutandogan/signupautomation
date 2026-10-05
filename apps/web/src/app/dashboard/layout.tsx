import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { NavLinks } from '@/components/nav-links';
import { requireMember } from '@/lib/auth';

export default async function DashboardLayout({ children }: LayoutProps<'/dashboard'>) {
  // Proxy iyimser kontrol yapar; burada gerçek üyelik (is_member) kontrolü.
  const viewer = await requireMember();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col gap-4 border-r bg-muted/30 px-3 py-4">
        <Link href="/dashboard" className="px-2.5 text-sm font-semibold">
          Signup Automation
        </Link>
        <NavLinks />
        <div className="mt-auto space-y-3">
          <Separator />
          <div className="px-2.5">
            <p className="truncate text-sm font-medium" title={viewer.email}>
              {viewer.email}
            </p>
            <p className="text-xs text-muted-foreground">{viewer.isAdmin ? 'Admin' : 'Member'}</p>
          </div>
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
              Sign out
            </Button>
          </form>
        </div>
      </aside>
      <main className="flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
