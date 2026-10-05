#!/bin/bash
# Panel senkronunun tek turu — launchd bunu 2 dakikada bir çağırır.
#
# Ayarlar .panel-sync/sync.env dosyasından gelir (git'e girmez, chmod 600).
# Dosya kabuk olarak okunur: boşluk içeren değeri TIRNAK içine al.
#   SUPABASE_URL="https://<ref>.supabase.co"
#   SUPABASE_SECRET_KEY="sb_secret_…"                # yalnızca bu Mac'te durur
#   PANEL_SYNC_SOURCE="/Users/…/signup automation/signupautomation"   # canlı proje dizini
#
# Sheet en çok saatte bir okunur; değişmeyen tablo veritabanından çekilmez.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$ROOT/.panel-sync"
ENV_FILE="$STATE_DIR/sync.env"
LOG="$STATE_DIR/sync.log"
LOCK="$STATE_DIR/lock"
TIMEOUT_SECONDS=600

mkdir -p "$STATE_DIR"

# Günlük sınırsız büyümesin: 1 MB'ı geçince son 2000 satır kalır.
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 1048576 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# Bundan sonraki her şey (ayar dosyasındaki hata dahil) günlüğe yazılır.
exec >> "$LOG" 2>&1
echo "── $(date '+%F %T')"

if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE yok — senkron çalışmadı"
  exit 78
fi
# Secret key bu dosyada: yalnızca sahibi okuyabilsin (elle oluşturulduysa da).
chmod 600 "$ENV_FILE"

# Aynı anda tek ZAMANLANMIŞ tur. Elle çalıştırılan `npm run panel:sync` bu betikten
# geçmez, kilidi görmez; iki tur çakışırsa yazımlar eşgüçlüdür (upsert) ama durum
# dosyasını son biten yazar. Kilit, zaman aşımından uzun süredir duruyorsa çökmüş
# bir turdan kalmıştır.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +$((TIMEOUT_SECONDS / 60 + 5)) 2>/dev/null)" ]; then
    echo "bayat kilit kaldırıldı"
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || { echo "kilit alınamadı — tur atlandı"; exit 0; }
  else
    echo "başka bir tur çalışıyor — atlandı"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

set -a
# shellcheck disable=SC1090
. "$ENV_FILE" || { echo "$ENV_FILE okunamadı (boşluklu değerler tırnak içinde mi?)"; exit 78; }
set +a

cd "$ROOT" || exit 1
# Tek süreç (node --import tsx) + sert zaman aşımı: uyku/uyanma sonrası ölü bir
# bağlantıda asılı kalan tur launchd'nin sonraki turlarını da engellerdi.
perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$TIMEOUT_SECONDS" \
  node --import tsx scripts/sync-panel.ts \
  --source "${PANEL_SYNC_SOURCE:-$ROOT}" \
  --sheet-max-age 60 \
  --backoff \
  --state "$STATE_DIR/state.json"
code=$?
[ "$code" -eq 142 ] && echo "zaman aşımı (${TIMEOUT_SECONDS}s) — tur sonlandırıldı"
exit "$code"
