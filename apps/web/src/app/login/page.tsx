import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getViewer } from '@/lib/auth';
import { safeNext } from '@/lib/safe-next';
import { GoogleButton } from './google-button';

export const metadata = { title: 'Sign in · Signup Automation Panel' };

/** Hata kodları /auth/callback'ten gelir; kullanıcıya anlaşılır metin. */
const ERRORS: Record<string, { title: string; body: string }> = {
  not_allowed: {
    title: 'This Google account is not invited',
    body: 'Ask an admin to add your email to the panel, then sign in again with the same account.',
  },
  auth_failed: {
    title: 'Sign-in did not complete',
    body: 'Google or the auth server returned an error. Please try again.',
  },
};

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === 'string' ? params.next : null);
  const errorKey = typeof params.error === 'string' ? params.error : null;
  const error = errorKey ? (ERRORS[errorKey] ?? ERRORS.auth_failed) : null;

  const viewer = await getViewer();
  if (viewer?.isMember) redirect(next);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Signup Automation Panel — invited team members only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{error.title}</AlertTitle>
              <AlertDescription>{error.body}</AlertDescription>
            </Alert>
          ) : null}
          <GoogleButton next={next} />
          <p className="text-xs text-muted-foreground">
            By signing in you agree to our{' '}
            <Link href="/privacy" className="underline underline-offset-4">
              privacy policy
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
