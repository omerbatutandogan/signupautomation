import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarList } from '@/components/panel/bar-list';
import { ExternalLink } from '@/components/panel/external-link';
import { PageHeader } from '@/components/panel/page-header';
import { ScanHeatTable, scanFilterHref, type ScanFilter } from '@/components/panel/scan-heat-table';
import { StatTile } from '@/components/panel/stat-tile';
import { requireMember } from '@/lib/auth';
import { formatInt, formatShare, hostOf, plural } from '@/lib/panel/format';
import { outcomeMeta, pivotScanMap, sortOutcomes } from '@/lib/panel/outcomes';
import {
  SITE_MAX_PAGE,
  SITE_PAGE_SIZE,
  getConfigStates,
  getScanMap,
  getScanProgress,
  getSiteCounts,
  getSiteStatusPage,
  getUniqueOutcomes,
} from '@/lib/panel/queries';

export const metadata = { title: 'Scan map · Signup Automation Panel' };

const CONFIG_STATE_LABEL: Record<string, string> = {
  verified: 'Verified',
  draft_unverified: 'Unverified draft',
  awaiting_move_approval: 'Awaiting move approval',
  invalid: 'Invalid file',
};

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ScanPage({ searchParams }: PageProps<'/dashboard/scan'>) {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();

  const query = await searchParams;
  const [scanMap, progressRows, siteCounts, uniqueOutcomes, configs] = await Promise.all([
    getScanMap(),
    getScanProgress(),
    getSiteCounts(),
    getUniqueOutcomes(),
    getConfigStates(),
  ]);

  const matrix = pivotScanMap(scanMap);
  const progress = new Map(progressRows.map((p) => [p.tab, p]));

  // Süzgeç yalnızca tabloda gerçekten var olan sekme/sonuç için geçerli.
  const tabParam = one(query.tab);
  const outcomeParam = one(query.outcome);
  const filter: ScanFilter = {
    tab: matrix.tabs.some((t) => t.tab === tabParam) ? tabParam : undefined,
    outcome: outcomeParam !== undefined && matrix.columns.includes(outcomeParam) ? outcomeParam : undefined,
  };
  const hasFilter = filter.tab !== undefined || filter.outcome !== undefined;
  const pageNumber = Math.min(SITE_MAX_PAGE, Math.max(0, (Number.parseInt(one(query.page) ?? '1', 10) || 1) - 1));
  const sites = hasFilter ? await getSiteStatusPage(filter, pageNumber) : null;

  const byOutcome = new Map(uniqueOutcomes.map((o) => [o.outcome, o.sites]));
  const bars = sortOutcomes(byOutcome.keys()).map((key) => ({
    key,
    label: outcomeMeta(key).label,
    description: outcomeMeta(key).description,
    value: byOutcome.get(key) ?? 0,
  }));

  const notScanned = matrix.totals.not_scanned ?? 0;
  const errorRows = matrix.totals.error ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader title="Scan map" description="What the discovery scan found for every site in the sheet." />

      <section aria-label="Scan totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Sheet rows" value={formatInt(matrix.grandTotal)} hint={`across ${plural(matrix.tabs.length, 'tab')}`} />
        <StatTile
          label="Unique sites"
          value={formatInt(siteCounts.uniqueSites)}
          hint="A site listed in several tabs counts once here."
        />
        <StatTile
          label="Rows with a conclusive result"
          value={formatShare(matrix.grandTotal - notScanned - errorRows, matrix.grandTotal)}
          hint={
            notScanned > 0
              ? `${plural(notScanned, 'row')} not reached by a scan yet`
              : 'Every row was reached by a scan or already had a config.'
          }
        />
        <StatTile
          label="Scan errors"
          value={formatInt(errorRows)}
          hint={`rows where the scan did not finish · ${plural(byOutcome.get('error') ?? 0, 'unique site')} with no other result`}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Outcome by unique site</CardTitle>
          <CardDescription>
            Each of the {formatInt(siteCounts.uniqueSites)} sites counted once. When a site is listed in several tabs, the
            most informative result wins (a real finding beats an unfinished scan).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BarList items={bars} total={siteCounts.uniqueSites} caption="Scan outcome by unique site" valueHeader="Unique sites" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Outcome by sheet tab</CardTitle>
          <CardDescription>
            Sheet rows, not unique sites. Select a number to list those sites below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {matrix.tabs.length === 0 ? (
            <p className="text-sm text-muted-foreground">The sheet has not been synced yet.</p>
          ) : (
            <div className="space-y-4">
              <ScanHeatTable matrix={matrix} progress={progress} selected={filter} />
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  What the columns mean
                </summary>
                <dl className="mt-2 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                  {matrix.columns.map((outcome) => (
                    <div key={outcome}>
                      <dt className="font-medium">{outcomeMeta(outcome).label}</dt>
                      <dd className="text-muted-foreground">{outcomeMeta(outcome).description}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </div>
          )}
        </CardContent>
      </Card>

      {sites && (
        <Card id="sites" className="scroll-mt-6">
          <CardHeader>
            <CardTitle>
              {filter.tab !== undefined ? filter.tab.trim() : 'All tabs'}
              {filter.outcome !== undefined && ` · ${outcomeMeta(filter.outcome).label}`}
            </CardTitle>
            <CardDescription>
              {sites.rows.length === 0
                ? 'No rows on this page.'
                : `Rows ${formatInt(pageNumber * SITE_PAGE_SIZE + 1)}–${formatInt(pageNumber * SITE_PAGE_SIZE + sites.rows.length)} of ${formatInt(sites.total)}.`}{' '}
              <Link href="/dashboard/scan" className="underline underline-offset-4 hover:text-foreground">
                Clear selection
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {sites.rows.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tab</TableHead>
                    <TableHead className="text-right">Row</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Signup page</TableHead>
                    <TableHead>Config</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.rows.map((s) => (
                    <TableRow key={`${s.tab}\u0000${s.site_id}`} data-site={s.site_id ?? ''}>
                      <TableCell className="text-muted-foreground">{s.tab?.trim()}</TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">{s.row_number}</TableCell>
                      <TableCell className="font-medium">
                        <ExternalLink url={s.website}>{hostOf(s.website) ?? s.site_id}</ExternalLink>
                      </TableCell>
                      <TableCell>{outcomeMeta(s.outcome ?? '').label}</TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground" title={s.reason ?? undefined}>
                        {s.reason ?? ''}
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground" title={s.signup_url ?? undefined}>
                        {s.signup_url ? <ExternalLink url={s.signup_url}>{s.signup_url}</ExternalLink> : ''}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.config_state ? (CONFIG_STATE_LABEL[s.config_state] ?? s.config_state) : ''}
                        {s.risk === 'high' && ' · high risk'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {(pageNumber > 0 || (pageNumber + 1) * SITE_PAGE_SIZE < sites.total) && (
              <nav aria-label="Pages" className="flex items-center gap-4 text-sm">
                {pageNumber > 0 && (
                  <Link href={scanFilterHref(filter, pageNumber - 1)} className="underline underline-offset-4">
                    Previous {SITE_PAGE_SIZE}
                  </Link>
                )}
                {(pageNumber + 1) * SITE_PAGE_SIZE < sites.total && (
                  <Link href={scanFilterHref(filter, pageNumber + 1)} className="underline underline-offset-4">
                    Next {SITE_PAGE_SIZE}
                  </Link>
                )}
              </nav>
            )}
          </CardContent>
        </Card>
      )}

      <section aria-labelledby="config-states" className="space-y-3">
        <div>
          <h2 id="config-states" className="text-base font-medium">
            Signup configs
          </h2>
          <p className="text-sm text-muted-foreground">
            One config per unique site with a signup form. Only verified configs are used for real signups.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            label="Verified"
            value={formatInt(configs.verified)}
            hint="Passed a dry-run against the live site, or written by hand."
          />
          <StatTile
            label="Unverified drafts"
            value={formatInt(configs.draft)}
            hint="Generated by the scan. Each needs one dry-run before it can be used."
          />
          <StatTile
            label="Awaiting move approval"
            value={formatInt(configs.awaitingMove)}
            hint="The site redirected to a different domain. A person must confirm it is the same site."
          />
        </div>
        {configs.invalid > 0 && (
          <p className="text-sm text-muted-foreground">
            {plural(configs.invalid, 'config file')} could not be parsed and {configs.invalid === 1 ? 'is' : 'are'} ignored.
          </p>
        )}
      </section>
    </div>
  );
}
