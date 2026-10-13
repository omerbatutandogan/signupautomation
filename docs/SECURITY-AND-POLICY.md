# Güvenlik ve politika

Bu belge iki şeyi söyler: **sırlar nasıl korunur** ve **sistemin neyi hiçbir koşulda yapmadığı**. Kod bu kuralları uygular; testler (özellikle `test/submitter.test.ts`,
`test/artifacts-scrub.test.ts`, `test/no-forbidden-name.test.ts`) bozulmalarını yakalar. Bir kuralı gevşetmek, yalnızca projenin sahibinin açık kararıyla ve burada belgelenerek yapılır.

## İçindekiler

1. [Sırlar](#1-sırlar)
2. [Şifre türetme](#2-şifre-türetme)
3. [Log ve kanıt dosyaları](#3-log-ve-kanıt-dosyaları)
4. [E-posta erişimi](#4-e-posta-erişimi)
5. [Captcha, bot koruması ve kullanım şartları](#5-captcha-bot-koruması-ve-kullanım-şartları)
6. [Kimlik ve içerik politikası](#6-kimlik-ve-içerik-politikası)
7. [Rıza ve pazarlama onayı](#7-rıza-ve-pazarlama-onayı)
8. [Hız ve nezaket](#8-hız-ve-nezaket)
9. [Listeleme güvenliği](#9-listeleme-güvenliği)
10. [Yapılmayacaklar](#10-yapılmayacaklar)
11. [Sır sızarsa ne yapılır](#11-sır-sızarsa-ne-yapılır)

---

## 1. Sırlar

| Sır | Nerede yaşar | Asla |
|---|---|---|
| `MASTER_SECRET` | Yalnızca `.env` (`chmod 600`) + parola yöneticisinde yedek | repo, log, ekran görüntüsü, sohbet, destek talebi |
| `CAPTCHA_API_KEY` (2captcha) | Yalnızca `.env` | repo, log |
| OAuth istemci dosyası ve token | `.auth/` (git dışı) | repo, başka klasöre kopya |
| Türetilmiş site şifreleri | **Hiçbir yerde saklanmaz**; ihtiyaç anında üretilir | veritabanı, log, artifact |

`.gitignore` bunları dışarıda tutar (`.env`, `.env.*` — `.env.example` hariç —, `.auth/`, `data/`, `artifacts/`, `*.sqlite`, `*.pem`, `client_secret*.json`, gerçek `.eml` korpusu).
Bir commit/push öncesinde değişen dosyalarda anahtar/parola/token desenleri taranır (bkz. [DEVELOPER-GUIDE.md §8](DEVELOPER-GUIDE.md#8-commit-inceleme-ve-teslim-süreci)).

Testler gerçek sır **kullanmaz**: yalnızca biçimi geçerli sahte `MASTER_SECRET`/`SIGNUP_EMAIL` ister; `vitest.config.ts` `CAPTCHA_API_KEY`'i boşaltır, böylece hiçbir test ücretli çözücüye ulaşamaz.

## 2. Şifre türetme

Her hesabın şifresi **saklanmaz, türetilir**:

```
şifre = "Gn" + base64url(HMAC-SHA256(MASTER_SECRET, "geo.new|<hesap anahtarı>|v<sürüm>"))[0..18] + "!7"     (22 karakter)
```

- **Hesap anahtarı** = ürün + site (varsayılan üründe yalın `siteId`, diğerlerinde `ürün@site`). Aynı sitede iki ürünün şifresi farklıdır; bir sitenin sızması diğerini açmaz.
- Veritabanında (`credentials`) yalnızca **e-posta, kullanıcı adı ve şifre sürümü** vardır. Veritabanı sızsa bile şifreler `MASTER_SECRET` olmadan üretilemez.
- Site politikası (`passwordPolicy`) şifreyi biçimlendirir ama entropiyi tek bir sırra bağlı tutar; aynı anahtar/sürüm her zaman aynı şifreyi verir (elle giriş: `npm run cli -- password <site>`).
- **`MASTER_SECRET` kaybı telafi edilemez**: şifreler yeniden üretilemez. Yedeği parola yöneticisinde tutun. Değiştirmek **tüm** şifreleri değiştirir (aşağıda §11).
- `geo.new|` öneki türetmenin parçasıdır; değiştirmeyin.
- `password` komutu şifreyi yalnızca stdout'a yazar, log'a girmez; ekranınız paylaşılıyorsa çalıştırmayın.

Bir hesabın şifresi sistem dışında belirlenmişse (hesap sistemden önce vardı) ledger notuna **"şifre kullanıcıda"** yazılır; sistem o hesaba türetilmiş şifreyle otomatik giriş **denemez** (`manual`).

## 3. Log ve kanıt dosyaları

- **Loglar:** ana komut satırının `pino` logger'ı şu yolları `[gizli]` ile maskeler: `*.password`, `identity.password`, `password`, `MASTER_SECRET`. Kod parolayı hiçbir log çağrısına koymaz; e-posta ve kullanıcı adı loglanabilir (sır değil).
- **Hata kanıtı (`artifacts/<runId>/<anahtar>/`):** ekran görüntüsü + sayfa HTML'i. HTML kaydedilirken **parola alanlarının değeri boşaltılır** (React gibi çerçeveler yazılan değeri `value` özniteliğine yansıtır;
  `test/artifacts-scrub.test.ts` bunu doğrular). Temizlik kopya üzerinde yapılır, canlı sayfaya dokunmaz. Ekran görüntüsünde parola nokta olarak görünür.
  Listelemede ayrıca yakalamadan önce canlı sayfadaki parola alanları da boşaltılır.
- **Kanıt dosyaları yine de hassastır:** e-posta, kullanıcı adı, sayfa içeriği taşır; `artifacts/` git dışıdır — **paylaşmadan önce gözden geçirin**.
- **Doğrulama maili içeriği** diske yazılmaz ve log'a girmez; yalnızca aday maillerin göndereni ve konusu loglanır. Kod/link kullanıldıktan sonra yalnızca mail kimliği (`seen_messages`) tutulur. Tek istisna: doğrulama bağlantısının ilk 80 karakteri log'a düşer (tek kullanımlıktır ve açıldıktan sonra değersizdir) — logları paylaşmadan önce gözden geçirin.
- **Hata mesajları** sırrı içermemeli: yeni bir `throw`/log eklerken şifre, token ya da anahtar değerini mesaja katmayın.

## 4. E-posta erişimi

- Tek bir **ayrılmış kayıt adresi** kullanılır (kullanılmayan bireysel bir Gmail hesabı); kurumsal/iş adresleriyle karıştırılmaz ki gerçek mailler boğulmasın ve alan adı itibarı risk almasın.
- Erişim `gmail.readonly` kapsamıyladır: **yalnızca okuma**, mail gönderilmez/silinmez/etiketlenmez. Kayıttan sonraki zaman penceresindeki en çok 20 mail ham olarak çekilip **bellekte** ayrıştırılır ve site alan adı/konu kurallarıyla süzülür; yalnızca eşleşenler işlenir, hiçbir içerik diske yazılmaz. Kutu yalnızca kayıtlar için ayrıldığından bu kabul edilmiştir; **kişisel/iş postası olan bir hesabı kayıt adresi yapmayın**.
- Sheets için `spreadsheets` kapsamı aynı token'dadır; yalnızca takip tablosuna yazar.
- OAuth onay ekranı **"Testing"** modundadır ve token 7 günde ölür ([OPERATIONS.md §1](OPERATIONS.md#1-token-yenileme-haftalık)); bu bilinçli bir seçimdir (Production, hassas kapsamlar için doğrulama ister).
  Bedeli haftalık yenilemedir; faydası, kapsamın yalnızca test kullanıcısı olarak eklenen hesapla sınırlı kalmasıdır.
- Token **hangi klasörde** üretildiyse oraya yazılır; bayat bir proje kopyası geçerli sırları barındırmasın diye kullanılmayan kopyaları silin.

## 5. Captcha, bot koruması ve kullanım şartları

Projenin hedefi **meşru bir ürünü, kullanım şartlarına uyan sitelerde, kendi adına kaydetmektir.** Bot korumalarını kırmak hedef değildir.

**Captcha:**
- Çözücü (2captcha) `CAPTCHA_API_KEY` doluysa kullanılır ve **varsayılan olarak açıktır** — ama yalnızca: `risk: high` **olmayan** sitelerde, config'te `"solveCaptcha": false` yazılmamışsa, **gerçek kayıtta**.
  Dry-run'da asla çözülmez (ücretli ve gönderimi zaten korumuyor). Listelemede tercih sitenin kayıt config'inden miras alınır; kayıt config'i yoksa kapalıdır.
- İki bağımsız savunma: runner `risk: high` siteyi ağ isteğinden önce eler; ayrıca bir config elle `risk: high` + `solveCaptcha: true` yapılırsa çözücü yine reddeder.
- Desteklenen: reCAPTCHA v2/v3, hCaptcha, Turnstile. **Görsel (yazı/resim) captcha çözülmez**: site elle bakılacak listeye düşer; yalnızca listeleme formunda bir **insan** kodu kendisi yazarsa (`humanInput` adımı) akış onu bekler ve sürer. hCaptcha 2captcha ile güvenilir değildir (180 sn sonra insana düşer).
- Görünmez/pasif (skorlayan) captcha için insan çağrılmaz.
- Çözücü yoksa/başarısızsa akış durur, tarayıcı öne gelir ve **insan** çözer (zaman aşımında `manual`).

**Bot koruması:**
- Cloudflare gibi bir **duvar** görülürse keşif/kayıt durur ve site "Bot koruması" olarak işaretlenir; **aşılmaya çalışılmaz**.
- **Gizlenme/stealth eklentisi, parmak izi sahteciliği, proxy/IP döndürme yoktur.** Tek istisna: tarayıcı `--disable-blink-features=AutomationControlled` bayrağıyla açılır
  (`navigator.webdriver` işaretini gizler); gerekçe bot korumasını aşmak değil, bazı sitelerin bu bayrakla formu hiç göstermemesidir. Bu, bilinçli ve belgelenmiş tek ödündür.
  Config'teki `stealth` alanı **uygulanmamıştır** (hiçbir kod okumaz).

**Kullanım şartları (ToS):**
- ToS'u otomatik erişimi/captcha aşmayı açıkça yasaklayan siteler `risk: high` işaretlenir: sistem bunlarda **hiç ağ isteği yapmadan** `skipped_high_risk` döner ve hiçbir bayrak bunu aşmaz.
  Keşif şu alan adlarını otomatik `high` yapar: g2.com, capterra.com, trustpilot.com, producthunt.com, gartner.com, getapp.com, softwareadvice.com.
- Şartları **okunamayan ya da belirsiz** siteler için `solveCaptcha: false` yazılır (çözücü kapalı; insan hâlâ çözebilir).
- Bir sitenin ToS'u sonradan değişirse ya da bir hesap uyarı alırsa: ilgili config `risk: high`'a çekilir ve sebebi `notes`'a yazılır.
- Site "otomasyon yasak" diyorsa ya da hesap/iletişim bilgisi bir insanın doğrudan doğrulamasını (telefon/SMS, kimlik belgesi, ödeme) istiyorsa sistem **durur** (`manual`) ve araya girmez.

## 6. Kimlik ve içerik politikası

Sitelere yazılan her şey **gerçek ve doğrulanmış** olmalıdır; üçüncü sitelerde yanlış bir iddia yayınlamak geri alınması zor bir zarardır.

- **Ürünün ne yaptığı adından TAHMİN EDİLMEZ; ürünün kendi sitesiyle doğrulanır.** Gerçek vaka: geo.new'in profili "geolokasyon API'si" diye yazılmıştı, site ise kendini "AI aramasında sayfayı denetleyen ücretsiz GEO audit aracı" olarak tanıtıyor; hata 3 haftadan uzun fark edilmedi, insan onayından geçti ve gerçek bir listelemeye yayıldı. Profil metni sitenin başlığı/meta açıklaması/ana başlığından alınır; `approve-profile` bu metinleri profille yan yana gösterir ve farklıysa ek bilinçli onay ister. Yayınlanmış yanlış bir kayıt bulunursa düzeltme için önce profil yeniden onaylanır, sonra ilgili kayıt sahibin düzenleme ekranından düzeltilir.
- **Ürün bilgisi yalnızca ürün sahibinin verdiği olgulardır.** Ürün profili (`src/profile/<ürün>.json`) şemayla doğrulanır; **uydurma unvan, yasal şirket adı, kuruluş hikâyesi, yorum/puan yazılmaz.**
  İletişim kişisinin unvanı (`role`) **isteğe bağlıdır**: profilde yoksa formdaki unvan alanı **boş bırakılır**; "Founder/CEO" gibi bir değer tahmin edilmez.
- **Operatörün kimliği/şirketi yayınlanmaz.** Projeyi çalıştıran kişi ya da kuruluşun adı, hesap e-postasının alan adından **çıkarılıp** profile, sayfaya, config'e ya da örnek dosyaya yazılmaz.
  Projenin tamamında geçmemesi gereken bir ad vardır; `test/no-forbidden-name.test.ts` depodaki metin dosyalarını (kod, test, betik, config, belge) tarar ve geçtiği anda kırılır.
  Belgelerde ve örneklerde nötr ifade kullanın.
- **Herkese açık sayfalar nötr kalır:** kişisel e-posta, uydurma ad/unvan yazılmaz.
- **Yanlış ya da doğrulanmamış bilgi yayınlanmaz.** Kategori, fiyat, açıklama, logo ürün sahibinin onayladığı değerlerdir. Bu yüzden listeleme `approve-profile` ister ([§9](#9-listeleme-güvenliği)); onaydan sonra tek karakter değişirse onay düşer.
- **Config'lerdeki notlar olgu yazar.** "Görsel captcha var, çözülmüyor" gibi; tahmin ("muhtemelen spam") ya da sitenin itibarını zedeleyen yorum yazılmaz.
- **Gerçek kişi verisi:** test fikstürlerinde ve belgelerde gerçek kişi/e-posta kullanılmaz (`example.com`).

## 7. Rıza ve pazarlama onayı

- Yalnızca **şartlar/gizlilik kutusu** işaretlenir. **Pazarlama, bülten, ortak teklifleri kutuları asla işaretlenmez.**
- Siteler bu kutuları **önceden işaretli** getirebilir: gerçek bir tıklamadan hemen önce, pazarlama metni taşıyıp hukuki metin (şartlar/gizlilik) taşımayan işaretli kutular kaldırılır; kaldırılamazsa uyarı loglanır.
  Birleşik onaylar ("Şartları kabul ediyorum ve ürün güncellemelerini almak istiyorum") dokunulmadan kalır — kaldırmak kayıt şartı olan onayı bozardı; bu kutular config yazılırken ayrıca değerlendirilir.
- Sistem **telefon/SMS, kimlik belgesi, ödeme yöntemi** gerektiren formlarda durur; bunları sağlamaz.
- Ücretli/sponsorlu seçeneklere ("skip the line", premium) dokunulmaz.

## 8. Hız ve nezaket

Amaç sitelere **gereksiz yük ve sahtecilik sinyali üretmemektir**:

- Günde en çok `DAILY_LIMIT` gerçek kayıt (ve ayrı sayaçla listeleme); siteler arası **6–18 dk rastgele** bekleme; tek anda **tek site** (hesap başına kilit).
- Yeniden deneme körlemesine değildir: bilinmeyen hata **kalıcı** sayılır (fail-closed), kalıcı sonuçlar tekrar denenmez (`--force` gerekir), listelemede belirsizlik yeniden denemeyi engeller.
- Liste çalıştırıcı **ardışık hatada durur** (sistem çapında bozulmayı körlemesine sürdürmez) ve internet kesintisini siteye yüklemez.
- Terminal sonuçlar (`completed`, `failed`, `manual`) bir daha otomatik denenmez; aynı siteye ardışık deneme yapılmaz.
- Keşif, her siteyi tek tek ve üst süreyle (4 dk) tarar; takılan site tarama sürecini kilitlemez.
- `DAILY_LIMIT`'i yükseltmek bir **risk kararıdır** ve sahibi tarafından verilir ([OPERATIONS.md §2](OPERATIONS.md#2-ayarlar-ve-hız-sınırı)).

## 9. Listeleme güvenliği

Listeleme ürünü **herkese açık yayınlar**; en sıkı korumalar buradadır (ayrıntı: [LISTINGS.md](LISTINGS.md)):

- Varsayılan **dry-run**; gerçek gönderim için `--live` **ve** geçerli onay gerekir.
- **Onay insan kararıdır:** `approve-profile` etkileşimli terminal ister ve ekrandaki kodun elle yazılmasını bekler; profil ya da logo dosyası (içerik parmak izi) değişirse düşer.
- **Dry-run hiçbir şey yayınlamaz:** tıklamalar atlanır **ve** tarayıcı düzeyinde giriş formu dışındaki tüm yazan istekler engellenir.
- **Çift yayın yok:** gönderimin yapılmış olabileceği andan sonra her hata `unconfirmed` olur, otomatik yeniden denenmez; önceki gönderim, günlük sınır ve kilitler ağdan önce kontrol edilir.
- **Şifre yalnızca sitenin kendi alan adına yazılır;** yükleme yalnızca onaylı logo dosyalarını kabul eder (`..`, mutlak yol, ters eğik çizgi yok).
- Başarı işareti gönderimden **önce** de görünüyorsa gönderim yapılmaz.

## 10. Yapılmayacaklar

Sistem ve bu depoda çalışan herkes (insan ya da araç) için:

- Gerçek bir sitede, **sahibi istemeden** gerçek kayıt/listeleme çalıştırmak; testlerde gerçek siteye gitmek (testler yerel sahte sitelere karşıdır).
- `approve-profile` komutunu insan yerine çalıştırmak ya da onay dosyasını elle yazmak.
- Captcha'yı `risk: high` sitede ya da `solveCaptcha: false` yazılı sitede çözmek; görsel captcha'yı çözmeye çalışmak; bot duvarını aşmaya çalışmak.
- Pazarlama/bülten kutusu işaretlemek; telefon/kimlik/ödeme bilgisi sağlamak.
- Uydurma kimlik, unvan, şirket adı, yorum ya da puan yazmak; operatörün adını/e-postasını herkese açık bir yere yazmak.
- Şifreyi, `MASTER_SECRET`'ı, token'ı, API anahtarını log'a, commit'e, config'e, artifact'a, hata mesajına ya da sohbete yazmak.
- Yayınlanmış (push edilmiş) git geçmişini sahibinin açık izni olmadan yeniden yazmak; commit mesajlarına/belgelere yazar araç imzası eklemek.
- Doğrulanmamış (`OTOMATİK ÜRETİLDİ — doğrulanmadı`) ya da taşınma onayı bekleyen bir config ile gerçek kayıt yapmak.
- Geri alınamaz bir listelemeyi, silme/kaldırma imkânı ve yayın davranışı araştırılmadan göndermek.

## 11. Sır sızarsa ne yapılır

| Sızan | Yapılacak |
|---|---|
| `CAPTCHA_API_KEY` | 2captcha panelinden anahtarı yenileyin; `.env`'i güncelleyin; kullanımı panelden kontrol edin |
| OAuth token (`.auth/gmail-token.json`) | Google Hesabı → Güvenlik → Üçüncü taraf erişimi'nden izni kaldırın; `npm run gmail:auth` ile yenisini alın |
| OAuth istemci sırrı | Cloud Console'da istemci sırrını sıfırlayın; `.auth/gmail-client-secret.json`'ı yenileyin |
| Bir sitenin türetilmiş şifresi | O sitede şifreyi değiştirin; **otomatik şifre-sürümü yükseltme aracı yoktur** (şifre sürümü alanı hazır, ancak değiştirme akışı uygulanmamıştır): elle yapılır |
| **`MASTER_SECRET`** | **Tüm** türetilmiş şifreler tehlikededir. Telafi aracı yoktur: her sitede şifre sıfırlanmalı, sonra yeni sır ve (gerekirse) yeni şifre sürümü modeli tasarlanmalıdır. Bu yüzden `.env` izinleri ve yedek disiplini önemlidir |
| Repo'ya yanlışlıkla sır commit edildi | Önce sırrı **iptal edin/yenileyin** (geçmişi temizlemek yetmez); yayınlanmış geçmişi yeniden yazmak sahibinin açık iznini gerektirir |

Şüphe halinde: yeni gerçek koşuları durdurun (`touch data/pilot/STOP`), sırrı yenileyin, sonra devam edin.
