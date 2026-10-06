#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [[ $# != 2 || ! "$1" =~ ^[0-9a-f]{40}$ || ! "$2" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo 'Exact source and image identity required.' >&2
  exit 2
fi
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# Helpers consume this array through Bash namerefs.
# shellcheck disable=SC2034
COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml)
target_has_media=0
target_ocr_version=''
target_has_ocr=0
maxim_topology_prepare_commercial_ocr_target "$1" COMPOSE_FILES \
  target_has_media target_ocr_version target_has_ocr
maxim_topology_prepare_photo_native_target "$1" COMPOSE_FILES
[[ "$target_has_media" == 1 && "$target_has_ocr" == 1 && "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" == 1 ]]
maxim_topology_verify_api_commercial_ocr_version COMPOSE_FILES "$target_ocr_version"
maxim_topology_verify_ocr_native_sandbox_runtime COMPOSE_FILES "$2" with-media
maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required sandbox
maxim_topology_smoke_photo_native_sandbox_uds COMPOSE_FILES "$2"
