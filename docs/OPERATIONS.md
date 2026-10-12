# Operasyon el kitabı

Sistemi **çalıştıran** kişi içindir: token yenileme, bir listeyi koşturma, hız sınırı, keşif/doğrulama turları, listeleme, Sheet güncelleme, kurtarma ve bakım.
Komutların ayrıntısı: [CLI.md](CLI.md). Bir şey ters giderse: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## İçindekiler

1. [Token yenileme (haftalık)](#1-token-yenileme-haftalık)
2. [Ayarlar ve hız sınırı](#2-ayarlar-ve-hız-sınırı)
3. [Bir listeyi koşturma (pilot)](#3-bir-listeyi-koşturma-pilot)
4. [Keşif ve doğrulama turları](#4-keşif-ve-doğrulama-turları)
5. [Listeleme operasyonu](#5-listeleme-operasyonu)
6. [Sheet güncelleme](#6-sheet-güncelleme)
7. [Kurtarma](#7-kurtarma)
8. [Veri düzeni, yedek ve temizlik](#8-veri-düzeni-yedek-ve-temizlik)
9. [Kontrol listeleri](#9-kontrol-listeleri)

---

## 1. Token yenileme (haftalık)

Gmail (doğrulama mailleri) ve Sheets için tek bir OAuth token'ı kullanılır. Google Cloud'daki OAuth onay ekranı bilerek **"Testing"** modunda tutulur
(Production'a geçiş, hassas kapsamlar için ana sayfa + gizlilik politikası ister; bu iç araç için gereksiz yük). Bedeli: **refresh token 7 günde ölür**.

```bash
cd <proje klasörü>          # DOĞRU klasörde olduğunuzdan emin olun (aşağıdaki uyarı)
npm run gmail:auth          # tarayıcı açılır; kayıt hesabıyla giriş yapıp izin verin
npm run cli -- check-gmail  # "Gmail bağlı: <adres>" ve SIGNUP_EMAIL ile eşleşmeli
```

- İzinler: `gmail.readonly` (yalnızca okuma) + `spreadsheets` (Sheet yazma). Yerel geri çağrı sunucusu **5899** numaralı portu kullanır.
- Komut her çalıştığında mevcut token'ın yaşını gösterir; **5–6 günlük token'ı beklemeden yenileyin** (uzun bir liste çalışırken ölürse doğrulama bekleyen siteler `error` olur).
- Kullandığınız Google hesabı Cloud Console → *OAuth consent screen* → *Audience* → **Test users** listesinde olmalı. Bu hesap `.env`'deki `SIGNUP_EMAIL` ile **aynı** olmalı; `check-gmail` farklıysa uyarır ve 1 döner.
- Sheet erişimi de bu hesap üzerindendir: Sheet o hesabın Drive'ındaysa ya da o hesaba paylaşıldıysa çalışır. Sheet hatası çalışmayı **düşürmez** (Sheet yalnızca görünürlük katmanıdır).

> **Klasör tuzağı.** `GOOGLE_OAUTH_TOKEN_FILE` göreli bir yoldur (`.auth/gmail-token.json`); token **komutun çalıştığı klasöre** yazılır. Projenin eski/bayat bir kopyasında çalıştırırsanız token yanlış yere yazılır,
> asıl klasördeki token ölü kalır ve `check-gmail` "bağlı değil" der. Her zaman `pwd` ve `git status` ile hangi kopyada olduğunuzu doğrulayın; token başka yere yazıldıysa dosyayı doğru `.auth/` altına kopyalayın.
> Projeyi iCloud ile eşitlenen klasörlerde (Desktop/Documents) tutmayın.

## 2. Ayarlar ve hız sınırı

Hepsi `.env`'de ([.env.example](../.env.example) açıklamalı şablon; doğrulama: [src/config.ts](../src/config.ts)). Eksik/hatalı ayar tarayıcı açılmadan okunur bir hatayla patlar.

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `MASTER_SECRET` | – (zorunlu, ≥ 32 karakter) | Tüm şifrelerin türetildiği sır. **Kaybı telafi edilemez**; `openssl rand -hex 32` ile üretin, parola yöneticisine yedekleyin |
| `SIGNUP_EMAIL` | – (zorunlu) | Tüm sitelere kaydolunan **tek** adres (kullanılmayan bireysel Gmail) |
| `GOOGLE_OAUTH_CLIENT_FILE` / `GOOGLE_OAUTH_TOKEN_FILE` | `.auth/gmail-client-secret.json` / `.auth/gmail-token.json` | OAuth istemci ve token dosyaları |
| `SHEET_ID`, `SHEET_TAB` | boş, `Sheet1` | Takip tablosu ve işlenecek sekme. `SHEET_ID` boşsa Sheet kapalıdır |
| `HEADLESS` | `false` | Görünür tarayıcı. Captcha'da insan devralması için **görünür** kalmalı; yalnızca yan etkisiz toplu doğrulamada `true` düşünülebilir |
| `DAILY_LIMIT` | `12` | Günde en çok kaç **gerçek** kayıt denemesi (ve ayrı sayaçla kaç gerçek listeleme) |
| `MIN_GAP_MINUTES` / `MAX_GAP_MINUTES` | `6` / `18` | Siteler arası rastgele bekleme (liste çalıştırıcı ve `run-batch`) |
| `EMAIL_TIMEOUT_MS` | `600000` (10 dk) | Doğrulama mailini bekleme üst süresi (config `verification.timeoutMs` bunu geçersiz kılar) |
| `CAPTCHA_TIMEOUT_MS` | `900000` (15 dk) | Captcha'da insanı bekleme süresi. Başsız/gözetimsiz koşuda kısaltın (örn. `120000`) ki takılan site saatleri yemesin |
| `LOCK_TTL_MS` | `2700000` (45 dk) | Çalıştırma kilidinin ömrü |
| `CAPTCHA_API_KEY` | boş | 2captcha anahtarı. Boşsa çözücü kapalı, captcha'lar insana düşer. **Yalnızca `.env`'de tutulur** |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

**`DAILY_LIMIT` bir risk kararıdır**, teknik bir sınır değil: aynı IP'den günde kaç kayıt yapıldığı sitelerin sahtecilik sinyalidir. Yükseltmek (ör. 12 → 80) bilinçli bir karar olmalı ve izleme gerektirir.
Sayaç yalnızca **gerçek** denemeleri sayar (`skipped_*` ve dry-run sayılmaz), yerel gün başlangıcından ölçülür. Listeleme için ayrı bir sayaç vardır ve `--force` onu aşmaz.

## 3. Bir listeyi koşturma (pilot)

### 3.1 Liste hazırlama

Liste, satır başına bir site id'si içeren düz metin dosyasıdır (`#` yorum). Aday seçerken:

- Config **doğrulanmış** olmalı (`OTOMATİK ÜRETİLDİ — doğrulanmadı` damgası yok; bir dry-run geçmiş). Taslakla gerçek kayıt yanlış forma veri göndermek demektir.
- `risk` `low` olmalı; taşınma onayı bekleyen olmamalı.
- Hesabı **henüz açık olmamalı** ve son gerçek denemesi kesin hatayla bitmemiş olmalı (yoksa `skipped_terminal` ile atlanır).
- Elenecekler ([FIELD-NOTES.md](FIELD-NOTES.md)): görsel captcha'lı siteler, yalnızca iş e-postası kabul edenler, yalnızca SSO ile girenler, çok adımlı sihirbazlar, davetle üyelik.

Dosyaları `data/pilot/liste-<tarih>[-etiket].txt` adıyla tutun; böylece neyin ne zaman denendiği iz bırakır.

### 3.2 Başlatma

```bash
cd <proje klasörü>
caffeinate -is npx tsx scripts/run-list.ts --file data/pilot/liste-2026-10-12.txt --max-failures 12 \
  > data/pilot/driver-2026-10-12.log 2>&1 &
```

`caffeinate -is` Mac'in uykuya dalmasını önler (uyku, koşuyu ve Wi‑Fi'ı keser). Çalıştırıcı:
- siteleri sırayla `run-one` ile gerçek kayıt olarak koşturur, aralarında `MIN_GAP_MINUTES`–`MAX_GAP_MINUTES` **rastgele** bekler;
- **ardışık** `--max-failures` (varsayılan 6) başarısızlıkta durur (sistem çapında bir bozulma — ağ, token, kod hatası — genelde arka arkaya başarısızlık olarak görünür);
- internet kesilirse bekler (30 dk'ya kadar); kesinti yüzünden düşen siteyi başarısız saymaz, listenin sonunda yeniden dener;
- günlük sınır, kilit ve risk kapılarını `run-one`'a bırakır (sınır dolunca kalan siteler `skipped_limit` ile atlanır).

### 3.3 İzleme

```bash
tail -f data/pilot/driver-2026-10-12.log            # genel akış
tail -n 20 data/pilot/results.jsonl                 # her sonuç bir satır
npm run cli -- status                               # bugünkü sayaç ve son denemeler
cat data/pilot/<site>.log                           # tek sitenin tüm çıktısı
```

### 3.4 Durdurma

```bash
touch data/pilot/STOP        # sıradaki siteden önce (ve bekleme sırasında) durur; mevcut site biter
rm data/pilot/STOP           # yeniden başlatmadan önce MUTLAKA silin (aksi halde çalıştırıcı hemen durur)
```

Süreci zorla öldürürseniz (`kill -9`) o sitenin **kilidi** süresi dolana kadar kalır (45 dk): `npm run cli -- unlock <site>`.

### 3.5 Bitişten sonra: sonuçları sınıflandırma

Her başarısız site için `data/pilot/<site>.log` ve `artifacts/<runId>/<anahtar>/failure-*.png|html` dosyalarına bakın:

| Sonuç | Yapılacak |
|---|---|
| `completed` | Hesap açık. Doğrulama gerekmediyse/doğrulandıysa iş tamam; profil adresi ledger'da |
| `failed`, sayfa metni "hesap açıldı" diyor ya da giriş mümkün | Hesap gerçekte açık olabilir: `password <site>` ile elle girin; açıksa `adopt-account` (kanıt notuyla) |
| `failed`/`manual`, sitenin kalıcı engeli (görsel captcha, iş e-postası, SSO…) | Config `notes`'una `| <tarih> GERÇEK denemede: …` yazın; siteyi bırakın |
| `failed`, config hatası (seçici, desen, yanlış doğrulama kipi) | Config'i düzeltin, `--force` ile **tek** koşu ile yeniden deneyin |
| `error` | Geçici (ağ, zaman aşımı, mail gelmedi); yeniden denenebilir (terminal değil) |
| Hesap açık ama doğrulama kodu/linki hiç gelmedi | Sitenin mail göndermediğini notlayın; hesap "doğrulanmamış" kalır |

### 3.6 Verim beklentisi

Gerçek denemelerin yaklaşık dörtte biri hesapla sonuçlanıyor (12 Ekim 2026: 138 gerçek denemede 32 `completed`); kalanı sitelerin kendine özgü engelleri (görsel captcha ailesi, iş e-postası, SSO, çok adımlı form, hiç gelmeyen mail).
Hız `MIN/MAX_GAP` ile sınırlıdır (ortalama ~12 dk → saatte ~5 site). Bu normaldir; hızlandırmak sinyal üretir ve verimi artırmaz. Ayrıntı: [FIELD-NOTES.md](FIELD-NOTES.md).

## 4. Keşif ve doğrulama turları

Sheet'teki yeni siteler için **config üretmek** ve **dry-run ile doğrulamak** (ikisi de kayıt göndermez):

```bash
SHEET_TAB="SaaS" npm run discover -- --limit 50            # taslak config'ler üretir (src/sites/<id>.json)
npm run verify-drafts -- --only a,b,c                      # ya da --limit N: toplu dry-run
```

- **Keşif** (`discover`): her site için kayıt sayfasını bulur (3 aşama: canlılık, doğrudan yollar, ana sayfa bağlantıları), formu analiz eder, "doğrulanmadı" damgalı taslak yazar.
  Sonuç sınıfları: `generated`, `high_risk`, `bot_protected`, `no_form`, `submit_form` (hesapsız gönderim formu), `email_first` (önce e-posta/sihirli bağlantı), `error`. İlerleme `data/discovery-<sekme>.json`'da; kesilirse kaldığı yerden sürer.
  `generated` ve `high_risk` **asla yeniden taranmaz** (elle düzeltmeleri ve ToS kararını korumak için). Bot duvarına çarpan site aşılmaya çalışılmaz, listeye "Bot koruması" olarak düşer.
- **Toplu doğrulama** (`verify-drafts`): her site ayrı süreçte `run-one --dry-run` koşar; başarılıysa damga kalkar, başarısızsa neden ledger'a yazılır. Takılan site süreç grubuyla öldürülür.
  İlerleme `data/verify-drafts/progress.json`; durdurmak için `touch data/verify-drafts/STOP` — ve yeniden başlatmadan önce **silin** (depoda eskiden kalmış bir STOP varsa tur hemen biter).
- Doğrulama **kayıt sonrasını** denemez (yalnızca alanların dolduğunu ve gönder butonunun bulunduğunu gösterir); doğrulama türü ve başarı sayfası yalnızca ilk gerçek koşuda ortaya çıkar. Bu yüzden ilk gerçek koşularda hata beklenir; liste çalıştırıcı bunun için ardışık hatada durur.

## 5. Listeleme operasyonu

Listeleme **herkese açık yayındır**; ayrıntılı model [LISTINGS.md](LISTINGS.md)'dedir. Her gerçek gönderimden önce:

- [ ] Ürün bilgisi **doğru** ve ürün sahibince teyitli (yanlış/doğrulanmamış bilgi yayınlanmaz).
- [ ] `submit <site>` (dry-run) temiz: `completed (dry-run — gönderilmedi)`, uyarısız; ekran görüntüsünde alanlar doğru.
- [ ] Sitede **silme/düzenleme** imkânı ve gönderimin **hemen yayınlanıp yayınlanmadığı** araştırıldı; kaldırılamayan ve tanıtım/bülten tetikleyen sitelerde karar ürün sahibinde.
- [ ] `approve-profile <ürün>` ekranındaki bilgileri **kendi gözünüzle** okudunuz ve kodu siz yazdınız (insan adımı).
- [ ] İlk gönderim **tek site, tek koşu**.

Gönderimden sonra: giriş yapmadan listeleme adresini açıp **herkese açık** olduğunu doğrulayın; sonucu config `notes`'una işleyin; `unconfirmed` ise elle kontrol edin ve `--force` ile **tekrar göndermeyin**.

## 6. Sheet güncelleme

Sheet **otorite değildir**; yalnızca insanın bakıp ilerlemeyi görmesi içindir. Otorite `data/ledger.sqlite`'tır. İki ayrı yazıcı vardır:

| Yazıcı | Ne yazar | Ne zaman |
|---|---|---|
| `run-batch` / `runSite` (`onProgress`) | Kaynak sekmedeki **Durum**, E-posta, Kullanıcı Adı, Risk, Deneme, Son Çalıştırma, Not, Profil URL kolonları | Her çalıştırmada (yalnızca `run-batch` ile; `run-list` Sheet'e yazmaz) |
| `scripts/sheet-annotate.ts` | **Otomasyon Durumu / Otomasyon Sorunu / Otomasyon Notu** — üç ek kolon; mevcut kolonlara dokunmaz | Elle, sekme sekme |
| `scripts/sheet-ready-tab.ts` | Tek bir **"Hazır Siteler"** özet sekmesini baştan yazar | Elle |

### 6.1 Sekme sekme etiketleme

```bash
SHEET_TAB="SaaS" npx tsx scripts/sheet-annotate.ts --dry-run    # ne yazacağını görün (hiçbir şey yazmaz)
SHEET_TAB="SaaS" npx tsx scripts/sheet-annotate.ts              # yazar
```

Sekme adları **tam** yazılmalıdır; bazılarında sonda boşluk vardır (`"Deals "`, `"File Upload "`). 22 sekmenin adı `data/discovery-*.json` dosya adlarından okunabilir.
Her sekme için kaynaklar: config'ler, `data/verify-drafts/progress.json`, `data/discovery-<sekme>.json` ve ledger (açık hesaplar). Sheet API kotasını aşmamak için yazımlar toplu yapılır.

### 6.2 Durum sınıfları (Otomasyon Durumu)

Sınıflar bilerek **az ve kalıcıdır**; ayrıntı "Not"/"Sorun" kolonlarındadır ([src/discovery/annotate.ts](../src/discovery/annotate.ts)):

| Durum | Anlamı |
|---|---|
| **Hesap açık** | Bu siteyle açılmış gerçek hesap var |
| **Hazır** | Doğrulanmış config; kayıt denenebilir (captcha türü notta) |
| **Takıldı: elle bakılacak** | Doğrulanmış config ama son gerçek deneme kesin başarısız bitti; işçi kendiliğinden yeniden denemez |
| **Taslak: düzeltilecek** | Dry-run başarısız; **Sorun** kolonu filtrelenebilir sınıfı verir (alan bulunamadı, zorunlu kutu, dinamik kimlik, sayfa açılmadı, …) |
| **Taslak: doğrulanmadı** | Config üretildi, canlı dry-run henüz yapılmadı |
| **Taşınma onayı bekliyor** | Site başka alan adına taşınmış; insan onaylayana kadar kayıt yok |
| **ToS yasaklıyor** | Kullanım şartları otomatik erişimi yasaklıyor (`risk: high`) |
| **Bot koruması** | Cloudflare/captcha duvarı; aşılmaya çalışılmaz |
| **Form yok** | Kayıt formu bulunamadı |
| **Submit formu (ayrı akış)** | Hesap yok, doğrudan gönderim formu (listeleme akışı) |
| **Mail-first (ayrı akış)** | Önce e-posta/sihirli bağlantı adımı |
| **Tarama hatası** / **Taranmadı** | Keşif tamamlanamadı / henüz taranmadı |

Yeni bir sınıf eklemek: `DURUM` + `annotate()` (saf) + `test/annotate.test.ts`; sınıfları çoğaltmak yerine ayrıntıyı Sorun/Not'a yazın.

### 6.3 Sheet'i güncel tutma

Etiketleme bir **anlık görüntüdür**; yeni hesaplar/denemeler olunca yeniden çalıştırılmalıdır (idempotent: aynı girdi aynı çıktıyı yazar). Pratik akış: bir liste koşusundan sonra
`sheet-annotate`'i ilgili sekmelerde, ardından `sheet-ready-tab`'ı çalıştırın. "Hazır kaç site?" sorusunun cevabı "Hazır Siteler" sekmesinin satır sayısıdır (aynı site birden çok sekmede geçebilir; orada bir kez görünür).

## 7. Kurtarma

| Durum | Ne yapılır |
|---|---|
| Çalıştırma öldü, kilit kaldı | Süre dolunca (45 dk) kendiliğinden temizlenir; beklemek istemezseniz `npm run cli -- unlock <site>` |
| Koşu "başarısız" yazdı ama hesap açık | `password <site>` ile elle girin; açıksa `adopt-account <site> --note "<kanıt>"` |
| Hesap açık ama sistem "terminal" sayıp bir daha denemiyor, oysa config düzeltildi | `run-one <site> --force` (tek koşu); site "zaten kayıtlı" derse sonuç `completed` olur |
| Token öldü (doğrulama bekleyen siteler `error`) | `npm run gmail:auth` → `check-gmail` → listeyi yeniden başlatın (terminal olmayan `error`'lar yeniden denenir) |
| Mac uyudu / internet kesildi | Liste çalıştırıcı bekler; uyku koşuyu kesmişse listeyi (tamamlananları çıkarıp) yeniden başlatın. `caffeinate -is` kullanın |
| `MASTER_SECRET` kayboldu | **Telafisi yok**: türetilmiş şifreler yeniden üretilemez; açık hesaplara yalnızca site üzerinden şifre sıfırlama ile girilir. Yedeği parola yöneticisinde tutun |
| Yanlış `.env`/yanlış klasör | Doğru klasörün `.env`, `.auth/` ve `data/` (özellikle `ledger.sqlite`, `profiles/`, `approvals/`) içeriği **birlikte** taşınır; eski kopya silinmeden önce karşılaştırılır |
| Config yanlış siteye kayıt yapıyor (taşınmış site) | `TAŞINMA ONAYI BEKLİYOR` damgası zaten gerçek kaydı engeller; doğru değilse config'i silin |

## 8. Veri düzeni, yedek ve temizlik

Çalışma zamanı verisi **git'e girmez** (`.gitignore`: `.env`, `.auth/`, `data/`, `artifacts/`, `*.sqlite`):

| Yol | İçerik | Not |
|---|---|---|
| `.env` | Sırlar | `chmod 600`; yedeği parola yöneticisinde |
| `.auth/` | OAuth istemcisi ve token | Token 7 günde ölür; istemci dosyası kaybolursa Cloud Console'dan yeniden indirilir |
| `data/ledger.sqlite` (+ `-wal`, `-shm`) | **Otorite**: kilitler, denemeler, kimlikler (e-posta/kullanıcı adı), listelemeler, görülen mail kimlikleri | Yedek: `sqlite3 data/ledger.sqlite ".backup 'yedek.sqlite'"` (çalışma sırasında dosyayı düz kopyalamayın) |
| `data/profiles/<anahtar>/` | Hesap başına kalıcı tarayıcı profili (çerezler, oturum) | Yüzlerce MB olabilir; açık hesabı olmayan/ölü sitelerin profilleri silinebilir. Çözülmüş Cloudflare çerezleri burada saklandığı için açık hesapların profilini silmeyin |
| `data/profiles/.dry-*` | Yarıda ölen dry-run'ın geçici profili | Hiçbir tur çalışmıyorken silinebilir |
| `data/approvals/<ürün>.json` | Yayın onayı (içerik parmak izi + tarih) | Makineye özel |
| `data/pilot/` | Liste dosyaları, site logları, `results.jsonl`, `driver-*.log`, `STOP` | İz kaydı olarak saklayın |
| `data/discovery-<sekme>.json`, `data/verify-drafts/` | Keşif ve toplu doğrulama ilerlemesi | Sıfırlama: `discover --reset` |
| `data/reports/`, `data/eval-*.json`, `data/scan-logs/` | Raporlar, ölçüm sonuçları, tarama günlükleri | |
| `artifacts/<runId>/<anahtar>/` | Her koşunun ekran görüntüleri ve hata sayfaları (parola alanları temizlenir) | Büyür; eski koşular silinebilir |

Yedeklenmesi **gereken**: `.env` (özellikle `MASTER_SECRET`) ve `data/ledger.sqlite`. Geri kalanı yeniden üretilebilir ya da önemsizdir.
Disk: toplu doğrulama geçici profil kullanır (iz bırakmaz); gerçek kayıt koşuları her hesap için kalıcı profil biriktirir.

## 9. Kontrol listeleri

**Bir listeyi başlatmadan önce**
- [ ] Doğru klasördesiniz (`pwd`), `git status` beklediğiniz gibi
- [ ] `npm run cli -- check-gmail` → bağlı ve `SIGNUP_EMAIL` ile eşleşiyor (token ≤ 5 gün)
- [ ] `npm run cli -- status` → bugünkü sayaç ve `DAILY_LIMIT` makul
- [ ] `data/pilot/STOP` yok; liste dosyası hazır; `caffeinate -is` ile sarılı
- [ ] `CAPTCHA_API_KEY` doğru amaçla dolu/boş; gözetimsizse `CAPTCHA_TIMEOUT_MS` kısa
- [ ] Disk alanı yeterli

**Liste bittikten sonra**
- [ ] `results.jsonl` ve başarısız site logları okundu; her sonuç sınıflandırıldı
- [ ] Gerçekte açık ama yanlış kaydedilen hesaplar `adopt-account` ile düzeltildi
- [ ] Öğrenilenler config `notes`'una işlendi (`| <tarih> GERÇEK denemede: …`)
- [ ] Sheet güncellendi (`sheet-annotate`, `sheet-ready-tab`)
- [ ] Değişen config'ler commit edildi (İngilizce, mantıksal parçalar, imzasız — bkz. [DEVELOPER-GUIDE.md §8](DEVELOPER-GUIDE.md#8-commit-inceleme-ve-teslim-süreci))

**Haftalık**
- [ ] Token yenile ([§1](#1-token-yenileme-haftalık))
- [ ] Ledger yedeği
- [ ] Eski `artifacts/` ve ölü site profillerini temizle
