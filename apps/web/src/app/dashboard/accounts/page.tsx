import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExternalLink } from '@/components/panel/external-link';
import { PageHeader } from '@/components/panel/page-header';
import { StatTile } from '@/components/panel/stat-tile';
import { AccountStatus, PasswordSource, VerificationStatus } from '@/components/panel/status-label';
import { requireMember } from '@/lib/auth';
import { formatDate, formatInt, hostOf } from '@/lib/panel/format';
import { getAccounts } from '@/lib/panel/queries';

export const metadata = { title: 'Accounts · Signup Automation Panel' };

export default async function AccountsPage() {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();

  const accounts = await getAccounts();
  const opened = accounts.filter((a) => a.status === 'opened').length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Accounts"
        description="Every account that exists on a listed site, per product. Dry-runs are not accounts and are not shown."
      />

      <section aria-label="Account totals" className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Accounts" value={formatInt(accounts.length)} />
        <StatTile label="Opened by the automation" value={formatInt(opened)} />
        <StatTile
          label="Already existed"
          value={formatInt(accounts.length - opened)}
          hint="Found already registered when the automation reached the site."
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>All accounts</CardTitle>
          <CardDescription>
            Passwords are never stored: they are derived on the worker when needed. Showing a password from the panel
            arrives with the worker (phase 3).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No accounts yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead>Password</TableHead>
                  <TableHead>Since</TableHead>
                  <TableHead>Profile</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.id} data-account={`${a.product_id}@${a.site_id}`} title={a.note ?? undefined}>
                    <TableCell className="font-medium">
                      <ExternalLink url={a.website}>{hostOf(a.website) ?? a.site_id}</ExternalLink>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.product_id}</TableCell>
                    <TableCell>{a.email ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{a.username ?? '—'}</TableCell>
                    <TableCell>
                      <AccountStatus status={a.status} />
                    </TableCell>
                    <TableCell>
                      <VerificationStatus verification={a.verification} />
                    </TableCell>
                    <TableCell>
                      <PasswordSource source={a.password_source} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDate(a.opened_at)}</TableCell>
                    <TableCell>
                      {a.profile_url ? <ExternalLink url={a.profile_url}>Open</ExternalLink> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
