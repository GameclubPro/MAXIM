#!/usr/bin/env bash

MAXIM_API_BUILD_HARD_MIN_FREE_BYTES="21474836480"
MAXIM_STATIC_BUILD_HARD_MIN_FREE_BYTES="6442450944"

maxim_deploy_disk_validate_nonnegative_int() {
  local name="$1"
  local value="$2"

  if [[ "$value" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  echo "$name must be a non-negative integer." >&2
  return 1
}

maxim_deploy_disk_normalize_nonnegative_int() {
  local value="$1"
  local leading_zeroes="${value%%[!0]*}"

  value="${value#"$leading_zeroes"}"
  printf '%s\n' "${value:-0}"
}

maxim_deploy_disk_decimal_less_than() {
  local left
  local right

  left="$(maxim_deploy_disk_normalize_nonnegative_int "$1")"
  right="$(maxim_deploy_disk_normalize_nonnegative_int "$2")"
  if [[ "${#left}" -ne "${#right}" ]]; then
    [[ "${#left}" -lt "${#right}" ]]
    return
  fi
  [[ "$left" < "$right" ]]
}

maxim_deploy_disk_override_enabled() {
  case "${1:-0}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

maxim_check_deploy_disk_capacity() {
  local needs_api_build="${1:-}"
  local needs_static_build="${2:-}"
  local target_percent="${MAXIM_DEPLOY_DISK_TARGET_PERCENT:-${MAXIM_DEPLOY_DISK_WARN_PERCENT:-90}}"
  local critical_percent="${MAXIM_DEPLOY_DISK_CRITICAL_PERCENT:-${MAXIM_DEPLOY_DISK_MAX_PERCENT:-95}}"
  local hard_minimum_free_bytes="0"
  local minimum_free_bytes
  local build_kind=""
  local disk_path="/var/lib/docker"
  local disk_stats
  local available_bytes
  local used_percent

  if [[ "$needs_api_build" != "0" && "$needs_api_build" != "1" ]] ||
     [[ "$needs_static_build" != "0" && "$needs_static_build" != "1" ]]; then
    echo "Deploy disk capacity requirements must be expressed as 0 or 1." >&2
    return 1
  fi
  if [[ "$needs_api_build" -eq 1 ]]; then
    hard_minimum_free_bytes="$MAXIM_API_BUILD_HARD_MIN_FREE_BYTES"
    build_kind="api"
  fi
  if [[ "$needs_static_build" -eq 1 ]]; then
    if maxim_deploy_disk_decimal_less_than \
      "$hard_minimum_free_bytes" "$MAXIM_STATIC_BUILD_HARD_MIN_FREE_BYTES"; then
      hard_minimum_free_bytes="$MAXIM_STATIC_BUILD_HARD_MIN_FREE_BYTES"
    fi
    build_kind="${build_kind:+$build_kind+}static"
  fi
  if [[ "$hard_minimum_free_bytes" == "0" ]]; then
    echo "Deploy disk capacity preflight requires at least one build component." >&2
    return 1
  fi

  minimum_free_bytes="${MAXIM_DEPLOY_DISK_MIN_FREE_BYTES:-$hard_minimum_free_bytes}"
  maxim_deploy_disk_validate_nonnegative_int \
    "MAXIM_DEPLOY_DISK_TARGET_PERCENT" "$target_percent" || return 1
  maxim_deploy_disk_validate_nonnegative_int \
    "MAXIM_DEPLOY_DISK_CRITICAL_PERCENT" "$critical_percent" || return 1
  maxim_deploy_disk_validate_nonnegative_int \
    "MAXIM_DEPLOY_DISK_MIN_FREE_BYTES" "$minimum_free_bytes" || return 1
  target_percent="$(maxim_deploy_disk_normalize_nonnegative_int "$target_percent")"
  critical_percent="$(maxim_deploy_disk_normalize_nonnegative_int "$critical_percent")"
  minimum_free_bytes="$(maxim_deploy_disk_normalize_nonnegative_int "$minimum_free_bytes")"
  if maxim_deploy_disk_decimal_less_than "$minimum_free_bytes" "$hard_minimum_free_bytes"; then
    echo "MAXIM_DEPLOY_DISK_MIN_FREE_BYTES must be at least ${hard_minimum_free_bytes} for build components: ${build_kind}." >&2
    return 1
  fi
  if ! maxim_deploy_disk_decimal_less_than "$target_percent" "$critical_percent" ||
     maxim_deploy_disk_decimal_less_than 100 "$critical_percent"; then
    echo "Disk thresholds must satisfy target < critical <= 100." >&2
    return 1
  fi

  if [[ ! -d "$disk_path" ]]; then
    disk_path="/"
  fi
  if ! disk_stats="$(
    df -P -B1 "$disk_path" | awk 'NR == 2 { gsub(/%/, "", $5); print $4, $5 }'
  )"; then
    echo "Failed to read disk utilization for $disk_path in bytes." >&2
    return 1
  fi
  read -r available_bytes used_percent <<< "$disk_stats"
  if [[ ! "$available_bytes" =~ ^[0-9]+$ ]] || [[ ! "$used_percent" =~ ^[0-9]+$ ]]; then
    echo "Failed to read disk utilization for $disk_path in bytes." >&2
    return 1
  fi
  available_bytes="$(maxim_deploy_disk_normalize_nonnegative_int "$available_bytes")"
  used_percent="$(maxim_deploy_disk_normalize_nonnegative_int "$used_percent")"

  echo "Deploy disk preflight: components=$build_kind path=$disk_path used=${used_percent}% available=${available_bytes}B minimum-free=${minimum_free_bytes}B target=${target_percent}% critical=${critical_percent}%"
  if maxim_deploy_disk_decimal_less_than "$available_bytes" "$minimum_free_bytes"; then
    cat >&2 <<EOF
Refusing to build with ${available_bytes} free bytes; at least ${minimum_free_bytes} bytes are required.
Run infra/scripts/vps-docker-space-reclaim.sh after reviewing its inventory.
This absolute free-space minimum is not bypassed by MAXIM_ALLOW_CRITICAL_DISK_DEPLOY.
EOF
    return 1
  fi

  if ! maxim_deploy_disk_decimal_less_than "$used_percent" "$target_percent" &&
     ! maxim_deploy_disk_override_enabled "${MAXIM_ALLOW_CRITICAL_DISK_DEPLOY:-0}"; then
    local severity="above the deploy target"
    if ! maxim_deploy_disk_decimal_less_than "$used_percent" "$critical_percent"; then
      severity="critical"
    fi
    cat >&2 <<EOF
Refusing to build with ${severity} disk utilization (${used_percent}%).
Run infra/scripts/vps-docker-space-reclaim.sh after reviewing its inventory.
This guard never prunes Docker volumes. Set MAXIM_ALLOW_CRITICAL_DISK_DEPLOY=1 only for an explicit emergency deploy.
EOF
    return 1
  fi

  if ! maxim_deploy_disk_decimal_less_than "$used_percent" "$critical_percent"; then
    echo "CRITICAL: deploy host disk utilization is ${used_percent}%." >&2
  elif ! maxim_deploy_disk_decimal_less_than "$used_percent" "$target_percent"; then
    echo "WARNING: deploy host disk utilization is ${used_percent}%." >&2
  fi
}
