import { formatInt, formatShare } from '@/lib/panel/format';

export interface BarItem {
  key: string;
  label: string;
  description?: string;
  value: number;
}

/**
 * Kategoriler arası büyüklük karşılaştırması: yatay çubuk listesi.
 *
 * Tek seri → tek renk (kategorilere ayrı renk vermek çubuğun zaten gösterdiği
 * büyüklüğü ikinci kez kodlardı). Her satırın değeri ve payı metin olarak
 * yazılı; grafik kendi tablo karşılığıdır, hiçbir değer ipucuna gizlenmez.
 */
export function BarList({
  items,
  total,
  caption,
  valueHeader,
}: {
  items: BarItem[];
  /** Payların paydası (çubuk uzunluğu en büyük değere göredir). */
  total: number;
  caption: string;
  valueHeader: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Outcome</th>
          <th scope="col">Relative size</th>
          <th scope="col">{valueHeader}</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.key} data-bar={item.key} className="group/bar align-top">
            <th scope="row" className="w-[38%] py-2 pr-4 text-left font-normal">
              <span className="font-medium">{item.label}</span>
              {item.description && <span className="block text-xs text-muted-foreground">{item.description}</span>}
            </th>
            <td className="py-2" aria-hidden>
              <div className="flex h-5 items-center">
                <div
                  className="h-3 min-w-0.5 rounded-r-[4px] bg-(--viz-series-1) transition-opacity group-hover/bar:opacity-80"
                  style={{ width: `${(item.value / max) * 100}%` }}
                />
              </div>
            </td>
            <td className="w-20 py-2 pl-4 text-right font-medium tabular-nums">{formatInt(item.value)}</td>
            <td className="w-14 py-2 pl-2 text-right text-muted-foreground tabular-nums">{formatShare(item.value, total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
