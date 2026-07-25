#!/usr/bin/env bash
set -euo pipefail

DEVICE="${CARTHING_HOST:-172.16.42.2}"
REMOTE="root@${DEVICE}"

cd "$(dirname "$0")/.."
npm run build:device

echo "Installing the preview on ${REMOTE}. The default Nocturne password is: nocturne"

tar -C dist -cf - . | ssh -o StrictHostKeyChecking=accept-new "$REMOTE" '
  set -eu
  mount -o remount,rw /
  rm -rf /opt/nocturne/webapps/ui.carthing-ma-staging
  mkdir -p /opt/nocturne/webapps/ui.carthing-ma-staging
  tar -C /opt/nocturne/webapps/ui.carthing-ma-staging -xf -
  if [ ! -e /opt/nocturne/webapps/ui.nocturne-backup ]; then
    cp -a /opt/nocturne/webapps/ui /opt/nocturne/webapps/ui.nocturne-backup
  fi
  rm -rf /opt/nocturne/webapps/ui
  mv /opt/nocturne/webapps/ui.carthing-ma-staging /opt/nocturne/webapps/ui
  sync
  mount -o remount,ro /
  supervisorctl restart chromium
'

echo "Preview installed. No firmware partitions were changed."
