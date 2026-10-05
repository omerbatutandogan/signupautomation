# signupautomation

geo.new için dizin/review sitelerine otomatik kayıt ve e-posta doğrulama.

## Durum

Faz 1 — temel katmanlar yazıldı. Henüz gerçek bir siteye kayıt yapılmıyor.

| Bileşen | Durum |
|---|---|
| Çekirdek sözleşme (`core/types.ts`) | ✅ |
| Hata sınıflandırma (`core/errors.ts`) | ✅ |
| Captcha tespiti (`core/captcha.ts`) | ✅ |
| Şifre türetme / kimlik (`identity/`) | ✅ |
| Mail ayrıştırma (`integrations/mail-parse.ts`) | ✅ |
| Gmail OAuth (`scripts/gmail-auth.ts`) | ✅ (kurulum bekliyor) |
| Site adaptörleri, runner, Sheets, Telegram | ⬜ yazılmadı |

## Kurulum

```bash
npm install
```

Node 22.5+ gerekiyor (TypeScript dosyaları `--experimental-strip-types` ile
doğrudan çalıştırılıyor, ayrı derleme adımı yok).

### 1. `.env` dosyası

```bash
cp .env.example .env
chmod 600 .env
```

`MASTER_SECRET` üret ve `.env`'e yaz:

```bash
openssl rand -hex 32
```

> ⚠️ **`MASTER_SECRET` kaybı telafi edilemez** — tüm site şifreleri bundan
> türetiliyor, hiçbir yerde saklanmıyor. Bir kopyasını 1Password'e koy.

### 2. Gmail erişimi

Tüm siteler **tek bir sabit e-posta** ile kaydoluyor. Kullanılmayan bireysel
bir Gmail hesabı öneriliyor (kurumsal adresi bu trafiğe karıştırma).

1. [Google Cloud Console](https://console.cloud.google.com) → yeni proje
2. **APIs & Services → Library** → "Gmail API" → **Enable**
3. **OAuth consent screen** → External →  **Audience → Test users → + ADD USERS** → kayıt hesabını ekle
   > Production'a geçiş `gmail.readonly` gibi hassas scope'lar için homepage +
   > privacy policy istiyor — bu iç araç için gereksiz yük, bilinçli olarak
   > **Testing modunda** kalındı. Bedeli: refresh token **7 günde ölüyor**.
   > `npm run gmail:auth` her çalıştığında mevcut token'ın yaşını gösterir —
   > haftada bir (ya da uyarı geldiğinde) yeniden çalıştırmak yeterli.
4. **Credentials → Create Credentials → OAuth client ID** → *Desktop app*
5. JSON'u indir → `.auth/gmail-client-secret.json`
6. Yetkilendir:

```bash
npm run gmail:auth
```

Tarayıcı açılır, kayıt hesabıyla giriş yaparsın, token `.auth/` altına yazılır.

> 💡 **Haftalık rutin:** Test kullanıcısı modunda kaldığımız için bu komutu
> haftada bir yeniden çalıştırmak gerekiyor. Otomasyon çalışmıyor gibi
> görünürse önce bunu dene.

### 3. Doğrula

```bash
npm run mail:recent          # son 5 maili listele
npm run mail:recent -- 10 --save   # 10 maili .eml olarak kaydet
```

`--save` ile kaydedilen mailler `test/fixtures/emails/` altına düşer ve
mail ayrıştırma testlerinin gerçek örnek korpusunu oluşturur.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `npm test` | Test paketi (gerçek siteye dokunmaz) |
| `npm run typecheck` | TypeScript kontrolü |
| `npm run gmail:auth` | Gmail OAuth kurulumu (tek seferlik) |
| `npm run mail:recent` | Kutudaki son mailleri listele / `.eml` kaydet |

## Web paneli (`apps/web` + `supabase/`)

Ekibin tarama haritasını, açılan hesapları ve kayıt kuyruğunu gördüğü **salt-okunur**
panel (Next.js + Supabase, yalnızca izin listesindeki Google hesapları girer).
Panel kendi verisini üretmez: bu Mac'teki ledger, tarama dosyaları, config'ler ve
Sheet'in yansımasını gösterir; kaynaklara yazmaz. Üretime alma adımları:
`docs/panel-setup.md`.

| Komut | Ne yapar |
|---|---|
| `npx supabase start` | Yerel veritabanı (Docker) |
| `npm run panel:sync -- --source <canlı dizin> --verify` | Kaynakları panele yansıtır, sayımları doğrular |
| `npm run panel:sync-agent -- install` | Senkronu 2 dakikada bir launchd'ye kurar (`uninstall`, `status`) |
| `npm run db:types` | Şema değişince web tiplerini yeniler |
| `npm run build -w apps/web && npm run start -w apps/web` | Paneli yerelde çalıştırır |
| `npm run e2e -w apps/web` | Uçtan uca testler (yerel Supabase + çalışan panel gerekir) |
| `npx supabase test db` | Veritabanı / RLS testleri (pgTAP) |

## Mimari notları

**Tek e-posta, çoklu site.** Tüm siteler aynı adrese kaydolduğu için
doğrulama maili eşleştirmesi `to:` ile yapılamıyor; bunun yerine
**gönderen domaini + kayıt sonrası zaman penceresi** kullanılıyor
(`isVerificationCandidate()`). Siteler sıralı işlendiği için çakışma
riski düşük.

**Şifreler saklanmıyor.** Her şifre `HMAC-SHA256(MASTER_SECRET, site|version)`
ile türetiliyor. Sheet'e asla yazılmaz. Zorunlu şifre sıfırlamada `version`
bump edilir.

**Captcha otomatik çözülmüyor.** 2captcha vb. servisler kullanılmıyor —
çoğu sitenin ToS'unu ihlal ediyor. Bunun yerine tarayıcı headed çalışıyor,
captcha görülünce Telegram bildirimi gidiyor ve insan devralıyor.
reCAPTCHA v3 / managed Turnstile gibi *passive* captcha'larda insan
çağrılmıyor — yalnızca görünür interaktif challenge escalate ediliyor.

**Yüksek riskli siteler otomasyon dışı.** G2, Capterra, Trustpilot,
Product Hunt ve Gartner mülkleri (GetApp, Software Advice) ToS'larında
otomatik erişimi açıkça yasakladığı için manuel listeye alınıyor.
`runSite` bunları ağ isteği yapmadan önce reddediyor.
