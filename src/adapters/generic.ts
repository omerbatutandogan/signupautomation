/**
 * Declarative adım yorumlayıcısı.
 *
 * "Yeni site = bir JSON dosyası" vaadinin çalıştığı yer. Kod yalnızca
 * JSON'un ifade edemediği durumlar için (overrides/) yazılır.
 */

import type { Locator } from 'playwright';
import { classifyPageText, PermanentError, TransientError } from '../core/errors.js';
import { detectCaptcha, needsHumanIntervention } from '../core/captcha.js';
import {
  moveMouseTo,
  pickDescription,
  randInt,
  resolveField,
  selectBestOption,
  truncateAtWord,
  typeHuman,
} from '../core/formfill.js';
import type {
  SignupContext,
  SignupResult,
  SiteAdapter,
  SiteConfig,
  Step,
} from '../core/types.js';

const DEFAULT_STEP_TIMEOUT = 10_000;

/** Adımın `when` koşulu sağlanıyor mu? */
async function shouldRun(ctx: SignupContext, step: Step): Promise<boolean> {
  if (!step.when) return true;

  if (step.when.urlContains && !ctx.page.url().includes(step.when.urlContains)) return false;

  if (step.when.visible) {
    const visible = await ctx.page
      .locator(step.when.visible)
      .first()
      .isVisible()
      .catch(() => false);
    if (!visible) return false;
  }

  return true;
}

/**
 * Selector'ı bekler. Bulunamazsa hatayı SINIFLANDIRIR:
 * sayfa yüklendiyse selector gerçekten yok (Permanent — config çürümüş),
 * sayfa yüklenmediyse ağ sorunu (Transient — tekrar denemeye değer).
 */
async function locate(ctx: SignupContext, selector: string, timeoutMs: number): Promise<Locator> {
  const locator = ctx.page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return locator;
  } catch (err) {
    const loaded = await ctx.page
      .evaluate(() => document.readyState === 'complete')
      .catch(() => false);

    if (loaded) {
      throw new PermanentError(`Selector bulunamadı: ${selector}`, {
        selector,
        url: ctx.page.url(),
      });
    }
    throw new TransientError(`Sayfa yüklenmedi, selector beklenemedi: ${selector}`, {
      selector,
      err: (err as Error).message,
    });
  }
}

/** Bir adımı yürütür. */
async function runStep(ctx: SignupContext, step: Step, index: number): Promise<void> {
  const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT;
  const log = ctx.log.child({ step: index, type: step.type });

  if (!(await shouldRun(ctx, step))) {
    log.debug('when koşulu sağlanmadı, atlanıyor');
    return;
  }

  switch (step.type) {
    case 'goto': {
      const url = step.url!.replace('{{signupUrl}}', ctx.site.signupUrl);
      log.info({ url }, 'Sayfaya gidiliyor');
      await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs * 2 });
      return;
    }

    case 'dismiss': {
      // Çerez banner'ı gibi opsiyonel kapatmalar — ilk tutan yeterli.
      for (const selector of step.selectors ?? []) {
        const loc = ctx.page.locator(selector).first();
        if (await loc.isVisible().catch(() => false)) {
          await loc.click().catch(() => undefined);
          log.debug({ selector }, 'Kapatıldı');
          return;
        }
      }
      return;
    }

    case 'fill': {
      const locator = await tryLocate(ctx, step, timeoutMs, log);
      if (!locator) return;

      let value: string;
      if (step.field === 'description') {
        const picked = await pickDescription(locator, ctx.profile);
        value = picked.value;
        log.debug({ max: picked.max, length: value.length }, 'Açıklama varyantı seçildi');
      } else if (step.value !== undefined) {
        value = step.value;
      } else {
        const resolved = resolveField(step.field!, ctx.profile, ctx.identity);
        if (resolved === null) {
          log.debug({ field: step.field }, 'Alan için değer yok, atlanıyor');
          return;
        }
        value = resolved;
      }

      await typeHuman(locator, value);

      // Sessiz kırpılma klasik görünmez hata — yazdıktan sonra doğrula.
      const actual = await locator.inputValue().catch(() => value);
      if (actual !== value) {
        log.warn(
          { expected: value.length, actual: actual.length },
          'Yazılan değer kırpıldı — alan sınırı beklenenden dar',
        );
        if (step.field === 'description' && actual.length > 0) {
          // Kırpılmışsa kabul et ama kayda geç; diğer alanlarda sorun ciddi.
          return;
        }
      }
      return;
    }

    case 'select': {
      const locator = await tryLocate(ctx, step, timeoutMs, log);
      if (!locator) return;

      const candidates =
        step.value !== undefined
          ? [step.value]
          : step.field === 'category'
            ? [ctx.profile.category.primary, ...ctx.profile.category.aliases]
            : [resolveField(step.field!, ctx.profile, ctx.identity) ?? ''];

      const value = await selectBestOption(locator, candidates.filter(Boolean));
      await locator.selectOption(value);
      log.debug({ value }, 'Seçenek seçildi');
      return;
    }

    case 'check': {
      const locator = await tryLocate(ctx, step, timeoutMs, log);
      if (!locator) return;
      if (!(await locator.isChecked().catch(() => false))) {
        await locator.check();
      }
      return;
    }

    case 'click': {
      const locator = await tryLocate(ctx, step, timeoutMs, log);
      if (!locator) return;

      if (ctx.dryRun) {
        log.info({ selector: step.selector }, 'DRY-RUN: tıklama atlandı');
        return;
      }

      await moveMouseTo(ctx.page, locator);
      await locator.click();
      return;
    }

    case 'upload': {
      const locator = await tryLocate(ctx, step, timeoutMs, log);
      if (!locator) return;
      await locator.setInputFiles(`src/profile/${step.file}`);
      return;
    }

    case 'waitFor': {
      await tryLocate(ctx, step, timeoutMs, log);
      return;
    }

    case 'expect': {
      // DRY-RUN'da submit atlandığı için submit-sonrası içerik hiç
      // görünmez. expect'i zorlamak, selector'ları doğru bulmuş bir
      // config'i yanlışlıkla "başarısız" saymaya yol açıyordu.
      // Dry-run'ın amacı selector doğrulaması, submit sonucu değil.
      if (ctx.dryRun) {
        log.info('DRY-RUN: expect adımı atlandı (submit edilmedi)');
        return;
      }

      const found = await Promise.race([
        ...(step.anyOf ?? []).map(async (selector) => {
          await ctx.page
            .locator(selector)
            .first()
            .waitFor({ state: 'visible', timeout: timeoutMs });
          return selector;
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]).catch(() => null);

      if (found) {
        log.debug({ found }, 'Beklenen içerik görüldü');
        return;
      }

      // Beklenen görünmedi — sayfa metni neden olduğunu söylüyor olabilir.
      const text = await ctx.page.innerText('body').catch(() => '');
      const classified = classifyPageText(text);
      if (classified) throw classified;

      if (step.optional) return;
      throw new PermanentError('Beklenen içerik görünmedi', {
        anyOf: step.anyOf,
        url: ctx.page.url(),
      });
    }

    case 'captchaGate': {
      const kind = await detectCaptcha(ctx.page);
      if (!kind) return;

      // v3/managed Turnstile sessizce skorlar — insan çağırmak gereksiz.
      if (!(await needsHumanIntervention(ctx.page, kind))) {
        log.info({ kind }, 'Passive captcha tespit edildi, devam ediliyor');
        return;
      }

      const shot = await ctx.artifacts.shot(`captcha-${kind}`);
      log.warn({ kind, shot }, 'İnsan müdahalesi gerekiyor');
      await ctx.requestHumanCaptcha(kind, shot);
      return;
    }

    case 'humanPause': {
      await ctx.page.waitForTimeout(randInt(step.minMs ?? 800, step.maxMs ?? 2500));
      return;
    }

    case 'custom': {
      // Faz 1'de uygulanmıyor — şemada var, override'lar için ayrılmış.
      throw new PermanentError(`custom adımı henüz desteklenmiyor: ${step.handler}`, {
        handler: step.handler,
      });
    }

    default: {
      const exhaustive: never = step.type;
      throw new PermanentError(`Bilinmeyen adım tipi: ${String(exhaustive)}`);
    }
  }
}

/** optional adımlarda selector yoksa null döner; değilse hata fırlatır. */
async function tryLocate(
  ctx: SignupContext,
  step: Step,
  timeoutMs: number,
  log: SignupContext['log'],
): Promise<Locator | null> {
  try {
    return await locate(ctx, step.selector!, timeoutMs);
  } catch (err) {
    if (step.optional) {
      log.debug({ selector: step.selector }, 'Opsiyonel adım atlandı (selector yok)');
      return null;
    }
    throw err;
  }
}

export function makeGenericAdapter(cfg: SiteConfig): SiteAdapter {
  return {
    id: cfg.id,
    name: cfg.name,
    risk: cfg.risk,
    emailLocalPart: cfg.emailLocalPart ?? cfg.id,
    verification: cfg.verification,

    async signup(ctx: SignupContext): Promise<SignupResult> {
      for (const [index, step] of cfg.steps.entries()) {
        await runStep(ctx, step, index);
      }

      // Submit sonrası sayfa metni "zaten kayıtlı" diyor olabilir.
      const text = await ctx.page.innerText('body').catch(() => '');
      const classified = classifyPageText(text);
      if (classified instanceof PermanentError && /zaten mevcut/i.test(classified.message)) {
        return { status: 'already_exists' };
      }
      if (classified) throw classified;

      return {
        status: 'submitted',
        needsEmailVerification: cfg.verification.mode !== 'none',
      };
    },

    async confirmSuccess(ctx: SignupContext): Promise<boolean> {
      if (!cfg.success) return true;

      if (cfg.success.afterVerifyUrlContains?.length) {
        const url = ctx.page.url();
        if (cfg.success.afterVerifyUrlContains.some((fragment) => url.includes(fragment))) {
          return true;
        }
      }

      for (const selector of cfg.success.anyOf ?? []) {
        const visible = await ctx.page
          .locator(selector)
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) return true;
      }

      return false;
    },
  };
}

export { truncateAtWord };
