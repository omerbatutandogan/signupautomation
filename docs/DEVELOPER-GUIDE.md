# Geliştirici rehberi

Bu belge projeye kod yazacak herkes içindir: ortamı kurmak, projenin kurallarını öğrenmek, test yazmak,
sistemi genişletmek ve değişikliği güvenle teslim etmek.

Önce okuyun: [ARCHITECTURE.md](ARCHITECTURE.md) (sistem nasıl çalışıyor) ve
[SECURITY-AND-POLICY.md](SECURITY-AND-POLICY.md) (neyi **asla** yapmayacağımız).

## İçindekiler

1. [Ortam kurulumu](#1-ortam-kurulumu)
2. [Günlük komutlar](#2-günlük-komutlar)
3. [Kodlama ilkeleri](#3-kodlama-ilkeleri)
4. [Test stratejisi](#4-test-stratejisi)
5. [Mutasyon kontrolü: testin gerçekten bir şey denediğini kanıtlamak](#5-mutasyon-kontrolü)
6. [Nasıl yapılır: yaygın değişiklikler](#6-nasıl-yapılır-yaygın-değişiklikler)
7. [Hata ayıklama](#7-hata-ayıklama)
8. [Commit, inceleme ve teslim süreci](#8-commit-inceleme-ve-teslim-süreci)
9. [İnceleme kontrol listesi](#9-inceleme-kontrol-listesi)
10. [Bu projede yaşanmış tuzaklar](#10-bu-projede-yaşanmış-tuzaklar)

---

## 1. Ortam kurulumu

Gereksinimler: **Node ≥ 22.5**, npm, macOS/Linux. Gerçek tarayıcı testleri için Playwright'ın Chromium'u gerekir.

```bash
npm install
npx playwright install chromium
```

### `.env` testler için de gerekir

`src/config.ts` içe aktarıldığı anda `.env`'i doğrular ve eksikse hata verir. Testler gerçek sır **kullanmaz** ama
geçerli *biçimde* iki değer ister:

```bash
cp .env.example .env && chmod 600 .env
# Geliştirme için sahte değerler yeterlidir:
#   MASTER_SECRET=<openssl rand -hex 32 çıktısı>
#   SIGNUP_EMAIL=dev@example.com
```

`vitest.config.ts` testlerde `CAPTCHA_API_KEY`'i boşaltır; yerel `.env`'inizde gerçek bir 2captcha anahtarı olsa bile
hiçbir test ücretli çözücüye ulaşamaz. **Bu ayarı kaldırmayın.**

Gerçek hesap açmak/listelemek için ayrıca Gmail OAuth gerekir; bkz. [OPERATIONS.md](OPERATIONS.md#1-token-yenileme-haftalık).

### Çalışma klasörü

Projeyi iCloud ile eşitlenen klasörlerde (Desktop/Documents) **tutmayın**: bu projede eski bir iCloud kopyası bayat
kaldı ve OAuth token'ı bir kez yanlış kopyaya yazıldı. Komutları çalıştırmadan önce hangi klasörde olduğunuzu doğrulayın
(`pwd`, `git status`). Token/`data/`/`.env` her klasöre özeldir ve kopyalar arasında otomatik taşınmaz.

## 2. Günlük komutlar

| Komut | Ne yapar |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict). **Çıkış kodunu okuyun**; çıktıyı `head`'e boru yapmak hatayı gizleyebilir |
| `npm test` | Tüm testler (`vitest run`). Gerçek tarayıcı testleri nedeniyle ~3 dk sürer |
| `npx vitest run test/<dosya>.test.ts` | Tek dosya |
| `npx vitest run test/<dosya>.test.ts -t "<ad parçası>"` | Tek test/grup (mutasyon kontrolünde kullanılır) |
| `npm run test:watch` | İzleme kipi |
| `npm run fixtures` | Yerel sahte site sunucusunu (`test/fixture-server.ts`, port 4599) elle çalıştırır |
| `npm run cli -- <komut>` | Komut satırı (bkz. [CLI.md](CLI.md)) |

Teslimden önce: `npm run typecheck` **ve** `npm test` ikisi de 0 ile çıkmalı.

## 3. Kodlama ilkeleri

### Dil ve biçim

- **TypeScript, ESM, strict.** İçe aktarmalar `.js` uzantılıdır (`import { x } from './y.js'`); `verbatimModuleSyntax` açık,
  tipler `import type` ile alınır. `noUncheckedIndexedAccess` açık: dizi/kayıt erişimi `undefined` olabilir.
- **Yorumlar Türkçe**, mevcut dosyaların üslubunda: *ne* yaptığını değil *neden* öyle yaptığını ve hangi **gerçek olaydan**
  doğduğunu yazın ("BetaList'te şifre alanları boş kalıyordu"). Yeni dosyalar bir "dosya amacı" bloğuyla başlar.
- **Commit mesajları İngilizce** (bkz. [§8](#8-commit-inceleme-ve-teslim-süreci)).
- Çevrede olmayan bir paketi eklemeyin; yeni bağımlılık için gerekçe gerekir.

### Mimari ilkeler

1. **Saf mantığı G/Ç'den ayırın.** Karar veren kod (sınıflandırma, eşleştirme, eşik) saf fonksiyon olsun ve G/Ç'siz
   test edilsin. Örnek: `decidePostSubmit` (saf) / `observePostSubmit` (sayfaya bakan ince kabuk), `shouldStop`/`gapSeconds`
   (`core/run-list.ts`) / `scripts/run-list.ts`, `annotate()` / `scripts/sheet-annotate.ts`.
2. **Yüklerken doğrula.** Dışarıdan gelen her şey (config, profil, `.env`) zod ile *okunduğu anda* doğrulanır; hata tarayıcı
   açıkken değil başlangıçta patlar.
3. **Fail-closed.** Bilinmeyen hata kalıcı hata sayılır; kanıt yoksa `unknown`; listelemede belirsizlik `unconfirmed`
   (yeniden denemeyi engeller). "Emin değilim → tekrar dene" yönünde yanılan bir kapı yazmayın.
4. **Pozitif kanıtla karar verin.** Bir durumu tanımak için *olması gereken* işaretleri arayın; yokluğundan sonuç çıkarmayın.
5. **Kapılar ağdan önce.** Ucuz, geri alınabilir kontroller (risk, onay, terminal sonuç, limit, kilit) tarayıcıyı açmadan çalışır.
6. **Kilit/zaman penceresi sonrası yeniden kontrol edin.** Kontrol ile kilit arasındaki yarış gerçek bir çift-yayın yoludur
   (`submitListing` bunu kilidi aldıktan sonra tekrar sorar).
7. **Her temizlik adımı kendi `try/catch`'inde.** Biri patlarsa kilit ve tarayıcı açık kalmasın.
8. **Sheet ve diğer görünürlük katmanları otorite değildir**; hataları çalışmayı düşürmez.
9. **Gizli veriyi asla loglamayın ve diske yazmayın.** Parola `pino.redact` ile gizlenir; hata anı HTML'inden parola alanları
   temizlenir. Ayrıntı: [SECURITY-AND-POLICY.md](SECURITY-AND-POLICY.md).
10. **Dry-run hiçbir yan etki bırakmaz**: kimlik kaydı, kalıcı profil, günlük sayaç, yazan istek yok.

### `page.evaluate` içindeki kod

Sayfaya gönderilen fonksiyonlar tarayıcıda çalışır ve Node'daki değişkenlere erişemez. CLI `tsx` ile çalıştığı için
esbuild `keepNames` adlandırılmış iç fonksiyonlara `__name(...)` ekler; bu yardımcı sayfada tanımlı olmalıdır
(`core/browser.ts` bunu `addInitScript` ile yapar). Sayfa içi kod yazarken `test/keepnames.test.ts`'in kapsadığı yolu bozmayın.
Yeni sayfa-içi kod için o test kalıbıyla (modülü `keepNames` ile derleyip gerçek sayfada çalıştırmak) regresyon testi ekleyin.

## 4. Test stratejisi

Çerçeve: **vitest**. Gerçek bir siteye dokunan test **yoktur ve olmayacaktır**.

| Katman | Ne test eder | Örnek |
|---|---|---|
| Saf birim | Kararlar, ayrıştırma, şemalar | `post-submit`, `mail-parse`, `schema`, `annotate`, `run-list` |
| Ledger | Gerçek SQLite (`:memory:` ya da geçici dosya) | `ledger.test.ts`, `ledger-submissions.test.ts`, `adopt-account.test.ts` |
| Gerçek Chromium + sayfa içeriği | Tarayıcıda çalışan mantık | `dry-run-label`, `marketing-optin`, `verification-entry`, `keepnames` |
| Gerçek Chromium + yerel sahte site | Uçtan uca akış (giriş, form, POST, yanıt) | `submitter.test.ts` |
| Fixture sunucusu | Captcha/retry senaryoları (`test/fixture-server.ts`) | `captcha-*.test.ts`, `site-timeout` |

### Kurallar

- **Tarayıcı testleri yerel `http` sunucusuna** (`127.0.0.1:<rastgele port>`) karşı yazılır. Sunucu istekleri sayar
  (`received.submitPosts` gibi): "hiçbir şey gönderilmedi" iddiası **sunucuya ulaşan istek sayısıyla** kanıtlanır, sonuç
  metniyle değil.
- **Test kendi kontrolünü içermelidir**: bir şeyin *engellendiğini* kanıtlıyorsanız, aynı fikstürün engel olmadan *gerçekten
  yaptığını* gösteren bir kontrol testi ekleyin (aksi halde test boşuna geçer). Örnek: "kendiliğinden POST eden form dry-run'da
  engellenir" + "aynı form gerçek koşuda gerçekten POST eder".
- **Yan etki bırakmayın.** `artifacts/` altına yazılmasın (`../src/core/artifacts.js`'i mock'layın), gerçek `data/`'ya dokunmayın
  (ledger için `:memory:`, onay/logo/profil kökleri için geçici dizin; her testten sonra silin).
- **Yavaş olanı hızlandırın, konusu olmayanı değil.** `core/formfill.js`'in `typeHuman`'ı (alan başına 9 sn'ye kadar insan
  hızında yazma) sahte-site testlerinde doğrudan `fill`'e mock'lanır; testin konusu yazma hızı değil.
- **Dış servisler (Gmail, Sheets, 2captcha) her zaman sahtedir.** Gmail'in ağ katmanına ihtiyaç duyan davranışlar saf
  fonksiyonlara ayrılır (`mail-parse.ts`).
- **Gerçek posta korpusu** `test/fixtures/emails/*.eml` git'e girmez (kişisel adres ve geçerli bağlantılar içerir). Korpusa
  dayalı kontrol: `npm run mail:verify-corpus`.
- Test adları Türkçe ve **davranışı** söyler ("başarı işareti gönderimden ÖNCE de görünüyorsa tıklanmaz").
- `it.each` ve tablolar saf kararlar için idealdir.

### Yeni davranış için en az

1. Mutlu yol testi.
2. Her **reddetme/kapı** için "reddeder" testi ve (varsa) kapının *yanlış* reddetmediğini gösteren kontrol.
3. Hata yolu: hata *nerede* oluştuğuna göre doğru durum (`failed` mı `unconfirmed` mı).
4. [Mutasyon kontrolü](#5-mutasyon-kontrolü).

## 5. Mutasyon kontrolü

Geçen bir test iki şey olabilir: kodu gerçekten denedi, ya da hiçbir şeyi denemedi. Düzeltmeyi/korumayı **geçici olarak
bozup** ilgili testin **kırıldığını** görmeden bir korumayı "test edilmiş" saymayın.

```bash
# 1) Çalışan hali kaydedin
cp src/core/submitter.ts /tmp/submitter.ts.bak
# 2) Korumayı bozun (ör. bir kapıyı `if (false as boolean)` yapın)
# 3) YALNIZCA ilgili testi çalıştırın; KIRILMALI
npx vitest run test/submitter.test.ts -t "günlük gerçek listeleme sınırı"
# 4) Geri yükleyin ve aynı olduğunu doğrulayın
cp /tmp/submitter.ts.bak src/core/submitter.ts && git diff --stat
```

Yönergeler:

- Mutasyon başına **tek** değişiklik; sonra mutlaka geri yükleyin (`cmp` ya da `git diff` ile doğrulayın).
- **Test kırılmazsa** testi güçlendirin: ya konuyu hiç denemiyordur ya da başka bir yol aynı sonucu veriyordur (ör. onay
  özeti yanlış hesaplanınca "mutlu yol" testleri zaten kırıldığı için "logo değişti" testi vacuous geçiyordu; test, değişiklikten
  *önce* aynı koşulda başarıyı gösterecek şekilde yeniden yazıldı).
- Birden çok bağımsız savunma katmanı varsa (ör. servis worker için hem `context.route` hem CDP bypass), her katmanı
  *ayrı* mutasyonla ve *ikisini birden* bozarak deneyin; yalnızca ikisi birlikte kırıyorsa "katmanlı savunma" olarak belgeleyin.

## 6. Nasıl yapılır: yaygın değişiklikler

### Yeni site config'i

Ayrıntı: [SITE-CONFIGS.md](SITE-CONFIGS.md). Kısaca: sayfayı gerçek oturumda inceleyin (`npm run inspect -- <url>`), config'i yazın,
`run-one <id> --dry-run` ile doğrulayın, **tek** gerçek koşuyla kayıt sonrası davranışı görün, sonra notlara öğrendiklerinizi yazın.

### Yeni adım türü

1. `adapters/schema.ts`: `StepUnion`'a nesneyi ekleyin (gerekli alanlarıyla) — gerekirse `StepSchema.superRefine`'a kural.
2. `core/types.ts`: `Step`/ilgili tip alanları.
3. `adapters/generic.ts`: `runStep` içindeki `switch`'e `case` ekleyin. **Dry-run davranışını** açıkça düşünün (atlanmalı mı?).
   `default` dalı `never` ile kapsayıcılığı zorlar.
4. Testler: gerçek sayfada çalıştığını gösteren test; dry-run'da yan etkisiz olduğunu gösteren test.
5. [SITE-CONFIGS.md](SITE-CONFIGS.md)'ye ekleyin.

### Yeni alan adı (`FieldName`)

`adapters/schema.ts` (`FieldNameSchema`), `core/types.ts` (`FieldName`), `core/formfill.ts` (`resolveField`) üçü birlikte güncellenir.
Değer yoksa `null` döndürün: adım "Alan için değer yok, atlanıyor" der, uydurma değer yazılmaz.

### Yeni doğrulama kipi ya da kayıt-sonrası durum

`core/post-submit.ts`: önce saf `decidePostSubmit` için tablo testi ekleyin (pozitif kanıt + "kanıt yok" + "çelişen kanıt"
vakaları), sonra `collectFacts`'a gerekli ham bilgiyi ekleyin, sonra `effectiveVerification` ve runner'ı bağlayın.
Gerçek bir saha vakasından (`artifacts/.../failure-*.html`) tanımayı doğrulayın.

### Yeni ürün profili

`src/profile/<ürün-id>.json` (id: küçük harf/rakam/tire). `npm run cli -- products` zod hatalarını gösterir. Aynı sitede iki
ürün aynı e-postayla hesap açamaz: ikinci ürüne `signupEmail` verin. Profilde **yalnızca verilen bilgi** bulunur (uydurma unvan,
yasal ad yok); detaylar [SECURITY-AND-POLICY.md](SECURITY-AND-POLICY.md#6-kimlik-ve-içerik-politikası).

### Yeni listeleme config'i

[LISTINGS.md](LISTINGS.md#8-listeleme-configi-yazma). Başarı işareti formda **zaten görünmemelidir**; görünüyorsa gönderim engellenir.

### Yeni Sheet durum sınıfı

`discovery/annotate.ts` (`DURUM` + `annotate()` saf) → `test/annotate.test.ts` → gerekirse `scripts/sheet-annotate.ts`'e girdi.
Sınıfları az ve kalıcı tutun; ayrıntı "Not" kolonuna yazılır.

### Yeni ortam değişkeni

`src/config.ts` (zod) → `.env.example` (açıklamalı) → [OPERATIONS.md](OPERATIONS.md) ya da ilgili belge. Testlerin gerçek değere
bağımlı olmadığından emin olun.

### Ledger'a kolon/tablo

`Ledger.migrate()` içine `CREATE TABLE IF NOT EXISTS` ya da `addColumnIfMissing` ekleyin; **eski veritabanları
açılabilmeli** (`CREATE ... IF NOT EXISTS` mevcut tabloyu güncellemez). SQLite birincil anahtarı yerinde değiştirmez; hesap
anahtarı modeli bu yüzden "yalın siteId / `ürün@site`" biçimindedir.

## 7. Hata ayıklama

| İhtiyaç | Yol |
|---|---|
| Bir koşu neden düştü? | `artifacts/<runId>/<hesapAnahtarı>/failure-*.png/html` (ekran görüntüsü + sayfa). Yol çıktıda yazılır |
| Kayıt sonrası sayfa tanındı mı? | Log: `Kayıt sonrası durum otomatik tespit edildi` + `observed:`; tanınamazsa `Kayıt sonrası durum tespit edilemedi` uyarısı |
| Ledger'a bakmak | `sqlite3 -readonly data/ledger.sqlite 'select site_id,status,note from attempts order by id desc limit 20'` (yazmayın; gerekirse ilgili CLI komutu: `adopt-account`, `unlock`) |
| Son denemeler | `npm run cli -- status` |
| Görünür tarayıcı | `HEADLESS=false` (varsayılan) |
| Ayrıntılı log | `LOG_LEVEL=debug` |
| Formu görmek | `npm run inspect -- <url>` (kayıt sayfası alanlarını listeler) |
| Kaydedilmiş hata sayfasını sınamak | HTML'i `page.setContent` ile yükleyip ilgili saf/ince fonksiyonu çalıştırın (ağır sayfalar yerel kaynaklara bağlı olduğu için takılabilir) |
| Posta kutusuna bakmak | `npm run mail:recent -- 15` (gönderen/konu/tarih listesi) |
| Bir sitenin doğrulama postası geldi mi? | Gmail'de `in:anywhere` + site adı; spam klasörüne bakın |

Gerçek bir siteyle bir şey denerken **önce salt-okunur** yaklaşın (girişten sonra sayfayı gezin, alanları dökün) ve gönderimi yalnızca
bilinçli, tek bir koşuyla yapın.

## 8. Commit, inceleme ve teslim süreci

### Commit kuralları

- **Mesajlar İngilizce.** Başlık 72 karakter altı, emir kipi ("Add…", "Fix…", "Stop…"). Gövde *ne* değil **neden**: hangi gerçek olay/hata
  değişikliği gerektirdi, davranış neden böyle.
- **Mantıksal olarak bölün.** Bir commit bir fikir: bir düzeltme + testi, bir özellik + testi. Karışık değişiklikte hunk bazlı bölün. Her
  commit **tek başına derlenmeli ve testten geçmeli**.
- **Üretici/yardımcı imzası yok.** Commit mesajlarına ve belgelere yardımcı yazarlık satırı (`Co-Authored-By` vb.), "Generated with…"
  ibaresi ya da araç dosyaları (ör. `CLAUDE.md`) **eklenmez.** Her commit'ten sonra doğrulayın:
  `git log -1 --format=%B | grep -ciE "claude|co-authored|generated with"` → **0**.
- **Yalnızca ilgili dosyaları** ekleyin (`git add <dosyalar>`); `git add -A` ile çalışma zamanı dosyalarını sürüklemeyin. `data/`, `artifacts/`,
  `.env`, `.auth/` git dışıdır.
- Yayınlanmamış (push edilmemiş) yerel commit'ler yeniden yazılabilir; **yayınlanmış geçmişe zorla push yapılmaz** (açık izin gerekir).
- **Push yalnızca sahibinin isteğiyle.** Göndermeden önce: `git log origin/main..HEAD`, Claude/imza taraması, sır taraması (anahtar/parola/token
  desenleri) yapın.
- Projede hiçbir yerde geçmemesi gereken bir ad vardır; `test/no-forbidden-name.test.ts` bunu depo genelinde tarar. Yeni dosyalarda da geçmemeli.

### İnceleme

- **Yazan, onaylayan olmaz.** Önemli değişikliklerde (özellikle listeleme, ledger, onay, kapılar, sır ve ağ koruması) bağımsız bir inceleme isteyin;
  incelemeci çalışma ağacını *değiştirmeden* ve gerçek siteye/veriye dokunmadan okur.
- İnceleme bulguları şiddetine göre ele alınır: **kritik/yüksek** bulgu giderilmeden teslim olmaz; **orta** bulgular ilk gerçek canlı kullanımdan
  önce giderilir; düşükler bilinçli bir kararla ertelenebilir (nedeniyle birlikte).
- Yeniden inceleme için commit aralığı (`git diff <önceki>..HEAD`) ve **kanıt** (testler, mutasyon kontrolleri) sunun.

### Teslim kapısı

1. `npm run typecheck` → 0
2. `npm test` → 0 (çıkış kodunu okuyun)
3. Her yeni koruma için mutasyon kontrolü yapıldı
4. Yer tutucu yok: `TODO`, `test.skip`, `.only`, boş test gövdesi, "ileride" notu — bunlar tamamlanmamış işin kanıtıdır
5. Belgeler güncellendi (CLI, config, politika ya da operasyon etkileniyorsa)
6. `git status` temiz; commit'ler mantıksal ve imzasız

## 9. İnceleme kontrol listesi

Kod incelerken (ya da kendi değişikliğinizi gözden geçirirken):

- [ ] **Çift yayın/çift kayıt** yolu var mı? Kontrol ile kilit arasında yarış? Süreç ölürse ne olur (yetim kayıt)?
- [ ] Hata, "gönderim yapılmış olabilir" noktasından **önce mi sonra mı**? Sınıflandırma buna göre mi?
- [ ] Dry-run'da **yan etki** var mı (yazan istek, kimlik kaydı, profil, sayaç)?
- [ ] Yeni bir kapı **fail-closed** mu? Reddedilen durumda ağ/tarayıcı açılmadan mı dönüyor?
- [ ] Parola/sır log'a, `artifacts/`'e, hata mesajına ya da test çıktısına **sızıyor mu**?
- [ ] Alan adı/host doğrulaması var mı (parola yalnızca sitenin kendi alan adına)? `*.vercel.app` gibi paylaşımlı barındırma?
- [ ] Marketing/bülten onayı **hiçbir yolla** işaretli gidiyor mu?
- [ ] Yüklenen dosya yolu onaylı dosyalarla sınırlı mı (`..`, mutlak yol, başka dosya)?
- [ ] Test **kendi kontrolünü** içeriyor mu? Mutasyon kontrolü yapıldı mı?
- [ ] Gerçek siteye/`data/`'ya/`artifacts/`'e dokunan test var mı?
- [ ] Belge/yorum, kodun gerçek davranışıyla **uyumlu** mu? (Eskimiş "varsayılan kapalı" gibi yorumlar yanıltır.)

## 10. Bu projede yaşanmış tuzaklar

Her biri gerçek bir olaydan gelir; yeni kod yazarken aynı yere düşmeyin.

| Tuzak | Ders |
|---|---|
| Dry-run onay kutusunu DOM'dan işaretlerken *herhangi* bir etiket kontrolünü tıklıyordu; `label[for]` bir **gönder butonunu** gösterebilir | Yalnızca `checkbox`/`radio` kontrolleri işaretlenir |
| Canlı koşuda etiketin ortasına gerçek tıklama "Terms" **bağlantısına** düşüyordu, kutu boş kalıyordu (dry-run görmemişti) | Etiketler canlıda da DOM üzerinden işaretlenir; dry-run ile canlı yolu ayrıştıran her kod ayrı test ister |
| Siteler pazarlama/bülten kutusunu **önceden işaretli** getirebilir | Gerçek tıklamadan önce işaretli pazarlama kutuları kaldırılır |
| `tsx` altında `page.evaluate` içindeki kod `__name is not defined` hatası verdi; hata sessizce `unknown`'a çevrildiği için kayıt sonrası tanıma **hiç çalışmadı**, vitest'te ise çalışıyordu | Sayfa-içi kodu keepNames ile derleyip sınayan test; hataları yutmayın, loglayın |
| `waitForLoadState('networkidle')`, zaten ulaşılmış durum için **anında** döner; gecikmeli XHR giriş isteği sonraki `goto` ile yarıda kesildi | Oturumun kurulduğunu *işaretle* (adres/işaret) bekleyin |
| Tek sabit kayıt e-postası + `from:` eşleşmesi: Discourse gibi siteler başka alan adından gönderir | Config `from` vermediyse gövdenin site alan adına bağlanması da aday sayılır |
| Mac'in internet bağlantısı arada düşer; 12 site "başarısız" sayıldı | `ERR_INTERNET_DISCONNECTED` ağ kesintisidir: site başarısızlığı sayılmaz, bağlantı beklenir, site sonda yeniden denenir |
| `Promise.race` ile kaybeden taraf sonradan reddedilirse işlenmemiş red olur | Her taraf `.then(ok, fail)` ile sarılır |
| Test boşuna geçti (korumayı kaldırınca da geçiyordu) | Mutasyon kontrolü; "önce başarı, sonra değişiklik, sonra ret" biçiminde test |
| `package.json`'da var olmayan betiklere giden script'ler | Betik ekler/silerken `package.json`'u güncelleyin |
| Terminal sonuçlar yeniden denemeyi engeller: yanlış `failed` yazan bir koşu hesabı "kilitler" | Hesap gerçekten açıksa `adopt-account` (kanıt notuyla); açılmadığı kesinse `--force` |
