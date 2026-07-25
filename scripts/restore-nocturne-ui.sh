#!/usr/bin/env bash
set -euo pipefail

DEVICE="${CARTHING_HOST:-172.16.42.2}"
REMOTE="root@${DEVICE}"

echo "Restoring the Nocturne UI on ${REMOTE}. The default Nocturne password is: nocturne"

ssh -o StrictHostKeyChecking=accept-new "$REMOTE" '
  set -eu
  if [ ! -d /opt/nocturne/webapps/ui.nocturne-backup ]; then
    echo "No Nocturne UI backup exists; refusing to change the device." >&2
    exit 1
  fi
  mount -o remount,rw /
  rm -rf /opt/nocturne/webapps/ui
  cp -a /opt/nocturne/webapps/ui.nocturne-backup /opt/nocturne/webapps/ui
  sync
  mount -o remount,ro /
  supervisorctl restart chromium
'

echo "Nocturne UI restored."
