/**
 * Mail ile gelen doğrulama kodunu sayfaya girer.
 *
 * Çoğu site tek bir alan ister; modern sitelerin çoğu ise rakam başına bir kutu çizer (6 küçük kutu).
 * Tek `fill` ikinci durumda yalnızca ilk kutuyu doldurup kodu bozardı (bufferapps).
 */

import type { Page } from 'playwright';
import { ManualReviewError } from './errors.js';

export async function enterVerificationCode(
  page: Page,
  spec: { codeSelector?: string; codeSubmitSelector?: string },
  code: string,
): Promise<void> {
  if (!spec.codeSelector) throw new ManualReviewError('codeSelector tanımsız');
  const boxes = page.locator(spec.codeSelector);
  await boxes.first().waitFor({ state: 'visible', timeout: 15_000 });

  const count = await boxes.count();
  if (count > 1) {
    // Rakam başına bir kutu: her rakamı kendi kutusuna, gerçek tuş olaylarıyla yaz.
    if (count !== code.length) {
      throw new ManualReviewError(`Doğrulama kodu ${code.length} haneli ama sayfada ${count} kutu var`, { selector: spec.codeSelector });
    }
    for (let i = 0; i < count; i++) {
      await boxes.nth(i).click();
      await boxes.nth(i).pressSequentially(code[i]!, { delay: 40 });
    }
  } else {
    await boxes.first().fill(code);
  }

  if (spec.codeSubmitSelector) await page.locator(spec.codeSubmitSelector).first().click();
  else await page.keyboard.press('Enter');
}
