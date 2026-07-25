#!/bin/sh
set -eu

ARCHIVE="/tmp/carthing-ma-relay.tar"
INSTALL_DIR="/opt/carthing-ma-relay"
SUPERVISOR_CONF="/etc/supervisor.d/carthing-ma-relay.conf"

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

supervisorctl stop carthing-ma-relay >/dev/null 2>&1 || true
mount -o remount,rw /
mounted_rw=1

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xf "$ARCHIVE" -C "$INSTALL_DIR"
chmod 0755 "$INSTALL_DIR/relay_service.py"

cat > "$SUPERVISOR_CONF" <<'EOF'
[program:carthing-ma-relay]
command=/usr/bin/python3 -u /opt/carthing-ma-relay/relay_service.py
directory=/opt/carthing-ma-relay
numprocs=1
autostart=true
autorestart=true
startsecs=1
priority=95
redirect_stderr=true
stdout_logfile=/var/log/carthing-ma-relay.log
stdout_logfile_maxbytes=512KB
stdout_logfile_backups=2
environment=PYTHONPATH="/opt/carthing-ma-relay/vendor"
EOF

sync
mount -o remount,ro /
mounted_rw=0
rm -f "$ARCHIVE"

supervisorctl reread
supervisorctl update
supervisorctl restart carthing-ma-relay
supervisorctl status carthing-ma-relay
