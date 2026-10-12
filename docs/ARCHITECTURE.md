# Mimari

Bu belge sistemin **nasıl çalıştığını** anlatır: uçtan uca akışlar, modüller, veri modeli ve durum
makineleri. Nasıl kullanılacağı için [CLI.md](CLI.md) ve [OPERATIONS.md](OPERATIONS.md), nasıl
geliştirileceği için [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) belgelerine bakın.

## İçindekiler

1. [Tasarım hedefleri](#1-tasarım-hedefleri)
2. [Büyük resim](#2-büyük-resim)
3. [Kavramlar](#3-kavramlar)
4. [Hesap açma akışı (`runSite`)](#4-hesap-açma-akışı-runsite)
5. [Kayıt sonrası durum tanıma](#5-kayıt-sonrası-durum-tanıma)
6. [Doğrulama mailleri](#6-doğrulama-mailleri)
7. [Captcha](#7-captcha)
8. [Dry-run anlamı](#8-dry-run-anlamı)
9. [Listeleme akışı (`submitListing`)](#9-listeleme-akışı-submitlisting)
10. [Ledger (SQLite)](#10-ledger-sqlite)
11. [Keşif hattı](#11-keşif-hattı)
12. [Sheet entegrasyonu](#12-sheet-entegrasyonu)
13. [Hata sınıflandırması ve durumlar](#13-hata-sınıflandırması-ve-durumlar)
14. [Çalışma zamanı dosyaları](#14-çalışma-zamanı-dosyaları)
15. [Modül haritası](#15-modül-haritası)

---

## 1. Tasarım hedefleri

| Hedef | Nasıl sağlanıyor |
|---|---|
| **"Yeni site = bir JSON dosyası"** | Declarative adım yorumlayıcısı (`adapters/generic.ts`); kod yalnızca JSON'un anlatamadığı durumlar için |
| **Yanlış veri 200 siteye yayılmasın** | Profil ve config'ler zod ile *yüklerken* doğrulanır; listeleme için insan onayı |
| **Aynı hesabı iki kez açma / aynı ürünü iki kez yayınlama** | Atomik SQLite kilitleri, terminal sonuç kapısı, "belirsizse engelle" kuralı |
| **Şifre kasası olmasın** | Şifre `MASTER_SECRET`'tan türetilir, hiçbir yerde saklanmaz |
| **Gerçek siteleri dövmeden test** | Saf mantık ayrı modüllerde; tarayıcı testleri yerel sahte sitelere karşı |
| **Sessiz yanlış yerine açık durma** | Bilinmeyen hata = kalıcı hata (fail-closed); kanıt yoksa `unknown` |

## 2. Büyük resim

```
                      ┌────────────────────────────────────────────────────────────┐
                      │                    Google Sheet (insan görünürlüğü)         │
                      │  Durum/Sorun/Not kolonları ◄── scripts/sheet-annotate.ts    │
                      └───────────────▲───────────────────────────▲────────────────┘
                                      │ site listesi              │ sonuçlar
┌───────────────┐   keşif   ┌─────────┴──────────┐  doğrula  ┌────┴─────────────┐
│  Sheet satırı │──────────►│ src/sites/<id>.json │──────────►│ doğrulanmış      │
│  (website)    │ discover  │ ("doğrulanmadı")    │ dry-run   │ config           │
└───────────────┘           └─────────────────────┘           └────┬─────────────┘
                                                                    │ run-one / run-list
                                                  ┌─────────────────▼──────────────────┐
                                                  │ runSite (core/runner.ts)            │
                                                  │ kapılar → kilit → form → gönder →   │
                                                  │ kayıt sonrası tanıma → mail/kod →   │
                                                  │ başarı kontrolü                     │
                                                  └───────┬─────────────────┬──────────┘
                                         tarayıcı         │                 │ Gmail API
                                  (Playwright, kalıcı     │                 │ (doğrulama maili)
                                   profil / hesap)        ▼                 ▼
                                                  ┌────────────────┐  ┌──────────────┐
                                                  │ data/ledger    │  │ gelen kutusu │
                                                  │ .sqlite        │  └──────────────┘
                                                  └───────┬────────┘
                                                          │ hesap açık
                                        ┌─────────────────▼──────────────────┐
                                        │ submitListing (core/submitter.ts)   │
                                        │ kapılar → onay → giriş → form →     │
                                        │ gönder → başarıyı doğrula           │
                                        └─────────────────────────────────────┘
```

İki kural bu şemanın her yerinde geçerlidir:

- **Otorite ledger'dır, Sheet değil.** Sheet yalnızca insanın bakıp ilerlemeyi görmesi içindir; erişilemezse
  çalışma durmaz.
- **Dry-run ile gerçek koşu aynı koddan geçer.** Fark yalnızca "gönderme eylemi" ve yan etkilerdir (bkz. [§8](#8-dry-run-anlamı)).

## 3. Kavramlar

| Kavram | Tanım |
|---|---|
| **Site (`siteId`)** | Bir dizin/topluluk sitesi. `src/sites/<siteId>.json` dosya adı = kimlik. Sheet'teki `Website` değerinden türetilir (`siteIdFromWebsite`) |
| **Ürün (`productId`)** | Ürün profili: `src/profile/<productId>.json`. Varsayılan ürün `geo-new` |
| **Hesap anahtarı** (`accountKey`) | Varsayılan üründe yalın `siteId`, diğer ürünlerde `ürün@site`. Kilit, deneme kaydı, kimlik, **tarayıcı profili** ve **şifre** hesap anahtarına bağlıdır. Varsayılan ürünün anahtarı değişmediği için mevcut hesapların şifreleri korunur |
| **Config** | Kayıt formunun adım listesi (`src/sites/`). **Listeleme config'i** ise ürün ekleme formunun adım listesidir (`src/submissions/`) |
| **Taslak** | Keşfin otomatik ürettiği, notlarında `OTOMATİK ÜRETİLDİ — doğrulanmadı` damgası taşıyan config. Başarılı dry-run damgayı kaldırır |
| **Doğrulanmış config** | Dry-run'dan geçmiş config. **Dikkat:** dry-run formu göndermez; kayıt *sonrası* davranış doğrulanmış sayılmaz |
| **Terminal sonuç** | `completed`, `failed`, `manual`. Bir hesapta terminal sonuç varsa otomatik yeniden denenmez (`--force` ile aşılır) |
| **Onay (approval)** | Ürün bilgisinin (ve logo dosyalarının) herkese açık yayın için insan tarafından onaylandığını gösteren kayıt (`data/approvals/`) |
| **Kayıt sonrası durum** | Form gönderildikten sonra sayfanın tanınan hâli: `logged_in`, `code_prompt`, `check_email`, `unknown` |

## 4. Hesap açma akışı (`runSite`)

`src/core/runner.ts` bir siteyi uçtan uca işler. Sıra **bilerek** sabittir; ağa dokunmadan önceki kapılar
ucuz ve geri alınabilirdir.

```
runSite(siteId, { dryRun, force, productId })
 │
 ├─ 1. Risk kapısı        adapter.risk === 'high'         → skipped_high_risk   (ağ isteği YOK)
 ├─ 1b. Taşınma kapısı    notlarda TAŞINMA ONAYI damgası  → manual              (yalnızca gerçek koşuda)
 ├─ Profil yükle          geçersiz profil                 → failed              (siteye dokunmadan)
 ├─ 2. Terminal kapısı    önceki terminal sonuç, --force yok → skipped_terminal
 ├─ E-posta çakışması     aynı sitede aynı e-posta başka üründe → manual
 ├─ 3. Günlük limit       countToday() ≥ DAILY_LIMIT      → skipped_limit       (dry-run muaf)
 ├─ 4. Kilit              ledger.tryClaim(anahtar)        → skipped_locked
 │
 ├─ startAttempt          ledger'a "running" satırı
 ├─ Kimlik üret           e-posta (SIGNUP_EMAIL / profil), kullanıcı adı, türetilmiş şifre
 ├─ saveCredentials       SUBMIT'TEN ÖNCE (dry-run'da YOK)
 ├─ launchContext         kalıcı profil (dry-run: geçici profil)
 ├─ adapter.signup(ctx)   config adımlarını yürüt (goto/fill/click/captchaGate/expect…)
 │      └─ expect adımı: kayıt sonrası durum tanıma (§5)
 │
 ├─ already_exists        → completed ("Hesap zaten mevcut"); dry-run'da manual
 ├─ dry-run               ekran görüntüsü + checkDryRunPage → completed | manual
 ├─ doğrulama gerekmiyor  confirmSuccess → completed | manual
 ├─ doğrulama maili       Gmail'de bekle → link aç | kod gir
 ├─ postVerify + confirmSuccess → completed | manual
 │
 └─ catch/finally         hata sınıflandır → failed | error | manual
                          finishAttempt, kilidi bırak, tarayıcıyı kapat, Sheet'e yaz (opsiyonel)
```

Önemli davranışlar:

- **Kilit her koşulda bırakılır** (`finally`). Bırakılmayan kilit siteyi `LOCK_TTL_MS` (45 dk) boyunca
  işlenemez yapar. Süreç ölürse kilit TTL ile düşer; ledger açılırken "running" kalan denemeler `error`
  yapılır (`reapStaleLocks`).
- **Kimlik, gönderimden önce kaydedilir.** Çökme olursa hangi kimlikle denendiği kaybolmaz. Dry-run'da
  kaydedilmez: sahte kayıt `credentials` tablosunu yalanlar ve başka ürünün gerçek kaydını "e-posta
  zaten kullanılıyor" diye engellerdi.
- **"Hesap zaten var" başarısızlık değildir.** Tek e-posta mimarisinde o hesap bize aittir; `completed`
  ("Hesap zaten mevcut") yazılır. Dry-run'da bu **doğrulama sayılmaz** (sayfadaki "Already registered?
  Log in" sıradan bir bağlantıdır) → `manual`.
- **Terminal sonuçlar yeniden denemeyi engeller.** `failed` bir siteyi tekrar denemek için `--force`
  gerekir; bunu yalnızca hesabın **açılmadığı kesin** olduğunda yapın (bkz. [OPERATIONS.md](OPERATIONS.md)).

### Kimlik üretimi

| Alan | Kaynak |
|---|---|
| E-posta | `profile.signupEmail ?? env.SIGNUP_EMAIL` (tek sabit adres) |
| Kullanıcı adı | `<ürünAdıSadeceHarfRakam>_<siteId ilk 8 harf>` (en çok 30 karakter). Config'te `usernameStyle: "plain"` ise alt çizgi olmaz |
| Şifre | `derivePasswordForSite(MASTER_SECRET, { id: hesapAnahtarı, passwordPolicy })` — bkz. [SECURITY-AND-POLICY.md](SECURITY-AND-POLICY.md) |
| Ad/soyad/rol | Profil `contact` alanları. `role` isteğe bağlıdır: yoksa formdaki alan boş bırakılır |

## 5. Kayıt sonrası durum tanıma

Dry-run formu göndermediği için taslak config'ler kayıt sonrasını **tahmin eder** ("mail ile link gelir,
sayfada `check your email` yazar"). Gerçek koşularda bu tahmin sık yanlış çıktı. `core/post-submit.ts`
gönderimden sonra sayfayı **yalnızca pozitif kanıtla** sınıflandırır:

| Durum | Kanıt | Runner ne yapar |
|---|---|---|
| `logged_in` | Görünür bir "Log out/Sign out" bağlantısı (ya da açılır menüde gizli bağlantı **ve** sayfada bu hesabın kullanıcı adı/e-postası) **ve** görünür parola alanı yok | Posta beklemez, hesabı `completed` sayar |
| `code_prompt` | "enter the code / 6-digit / verification code" gibi metin **ve** 4-8 tek haneli kutu ya da kod adı taşıyan tek alan | `mode: code`'a geçer, seçiciyi gözlemden alır |
| `check_email` | "check your email / confirmation email / thanks for signing up…" **ve** kayıt formu görünmüyor | Config `none` dese bile `link` bekler |
| `unknown` | Hiçbiri | Eskisi gibi `Beklenen içerik görünmedi` hatası |

Kural tabanlıdır, LLM yoktur. Sayfa içi kod `page.evaluate` ile çalışır; bu yüzden tarayıcı context'inde
`__name` yardımcısı tanımlanır (bkz. [TROUBLESHOOTING.md](TROUBLESHOOTING.md) → "tsx ve `__name`").

## 6. Doğrulama mailleri

`integrations/gmail.ts` + `integrations/mail-parse.ts` (+ `mime.ts`).

1. Sorgu: `in:anywhere after:<gönderimZamanı − 60 sn>` — **spam dahil** (doğrulama mailleri sık spam'e düşer).
2. Her aday mesaj ham MIME olarak okunur ve `isVerificationCandidate`'ten geçer:
   - kayıt zamanından önce gelmemiş olmalı;
   - gönderen alan adı sitenin kayıtlanabilir alan adıyla eşleşmeli **ya da** config `from` vermediyse mailin
     gövdesi site alan adına bağlantı vermeli (Discourse gibi üçüncü taraf göndericiler için);
   - config `from` verdiyse **kesin** eşleşme aranır; `subjectContains` varsa konu da eşleşmeli.
3. `link` kipinde bağlantılar skorlanır (doğrulama yolu kalıpları, uzun token, site alan adı, anchor metni);
   gürültü (abonelikten çık, sosyal medya, görsel…) elenir. Belirsiz kalırsa `ManualReviewError`.
4. `code` kipinde 4-8 haneli aday kodlar skorlanır (yıl ve telefon benzeri diziler elenir).
5. Kullanılan mesaj `seen_messages`'a yazılır; aynı mail iki siteye atanmaz.

Bekleme süresi: `spec.timeoutMs` → `EMAIL_TIMEOUT_MS` (varsayılan 10 dk). Çoğu config 180 sn kullanır.

Kod girişi (`core/verification-entry.ts`): tek alan ya da **rakam başına bir kutu** (kutu sayısı = kod uzunluğu;
her rakam gerçek tuş olaylarıyla kendi kutusuna yazılır). Gönder düğmesi (`codeSubmitSelector`) yoksa Enter basılır.

## 7. Captcha

`core/captcha.ts` (tespit) + `integrations/captcha-solver.ts` (2captcha) + `adapters/generic.ts` (`captchaGate`).

```
captchaGate adımı
 ├─ widget görünmüyor            → devam
 ├─ dry-run                      → yalnızca ekran görüntüsü; ÇÖZME, BEKLEME YOK
 ├─ passive (v3 / managed)       → devam ("Passive captcha tespit edildi")
 ├─ risk:high + solveCaptcha:true→ hata günlüğü; 2captcha KULLANILMAZ, insana düşer
 ├─ shouldSolveCaptcha(site)     solveCaptcha !== false VE risk !== 'high'
 │    ├─ CAPTCHA_API_KEY var     → 2captcha çözer (180 sn sınırı); başarısızsa insana düşer
 │    └─ anahtar yok             → insana düşer
 └─ insan devralması             → görünür tarayıcıda çözmeni bekler (CAPTCHA_TIMEOUT_MS), süre dolarsa
                                   CaptchaRequiredError → manual
```

- Çözme **varsayılan açıktır** (düşük/orta riskli sitelerde) ve site bazında `solveCaptcha: false` ile kapatılır.
  Kayıt config'inin tercihi **listeleme akışına da miras** kalır.
- Görsel (yazı) captcha tanınmaz ve çözülmez; hCaptcha 2captcha ile saha deneyiminde güvenilir değildir
  (bkz. [FIELD-NOTES.md](FIELD-NOTES.md)).

## 8. Dry-run anlamı

| Konu | Dry-run | Gerçek |
|---|---|---|
| `fill/select/check` | Çalışır | Çalışır |
| `click` | **Atlanır** — yalnızca onay kutusu/radyo etiketi DOM üzerinden işaretlenir | Gerçek tıklama |
| `expect` | Atlanır (gönderim yok) | Çalışır + kayıt sonrası tanıma |
| `captchaGate` | Ekran görüntüsü, çözme/bekleme yok | Çöz ya da insana düş |
| Kimlik kaydı | **Yok** | Gönderimden önce |
| Tarayıcı profili | Geçici (kalıcı profil yoksa) ve silinir | Kalıcı `data/profiles/<anahtar>` |
| Günlük limit | Sayılmaz | Sayılır |
| "Zaten kayıtlı" metni | Yok sayılır (`manual`) | Başarı |
| Listeleme: yazan istekler | **Tarayıcı düzeyinde engellenir** (giriş hariç) | Serbest |

Dry-run başarısı şunu kanıtlar: selector'lar gerçek sayfada bulunuyor, alanlar doldu, zorunlu alan boş kalmadı,
gönder düğmesi var. **Şunu kanıtlamaz:** gönderimden sonra ne olduğu.

`core/dry-run-check.ts` otomatik denetimi yapar: kritik alan (e-posta/parola) boş, formun zorunlu işaretlediği alan boş,
görünmez zorunlu alan, gönder adımı yok.

## 9. Listeleme akışı (`submitListing`)

Ayrıntılar için [LISTINGS.md](LISTINGS.md). Özet:

```
submitListing(siteId, { dryRun, force, productId })
 ├─ Kapılar (ağdan ÖNCE)
 │   listeleme config'i yüklenir ve doğrulanır (id = dosya adı)
 │   kayıt config'i: risk:high → atla; yoksa ve (gerçek koşu ya da giriş var) → failed
 │   login/listing/goto adresleri kayıt sitesinin alan adında olmalı (parola yalnızca orada yazılır)
 │   yükleme adımları yalnızca onaylı logo dosyalarını isteyebilir
 │   hesap şart: terminalResult = completed + credentials; "şifre kullanıcıda" ise manual
 │   GERÇEK: onay (profil + logo özeti) · günlük listeleme sınırı · önceki gönderim (liveSubmission)
 │   açık bir kayıt çalışması aynı hesabı tutuyorsa atla
 ├─ Kilit: "<anahtar>#submit"; kilit alındıktan SONRA önceki gönderim yeniden kontrol edilir
 ├─ Tarayıcı: dry-run → geçici profil + ağ koruması (yazan istekler engellenir, giriş hariç)
 ├─ Giriş: oturum işareti (loggedIn) yoksa login adımları; bitince oturumun kurulmasını bekle
 ├─ Form adımları (runSteps) — her gerçek tıklamadan önce "maybeSent" işaretlenir
 └─ dry-run: denetle → completed | manual     gerçek: başarı işaretini bekle → completed | unconfirmed
```

Değişmez ilkeler: **çift yayın yok** (belirsizse `unconfirmed`, otomatik yeniden deneme yok) ve **dry-run hiçbir şey yayınlamaz**.

## 10. Ledger (SQLite)

`data/ledger.sqlite` (WAL kipi), `integrations/ledger.ts`. `better-sqlite3` kullanılır (`node:sqlite` vitest'te
çözülemediği için seçilmedi).

| Tablo | Amaç | Kritik alanlar |
|---|---|---|
| `locks` | Atomik kilit (INSERT çakışması = kilitli) | `site_id` (hesap anahtarı ya da `anahtar#submit`), `run_id`, `expires_at` |
| `attempts` | Hesap açma denemeleri | `status`, `terminal`, `dry_run`, `note`, `started_at/finished_at` |
| `credentials` | Hesap kimliği (şifre YOK) | `email`, `username`, `pw_version`, `profile_url` |
| `submissions` | Listeleme denemeleri (`attempts`'tan ayrı) | `account_key`, `status`, `dry_run`, `listing_url`, `note` |
| `seen_messages` | Kullanılmış doğrulama mailleri | `message_id`, `site_id` |

Kurallar:

- **`terminalResult(anahtar)`**: dry-run olmayan, `terminal=1` son deneme (`finished_at DESC, id DESC`).
  Hesap "var" demek = bu sonucun `completed` olması **ve** `credentials` kaydı.
- **`countToday()`**: yerel gün başından beri başlayan, dry-run olmayan, `skipped%` olmayan denemeler.
  Başarısız ve yeniden denemeler de **sayılır**.
- **`adoptAccount()`**: gerçekte açık ama yanlış `failed` yazılmış hesabı `completed` yapar; gün sayacını tüketmez
  (başlangıcı gün başından önceye yazılır). Yalnızca insan kanıtıyla kullanılır.
- **`liveSubmission(anahtar)`** — "bu hesapla gerçek gönderim yapılmış olabilir mi?": `failed` **dışındaki** her
  gerçek durum engeller (`completed`, `unconfirmed`, hâlâ `running`, `error`, bilinmeyenler). Beyaz liste değil kara liste.
- **Yetim kayıtlar**: ledger açılırken süresi dolmuş kilit silinir; kilidi olmayan `running` hesap denemesi `error`,
  `running` **gerçek** listeleme `unconfirmed` (çift yayın riski), dry-run listeleme `error` olur.

## 11. Keşif hattı

`scripts/discover.ts` → `discovery/find-signup.ts` → `analyze-form.ts` → `generate-config.ts`.

1. **Kayıt sayfasını bul** (`findSignupPage`), üç adımda: (0) site ayakta mı (yanıt vermeyen sitede 8 yolu
   tek tek denememek için), (1) tahmin edilebilir yollar (`/signup`, `/register`, `/auth/register`, `/join`, …),
   (2) ana sayfadaki "Sign up / Register / Submit your startup / Get started…" bağlantılarını izleme.
   Bot duvarı, park edilmiş alan adı, başka platforma yönlenme, "form yok", yalnızca e-posta alanlı gönderim
   formu (`submit_form`) ve "önce e-posta" (`email_first`) durumları ayrı sonuçlardır. Giriş sayfaları kayıt
   sayfası sayılmaz.
2. **Formu analiz et**: alanları okur, semantik adlara eşler (`email`, `password`, `companyName`, …). Pazarlama/bülten
   kutuları **asla** işaretlenmez. Seçici önceliği: kararlı `id` → `name` → `type` → `aria-label` → dinamik görünümlü `id`
   → etiket (üretilmiş kimlikler — UUID, md5, React `useId`… — `selectors.ts` ile elenir).
3. **Config üret**: `goto → dismiss → waitFor → fill'ler → captchaGate → click → expect` sırası. Her üretilmiş config
   `OTOMATİK ÜRETİLDİ — doğrulanmadı` damgası taşır; `run-batch` damgalı config'leri atlar.
   Yüksek riskli alan adları (G2, Capterra, Trustpilot, Product Hunt, Gartner, GetApp, Software Advice) `risk: high` olur.
4. **Doğrula** (`scripts/verify-drafts.ts`): her taslak ayrı süreçte `run-one --dry-run` ile denenir; başarılıysa damga
   kalkar, değilse neden ledger'a ve `data/verify-drafts/progress.json`'a yazılır.

Keşif sonuçları sekme başına `data/discovery-<sekme>.json` dosyasında tutulur; doğrulanmış config'ler yeniden
taranıp ezilmez (`discover-queue.ts` kuralları).

## 12. Sheet entegrasyonu

`integrations/sheet.ts` (+ `discovery/annotate.ts`). Kaynak Sheet'in kendi kolonlarına (Durum, Not…) `run-batch`
yazar; **otomasyon durumu** ise ayrı üç kolona yazılır: `Otomasyon Durumu`, `Otomasyon Sorunu`, `Otomasyon Notu`
(`scripts/sheet-annotate.ts`). Sınıflar bilerek az ve kalıcıdır (`DURUM` sabitleri); ayrıntı Not kolonundadır.
Sheet hatası hiçbir zaman çalışmayı düşürmez.

## 13. Hata sınıflandırması ve durumlar

`core/errors.ts`: `TransientError` (ağ/zaman aşımı → `error`, yeniden denenebilir), `PermanentError` (sayfa yüklendi
ama selector yok → `failed`), `CaptchaRequiredError`/`ManualReviewError` (→ `manual`). **Bilinmeyen hata kalıcı sayılır**
(fail-closed).

Hesap açma sonuçları (`TerminalStatus`):

| Durum | Anlam | Terminal mi? |
|---|---|---|
| `completed` | Hesap açık (ya da zaten vardı) | Evet |
| `failed` | Kalıcı hata | Evet |
| `manual` | İnsan bakmalı (captcha, belirsiz sonuç, çakışma…) | Evet |
| `error` | Geçici hata (ağ kesintisi, doğrulama maili gelmedi) | Hayır — yeniden denenir |
| `email_timeout` | Doğrulama maili zaman aşımı | Hayır |
| `skipped_locked / _limit / _terminal / _high_risk` | Kapı reddetti; deneme sayılmaz | — |

Listeleme sonuçları (`SubmitStatus`): `completed`, `unconfirmed`, `failed`, `manual`, `error`, `skipped_no_account`,
`skipped_not_approved`, `skipped_done`, `skipped_unverified`, `skipped_locked`, `skipped_high_risk`,
`skipped_daily_limit`. Anlamlar için [LISTINGS.md](LISTINGS.md#7-durumlar).

## 14. Çalışma zamanı dosyaları

Hepsi git dışındadır (`.gitignore`).

| Yol | İçerik |
|---|---|
| `.env` | Yapılandırma ve sırlar (`MASTER_SECRET`, `CAPTCHA_API_KEY`…) |
| `.auth/` | Gmail OAuth istemci dosyası ve token(lar)ı |
| `data/ledger.sqlite` | Ledger (+ `-wal`/`-shm`) |
| `data/profiles/<hesapAnahtarı>/` | Kalıcı tarayıcı profili (çerezler, Cloudflare çözümleri); `.dry-*` = geçici dry-run profilleri |
| `data/approvals/<ürün>.json` | Listeleme onayı (içerik özeti + zaman) |
| `data/discovery-<sekme>.json` | Sekme başına keşif ilerlemesi |
| `data/verify-drafts/` | Toplu dry-run ilerlemesi (`progress.json`), kilit, `STOP`, loglar |
| `data/pilot/` | `run-list` çalıştırmaları: site başına log, `results.jsonl`, `STOP`, listeler |
| `data/reports/` | Üretilmiş raporlar (hazır siteler vb.) |
| `artifacts/<runId>/<hesapAnahtarı>/` | Hata anı ekran görüntüsü + HTML (parola alanları temizlenmiş) |

## 15. Modül haritası

| Modül | Sorumluluk | Saf mı? |
|---|---|---|
| `config.ts` | `.env` yükleme ve zod doğrulaması | — |
| `cli.ts`, `cli-args.ts` | Komutlar; argüman ayrıştırma (ayrı dosya çünkü `cli.ts` import edilince çalışır) | `cli-args` saf |
| `core/runner.ts` | Hesap açma durum makinesi | Hayır |
| `core/submitter.ts` | Listeleme durum makinesi | Hayır |
| `core/listing-approval.ts` | Onay özeti (profil + logo baytları), kayıt/okuma | Kısmen |
| `core/approval-prompt.ts` | `approve-profile` insan adımı (TTY + yazılı kod; profil ürünün kendi sitesinden farklıysa ek onay ifadesi) | G/Ç enjekte edilir |
| `core/site-facts.ts` | Ürünün KENDİ sitesinin başlık/açıklama/ana başlığını okur ve profille sözcük örtüşmesini ölçer | `extractSiteFacts`/`siteOverlap` saf; `fetchSiteFacts` tek GET |
| `core/post-submit.ts` | Kayıt sonrası durum tanıma (`decidePostSubmit` saf) | Karar saf |
| `core/verification-entry.ts` | Kod girişi (tek/çok kutu) | Hayır |
| `core/browser.ts` | Playwright context, kalıcı/geçici profil, `__name` yardımcısı | Hayır |
| `core/captcha.ts` | Captcha tespiti, passive/interaktif ayrımı, çözüldü izleme | Hayır |
| `core/dry-run-check.ts` | Dry-run sonrası otomatik denetim | Hayır |
| `core/formfill.ts` | Alan değerleri (`resolveField`), insan hızında yazma, açıklama varyantı seçimi | Kısmen |
| `core/errors.ts`, `core/markers.ts`, `core/types.ts` | Hata sınıfları, config işaretleri, sözleşmeler | Evet |
| `core/run-list.ts` | Liste çalıştırıcının kuralları (durdurma, bekleme, ağ kesintisi) | Evet |
| `core/artifacts.ts` | Ekran görüntüsü/HTML yakalama | Hayır |
| `adapters/schema.ts`, `submission-schema.ts` | Config şemaları (zod) | Evet |
| `adapters/generic.ts` | Adım yorumlayıcı (`runSteps`), onay kutusu/pazarlama kutusu mantığı | Hayır |
| `adapters/registry.ts`, `submission-registry.ts` | Config yükleme (`overrides/` ayrılmış, boş) | Hayır |
| `discovery/*` | Bulma, analiz, üretim, Sheet sınıflandırması (`annotate.ts` saf) | Karışık |
| `identity/*` | Hesap anahtarı, şifre, e-posta, profil | Evet |
| `integrations/ledger.ts` | SQLite | Hayır |
| `integrations/gmail.ts`, `mail-parse.ts`, `mime.ts` | Posta: ağ/polling · ayrıştırma · MIME | `mail-parse`, `mime` saf |
| `integrations/sheet.ts` | Sheets API | Hayır |
| `integrations/captcha-solver.ts` | 2captcha istemcisi | Hayır |

Not: şemada bulunan **`stealth`** alanı ve adım türü **`custom`** şu an **uygulanmamıştır** (etkisizdir). Proje politikası
gizlenme/stealth kullanmamaktır (bkz. [SECURITY-AND-POLICY.md](SECURITY-AND-POLICY.md)).
