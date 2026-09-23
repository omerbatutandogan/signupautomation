import { describe, expect, it } from 'vitest';
import { alreadyExistsOutcome } from '../src/core/runner.js';
import { classifyPageText } from '../src/core/errors.js';
import { TERMINAL_STATUSES, ELIGIBLE_STATUSES, STATUS } from '../src/core/types.js';

/**
 * "Hesap zaten mevcut" sonucu.
 *
 * Gerçek hata: runner bunu `failed` sayıyordu. Ama amaç hesap açmaktı ve
 * hesap VAR — tek e-posta mimarisi gereği o hesap bize ait. ontoplist ve
 * awwwards'ta hesap açıkken sistem "Başarısız" diyordu, yani kendi
 * başarısını başarısızlık olarak kaydediyordu.
 */

describe('alreadyExistsOutcome', () => {
  it('completed döner — başarısızlık DEĞİL', () => {
    expect(alreadyExistsOutcome().status).toBe('completed');
  });

  it('notta hesabın önceden açıldığı yazar', () => {
    // Sheet'i okuyan kişi "yeni kaydoldu" ile "zaten vardı" farkını
    // görebilmeli; ikisi de başarı ama hikâyeleri farklı.
    expect(alreadyExistsOutcome().note).toMatch(/zaten mevcut/i);
  });

  it('terminal bir durumdur — bir daha denenmez', () => {
    // run-batch her turda yeniden denerse boşuna trafik ve bot sinyali.
    const status = alreadyExistsOutcome().status;
    const sheetStatus = status === 'completed' ? STATUS.DONE : STATUS.FAILED;
    expect(TERMINAL_STATUSES).toContain(sheetStatus);
    expect(ELIGIBLE_STATUSES).not.toContain(sheetStatus);
  });
});

describe('classifyPageText — hesap mevcut tespiti', () => {
  it('ontoplist/awwwards tarzı İngilizce mesajı yakalar', () => {
    const err = classifyPageText('This email has already been taken');
    expect(err?.message).toMatch(/zaten mevcut/i);
  });

  it('"already registered" varyantını yakalar', () => {
    expect(classifyPageText('That address is already registered')).not.toBeNull();
  });

  it('araya özne giren "User already exists" varyantını yakalar', () => {
    // alternative.me'nin GERÇEK metni. Eski desen `already (been )?exists`
    // arıyordu ve "User" araya girdiği için kaçırıyordu — site "hesap var"
    // dediği hâlde çalıştırma "Beklenen içerik görünmedi" ile başarısız
    // sayılıyordu.
    const err = classifyPageText('User already exists. Please choose a different email.');
    expect(err?.message).toMatch(/zaten mevcut/i);
  });

  it('sıradan kayıt sayfasını yakalamaz', () => {
    // Yanlış pozitif, gerçekten açılabilecek hesabı "zaten var" sanıp
    // completed yazardı — sessiz bir kayıp.
    expect(classifyPageText('Create your account. Email Password')).toBeNull();
  });

  it('SMS doğrulaması isteyen sayfa manuel incelemeye gider', () => {
    // MANUAL_REVIEW önce kontrol edilmeli: "phone verification" isteyen
    // bir sayfa yanlışlıkla completed sayılmamalı.
    const err = classifyPageText('Please complete phone verification to continue');
    expect(err?.name).toBe('ManualReviewError');
  });
});
