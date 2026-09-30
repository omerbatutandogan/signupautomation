import type { Browser, Page, Route } from 'playwright';

/**
 * Ağa çıkmadan sahte domainler — keşif testleri için.
 *
 * Anahtar `host + path` ("site.test/signup") ya da hostun tamamı için
 * `host/*`. Tanımsız her istek 404. Not: Playwright gezinme isteğine
 * sahte 3xx veremiyor (Chromium orijinal adrese ağdan gitmeye çalışıyor);
 * yönlendirme gereken testler JS yönlendirmesi kullanmalı.
 */
export type Routes = Record<string, (route: Route) => Promise<void>>;

export const html = (body: string, title = 'Site') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

export const ok = (body: string) => (route: Route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body });

/** Kısa gövde "boş sayfa" sayılmasın diye ana sayfalara eklenen metin. */
export const LONG_TEXT = 'A curated directory of startups and tools. '.repeat(5);

export const SIGNUP_FORM = html(`
  <h1>Create your account</h1>
  <form><input type="email" name="email"><input type="password" name="password">
  <button type="submit">Sign up</button></form>`);

export async function serve(browser: Browser, routes: Routes): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const handler = routes[`${url.host}${url.pathname}`] ?? routes[`${url.host}/*`];
    if (handler) return handler(route);
    return route.fulfill({ status: 404, contentType: 'text/html', body: html('Not found') });
  });
  return ctx.newPage();
}
