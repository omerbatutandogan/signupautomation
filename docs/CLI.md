# Komut referansı

İki giriş noktası vardır: ana komut satırı (`npm run cli -- …`, kaynak [src/cli.ts](../src/cli.ts)) ve toplu işler için betikler
(`scripts/*.ts`). Bu belge ikisinin de bayraklarını, çıkış kodlarını ve yan etkilerini listeler.
Ne zaman hangisinin kullanılacağı için: [OPERATIONS.md](OPERATIONS.md).

## İçindekiler

1. [Genel kurallar](#1-genel-kurallar)
2. [Ana komut: `npm run cli -- <komut>`](#2-ana-komut)
3. [Betikler](#3-betikler)
4. [Çıkış kodları](#4-çıkış-kodları)
5. [Hazır tarifler](#5-hazır-tarifler)

---

## 1. Genel kurallar

- Her komut `.env` doğrulamasından geçer (`MASTER_SECRET` ≥ 32 karakter, `SIGNUP_EMAIL`). Eksikse tarayıcı açılmadan okunur bir hatayla durur.
- **`--product <ürünId>`** (ya da `--product=<ürünId>`): hangi ürün adına işlem yapılacağını seçer (`src/profile/<ürünId>.json`).
  Verilmezse varsayılan ürün (`geo-new`). Değer vermeden yazılırsa hata verir. `run-one`, `submit`, `signup`, `password`, `unlock`,
  `adopt-account` kabul eder.
- Varsayılan ürün için hesap anahtarı yalın `siteId`'dir; diğer ürünlerde `ürün@site`. Ledger, kilit, kimlik, tarayıcı profili ve şifre bu anahtarla tutulur.
- Gerçek siteye dokunan her komutun **dry-run** karşılığı vardır; dry-run kayıt göndermez ve hiçbir kimlik/günlük sayaç/kalıcı profil izi bırakmaz
  ([ARCHITECTURE.md §8](ARCHITECTURE.md#8-dry-run-anlamı)).
- Günlük sınır (`DAILY_LIMIT`) yalnızca **gerçek** denemeleri sayar; `skipped_*` sonuçlar ve dry-run sayılmaz.

## 2. Ana komut

```bash
npm run cli -- <komut> [argümanlar] [--product <ürünId>]
```

Komutsuz ya da bilinmeyen bir komutla çağrılırsa kullanım metnini basar (bilinmeyen komutta çıkış kodu 1).

### `run-one <siteId>` — tek siteyi uçtan uca işle

Hesap açar: formu doldurur, gerekirse captcha'yı çözer, kayıt sonrası sayfayı tanır, doğrulama mailini Gmail'den okuyup link/kod adımını bitirir.

| Bayrak | Anlamı |
|---|---|
| `--dry-run` | Formu doldurur, **göndermez**; alanların gerçekten dolduğunu, zorunlu boş alan olmadığını, gönder butonunun bulunduğunu denetler. Başarılıysa config'in "doğrulanmadı" damgasını kaldırır |
| `--force` | Önceki *terminal* sonucu (`completed`/`failed`/`manual`) yok sayıp yeniden dener |

`--force` şunları **aşmaz**: yüksek risk (`risk: high`), taşınma onayı damgası, aynı e-postayla başka ürün hesabı çakışması, günlük sınır.

Sonuç satırı: `✅ <anahtar>: completed` · `⏭️ …: skipped_*` · `❌ …: failed|manual|error`, ardından not ve artifact klasörü.
Çıkış kodu: `completed` ve `skipped_*` → 0, diğerleri → 1 (not: `skipped_limit` da 0 döner; betikler çıktıdaki durum metnine bakar — `scripts/run-list.ts` öyle yapar).

### `signup <website>` — config dosyası OLMADAN dene

Keşif → form analizi → bellekte geçici config → `runSite`. Varsayılan **dry-run**.

| Bayrak | Anlamı |
|---|---|
| `--live` | Gerçek kayıt yapar |
| `--save` | Üretilen config'i `src/sites/<id>.json` olarak yazar ("doğrulanmadı" damgalı). Sonuç başarısız olsa bile yazılır |

Durur (kod yazmaz, kayıt denemez): bot duvarı, kayıt sayfası bulunamadı, kullanılamaz form, `risk: high` domain, taşınmış site (gerçek kayıtta —
yeni adresi açıkça vererek yeniden çalıştırın). Çıkış kodu: yalnızca `completed` → 0.

### `run-batch [N]` — Sheet'ten N siteyi sırayla işle

Varsayılan N = 5. Sheet'te `SHEET_TAB` sekmesindeki işlenmeye uygun satırlardan **config'i olanları** alır.

| Bayrak | Anlamı |
|---|---|
| `--dry-run` | Gönderme, selector doğrula |
| `--no-wait` | Siteler arası beklemeyi atla (test için; dry-run'da zaten beklenmez) |
| `--include-unverified` | "Doğrulanmadı" damgalı taslakları da çalıştır (**riskli**: yanlış selector'la gerçek kayıt) |

Taşınma onayı bekleyen siteler hiçbir bayrakla çalışmaz. Siteler arasında `MIN_GAP_MINUTES`–`MAX_GAP_MINUTES` rastgele beklenir; günlük sınır dolunca durur.
**Yalnızca varsayılan ürün için** çalışır (Sheet kolonları ürün bazlı değildir). Başarısız site varsa çıkış kodu 1.
Büyük listeler için tercih edilen yol [`scripts/run-list.ts`](#scriptsrun-listts)'tir (ağ kesintisine dayanıklı, ardışık hatada durur).

### `status` — ledger özeti

Bugünkü gerçek deneme sayısı (`n/DAILY_LIMIT`), son 15 deneme, bugünkü gerçek listeleme sayısı ve son 10 listeleme (dry-run/GERÇEK etiketiyle).
Salt okunur; çıkış kodu 0.

### `list` — tanımlı site config'leri

`src/sites/` altındaki her config için `id`, risk (`⛔ high` işaretli) ve doğrulama kipi (`link`/`code`/`none`). Geçersiz bir config satırında
zod hatasının ilk satırı görünür — config yazarken doğrulama yöntemi olarak da kullanılır.

### `products` — ürün profillerini doğrula

`src/profile/*.json` dosyalarını zod ile doğrular; her ürün için ad ve kayıt e-postası (ayrı `signupEmail` yoksa "ortak"). Hatalı profil varsa ya da hiç profil
yoksa çıkış kodu 1. Yeni ürün bilgisi geldiğinde **200 siteye yayılmadan önce** burada eksik/hatalı alan görünür.

### `submit <siteId>` — ürünü listeleme formuna gir

Açık hesapla giriş yapar, `src/submissions/<siteId>.json` ile ürünü sitenin "ürün ekle" formuna girer. Varsayılan **dry-run**: doldurur, göndermez, ağ düzeyinde yazan istekleri engeller.
Ayrıntılı model: [LISTINGS.md](LISTINGS.md).

| Bayrak | Anlamı |
|---|---|
| `--live` | **Gerçekten gönderir (herkese açık yayın).** Ürün profilinin ve logo dosyalarının onaylı olması şart (`approve-profile`) |
| `--force` | Önceden tamamlanmış ya da sonucu doğrulanamamış (`unconfirmed`) gönderimi yeniden dener. Günlük listeleme sınırını **aşmaz** |

Çıkış kodu: yalnızca `completed` ve `skipped_done` → 0. Onaysız, hesapsız, kilitli, doğrulanamayan (`unconfirmed`) hepsi 1 (betik zincirleri yanlışlıkla "başarı" saymasın).

### `approve-profile <ürün>` — yayın onayı (insan adımı)

Yayınlanacak **tüm** bilgiyi (ad, site, slogan, üç açıklama, kategori, iletişim, fiyat, sosyal, logo dosyalarının SHA-256'sı) ekrana basar ve
ekrandaki 8 haneli kodu yazmanızı ister. Etkileşimli terminal (TTY) şarttır; boru/betik içinden çalışmaz, böylece `approve-profile && submit --live`
zinciri kararı insan yerine veremez. Onay `data/approvals/<ürün>.json`'a yazılır; profil ya da logo bir bayt değişirse geçersiz olur.
Ekranda ayrıca **ürünün kendi sitesinin** başlığı, meta açıklaması ve ana başlığı (`GET <profil.website>`) profille **yan yana** gösterilir ve iki metnin ortak sözcük oranı hesaplanır.
Oran %30'un altındaysa (profil sitenin kendi anlatımından farklı görünüyor) uyarı çıkar ve onay kodu **yetmez**: kodun yerine tam olarak `FARKLI ONAYLIYORUM` yazılmalıdır.
Site okunamıyorsa engellenmez; ekranda "elle karşılaştırın" uyarısı çıkar.
Çıkış kodu: onaylandıysa 0.

> Bu komutu otomasyonun/yardımcı bir aracın çalıştırması beklenmez: yayın kararı sizindir.

### `adopt-account <siteId> --note "<kanıt>"` — yanlış kaydedilmiş hesabı düzelt

Hesap **gerçekte açıktır** ama koşu bunu yanlış sınıflandırmıştır (ör. oturum açık kaldı ve doğrulama maili yoktu → `failed` yazıldı; terminal olduğu için sistem bir daha denemez).
Komut, o hesabı "tamamlandı" yapar.

- `--note` **zorunlu** ve en az 10 karakter: hesabın gerçekten açık olduğunu neyle doğruladığınız (ör. "türetilen şifreyle girişle doğrulandı"). Nota `elle doğrulandı:` öneki eklenir.
- Kimlik kaydı (`credentials`) yoksa reddeder (`❌ … hesap sistemde açılmamış`; çıkış 1).
- Zaten tamamlanmışsa bir şey yapmaz (`ℹ️`).

### `unlock <siteId>` — takılı kilidi temizle

Çalıştırma kilitleri süre dolunca (`LOCK_TTL_MS`, varsayılan 45 dk) kendiliğinden temizlenir (ledger her açılışta eskimiş kilitleri siler). Süre dolmadan
takılı kalmış bir kilidi (ör. süreç `kill -9` ile öldürüldü) bu komut siler. Çıkış kodu 0; kilit yoksa "kilit yok" der.

### `password <siteId>` — türetilmiş şifreyi yazdır

Şifre depolanmaz; `HMAC-SHA256(MASTER_SECRET, hesap anahtarı)` ve sitenin `passwordPolicy`'si ile **o anda** üretilir ve yalnızca **stdout'a** yazılır (log'a girmez).
Elle giriş yapmanız gerektiğinde kullanın. Ekranınız paylaşılıyorsa ya da çıktı bir yere kaydediliyorsa çalıştırmayın.

### `check-gmail` — Gmail bağlantısını doğrula

Token ile Gmail'e bağlanır ve bağlanılan adresi yazar. Adres `.env`'deki `SIGNUP_EMAIL` ile **farklıysa** uyarır ve 1 döner (yanlış hesaba yetki verilmiş demektir).
Token süresi dolmuşsa `npm run gmail:auth`.

### `sheet` — Sheet bağlantısı ve kolonlar

Sheet'i okur, işlenmeye uygun satır sayısını ve ilk 10 satırı yazar; takip kolonlarından eksik olanları listeler.

| Bayrak | Anlamı |
|---|---|
| `--add-columns` | Eksik takip kolonlarını (Durum, E-posta, Kullanıcı Adı, Risk, …) Sheet'e ekler |

Bağlanamazsa (`SHEET_ID` boş, token'da Sheets yetkisi yok) 1 döner.

## 3. Betikler

`npx tsx scripts/<ad>.ts [bayraklar]` ya da tanımlı npm kısayolu. Betikler **kendi başlarına** `.env` ister.

### `scripts/run-list.ts`

Verilen sitelerde sırayla gerçek `run-one` çalıştırır; siteler arasında `MIN_GAP_MINUTES`–`MAX_GAP_MINUTES` rastgele bekler.

```bash
npx tsx scripts/run-list.ts --file data/pilot/liste-2026-10-12.txt --max-failures 12
npx tsx scripts/run-list.ts siteA siteB siteC
```

| Bayrak / girdi | Anlamı |
|---|---|
| `--file <dosya>` | Satır başına bir site id; boş satırlar ve `#` ile başlayanlar yok sayılır |
| `--max-failures N` | **Ardışık** N başarısızlıkta durur (varsayılan 6). `skipped_*` ne sayılır ne seriyi böler |
| `data/pilot/STOP` dosyası | Varsa sıradaki siteden **önce** (ve bekleme sırasında) durur. `touch data/pilot/STOP` |

Davranışlar:
- Her site çıktısı `data/pilot/<site>.log`; her sonuç `data/pilot/results.jsonl`'a satır olarak eklenir (`id`, `status`, `outcome`, zamanlar).
- Çalışmadan önce internet var mı bakar; yoksa 30 dakikaya kadar bekler, gelmezse durur.
- `ERR_INTERNET_DISCONNECTED` / `ERR_NETWORK_CHANGED` ile düşen site **başarısız sayılmaz**, listenin sonunda yeniden denenir (en çok 2 kez).
- Günlük sınır, kilitler ve risk kapıları `run-one`'ın içinde uygulanır (betik bunları ayrıca kontrol etmez).
- Uzun koşular için `caffeinate -is` ile sarın (Mac uyumasın).

### `scripts/discover.ts` (`npm run discover`)

Sheet'teki siteleri tarar: kayıt sayfasını bulur, formu analiz eder, **taslak config** üretir (`src/sites/<id>.json`, "doğrulanmadı" damgalı).
İlerleme sekme başına `data/discovery-<SHEET_TAB>.json`'da tutulur; kesilirse kalan yerden sürer.

| Bayrak | Anlamı |
|---|---|
| `--limit N` | Bu turda en çok N yeni site |
| `--headed` | Görünür tarayıcı (gözlemlemek için) |
| `--site <id>` | Tek siteyi yeniden keşfet |
| `--retry-failed` | Yalnızca reddedilenleri yeniden dene |
| `--retry-errors` | Yalnızca hataları (açılamayan tarayıcı, zaman aşımı) yeniden dene |
| `--reset` | İlerlemeyi sıfırla |

Doğrulanmış (`generated`) ve `high_risk` sonuçlar **asla** yeniden taranmaz (elle düzeltmeleri ezmemek ve ToS kararını korumak için). Tek sitede
takılma bekçisi vardır (site başına 4 dk üst süre); iş bitince süreç açıkça çıkar.

### `scripts/verify-drafts.ts` (`npm run verify-drafts`)

Doğrulanmamış taslakları toplu **dry-run** ile doğrular; yalnızca `run-one <site> --dry-run` çalıştırır (kayıt göndermez).

```bash
npx tsx scripts/verify-drafts.ts [--limit N] [--only a,b,c] [--timeout-min 4] [--retry-failed] [--headed] [--dry-list]
```

Başarılı dry-run damgayı kaldırır; başarısız olanın nedeni ledger'a yazılır. Her site **ayrı süreçte** çalışır ve takılırsa süreç grubuyla SIGKILL'lenir.
İlerleme `data/verify-drafts/progress.json`; durdurmak için `touch data/verify-drafts/STOP` (mevcut site bitince çıkar). `--dry-list` yalnızca neyin çalışacağını listeler.

### `scripts/sheet-annotate.ts`

Sheet'in **bir sekmesine** üç kolon yazar: *Otomasyon Durumu*, *Otomasyon Sorunu*, *Otomasyon Notu* (yoksa başlık satırının sağına ekler; mevcut kolonlara dokunmaz).

```bash
SHEET_TAB="SaaS" npx tsx scripts/sheet-annotate.ts [--dry-run]    # tek sekme
npx tsx scripts/sheet-annotate.ts --all [--dry-run]              # tüm kaynak sekmeler (özet sekmesi hariç), sekmeler arası 3 sn bekler
```

Kaynaklar: config'ler, `verify-drafts` sonucu, tarama dosyası ve ledger (açık hesaplar). `--dry-run` hiçbir şey yazmaz. Sınıflar: [OPERATIONS.md §6](OPERATIONS.md#6-sheet-güncelleme).

### `scripts/sheet-ready-tab.ts`

"Hazır Siteler" adlı **tek bir özet sekmesini** baştan yazar: kayda hazır her site bir satır (tekilleştirilmiş), geçtiği kaynak sekmeler yanında. Kaynak sekmelere dokunmaz. `--dry-run` destekler.
"Hazır" = doğrulanmış config, yüksek riskli ya da taşınma onayı bekleyen değil, açık hesabı yok, son gerçek denemesi kesin hatayla bitmemiş.

### `scripts/inspect-form.ts` (`npm run inspect -- <url|siteId>`)

Bir kayıt sayfasındaki form alanlarını listeler (etiket, `name`, `id`, `placeholder`, görünürlük, önerilen alan). Yeni config yazarken ilk adım: tahminle selector yazmak yerine gerçek DOM'u görün.
`siteId` verilirse config'in `signupUrl`'ünü açar.

### `scripts/eval-signup.ts`

Sabit bir site setinde, **config yazılmadan**, "elle dokunmadan başarı oranı"nı ölçer (keşif → analiz → üretim → dry-run → denetim). Site configi ya da ledger kaydı
yazmaz, göndermez; yalnızca sonuç dosyalarını `data/` altına yazar. Site seti `data/eval-set.json` (`{ "sites": [{ "siteId", "website", "tab" }] }`) dosyasından okunur.

```bash
npx tsx scripts/eval-signup.ts --baseline                              # ölç, data/eval-baseline.json'a kaydet
npx tsx scripts/eval-signup.ts --compare data/eval-baseline.json       # ölç, başlangıçla kıyasla, data/eval-final.json'a yaz
npx tsx scripts/eval-signup.ts --compare data/eval-baseline.json --out data/eval-yeni.json
```

Keşif/analiz sezgisini değiştirdiğinizde gerileme olup olmadığını görmek için kullanılır.

### `scripts/gmail-auth.ts` (`npm run gmail:auth`)

Tek seferlik / haftalık OAuth: Gmail okuma + Sheets yazma izni. Tarayıcı açar, yerel bir geri çağrı sunucusu (port 5899) ile yetki kodunu alır ve `GOOGLE_OAUTH_TOKEN_FILE`'a yazar.
Çalıştığında mevcut token'ın yaşını gösterir. Consent ekranı "Testing" modunda olduğu için **refresh token 7 günde ölür**; ayrıntı: [OPERATIONS.md §1](OPERATIONS.md#1-token-yenileme-haftalık).

### `scripts/fetch-recent.ts` (`npm run mail:recent`)

Kayıt kutusundaki son mailleri listeler: `npm run mail:recent -- 10` (son 10), `-- 10 --save` ile ayrıca `test/fixtures/emails/` altına `.eml` olarak kaydeder.
Gmail kurulumunun çalıştığını kanıtlar ve doğrulama maili korpusu toplar.

### `scripts/verify-eml-corpus.ts` (`npm run mail:verify-corpus`)

`test/fixtures/emails/` altındaki gerçek `.eml` korpusunu mail ayrıştırıcıya karşı denetler (hızlı sağlık kontrolü).

### `scripts/discover-queue.ts`

Komut değil; keşif kuyruğunun saf kararları (`RETRYABLE`, `shouldEnqueue`, `withSiteTimeout`, `guardSite`). `discover.ts` içe aktarır, testleri `test/site-timeout.test.ts` ve `test/retry-filter.test.ts`.

## 4. Çıkış kodları

| Komut | 0 | 1 |
|---|---|---|
| `run-one` | `completed`, `skipped_*` | `failed`, `manual`, `error`, … |
| `signup` | `completed` | diğer her şey |
| `run-batch` | hiç başarısız site yok | en az bir başarısız site |
| `submit` | `completed`, `skipped_done` | diğer her şey (`unconfirmed` ve `skipped_*` dahil) |
| `approve-profile` | onaylandı | onaylanmadı / etkileşimli terminal yok |
| `products` | tüm profiller geçerli | geçersiz profil ya da profil yok |
| `adopt-account` | benimsendi / zaten tamam | `--note` eksik, kimlik kaydı yok |
| `check-gmail` | bağlı ve `SIGNUP_EMAIL` ile eşleşiyor | hata ya da farklı adres |
| `sheet` | bağlı | bağlanamadı |
| `status`, `list`, `unlock`, `password` | her zaman | — |
| bilinmeyen komut | — | kullanım metni + 1 |

## 5. Hazır tarifler

**Yeni bir siteyi güvenle dene**
```bash
npm run inspect -- https://site.example/signup          # alanları gör
npm run cli -- run-one site --dry-run                   # doldur, gönderme
npm run cli -- run-one site                             # TEK gerçek koşu; sonucu oku
```

**Bir listeyi çalıştır ve gerekirse durdur**
```bash
caffeinate -is npx tsx scripts/run-list.ts --file liste.txt --max-failures 12 > data/pilot/driver.log 2>&1 &
touch data/pilot/STOP        # sıradaki siteden önce durur; devam için dosyayı sil
```

**Hesap açık ama sistem "başarısız" yazdı**
```bash
npm run cli -- password site                             # türetilmiş şifre (elle giriş denemek için)
npm run cli -- adopt-account site --note "türetilen şifreyle girişle doğrulandı"
```

**Listeleme: önce kuru, sonra (onayla) gerçek**
```bash
npm run cli -- submit site                               # dry-run (varsayılan)
npm run cli -- approve-profile geo-new                   # insan adımı, TTY şart
npm run cli -- submit site --live                        # herkese açık yayın
```

**Sheet'i güncelle**
```bash
SHEET_TAB="SaaS" npx tsx scripts/sheet-annotate.ts --dry-run   # ne yazacağını gör
SHEET_TAB="SaaS" npx tsx scripts/sheet-annotate.ts
npx tsx scripts/sheet-ready-tab.ts
```
