#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_REL_PATH="${SCRIPT_PATH#"$ROOT_DIR"/}"
ORIGINAL_ARGS=("$@")

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/webhook-rollout-quiescence.sh
source "$ROOT_DIR/infra/scripts/lib/webhook-rollout-quiescence.sh"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/deploy-disk-capacity.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-disk-capacity.sh"
# shellcheck source=infra/scripts/lib/change-impact-components.generated.sh
source "$ROOT_DIR/infra/scripts/lib/change-impact-components.generated.sh"

MAIN_PROJECT_NAME="infra"
SCALE_PROJECT_NAME="infra-scale"
COMPOSE_FILES=(--env-file ".env" -p "$MAIN_PROJECT_NAME" -f "infra/docker-compose.yml")
MIGRATION_COMPOSE_FILES=("${COMPOSE_FILES[@]}" -f "infra/docker-compose.runtime-no-build.yml")
ALTERNATE_COMPOSE_FILES=(-p "$SCALE_PROJECT_NAME" -f "infra/docker-compose.scale.yml")
BRANCH="${1:-main}"
PRE_PULL_HEAD=""
EXPECTED_DEPLOY_SHA="${MAXIM_EXPECTED_DEPLOY_SHA:-}"
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
DEPLOY_MODE="manual"
DEPLOY_RUNTIME_STARTED=0
DEPLOY_MANIFEST_RECORDED=0
RECOVERY_BASE_MANIFEST=""
PUBLIC_HEALTH_URL="${MAXIM_VPS_PUBLIC_URL:-${MAXIM_PUBLIC_HEALTH_URL:-https://major-maksimov.ru}}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL%/}"
API_READY_TIMEOUT_SEC="${MAXIM_DEPLOY_API_READY_TIMEOUT_SEC:-900}"

SERVICES=()
if [[ $# -ge 2 ]]; then
  for argument in "${@:2}"; do
    case "$argument" in
      --plan|--auto|--full)
        if [[ "$DEPLOY_MODE" != "manual" ]]; then
          echo "Only one of --plan, --auto, or --full may be used." >&2
          exit 2
        fi
        DEPLOY_MODE="${argument#--}"
        ;;
      --*)
        echo "Unknown deploy option: $argument" >&2
        exit 2
        ;;
      *)
        SERVICES+=("$argument")
        ;;
    esac
  done
fi

if [[ "$DEPLOY_MODE" != "manual" && "${#SERVICES[@]}" -gt 0 ]]; then
  echo "Explicit services cannot be combined with --$DEPLOY_MODE." >&2
  exit 2
fi

if [[ "$DEPLOY_MODE" == "full" ]] || [[ "$DEPLOY_MODE" == "manual" && "${#SERVICES[@]}" -eq 0 ]]; then
  SERVICES=(
    "api-ingress"
    "api-admin"
    "api-enqueue"
    "api-moderation"
    "api-moderation-critical"
    "api-moderation-join"
    "api-moderation-realtime-b"
    "api-moderation-realtime-c"
    "api-moderation-realtime-d"
    "api-moderation-background"
    "api-media-analysis"
    "api-action"
    "api-publisher"
    "miniapp-major-static"
    "admin-static"
  )
fi

API_SERVICES=("${MAXIM_PRODUCTION_API_SERVICES[@]}")
ACTIVE_STATIC_SERVICES=("miniapp-major-static" "admin-static")
OPTIONAL_STATIC_SERVICES=("miniapp-static")

contains_service() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

validate_requested_services() {
  local service
  local validated=()

  for service in "${SERVICES[@]}"; do
    if ! contains_service "$service" "${API_SERVICES[@]}" "${ACTIVE_STATIC_SERVICES[@]}" "${OPTIONAL_STATIC_SERVICES[@]}"; then
      echo "Unknown or unsafe deploy service: $service" >&2
      echo "Stateful services are startup dependencies, not routine deploy targets." >&2
      exit 2
    fi
    if ! contains_service "$service" "${validated[@]}"; then
      validated+=("$service")
    fi
  done
  SERVICES=("${validated[@]}")
}

validate_api_ready_timeout() {
  if [[ ! "$API_READY_TIMEOUT_SEC" =~ ^[1-9][0-9]{2,3}$ ]] ||
    ((API_READY_TIMEOUT_SEC < 180 || API_READY_TIMEOUT_SEC > 3600)); then
    echo "MAXIM_DEPLOY_API_READY_TIMEOUT_SEC must be an integer between 180 and 3600." >&2
    return 2
  fi
}

release_manifest() {
  MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" node infra/scripts/release-manifest.mjs "$@"
}

release_field() {
  local args=(field current "$1" "$2")
  if [[ -n "$RECOVERY_BASE_MANIFEST" ]]; then
    args+=(--current-manifest-file "$RECOVERY_BASE_MANIFEST")
  fi
  release_manifest "${args[@]}" 2>/dev/null
}

invalidate_stale_release_inventory() {
  local current_manifest="$RELEASE_STATE_DIR/current.json"
  local invalid_manifest

  [[ "$DEPLOY_RUNTIME_STARTED" -eq 1 && "$DEPLOY_MANIFEST_RECORDED" -eq 0 ]] || return 0
  [[ -f "$current_manifest" ]] || return 0
  invalid_manifest="$RELEASE_STATE_DIR/current.invalid-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  if mv "$current_manifest" "$invalid_manifest"; then
    echo "Invalidated stale release inventory after incomplete deploy: $invalid_manifest" >&2
  else
    echo "CRITICAL: failed to invalidate stale release inventory: $current_manifest" >&2
  fi
}

cleanup() {
  maxim_webhook_rollout_warn_if_paused
  invalidate_stale_release_inventory
  release_deploy_lock
}

inspect_container_component() {
  local service="$1"
  local component="$2"
  local fallback_ref="$3"
  local container_id
  local image_ref="$fallback_ref"
  local image_id="unknown"

  container_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q "$service" 2>/dev/null || true)"
  if [[ -n "$container_id" ]]; then
    image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null || printf '%s' "$fallback_ref")"
    image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || printf '%s' unknown)"
  fi
  printf '%s|unknown|%s|%s' "$component" "$image_ref" "$image_id"
}

initialize_release_inventory() {
  local recovery_status
  local release_id

  if release_manifest validate-current --allow-unknown 1 >/dev/null 2>&1; then
    return 0
  fi
  if [[ -e "$RELEASE_STATE_DIR/current.json" ]]; then
    echo "Current release manifest exists but is invalid; refusing to overwrite it." >&2
    return 1
  fi

  if RECOVERY_BASE_MANIFEST="$(release_manifest recovery-base --allow-unknown 1)"; then
    if [[ "$MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE" != "1" ]]; then
      echo "An interrupted release manifest requires explicit recovery adoption." >&2
      echo "Set MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1 for this reviewed retry." >&2
      RECOVERY_BASE_MANIFEST=""
      return 1
    fi
    echo "Adopting the single validated interrupted release manifest."
    return 0
  else
    recovery_status=$?
  fi
  if [[ "$recovery_status" -ne 3 ]]; then
    RECOVERY_BASE_MANIFEST=""
    return "$recovery_status"
  fi

  release_id="inventory-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "Initializing release inventory with unverified source SHAs: $release_id"
  release_manifest inventory \
    --release-id "$release_id" \
    --target-sha unknown \
    --component "$(inspect_container_component api-ingress api-shared maxim-api:unknown)" \
    --component "$(inspect_container_component miniapp-major-static miniapp-major-static maxim-miniapp-major:unknown)" \
    --component "$(inspect_container_component admin-static admin-static maxim-admin:unknown)" \
    --smoke inventory-only >/dev/null
}

begin_release_runtime_transition() {
  if [[ -n "$RECOVERY_BASE_MANIFEST" ]]; then
    return 0
  fi
  if ! RECOVERY_BASE_MANIFEST="$(release_manifest begin-transition --kind deploy)"; then
    RECOVERY_BASE_MANIFEST=""
    echo "Could not journal the current release before runtime mutation." >&2
    return 1
  fi
  echo "Current release inventory journaled before runtime mutation."
}

archive_recovery_base_manifest() {
  [[ -n "$RECOVERY_BASE_MANIFEST" ]] || return 0
  if ! release_manifest archive-transition \
    --current-manifest-file "$RECOVERY_BASE_MANIFEST" \
    --disposition recovered >/dev/null; then
    echo "CRITICAL: could not archive the consumed release recovery manifest." >&2
    return 1
  fi
  RECOVERY_BASE_MANIFEST=""
}

load_current_component_images() {
  MAXIM_API_IMAGE="$(release_field api-shared imageRef || printf '%s' maxim-api:unknown)"
  MAXIM_MINIAPP_MAJOR_IMAGE="$(release_field miniapp-major-static imageRef || printf '%s' maxim-miniapp-major:unknown)"
  MAXIM_ADMIN_IMAGE="$(release_field admin-static imageRef || printf '%s' maxim-admin:unknown)"
  MAXIM_MINIAPP_LEGACY_IMAGE="${MAXIM_MINIAPP_LEGACY_IMAGE:-maxim-miniapp-legacy:local}"
  export MAXIM_API_IMAGE MAXIM_MINIAPP_MAJOR_IMAGE MAXIM_ADMIN_IMAGE MAXIM_MINIAPP_LEGACY_IMAGE
}

component_manifest_matches_runtime() {
  local component="$1"
  local expected_image_id
  local service
  local container_id
  local actual_image_id
  local services=()

  expected_image_id="$(release_field "$component" imageId || printf '%s' unknown)"
  if [[ ! "$expected_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    return 1
  fi

  case "$component" in
    api-shared) services=("${API_SERVICES[@]}") ;;
    miniapp-major-static) services=("miniapp-major-static") ;;
    admin-static) services=("admin-static") ;;
    *) return 1 ;;
  esac

  for service in "${services[@]}"; do
    container_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q "$service" 2>/dev/null || true)"
    [[ -n "$container_id" ]] || return 1
    actual_image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
    [[ "$actual_image_id" == "$expected_image_id" ]] || return 1
  done
  if [[ "$component" == "api-shared" ]]; then
    maxim_topology_verify_ocr_native_sandbox_for_image \
      COMPOSE_FILES "$expected_image_id" || return 1
  fi
}

impact_plan_selects_component() {
  local component="$1"
  local source_sha
  local changes_file
  local path
  local path_selected
  local result=1

  case "$component" in
    api-shared|miniapp-major-static|admin-static) ;;
    *)
      echo "Unknown deploy component during impact classification: $component" >&2
      exit 1
      ;;
  esac

  source_sha="$(release_field "$component" sourceSha || printf '%s' unknown)"
  if [[ "$source_sha" == "unknown" ]] || ! git cat-file -e "${source_sha}^{commit}" 2>/dev/null; then
    return 0
  fi
  if ! component_manifest_matches_runtime "$component"; then
    echo "Component manifest/runtime drift detected; selecting deploy: $component" >&2
    return 0
  fi
  if [[ "$source_sha" == "$(git rev-parse HEAD)" ]]; then
    return 1
  fi

  changes_file="$(mktemp)"
  if ! git diff --name-only --no-renames -z "$source_sha" HEAD -- >"$changes_file"; then
    rm -f "$changes_file"
    echo "Could not classify deploy impact for $component from $source_sha to HEAD." >&2
    exit 1
  fi

  while IFS= read -r -d '' path; do
    maxim_impact_classify_path "$path"
    case "$component" in
      api-shared) path_selected="$MAXIM_IMPACT_PATH_API_SHARED" ;;
      miniapp-major-static) path_selected="$MAXIM_IMPACT_PATH_MINIAPP_MAJOR_STATIC" ;;
      admin-static) path_selected="$MAXIM_IMPACT_PATH_ADMIN_STATIC" ;;
    esac
    if [[ "$path_selected" -eq 1 ]]; then
      result=0
      break
    fi
  done <"$changes_file"

  rm -f "$changes_file"
  return "$result"
}

derive_auto_services() {
  SERVICES=()
  if impact_plan_selects_component api-shared; then
    SERVICES+=("api-ingress")
  fi
  if impact_plan_selects_component miniapp-major-static; then
    SERVICES+=("miniapp-major-static")
  fi
  if impact_plan_selects_component admin-static; then
    SERVICES+=("admin-static")
  fi
}

print_deploy_plan() {
  local current_sha
  local component
  local selected=()

  for component in api-shared miniapp-major-static admin-static; do
    current_sha="$(release_field "$component" sourceSha || printf '%s' unknown)"
    if impact_plan_selects_component "$component"; then
      selected+=("$component")
    fi
    echo "$component current=$current_sha target=$(git rev-parse HEAD)"
  done
  if [[ "${#selected[@]}" -eq 0 ]]; then
    echo "No production components require deployment."
  else
    echo "Deploy components: ${selected[*]}"
  fi
}

has_requested_api_service() {
  local service
  for service in "${API_SERVICES[@]}"; do
    if contains_service "$service" "${SERVICES[@]}"; then
      return 0
    fi
  done
  return 1
}

is_enabled() {
  case "${1:-0}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_node_24() {
  if ! command -v node >/dev/null 2>&1 || \
    ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
    echo "Node 24 is required for production deploy." >&2
    exit 1
  fi
}

is_exact_deploy_target_image_ref() {
  local image_ref="$1"
  local image_repository="$2"

  [[ -n "${TARGET_SHA:-}" ]] &&
    [[ "$TARGET_SHA" == "${EXPECTED_DEPLOY_SHA:-}" ]] &&
    [[ "$image_ref" == "${image_repository}:${TARGET_SHA}" ]]
}

verified_preloaded_target_image() {
  local image_ref="$1"
  local labels

  if ! labels="$(
    docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}' \
      "$image_ref" 2>/dev/null
  )"; then
    echo "Selected immutable target image is not local and requires a build: $image_ref" >&2
    return 1
  fi
  if [[ "$labels" != "${TARGET_SHA}|true" ]]; then
    echo "Selected target image has unverified release labels: $image_ref ($labels)" >&2
    return 1
  fi
}

selected_target_images_are_preloaded() {
  local service
  local image_ref
  local image_repository
  local selected_count=0
  local checked_refs=()

  if [[ -z "${TARGET_SHA:-}" ]] || [[ "$TARGET_SHA" != "${EXPECTED_DEPLOY_SHA:-}" ]]; then
    echo "Deploy disk preflight cannot be skipped without the verified exact target SHA." >&2
    return 1
  fi

  for service in "${SERVICES[@]}"; do
    if contains_service "$service" "${API_SERVICES[@]}"; then
      if [[ "${BUILD_API_IMAGE:-0}" -ne 1 ]]; then
        echo "Deploy disk preflight cannot be skipped for an unresolved API build target." >&2
        return 1
      fi
      image_ref="${MAXIM_API_IMAGE:-}"
      image_repository="maxim-api"
    else
      case "$service" in
        miniapp-major-static)
          image_ref="${MAXIM_MINIAPP_MAJOR_IMAGE:-}"
          image_repository="maxim-miniapp-major"
          ;;
        admin-static)
          image_ref="${MAXIM_ADMIN_IMAGE:-}"
          image_repository="maxim-admin"
          ;;
        miniapp-static)
          image_ref="${MAXIM_MINIAPP_LEGACY_IMAGE:-}"
          image_repository="maxim-miniapp-legacy"
          ;;
        *)
          echo "Deploy disk preflight cannot be skipped for unknown target: $service" >&2
          return 1
          ;;
      esac
    fi

    if contains_service "$image_ref" "${checked_refs[@]}"; then
      continue
    fi
    checked_refs+=("$image_ref")
    selected_count=$((selected_count + 1))

    if ! is_exact_deploy_target_image_ref "$image_ref" "$image_repository"; then
      echo "Deploy disk preflight cannot be skipped for a non-target image ref: ${image_ref:-unset}" >&2
      return 1
    fi
    if ! verified_preloaded_target_image "$image_ref"; then
      return 1
    fi
  done

  if [[ "$selected_count" -eq 0 ]]; then
    echo "Deploy disk preflight cannot be skipped without a resolved image target." >&2
    return 1
  fi
}

prepare_deploy_disk_capacity() {
  local needs_static_build=0
  local service

  REUSE_PRELOADED_TARGET_IMAGES_ONLY=0
  if selected_target_images_are_preloaded; then
    REUSE_PRELOADED_TARGET_IMAGES_ONLY=1
    echo "Skipping deploy build disk preflight: every selected exact immutable target image is already local for $TARGET_SHA."
    return 0
  fi

  for service in "${SERVICES[@]}"; do
    case "$service" in
      miniapp-static|miniapp-major-static|admin-static)
        needs_static_build=1
        ;;
      api-*)
        ;;
      *)
        echo "Unknown deploy target reached disk preflight: $service" >&2
        maxim_check_deploy_disk_capacity 1 1
        return
        ;;
    esac
  done

  maxim_check_deploy_disk_capacity "$BUILD_API_IMAGE" "$needs_static_build"
}

require_preloaded_target_image() {
  local image_ref="$1"

  if verified_preloaded_target_image "$image_ref"; then
    return 0
  fi

  echo "Preloaded target image disappeared or lost verified labels after the build disk preflight was skipped: $image_ref" >&2
  echo "Refusing fallback build; restore the exact image or satisfy the disk build preflight." >&2
  return 1
}

validate_deploy_branch() {
  if [[ -z "$BRANCH" ]]; then
    echo "Deploy branch must not be empty." >&2
    exit 2
  fi

  if [[ ! "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] ||
     [[ "$BRANCH" == *..* ]] ||
     [[ "$BRANCH" == *//* ]] ||
     [[ "$BRANCH" == */ ]] ||
     [[ "$BRANCH" == *. ]] ||
     [[ "$BRANCH" == *.lock ]] ||
     [[ "$BRANCH" == *"@{"* ]]; then
    echo "Refusing unsafe deploy branch name: $BRANCH" >&2
    exit 2
  fi

  if ! git check-ref-format --branch "$BRANCH" >/dev/null 2>&1; then
    echo "Refusing invalid git branch name: $BRANCH" >&2
    exit 2
  fi
}

require_production_branch_confirmation() {
  validate_deploy_branch

  if [[ "$BRANCH" == "main" ]]; then
    return 0
  fi

  if is_enabled "${MAXIM_ALLOW_NON_MAIN_DEPLOY:-0}"; then
    echo "WARNING: deploying non-main branch to production by explicit request: $BRANCH" >&2
    return 0
  fi

  cat >&2 <<EOF
Refusing production deploy from non-main branch: $BRANCH
Production deploys default to main. Set MAXIM_ALLOW_NON_MAIN_DEPLOY=1 only when this non-main deploy is intentional.
EOF
  exit 2
}

verify_expected_deploy_sha() {
  local actual_sha

  if [[ -z "$EXPECTED_DEPLOY_SHA" ]]; then
    if [[ "$DEPLOY_MODE" == "plan" ]]; then
      echo "Read-only deploy plan has no MAXIM_EXPECTED_DEPLOY_SHA; no rollout will run." >&2
      return 0
    fi
    echo "MAXIM_EXPECTED_DEPLOY_SHA is required for every mutating production deploy." >&2
    echo "Use the guarded local wrapper/workflow or pass the reviewed full target SHA." >&2
    exit 2
  fi

  if [[ ! "$EXPECTED_DEPLOY_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    echo "MAXIM_EXPECTED_DEPLOY_SHA must be a full lowercase Git object id." >&2
    exit 2
  fi

  actual_sha="$(git rev-parse HEAD)"
  if [[ "$actual_sha" != "$EXPECTED_DEPLOY_SHA" ]]; then
    cat >&2 <<EOF
Refusing deploy because the synchronized VPS commit does not match the local requested commit.
Expected: $EXPECTED_DEPLOY_SHA
Actual:   $actual_sha
Update/push the local branch or choose the intended branch, then retry.
EOF
    exit 2
  fi

  echo "Deploy commit verified: $actual_sha"
}

ensure_service_requested_if_down() {
  local service="$1"

  if contains_service "$service" "${SERVICES[@]}"; then
    return 0
  fi

  if docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx "$service"; then
    return 0
  fi

  echo "$service is not running. Including it in this deploy to restore availability."
  SERVICES+=("$service")
}

warn_legacy_miniapp_static_target() {
  if ! contains_service "miniapp-static" "${SERVICES[@]}"; then
    return 0
  fi

  cat >&2 <<'EOF'
WARNING: miniapp-static serves legacy https://maxim.play-team.ru/app/.
Routine production mini app deploys should target miniapp-major-static for https://major-maksimov.ru/app/.
Continue only if you intentionally need the legacy support static container.
EOF
}

has_pulled_changes() {
  [[ -n "$PRE_PULL_HEAD" ]] && [[ "$PRE_PULL_HEAD" != "$(git rev-parse HEAD)" ]]
}

diff_in_paths() {
  local status=0

  if ! has_pulled_changes; then
    return 1
  fi

  git diff --quiet "$PRE_PULL_HEAD" HEAD -- "$@" >/dev/null 2>&1 || status=$?
  case "$status" in
    0) return 1 ;;
    1) return 0 ;;
    *) return 1 ;;
  esac
}

reexec_if_current_script_changed() {
  if [[ "${MAXIM_DEPLOY_SCRIPT_REEXECED:-0}" == "1" ]]; then
    return 0
  fi

  if ! diff_in_paths \
    "$SCRIPT_REL_PATH" \
    "infra/scripts/lib/deploy-disk-capacity.sh" \
    "infra/scripts/lib/deploy-lock.sh" \
    "infra/scripts/lib/deploy-topology.sh" \
    "infra/scripts/lib/webhook-rollout-quiescence.sh" \
    "infra/scripts/lib/change-impact-components.generated.sh"; then
    return 0
  fi

  echo "Deploy runtime tooling changed during git pull. Re-executing updated $SCRIPT_REL_PATH..."
  export MAXIM_DEPLOY_SCRIPT_REEXECED=1
  exec "$SCRIPT_PATH" "${ORIGINAL_ARGS[@]}"
}

ensure_compose_env() {
  local tmp_env
  local container_name
  local restore_candidates=(
    "infra-api-ingress-1"
    "infra-api-admin-1"
    "infra-api-enqueue-1"
    "infra-api-moderation-1"
    "infra-api-moderation-critical-1"
    "infra-api-moderation-join-1"
    "infra-api-moderation-realtime-b-1"
    "infra-api-moderation-realtime-c-1"
    "infra-api-moderation-realtime-d-1"
    "infra-api-moderation-background-1"
    "infra-api-media-analysis-1"
    "infra-api-action-1"
    "infra-api-1"
  )

  if [[ -s .env ]]; then
    return 0
  fi

  for container_name in "${restore_candidates[@]}"; do
    if docker ps --format '{{.Names}}' | grep -qx "$container_name"; then
      echo "Missing .env. Restoring it from $container_name container env..."
      tmp_env="$(mktemp .env.restore.XXXXXX)"
      if docker inspect "$container_name" --format '{{range .Config.Env}}{{println .}}{{end}}' \
        | awk '!/^(PATH|NODE_VERSION|YARN_VERSION)=/' >"$tmp_env" && [[ -s "$tmp_env" ]]; then
        mv "$tmp_env" .env
        return 0
      fi

      rm -f "$tmp_env"
      echo "Failed to restore /var/www/Chat_bot/.env from $container_name container env."
      return 1
    fi
  done

  echo "Missing /var/www/Chat_bot/.env and no running API container is available for restore."
  echo "Create .env manually, then rerun the deploy."
  return 1
}

validate_admin_access_code() {
  local code
  local normalized

  code="$(
    awk '
      /^[[:space:]]*ADMIN_ACCESS_CODE[[:space:]]*=/ {
        sub(/^[[:space:]]*ADMIN_ACCESS_CODE[[:space:]]*=[[:space:]]*/, "")
        value = $0
      }
      END { print value }
    ' .env
  )"
  code="${code%$'\r'}"
  code="$(printf '%s' "$code" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if ((${#code} >= 2)) && [[ "$code" == \"*\" && "$code" == *\" ]]; then
    code="${code:1:${#code}-2}"
  elif ((${#code} >= 2)) && [[ "$code" == \'*\' && "$code" == *\' ]]; then
    code="${code:1:${#code}-2}"
  fi
  code="$(printf '%s' "$code" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  normalized="${code,,}"

  if ((${#code} < 6 || ${#code} > 256)); then
    echo "Refusing deploy: ADMIN_ACCESS_CODE must contain 6-256 characters." >&2
    return 1
  fi
  case "$normalized" in
    change-me|changeme|replace-me|replace-with-random-admin-code)
      echo "Refusing deploy: ADMIN_ACCESS_CODE still uses a documented placeholder." >&2
      return 1
      ;;
  esac

  echo "Safety Desk server-side access code preflight passed."
}

warn_postgres_password_fallback() {
  if [[ -f .env ]] && grep -Eq '^[[:space:]]*POSTGRES_PASSWORD=.+$' .env; then
    return 0
  fi

  cat >&2 <<'EOF'
WARNING: POSTGRES_PASSWORD is not set in .env; docker compose will use the legacy compatibility fallback.
Set POSTGRES_PASSWORD to the current database password before intentionally recreating postgres.
EOF
}

sync_branch() {
  local stash_name
  local tracked_status

  git fetch origin "$BRANCH"

  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git checkout "$BRANCH"
  else
    git checkout -b "$BRANCH" "origin/$BRANCH"
  fi

  PRE_PULL_HEAD="$(git rev-parse HEAD)"
  tracked_status="$(git status --porcelain --untracked-files=no)"

  if [[ -n "$tracked_status" ]]; then
    if git diff --quiet "origin/$BRANCH" -- && git diff --cached --quiet "origin/$BRANCH" --; then
      stash_name="codex-sync-${BRANCH}-$(date +%Y%m%d-%H%M%S)"
      echo "Worktree matches origin/$BRANCH but blocks ff-only pull. Stashing snapshot: $stash_name"
      git stash push -m "$stash_name" >/dev/null
      git pull --ff-only origin "$BRANCH"
      git stash drop "stash@{0}" >/dev/null || true
      return 0
    fi

    echo "VPS worktree has local changes that do not match origin/$BRANCH."
    git status --short
    git diff --stat -- . ':(exclude).env' || true
    return 1
  fi

  git pull --ff-only origin "$BRANCH"
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS --connect-timeout 5 --max-time 15 "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "Health check timeout: $url"
  return 1
}

verify_service_image_id() {
  local service="$1"
  local expected_image_id="$2"
  local container_id
  local actual_image_id

  container_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    echo "Cannot verify image for missing service container: $service" >&2
    return 1
  fi
  actual_image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  if [[ "$actual_image_id" != "$expected_image_id" ]]; then
    echo "$service runs $actual_image_id, expected $expected_image_id." >&2
    return 1
  fi
}

verify_inherited_api_component() {
  local expected_image_id="$1"
  local source_sha
  local topology_status
  local service
  local media_container_ids
  local publisher_container_ids
  local inherited_api_services=("${API_SERVICES[@]}")

  source_sha="$(release_field api-shared sourceSha)"
  if ! git cat-file -e "${source_sha}^{commit}" 2>/dev/null; then
    echo "Cannot verify inherited API topology at source $source_sha." >&2
    return 1
  fi
  if maxim_topology_git_compose_has_service "$source_sha" "$MAXIM_PUBLISHER_SERVICE"; then
    :
  else
    topology_status=$?
    if [[ "$topology_status" -ne 1 ]]; then
      return "$topology_status"
    fi
    maxim_topology_remove_service inherited_api_services "$MAXIM_PUBLISHER_SERVICE"
    if ! publisher_container_ids="$(
      docker ps -a -q \
        --filter "label=com.docker.compose.project=$MAIN_PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$MAXIM_PUBLISHER_SERVICE"
    )"; then
      echo "Could not inspect inherited publisher container state." >&2
      return 1
    fi
    if [[ -n "$publisher_container_ids" ]]; then
      echo "Inherited API runtime contains publisher absent from its source topology." >&2
      return 1
    fi
  fi
  if maxim_topology_git_compose_has_service "$source_sha" "$MAXIM_MEDIA_ANALYSIS_SERVICE"; then
    :
  else
    topology_status=$?
    if [[ "$topology_status" -ne 1 ]]; then
      return "$topology_status"
    fi
    maxim_topology_remove_service inherited_api_services "$MAXIM_MEDIA_ANALYSIS_SERVICE"
    if ! media_container_ids="$(
      docker ps -a -q \
        --filter "label=com.docker.compose.project=$MAIN_PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$MAXIM_MEDIA_ANALYSIS_SERVICE"
    )"; then
      echo "Could not inspect inherited media-analysis container state." >&2
      return 1
    fi
    if [[ -n "$media_container_ids" ]]; then
      echo "Inherited API runtime contains media analysis absent from its source topology." >&2
      return 1
    fi
  fi
  for service in "${inherited_api_services[@]}"; do
    verify_service_image_id "$service" "$expected_image_id"
  done
  maxim_topology_verify_ocr_native_sandbox_for_image COMPOSE_FILES "$expected_image_id"
}

verify_inherited_release_components() {
  local component
  local expected_image_id

  for component in api-shared miniapp-major-static admin-static; do
    if contains_service "$component" "${DEPLOYED_COMPONENTS[@]}"; then
      continue
    fi
    expected_image_id="$(release_field "$component" imageId || true)"
    if [[ ! "$expected_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "Inherited release component lacks a known image id: $component" >&2
      return 1
    fi
    case "$component" in
      api-shared)
        verify_inherited_api_component "$expected_image_id"
        ;;
      miniapp-major-static)
        verify_service_image_id miniapp-major-static "$expected_image_id"
        ;;
      admin-static)
        verify_service_image_id admin-static "$expected_image_id"
        ;;
    esac
  done
}

record_successful_release() {
  local migrations_file=""
  local component
  local image_ref
  local image_id
  local service
  local args=(
    commit
    --release-id "$RELEASE_ID"
    --target-sha "$TARGET_SHA"
  )

  for component in "${DEPLOYED_COMPONENTS[@]}"; do
    case "$component" in
      api-shared)
        image_ref="$MAXIM_API_IMAGE"
        service="api-ingress"
        ;;
      miniapp-major-static)
        image_ref="$MAXIM_MINIAPP_MAJOR_IMAGE"
        service="miniapp-major-static"
        ;;
      admin-static)
        image_ref="$MAXIM_ADMIN_IMAGE"
        service="admin-static"
        ;;
      *)
        echo "Cannot record unknown release component: $component" >&2
        return 1
        ;;
    esac
    image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
    if [[ "$component" == "api-shared" ]]; then
      for service in "${API_SERVICES[@]}"; do
        verify_service_image_id "$service" "$image_id"
      done
      maxim_topology_verify_ocr_native_sandbox_for_image COMPOSE_FILES "$image_id"
    else
      verify_service_image_id "$service" "$image_id"
    fi
    args+=(--component "${component}|${TARGET_SHA}|${image_ref}|${image_id}")
  done
  verify_inherited_release_components

  if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
    migrations_file="$(mktemp)"
    docker compose "${COMPOSE_FILES[@]}" exec -T postgres psql -U maxim -d maxim -Atc \
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;" \
      >"$migrations_file"
    args+=(--migrations-file "$migrations_file")
  fi
  for smoke in "${SMOKE_RESULTS[@]}"; do
    args+=(--smoke "$smoke")
  done
  if [[ -n "${MAXIM_DEPLOY_EMERGENCY_REASON:-}" ]]; then
    args+=(--emergency-reason "$MAXIM_DEPLOY_EMERGENCY_REASON")
  fi
  if [[ -n "$RECOVERY_BASE_MANIFEST" ]]; then
    args+=(--current-manifest-file "$RECOVERY_BASE_MANIFEST")
  fi

  if ! release_manifest "${args[@]}" >/dev/null; then
    [[ -z "$migrations_file" ]] || rm -f "$migrations_file"
    return 1
  fi
  [[ -z "$migrations_file" ]] || rm -f "$migrations_file"
  DEPLOY_MANIFEST_RECORDED=1
  archive_recovery_base_manifest
  echo "Release manifest committed: $RELEASE_ID"
}

wait_for_postgres() {
  local attempts="${1:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if docker compose "${COMPOSE_FILES[@]}" exec -T postgres pg_isready -U maxim -d maxim >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Postgres readiness timeout."
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 postgres || true
  return 1
}

wait_for_redis() {
  local attempts="${1:-60}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if docker compose "${COMPOSE_FILES[@]}" exec -T redis redis-cli ping 2>/dev/null | grep -qx PONG; then
      return 0
    fi
    sleep 1
  done

  echo "Redis readiness timeout."
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 redis || true
  return 1
}

require_stateful_services_ready() {
  local running_services
  local service

  running_services="$(docker compose "${COMPOSE_FILES[@]}" ps --status running --services)"
  for service in postgres redis; do
    if ! grep -qx "$service" <<<"$running_services"; then
      echo "$service is not already running; refusing application deploy instead of starting or recreating a stateful service." >&2
      return 1
    fi
  done

  wait_for_postgres 180
  wait_for_redis 60
}

wait_for_service_running() {
  local service="$1"
  local attempts="${2:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx "$service"; then
      return 0
    fi
    sleep 1
  done

  echo "Service failed to reach running state: $service"
  docker compose "${COMPOSE_FILES[@]}" ps "$service" || true
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 "$service" || true
  return 1
}

recreate_service_wave() {
  local label="$1"
  shift
  local requested_services=()
  local service

  for service in "$@"; do
    if contains_service "$service" "${SERVICES[@]}"; then
      requested_services+=("$service")
    fi
  done

  if [[ "${#requested_services[@]}" -eq 0 ]]; then
    return 0
  fi

  echo "Recreating $label services: ${requested_services[*]}"
  local batch_size_name="MAXIM_DEPLOY_RECREATE_BATCH_SIZE"
  local batch_delay_name="MAXIM_DEPLOY_RECREATE_BATCH_DELAY_SEC"
  local batch_size="${MAXIM_DEPLOY_RECREATE_BATCH_SIZE:-0}"
  local batch_delay_sec="${MAXIM_DEPLOY_RECREATE_BATCH_DELAY_SEC:-0}"
  if [[ "$label" == "worker" || "$label" == "action" || "$label" == "moderation" || \
        "$label" == "enqueue" || "$label" == "admin" || "$label" == "ingress" ]]; then
    batch_size_name="MAXIM_DEPLOY_API_RECREATE_BATCH_SIZE"
    batch_delay_name="MAXIM_DEPLOY_API_RECREATE_BATCH_DELAY_SEC"
    batch_size="${MAXIM_DEPLOY_API_RECREATE_BATCH_SIZE:-1}"
    batch_delay_sec="${MAXIM_DEPLOY_API_RECREATE_BATCH_DELAY_SEC:-5}"
  fi
  if [[ "$label" == "worker" || "$label" == "action" || "$label" == "moderation" || \
        "$label" == "enqueue" ]]; then
    batch_size_name="MAXIM_DEPLOY_WORKER_RECREATE_BATCH_SIZE"
    batch_delay_name="MAXIM_DEPLOY_WORKER_RECREATE_BATCH_DELAY_SEC"
    batch_size="${MAXIM_DEPLOY_WORKER_RECREATE_BATCH_SIZE:-$batch_size}"
    batch_delay_sec="${MAXIM_DEPLOY_WORKER_RECREATE_BATCH_DELAY_SEC:-$batch_delay_sec}"
  fi
  validate_nonnegative_int "$batch_size_name" "$batch_size"
  validate_nonnegative_int "$batch_delay_name" "$batch_delay_sec"

  if [[ "$batch_size" -eq 0 ]] || [[ "$batch_size" -ge "${#requested_services[@]}" ]]; then
    docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate "${requested_services[@]}"

    for service in "${requested_services[@]}"; do
      wait_for_service_running "$service" 180
    done
    return 0
  fi

  local batch=()
  local start
  local end
  local index
  for ((start = 0; start < ${#requested_services[@]}; start += batch_size)); do
    end=$((start + batch_size))
    if [[ "$end" -gt "${#requested_services[@]}" ]]; then
      end="${#requested_services[@]}"
    fi
    batch=()
    for ((index = start; index < end; index += 1)); do
      batch+=("${requested_services[$index]}")
    done

    echo "Recreating $label services batch: ${batch[*]}"
    docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate "${batch[@]}"
    for service in "${batch[@]}"; do
      wait_for_service_running "$service" 180
    done

    if [[ "$end" -lt "${#requested_services[@]}" ]] && [[ "$batch_delay_sec" -gt 0 ]]; then
      sleep "$batch_delay_sec"
    fi
  done
}

validate_nonnegative_int() {
  local name="$1"
  local value="$2"

  if [[ "$value" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  echo "$name must be a non-negative integer." >&2
  exit 1
}

ensure_requested_services_running() {
  local excluded_service="${1:-}"
  local service

  for service in "${SERVICES[@]}"; do
    if [[ -n "$excluded_service" && "$service" == "$excluded_service" ]]; then
      continue
    fi
    if docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx "$service"; then
      continue
    fi

    echo "Requested service $service is not running after deploy waves. Recreating it explicitly..."
    docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate "$service"
    wait_for_service_running "$service" 180
  done
}

stop_conflicting_stacks() {
  docker compose "${ALTERNATE_COMPOSE_FILES[@]}" down --remove-orphans >/dev/null 2>&1 || true
}

remove_stale_service_containers() {
  local service
  local container_id
  local state
  local container_ids=()

  for service in "$@"; do
    mapfile -t container_ids < <(docker compose "${COMPOSE_FILES[@]}" ps -a -q "$service" 2>/dev/null || true)
    for container_id in "${container_ids[@]}"; do
      [[ -n "$container_id" ]] || continue
      state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      case "$state" in
        running|restarting|paused)
          continue
          ;;
      esac

      echo "Removing stale $service container: $container_id (state=${state:-unknown})"
      docker rm -f "$container_id" >/dev/null 2>&1 || true
    done
  done
}

run_migrations() {
  ensure_compose_env
  MAXIM_MIGRATION_API_IMAGE="$MAXIM_API_IMAGE" \
    docker compose "${MIGRATION_COMPOSE_FILES[@]}" run --rm --no-deps --pull never api-ingress \
    ./node_modules/.bin/prisma migrate deploy --config apps/api/prisma.config.ts
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

require_node_24
require_production_branch_confirmation
validate_requested_services
validate_api_ready_timeout
acquire_deploy_lock
trap cleanup EXIT
sync_branch
verify_expected_deploy_sha
reexec_if_current_script_changed
if [[ "$DEPLOY_MODE" == "plan" ]]; then
  load_current_component_images
  print_deploy_plan
  exit 0
fi
ensure_compose_env
initialize_release_inventory
load_current_component_images
if [[ "$DEPLOY_MODE" == "auto" ]]; then
  derive_auto_services
  validate_requested_services
  if [[ "${#SERVICES[@]}" -eq 0 && -z "$RECOVERY_BASE_MANIFEST" ]]; then
    echo "No production components require deployment."
    exit 0
  fi
fi
if [[ -n "$RECOVERY_BASE_MANIFEST" ]]; then
  for recovery_service in api-ingress miniapp-major-static admin-static; do
    if ! contains_service "$recovery_service" "${SERVICES[@]}"; then
      SERVICES+=("$recovery_service")
    fi
  done
  echo "Interrupted release recovery selected every active component for full reconciliation."
fi
validate_admin_access_code
warn_postgres_password_fallback

BUILD_API_IMAGE=0
for service in "${API_SERVICES[@]}"; do
  if contains_service "$service" "${SERVICES[@]}"; then
    BUILD_API_IMAGE=1
    break
  fi
done

if [[ "$BUILD_API_IMAGE" -eq 0 ]] && impact_plan_selects_component api-shared; then
  BUILD_API_IMAGE=1
  SERVICES+=("api-ingress")
  echo "Unreleased API impact detected from the api-shared component manifest."
fi

if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  maxim_topology_expand_api_services SERVICES \
    "Shared API image build or API-related diff detected."
fi

if ! contains_service "miniapp-major-static" "${SERVICES[@]}" && impact_plan_selects_component miniapp-major-static; then
  SERVICES+=("miniapp-major-static")
  echo "Unreleased Major mini app impact detected from the component manifest."
fi
if ! contains_service "admin-static" "${SERVICES[@]}" && impact_plan_selects_component admin-static; then
  SERVICES+=("admin-static")
  echo "Unreleased Safety Desk impact detected from the component manifest."
fi
validate_requested_services

if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  maxim_topology_refuse_dirty_api_build_inputs
fi

TARGET_SHA="$(git rev-parse HEAD)"
RELEASE_ID="release-$(date -u +%Y%m%dT%H%M%SZ)-${TARGET_SHA:0:12}"
TARGET_HAS_MEDIA_ANALYSIS=0
TARGET_HAS_OCR_NATIVE_SANDBOX=0
TARGET_COMMERCIAL_OCR_VERSION=""
if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  maxim_topology_require_publisher_secret_files
  maxim_topology_prepare_commercial_ocr_target \
    "$TARGET_SHA" \
    COMPOSE_FILES \
    TARGET_HAS_MEDIA_ANALYSIS \
    TARGET_COMMERCIAL_OCR_VERSION \
    TARGET_HAS_OCR_NATIVE_SANDBOX
fi
DEPLOYED_COMPONENTS=()
if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  export MAXIM_API_IMAGE="maxim-api:${TARGET_SHA}"
  DEPLOYED_COMPONENTS+=("api-shared")
fi
if contains_service "miniapp-major-static" "${SERVICES[@]}"; then
  export MAXIM_MINIAPP_MAJOR_IMAGE="maxim-miniapp-major:${TARGET_SHA}"
  DEPLOYED_COMPONENTS+=("miniapp-major-static")
fi
if contains_service "admin-static" "${SERVICES[@]}"; then
  export MAXIM_ADMIN_IMAGE="maxim-admin:${TARGET_SHA}"
  DEPLOYED_COMPONENTS+=("admin-static")
fi
if contains_service "miniapp-static" "${SERVICES[@]}"; then
  export MAXIM_MINIAPP_LEGACY_IMAGE="maxim-miniapp-legacy:${TARGET_SHA}"
fi

prepare_deploy_disk_capacity
stop_conflicting_stacks
warn_legacy_miniapp_static_target

if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  require_stateful_services_ready
  if [[ "$REUSE_PRELOADED_TARGET_IMAGES_ONLY" -eq 1 ]]; then
    require_preloaded_target_image "$MAXIM_API_IMAGE"
    echo "Reusing existing immutable API image: $MAXIM_API_IMAGE"
  else
    if docker image inspect "$MAXIM_API_IMAGE" >/dev/null 2>&1 &&
       ! verified_preloaded_target_image "$MAXIM_API_IMAGE"; then
      echo "Refusing to reuse or overwrite an unverified exact-SHA API image." >&2
      exit 1
    fi
    maxim_topology_build_shared_api_image "$MAXIM_API_IMAGE" "$TARGET_SHA"
  fi
  maxim_topology_require_ocr_native_sandbox_image_capability \
    "$MAXIM_API_IMAGE" "$TARGET_HAS_OCR_NATIVE_SANDBOX"
  begin_release_runtime_transition
  DEPLOY_RUNTIME_STARTED=1
  verify_inherited_release_components
  if ! run_migrations; then
    echo "First migration attempt failed. Retrying once in 5 seconds..."
    sleep 5
    run_migrations
  fi
fi

SERVICES_TO_BUILD=()
for service in "${SERVICES[@]}"; do
  if [[ "$BUILD_API_IMAGE" -eq 1 ]] && contains_service "$service" "${API_SERVICES[@]}"; then
    continue
  fi
  SERVICES_TO_BUILD+=("$service")
done

for service in "${SERVICES_TO_BUILD[@]}"; do
  case "$service" in
    miniapp-static) candidate_image_ref="$MAXIM_MINIAPP_LEGACY_IMAGE" ;;
    miniapp-major-static) candidate_image_ref="$MAXIM_MINIAPP_MAJOR_IMAGE" ;;
    admin-static) candidate_image_ref="$MAXIM_ADMIN_IMAGE" ;;
    *)
      echo "Refusing unexpected non-API build target: $service" >&2
      exit 2
      ;;
  esac
  if docker image inspect "$candidate_image_ref" >/dev/null 2>&1 &&
     verified_preloaded_target_image "$candidate_image_ref"; then
    echo "Reusing existing immutable static image: $candidate_image_ref"
  elif docker image inspect "$candidate_image_ref" >/dev/null 2>&1; then
    echo "Refusing to reuse or overwrite an unverified exact-SHA static image: $candidate_image_ref" >&2
    exit 1
  elif [[ "$REUSE_PRELOADED_TARGET_IMAGES_ONLY" -eq 1 ]]; then
    require_preloaded_target_image "$candidate_image_ref"
  else
    docker compose "${COMPOSE_FILES[@]}" build "$service"
  fi
done

ensure_compose_env
if [[ "${#DEPLOYED_COMPONENTS[@]}" -gt 0 ]]; then
  begin_release_runtime_transition
  DEPLOY_RUNTIME_STARTED=1
  verify_inherited_release_components
fi
remove_stale_service_containers "${SERVICES[@]}"
if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  expected_api_image_id="$(docker image inspect --format '{{.Id}}' "$MAXIM_API_IMAGE")"
  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES
  if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
    maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
    maxim_topology_stop_media_analysis_before_api_transition COMPOSE_FILES
  fi

  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service_wave "action and publisher" "api-action" "api-publisher"
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service_wave "admin" "api-admin"
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service_wave "ingress" "api-ingress"
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  if [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_recreate_ocr_native_sandbox COMPOSE_FILES "$expected_api_image_id"
    maxim_topology_smoke_ocr_native_sandbox_uds \
      COMPOSE_FILES "$expected_api_image_id" prestart
  else
    maxim_topology_remove_ocr_native_sandbox_container COMPOSE_FILES
  fi
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service_wave "media analysis" "$MAXIM_MEDIA_ANALYSIS_SERVICE"
  if [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "$expected_api_image_id" with-media
  fi

  # FLAG: Webhook consumers and the enqueue producer start only after every non-webhook API role
  # is already on the target image and the owned global pause has been re-proven.
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service_wave "moderation" \
    "api-moderation" \
    "api-moderation-critical" \
    "api-moderation-join" \
    "api-moderation-realtime-b" \
    "api-moderation-realtime-c" \
    "api-moderation-realtime-d" \
    "api-moderation-background"
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  recreate_service_wave "enqueue" "api-enqueue"
  maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
fi
ensure_requested_services_running "$MAXIM_MEDIA_ANALYSIS_SERVICE"
if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
  maxim_topology_verify_api_commercial_ocr_version \
    COMPOSE_FILES \
    "$TARGET_COMMERCIAL_OCR_VERSION"
fi
if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  for service in "${API_SERVICES[@]}"; do
    verify_service_image_id "$service" "$expected_api_image_id"
  done
  if [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "$expected_api_image_id" with-media
  else
    maxim_topology_require_ocr_native_sandbox_absent COMPOSE_FILES
  fi
  wait_for_url "http://127.0.0.1:3001/api/health/live" 180
  wait_for_url "http://127.0.0.1:3002/api/health/live" 180
  maxim_webhook_resume_after_api_fence COMPOSE_FILES
fi
recreate_service_wave "support static" "miniapp-static"
recreate_service_wave "major static" "miniapp-major-static"
recreate_service_wave "admin static" "admin-static"

SMOKE_RESULTS=()
if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  wait_for_url "http://127.0.0.1:3001/api/health/live" 180
  # Ingress remains live while consumers are fenced, so real traffic can require a bounded drain.
  wait_for_url "http://127.0.0.1:3001/api/health/ready" "$API_READY_TIMEOUT_SEC"
  wait_for_url "http://127.0.0.1:3002/api/health/live" 180
  wait_for_url "http://127.0.0.1:3002/api/health/ready" "$API_READY_TIMEOUT_SEC"
  wait_for_url "$PUBLIC_HEALTH_URL/api/health/live" 180
  node scripts/smoke-http.mjs json-ok http://127.0.0.1:3001/api/health/live
  node scripts/smoke-http.mjs json-ok http://127.0.0.1:3001/api/health/ready
  node scripts/smoke-http.mjs json-ok http://127.0.0.1:3002/api/health/live
  node scripts/smoke-http.mjs json-ok http://127.0.0.1:3002/api/health/ready
  node scripts/smoke-http.mjs json-ok "$PUBLIC_HEALTH_URL/api/health/live"
  SMOKE_RESULTS+=("api-local-live" "api-local-ready" "api-admin-live" "api-admin-ready" "api-public-live")
  if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
    if [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
      maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required sandbox
    else
      maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required legacy
    fi
    SMOKE_RESULTS+=(
      "api-commercial-ocr-version"
      "api-media-analysis-tesseract-rus-eng"
      "api-media-analysis-shadow"
      "api-media-analysis-native-raster"
      "api-media-analysis-internal-ready"
    )
    if [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
      SMOKE_RESULTS+=(
        "api-ocr-native-sandbox-isolation"
        "api-ocr-native-sandbox-uds"
        "api-ocr-native-sandbox-process-clean"
      )
    fi
  fi
fi

if contains_service "miniapp-static" "${SERVICES[@]}"; then
  node scripts/smoke-http.mjs static https://maxim.play-team.ru/app/
fi
if contains_service "miniapp-major-static" "${SERVICES[@]}"; then
  node scripts/smoke-http.mjs static https://major-maksimov.ru/app/
  SMOKE_RESULTS+=("miniapp-major-static")
fi
if contains_service "admin-static" "${SERVICES[@]}"; then
  node scripts/smoke-http.mjs static http://127.0.0.1:3004/
  SMOKE_RESULTS+=("admin-static")
fi

if [[ "${#DEPLOYED_COMPONENTS[@]}" -gt 0 ]]; then
  record_successful_release
else
  echo "No active release component changed; current release manifest was preserved."
fi
echo "Done: branch=$BRANCH services=${SERVICES[*]}"
