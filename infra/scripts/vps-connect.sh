#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

export YC_CLI_INITIALIZATION_SILENCE="${YC_CLI_INITIALIZATION_SILENCE:-true}"

ENV_FILE="${MAXIM_VPS_ENV_FILE:-$ROOT_DIR/.env.vps}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

MAXIM_VPS_SSH_TARGET="${MAXIM_VPS_SSH_TARGET:-maxim-vps}"
MAXIM_VPS_REPO_DIR="${MAXIM_VPS_REPO_DIR:-/var/www/Chat_bot}"
MAXIM_VPS_PUBLIC_URL="${MAXIM_VPS_PUBLIC_URL:-https://major-maksimov.ru}"

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/vps-connect.sh <command> [args...]

Commands:
  doctor                      Check local SSH config and remote VPS basics
  shell                       Open an interactive shell in the remote repo
  exec <command...>           Run a command in the remote repo
  deploy [branch] [services|--plan|--auto|--full]
                              Run or plan a manifest-aware production deploy
  preload-ci-image <component> [git-ref]
                              Stream a green CI exact-SHA MAXIM image to the VPS
  deploy-scale [branch] [...] Run the split/load-testing deploy script on the VPS.
                              Requires MAXIM_ALLOW_SCALE_DEPLOY=1.
  rollback-runtime <ref> [...] Rebuild/recreate API roles from a previous git ref
  rollback-release <release-id> [components...]
                              Recreate immutable API/miniapp/admin release images
  allow-ssh-current-ip [sg]  Add current public IP/32 to the Yandex Cloud SSH security group
  ensure-ssh [sg]            Allow current public IP, then run doctor
  health                      Check local-on-VPS and public health endpoints
  monitor-readonly [duration-sec] [interval-sec]
                              Sample health, ps, restarts, public app, and error logs
  ps [services...]            Show main production docker compose status
  logs <service> [tail]       Show main production service logs, default tail=200
  yc-shell                    Open a Yandex Cloud CLI SSH shell, if configured

Per-device config:
  cp infra/env/vps.env.example .env.vps
  edit .env.vps
  ./infra/scripts/vps-connect.sh doctor
USAGE
}

expand_path() {
  local value="$1"

  case "$value" in
    "~") printf '%s' "$HOME" ;;
    \~/*) printf '%s/%s' "$HOME" "${value#\~/}" ;;
    *) printf '%s' "$value" ;;
  esac
}

shell_quote_args() {
  local arg
  local quoted

  for arg in "$@"; do
    printf -v quoted '%q' "$arg"
    printf '%s ' "$quoted"
  done
}

ssh_args() {
  local args=(
    -o ServerAliveInterval=15
    -o ServerAliveCountMax=3
  )
  local extra_args=()

  if [[ -n "${MAXIM_VPS_SSH_PORT:-}" ]]; then
    args+=(-p "$MAXIM_VPS_SSH_PORT")
  fi

  if [[ -n "${MAXIM_VPS_SSH_KEY:-}" ]]; then
    args+=(-i "$(expand_path "$MAXIM_VPS_SSH_KEY")")
  fi

  if [[ -n "${MAXIM_VPS_SSH_CONFIG:-}" ]]; then
    args+=(-F "$(expand_path "$MAXIM_VPS_SSH_CONFIG")")
  fi

  if [[ -n "${MAXIM_VPS_SSH_EXTRA_ARGS:-}" ]]; then
    # Split simple whitespace-separated extra args. Keep complex SSH options in
    # ~/.ssh/config when quoting is required.
    read -r -a extra_args <<<"$MAXIM_VPS_SSH_EXTRA_ARGS"
    args+=("${extra_args[@]}")
  fi

  printf '%s\0' "${args[@]}"
}

yc_args() {
  local args=()

  if [[ -n "${MAXIM_YC_PROFILE:-}" ]]; then
    args=(--profile "$MAXIM_YC_PROFILE")
  fi

  printf '%s\0' "${args[@]}"
}

detect_public_ipv4() {
  local ip
  local url
  local urls=()

  if [[ -n "${MAXIM_PUBLIC_IP_URL:-}" ]]; then
    urls+=("$MAXIM_PUBLIC_IP_URL")
  fi

  urls+=("https://api.ipify.org" "https://ifconfig.me/ip")

  for url in "${urls[@]}"; do
    ip="$(curl -4 -fsS --connect-timeout 5 --max-time 10 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      printf '%s' "$ip"
      return 0
    fi
  done

  return 1
}

ssh_source_cidr() {
  local ip

  if [[ -n "${MAXIM_YC_SSH_SOURCE_CIDR:-}" ]]; then
    if [[ "$MAXIM_YC_SSH_SOURCE_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
      printf '%s' "$MAXIM_YC_SSH_SOURCE_CIDR"
      return 0
    fi

    echo "MAXIM_YC_SSH_SOURCE_CIDR must be an IPv4 CIDR, for example 203.0.113.7/32." >&2
    return 1
  fi

  ip="$(detect_public_ipv4)" || return 1
  printf '%s/32' "$ip"
}

allow_ssh_current_ip() {
  local sg="${1:-${MAXIM_YC_SSH_SECURITY_GROUP_ID:-${MAXIM_YC_SSH_SECURITY_GROUP_NAME:-}}}"
  local cidr
  local description
  local current_rules
  local timeout_sec="${MAXIM_YC_COMMAND_TIMEOUT_SEC:-30}"
  local args=()

  if ! command -v yc >/dev/null 2>&1; then
    echo "yc not found"
    exit 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found"
    exit 1
  fi

  if [[ -z "$sg" ]]; then
    echo "Set MAXIM_YC_SSH_SECURITY_GROUP_ID or MAXIM_YC_SSH_SECURITY_GROUP_NAME in .env.vps, or pass a security group id/name."
    exit 1
  fi

  cidr="$(ssh_source_cidr)" || {
    echo "Could not resolve SSH source CIDR."
    exit 1
  }

  mapfile -d '' -t args < <(yc_args)

  current_rules="$(timeout "$timeout_sec" yc "${args[@]}" vpc security-group get "$sg")" || {
    echo "Could not read Yandex Cloud security group '$sg'."
    exit 1
  }

  if grep -Fq -- "- $cidr" <<<"$current_rules"; then
    echo "SSH already allowed from $cidr in $sg."
    return 0
  fi

  description="ssh-codex-$(date -u +%Y%m%d)-${cidr//[.\/]/-}"
  timeout "$timeout_sec" yc "${args[@]}" vpc security-group update-rules "$sg" \
    --add-rule "description=$description,direction=ingress,port=22,protocol=tcp,v4-cidrs=$cidr" >/dev/null

  echo "Allowed SSH from $cidr in $sg."
}

maybe_allow_ssh_current_ip() {
  case "${MAXIM_VPS_AUTO_AUTHORIZE_SSH:-0}" in
    1|true|TRUE|yes|YES)
      if ! allow_ssh_current_ip >/dev/null; then
        echo "Warning: could not auto-authorize current SSH source IP; continuing with SSH attempt." >&2
      fi
      ;;
  esac
}

remote_exec() {
  local command="$1"
  local remote_command
  local args=()

  maybe_allow_ssh_current_ip
  mapfile -d '' -t args < <(ssh_args)
  printf -v remote_command 'cd %q && %s' "$MAXIM_VPS_REPO_DIR" "$command"
  # The command is composed and shell-escaped locally before the remote shell parses it.
  # shellcheck disable=SC2029
  ssh "${args[@]}" "$MAXIM_VPS_SSH_TARGET" "bash -lc $(printf '%q' "$remote_command")"
}

remote_from_args() {
  if [[ $# -eq 0 ]]; then
    echo "Missing remote command."
    usage
    exit 1
  fi

  if [[ $# -eq 1 ]]; then
    remote_exec "$1"
  else
    remote_exec "$(shell_quote_args "$@")"
  fi
}

open_shell() {
  local args=()
  local remote_command

  maybe_allow_ssh_current_ip
  mapfile -d '' -t args < <(ssh_args)
  # Keep the shell lookup literal until the interactive command runs remotely.
  # shellcheck disable=SC2016
  printf -v remote_command 'cd %q && exec "${SHELL:-bash}"' "$MAXIM_VPS_REPO_DIR"
  ssh "${args[@]}" -t "$MAXIM_VPS_SSH_TARGET" "bash -lc $(printf '%q' "$remote_command")"
}

deploy_main() {
  local branch="${1:-main}"
  local expected_sha
  local remote_command
  shift || true

  if ! expected_sha="$(git rev-parse --verify --end-of-options "${branch}^{commit}" 2>/dev/null)"; then
    echo "Cannot resolve local deploy branch to an exact commit: ${branch}" >&2
    exit 2
  fi

  case "${MAXIM_DEPLOY_EMERGENCY_BYPASS:-0}" in
    1|true|TRUE|yes|YES)
      if [[ -z "${MAXIM_DEPLOY_EMERGENCY_REASON:-}" ]]; then
        echo "MAXIM_DEPLOY_EMERGENCY_REASON is required with MAXIM_DEPLOY_EMERGENCY_BYPASS=1." >&2
        exit 2
      fi
      echo "WARNING: bypassing the green-CI deploy gate: $MAXIM_DEPLOY_EMERGENCY_REASON" >&2
      ;;
    *)
      node scripts/ci/assert-green.mjs "$expected_sha"
      ;;
  esac

  remote_command="$(shell_quote_args ./infra/scripts/vps-pull-build-up.sh "$branch" "$@")"
  remote_command="MAXIM_EXPECTED_DEPLOY_SHA=$(printf '%q' "$expected_sha") $remote_command"
  if [[ -n "${MAXIM_DEPLOY_EMERGENCY_REASON:-}" ]]; then
    remote_command="MAXIM_DEPLOY_EMERGENCY_REASON=$(printf '%q' "$MAXIM_DEPLOY_EMERGENCY_REASON") $remote_command"
  fi
  if [[ "$branch" != "main" ]]; then
    case "${MAXIM_ALLOW_NON_MAIN_DEPLOY:-0}" in
      1|true|TRUE|yes|YES)
        remote_command="MAXIM_ALLOW_NON_MAIN_DEPLOY=1 $remote_command"
        ;;
    esac
  fi

  remote_exec "$remote_command"
}

preload_ci_image() (
  local component="${1:-}"
  local ref="${2:-HEAD}"
  local artifact_component
  local artifact_name
  local artifact_run_id
  local artifact_run_metadata
  local archive_path
  local archive_uncompressed_bytes
  local checksum_path
  local download_dir
  local exact_sha
  local image_ref
  local image_repository
  local preload_min_remaining_free_bytes="4294967296"
  local remote_load_command
  local remote_load_script
  local repository
  local args=()

  case "$component" in
    api|api-shared)
      artifact_component="api"
      image_repository="maxim-api"
      ;;
    miniapp|miniapp-major-static)
      artifact_component="miniapp"
      image_repository="maxim-miniapp-major"
      ;;
    admin|admin-static)
      artifact_component="admin"
      image_repository="maxim-admin"
      ;;
    *)
      echo "Component must be one of: api, miniapp, admin." >&2
      exit 2
      ;;
  esac

  if ! command -v gh >/dev/null 2>&1; then
    echo "gh not found" >&2
    exit 1
  fi
  if ! command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum not found" >&2
    exit 1
  fi
  if ! command -v gzip >/dev/null 2>&1; then
    echo "gzip not found" >&2
    exit 1
  fi
  if ! exact_sha="$(git rev-parse --verify --end-of-options "${ref}^{commit}" 2>/dev/null)" ||
    [[ ! "$exact_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Cannot resolve CI image ref to an exact commit: $ref" >&2
    exit 2
  fi

  node scripts/ci/assert-green.mjs "$exact_sha"
  repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
  if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "Could not resolve the GitHub repository for the CI image." >&2
    exit 1
  fi

  artifact_name="maxim-image-${artifact_component}-${exact_sha}"
  artifact_run_id="$(
    gh api --method GET "repos/${repository}/actions/artifacts" \
      -f "name=${artifact_name}" \
      -f per_page=100 \
      --jq ".artifacts | map(select(.expired == false and .workflow_run.head_sha == \"${exact_sha}\")) | sort_by(.created_at) | last | .workflow_run.id // empty"
  )"
  if [[ ! "$artifact_run_id" =~ ^[0-9]+$ ]]; then
    echo "No unexpired exact-SHA CI image artifact found: $artifact_name" >&2
    exit 1
  fi
  artifact_run_metadata="$(
    gh run view "$artifact_run_id" \
      --repo "$repository" \
      --json workflowName,headSha,headBranch,conclusion,event \
      --jq '[.workflowName, .headSha, .headBranch, .conclusion, .event] | join("|")'
  )"
  if [[ "$artifact_run_metadata" != "CI|${exact_sha}|main|success|push" ]]; then
    echo "Image artifact did not come from the successful main CI push: $artifact_run_metadata" >&2
    exit 1
  fi

  download_dir="$(mktemp -d /tmp/maxim-ci-image.XXXXXX)"
  # Invoked indirectly by the EXIT trap below.
  # shellcheck disable=SC2317
  cleanup_download_dir() {
    if [[ "$download_dir" == /tmp/maxim-ci-image.* && -d "$download_dir" ]]; then
      find "$download_dir" -mindepth 1 -delete
      rmdir "$download_dir"
    fi
  }
  trap cleanup_download_dir EXIT

  gh run download "$artifact_run_id" \
    --repo "$repository" \
    --name "$artifact_name" \
    --dir "$download_dir"
  archive_path="$download_dir/maxim-image.tar.gz"
  checksum_path="$download_dir/maxim-image.tar.gz.sha256"
  if [[ ! -f "$archive_path" || ! -f "$checksum_path" ]]; then
    echo "CI image artifact is incomplete: $artifact_name" >&2
    exit 1
  fi
  (cd "$download_dir" && sha256sum --check "$(basename "$checksum_path")")
  archive_uncompressed_bytes="$(gzip -dc "$archive_path" | wc -c)"
  archive_uncompressed_bytes="${archive_uncompressed_bytes//[[:space:]]/}"
  if [[ ! "$archive_uncompressed_bytes" =~ ^[1-9][0-9]*$ ]]; then
    echo "Could not determine the uncompressed CI image archive size: $artifact_name" >&2
    exit 1
  fi

  image_ref="${image_repository}:${exact_sha}"
  maybe_allow_ssh_current_ip
  mapfile -d '' -t args < <(ssh_args)
  echo "Streaming verified CI image to $MAXIM_VPS_SSH_TARGET: $image_ref"
  remote_load_script=$(cat <<'REMOTE'
set -euo pipefail
source infra/scripts/lib/deploy-lock.sh
acquire_deploy_lock
if [[ ! "$MAXIM_PRELOAD_EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid exact SHA for CI image preload." >&2
  exit 1
fi
case "$MAXIM_PRELOAD_IMAGE_REF" in
  "maxim-api:${MAXIM_PRELOAD_EXPECTED_SHA}"|\
  "maxim-miniapp-major:${MAXIM_PRELOAD_EXPECTED_SHA}"|\
  "maxim-admin:${MAXIM_PRELOAD_EXPECTED_SHA}")
    ;;
  *)
    echo "Refusing unsafe CI image preload target: $MAXIM_PRELOAD_IMAGE_REF" >&2
    exit 1
    ;;
esac
if [[ ! "$MAXIM_PRELOAD_ARCHIVE_BYTES" =~ ^[1-9][0-9]*$ ]] ||
   [[ ! "$MAXIM_PRELOAD_MIN_REMAINING_FREE_BYTES" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid CI image preload capacity values." >&2
  exit 1
fi
disk_path="/var/lib/docker"
if [[ ! -d "$disk_path" ]]; then
  disk_path="/"
fi
available_bytes="$(df -P -B1 "$disk_path" | awk 'NR == 2 { print $4 }')"
if [[ ! "$available_bytes" =~ ^[0-9]+$ ]]; then
  echo "Failed to read free space for CI image preload: $disk_path" >&2
  exit 1
fi
required_bytes=$((MAXIM_PRELOAD_ARCHIVE_BYTES + MAXIM_PRELOAD_MIN_REMAINING_FREE_BYTES))
echo "CI image preload disk preflight: path=$disk_path available=${available_bytes}B archive=${MAXIM_PRELOAD_ARCHIVE_BYTES}B reserve=${MAXIM_PRELOAD_MIN_REMAINING_FREE_BYTES}B"
if (( available_bytes < required_bytes )); then
  echo "Refusing CI image preload: ${available_bytes}B available, ${required_bytes}B required." >&2
  exit 1
fi
previous_image_id="$(
  docker image inspect --format '{{.Id}}' "$MAXIM_PRELOAD_IMAGE_REF" 2>/dev/null || true
)"
if [[ -n "$previous_image_id" && ! "$previous_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Could not verify the existing CI image preload target: $MAXIM_PRELOAD_IMAGE_REF" >&2
  exit 1
fi
docker image load >/dev/null
loaded_image_id="$(
  docker image inspect --format '{{.Id}}' "$MAXIM_PRELOAD_IMAGE_REF" 2>/dev/null || true
)"
if [[ ! "$loaded_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "CI image archive did not load the expected target: $MAXIM_PRELOAD_IMAGE_REF" >&2
  exit 1
fi

cleanup_invalid_loaded_tag() {
  local current_image_id

  current_image_id="$(
    docker image inspect --format '{{.Id}}' "$MAXIM_PRELOAD_IMAGE_REF" 2>/dev/null || true
  )"
  if [[ "$current_image_id" != "$loaded_image_id" ||
        "$loaded_image_id" == "$previous_image_id" ]]; then
    echo "Leaving the preload target untouched because it is not a newly loaded invalid tag: $MAXIM_PRELOAD_IMAGE_REF" >&2
    return 0
  fi

  echo "Removing newly loaded invalid MAXIM tag: $MAXIM_PRELOAD_IMAGE_REF" >&2
  docker image rm "$MAXIM_PRELOAD_IMAGE_REF" >/dev/null
  if [[ -n "$previous_image_id" ]]; then
    docker image tag "$previous_image_id" "$MAXIM_PRELOAD_IMAGE_REF"
    echo "Restored previous MAXIM tag after rejected preload: $MAXIM_PRELOAD_IMAGE_REF" >&2
  fi
}

labels="$(
  docker image inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}' \
    "$MAXIM_PRELOAD_IMAGE_REF" 2>/dev/null || true
)"
if [[ "$labels" != "${MAXIM_PRELOAD_EXPECTED_SHA}|true" ]]; then
  echo "Loaded image metadata does not match the exact reviewed commit: $MAXIM_PRELOAD_IMAGE_REF ($labels)" >&2
  if ! cleanup_invalid_loaded_tag; then
    echo "Failed to remove the newly loaded invalid MAXIM tag: $MAXIM_PRELOAD_IMAGE_REF" >&2
  fi
  exit 1
fi
REMOTE
  )
  printf -v remote_load_command \
    'cd %q && MAXIM_PRELOAD_ARCHIVE_BYTES=%q MAXIM_PRELOAD_MIN_REMAINING_FREE_BYTES=%q MAXIM_PRELOAD_IMAGE_REF=%q MAXIM_PRELOAD_EXPECTED_SHA=%q bash -c %q' \
    "$MAXIM_VPS_REPO_DIR" \
    "$archive_uncompressed_bytes" \
    "$preload_min_remaining_free_bytes" \
    "$image_ref" \
    "$exact_sha" \
    "$remote_load_script"
  # The command is composed and shell-escaped locally before the remote shell parses it.
  # shellcheck disable=SC2029
  ssh "${args[@]}" "$MAXIM_VPS_SSH_TARGET" \
    "bash -lc $(printf '%q' "$remote_load_command")" <"$archive_path"

  echo "Preloaded immutable MAXIM image: $image_ref"
)

deploy_scale() {
  local branch="${1:-main}"
  shift || true

  case "${MAXIM_ALLOW_SCALE_DEPLOY:-0}" in
    1|true|TRUE|yes|YES)
      ;;
    *)
      echo "deploy-scale is loadtest-only and can stop the main infra stack. Set MAXIM_ALLOW_SCALE_DEPLOY=1 to continue." >&2
      exit 2
      ;;
  esac

  remote_exec "MAXIM_ALLOW_SCALE_DEPLOY=1 $(shell_quote_args ./infra/scripts/vps-pull-build-up-scale.sh "$branch" "$@")"
}

rollback_runtime() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: $0 rollback-runtime <git-ref> [services...]"
    exit 1
  fi

  remote_exec "$(shell_quote_args ./infra/scripts/vps-runtime-rollback.sh "$@")"
}

rollback_release() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: $0 rollback-release <release-id> [api-shared] [miniapp-major-static] [admin-static]"
    exit 1
  fi

  remote_exec "$(shell_quote_args ./infra/scripts/vps-release-rollback.sh "$@")"
}

health() {
  remote_exec 'curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/live && printf "\n" && curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/ready && printf "\n" && curl -fsS --max-time 15 http://127.0.0.1:3002/api/health/live && printf "\n" && curl -fsS --max-time 15 http://127.0.0.1:3002/api/health/ready && printf "\n"'
  curl -fsS --max-time 15 "$MAXIM_VPS_PUBLIC_URL/api/health/live"
  printf '\n'
}

doctor() {
  local args=()

  if ! command -v ssh >/dev/null 2>&1; then
    echo "ssh not found"
    exit 1
  fi

  maybe_allow_ssh_current_ip
  mapfile -d '' -t args < <(ssh_args)

  echo "Config:"
  echo "  env_file=$ENV_FILE"
  echo "  ssh_target=$MAXIM_VPS_SSH_TARGET"
  echo "  repo_dir=$MAXIM_VPS_REPO_DIR"
  echo "  public_url=$MAXIM_VPS_PUBLIC_URL"
  echo

  ssh "${args[@]}" -o BatchMode=yes -o ConnectTimeout=10 "$MAXIM_VPS_SSH_TARGET" \
    "cd $(printf '%q' "$MAXIM_VPS_REPO_DIR") && printf 'remote_repo=%s\n' \"\$PWD\" && git rev-parse --short HEAD && docker compose version"
}

ensure_ssh() {
  allow_ssh_current_ip "$@"
  doctor
}

yc_shell() {
  local args=(compute ssh --public-address)

  if ! command -v yc >/dev/null 2>&1; then
    echo "yc not found"
    exit 1
  fi

  if [[ -n "${MAXIM_YC_PROFILE:-}" ]]; then
    args=(--profile "$MAXIM_YC_PROFILE" "${args[@]}")
  fi

  if [[ -n "${MAXIM_YC_VM_ID:-}" ]]; then
    args+=(--id "$MAXIM_YC_VM_ID")
  elif [[ -n "${MAXIM_YC_VM_NAME:-}" ]]; then
    args+=(--name "$MAXIM_YC_VM_NAME")
  else
    echo "Set MAXIM_YC_VM_NAME or MAXIM_YC_VM_ID in .env.vps."
    exit 1
  fi

  if [[ -n "${MAXIM_YC_LOGIN:-}" ]]; then
    args+=(--login "$MAXIM_YC_LOGIN")
  fi

  if [[ -n "${MAXIM_YC_IDENTITY_FILE:-}" ]]; then
    args+=(-i "$(expand_path "$MAXIM_YC_IDENTITY_FILE")")
  fi

  yc "${args[@]}"
}

command="${1:-}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$command" in
  doctor)
    doctor
    ;;
  shell)
    open_shell
    ;;
  exec)
    remote_from_args "$@"
    ;;
  deploy)
    deploy_main "$@"
    ;;
  preload-ci-image)
    preload_ci_image "$@"
    ;;
  deploy-scale)
    deploy_scale "$@"
    ;;
  rollback-runtime)
    rollback_runtime "$@"
    ;;
  rollback-release)
    rollback_release "$@"
    ;;
  allow-ssh-current-ip)
    allow_ssh_current_ip "$@"
    ;;
  ensure-ssh)
    ensure_ssh "$@"
    ;;
  health)
    health
    ;;
  monitor-readonly)
    "$ROOT_DIR/infra/scripts/vps-monitor-readonly.sh" "$@"
    ;;
  ps)
    remote_exec "$(shell_quote_args docker compose --env-file .env -p infra -f infra/docker-compose.yml ps "$@")"
    ;;
  logs)
    if [[ $# -lt 1 ]]; then
      echo "Usage: $0 logs <service> [tail]"
      exit 1
    fi
    service="$1"
    tail="${2:-200}"
    remote_exec "$(shell_quote_args docker compose --env-file .env -p infra -f infra/docker-compose.yml logs --tail "$tail" "$service")"
    ;;
  yc-shell)
    yc_shell
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    echo "Unknown command: $command"
    usage
    exit 1
    ;;
esac
