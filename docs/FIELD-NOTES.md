# Saha notları

Gerçek sitelerde öğrenilenler: hangi site aileleri nasıl davranıyor, kayıttan sonra ne oluyor, neyi denedik ve işe yaramadı, hangi tuzaklara düştük.
Bu belge **olgusaldır ve tarihlidir** (durum: 12 Ekim 2026); tek tek siteler için kesin kaynak her config'in `notes` alanıdır (`| <tarih> GERÇEK denemede: …`).
Yeni bir şey öğrendiğinizde önce config'in `notes`'una, genelleştirilebiliyorsa buraya yazın.

## İçindekiler

1. [Sayılarla durum](#1-sayılarla-durum)
2. [Kayıt sonrası kalıplar](#2-kayıt-sonrası-kalıplar)
3. [Site aileleri ve engel sınıfları](#3-site-aileleri-ve-engel-sınıfları)
4. [Form tuzakları](#4-form-tuzakları)
5. [Ne işe yaradı, ne yaramadı](#5-ne-işe-yaradı-ne-yaramadı)
6. [Listeleme gözlemleri](#6-listeleme-gözlemleri)

---

## 1. Sayılarla durum

| Ölçü | Değer |
|---|---|
| Site config'i | ~740 (`src/sites/`), bunların ~290'ı doğrulanmış (dry-run geçti), ~450'si "doğrulanmadı" taslak |
| Risk dağılımı | 735 `low`, 1 `medium`, 4 `high` (ToS yasaklıyor) |
| Doğrulama kipi | 732 `link`, 2 `code`, 6 `none` (taslaklarda varsayılan `link` bir **tahmindir**) |
| Gerçek hesap | **33 site** açık (ledger'da `completed`, dry-run olmayan; 13 Ekim 2026) |
| Gerçek denemeler | 156 (35 `completed`, 91 `failed`, 25 `error`, 5 `manual`) → **yaklaşık dörtte biri hesapla sonuçlanıyor** |
| Gerçek listeleme | 1 gönderim (`toolsnocode`), 3 listeleme config'i ([LISTINGS.md §9](LISTINGS.md#9-mevcut-listeleme-configleri)) |

**Başarısızlıkların dağılımı** (111 kesin olmayan/başarısız gerçek deneme): ~80 `Beklenen içerik görünmedi`, 8 doğrulama maili gelmedi, 7 ağ hatası, 5 zaman aşımı, 4 captcha'da insana düşme, geri kalanı tekil.
En büyük sınıf, **formun gönderildiği ama sonuç sayfasının tanınmadığı** durumlardır; bunların bir kısmı gerçekte açılmış hesaplar olabilir (kayıt sonrası otomatik tanıma sonradan eklendi). Bir hesabın açık olup olmadığını **yalnızca türetilmiş şifreyle girişle**
(`password <site>`) anlarsınız; açıksa `adopt-account`.

> Dry-run, formun *doldurulmasını* doğrular; **kayıt sonrasını** (doğrulama türü, başarı sayfası) göstermez. Bu yüzden "doğrulanmış config" ilk gerçek koşuda yine de hata verebilir ve verim sitelere göre çok değişir.

## 2. Kayıt sonrası kalıplar

Gönderimden sonra sayfa **otomatik tanınır** ([ARCHITECTURE.md §5](ARCHITECTURE.md#5-kayıt-sonrası-durum-tanıma)); sahada görülen kalıplar:

| Kalıp | Nasıl görünür | Sistem ne yapar | Örnekler |
|---|---|---|---|
| **Oturum açık kaldı** | Çıkış bağlantısı/kullanıcı adı görünür, doğrulama maili yok | Doğrulama beklenmez; hesap hemen kullanılabilir | `sideprojects`, `toolsnocode`, `ondashboard`, `1look4`, `ontoplist` |
| **Çıkış bağlantısı gizli menüde** | Kullanıcı adı açılır menüde, "Logout" gizli | Sayfa bu hesabın kullanıcı adını/e-postasını gösteriyorsa "açık" sayılır | `1look4` |
| **Doğrulama bağlantısı** | "Check your inbox / verification email sent" | Mail beklenir, bağlantı açılır | çoğu site (`awwwards`, `owncloud`, `qr`, …) |
| **Doğrulama kodu (tek alan)** | "Enter the code we sent" + tek alan | Koda geçer, alanı sayfadan bulur | `robingood` (6 haneli) |
| **Doğrulama kodu (rakam başına kutu)** | 4–8 tek haneli kutu | Her rakamı kendi kutusuna yazar | `bufferapps` (`/auth/verify-otp`, 6 kutu) |
| **Mail gelmiyor** | Site "mail gönderdik" der ya da hiçbir şey demez, kutuya hiçbir şey düşmez | Süre dolar (`error`); hesap doğrulanmamış kalır | `earnthatbuck`, `wow-link` (kod ekranı çıktı ama mail düşmedi), `alternative` (`unverifiedAccount`) |
| **"Hesap zaten mevcut"** | Tekrar kayıt: "e-posta kayıtlı" | Hata değil: tek e-postayla hesap bizimdir → `completed` | birçok site (yeniden denemelerde) |
| **Moderatör onayı** | "A moderator must manually approve your new account" | E-posta doğrulansa da hesap kullanılamaz; elle takip | `endnote` (Discourse) |
| **Sonuç belirsiz** | Kayıt sayfası aynen kalır, hata metni yok | `Beklenen içerik görünmedi` → `failed` | `powershow`, `simandhareducation`, `dreevoo`, `jjmehta`, `collegeconfidential` |

**Doğrulama mail gönderen alan adı:** çoğu site kendi alan adından gönderir; forum yazılımları ve bazı platformlar üçüncü taraftan gönderir (Discourse → `discoursemail.com`). Sistem `from` verilmediğinde gövdenin site alan adını anmasını da kabul eder.
**Bazı siteler mail göndermez ama hesabı hemen açar** (`mode: none`); yanlışlıkla `link` kalan config her koşuyu "mail gelmedi" ile 10 dk beklettirir — bunu ilk gerçek koşuda düzeltin.

## 3. Site aileleri ve engel sınıfları

Aynı motoru kullanan siteler **aynı sebeple** takılır; bir tanesini çözmek (ya da elemek) aileyi çözer. Eleme kararları config `notes`'unda tutulur.

| Sınıf / aile | Belirti | Karar |
|---|---|---|
| **Bookmarking (hikâye gönderme) motoru** (`1look4`, `ondashboard`, `coolpot`, `justpep`, `mootin`, `sharedais`, `urlsuggest`; `worldranklist` ayrı motor) | reCAPTCHA v2 (çözülür); kayıttan sonra **oturum açık kalır**, doğrulama maili yok | **Kayıt çalışır.** Gönderim 2 adımlı: 1. adımda yalnızca adres, 2. adımda başlık/kategori/açıklama + **görsel doğrulama kodu** (7 sitenin hepsinde gerçek 1. adımla doğrulandı, 13 Ekim) → kodu bir insan yazmadan tamamlanamaz. Site başlık ve açıklamayı ürünün kendi sayfasından okur |
| **Ücretsiz web sitesi/blog platformu motoru** (`aboutyoublog`, `activablog`, `arwebo`, aynı motoru kullanan diğerleri) | Formda **görsel (yazı) captcha** (`SecureImg`) + reCAPTCHA; "Username should be alphanumeric" | **Elenir.** Sistem görsel captcha çözmez |
| **Görsel captcha'lı tekil siteler** (`minds`, `trendystartups`) | "Enter the characters above" / "Type Image Values" | Elenir |
| **hCaptcha forumları** (gerçek denemede doğrulananlar: `insanelymac`, `knittinghelp`, `logopond`, `psxextreme-info`; notlarında hCaptcha geçen ~40 config) | 2captcha 180 sn içinde çözemiyor, ardından insan beklenir | `solveCaptcha: false`; gözetimsiz koşuda atlanır, **elle** (görünür tarayıcıda) çözülürse çalışır |
| **Cloudflare/Turnstile duvarı** (`digg`) | Form, "Verify you are human" geçilmeden görünmüyor | **Aşılmaz**; "Bot koruması" |
| **SSO-only** (`codechef` Google, `dpreview` Google, `sketchfab` Epic Games) | Kayıt sosyal girişe yönleniyor, e-posta formu yok | Elenir |
| **İş e-postası şartı** (`getlatka`) | "Please use your work email address" | Gmail ile kayıt **yapılamaz**; kendi alan adlı adres gerekir (karar insanın) |
| **Çok adımlı sihirbaz** (`dandad`: hesap → konum/meslek → ilgi alanları) | Config yalnızca 1. adımı biliyor | 2. ve 3. adım alanları eklenirse çalışabilir |
| **Bal tuzağı alanı** (`homepage-ninja`: "leave this field empty. It is for robots") | Gizli alan botları ele verir | Alanı **doldurmayın**; sonuç belirsiz |
| **Kayıt adresi yanlış** (`askopinion` 404; `indiehackers`, `proguitar` giriş sayfası) | `signupUrl` kayıt formu değil | Gerçek kayıt adresi bulunmalı |
| **Moderatör onaylı Discourse** (`endnote`) | Mail çalışır ve e-posta doğrulanır ama "A moderator must manually approve your new account" | Hesap site tarafında oluşur ama moderatör onaylayana kadar kullanılamaz; elle takip |
| **Telefon/kimlik/ödeme isteyenler** | "Phone verification", "credit card required", "invite only" | Sistem durur (`manual`) |

Bir siteyi **bırakmak meşru bir sonuçtur**: nedeni `notes`'a yazın ki tekrar denenmesin ve Sheet'te "Takıldı: elle bakılacak" olarak görünsün.

## 4. Form tuzakları

Her biri gerçek bir vakadan; düzeltmesi kodda ya da config rehberinde (bkz. [SITE-CONFIGS.md §10](SITE-CONFIGS.md#10-config-yazma-rehberi)):

- **Görünmez şartlar kutusu:** özel stilli onay kutusu `display:none`'dır; `label[for=…]` tıklanır. Etiketin **ortasına** tıklamak içindeki "Terms" bağlantısına düşer ve kutu boş kalır (`bufferapps`, gerçek koşuda); bu yüzden etiket kutuları DOM'dan işaretlenir. Dry-run bu yolu zaten DOM'dan işaretlediği için hatayı **görmemişti**.
- **Önceden işaretli pazarlama kutusu** (`minds`: "Receive exclusive token rewards and info"): gerçek tıklamadan önce kaldırılır.
- **Captcha adımı sırası:** `captchaGate` alanlardan **önce** konunca form "şifre alanları sıfırlanıyor" gibi görünür (`betalist`: aslında Turnstile henüz yüklenmemiş, form token'sız gitmiş, sunucu formu yeniden çizmiş ve Rails parolaları geri koymamış). Captcha **gönder tıklamasından hemen önce** durmalı; geç yüklenen widget için kısa bekleme vardır.
- **Typeahead/otomatik tamamlama:** metin yazılır ama listeden seçilmezse gizli kimlik alanı boş kalır (`360quadrants`).
- **Dinamik alan kimlikleri** (UUID, uzun hex/sayı kuyruğu, React `useId`): her yüklemede değişir; dry-run'da "Selector bulunamadı"ların ~110'u böyleydi → `name`/`placeholder` kullanın.
- **Genel `expect` desenleri:** `welcome`/`confirm`/`dashboard` gibi tek kelimelik desen yanlış pozitif verir (`awwwards`: kayıt başarısızken başlıkta "Welcome" vardı → sistem 10 dk boşuna mail bekledi).
- **Kullanıcı adı kuralları:** bazı siteler alt çizgiyi "özel karakter" sayar (`getworm`) → `usernameStyle: plain`.
- **Alan sınırları:** `maxlength` dar olabilir (açıklama kırpılır); `description` alanı uygun varyantı seçer, diğer alanlarda kırpılma uyarı verir.
- **`networkidle` tuzağı:** zaten ulaşılmış durum için anında döner; gecikmeli giriş isteği sonraki gezinmeyle yarıda kesilir (`10words` girişi). Oturumun kurulduğunu **işaretle** (adres/işaret) bekleyin.
- **Karşılama pencereleri** tıklamaları kapar (`10words` giriş sonrası): `waitFor` + `dismiss`.
- **Yanlış dry-run başarısızlıkları:** etiket (onay kutusu) tıklamaları atlandığında sayfa kutuyu "zorunlu, boş" gösterir ve doğru config başarısız sayılırdı → onay kutusu etiketleri dry-run'da da DOM'dan işaretlenir.

## 5. Ne işe yaradı, ne yaramadı

**İşe yarayanlar**
- **Kayıt sonrası sayfayı tanımak** (oturum açık / kod / "mailini kontrol et"): config tahminleri sık yanlıştır; gözlem tahmini düzeltir ve gereksiz 10 dakikalık mail beklemelerini ve yanlış `failed`'leri azalttı.
- **Etiket kutularını DOM'dan işaretlemek**, **önceden işaretli pazarlama kutularını kaldırmak**.
- **Rakam başına kutulu kod girişi** (`verification-entry`).
- **Mail eşleşmesini gövdeye bağlamak** (üçüncü taraf göndericiler).
- **Ardışık hatada durmak** (varsayılan 6): ilk gerçek koşularda config bozukluğu beklenir; sistem çapında bir bozulma (ağ, token) arka arkaya başarısızlık olarak görünür ve körlemesine sürdürülmez.
- **Ağ kesintisini siteyle ilişkilendirmemek:** Mac'in Wi‑Fi'ı arada düşer; bu "başarısız site" değildir. Liste çalıştırıcı bekler ve siteyi sonda yeniden dener.
- **Hesabı "benimsemek" (`adopt-account`):** sınıflandırması yanlış ama gerçekte açık hesaplar kanıt notuyla düzeltildi.
- **Ayrı koşu logları** (`data/pilot/<site>.log`) ve `results.jsonl`: sonradan analiz ve aile tespiti için.

**İşe yaramayanlar / yanlış çıkan teşhisler**
- **hCaptcha'yı 2captcha ile çözmek:** güvenilir değil; 180 sn bekleyip yine insana düşüyor.
- **Görsel captcha'yı çözmek:** desteklenmiyor; bu aileler elenir.
- **Taslak config'e güvenmek:** otomatik üretilen taslağın `mode: link` varsayımı sık yanlış (10words, alternative, ontoplist, toolsnocode hiç mail göndermiyor).
- **"Dry-run geçti = hazır"** varsayımı: kayıt sonrası davranış ve başarı sayfası yalnızca gerçek koşuda ortaya çıkar.
- **Tek kelimelik `expect` desenleri** (yukarıda).
- **`captchaGate`'i alanlardan öne almak** (yukarıda, `betalist`'te yanlış teşhis).
- **Ürünü adından tahmin etmek:** geo.new'in profili "geolokasyon API'si" diye yazılmıştı (ad "geo"dan çıkarılmış); site ise kendini "AI aramasında sayfayı denetleyen ücretsiz GEO audit aracı" olarak tanıtıyor. Hata 3 haftadan uzun fark edilmedi, insan onayından geçti ve 1 gerçek listelemeye, 1 toplist kaydına ve 1 forum profiline yayıldı; ancak bir yer imi sitesi geo.new'in gerçek başlığını kendisi okuyup getirince ortaya çıktı. Ders: ürün bilgisi ürünün kendi sitesinden alınır ve onay ekranında yan yana gösterilir (`core/site-facts.ts`).
- **Hesabı sistemden önce açılmış siteler:** türetilen şifre geçmez (`betalist`); bu hesaplar "şifre kullanıcıda" olarak işaretlenir ve otomatik girişe/listelemeye dahil edilmez.
- **Başarı işaretini formun kendi metninden seçmek** (listeleme): "review queue" yazısı form sayfasında zaten vardı.

## 6. Listeleme gözlemleri

| Site | Gözlem |
|---|---|
| `toolsnocode` | Giriş: e-posta + şifre, doğrulama yok. "Publish Tool" gönderimi **hemen oluşturur**; ürün sahibe görünür ve düzenlenebilir, ancak **anonim ziyaretçiye 404** (herkese açık olması site onayına bağlı görünüyor); **silme/yayından kaldırma yok** |
| `10words` | Açıklama "10 kelime veya daha az" ister → slogan kullanılır. Giriş sonrası karşılama penceresi var (`dismiss`). Gönderim sonrası ödeme/sponsor yönlendirmesi ve bülten/sosyal medya tanıtımı olabilir; silme belirsiz → **bilinçli bekletiliyor** |
| `sideprojects` | Tek adımlı form; kategori en çok 3, yalnızca "Developer tools" uygun; ücretsiz gönderim **inceleme kuyruğuna** girer (hemen yayınlanmaz); ücretli "skip the line" seçeneğine dokunulmaz |
| Bookmarking (hikâye gönderme) ailesi | Gönderim **2 adımlı**: 1. adım yalnızca adres (yayınlamaz, site başlık/açıklamayı geo.new'in kendi sayfasından okur); 2. adım başlık, kategori (SEO/Web/Software var), açıklama ve **görsel doğrulama kodu** ister |

Genel ilkeler: gönderimden **önce** silme/düzenleme imkânını ve yayın davranışını araştırın; başarı işaretini gönderimden **sonra** oluşan bir şeyden seçin; tek site, tek koşu ile başlayın; `completed`'ı "herkese açık" saymayın.

## Bilinen açık konular (saha kaynaklı)

- **Hesap açık mı?** sınıfı: "sonuç belirsiz" ve `Beklenen içerik görünmedi` ile bitmiş siteler için toplu bir **giriş yoklaması** (türetilmiş şifreyle giriş denemesi) hesapları ortaya çıkarabilir; yapılmadı.
- **Bookmarking ailesi:** 7 sitede de alanları sistem doldurur ama görsel doğrulama kodunu bir **insan** yazmalıdır: listeleme config'lerinde `humanInput` adımı kodu bekler (tarayıcı görünür olmalı). İlk gerçek deneme (1look4, 14 Ekim) 2. adımı **atladı**: tıklama 46 ms'de döndü, site formu ~0,3 sn sonra gönderdi, 2. sayfa ~3 sn sonra açıldı; `when` koşulu erken okundu (`when.waitMs` ile düzeltildi, testli). Gönderim sonrası sayfanın başarı işareti henüz görülmedi; ilk **tamamlanan** gerçek gönderimden sonra config'e yazılacak.
- **Görsel captcha ailesi** için çözüm yok; kapsam dışı.
- **Logo dosyaları** yok; logo isteyen listeleme formları atlanıyor.
