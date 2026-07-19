#!/usr/bin/env bash
set -euo pipefail

source "$1"
maxim_impact_classify_path "$2"
printf '%s %s %s %s\n' \
  "$MAXIM_IMPACT_PATH_API_SHARED" \
  "$MAXIM_IMPACT_PATH_MINIAPP_MAJOR_STATIC" \
  "$MAXIM_IMPACT_PATH_ADMIN_STATIC" \
  "$MAXIM_IMPACT_PATH_UNKNOWN"
