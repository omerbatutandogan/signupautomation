# Sorun giderme

**Belirti → neden → çözüm.** Her satır gerçek bir olaydan ya da kodun gerçek bir mesajından gelir. Önce belirtiyi (log/çıktı metnini) bulun; bulamazsanız §7'deki genel teşhis adımlarına bakın.

## İçindekiler

1. [Kurulum ve ortam](#1-kurulum-ve-ortam)
2. [Gmail ve doğrulama mailleri](#2-gmail-ve-doğrulama-mailleri)
3. [Kayıt (run-one / liste)](#3-kayıt-run-one--liste)
4. [Captcha ve bot koruması](#4-captcha-ve-bot-koruması)
5. [Listeleme (submit)](#5-listeleme-submit)
6. [Sheet](#6-sheet)
7. [Genel teşhis](#7-genel-teşhis)
8. [Bilinen sınırlamalar](#8-bilinen-sınırlamalar)

---

## 1. Kurulum ve ortam

| Belirti | Neden | Çözüm |
|---|---|---|
| `.env dosyası eksik veya hatalı: MASTER_SECRET en az 32 karakter olmalı` | `.env` yok, eksik ya da kısa. **Testler dahil her komut** `.env` ister | `cp .env.example .env`; `openssl rand -hex 32` çıktısını `MASTER_SECRET`'a, geçerli bir adresi `SIGNUP_EMAIL`'e yazın. Testler için sahte değerler yeterlidir |
| `Executable doesn't exist at …` (Playwright) | Playwright'ın Chromium'u kurulu değil | `npx playwright install chromium` |
| `__name is not defined` (log'da ya da `Kayıt sonrası durum tespit edilemedi` uyarısı) | CLI `tsx` ile çalışır; esbuild `keepNames` her adlandırılmış fonksiyona `__name(...)` ekler ve `page.evaluate`'e giden fonksiyon sayfada çalışırken bu yardımcıyı bulamaz. Vitest bunu eklemediği için testler geçerken gerçek çalıştırmada kayıt sonrası tanıma sessizce `unknown` dönüyordu | `core/browser.ts` her sayfaya `__name` tanımlayan bir başlangıç betiği ekler; **kendi başınıza tarayıcı açan** betiklerde (`launchContext` kullanmıyorsanız) aynısını ekleyin ya da `page.evaluate`'e adlandırılmış iç fonksiyon vermeyin. Regresyon: `test/keepnames.test.ts` |
| Komutlar eski/boş veri görüyor, token "ölü" | Projenin **bayat bir kopyasında** (iCloud Desktop) çalışıyorsunuz | `pwd` ve `git status` ile doğru klasörü doğrulayın; `.env`, `.auth/`, `data/` her kopyada ayrıdır ([OPERATIONS.md §1](OPERATIONS.md#1-token-yenileme-haftalık)) |
| Çıktı temiz ama komut bir şey yapmadı, `echo $?` 1 | `npm run typecheck`/`test`'i `\| head` ile boru yaptınız; çıkış kodu `head`'inkidir | Çıkış kodunu boru olmadan okuyun |

## 2. Gmail ve doğrulama mailleri

| Belirti | Neden | Çözüm |
|---|---|---|
| `Gmail kimlik dosyaları eksik (…) Önce çalıştır: npm run gmail:auth` | `.auth/` altında istemci/token yok (yanlış klasör olabilir) | `npm run gmail:auth`; doğru klasörde olduğunuzu doğrulayın |
| `Gmail erişimi başarısız — token ölmüş olabilir (test kullanıcısı modunda 7 gün)` | Refresh token 7 günde ölür | `npm run gmail:auth`, sonra `npm run cli -- check-gmail` |
| `check-gmail`: `⚠️ .env'deki SIGNUP_EMAIL (…) ile farklı!` | OAuth'ta farklı bir Google hesabıyla giriş yaptınız | Kayıt adresiyle yeniden `gmail:auth` yapın ya da `.env`'i bilinçli olarak güncelleyin; o hesap **Test users** listesinde olmalı |
| Log'da tekrarlayan `Gmail listeleme hatası, tekrar denenecek`, sonunda `Doğrulama maili 600 saniyede gelmedi` | **Token ölmüş** (ya da kota/ağ hatası): kod hatayı geçici sayıp süre dolana kadar dener ve sonunda "mail gelmedi" der | `check-gmail`. Token ölüyse yenileyin; ölü token'la koşan her site 10 dk harcar ve `error` yazar ([§8](#8-bilinen-sınırlamalar)) |
| `Doğrulama maili N saniyede gelmedi` (token sağlam) | (a) Site **hiç mail göndermiyor** (config `mode: link` ama gerçekte `none`); (b) mail çok geç/hiç ulaşmadı; (c) gönderen başka alan adında ve gövde site alan adını anmıyor; (d) `from`/`subjectContains` fazla katı | Kutuyu elle kontrol edin: `npm run mail:recent -- 15` (`in:anywhere`: spam ve çöp kutusu dahil son 15 mail) ya da Gmail'de site adıyla arayın. Mail yoksa sitenin mail göndermediğini config `notes`'una yazın ve `mode: none` (+ gerekirse `unverifiedAccount: true`) yapın; (c)/(d) için `from`'u kaldırın |
| `linkPattern maildeki hiçbir linkle eşleşmedi` | `linkPattern` regex'i mailin bağlantısıyla uyuşmuyor | Mailin gerçek bağlantısına göre regex'i düzeltin ya da kaldırıp genel skorlamaya bırakın |
| `Doğrulama linki belirsiz — eşit skorlu iki aday` / `Mailde doğrulama linki bulunamadı` | Genel skorlama karar veremedi | `linkPattern` verin |
| `Doğrulama kodu 6 haneli ama sayfada 1 kutu var` (ya da tersi) | `codeSelector` yanlış sayıda kutu seçiyor | Rakam başına kutu varsa hepsini seçen bir seçici (`input[maxlength='1']`); tek alan varsa tek alan |
| Kod ekranı çıktı ama kod girilmedi | Kayıt sonrası tanıma kodu tanıdı ama mail gelmedi | Yukarıdaki "mail gelmedi" satırı; hesap doğrulanmamış kalır |
| Mail geldi ama `Aday doğrulama maili bulundu` yok | Gönderen alan adı eşleşmedi (üçüncü taraf gönderici) ve gövde site alan adını anmıyor | `verification.from`'u kaldırın; gövde site alan adını içermiyorsa o site için `subjectContains` ile daraltın |

## 3. Kayıt (run-one / liste)

| Belirti | Neden | Çözüm |
|---|---|---|
| `skipped_terminal` ("önceki sonuç: failed/manual/completed") | Terminal sonuç bir daha otomatik denenmez (körlemesine tekrar sinyal üretir) | Config düzeldiyse `run-one <site> --force`; hesap gerçekte açıksa `adopt-account` |
| `skipped_locked` ("kilit sahibi: …") | Aynı hesapta başka koşu var **ya da** önceki süreç öldürüldü ve kilit kaldı | Biri bitsin; ölü süreçse `npm run cli -- unlock <site>` (ya da 45 dk bekleyin) |
| `skipped_limit` ("bugün N/M") | Günlük gerçek deneme sınırı doldu | Yarın; ya da bilinçli olarak `DAILY_LIMIT` ([OPERATIONS.md §2](OPERATIONS.md#2-ayarlar-ve-hız-sınırı)) |
| `skipped_high_risk` | Site ToS'u otomatik erişimi yasaklıyor | Yapılacak bir şey yok; elle kayıt |
| `manual`: `Site taşınmış, onay bekliyor` | Keşif sitenin başka alan adına taşındığını gördü | Doğru site mi kontrol edin; doğruysa config `notes`'taki `TAŞINMA ONAYI BEKLİYOR` damgasını silin |
| `manual`: `bu sitede "<anahtar>" hesabı aynı e-postayı kullanıyor` | İkinci ürün aynı e-postayla aynı siteye kaydolamaz (site "zaten kayıtlı" der ve sistem başka ürünün hesabını bu ürün sanırdı) | Ürün profiline ayrı `signupEmail` verin |
| `Selector bulunamadı: …` (kalıcı) | Form değişmiş ya da seçici dinamik kimlik içeriyor | `npm run inspect -- <url>` ile yeniden okuyun; kararlı `name`/`placeholder` seçin ([SITE-CONFIGS.md §10](SITE-CONFIGS.md#10-config-yazma-rehberi)) |
| `Sayfa yüklenmedi, selector beklenemedi` | Sayfa geç/hiç yüklenmedi (geçici) | Yeniden deneyin; sürekli oluyorsa site yavaş/engelli: `timeoutMs`'i artırın |
| `Beklenen içerik görünmedi` | `expect` deseni sitenin gerçek metniyle tutmuyor ya da kayıt gerçekten başarısız | `artifacts/…/failure-*.png`/`.html`'e bakın: hesap açıldıysa deseni gerçek metne göre düzeltin; açılmadıysa nedeni bulun |
| `Alan doldurulamadı (boş kaldı)` | Alan JS ile sıfırlanıyor, üstünde örtü var ya da yanlış öğe | Seçiciyi gerçek `<input>`'a çevirin; `waitFor` + `humanPause` ekleyin |
| `Yazılan değer kırpıldı — alan sınırı beklenenden dar` (uyarı) | Alan `maxlength`'i dar | `description` için otomatik uygun varyant seçilir; diğer alanlarda kullanıcı adı/şifre politikası kontrol edin |
| Dry-run: `Kritik alan BOŞ — sayfa bu alanı ZORUNLU işaretliyor (checkbox)` | Şartlar kutusu işaretlenmiyor (görünmez/özel stilli kutu) | Etiket seçicisi ekleyin: `label[for='…']` ya da `label:has(input[name='…'])` |
| Gerçek koşuda şartlar kutusu boş kaldı, dry-run'da değildi | Etiketin ortasındaki "Terms" bağlantısına tıklanıyordu | Güncel kod etiketi DOM'dan işaretler; hâlâ oluyorsa etiket seçicisi kullanıldığından emin olun (`click` + `label…`) |
| Kayıt formu pazarlama kutusunu işaretli gönderdi | Site kutuyu önceden işaretli getirdi | Güncel kod gerçek tıklamadan önce kaldırır (log: `Önceden işaretli pazarlama kutusu KALDIRILDI`); kaldırılamıyorsa (`stuck`) siteyi elle inceleyin |
| `Username cannot contain special characters` | Site alt çizgiyi reddediyor | `"usernameStyle": "plain"` |
| Site şifreyi reddediyor (uzunluk/sembol) | Şifre politikası | `passwordPolicy` (`maxLen`, `noSymbols`, `allowedSymbols`) |
| Koşu `failed` ama hesap gerçekte açık | Oturum açık kaldı ya da doğrulama yoktu; sınıflandırma yanlış | `password <site>` ile elle girin; açıksa `adopt-account <site> --note "<kanıt>"` |
| Koşu hemen `completed` ("Hesap zaten mevcut") | Site "bu e-posta kayıtlı" dedi: tek e-posta mimarisinde hesap bizimdir | Beklenen; emin değilseniz `password <site>` ile girişle doğrulayın |
| `ERR_INTERNET_DISCONNECTED` / `ERR_NETWORK_CHANGED` | Bizim bağlantımız kesildi (Mac Wi‑Fi) | Liste çalıştırıcı bunu başarısızlık saymaz, bekler ve site sonda yeniden denenir |
| `net::ERR_NAME_NOT_RESOLVED` / `ERR_CONNECTION_*` | Site ölü ya da geçici ağ sorunu (`error`, terminal değil) | Tekrarlıyorsa siteyi listeden çıkarın |
| Koşu bir captcha'da saatlerce bekledi | `CAPTCHA_TIMEOUT_MS` 15 dk ve insan yok | Gözetimsiz koşuda `CAPTCHA_TIMEOUT_MS=120000` |
| Liste "N ardışık başarısızlık — duruyorum" | Güvenlik freni: sistem çapında bozulma olabilir (token, ağ, kod) | Loglara bakın; sorun sitelere özgüyse `--max-failures`'ı artırıp devam edin |
| Liste çalıştırıcı hemen çıkıyor / `⏹ … STOP bulundu` | `data/pilot/STOP` dosyası kalmış | `rm data/pilot/STOP` |
| `verify-drafts` hemen bitiyor | `data/verify-drafts/STOP` kalmış | Silin |
| Mac uyudu, koşu takıldı | Uyku koşuyu ve ağı keser | `caffeinate -is` ile çalıştırın; kesilmiş listeyi (bitenleri çıkarıp) yeniden başlatın |
| `data/profiles/.dry-*` klasörleri birikti | Yarıda ölen dry-run'ın geçici profilleri | Hiçbir tur çalışmıyorken silin |

## 4. Captcha ve bot koruması

| Belirti | Neden | Çözüm |
|---|---|---|
| `Captcha insan müdahalesi gerektiriyor: <tür>` (`manual`) | Çözücü yok/başarısız ve süre içinde kimse çözmedi | Görünür tarayıcıda siz çözün (akış kendiliğinden sürer) ya da siteyi bırakın |
| hCaptcha'da `2captcha çözemedi, insana düşülüyor` | hCaptcha'yı 2captcha ile çözmek bu sitelerde **güvenilir değil** (180 sn zaman aşımı) | `solveCaptcha: false` yazıp insana bırakın; ya da siteyi bırakın |
| Formda görsel (yazı/resim) captcha (`SecureImg`, "Type Image Values", "Enter the characters above") | Görsel captcha **desteklenmiyor** | Siteyi bırakın; `notes`'a yazın (aynı motoru kullanan site ailesi toplu elenir: [FIELD-NOTES.md](FIELD-NOTES.md)) |
| Kayıt formu görünmüyor, "Verify you are human" (Cloudflare/Turnstile duvarı) | Bot koruması duvarı | **Aşılmaya çalışılmaz**; "Bot koruması" olarak bırakın |
| Formda "Please leave this field empty. It is for robots" | Bal tuzağı alanı: botları ele veriyor | Bu alanı doldurmayın; config'de yoksa sorun başka yerdedir |
| `Passive captcha tespit edildi, devam ediliyor` | Görünmez/skorlayan captcha | Normal |

## 5. Listeleme (submit)

| Belirti | Neden | Çözüm |
|---|---|---|
| `skipped_not_approved`: "ürün bilgisi henüz onaylanmamış" / "onaydan sonra DEĞİŞMİŞ" | Onay yok ya da profil/logo değişti | `npm run cli -- approve-profile <ürün>` (insan adımı, TTY şart) |
| `approve-profile`: "etkileşimli bir terminal ister" | Komut borudan/betikten çalıştırıldı | Gerçek bir terminalde çalıştırın |
| Onay verilmişti ama bu makinede yok | Onay `data/approvals/` altında, makineye özel | Bu makinede yeniden onaylayın |
| `skipped_no_account` | Bu ürün + site için açık hesap yok | Önce `run-one <site>` |
| `manual`: "Hesabın şifresi kullanıcıda" | Hesap sistemden önce vardı; türetilen şifre geçmiyor | Elle listeleyin ya da şifreyi sistemle uyumlu hale getirin |
| `failed`: "Gerçek listeleme için kayıt config'i … gerekli" | `src/sites/<id>.json` yok | Kayıt config'ini yazın (risk, captcha tercihi, şifre politikası, alan adı oradan gelir) |
| `failed`: "Listeleme/giriş adresi kayıt sitesinin alan adında değil" | `listingUrl`/`login.url`/`goto` başka bir alan adına gidiyor; şifre oraya yazılmaz | Adresi düzeltin (alt alan adları serbest, başka site değil) |
| `failed`: "Giriş yapılamadı (oturum işareti görünmedi)" | Giriş adımları/`loggedIn` seçicisi yanlış, şifre geçmiyor, ya da giriş istekleri tamamlanmadan sayfa değişti. Sistem girişi **bir kez daha** dener (reklam-yoğun sitelerde sayfa yeniden yüklenip yazılanı siliyor); iki denemede de tutmadıysa buradasınız | `artifacts/…/login-failed.png`'ye bakın; `loggedIn`'i giriş sonrası **formun kendi alanı** yapın; elle girişle şifreyi doğrulayın |
| `failed`: "Oturum açık değil ve config'te giriş adımları (login) yok" | `loggedIn` tanımlı ama `login` yok | `login` ekleyin |
| `failed`: "Başarı işareti gönderimden ÖNCE de görünüyor" | `success` seçicisi/adres parçası form sayfasında zaten var (sahte başarı verir) | Gönderimden **sonra** oluşan bir işaret seçin; `urlContains` parçası `listingUrl`'de olmamalı |
| `failed`: "Form adımları bitti ama gönderim yapılmadı" | Config'te çalışan bir `click` yok (ya da dry-run'dı) | Gönder `click`'ini ekleyin |
| `failed`: "Yükleme adımı onaylı logo dosyaları dışında bir dosya istiyor" | `upload.file` profildeki `logo` yollarından biri değil | Yolu profildeki `logo` değeriyle birebir yazın (`assets/logo-256.png`); dosya `src/profile/assets/` altında olmalı |
| Dry-run `manual`: "form tıklanmadan kendiliğinden göndermeye çalıştı, engellendi" | Site bir alanın değişmesiyle formu kendisi gönderiyor (`onchange` → submit) | Bu alanı başka bir yolla doldurun ya da sitenin akışına göre adımları yeniden düzenleyin; gerçek gönderimde de aynı olacağı için ihmal etmeyin |
| Dry-run `manual`: "dry-run BAŞARISIZ: Kritik alan BOŞ…" | Zorunlu alan config'te yok/boş | İlgili `fill`/`select`'i ekleyin; değeri profilde yoksa **uydurmayın**, ürün sahibine sorun |
| Giriş sonrası tıklamalar çalışmıyor (karşılama penceresi) | Pencere tıklamaları kapıyor | `waitFor` + `dismiss` ekleyin (10words'te yaşandı) |
| `unconfirmed` | Gönderim yapılmış **olabilir**, başarı işareti görünmedi ya da gönderimden sonra hata | Not'taki **"Sayfa uyarısı"** nedeni söyler (ör. sideprojects: "That launch date is full — pick another."). Hesaba girip ürünün oluşup oluşmadığına **elle bakın**. Oluşmuşsa `--force` ile **tekrar göndermeyin**; oluşmadıysa `reject-submission <site> --note "<kanıt>"` ile "yayınlanmadı" diye işleyin, nedeni giderip yeniden deneyin |
| `unconfirmed`, ekran görüntüsünde **2. sayfa ilk haliyle** duruyor (alanlar boş/varsayılan, kod boş) | Çok sayfalı formda sonraki sayfanın adımları `when` ile korunuyor ama koşul tıklamanın hemen ardından, sayfa değişmeden okundu → hepsi atlandı (1look4, 14 Ekim) | İlk korunan adıma `"when": { …, "waitMs": 20000 }` ekleyin ([SITE-CONFIGS.md](SITE-CONFIGS.md#her-adımda-bulunabilen-ortak-alanlar)). Hiçbir şey yayınlanmadıysa `reject-submission` ile işleyin |
| `completed` ama ürün anonim ziyaretçiye görünmüyor | Site moderasyon/sahiplik onayı istiyor ya da yalnızca sahibe gösteriyor | Normal olabilir: giriş yapmadan listeleme adresini açıp doğrulayın, sonucu `notes`'a yazın ([LISTINGS.md §6](LISTINGS.md#6-gönderimden-sonra)) |
| `approve-profile`: "UYARI: Profil, sitenin kendi anlatımından FARKLI görünüyor" | Profil metni ürünün kendi sitesindeki başlık/açıklamayla örtüşmüyor (yanlış ürün tanımı olabilir) | Ekrandaki iki metni yan yana okuyun; profil yanlışsa `src/profile/<ürün>.json`'u sitenin kendi sözleriyle düzeltin. Bilerek farklıysa kod yerine `FARKLI ONAYLIYORUM` yazın |
| Yayınlanmış bir kayıtta yanlış ürün bilgisi bulundu | Eski/yanlış profille gönderilmiş (listeleme, toplist kaydı, forum profil alanı) | Önce profili düzeltip `approve-profile` ile yeniden onaylayın; sonra ilgili kaydı sahibin düzenleme ekranından (ör. toolsnocode "Edit") düzeltin. Silme çoğu sitede yoktur |
| `skipped_done` / `skipped_unverified` | Daha önce gönderilmiş (ya da belirsiz) | Elle kontrol; bilinçli yeniden gönderim için `--force` |
| `skipped_daily_limit` | Bugünkü gerçek gönderim sınırı doldu | Yarın (`--force` aşmaz) |

## 6. Sheet

| Belirti | Neden | Çözüm |
|---|---|---|
| `Sheet bağlanamadı` | `SHEET_ID` boş, token'da Sheets yetkisi yok ya da token ölü | `.env`'i, `npm run gmail:auth`'u (spreadsheets izni) kontrol edin |
| `sheet-annotate` "sekme bulunamadı"/boş satır | Sekme adı tam eşleşmiyor (bazılarında **sonda boşluk** var: `"Deals "`, `"File Upload "`) | `SHEET_TAB`'ı tırnak içinde, boşluğuyla birlikte yazın |
| Yazım hatası: `Sheet yazımı başarısız` (uyarı) | Kota/ağ/yetki | Çalışmayı **düşürmez** (Sheet otorite değil); sonra `sheet-annotate`'i yeniden çalıştırın |
| `.co.uk`, `.com.au`… sitelerinin satırları yanlış durum gösteriyordu | `siteIdFromWebsite` ikili uzantılarda yanlış etiket alıyordu (`co-uk`) ve farklı siteler aynı kimliğe düşüyordu | 13 Ekim 2026'da düzeltildi; Sheet'i yeniden etiketleyin (`sheet-annotate --all`). Bu uzantılı siteler artık ayrı kimlik alır ve `discover` ile taranabilir |

## 7. Genel teşhis

1. **Hangi klasördesiniz?** `pwd && git status --short --branch`.
2. **Ortam sağlıklı mı?** `npm run cli -- check-gmail`, `npm run cli -- products`, `npm run cli -- status`.
3. **Ne olduğunu kanıt söylesin:** `artifacts/<runId>/<anahtar>/failure-*.png|html` (yol çıktıda yazılır). Sayfa metni, hata nedenini çoğu zaman doğrudan gösterir.
4. **Tek siteyi yeniden üretin:** `LOG_LEVEL=debug npm run cli -- run-one <site> --dry-run` (görünür tarayıcı varsayılan). Seçici sorunlarını `npm run inspect -- <url>` ile görün.
5. **Ledger'a bakın (salt okunur):**
   ```bash
   sqlite3 -readonly data/ledger.sqlite "select id, site_id, status, dry_run, substr(note,1,90) from attempts order by id desc limit 20"
   sqlite3 -readonly data/ledger.sqlite "select account_key, status, dry_run, listing_url from submissions order by id desc limit 10"
   ```
   Ledger'a elle **yazmayın**; düzeltme için `adopt-account`, `unlock` ya da `--force` kullanın.
6. **Yeni bir hata türü bulduysanız** önce bir test yazarak yeniden üretin, sonra düzeltin ([DEVELOPER-GUIDE.md §4–5](DEVELOPER-GUIDE.md#4-test-stratejisi)) ve burayı güncelleyin.

## 8. Bilinen sınırlamalar

Dürüst liste: bunlar bilinen eksiklerdir, gizli hata değildir.

- **Ölü Gmail token'ı geç fark edilir.** Gmail listeleme hatası geçici sayılıp süre dolana kadar tekrarlanır; token ölüyse her doğrulamalı site `EMAIL_TIMEOUT_MS` (10 dk) harcayıp `error` yazar. Uzun bir listeden önce `check-gmail` çalıştırın; token 5 günü geçtiyse yenileyin.
- **Eski kimlik çakışması düzeltildi, ama taranmamış siteler var:** `.co.uk`, `.com.au`, `.co.nz`… gibi ikili uzantılı yaklaşık 120 site (39 çöken kimlik) eskiden hiç taranmamıştı; kimlik düzeltildiği için artık taranabilir durumdalar, fakat `discover` henüz çalıştırılmadı (Sheet'te "Taranmadı" görünürler).
- **Uygulanmamış özellikler:** `stealth` ve `custom` adım türü şemada vardır ama çalışmaz; `emailLocalPart` kullanılmaz; `src/adapters/overrides/` boştur (kod override mekanizması yüklenir ama hiç override yoktur);
  **Telegram bildirimi uygulanmamıştır** — captcha'da insan devralması yalnızca terminal çıktısı ve görünür tarayıcıyla çalışır.
- **Logo dosyaları yok:** `src/profile/assets/` boştur; profil `assets/logo-*.png` yollarını gösterir. Onay kaydı bunları "dosya yok" olarak bağlar; logo eklemek içeriği değiştirdiği için **yeniden onay** ister ve logo isteyen listeleme formları atlanır.
- **Dry-run kayıt sonrasını doğrulamaz:** doğrulama türü ve başarı sayfası yalnızca ilk gerçek koşuda ortaya çıkar; ilk gerçek koşularda hata beklenir.
- **`completed` = başarı işareti gördük**, "herkese açık" demek değildir (listeleme; [LISTINGS.md §6](LISTINGS.md#6-gönderimden-sonra)).
- **Zamanlayıcı yok:** kayıtlar elle ya da `scripts/run-list.ts` ile başlatılır. `node-cron` bağımlılığı kullanılmıyordur; `CRON_SCHEDULE`/`SITES_PER_TICK` gibi eski yer tutucular `.env.example`'dan kaldırıldı (hiçbir kod okumuyordu).
- **Parola sürümü yükseltme akışı yok:** şifre sürümü alanı hazırdır ama değiştirme/otomatik şifre sıfırlama akışı uygulanmamıştır.
- **`run-one` çıkış kodu:** `skipped_limit`/`skipped_locked` dahil tüm `skipped_*` durumları 0 döner; betikler durumu çıktıdaki metinden okumalıdır (`scripts/run-list.ts` öyle yapar).
