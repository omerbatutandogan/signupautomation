-- YALNIZCA YEREL: `supabase db reset` / `start` uygular, üretime gitmez.
-- Uçtan uca testler e-posta/şifreyle giriyor (Google yerelde denenemiyor).
update public.panel_settings
set value = '["google", "email"]'::jsonb
where key = 'allowed_auth_providers';
