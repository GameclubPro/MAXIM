#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-/var/www/Chat_bot}"
BASE_URL="${MINIAPP_SCREENSHOT_BASE_URL:-https://maxim.play-team.ru/app/}"
DEVICE="${MINIAPP_SCREENSHOT_DEVICE:-all}"
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.58.2-jammy}"

cd "$ROOT_DIR"

docker run --rm \
  -u "$(id -u):$(id -g)" \
  -v "$ROOT_DIR:/work" \
  -w /work \
  -e HOME=/tmp \
  -e MINIAPP_SCREENSHOT_BASE_URL="$BASE_URL" \
  -e MINIAPP_SCREENSHOT_DEVICE="$DEVICE" \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc "HUSKY=0 npm ci --ignore-scripts && node scripts/capture-miniapp-preview.mjs"
