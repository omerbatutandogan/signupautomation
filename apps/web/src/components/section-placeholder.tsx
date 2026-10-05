import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/** Henüz dolmamış bölüm — hangi aşamada ne geleceğini açıkça söyler. */
export function SectionPlaceholder({
  title,
  phase,
  items,
}: {
  title: string;
  phase: string;
  items: string[];
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <Badge variant="secondary">{phase}</Badge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>What this page will show</CardTitle>
          <CardDescription>Data is not connected yet.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
