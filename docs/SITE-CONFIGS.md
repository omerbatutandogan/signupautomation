# Site config rehberi (kayıt)

Bir sitede **hesap açmak** için bilmemiz gereken her şey tek bir JSON dosyasıdır: `src/sites/<id>.json`. Yeni site eklemek kod yazmak değil, veri yazmaktır;
ortak yürütücü ([src/adapters/generic.ts](../src/adapters/generic.ts)) dosyadaki adımları sırayla oynatır.
Ürünü sitenin "ürün ekle" formuna girmek ayrı bir iştir ve ayrı bir config ister: [LISTINGS.md](LISTINGS.md).

## İçindekiler

1. [Dosya, kimlik ve doğrulama](#1-dosya-kimlik-ve-doğrulama)
2. [Üst düzey alanlar](#2-üst-düzey-alanlar)
3. [Adımlar](#3-adımlar)
4. [Alan adları (`field`)](#4-alan-adları-field)
5. [Doğrulama (`verification`)](#5-doğrulama-verification)
6. [Başarı kanıtı (`success`)](#6-başarı-kanıtı-success)
7. [Kullanıcı adı ve şifre](#7-kullanıcı-adı-ve-şifre)
8. [Risk ve captcha](#8-risk-ve-captcha)
9. [Notlar ve damgalar](#9-notlar-ve-damgalar)
10. [Config yazma rehberi](#10-config-yazma-rehberi)
11. [Örnek: açıklamalı bir config](#11-örnek-açıklamalı-bir-config)
12. [Sık hatalar](#12-sık-hatalar)

---

## 1. Dosya, kimlik ve doğrulama

- Konum: `src/sites/<id>.json`. `id` yalnızca **küçük harf, rakam ve tire** içerir (`^[a-z0-9-]+$`) ve dosya adıyla aynıdır. `_` ile başlayan dosyalar listelenmez.
- Config **yüklenirken** zod ile doğrulanır ([src/adapters/schema.ts](../src/adapters/schema.ts)); hatalı dosya tarayıcı açılmadan, hangi alanın neden geçersiz olduğunu söyleyerek patlar.
  Toplu doğrulama: `npm run cli -- list` (geçersiz config'in satırında hata görünür).
- `id` Sheet'ten türetilir: `siteIdFromWebsite` ([src/integrations/sheet.ts](../src/integrations/sheet.ts)) alan adının anlamlı etiketini alır
  (`portal.10words.io` → `10words`); jenerik olmayan ülke uzantılarında uzantıyı ekler (`example.de` → `example-de`).
  İkili ülke uzantılarında (`.co.uk`, `.com.au`, `.org.nz`…) uzantı değil site adı seçilir: `freeindex.co.uk` → `freeindex-uk`, `forum.audio.com.pl` → `audio-pl`.
  > Geçmiş: eskiden bu adresler `co-uk`, `com-au` gibi uzantı adlarına çözülüyor ve **88 farklı site sekiz kimliğe çöküyordu** (her kimliğin yalnızca ilk sitesi taranıyor, kalanı hiç görülmüyordu).
  > 13 Ekim 2026'da düzeltildi; sekiz config yeni adına taşındı (`freeindex-uk`, `hotfrog-nz`, `hotfrog-za`, `wordofmouth-au`, `misterwhat-br`, `hotfrog-mx`, `audio-pl`, `fyi-nz`; hiçbirinde gerçek hesap yoktu).
- Config'ler **herkese açık sitelere dair bilgidir**, sır değildir; git'te tutulur. Parola, token ya da kişisel e-posta config'e yazılmaz (yalnızca `field` ile ad verilir).

## 2. Üst düzey alanlar

| Alan | Zorunlu | Anlamı |
|---|---|---|
| `id` | ✔ | Dosya adıyla aynı; ledger, kilit, tarayıcı profili ve şifre türetimi bu kimliğe bağlıdır. **Sonradan değiştirmeyin** (şifre değişir, hesap kaybolur) |
| `name` | ✔ | Görünen ad |
| `risk` | ✔ | `low` · `medium` · `high`. `high` = sistem hiç ağ isteği yapmadan atlar ([§8](#8-risk-ve-captcha)) |
| `signupUrl` | ✔ | Kayıt sayfası adresi; `goto` adımlarında `{{signupUrl}}` olarak kullanılır |
| `steps` | ✔ | En az bir adım ([§3](#3-adımlar)) |
| `verification` | ✔ | E-posta doğrulama belirtimi ([§5](#5-doğrulama-verification)) |
| `success` | – | Hesabın açıldığını gösteren kanıt ([§6](#6-başarı-kanıtı-success)). Yoksa her zaman başarılı sayılır |
| `usernameStyle` | – | `default` ya da `plain` ([§7](#7-kullanıcı-adı-ve-şifre)) |
| `passwordPolicy` | – | `maxLen`, `noSymbols`, `allowedSymbols` ([§7](#7-kullanıcı-adı-ve-şifre)) |
| `solveCaptcha` | – | `false` yazılırsa 2captcha bu sitede kullanılmaz ([§8](#8-risk-ve-captcha)) |
| `notes` | – | Serbest metin + sistemin okuduğu damgalar ([§9](#9-notlar-ve-damgalar)) |
| `emailLocalPart`, `stealth` | – | Şemada kabul edilir ama **hiçbir kod kullanmaz**; yazmayın |

## 3. Adımlar

`steps` bir diziler; yürütücü sırayla oynatır. Her adımın `type`'ı vardır; **bilinmeyen alan ya da eksik gerekli alan yükleme hatasıdır**.

### Her adımda bulunabilen ortak alanlar

| Alan | Anlamı |
|---|---|
| `optional: true` | Seçici bulunamazsa adım **atlanır**, hata verilmez (yalnızca bazı sitelerde görünen alanlar için) |
| `timeoutMs` | Bu adımın bekleme süresi (varsayılan 10 000 ms). `goto` için gezinti süresi bunun iki katıdır |
| `when` | Koşul sağlanmazsa adım atlanır: `{ "urlContains": "…" }` (adres parçası) ve/veya `{ "visible": "<seçici>" }` (görünür öğe). İkisi birlikte verilirse ikisi de gerekir. `"waitMs": N` (1–120 000) eklenirse koşul **N ms'ye kadar beklenir** (250 ms'de bir yoklanır), sonra yine sağlanmıyorsa adım atlanır. Verilmezse koşul **anında** okunur — bir tıklamadan hemen sonra sayfa henüz değişmemiş olabileceği için, sonraki sayfanın ilk korunan adımına `waitMs` yazın (aşağıdaki not) |

> **`when` ve gecikmeli sayfa değişimi (1look4 vakası, 14 Ekim).** `click()` formu gönderirken **hemen döner**: 1look4'te 46 ms'de döndü, site formu ~0,3 sn sonra
> gönderdi ve yeni sayfa ~3 sn sonra açıldı (site ürünün adresini kendisi okuyor). Sonraki sayfanın adımları `when: { "urlContains": "…" }` ile korunuyorsa ve `waitMs`
> yoksa, koşul tıklamanın hemen ardından (adres hâlâ eski) okunur ve o sayfanın **bütün adımları sessizce atlanır**: alanlar boş kalır, insan beklenmez, gönder
> tıklanmaz ve çalıştırma `unconfirmed` biter. Çok sayfalı formlarda **ilk** korunan adıma `"waitMs": 20000` yazın; sayfa geldikten sonra kalan adımların
> `waitMs`'ye ihtiyacı yoktur (adres artık doğrudur). Süre dolarsa gerçek çalıştırmada uyarı (`when koşulu … sağlanmadı`), dry-run'da bilgi satırı düşer.

Seçici bulunamadığında hata **sınıflandırılır**: sayfa yüklenmişse seçici gerçekten yoktur (`Selector bulunamadı` → kalıcı hata, config çürümüş);
sayfa hiç yüklenmemişse ağ sorunudur (geçici hata, tekrar denenebilir).

### Adım türleri

| `type` | Gerekli alanlar | Ne yapar |
|---|---|---|
| `goto` | `url` | Sayfaya gider (`domcontentloaded`). `url` içinde `{{signupUrl}}` kayıt adresiyle değişir |
| `fill` | `selector` + (`field` **ya da** `value`) | Alanı insan hızında yazar, sonra değerin gerçekten yazıldığını doğrular (boş kaldıysa bir kez daha dener, yine boşsa hata; kırpıldıysa uyarır). `field: description` için alanın `maxlength`'ine uyan açıklama varyantı (kısa/orta/uzun) seçilir |
| `select` | `selector` + (`field` **ya da** `value`) | `<select>`'te seçeneği seçer. `field: category` için ürünün birincil kategorisi ve takma adları sırayla denenir; eşleşme yoksa hata (`kategori seçeneği`) |
| `check` | `selector` | Onay kutusunu işaretler (zaten işaretliyse dokunmaz). **Pazarlama/bülten kutusuna asla `check` yazmayın** |
| `click` | `selector` | Tıklar. Etiket seçicileri (`label[for=…]`, `label:has(…)`) için kutu DOM üzerinden işaretlenir (etiketin içindeki "Şartlar" bağlantısına yanlışlıkla tıklanmaz). Gerçek tıklamadan hemen önce **önceden işaretli pazarlama kutuları kaldırılır** |
| `dismiss` | `selectors` (dizi) | Çerez/duyuru bandı gibi kapatılabilir öğeler: görünen **ilk** seçiciye tıklar; hiçbiri yoksa sessizce geçer |
| `upload` | `selector`, `file` | `src/profile/<file>` dosyasını yükleme alanına verir. `file` göreli olmalı: `/`, `\` ve `..` **yasak** (şema reddeder) |
| `waitFor` | `selector` | Seçici görünene kadar bekler (sayfanın hazır olduğunu anlamak için) |
| `expect` | `anyOf` (dizi) | Kayıt gönderildikten sonra bu seçicilerden **biri** görünmeli. Görünmezse sayfa metni sınıflandırılır (aşağıda) |
| `captchaGate` | – | Captcha varsa tespit eder; çözer ya da insana bırakır ([§8](#8-risk-ve-captcha)). Yoksa geçer |
| `humanPause` | – (`minMs`, `maxMs`) | Rastgele kısa bekleme (varsayılan 800–2500 ms) |
| `humanInput` | `selector` (+ `minLength`, `settleMs`, `timeoutMs`) | Sistemin çözemediği alanı (ör. **görsel doğrulama kodu**) bir **insanın** doldurmasını bekler: alanı görünür yapıp **odaklar** (insan tıklamadan yazabilir; odak önceki alanda kalırsa harfler oraya düşer: sharedais vakası), tarayıcıyı öne getirir, uyarı basar ve terminal TTY ise **zil çalar** (pencere başka pencerelerin arkasında kalabilir), alan en az `minLength` (varsayılan 1) karakter olunca (kırpılmış değer) değerin `settleMs` (varsayılan 2000 ms, 0–30 000) boyunca **değişmeden** kalmasını bekler, sonra akış sürer: kod yazılırken 3. harfte devam edilip gönder eksik kodla tıklanmaz. İnsan kodu yazıp **Enter'a ya da Gönder'e kendisi de basabilir** (en doğal davranış): ana çerçevede GET olmayan bir gezinme isteği (form gönderimi) başlarsa insanın gönderdiği anlaşılır, gezinmenin bitmesi beklenir ve sonraki **tıklamalar atlanır** (çift gönderim olmaz; `ctx.humanSubmitted`), akış başarı denetimine geçer. Arka plan istekleri (analitik, fetch) ve GET gezinmeleri (yeniden yükleme) gönderim sayılmaz. Alan başka bir yolla sayfadan kaybolursa bekleme biter, sonraki adımlar kendi `when` koşuluyla karar verir. `timeoutMs` bu adımda insanı bekleme süresidir (varsayılan 5 dk); dolarsa `manual`. Tarayıcı görünür olmalı (`HEADLESS=false`); gözetimsiz çalıştırmada kullanmayın |
| `custom` | `handler` | **Uygulanmadı** — çalıştırılırsa kalıcı hata verir. Kullanmayın |

`fill`/`select`'te `field` ve `value` ikisi de yoksa config yüklenmez. İkisi birlikte verilirse `value` kazanır (`field: description` hariç).

### Dry-run'da adımlar

Dry-run formu doldurur ama **göndermez**; adım adım:

| Adım | Dry-run davranışı |
|---|---|
| `goto`, `fill`, `select`, `check`, `waitFor`, `upload`, `dismiss`, `humanPause` | Normal çalışır |
| `click` | **Atlanır** — yalnızca onay kutusu etiketi tıklamaları (DOM ile işaretleme) yapılır |
| `expect` | Atlanır (gönderim olmadığı için sonuç sayfası yoktur) |
| `captchaGate` | Captcha görülürse ekran görüntüsü alınır; **çözülmez, insan beklenmez** |
| `humanInput` | **Atlanır** (insan beklenmez; gönderim zaten yapılmıyor) |
| `when` + `waitMs` | **Beklenir** (sayfada sonradan beliren öğeler dry-run'da da geç gelir). Tıklama atlandığı için hiç gelmeyen sonraki sayfada `waitMs` kadar sürer, sonra adım atlanır (log: bilgi) |

Dry-run sonrası otomatik denetim: kritik alanlar (`email`, `password`) boş kaldıysa ya da sayfa formdaki bir zorunlu alanı boş görüyorsa sonuç `manual`
olur ("doğrulanmadı" damgası kalkmaz). Görünmez zorunlu alan ve diğer boş alanlar uyarı olarak yazılır. Gönder (`click`) adımı hiç yoksa uyarılır. Sayfada **hiç olmayan** bir alan (ör. sonraki sayfaya ait, `when` ile korunan `fill`) bu denetimde **beklenmez ve boş sayılmaz** (eskiden alan başına tüm zaman aşımı beklenirdi: 1look4 dry-run'ı 53 sn sürüyordu, şimdi ~28 sn).

### `expect` sonrası sayfa metni sınıflandırması

`anyOf` görünmezse sayfa metni (görünür metin + `.alert`, `[role=alert]`, `.error`… içindeki gizli bildirimler) şu sırayla okunur:

1. **İnsan gerektiren** kalıplar (telefon/SMS doğrulaması, kimlik yükleme, ödeme yöntemi şart, davetle üyelik) → `manual`
2. **Hesap zaten var** kalıpları → hata sayılmaz, sonuç `completed` ("Hesap zaten mevcut (daha önce açılmış)"); tek e-posta mimarisinde site "zaten kayıtlı" diyorsa hesap bizimdir
3. Hiçbiri değil ama kayıt sonrası sayfa **tanınıyorsa** (oturum açık, kod isteniyor, "mailini kontrol et") → hata değil, tanınan durum kullanılır
4. Aksi halde `Beklenen içerik görünmedi` (kalıcı hata) — `expect` adımı `optional: true` ise bu da yok sayılır

URL'nin kayıt sayfasından uzaklaşması **tek başına başarı değildir**; yalnızca log'a düşen zayıf bir ipucudur. Bu yüzden `anyOf` desenleri kayda **özgü** olmalı
(`text=/verification (e-?mail|link)/i` gibi); tek kelimelik genel desenler (`welcome`, `dashboard`, `confirm`) yanlış pozitif verdi ve kullanılmıyor.

## 4. Alan adları (`field`)

`fill`/`select` değeri JSON'a **yazılmaz**; adıyla istenir ve çalışma anında profilden ya da kimlikten çözülür. Değer yoksa adım "Alan için değer yok, atlanıyor" der — uydurma değer yazılmaz.

| `field` | Kaynak |
|---|---|
| `email` | Ortak kayıt adresi (`SIGNUP_EMAIL`) ya da ürün profilindeki `signupEmail` |
| `username` | Türetilmiş kullanıcı adı ([§7](#7-kullanıcı-adı-ve-şifre)) |
| `password` | Hesap anahtarından türetilmiş şifre ([§7](#7-kullanıcı-adı-ve-şifre)) |
| `companyName`, `website`, `tagline`, `pricing` | Ürün profili |
| `description` | Profil açıklaması; alan `maxlength`'ine göre kısa/orta/uzun seçilir |
| `category` | Birincil kategori (`select`'te takma adlarla birlikte denenir) |
| `firstName`, `lastName`, `fullName`, `contactEmail` | Profildeki iletişim kişisi |
| `role` | İletişim kişisinin unvanı — **profilde yoksa boş bırakılır** (uydurma unvan yazılmaz) |
| `twitter`, `linkedin`, `github` | Profildeki sosyal bağlantılar; yoksa atlanır |
| `foundedYear` | Kuruluş yılı |
| `productTitle` | `"<ürün adı> — <slogan>"` (ör. `geo.new — Free GEO audit for AI search`): liste/bookmarking sitelerinin tek satırlık başlık alanları için |
| `terms` | Alan adı olarak tanınır ama değeri yoktur; şartlar kutusu `check`/`click` ile işaretlenir |

## 5. Doğrulama (`verification`)

Site kayıttan sonra e-posta doğrulaması istiyor mu? İstiyorsa doğrulama maili ortak kutuya düşer; sistem Gmail'den okur.

| Alan | Anlamı |
|---|---|
| `mode` | `link` (mailde bir bağlantı), `code` (mailde bir kod), `none` (doğrulama yok) |
| `from` | Beklenen gönderen: `noreply@site.com` ya da `*@site.com`. **Yalnızca alan adı** karşılaştırılır. Verilirse eşleşme katıdır |
| `subjectContains` | Konu şu ifadelerden **birini** içermeli (büyük/küçük harf duyarsız) |
| `linkPattern` | Verilirse bağlantı genel skorlama yerine bu **regex** ile seçilir (önce düz metinde, sonra HTML bağlantılarında aranır) |
| `codeSelector` | `mode: code` için **zorunlu**: kodun yazılacağı alan. Rakam başına ayrı kutu varsa hepsini seçen bir seçici verin (ör. `input[maxlength='1']`); kutu sayısı kod uzunluğuna eşit olmalı |
| `codeSubmitSelector` | Kod gönder düğmesi; yoksa `Enter` basılır |
| `timeoutMs` | Mailin gelmesi için bekleme (varsayılan `EMAIL_TIMEOUT_MS` = 10 dk; otomatik üretilen taslaklarda 3 dk) |
| `unverifiedAccount` | `mode: none` iken **hesap doğrulanmamış kalıyorsa** `true` (site mail göndermiyor, hesap "Pending"). "Doğrulama gerekmiyor" ile "doğrulama maili hiç gelmiyor" notta ayrılır |

### Mail eşleşmesi nasıl çalışır

Tüm sitelere **aynı** adresle kaydolunduğu için `to:` ayırt etmez; eşleşme şunlara dayanır:

1. Sorgu `in:anywhere` (spam dahil) ve **kayıt zamanından 60 sn öncesi** sonrası;
2. Gönderenin kayıtlanabilir alan adı = sitenin alan adı (ya da `from`). `from` verilmemişse, gönderen başka bir alan adı olsa bile (Discourse forumları `discoursemail.com`'dan yollar) **mailin gövdesi site alan adını anıyorsa** aday sayılır;
3. `subjectContains` verildiyse konu eşleşmeli;
4. Daha önce görülmüş mail kimlikleri (`seen_messages`) atlanır.

Poll aralığı kademelidir: ilk dakika 10 sn'de bir, sonra 30 sn, en sonda 60 sn. Mail süre içinde gelmezse **geçici hata** (`Doğrulama maili N saniyede gelmedi` → durum `error`, sonradan yeniden denenebilir).
Link için: `linkPattern` yoksa bağlantılar skorlanır (doğrulama yolu `/verify`, `/confirm`, `/activate`…; uzun token; çıkma/sosyal/gizlilik bağlantıları elenir); en iyi iki aday **eşit skorluysa** tahmin etmez, `manual` verir.
Kod için: 4–8 haneli sayılar adaydır; yıl benzeri sayılar elenir, "code/kod/pin/otp" geçen satırlar ve konudaki sayı öne geçer.

### Config'in tahmini kayıt sonrası sayfayla düzeltilir

`mode` çoğu zaman **tahmindir** (taslaklarda varsayılan `link`). Gönderimden sonra sayfa **otomatik tanınır** ve gözlem, config'in tahminini o koşu için geçersiz kılar:

| Gözlem | Sistem ne yapar |
|---|---|
| **Oturum açık** (çıkış bağlantısı görünüyor ya da gizli menüde çıkış var ve sayfa bu hesabın kullanıcı adını/e-postasını gösteriyor; parola alanı yok) | Doğrulama gerekmez; mail beklenmez |
| **Kod isteniyor** (kod metni + 4–8 tek haneli kutu ya da kod adlı tek alan) | `mode: code`'a geçer; seçiciyi sayfadan alır |
| **"Mailini kontrol et"** yazıyor (ve form ortada değil) | Config `none` demişse bile `link` kipine geçer |
| Hiçbiri | Config aynen uygulanır |

Sistem config dosyasını **kendiliğinden değiştirmez**; yalnızca log'a "mode:none olabilir" önerisi yazar. Gerçek koşudan öğrendiğinizi `mode`'a ve `notes`'a siz işlersiniz.

## 6. Başarı kanıtı (`success`)

Doğrulamadan sonra (ya da doğrulama gerekmiyorsa gönderimden hemen sonra) hesabın gerçekten açıldığını kontrol eder:

```json
"success": {
  "afterVerifyUrlContains": ["/dashboard", "/welcome"],
  "anyOf": ["text=/my account/i", "a:has-text('Log out')"]
}
```

- `afterVerifyUrlContains`: son adres bu parçalardan birini içeriyorsa başarılı.
- `anyOf`: bu seçicilerden biri görünüyorsa başarılı.
- `success` alanı **hiç yazılmazsa** hesap her zaman başarılı sayılır — bu zayıf bir güvencedir; mümkünse yazın. `success` yazılıp iki liste de boş bırakılırsa tam tersi: hiçbir zaman başarılı sayılmaz.
- Kanıt tutmazsa durum `manual` ("doğrulama sonrası başarı kontrolü geçmedi").

## 7. Kullanıcı adı ve şifre

**Kullanıcı adı** her hesapta farklıdır, çünkü e-posta ortaktır: `<ürün adı (yalnız harf/rakam, küçük)>_<site kimliğinin ilk 8 karakteri, tireler atılarak>` — örn. `geonew_10words` (en çok 30 karakter).
`usernameStyle: "plain"` alt çizgiyi kaldırır (`geonew10words`); site "özel karakter içeremez" diyorsa kullanın.

**Şifre saklanmaz, türetilir:** `HMAC-SHA256(MASTER_SECRET, "geo.new|<hesap anahtarı>|v<sürüm>")`; çıktı `Gn` + 18 karakterlik gövde + `!7` = 22 karakter (büyük/küçük harf, rakam, sembol). Aynı ürün/site için her zaman aynı şifre çıkar; `npm run cli -- password <siteId>` ile görülür.
`passwordPolicy` siteler için ayarlar:

| Alan | Etki |
|---|---|
| `maxLen` | Şifreyi bu uzunluğa **ortadan kırparak** indirir (baş `Gn` ve son `!7` korunur). 8'den küçük değer hata verir |
| `noSymbols: true` | Sembolsüz: `Gn<gövde>7` |
| `allowedSymbols` | Yalnızca izin verilen semboller: ilk karakter kullanılır (`Gn<gövde><sembol>7`) |

> `geo.new|…` öneki türetmenin parçasıdır; değiştirmek **tüm mevcut hesapların şifresini değiştirir**.

## 8. Risk ve captcha

**`risk`:**

| Değer | Anlamı |
|---|---|
| `low` | Normal; sistem işler (config'lerin ezici çoğunluğu) |
| `medium` | Bilgi amaçlı etiket; işleme farkı yok |
| `high` | **Kullanım şartları otomatik erişimi/captcha aşmayı açıkça yasaklıyor.** Sistem ağ isteği yapmadan `skipped_high_risk` döner ve hiçbir bayrak bunu aşmaz. Keşif şu alan adlarını otomatik `high` işaretler: g2.com, capterra.com, trustpilot.com, producthunt.com, gartner.com, getapp.com, softwareadvice.com |

**Captcha** ([ARCHITECTURE.md §7](ARCHITECTURE.md#7-captcha)): `captchaGate` adımı captcha görürse:

1. Görünmez/pasif (skorlayan) captcha ise insan çağrılmaz, devam edilir.
2. `CAPTCHA_API_KEY` doluysa ve site `risk: high` değilse ve `solveCaptcha: false` **yazılmamışsa** 2captcha ile çözülür (varsayılan **açık**). reCAPTCHA v2/v3, hCaptcha ve Turnstile desteklenir; görsel (yazı/resim) captcha desteklenmez.
3. Çözücü yoksa/başarısızsa tarayıcı öne getirilir, **insan çözene kadar** `CAPTCHA_TIMEOUT_MS` boyunca beklenir (çözülünce akış kendiliğinden sürer); süre dolarsa `manual`.

Bir sitenin ToS'u captcha aşmayı yasaklıyor ya da belirsizse `"solveCaptcha": false` yazın (ya da tamamen yasaksa `risk: high`).
`captchaGate`'i her zaman **gönder tıklamasından önce** koyun.

## 9. Notlar ve damgalar

`notes` serbest metindir, ama sistem **iki damgayı** okur:

| Damga | Anlamı | Etki |
|---|---|---|
| `OTOMATİK ÜRETİLDİ — doğrulanmadı` | Keşfin ürettiği taslak; hiç dry-run'dan geçmedi | `run-batch` bu config'i atlar. Başarılı `run-one <id> --dry-run` damgayı `Doğrulandı (dry-run, <tarih>)` ile değiştirir |
| `TAŞINMA ONAYI BEKLİYOR` | Keşif sitenin başka alan adına taşındığını gördü | **Hiçbir bayrakla** gerçek kayıt yapılmaz (dry-run serbest). Doğru site olduğunu insan onaylayıp damgayı elle siler; dry-run bu damgayı kaldırmaz |

**Gerçek koşudan öğrendiklerinizi `notes`'a ekleyin.** Biçim: `| <yyyy-aa-gg> GERÇEK denemede: <ne oldu, neden>`. Sonraki kişi (ve Sheet raporu) neden takıldığını buradan okur;
yalnızca olgu yazın ("görsel captcha var, çözülmüyor"), tahmin yazmayın. Sheet etiketlemesi **en son** `GERÇEK` bölümünü okuyup engeli sınıflar (görsel captcha, iş e-postası, hCaptcha, SSO…).
Hesabı açık bir sitenin **listeleme formunda** bilinen bir engel varsa `| <tarih> LİSTELEME: <kısa sınıf> — <ayrıntı>` ekleyin (Sheet'te Sorun = `Listeleme: <kısa sınıf>`).

## 10. Config yazma rehberi

1. **Gerçek formu görün.** Tahminle seçici yazmayın:
   ```bash
   npm run inspect -- https://site.example/signup
   ```
   Alanların `name`/`id`/`placeholder`'ı ve önerilen `field` listelenir.
2. **Seçicileri kararlı seçin.** Sıra: `name` → `type` → `autocomplete` → `placeholder` → görünür metin (`button:has-text('Create account')`).
   Üretilmiş kimliklerden (UUID, uzun hex/sayı kuyruğu, `:r1:`, `react-aria…`, `css-…`) **kaçının**: her yüklemede değişirler. Bir `id` geçerli CSS değilse (`#3ab…`, `#a.b`) `[id='…']` yazın.
3. **Şartlar kutusu görünmezse** (özel stilli) etiketi seçin: kararlı kimlikte `label[for='agree']`, üretilmişte `label:has(input[name='terms'])`. Etiket seçicileri dry-run'da da çalışır ve kutuyu DOM'dan işaretler.
4. **Sıra:** `goto` → (varsa `dismiss`) → `waitFor` (form hazır) → `humanPause` → `fill`'ler → şartlar kutusu → `captchaGate` → `humanPause` → gönder `click` → `expect`.
5. **`expect` desenleri kayda özgü olsun** (doğrulama maili gönderildi, hesap oluştu); tek kelimelik genel desen yazmayın.
6. **Doğrulama kipini tahmin edin, sonra gerçekle düzeltin:** `link` ile başlayın; `verification.timeoutMs`'i kısa tutun (3 dk) ki mail göndermeyen sitede dakikalar boşa gitmesin.
7. **Dry-run:**
   ```bash
   npm run cli -- run-one <id> --dry-run
   ```
   Ekran görüntüsünü (`artifacts/…/dry-run-final.png`) **gözle de** kontrol edin: bir seçicinin bulunması, alanın dolduğu anlamına gelmez.
8. **Tek gerçek koşu:** `npm run cli -- run-one <id>`. Kayıt sonrası sayfa (doğrulama türü, başarı işareti) yalnızca burada görülür. Sonucu `notes`'a işleyin.
9. **Pazarlama kutusu:** hiçbir `check`/`click` pazarlama/bülten kutusuna gitmemeli; önceden işaretli gelenler zaten kaldırılır.
10. **Uygun olmayanı bırakın.** Görsel captcha, yalnızca iş e-postası, yalnızca SSO (Google/Epic ile giriş), çok adımlı sihirbaz, davetle üyelik: bunlar config ile çözülmez; nedeni `notes`'a yazıp bırakın ([FIELD-NOTES.md](FIELD-NOTES.md)).

Yeni config'i commit etmeden önce `npm run cli -- list` (şema geçerli mi) ve ilgili testler (`npm test`) çalışmalı.

## 11. Örnek: açıklamalı bir config

Aşağıdaki config yalnızca biçimi göstermek için yazılmış kurgusal bir örnektir (`example.com`).

```json
{
  "id": "ornek",
  "name": "Ornek Dizin",
  "risk": "low",
  "signupUrl": "https://example.com/signup",
  "steps": [
    { "type": "goto", "url": "{{signupUrl}}" },
    { "type": "dismiss", "selectors": ["#cookie-accept", "button:has-text('Accept')"], "optional": true },
    { "type": "waitFor", "selector": "input[name='email']", "timeoutMs": 20000 },
    { "type": "humanPause", "minMs": 600, "maxMs": 1600 },
    { "type": "fill", "selector": "input[name='username']", "field": "username", "optional": true },
    { "type": "fill", "selector": "input[name='email']", "field": "email" },
    { "type": "fill", "selector": "input[name='password']", "field": "password" },
    { "type": "click", "selector": "label[for='agree-terms']", "optional": true },
    { "type": "captchaGate" },
    { "type": "humanPause", "minMs": 500, "maxMs": 1200 },
    { "type": "click", "selector": "button:has-text('Create account')" },
    {
      "type": "expect",
      "anyOf": ["text=/verification (e-?mail|link)/i", "text=/check your (e-?mail|inbox)/i"],
      "timeoutMs": 25000
    }
  ],
  "verification": {
    "mode": "link",
    "from": "*@example.com",
    "subjectContains": ["confirm", "verify"],
    "timeoutMs": 180000
  },
  "success": { "anyOf": ["a:has-text('Log out')"] },
  "passwordPolicy": { "maxLen": 20 },
  "notes": "OTOMATİK ÜRETİLDİ — doğrulanmadı"
}
```

Satır satır:
- `dismiss` çerez bandını kapatır; hiçbiri yoksa sessizce geçer. `waitFor` formun hazır olduğunu bekler.
- `username` alanı bazı kayıt formlarında yoktur: `optional: true` ile atlanır.
- Şartlar kutusu etiketi tıklanır; `optional` çünkü bazı yüklemelerde kutu yoktur. Pazarlama kutusuna dokunulmaz.
- `captchaGate` gönder tıklamasından önce.
- `expect` kayda özgü iki desen; `verification.from` yalnızca alan adını karşılaştırır.
- `passwordPolicy.maxLen` 20: 22 karakterlik şifre ortadan kırpılarak 20'ye iner.

Gerçek örnekler: [src/sites/10words.json](../src/sites/10words.json) (doğrulama yok, `mode: none`), [src/sites/bufferapps.json](../src/sites/bufferapps.json) (6 kutulu kod, `mode: code`).

## 12. Sık hatalar

| Belirti | Neden / çözüm |
|---|---|
| `Geçersiz site config … fill adımında field veya value verilmeli` | `fill`/`select`'e `field` ya da `value` ekleyin |
| `mode:'code' için codeSelector zorunlu` | Kod kipinde kodun yazılacağı alanı verin |
| `upload dosyası src/profile/ altında göreli bir yol olmalı` | `file`'da `/`, `\` ya da `..` var |
| `Selector bulunamadı: …` | Seçici sayfada yok: form değişmiş ya da dinamik kimlik. `npm run inspect` ile yeniden okuyun |
| `Beklenen içerik görünmedi` | `expect` deseni sitenin gerçek metniyle tutmuyor: artifact'taki `failure-*.html`/`.png`'den gerçek metni alıp deseni düzeltin |
| Dry-run "Kritik alan BOŞ — sayfa bu alanı ZORUNLU işaretliyor (checkbox)" | Şartlar kutusu işaretlenmiyor: etiket seçicisi ekleyin ([§10.3](#10-config-yazma-rehberi)) |
| Config yüklenir ama `run-batch` atlıyor | Hâlâ `OTOMATİK ÜRETİLDİ — doğrulanmadı` damgası var: `run-one <id> --dry-run` ile doğrulayın |
| Doğrulama maili gelmiş ama bulunamıyor | `from`/`subjectContains` fazla katı ya da gönderen başka bir alan adı: `from`'u kaldırın (gövde site alan adını anıyorsa eşleşir) |

Daha fazlası: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
