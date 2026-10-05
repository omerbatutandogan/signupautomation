/**
 * Hesap = ürün + site.
 *
 * Sistem başta tek ürün (geo.new) için kuruldu: kilit, deneme kaydı,
 * kimlik bilgisi, tarayıcı profili ve şifre hep siteId'ye bağlıydı. 10
 * ürün aynı siteye kaydolacağı için bunların hepsi artık HESAP başına
 * tutulmalı — yoksa ikinci ürün birincinin kilidine, çerezlerine ve
 * "zaten tamamlandı" kaydına takılır.
 *
 * Hesap anahtarı varsayılan ürün için eskisi gibi yalın siteId; diğer
 * ürünler için `urun@site`. Böylece:
 *  - ledger şeması değişmiyor (locks/credentials site_id PRIMARY KEY;
 *    SQLite'ta birincil anahtar yerinde değiştirilemiyor, tablo baştan
 *    kurulmak zorunda kalırdı),
 *  - mevcut hesapların şifresi DEĞİŞMİYOR — şifre anahtardan türetiliyor
 *    ve varsayılan ürünün anahtarı aynı kaldı. Değişseydi açık 4 hesaba
 *    bir daha giremezdik.
 */

/** Sistemin ilk ürünü; mevcut kayıtların hepsi buna ait. */
export const DEFAULT_PRODUCT = 'geo-new';

/** Ürün id'si dosya adı (src/profile/<id>.json) olarak da kullanılıyor. */
const PRODUCT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertProductId(productId: string): void {
  if (!PRODUCT_ID.test(productId)) {
    throw new Error(
      `Geçersiz ürün id'si: "${productId}" — yalnızca küçük harf, rakam ve tire (örn. "geo-new")`,
    );
  }
}

/** Ledger, tarayıcı profili ve şifre türetmede kullanılan hesap anahtarı. */
export function accountKey(productId: string, siteId: string): string {
  assertProductId(productId);
  return productId === DEFAULT_PRODUCT ? siteId : `${productId}@${siteId}`;
}
