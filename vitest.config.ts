import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Yerel .env'de GERÇEK bir 2captcha anahtarı var. Hiçbir test, bir import yolu
    // değişse bile, ücretli çözücüye ulaşamasın (dotenv var olan değişkeni ezmez).
    env: { CAPTCHA_API_KEY: '' },
  },
});
