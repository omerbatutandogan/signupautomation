# Panel kurulumu — hesaplar ve ayarlar

Bu adımları yalnızca bir kez yapacaksın. Kod tarafı hazır: yerelde giriş, izin
listesi, erişim kontrolü ve testler çalışıyor. Bu rehber üretim ortamını açmak için.

Sıra önemli: **1 → 2 → 3 → 4**. Her adımın sonunda bana vermen gereken bilgi
"→ Bana ver" diye işaretli.

---

## 1. Supabase (≈10 dk)

1. https://supabase.com → Sign up (GitHub ya da Google ile).
2. İki proje oluştur (New project):
   - `signup-panel` (üretim)
   - `signup-panel-staging` (deneme)
   - Region: **Central EU (Frankfurt)**
   - Database password: güçlü bir şifre üret, **1Password'e kaydet**.
3. Her proje için: **Project Settings → API Keys** sayfası.
   - **Publishable key** (`sb_publishable_…`) → Bana ver.
   - **Secret key** (`sb_secret_…`) → bana VERME. 6. adımda kendin yalnızca bu
     Mac'teki bir dosyaya yazacaksın; Vercel'e asla girmeyecek.
4. Proje adresi: Project Settings → General → **Project URL**
   (`https://<ref>.supabase.co`) → Bana ver.
5. Prompt'a yaz: `! npx supabase login` (tarayıcıda onay). Böylece veritabanı
   tablolarını (migration) ben yükleyebilirim.

## 2. Google Cloud — giriş için OAuth istemcisi (≈10 dk)

Gmail için kullandığımız **aynı** Google Cloud projesinde:

1. **APIs & Services → OAuth consent screen → Audience → Test users**:
   panele girecek herkesin Google hesabını ekle (sen, Emre).
   Uygulama "Testing" modunda olduğu için yalnızca bu listedekiler giriş yapabilir.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `panel-login`
   - **Authorized redirect URIs** (üçü de):
     - `https://<üretim-ref>.supabase.co/auth/v1/callback`
     - `https://<staging-ref>.supabase.co/auth/v1/callback`
     - `http://127.0.0.1:54321/auth/v1/callback`
3. Oluşan **Client ID** ve **Client secret**'ı bir sonraki adımda Supabase'e
   yapıştıracaksın (bana vermene gerek yok).

> Bu istemci yalnızca temel kapsamları (ad, e-posta) ister. Gmail okuma izni
> ayrı bir istemciyle, Aşama 4'te gelecek.

## 3. Supabase panel ayarları (her iki proje için, ≈5 dk)

1. **Authentication → Sign In / Providers → Google**: Enable, adım 2'deki
   Client ID ve Client secret'ı yapıştır, kaydet.
2. Aynı sayfada **Email** sağlayıcısında "Allow new users to sign up"ı **kapat**
   (panel yalnızca Google ile girilir).
3. **Authentication → URL Configuration**:
   - Site URL: panelin adresi (adım 4'ten sonra belli olacak; şimdilik
     `http://localhost:3000` bırakılabilir)
   - Redirect URLs: `http://localhost:3000/auth/callback` ve adım 4'teki
     `https://<panel-adresi>/auth/callback`
4. **Authentication → Hooks → Before User Created → Postgres function →
   `public.hook_before_user_created`** — migration'ları yükledikten SONRA
   (ben haber vereceğim). Bu açılmazsa izin listesi çalışmaz; yerel testte
   tam bunu yakaladık.

## 4. Vercel (≈5 dk)

1. https://vercel.com → Sign up (Hobby plan).
2. Prompt'a yaz: `! npx vercel login`.
3. Projeyi (kök dizin `apps/web`), ortam değişkenlerini ve ilk yayını ben
   yapacağım. Vercel'e yalnızca şu iki değer girecek:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

## 5. İlk girişte birlikte doğrulayacaklarımız

- Davetli hesapla Google girişi → dashboard açılır, e-postan sol altta görünür.
- **Davetli OLMAYAN** bir Google hesabıyla giriş → "This Google account is not
  invited" mesajı (kancanın üretimde gerçekten açık olduğunu ve Google'ın
  ret yolunu doğrular; yerelde yalnızca e-posta yolu test edilebildi).
- Supabase → Authentication → Users: davetsiz hesap için satır OLMAMALI.

## 6. Veri senkronu (üretim veritabanı açıldıktan sonra, ≈5 dk)

Panel kendi verisini üretmez: bu Mac'teki ledger, tarama dosyaları, config'ler
ve Sheet'in **yansımasını** gösterir. Yansıtan betik kaynaklara asla yazmaz.

1. Supabase → Project Settings → API Keys → **Secret key**'i kopyala ve
   **yalnızca bu Mac'te** şu dosyaya yaz (git'e girmez):

   ```
   # <repo>/.panel-sync/sync.env
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_…
   PANEL_SYNC_SOURCE="/Users/omer/signup automation/signupautomation"
   ```

2. İlk tam senkron ve doğrulama:

   ```
   set -a; . .panel-sync/sync.env; set +a
   npm run panel:sync -- --source "$PANEL_SYNC_SOURCE" --full --verify
   ```

   Son satır `✅ Doğrulama: veritabanı kaynakla aynı.` olmalı.

3. Zamanlanmış senkron (2 dakikada bir, oturum açıkken):

   ```
   npm run panel:sync-agent -- install     # kaldırmak için: uninstall, durum: status
   ```

   Günlük: `.panel-sync/sync.log`. Mac uyursa senkron durur; panel her sayfanın
   sağ üstünde verinin yaşını gösterir ve 10 dakikayı geçince "stale" der.
   Senkron çalışıp hata veriyorsa rozet "Sync is failing" der ve hatayı gösterir.

Notlar:

- Veritabanı kaynakların yansımasıdır: Sheet'ten silinen satır ya da silinen
  config dosyası veritabanından da silinir. Bir tablonun TÜMÜNÜ ya da beşte
  birinden fazlasını (ve 10 satırdan çoğunu) silmeyi gerektiren fark reddedilir —
  yanlış `--source`, boş bir klasör ya da başka bir Sheet yansımayı silmesin diye.
  Bilerek yapılan büyük temizlikte: `--allow-mass-delete`.
- Olağan turun maliyeti bir okuma + bir kalp atışıdır: kaynağı değişmeyen tablo
  veritabanından çekilmez (yerel özet önbelleği, `.panel-sync/state.json`).
  Veritabanında elle yapılan bir değişiklik en geç 6 saat sonraki tam senkronda
  ya da `--full` ile düzelir.
- `discover --reset` bir sekmenin tarama dosyasını küçültürse panel o sekmeyi
  dosyanın gerçek haline getirir (silmeler dahil): koruma yalnızca ledger, config
  ve Sheet tablolarında devrededir. Hesaplar ve denemeler hiçbir zaman silinmez.
- Senkron üst üste başarısız olursa zamanlanmış turlar seyrekleşir (4, 8, 16, 32,
  en çok 60 dakika) ve tek bir başarı sayacı sıfırlar: kalıcı bir hata her
  2 dakikada tüm tabloları yeniden çektirip ücretsiz Supabase'in çıkış kotasını
  bitirmesin. Panel bu sürede "Sync is failing" der. Elle `npm run panel:sync`
  çalıştırmak her zaman hemen dener.
- Sheet en çok saatte bir okunur. Google token'ı (Testing modu) 7 günde bir
  ölür; o zaman rozet "with a warning" der ve site listesi yenilenmez, geri
  kalan veri akmaya devam eder. Çözüm: `npm run gmail:auth`.
- Şema değişince tipleri yenile: `npm run db:types` (yerel Supabase açıkken).

## Not: gizlilik sayfasındaki iletişim adresi

Herkese açık `/privacy` sayfasında şirket adı ya da e-posta adresi YOK (iç araç;
kimsenin adresini onaysız yayınlamıyoruz). Google'a uygulamayı doğrulatırken
(Aşama 5) gerçek bir iletişim adresi ve işletici adı gerekecek; o zaman sen
söyle, sayfaya eklerim.

## Bana gerekecekler (özet)

- İki Supabase projesinin **Project URL** + **Publishable key**'i
- Panele girecek kişilerin Google e-postaları ve kimin admin olacağı
- `npx supabase login` ve `npx vercel login` yapıldığına dair haber
