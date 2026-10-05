/**
 * Ürün × site matrisi (saf).
 *
 * Satırlar: doğrulanmış config'i olan, en az bir hesabı bulunan ya da kaydı
 * takılmış (engelli) siteler — yani bugün üzerinde iş yapılabilen, yapılmış
 * ya da bir insanın bakması gerekenler. Taslaklar
 * (yüzlerce) burada satır olmaz; onlar kuyruk sayfasında sayı olarak durur.
 */

export type CellState = 'opened' | 'already_existed' | 'ready' | 'blocked' | 'high_risk' | 'none';

export interface MatrixConfig {
  siteId: string;
  risk: string | null;
}

export interface MatrixAccount {
  product_id: string;
  site_id: string;
  status: string;
}

export interface MatrixRow {
  siteId: string;
  /** Ürün sırası `productIds` ile aynı. */
  cells: CellState[];
}

export interface MatrixProduct {
  id: string;
  /** Yalnızca 'ready' ürün kayda girebilir. */
  status: string;
}

export interface MatrixBlocked {
  productId: string;
  siteId: string;
}

export function buildProductMatrix(
  products: readonly MatrixProduct[],
  verifiedConfigs: readonly MatrixConfig[],
  accounts: readonly MatrixAccount[],
  blocked: readonly MatrixBlocked[] = [],
): MatrixRow[] {
  const configBySite = new Map(verifiedConfigs.map((c) => [c.siteId, c]));
  const accountByKey = new Map(accounts.map((a) => [`${a.product_id}\u0000${a.site_id}`, a]));
  const blockedKeys = new Set(blocked.map((b) => `${b.productId}\u0000${b.siteId}`));
  const siteIds = [
    ...new Set([...configBySite.keys(), ...accounts.map((a) => a.site_id), ...blocked.map((b) => b.siteId)]),
  ].sort((a, b) => a.localeCompare(b));

  return siteIds.map((siteId) => ({
    siteId,
    cells: products.map((product): CellState => {
      const key = `${product.id}\u0000${siteId}`;
      const account = accountByKey.get(key);
      // Hesap varsa config'in bugünkü durumu (riskli, taslağa dönmüş…) onu değiştirmez.
      if (account) return account.status === 'already_existed' ? 'already_existed' : 'opened';
      // Son gerçek deneme terminal bitti: işçi kendiliğinden yeniden denemez.
      if (blockedKeys.has(key)) return 'blocked';
      const config = configBySite.get(siteId);
      if (!config) return 'none';
      if (config.risk === 'high') return 'high_risk';
      // Taslak/arşiv ürün kayda giremez: "hazır" göstermek yanıltırdı.
      return product.status === 'ready' ? 'ready' : 'none';
    }),
  }));
}
