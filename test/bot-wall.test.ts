import { describe, expect, it } from 'vitest';
import { isBotWall } from '../src/discovery/find-signup.js';

/**
 * Bot duvarı tespiti.
 *
 * Gerçek hata: keşif 403 (bot koruması) ile 404 (sayfa yok) arasında ayrım
 * yapmıyordu ve ikisini de "Kayıt formu bulunamadı" diye kaydediyordu.
 * Crunchbase, GoodFirms, EU-Startups, AngelList gibi kayıt formu KESİNLİKLE
 * olan siteler böylece "kayıt almıyor" sanıldı.
 *
 * Aşağıdaki gövde metinleri 2026-09-23'te o sitelerden gerçekten çekildi.
 */

// Gerçek yakalanmış gövdeler (curl + tarayıcı UA, 2026-09-23)
const CRUNCHBASE =
  'Attention Required! | Cloudflare Please enable cookies. Sorry, you have been blocked You are unable to access crunchbase.com';
const GOODFIRMS = 'Just a moment... Enable JavaScript and cookies to continue';
const SITEINSPIRE =
  "Vercel Security Checkpoint We're verifying your browser Website owner? Click here to fix";

describe('isBotWall — gerçek sayfalar', () => {
  it('Cloudflare blok sayfasını tanır (crunchbase)', () => {
    expect(isBotWall(403, CRUNCHBASE)).toBe(true);
  });

  it('Cloudflare interstitial tanır (goodfirms / eu-startups)', () => {
    expect(isBotWall(403, GOODFIRMS)).toBe(true);
  });

  it('Cloudflare "security verification" varyantını tanır', () => {
    // Playwright ile yakalandı: curl'ün gördüğü "Just a moment..."
    // sayfasından FARKLI bir metin. Bu desen eksikken eu-startups
    // yanlışlıkla "şifre alanı yok" diye kaydedildi.
    const body =
      'www.eu-startups.com Performing security verification This website uses a security service to protect itself';
    expect(isBotWall(403, body)).toBe(true);
    // Durum kodu 200 olsa bile metin tek başına yetmeli.
    expect(isBotWall(200, body)).toBe(true);
  });

  it('Vercel checkpoint tanır (siteinspire)', () => {
    // siteinspire 429 döndürmüştü ama metin tek başına da yetmeli:
    // aynı duvar 200 ile de servis edilebiliyor.
    expect(isBotWall(200, SITEINSPIRE)).toBe(true);
  });

  it('429 rate-limit bot koruması sayılır', () => {
    expect(isBotWall(429, '')).toBe(true);
  });
});

describe('isBotWall — yanlış pozitif olmamalı', () => {
  it('404 bot koruması DEĞİLDİR', () => {
    // En kritik ayrım: sayfa yok ≠ bot engellendi. 404'ü bot koruması
    // saymak siteyi gereksiz yere otomasyon dışına atardı.
    expect(isBotWall(404, 'Page Not Found')).toBe(false);
  });

  it('normal kayıt sayfası bot koruması değildir', () => {
    expect(isBotWall(200, 'Sign up for an account. Email Password Create Account')).toBe(false);
  });

  it('taşınmış sitenin 404 sayfası bot koruması değildir', () => {
    // Gerçek vaka: angel.co/signup → wellfound.com/signup, ama orada
    // sayfa GERÇEKTEN yok. Doğru red "form yok", "bot koruması" değil —
    // yoksa Emre'nin elle açacağı listeye boşuna girerdi.
    const body = 'Join Log In STARTUP JOBS RECRUIT DISCOVER BLOG 404 We couldn’t find what you were looking for';
    expect(isBotWall(404, body)).toBe(false);
  });

  it('500 sunucu hatası bot koruması değildir', () => {
    expect(isBotWall(500, 'Internal Server Error')).toBe(false);
  });

  it('içeriğinde "moment" geçen sıradan sayfayı yakalamaz', () => {
    // Desen "just a moment..." — üç noktasıyla birlikte dar tutuldu.
    expect(isBotWall(200, 'Give us a moment to process your submission')).toBe(false);
  });

  it('boş gövdeli 200 bot koruması değildir', () => {
    expect(isBotWall(200, '')).toBe(false);
  });
});
