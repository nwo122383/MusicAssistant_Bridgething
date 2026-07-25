#!/bin/sh
set -eu

supervisorctl stop carthing-ma-relay >/dev/null 2>&1 || true
mount -o remount,rw /
trap 'sync; mount -o remount,ro / || true' EXIT INT TERM
rm -f /etc/supervisor.d/carthing-ma-relay.conf
rm -rf /opt/carthing-ma-relay
sync
mount -o remount,ro /
trap - EXIT INT TERM
supervisorctl reread
supervisorctl update
echo "Car Thing MA Bluetooth relay removed."
