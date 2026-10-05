import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * Açık ana sayfa — Google OAuth uygulamasının istediği "uygulama ana
 * sayfası". Panel içeriği burada yok; yalnızca ne olduğu ve giriş.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <p className="text-sm font-medium text-muted-foreground">Internal tool</p>
      <h1 className="text-3xl font-semibold tracking-tight">Signup Automation Panel</h1>
      <p className="text-base leading-relaxed text-muted-foreground">
        An internal control panel to track directory-site registrations for the products we list: which
        sites were scanned, which accounts were opened, and what is queued next. Access is limited to
        invited team members.
      </p>
      <div className="flex items-center gap-3">
        <Button render={<Link href="/login" />}>Sign in</Button>
        <Button variant="ghost" render={<Link href="/privacy" />}>
          Privacy policy
        </Button>
      </div>
    </main>
  );
}
