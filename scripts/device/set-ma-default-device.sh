#!/bin/sh
set -eu

if [ -f /etc/nocturne/ui/index.html ]; then
  UI_DIR="/etc/nocturne/ui"
elif [ -f /opt/nocturne/webapps/ui/index.html ]; then
  UI_DIR="/opt/nocturne/webapps/ui"
else
  echo "Could not locate the installed Nocturne UI." >&2
  exit 1
fi

if [ ! -d "$UI_DIR/music-assistant" ]; then
  echo "Music Assistant side-by-side app is not installed at $UI_DIR/music-assistant." >&2
  exit 1
fi

mounted_rw=0
cleanup() {
  if [ "$mounted_rw" -eq 1 ]; then
    sync
    mount -o remount,ro / || true
  fi
}
trap cleanup EXIT INT TERM

mount -o remount,rw /
mounted_rw=1
printf '{"defaultToMusicAssistant":true}\n' > "$UI_DIR/music-assistant-default.json"
chmod 644 "$UI_DIR/music-assistant-default.json"
sync
mount -o remount,ro /
mounted_rw=0

supervisorctl stop chromium >/dev/null 2>&1 || true
killall chrome >/dev/null 2>&1 || true
rm -rf /var/lib/chrome_storage/Default/Cache /var/lib/chrome_storage/Default/GPUCache /var/lib/chrome_storage/Default/Session\ Storage /var/lib/chrome_storage/ShaderCache/GPUCache 2>/dev/null || true
supervisorctl start chromium

echo "Music Assistant is now the default Car Thing UI."
