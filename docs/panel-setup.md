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
   - **Secret key** (`sb_secret_…`) → bana VERME, şimdilik gerekmiyor (işçi aşamasında
     yalnızca Mac'teki `.env`'e girecek; Vercel'e asla girmeyecek).
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

## Bana gerekecekler (özet)

- İki Supabase projesinin **Project URL** + **Publishable key**'i
- Panele girecek kişilerin Google e-postaları ve kimin admin olacağı
- `npx supabase login` ve `npx vercel login` yapıldığına dair haber
