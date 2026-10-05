import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getViewer } from '@/lib/auth';

export const metadata = { title: 'No access · Signup Automation Panel' };

/** Oturum var ama izin listesinde değil (ya da erişimi kaldırıldı). */
export default async function NotAllowedPage() {
  const viewer = await getViewer();

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>No access</CardTitle>
          <CardDescription>
            {viewer?.email ? (
              <>
                <span className="font-medium text-foreground">{viewer.email}</span> is not on the panel&apos;s
                invite list, or its access was removed.
              </>
            ) : (
              'Your account is not on the panel’s invite list.'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="outline" className="w-full">
              Sign out and use another account
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
