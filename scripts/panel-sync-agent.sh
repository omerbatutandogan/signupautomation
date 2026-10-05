#!/bin/bash
# Panel senkronunu launchd'ye kurar/kaldırır (bu Mac'te, oturum açıkken çalışır).
#
#   scripts/panel-sync-agent.sh install     # 2 dakikada bir + hemen bir tur
#   scripts/panel-sync-agent.sh uninstall
#   scripts/panel-sync-agent.sh status
#
# Önce .panel-sync/sync.env dosyasını oluştur (scripts/panel-sync-run.sh'e bak).
set -euo pipefail

LABEL="com.signupautomation.panel-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

# plist XML'dir: yoldaki & < > karakterleri kaçırılmalı.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

case "${1:-}" in
  install)
    ENV_FILE="$ROOT/.panel-sync/sync.env"
    if [ ! -f "$ENV_FILE" ]; then
      echo "Önce $ENV_FILE dosyasını oluştur (SUPABASE_URL, SUPABASE_SECRET_KEY, PANEL_SYNC_SOURCE)." >&2
      exit 1
    fi
    # Secret key bu dosyada: yalnızca sahibi okuyabilsin.
    chmod 600 "$ENV_FILE"
    # launchd'nin PATH'i çok kısadır; node'un yeri kurulum anında sabitlenir.
    NODE_BIN="$(command -v node || true)"
    if [ -z "$NODE_BIN" ]; then
      echo "node bulunamadı (PATH'te yok) — kurulmadı." >&2
      exit 1
    fi
    NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml "$ROOT/scripts/panel-sync-run.sh")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$NODE_DIR"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml "$ROOT/.panel-sync/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$ROOT/.panel-sync/launchd.log")</string>
</dict>
</plist>
PLIST_EOF
    plutil -lint "$PLIST" > /dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout hemen bitmeyebilir; bootstrap o sırada "Input/output error" verir.
    loaded=0
    for _ in 1 2 3 4 5; do
      if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
        loaded=1
        break
      fi
      sleep 1
    done
    if [ "$loaded" -ne 1 ]; then
      echo "launchd'ye yüklenemedi: launchctl bootstrap $DOMAIN \"$PLIST\"" >&2
      exit 1
    fi
    echo "Kuruldu: $LABEL (2 dakikada bir). Günlük: $ROOT/.panel-sync/sync.log"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Kaldırıldı: $LABEL"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" > /dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|runs =|last exit code =" || true
      tail -n 16 "$ROOT/.panel-sync/sync.log" 2>/dev/null || true
    else
      echo "Kurulu değil: $LABEL"
    fi
    ;;
  *)
    echo "Kullanım: $0 install|uninstall|status" >&2
    exit 2
    ;;
esac
