import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AttemptsTable } from '@/components/panel/attempts-table';
import { DailyAttemptsChart } from '@/components/panel/daily-attempts-chart';
import { PageHeader } from '@/components/panel/page-header';
import { Meter, StatTile } from '@/components/panel/stat-tile';
import { requireMember } from '@/lib/auth';
import { AttemptStatus } from '@/components/panel/status-label';
import { formatDate, formatDay, formatInt, plural, todayInPanelTz } from '@/lib/panel/format';
import { getBacklog, getBlockedPairs, getDailyAttempts, getRecentAttempts, getUsage } from '@/lib/panel/queries';
import { estimateEta, type Eta } from '@/lib/panel/queue';

export const metadata = { title: 'Queue · Signup Automation Panel' };

const CHART_DAYS = 14;

function etaText(eta: Eta, today: string): string {
  if (eta.days === 0 || eta.finishDay === null) return 'Nothing waiting';
  if (eta.finishDay === today) return 'Today';
  return `${plural(eta.days, 'day')}`;
}

export default async function QueuePage() {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();

  const [backlog, blocked, usage, daily, recent] = await Promise.all([
    getBacklog(),
    getBlockedPairs(),
    getUsage(),
    getDailyAttempts(CHART_DAYS),
    getRecentAttempts(30),
  ]);

  const today = todayInPanelTz(new Date());
  const ready = backlog.reduce((n, b) => n + b.ready, 0);
  const drafts = backlog.reduce((n, b) => n + b.unverified, 0);
  const readyEta = estimateEta(ready, usage.dailyLimit, usage.usedToday, today);
  // Üst sınır: bütün taslaklar dry-run'dan geçerse kuyruğun tamamı.
  const fullEta = estimateEta(ready + drafts, usage.dailyLimit, usage.usedToday, today);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Queue"
        description="What is waiting to be signed up, how fast it can go, and what ran recently."
      />

      <section aria-label="Queue totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Ready to sign up"
          value={formatInt(ready)}
          hint="Product–site pairs the worker can sign up now: verified config, no account, not high risk, no final failure."
        />
        <StatTile
          label="Real signups today"
          value={`${formatInt(usage.usedToday)} / ${formatInt(usage.dailyLimit)}`}
          hint="Shared by all products. Resets at midnight, Istanbul time."
        >
          <Meter value={usage.usedToday} max={usage.dailyLimit} label="Real signups used today" />
        </StatTile>
        <StatTile
          label="Ready queue finishes in"
          value={etaText(readyEta, today)}
          hint={
            readyEta.finishDay
              ? `At ${usage.dailyLimit} a day, done by ${formatDay(readyEta.finishDay)}.`
              : 'Verify more drafts to fill the queue.'
          }
        />
        <StatTile
          label="Drafts awaiting a dry-run"
          value={formatInt(drafts)}
          hint={
            fullEta.finishDay
              ? `If every draft verifies, the whole queue takes ${plural(fullEta.days, 'day')} (until ${formatDay(fullEta.finishDay)}).`
              : 'Dry-runs are not limited by the daily cap.'
          }
        />
      </section>

      {blocked.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>
              {plural(blocked.length, 'signup')} ended in a final failure. The worker will not retry {blocked.length === 1 ? 'it' : 'them'} on
              its own: someone has to look at the site (fix the config or sign up by hand) and rerun it with force.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Last result</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {blocked.map((b) => (
                  <TableRow key={`${b.productId}\u0000${b.siteId}`} data-blocked={`${b.productId}@${b.siteId}`}>
                    <TableCell className="font-medium">{b.siteId}</TableCell>
                    <TableCell className="text-muted-foreground">{b.productId}</TableCell>
                    <TableCell>
                      <AttemptStatus status={b.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDate(b.finishedAt)}</TableCell>
                    <TableCell className="max-w-md truncate text-muted-foreground" title={b.note ?? undefined}>
                      {b.note ?? ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Real signup attempts per day</CardTitle>
          <CardDescription>
            Last {CHART_DAYS} days, Istanbul time. Counts every real attempt, successful or not; dry-runs are excluded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DailyAttemptsChart days={daily} limit={usage.dailyLimit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backlog by product</CardTitle>
          <CardDescription>How many sites each product can still be signed up on.</CardDescription>
        </CardHeader>
        <CardContent>
          {backlog.length === 0 ? (
            <p className="text-sm text-muted-foreground">No products yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                  <TableHead className="text-right">Ready</TableHead>
                  <TableHead className="text-right">Needs attention</TableHead>
                  <TableHead className="text-right">Drafts to verify</TableHead>
                  <TableHead className="text-right">Awaiting move approval</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backlog.map((b) => (
                  <TableRow key={b.productId} data-product={b.productId}>
                    <TableCell className="font-medium">{b.productId}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(b.opened)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(b.ready)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(b.blocked)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(b.unverified)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(b.awaitingMove)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent attempts</CardTitle>
          <CardDescription>The 30 most recent runs, real signups and dry-runs.</CardDescription>
        </CardHeader>
        <CardContent>
          <AttemptsTable attempts={recent} />
        </CardContent>
      </Card>
    </div>
  );
}
