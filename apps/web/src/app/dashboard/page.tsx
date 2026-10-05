import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AttemptsTable } from '@/components/panel/attempts-table';
import { BarList } from '@/components/panel/bar-list';
import { PageHeader } from '@/components/panel/page-header';
import { Meter, StatTile } from '@/components/panel/stat-tile';
import { requireMember } from '@/lib/auth';
import { formatInt, formatShare, plural } from '@/lib/panel/format';
import { outcomeMeta, sortOutcomes } from '@/lib/panel/outcomes';
import {
  getAccountCounts,
  getConfigStates,
  getRecentAttempts,
  getSiteCounts,
  getUniqueOutcomes,
  getUsage,
} from '@/lib/panel/queries';

export const metadata = { title: 'Overview · Signup Automation Panel' };

export default async function OverviewPage() {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();

  const [accounts, sites, configs, outcomes, usage, recent] = await Promise.all([
    getAccountCounts(),
    getSiteCounts(),
    getConfigStates(),
    getUniqueOutcomes(),
    getUsage(),
    getRecentAttempts(6),
  ]);

  const byOutcome = new Map(outcomes.map((o) => [o.outcome, o.sites]));
  const bars = sortOutcomes(byOutcome.keys()).map((key) => ({
    key,
    label: outcomeMeta(key).label,
    value: byOutcome.get(key) ?? 0,
  }));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Overview"
        description="From every site in the sheet down to the accounts that are actually open."
      />

      <section aria-label="Pipeline" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          hero
          label="Accounts opened"
          value={formatInt(accounts.total)}
          hint={`${formatInt(accounts.opened)} opened by the automation · ${formatInt(accounts.existed)} already existed`}
          href="/dashboard/accounts"
        />
        <StatTile
          label="Unique sites in the sheet"
          value={formatInt(sites.uniqueSites)}
          hint={`${formatInt(sites.sheetRows)} rows (a site can be listed in several tabs)`}
          href="/dashboard/scan"
        />
        <StatTile
          label="Signup form found"
          value={formatInt(configs.total)}
          hint={`${formatShare(configs.total, sites.uniqueSites)} of unique sites have a signup config`}
          href="/dashboard/scan"
        />
        <StatTile
          label="Verified configs"
          value={formatInt(configs.verified)}
          hint={`${plural(configs.draft, 'draft')} still need a dry-run · ${formatInt(configs.awaitingMove)} await move approval`}
          href="/dashboard/queue"
        />
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Scan outcome by unique site</CardTitle>
            <CardDescription>
              What the discovery scan found for each of the {formatInt(sites.uniqueSites)} sites.{' '}
              <Link href="/dashboard/scan" className="underline underline-offset-4 hover:text-foreground">
                Scan map
              </Link>{' '}
              has the breakdown by tab.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarList
              items={bars}
              total={sites.uniqueSites}
              caption="Scan outcome by unique site"
              valueHeader="Unique sites"
            />
          </CardContent>
        </Card>

        <StatTile
          label="Real signups today"
          value={`${formatInt(usage.usedToday)} / ${formatInt(usage.dailyLimit)}`}
          hint="The daily limit is shared by all products and resets at midnight, Istanbul time. Dry-runs do not count."
          href="/dashboard/queue"
        >
          <Meter value={usage.usedToday} max={usage.dailyLimit} label="Real signups used today" />
        </StatTile>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Latest attempts</CardTitle>
          <CardDescription>
            The six most recent runs.{' '}
            <Link href="/dashboard/queue" className="underline underline-offset-4 hover:text-foreground">
              Queue
            </Link>{' '}
            has the full recent history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AttemptsTable attempts={recent} />
        </CardContent>
      </Card>
    </div>
  );
}
