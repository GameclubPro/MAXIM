#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-/var/www/Chat_bot}"
BASE_URL="${MINIAPP_SCREENSHOT_BASE_URL:-https://maxim.play-team.ru/app/}"
DEVICE="${MINIAPP_SCREENSHOT_DEVICE:-all}"
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.58.2-jammy}"

cd "$ROOT_DIR"

docker run --rm \
  --ipc=host \
  -u "$(id -u):$(id -g)" \
  -v "$ROOT_DIR:/repo" \
  -e HOME=/tmp \
  -e MINIAPP_SCREENSHOT_BASE_URL="$BASE_URL" \
  -e MINIAPP_SCREENSHOT_DEVICE="$DEVICE" \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc '
    set -euo pipefail
    rm -rf /tmp/miniapp-shots
    mkdir -p \
      /tmp/miniapp-shots/apps/api \
      /tmp/miniapp-shots/apps/miniapp \
      /tmp/miniapp-shots/packages/contracts \
      /tmp/miniapp-shots/scripts \
      /repo/artifacts/miniapp-screenshots

    cp /repo/package.json /repo/package-lock.json /tmp/miniapp-shots/
    [ -f /repo/.npmrc ] && cp /repo/.npmrc /tmp/miniapp-shots/.npmrc || true
    cp /repo/apps/api/package.json /tmp/miniapp-shots/apps/api/package.json
    cp /repo/apps/miniapp/package.json /tmp/miniapp-shots/apps/miniapp/package.json
    cp /repo/packages/contracts/package.json /tmp/miniapp-shots/packages/contracts/package.json
    cp /repo/scripts/capture-miniapp-preview.mjs /tmp/miniapp-shots/scripts/capture-miniapp-preview.mjs

    cd /tmp/miniapp-shots
    HUSKY=0 npm ci --ignore-scripts
    node scripts/capture-miniapp-preview.mjs
    install -d /repo/artifacts/miniapp-screenshots
    tar -C /tmp/miniapp-shots/artifacts/miniapp-screenshots -cf - . | tar -C /repo/artifacts/miniapp-screenshots -xf -
  '
