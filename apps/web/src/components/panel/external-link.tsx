import { safeHttpUrl } from '@/lib/panel/format';

/**
 * Sheet'ten ya da taramadan gelen adrese bağlantı. Adres http(s) değilse
 * bağlantı yapılmaz, düz metin kalır. Yeni sekmede açılır ve açılan sayfaya
 * panelin adresi (referrer) ile pencere erişimi verilmez.
 */
export function ExternalLink({ url, children, className }: { url: string | null; children: React.ReactNode; className?: string }) {
  const href = safeHttpUrl(url);
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className ?? 'underline-offset-4 hover:underline'}>
      {children}
    </a>
  );
}
