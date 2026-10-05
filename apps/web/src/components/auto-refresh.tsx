'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sunucu bileşenlerini belirli aralıkla tazeler (router.refresh): ekran
 * boşalmaz, yeni veri gelene kadar eski görüntü kalır. Sekme arka plandayken
 * istek atmaz; öne gelince hemen tazeler. Tazeleme üyelik kontrolünü de
 * yeniden çalıştırır (izni kaldırılan kişi açık sekmede kalamaz).
 */
const MIN_GAP_MS = 15_000;

export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();

  useEffect(() => {
    let last = Date.now();
    const refreshIfVisible = () => {
      // Sekmeler arasında hızlı geçiş her seferinde istek atmasın.
      if (document.visibilityState !== 'visible' || Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      router.refresh();
    };
    const timer = setInterval(refreshIfVisible, seconds * 1000);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [router, seconds]);

  return null;
}
