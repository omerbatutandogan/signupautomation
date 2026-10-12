# Listeleme (ürünü sitenin "ürün ekle" formuna girme)

Hesap açmak (kayıt) ile ürünü yayınlamak (listeleme) **farklı işlerdir** ve farklı riskler taşır:

| | Kayıt (`run-one`) | Listeleme (`submit`) |
|---|---|---|
| Sonuç | Bir hesap açılır | Ürün üçüncü sitede **herkese açık yayınlanır** |
| Geri alma | Hesap bırakılabilir | **Çoğu zaman mümkün değil** (silme düğmesi yok, moderatör gerekir, bülten/sosyal medya duyurusu çıkabilir) |
| Config | `src/sites/<id>.json` | `src/submissions/<id>.json` (ayrı dosya, ayrı yaşam döngüsü) |
| Varsayılan | Gerçek | **Dry-run** |
| İnsan onayı | Gerekmez | **Şart** (`approve-profile`) |
| Yanlış giderse | Hesap boşa açılır | Yanlış/doğrulanmamış bilgi herkese açık görünür |

Bu yüzden bu akışta iki ilke her şeyin önündedir: **çift yayın yok** ve **dry-run hiçbir şey yayınlamaz**.

## İçindekiler

1. [Ön koşullar](#1-ön-koşullar)
2. [Onay modeli](#2-onay-modeli)
3. [Akış](#3-akış)
4. [Dry-run güvenceleri](#4-dry-run-güvenceleri)
5. [Gerçek gönderim güvenceleri](#5-gerçek-gönderim-güvenceleri)
6. [Gönderimden sonra](#6-gönderimden-sonra)
7. [Durumlar](#7-durumlar)
8. [Listeleme config'i yazma](#8-listeleme-configi-yazma)
9. [Mevcut listeleme config'leri](#9-mevcut-listeleme-configleri)

---

## 1. Ön koşullar

Gerçek gönderim için hepsi gerekir; biri eksikse sistem **ağa çıkmadan** durur ve nedenini söyler:

1. **Listeleme config'i:** `src/submissions/<siteId>.json` ([§8](#8-listeleme-configi-yazma)).
2. **Kayıt config'i:** `src/sites/<siteId>.json`. Risk (`high` ise hiç çalışmaz), captcha tercihi, şifre politikası ve **şifrenin yazılabileceği alan adı** buradan okunur.
   Kayıt config'i yoksa gerçek gönderim `failed` döner; giriş adımı olan config'te dry-run da buna ihtiyaç duyar.
3. **Açık hesap:** o ürün + site için ledger'da `completed` kayıt ve kimlik bilgisi (`run-one` ile açılmış ya da `adopt-account` ile benimsenmiş).
   Hesabın notunda "şifre kullanıcıda" yazıyorsa (hesap sistemden önce vardı, türetilen şifre geçmez) otomatik giriş yapılamaz → `manual`.
4. **Ürün profili:** `src/profile/<ürün>.json` (zod ile doğrulanır). Yayınlanacak her şey buradan gelir: ad, site, slogan, kısa/orta/uzun açıklama, kategori, iletişim, fiyat, kuruluş yılı, sosyal bağlantılar, logo yolları.
5. **Logo dosyaları** (profilde `logo` yolu varsa): `src/profile/<yol>` altında bulunmalı. Dosya yoksa onay kaydına "yok" olarak girer; sonradan eklemek profilin içeriğini değiştirmiş sayılır ve **yeniden onay** ister.
6. **Onay:** profil + logo dosyaları için geçerli bir `approve-profile` kaydı ([§2](#2-onay-modeli)).

## 2. Onay modeli

Listeleme, ürünün üçüncü sitelerde yayınlanmasının tek kapısıdır; bu kapı **bir insan kararıdır**.

```bash
npm run cli -- approve-profile geo-new
```

Komut yayınlanabilecek **tüm** bilgiyi ekrana basar (ad, site, slogan, üç açıklama, kategori ve takma adlar, iletişim kişisi/e-postası, fiyat, kuruluş yılı, sosyal bağlantılar, her logo dosyasının SHA-256'sı ya da "DOSYA YOK" uyarısı)
ve ekrandaki **8 haneli kodu** yazmanızı ister. Kod, o içeriğin parmak izinden türetilir; içerik değişmişse kod da değişir.

| Kural | Neden |
|---|---|
| **Etkileşimli terminal (TTY) şart** | Bir betik ya da otomasyon `approve-profile && submit --live` zinciriyle kararı insan yerine veremez |
| Onay **içeriğe bağlıdır** | Profildeki tek bir karakter ya da logo dosyasının tek bir baytı değişirse onay geçersiz olur (`changed`); sistem `skipped_not_approved` döner |
| Onay **makineye özeldir** | `data/approvals/<ürün>.json` (git'e girmez): bir insanın o makinede verdiği karar repo'ya işlenmez |
| Kaydın biçimi | `{ "sha256": "…", "approvedAt": "<ISO tarih>" }`; bozuk dosya `unreadable` sayılır (gönderim yapılmaz) |

> Yardımcı araçlar/ajanlar `approve-profile` çalıştırmaz ve onay dosyasını elle yazmaz; kararı insan verir.

Ne zaman yeniden onay gerekir: profil içeriği değişti; logo eklendi/değişti/silindi; başka bir makineden çalıştırılıyor (onay dosyası orada yok).

## 3. Akış

`submit <siteId> [--live] [--force]` ([src/core/submitter.ts](../src/core/submitter.ts)):

```
1  Kapılar (ağdan ÖNCE)        config yükle · risk · kayıt config'i · alan adı denetimi · profil · yükleme denetimi
                               · hesap var mı · (gerçek:) onay · günlük sınır · daha önce gönderilmiş mi
2  Kilitler                    kayıt kilidi (aynı hesapta run-one sürüyorsa dur) + <anahtar>#submit kilidi
3  Kilit sonrası yeniden bak   "daha önce gönderilmiş mi" tekrar sorulur (kontrol ile kilit arasında başka süreç göndermiş olabilir)
4  Tarayıcı                    hesabın kalıcı profili (dry-run: geçici profil)
5  Giriş                       listingUrl'e git; loggedIn işareti yoksa login adımlarını oynat; oturumun kurulmasını bekle
6  Form                        steps'i oynat (gerçek tıklamadan hemen önce kanca çalışır)
7a Dry-run: denetle             ekran görüntüsü + otomatik denetim + engellenen istek raporu
7b Gerçek: başarıyı doğrula     success işaretini en çok 15 sn bekle → completed / unconfirmed
8  Temizlik                    sonuç ledger'a yazılır, kilit bırakılır, tarayıcı kapanır (her adım ayrı korunur)
```

Giriş **bir yayın değildir** (kendi hesabımıza oturum açıyoruz): login adımları (tıklamalar dahil) dry-run'da bile çalışır, yoksa form hiç görünmezdi; yalnızca `captchaGate` adımları dry-run'da ayıklanır.
Türetilen şifre **yalnızca** sitenin kendi alan adına yazılır: `listingUrl`, `login.url` ve `goto` adımlarının sabit adresleri kayıt sitesinin kayıtlanabilir alan adında olmalıdır
(`*.vercel.app`, `github.io`, `blogspot.com` gibi paylaşımlı barındırma alan adlarında tam makine adı eşleşmesi aranır). Aksi halde hiçbir şey açılmadan `failed`.

## 4. Dry-run güvenceleri

Dry-run formu **doldurur, göndermez**. Bunu iki bağımsız katman sağlar:

1. **Tıklamalar atlanır** (yalnızca onay kutusu etiketleri DOM'dan işaretlenir).
2. **Tarayıcı düzeyinde ağ koruması:** giriş formunun *kendi* isteği (login sayfasından çıkan, `login` aşamasındaki yazan istek) dışında **hiçbir yazan istek (POST/PUT/PATCH/DELETE…) dışarı çıkamaz** (`blockedbyclient`).
   Böylece tıklamasız tetiklenen gönderimler de (`onchange="form.submit()"`, otomatik gönderen betikler) durur. Ayrıca service worker bu sayfada devre dışı bırakılır (CDP `Network.setBypassServiceWorker`; ikinci katman).
   Engellenen her istek log'a `DRY-RUN: yazan istek ENGELLENDİ` düşer.

Dry-run'ın ayrıca denetlediği şeyler (sorun varsa sonuç `manual` ve notta nedeni yazar):
- Form, **tıklanmadan kendiliğinden göndermeye çalıştı** mı? (engellenir ve raporlanır)
- Doldurulan alanlar gerçekten doldu mu; formdaki zorunlu alanlar boş mu; **gönder (`click`) adımı** var mı?
- **Başarı işareti gönderimden önce de görünüyor mu?** Görünüyorsa config güvenilmezdir: gerçek gönderimde "sahte başarı" verir.

> **"dry-run completed" ne demektir, ne demek değildir?** Formun doğru alanlara doğru değerle dolduğunu ve hiçbir şeyin gönderilmediğini gösterir.
> Gerçek gönderimin başarılı olacağını, `success` işaretinin doğru olduğunu, sitenin gönderimi hemen yayınlayıp yayınlamayacağını **göstermez**.
> Dry-run kaydı (`dry_run = 1`) hiçbir zaman "gönderildi" sayılmaz ve günlük sayaca girmez.

## 5. Gerçek gönderim güvenceleri

**Çift yayın yok.** Aşağıdaki katmanlar birlikte çalışır:

| Katman | Davranış |
|---|---|
| Önceki gönderim | Bu hesapla `failed` **dışında** herhangi bir gerçek gönderim kaydı varsa (`completed`, `unconfirmed`, hâlâ `running` — süreç ölmüş olabilir, `error` ya da bilinmeyen durum) yeniden gönderilmez: `skipped_done` ya da `skipped_unverified`. Aşmak için `--force` |
| Günlük sınır | Bugün başlatılan gerçek gönderim sayısı `DAILY_LIMIT`'e ulaştıysa `skipped_daily_limit`; `--force` bunu **aşmaz** |
| Kilitler | Aynı hesapta kayıt ya da başka bir listeleme sürüyorsa `skipped_locked`; kilit alındıktan sonra "daha önce gönderilmiş mi" yeniden sorulur |
| Gönderim-olabilir izi | İlk **gerçek form tıklaması** ya da form aşamasında **ürünü taşıyan bir yazan istek** (sayfa gezintili POST ya da gövdesinde ürün adı/adresi geçen XHR) görüldüğü anda gönderim "yapılmış olabilir" sayılır |
| Belirsizlikte yeniden deneme yok | "Yapılmış olabilir" noktasından **sonra** oluşan her hata (zaman aşımı, sayfa çökmesi, başarı işareti görünmemesi) `unconfirmed` olur; otomatik tekrar denenmez. Öncesindeki hatalar (öğe bulunamadı, giriş olmadı) `failed` kalır ve güvenle yeniden denenebilir |
| Erken başarı işareti | İlk gerçek tıklamadan **önce** `success` işareti zaten görünüyorsa tıklanmaz (`config güvenilmez, gönderilmedi`) |
| Yükleme denetimi | `upload` adımları yalnızca profildeki **onaylı logo dosyalarını** yükleyebilir; başka dosya yolu gönderimden önce `failed` |
| Alan adı denetimi | Şifre yalnızca sitenin kendi alan adına yazılır ([§3](#3-akış)) |
| Marketing/bülten | Hiçbir koşulda işaretlenmez; önceden işaretli gelenler gerçek tıklamadan önce kaldırılır; ücretli seçeneklere (örn. "skip the line") config dokunmaz |

Gönderim yapılmadığı halde adımlar bittiyse (config'te çalışan bir `click` yoksa) sonuç `failed`: "gönderim yapılmadı".
Başarı işareti `success.anyOf` (görünür seçici) ya da `success.urlContains` (adres parçası) ile aranır; 15 sn içinde çıkmazsa `unconfirmed`, `listingUrl` olarak son adres kaydedilir.

## 6. Gönderimden sonra

`completed` = **sitenin başarı işareti göründü**. Bu, ürünün **herkese açık görünür** olduğu anlamına gelmez: siteler gönderimi moderasyon kuyruğuna alabilir, sahiplik doğrulaması isteyebilir ya da yalnızca sahibe gösterebilir.
Bu yüzden her gerçek gönderimden sonra:

1. **Giriş yapmadan** (gizli pencerede ya da `curl` ile) `listingUrl`'i açıp sayfanın gerçekten herkese açık olduğunu doğrulayın.
2. Sonucu ilgili listeleme config'inin `notes`'una yazın (gönderim tarihi, adres, görünürlük, düzenle/sil seçenekleri).
3. Siteye ürünü sonradan **düzenleme/silme** imkânı var mı bakın (kaldırma çoğu sitede yoktur; bunu ilk gönderimden **önce** araştırın).

`unconfirmed` sonucu bir **elle kontrol** emridir: hesaba giriş yapıp ürünün oluşup oluşmadığına bakın. Oluşmuşsa `--force` ile **tekrar göndermeyin**; ürün yoksa nedenini bulup `--force` ile yeniden deneyin.

## 7. Durumlar

`submit` çıktısı ve `submissions` tablosundaki `status`:

| Durum | Anlamı | Yeniden denenir mi? |
|---|---|---|
| `completed` | Gerçek gönderim: başarı işareti göründü. Dry-run: form dolduruldu, **gönderilmedi** (notta yazar) | Gerçek ise hayır |
| `unconfirmed` | Gönderim yapılmış **olabilir** ama başarı doğrulanamadı | **Hayır** (elle bak; `--force` yalnızca bilinçli) |
| `failed` | Gönderimden **önce** hata (config, giriş, öğe yok) ya da hiçbir şey gönderilmedi | Evet |
| `manual` | İnsan gerekiyor: dry-run denetimi başarısız, şifre kullanıcıda, kendiliğinden gönderim engellendi | Sorun giderilince |
| `error` | Beklenmeyen hata (kalıcı kayıt yok) | Bu kayıt "belirsiz" sayılır, `--force` gerekir |
| `skipped_no_account` | O ürün + site için açık hesap yok | Önce kayıt |
| `skipped_not_approved` | Profil/logo onaylı değil ya da onaydan sonra değişti | `approve-profile` |
| `skipped_done` | Zaten listelendi (`completed` kaydı var) | `--force` |
| `skipped_unverified` | Önceki gönderimin sonucu doğrulanamadı, yayınlanmış olabilir | Elle bak; `--force` |
| `skipped_locked` | Aynı hesapta başka bir kayıt/listeleme sürüyor | Biri bitince |
| `skipped_high_risk` | Site ToS'u otomatik erişimi yasaklıyor | Hayır |
| `skipped_daily_limit` | Bugünkü gerçek gönderim sınırı doldu | Yarın |

Çıkış kodu: yalnızca `completed` ve `skipped_done` → 0; geri kalan her şey 1 (betik zincirleri onaysız/doğrulanamayan durumu başarı saymasın).

## 8. Listeleme config'i yazma

Dosya: `src/submissions/<siteId>.json` ([src/adapters/submission-schema.ts](../src/adapters/submission-schema.ts)). Adımlar kayıt config'iyle **aynı sözlüğü** kullanır
([SITE-CONFIGS.md §3](SITE-CONFIGS.md#3-adımlar)); `{{signupUrl}}`, bir `goto` adımında o bağlamın adresine (giriş için `login.url`, form için `listingUrl`) çözülür.

| Alan | Zorunlu | Anlamı |
|---|---|---|
| `id`, `name` | ✔ | Kayıt config'iyle aynı `id` (hesap anahtarı onunla bulunur) |
| `listingUrl` | ✔ | Listeleme formunun adresi (giriş yapılmış hesapla açılır) |
| `loggedIn` | `login` varsa ✔ | Giriş yapılmışken görünen seçici (çıkış bağlantısı, kullanıcı menüsü, **giriş sonrası formun kendi alanı**). Görünürse giriş atlanır |
| `login` | – | `{ url, steps }`: giriş sayfası ve adımları. İlk adım genelde `{ "type": "goto", "url": "{{signupUrl}}" }`. `login.url`, `listingUrl` ile **aynı sayfa olamaz** |
| `steps` | ✔ | Formu dolduran ve gönderen adımlar. **Gönder `click`'i son adım olmalı** |
| `success` | ✔ | `anyOf` (görünür seçiciler) ve/veya `urlContains` (adres parçaları). En az biri şart |
| `notes` | – | Neyin doğrulandığı, neyin **doğrulanmadığı**, görünürlük/silme bilgisi |

**Şema kuralları (yükleme hatası olur):**
- `login` varsa `loggedIn` zorunlu (yanlış şifre/engelli hesap giriş yapılmamış formu doldurmasın).
- `login.url` ile `listingUrl` aynı sayfa olamaz (dry-run girişi ile gönderim ayrılamaz).
- `success.urlContains` içindeki parça `listingUrl`'de zaten varsa reddedilir (gönderim yapılmadan da tutar).
- `upload` yolları göreli olmalı (`/`, `\`, `..` yok).

**Yazarken:**
1. Formu **gerçek, giriş yapılmış oturumda** inceleyin (`npm run inspect`, ya da giriş sonrası sayfayı elle gezin). Alan adı yoksa yer tutucu/etiket metniyle seçin (`input[placeholder='…']`).
2. Alanları profilden doldurun (`field`); **sitede olmayan/zorunlu olmayan alanlara değer uydurmayın**. Kategori `select` için `field: category` ya da bilinçli bir sabit `value` (ürün sahibinin onayıyla) kullanın.
3. **Başarı işaretini formda zaten görünmeyecek şekilde seçin.** "Başarılı", "gönderildi", ya da gönderimden sonra oluşan sayfanın adresi/başlığı iyi işarettir; formun kendi metnindeki ("review queue") ifade kötüdür.
4. **Ücretli/sponsorlu seçeneklere, bülten/pazarlama onayına ve yayın zamanlaması gibi tercihlere dokunmayın.** Atladığınız alanları `notes`'a yazın.
5. Önce **dry-run**: `npm run cli -- submit <id>`; sonucun `completed (dry-run — gönderilmedi)` ve uyarısız olduğunu, ekran görüntüsünde alanların doğru dolduğunu kontrol edin.
6. Gerçek gönderime geçmeden önce: ürün bilgisi doğru mu (**yanlış/doğrulanmamış bilgi yayınlanmaz**), site gönderimi geri almaya izin veriyor mu, `approve-profile` verildi mi.
7. İlk gerçek gönderim **tek bir site, tek koşu** olsun; sonucu ve herkese açık görünürlüğü doğrulayıp `notes`'a işleyin ([§6](#6-gönderimden-sonra)).

## 9. Mevcut listeleme config'leri

| Site | Durum (2026-10-12) | Notlar |
|---|---|---|
| `toolsnocode` | **Gerçek gönderim yapıldı** (`/tools/geo-new`), site kabul etti | Sahip hesabında görünüyor ve düzenlenebilir ("Edit"); **silme/yayından kaldırma yok**. Giriş yapmadan sayfa 404 → herkese açık olması site onayına/sahiplik doğrulamasına bağlı görünüyor; **henüz herkese açık doğrulanmadı** |
| `sideprojects` | Dry-run geçti, **gönderilmedi** | Yalnızca "Developer tools" kategorisi; ücretsiz gönderim inceleme kuyruğuna girer; ücretli "skip the line"a dokunulmaz. Başarı işareti (`urlContains: /projects/geo`) **doğrulanmadı** |
| `10words` | Dry-run geçti, **gönderilmedi — bilinçli olarak bekletiliyor** | Gönderim sonrası ödeme/sponsor yönlendirmesi çıkabilir; site bülten/sosyal medya tanıtımı yapıyor olabilir ve silme imkânı belirsiz. Karar netleşmeden gerçek gönderim yapılmaz. Başarı işareti **doğrulanmadı** |

Bu tablo tarihlidir; güncel durum için `npm run cli -- status` ve ilgili config'in `notes` alanına bakın.
