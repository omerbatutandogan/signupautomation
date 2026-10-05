import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/panel/format';
import type { Attempt } from '@/lib/panel/queries';
import { AttemptStatus } from './status-label';

/** Son denemeler: gerçek kayıt ve dry-run ayrı etiketlenir (dry-run hesap açmaz). */
export function AttemptsTable({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) {
    return <p className="text-sm text-muted-foreground">No attempts recorded yet.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Site</TableHead>
          <TableHead>Product</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Result</TableHead>
          <TableHead>Note</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {attempts.map((a) => (
          <TableRow key={a.id} data-attempt={a.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(a.started_at)}</TableCell>
            <TableCell className="font-medium">{a.site_id}</TableCell>
            <TableCell className="text-muted-foreground">{a.product_id}</TableCell>
            <TableCell className="text-muted-foreground">{a.dry_run ? 'Dry-run' : 'Real signup'}</TableCell>
            <TableCell>
              <AttemptStatus status={a.status} />
            </TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground" title={a.note ?? undefined}>
              {a.note ?? ''}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
