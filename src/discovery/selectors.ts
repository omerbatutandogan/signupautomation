/**
 * Seçici kararlılığı (saf).
 *
 * Keşif bir formu BİR kez okuyup alan seçicilerini config'e yazar; kayıt günü sayfa
 * yeniden yüklenir. Framework'lerin üretip her yüklemede ya da yapıda değiştirdiği
 * kimlikler (UUID, md5, React `useId`, zaman damgası, Mantine/Radix/Reach) o sırada
 * artık yoktur: dry-run'da "Selector bulunamadı" verenlerin 110'u böyleydi
 * (2026-10-06 toplu doğrulama). Bunlar `name`/`type` gibi kararlı özniteliklere
 * yer bırakmalı.
 */

/** Kimlik (başındaki # olmadan) her yüklemede değişen bir üretilmiş değer gibi mi? */
export function looksDynamicId(id: string): boolean {
  const s = id.replace(/^#/, '');
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(s) || // UUID
    /(^|[_-])[0-9a-f]{10,}$/i.test(s) || // md5/sha/uzun hex ("ctrl_4b96fac8…", "3ffab6823d8")
    /\d{6,}$/.test(s) || // uzun sayısal kuyruk: zaman damgası, sayaç ("_xfUid-5-1790795823", "email790437677")
    /^:r[0-9a-z]+:/i.test(s) || // React useId (eski biçim)
    /^(react-aria|radix-|headlessui-|mantine-|ember\d|ext-gen|_R_)/i.test(s) || // kütüphane üretimli
    /^css-[a-z0-9]{5,}$/i.test(s) // CSS-in-JS
  );
}

/**
 * Görünmez (özel stilli) onay kutusunu işaretleyen etiket seçicisi.
 * Kararlı id'de `label[for='id']`; üretilmiş id'de id'ye güvenilemez, kutuyu saran
 * etiket seçilir (`label:has(<alan seçicisi>)`).
 */
export function checkboxLabelSelector(id: string, fieldSelector: string): string {
  return looksDynamicId(id) ? `label:has(${fieldSelector})` : `label[for='${id}']`;
}

/** Bu `click` adımı bir onay kutusu etiketine mi tıklıyor? (dry-run'da güvenle yapılabilen tek tıklama) */
export function isCheckboxLabelClick(selector: string): boolean {
  return /^label(\[for=|:has\()/.test(selector.trim());
}

/**
 * Bir id için GEÇERLİ CSS seçici. `#registerUser.email` CSS'te "id=registerUser + sınıf=email"
 * demektir ve hiçbir şeyle eşleşmez; rakamla başlayan id de (`#3ffab…`) geçersizdir. Düz
 * tanımlayıcı olmayan id'ler öznitelik seçicisiyle yazılır.
 */
export function idSelector(id: string): string {
  return /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id='${id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}
