/**
 * Girişten sonra dönülecek yol — yalnızca uygulama içi göreli yollar.
 *
 * `?next=https://kotu.site` ya da `//kotu.site` kabul edilseydi giriş
 * sayfası açık yönlendirme (open redirect) olurdu: kurban bizim
 * domainimizden geçip saldırganın sitesine giderdi.
 */
export function safeNext(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (!raw) return fallback;
  // Yalnızca tek "/" ile başlayan yol; "//host", "/\host" ve şema reddedilir.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  try {
    // Göreli yol kukla bir kökle çözülünce kök değişmemeli.
    const resolved = new URL(raw, 'http://panel.invalid');
    if (resolved.origin !== 'http://panel.invalid') return fallback;
    const path = resolved.pathname + resolved.search + resolved.hash;
    // Kontrol normalleştirmeden SONRA da yapılmalı: "/.//evil" çözülünce
    // "//evil" oluyor ve tarayıcı bunu başka bir siteye gider sanıyor.
    if (path.startsWith('//') || path.startsWith('/\\')) return fallback;
    return path;
  } catch {
    return fallback;
  }
}
