import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ExternalLink } from '@/components/panel/external-link';
import { PageHeader } from '@/components/panel/page-header';
import { MatrixCell } from '@/components/panel/status-label';
import { requireMember } from '@/lib/auth';
import { formatInt, hostOf, plural } from '@/lib/panel/format';
import { buildProductMatrix } from '@/lib/panel/matrix';
import {
  getAccountCells,
  getBacklog,
  getBlockedPairs,
  getProducts,
  getVerifiedConfigs,
  getWebsites,
} from '@/lib/panel/queries';

export const metadata = { title: 'Products · Signup Automation Panel' };

const PRODUCT_STATUS: Record<string, { label: string; hint: string }> = {
  ready: { label: 'Ready', hint: 'The profile is complete and can be used for signups.' },
  draft: { label: 'Draft', hint: 'The profile is incomplete; the product cannot be signed up yet.' },
  archived: { label: 'Archived', hint: 'No longer signed up anywhere.' },
};

export default async function ProductsPage() {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();

  const [products, backlog, configs, accounts, blocked] = await Promise.all([
    getProducts(),
    getBacklog(),
    getVerifiedConfigs(),
    getAccountCells(),
    getBlockedPairs(),
  ]);

  const backlogById = new Map(backlog.map((b) => [b.productId, b]));
  const rows = buildProductMatrix(products, configs, accounts, blocked);
  const websites = await getWebsites(rows.map((r) => r.siteId));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Products"
        description="The products being listed and where each one stands, site by site. Editing products from the panel arrives in phase 2."
      />

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">No products yet.</p>
      ) : (
        <section aria-label="Products" className="grid gap-4 lg:grid-cols-2">
          {products.map((p) => {
            const b = backlogById.get(p.id);
            const status = PRODUCT_STATUS[p.status] ?? { label: p.status, hint: '' };
            return (
              <Card key={p.id} data-product={p.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {p.name ?? p.id}
                    <Badge variant={p.status === 'ready' ? 'secondary' : 'outline'} title={status.hint}>
                      {status.label}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    <span className="font-mono text-xs">{p.id}</span>
                    {p.website && (
                      <>
                        {' · '}
                        <ExternalLink url={p.website}>{hostOf(p.website) ?? p.website}</ExternalLink>
                      </>
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {p.tagline && <p className="text-sm">{p.tagline}</p>}
                  <dl className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Accounts</dt>
                      <dd className="text-lg font-semibold">{formatInt(b?.opened ?? 0)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Ready to sign up</dt>
                      <dd className="text-lg font-semibold">{formatInt(b?.ready ?? 0)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Drafts to verify</dt>
                      <dd className="text-lg font-semibold">{formatInt(b?.unverified ?? 0)}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            );
          })}
        </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Product × site</CardTitle>
          <CardDescription>
            {plural(rows.length, 'site')} with a verified config, an existing account or a signup that needs attention.
            Unverified drafts are counted above, not listed here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 || products.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing to show yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[28rem] text-sm">
                <caption className="sr-only">Account status of each product on each site</caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="w-64 py-2 pr-4 font-medium">
                      Site
                    </th>
                    {products.map((p) => (
                      <th key={p.id} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                        {p.name ?? p.id}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.siteId} data-site={row.siteId} className="border-b last:border-0 hover:bg-muted/50">
                      <th scope="row" className="py-2 pr-4 text-left font-medium whitespace-nowrap">
                        <ExternalLink url={websites.get(row.siteId) ?? null}>
                          {hostOf(websites.get(row.siteId)) ?? row.siteId}
                        </ExternalLink>
                      </th>
                      {row.cells.map((state, i) => (
                        <td key={products[i]?.id ?? i} data-cell={state} className="px-3 py-2">
                          <MatrixCell state={state} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
