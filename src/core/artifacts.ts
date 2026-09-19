/**
 * Hata anı kanıt yakalama.
 *
 * 200 JSON config zamanla çürüyecek. Ekran görüntüsü + HTML, "neden
 * başarısız oldu" sorusunu dakikalar yerine saniyeler içinde cevaplayan şey —
 * disk tasarrufu için atlanmamalı.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import type { Artifacts } from './types.js';

const ARTIFACT_ROOT = 'artifacts';

/** Dosya adı için güvenli hale getirir. */
function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'artifact';
}

export function createArtifacts(page: Page, runId: string, siteId: string): Artifacts {
  const dir = `${ARTIFACT_ROOT}/${runId}/${siteId}`;
  let ensured = false;

  const ensureDir = async (): Promise<void> => {
    if (ensured) return;
    await mkdir(dir, { recursive: true });
    ensured = true;
  };

  return {
    dir,

    async shot(name: string): Promise<string> {
      await ensureDir();
      const path = `${dir}/${safe(name)}.png`;
      // Artifact yakalama asıl hatayı gölgelememeli — sessizce başarısız ol.
      await page.screenshot({ path, fullPage: true }).catch(() => undefined);
      return path;
    },

    async html(name: string): Promise<string> {
      await ensureDir();
      const path = `${dir}/${safe(name)}.html`;
      try {
        await writeFile(path, await page.content());
      } catch {
        /* yoksay */
      }
      return path;
    },
  };
}

/** Hata anında ekran görüntüsü + HTML'i birlikte yakalar. */
export async function captureFailure(
  artifacts: Artifacts,
  name: string,
): Promise<{ shot: string; html: string }> {
  const [shot, html] = await Promise.all([artifacts.shot(name), artifacts.html(name)]);
  return { shot, html };
}
