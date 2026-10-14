# signupautomation

Bir ürünü (ilk ürün: **geo.new**) yüzlerce dizin, topluluk ve inceleme sitesine kaydetmek ve oralarda
listelemek için kurallara dayalı bir otomasyon. LLM yok: her karar okunabilir bir kurala ya da bir
JSON config'ine dayanır.

Sistem iki ayrı iş yapar ve ikisini bilerek ayırır:

| İş | Ne yapar | Risk |
|---|---|---|
| **Hesap açma** (`run-one`, `run-batch`, `scripts/run-list.ts`) | Sitenin kayıt formunu doldurur, doğrulama mailini Gmail'den okur, linke tıklar ya da kodu girer | Düşük: hesap açılır, ürün yayınlanmaz |
| **Listeleme** (`submit`, `approve-profile`) | Açık hesapla giriş yapar, ürünü sitenin "ürün ekle" formuna girer | **Yüksek: ürün herkese açık yayınlanır, geri almak çoğu zaman mümkün değildir** |

Bu yüzden listeleme varsayılan olarak **dry-run**'dır ve gerçek gönderim için ürün bilgisinin bir
**insan tarafından yazılı olarak onaylanması** gerekir (bkz. [docs/LISTINGS.md](docs/LISTINGS.md)).

## Dokümantasyon

| Belge | Kime / Ne için |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Sistemin nasıl çalıştığı: akışlar, modüller, veri modeli, durum makineleri |
| [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | **Geliştirici rehberi**: kurulum, kodlama kuralları, test stratejisi, nasıl genişletilir, commit ve inceleme süreci |
| [docs/CLI.md](docs/CLI.md) | Tüm komutlar ve betikler, bayraklar, çıkış kodları |
| [docs/SITE-CONFIGS.md](docs/SITE-CONFIGS.md) | Site config (`src/sites/*.json`) biçimi, adım türleri, doğrulama kipleri, config yazma rehberi |
| [docs/LISTINGS.md](docs/LISTINGS.md) | Listeleme akışı, onay modeli, güvenlik garantileri, listeleme config'i yazma |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Operasyon el kitabı: token yenileme, pilot çalıştırma, hız sınırı, Sheet güncelleme, kurtarma |
| [docs/SECURITY-AND-POLICY.md](docs/SECURITY-AND-POLICY.md) | Sırlar, şifre türetme, captcha ve ToS politikası, yapılmaması gerekenler |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Belirti → neden → çözüm tablosu (gerçek olaylardan) |
| [docs/FIELD-NOTES.md](docs/FIELD-NOTES.md) | Gerçek sitelerde öğrenilenler: site aileleri, kayıt sonrası kalıplar, ne işe yaradı ne yaramadı |

## Hızlı başlangıç

Gereksinimler: **Node 22.5+**, bir Gmail hesabı (kayıt e-postası), Google Cloud'da OAuth istemcisi.

```bash
npm install
npx playwright install chromium

cp .env.example .env && chmod 600 .env
openssl rand -hex 32          # çıktıyı .env'de MASTER_SECRET olarak kullan (yedeğini al!)
# .env'de SIGNUP_EMAIL'i de doldur

npm run gmail:auth            # Gmail/Sheets OAuth (tarayıcı açılır)
npm run cli -- check-gmail    # bağlantıyı ve hesap eşleşmesini doğrula
npm test                      # gerçek siteye dokunmaz
```

İlk denemeler (hiçbiri gerçek kayıt göndermez):

```bash
npm run cli -- products                       # ürün profillerini doğrula ve listele
npm run cli -- list                           # tanımlı site config'leri
npm run cli -- run-one 10words --dry-run      # formu doldur, gönderme
npm run cli -- submit toolsnocode             # listeleme formunu doldur, gönderme (dry-run)
```

Gerçek kayıt (hesap açar, günlük sınıra sayılır):

```bash
npm run cli -- run-one <siteId>                          # tek site
npx tsx scripts/run-list.ts --file liste.txt             # bir liste, siteler arası rastgele bekleyerek
```

Gerçek listeleme (**herkese açık yayınlar**):

```bash
npm run cli -- approve-profile geo-new        # insan adımı: bilgiyi oku, ekrandaki kodu yaz
npm run cli -- submit <siteId> --live
```

## Bir bakışta nasıl çalışır

```
Google Sheet (site listesi)
      │  scripts/discover.ts: kayıt sayfasını bul, formu analiz et, taslak config üret
      ▼
src/sites/<id>.json  ("doğrulanmadı" damgalı taslak)
      │  scripts/verify-drafts.ts / run-one --dry-run: formu doldur, GÖNDERME, otomatik denetle
      ▼
doğrulanmış config  ──►  run-one / run-list: gerçek kayıt
                              │  form → (gerekirse captcha) → gönder
                              │  kayıt sonrası sayfa durumunu tanı (oturum açık / kod / mail)
                              │  doğrulama maili (Gmail) → link ya da kod
                              ▼
                      SQLite ledger (data/ledger.sqlite): kilit, deneme, kimlik, listeleme kaydı
                              │
                              ├──► submit: açık hesapla giriş → listeleme formu (onay şart)
                              └──► scripts/sheet-annotate.ts: Sheet'e durum/sorun/not yaz
```

Ayrıntılı akış ve modül haritası: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Temel ilkeler (kısaca)

1. **Şifreler saklanmaz, türetilir.** `HMAC-SHA256(MASTER_SECRET, hesap anahtarı)`. `MASTER_SECRET` kaybı telafi edilemez.
2. **Tek sabit kayıt e-postası.** Doğrulama maili `from:` alan adı + kayıt sonrası zaman penceresiyle eşleşir.
3. **Dry-run hiçbir şey yayınlamaz.** Tıklamalar atlanır; listeleme dry-run'ında tarayıcı düzeyinde tüm yazan istekler (giriş hariç) engellenir.
4. **Belirsizse engelle.** Bir gönderimin yapılmış *olabileceği* anda sonuç `unconfirmed` olur ve otomatik yeniden denenmez (çift yayın yok).
5. **Pazarlama onayı asla verilmez.** Yalnızca şartlar kutusu işaretlenir; önceden işaretli gelen bülten/pazarlama kutuları kaldırılır.
6. **Bot korumaları aşılmaz.** Stealth eklentisi, parmak izi sahteciliği ve IP döndürme yok (tek, belgelenmiş istisna bir tarayıcı bayrağı); Cloudflare duvarı ve görsel captcha'lı siteler elle bakılacak listeye düşer.
7. **Uydurma kimlik yok.** Profilde yalnızca verilen bilgi bulunur: uydurma unvan ya da şirket adı yayınlanmaz.

Ayrıntı: [docs/SECURITY-AND-POLICY.md](docs/SECURITY-AND-POLICY.md).

## Depo düzeni

```
src/
  cli.ts, cli-args.ts        Komut satırı
  config.ts                  .env doğrulaması (zod)
  core/                      runner (hesap açma), submitter (listeleme), browser, captcha, kayıt-sonrası tanıma, ...
  adapters/                  Config şemaları + adım yorumlayıcı (generic.ts) + yükleyiciler
  discovery/                 Kayıt sayfası bulma, form analizi, config üretimi, Sheet sınıflandırması
  identity/                  Hesap anahtarı, şifre türetme, e-posta, ürün profili
  integrations/              Ledger (SQLite), Gmail, Sheets, 2captcha, MIME/mail ayrıştırma
  profile/                   Ürün profilleri (<ürün>.json)
  sites/                     Site config'leri (kayıt)            ← 700+ dosya
  submissions/               Listeleme config'leri (ürün ekleme formları)
scripts/                     Toplu işler: keşif, doğrulama, liste çalıştırıcı, Sheet, OAuth, inceleme
test/                        vitest: saf mantık + gerçek Chromium + yerel sahte siteler
docs/                        Bu dokümantasyon
data/  artifacts/  .auth/    Çalışma zamanı verisi ve sırlar (git'e girmez)
```

## Durum ve sınırlar

- Hesap açma gerçek sitelerde çalışıyor; verim sitelere göre çok değişiyor (saha notları: [docs/FIELD-NOTES.md](docs/FIELD-NOTES.md)). Dry-run formun *doldurulmasını* doğrular; **kayıt sonrasını** (doğrulama türü, başarı sayfası) yalnızca ilk gerçek koşu gösterir.
- Listeleme akışı hazır ve sıkı korumalı; gerçek gönderimler ürün bilgisinin onaylanmasına bağlı. Bir listelemenin herkese açık olduğu ayrıca doğrulanmalıdır (siteler onay kuyruğu kullanabilir). Uçtan uca gerçek listeleme 14 Ekim'de 7 sitede yapıldı ve doğrulandı (1look4, ondashboard, justpep, coolpot, mootin, sharedais, urlsuggest; kodu insan yazdı); yeni siteler tek tek, görsel doğrulama kodu olanlarda insan eşliğinde ilerler.
- Telegram bildirimi ve zamanlayıcı (cron) **uygulanmadı**: kayıtlar elle ya da `scripts/run-list.ts` ile başlatılır; captcha'da insan devralması yalnızca terminal çıktısı ve görünür tarayıcıyla çalışır. Uygulanmamış diğer parçalar: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#8-bilinen-sınırlamalar).
- Panel (Next.js + Supabase) ayrı bir dalda (`web-panel`) yaşar ve bu dokümantasyonun kapsamı dışındadır.
