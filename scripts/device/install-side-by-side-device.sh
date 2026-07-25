#!/bin/sh
set -eu

ARCHIVE="/tmp/carthing-ma-side-by-side.tar"
STATE_DIR="/var/lib/carthing-ma-side-by-side"
MARKER="carthing-ma-launcher-script"

if [ -f /etc/nocturne/ui/index.html ]; then
  UI_DIR="/etc/nocturne/ui"
elif [ -f /opt/nocturne/webapps/ui/index.html ]; then
  UI_DIR="/opt/nocturne/webapps/ui"
else
  echo "Could not locate the installed Nocturne UI." >&2
  exit 1
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "Missing upload: $ARCHIVE" >&2
  exit 1
fi

mounted_rw=0
cleanup() {
  rm -f "$ARCHIVE"
  if [ "$mounted_rw" -eq 1 ]; then
    sync
    mount -o remount,ro / || true
  fi
}
trap cleanup EXIT INT TERM

mount -o remount,rw /
mounted_rw=1
mkdir -p "$STATE_DIR"

# Refresh the backup when the current index is an unmodified Nocturne index.
# This keeps restoration safe after a Nocturne update.
if ! grep -q "$MARKER" "$UI_DIR/index.html"; then
  cp -p "$UI_DIR/index.html" "$STATE_DIR/nocturne-index.html"
fi

rm -rf "$UI_DIR/music-assistant"
mkdir -p "$UI_DIR/music-assistant"
tar -xf "$ARCHIVE" -C "$UI_DIR/music-assistant"
cp "$UI_DIR/music-assistant/nocturne-launcher.js" "$UI_DIR/music-assistant-launcher.js"
STAMP="$(date +%s)"

if ! grep -q "$MARKER" "$UI_DIR/index.html"; then
  sed -i "s#</body>#<script id=\"carthing-ma-launcher-script\" src=\"/music-assistant-launcher.js?v=$STAMP\"></script></body>#" "$UI_DIR/index.html"
else
  sed -i "s#src=\"/music-assistant-launcher.js[^\"]*\"#src=\"/music-assistant-launcher.js?v=$STAMP\"#" "$UI_DIR/index.html"
fi

sync
mount -o remount,ro /
mounted_rw=0
rm -f "$ARCHIVE"

supervisorctl stop chromium >/dev/null 2>&1 || true
killall chrome >/dev/null 2>&1 || true
rm -rf /var/lib/chrome_storage/Default/Cache /var/lib/chrome_storage/Default/GPUCache /var/lib/chrome_storage/Default/Session\ Storage /var/lib/chrome_storage/ShaderCache/GPUCache 2>/dev/null || true
supervisorctl start chromium

echo "Side-by-side Music Assistant installed under $UI_DIR/music-assistant"
