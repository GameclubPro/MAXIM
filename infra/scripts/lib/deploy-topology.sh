#!/usr/bin/env bash

MAXIM_PRODUCTION_API_SERVICES=(
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
)

MAXIM_MEDIA_ANALYSIS_SERVICE="api-media-analysis"

maxim_topology_contains() {
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

maxim_topology_is_api_service() {
  maxim_topology_contains "$1" "${MAXIM_PRODUCTION_API_SERVICES[@]}"
}

maxim_topology_remove_service() {
  local services_var="$1"
  local removed_service="$2"
  local -n services_ref="$services_var"
  local service
  local filtered=()

  for service in "${services_ref[@]}"; do
    [[ "$service" == "$removed_service" ]] || filtered+=("$service")
  done
  services_ref=("${filtered[@]}")
}

maxim_topology_git_compose_has_service() {
  local commit_sha="$1"
  local service="$2"
  local compose_path="infra/docker-compose.yml"

  if ! git cat-file -e "${commit_sha}:${compose_path}" 2>/dev/null; then
    echo "Target commit is missing $compose_path: $commit_sha" >&2
    return 2
  fi
  git show "${commit_sha}:${compose_path}" | awk -v service="$service" '
    {
      line = $0
      sub(/[[:space:]]+$/, "", line)
      if (line == "  " service ":") {
        found = 1
      }
    }
    END { exit found ? 0 : 1 }
  '
}

maxim_topology_git_has_commercial_ocr_raster_smoke() {
  local commit_sha="$1"

  git cat-file -e \
    "${commit_sha}:apps/api/src/scripts/smoke-commercial-ocr-worker.ts" 2>/dev/null
}

maxim_topology_git_commercial_ocr_version() {
  local commit_sha="$1"
  local source_path="apps/api/src/moderation/commercial-ocr/commercial-ocr.queue.ts"
  local source
  local version
  local versions=()

  if ! source="$(git show "${commit_sha}:${source_path}" 2>/dev/null)"; then
    echo "Target commit is missing the commercial OCR behavior version source: $commit_sha" >&2
    return 1
  fi

  mapfile -t versions < <(
    printf '%s\n' "$source" | sed -nE \
      -e "s/^[[:space:]]*export const COMMERCIAL_OCR_DEFAULT_VERSION[[:space:]]*=[[:space:]]*'([^']+)'([[:space:]]+as[[:space:]]+const)?;[[:space:]]*$/\\1/p" \
      -e 's/^[[:space:]]*export const COMMERCIAL_OCR_DEFAULT_VERSION[[:space:]]*=[[:space:]]*"([^"]+)"([[:space:]]+as[[:space:]]+const)?;[[:space:]]*$/\1/p'
  )
  if [[ "${#versions[@]}" -ne 1 ]]; then
    echo "Target commit must define exactly one literal COMMERCIAL_OCR_DEFAULT_VERSION: $commit_sha" >&2
    return 1
  fi

  version="${versions[0]}"
  if [[ ! "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "Target commit defines an invalid COMMERCIAL_OCR_DEFAULT_VERSION: $commit_sha" >&2
    return 1
  fi
  printf '%s' "$version"
}

maxim_topology_require_api_commercial_ocr_version_config() {
  local compose_args_var="$1"
  local expected_version="$2"
  local -n compose_args_ref="$compose_args_var"
  local config

  if ! config="$(docker compose "${compose_args_ref[@]}" config --format json 2>/dev/null)"; then
    echo "Could not resolve effective Compose configuration for the commercial OCR version." >&2
    return 1
  fi
  if ! printf '%s' "$config" | node -e '
      const { readFileSync } = require("node:fs");
      const expectedVersion = process.argv[1];
      const services = process.argv.slice(2);
      const config = JSON.parse(readFileSync(0, "utf8"));
      const valid =
        services.length === 12 &&
        new Set(services).size === services.length &&
        services.every(
          (service) =>
            config?.services?.[service]?.environment?.COMMERCIAL_OCR_VERSION === expectedVersion,
        );
      process.exit(valid ? 0 : 1);
    ' "$expected_version" "${MAXIM_PRODUCTION_API_SERVICES[@]}" >/dev/null 2>&1; then
    echo "Refusing API rollout unless every production API role has the target COMMERCIAL_OCR_VERSION." >&2
    return 1
  fi
}

maxim_topology_prepare_commercial_ocr_target() {
  local commit_sha="$1"
  local compose_args_var="$2"
  local has_media_analysis_var="$3"
  local version_var="$4"
  local topology_status
  local resolved_version

  printf -v "$has_media_analysis_var" '%s' 0
  printf -v "$version_var" '%s' ''
  if maxim_topology_git_compose_has_service "$commit_sha" "$MAXIM_MEDIA_ANALYSIS_SERVICE"; then
    printf -v "$has_media_analysis_var" '%s' 1
  else
    topology_status=$?
    if [[ "$topology_status" -eq 1 ]]; then
      return 0
    fi
    return "$topology_status"
  fi

  if ! resolved_version="$(maxim_topology_git_commercial_ocr_version "$commit_sha")"; then
    return 1
  fi
  printf -v "$version_var" '%s' "$resolved_version"
  export COMMERCIAL_OCR_VERSION="$resolved_version"
  maxim_topology_require_api_commercial_ocr_version_config "$compose_args_var" "$resolved_version"
  maxim_topology_require_media_analysis_shadow_config "$compose_args_var"
}

maxim_topology_verify_api_commercial_ocr_version() {
  local compose_args_var="$1"
  local expected_version="$2"
  local -n compose_args_ref="$compose_args_var"
  local service
  local container_id
  local container_env
  local entry
  local actual_version
  local matches

  if [[ "${#MAXIM_PRODUCTION_API_SERVICES[@]}" -ne 12 ]]; then
    echo "Commercial OCR version verification requires the reviewed 12-role API topology." >&2
    return 1
  fi
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    container_id="$(docker compose "${compose_args_ref[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      echo "Cannot verify commercial OCR version for missing API service container: $service" >&2
      return 1
    fi
    if ! container_env="$(
      docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null
    )"; then
      echo "Could not inspect commercial OCR version for API service: $service" >&2
      return 1
    fi

    actual_version=""
    matches=0
    while IFS= read -r entry; do
      if [[ "$entry" == COMMERCIAL_OCR_VERSION=* ]]; then
        actual_version="${entry#COMMERCIAL_OCR_VERSION=}"
        matches=$((matches + 1))
      fi
    done <<<"$container_env"
    if [[ "$matches" -ne 1 || "$actual_version" != "$expected_version" ]]; then
      echo "$service does not run with the target COMMERCIAL_OCR_VERSION." >&2
      return 1
    fi
  done
}

maxim_topology_stop_media_analysis_before_api_transition() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"
  local container_list
  local container_ids=()

  if ! container_list="$(
    docker compose "${compose_args_ref[@]}" ps -a -q "$MAXIM_MEDIA_ANALYSIS_SERVICE" 2>/dev/null
  )"; then
    echo "Could not inspect the current $MAXIM_MEDIA_ANALYSIS_SERVICE container." >&2
    return 1
  fi
  if [[ -z "$container_list" ]]; then
    return 0
  fi

  mapfile -t container_ids <<<"$container_list"
  echo "Stopping the current $MAXIM_MEDIA_ANALYSIS_SERVICE before API behavior transition..."
  docker stop --time 30 "${container_ids[@]}" >/dev/null
}

maxim_topology_require_media_analysis_shadow_config() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"

  if ! docker compose "${compose_args_ref[@]}" config --format json 2>/dev/null \
    | node -e '
        const { readFileSync } = require("node:fs");
        const config = JSON.parse(readFileSync(0, "utf8"));
        process.exit(
          config?.services?.["api-media-analysis"]?.environment?.COMMERCIAL_OCR_ROLLOUT_MODE ===
            "shadow"
            ? 0
            : 1,
        );
      ' >/dev/null 2>&1; then
    echo "Refusing media-analysis rollout unless effective COMMERCIAL_OCR_ROLLOUT_MODE=shadow." >&2
    return 1
  fi
}

maxim_topology_smoke_media_analysis_tesseract() {
  local compose_args_var="$1"
  local raster_smoke_policy="${2:-required}"
  local -n compose_args_ref="$compose_args_var"
  local raster_smoke_capability
  local attempt
  local binary
  local output
  local ready=0

  case "$raster_smoke_policy" in
    required | if-present)
      ;;
    *)
      echo "Unknown media-analysis raster smoke policy: $raster_smoke_policy" >&2
      return 2
      ;;
  esac

  if ! binary="$(
    docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      sh -c 'printf "%s" "${COMMERCIAL_OCR_TESSERACT_BINARY:-tesseract}"' 2>&1
  )"; then
    echo "Could not resolve the configured Tesseract binary in $MAXIM_MEDIA_ANALYSIS_SERVICE." >&2
    [[ -z "$binary" ]] || printf '%s\n' "$binary" >&2
    return 1
  fi
  if [[ -z "$binary" || "$binary" == *$'\n'* || "$binary" == *$'\r'* ]]; then
    echo "$MAXIM_MEDIA_ANALYSIS_SERVICE has an invalid configured Tesseract binary." >&2
    return 1
  fi

  if ! output="$(
    docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      "$binary" --list-langs 2>&1
  )"; then
    echo "Tesseract language smoke failed in $MAXIM_MEDIA_ANALYSIS_SERVICE." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi
  if ! grep -Fxq rus <<<"$output" || ! grep -Fxq eng <<<"$output"; then
    echo "$MAXIM_MEDIA_ANALYSIS_SERVICE must provide exact Tesseract language entries: rus and eng." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi

  if ! docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
    sh -c 'test "${COMMERCIAL_OCR_ROLLOUT_MODE:-}" = shadow' >/dev/null 2>&1; then
    echo "$MAXIM_MEDIA_ANALYSIS_SERVICE must run with COMMERCIAL_OCR_ROLLOUT_MODE=shadow for this rollout." >&2
    return 1
  fi

  if ! raster_smoke_capability="$(
    docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      sh -c \
      'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]; then printf present; else printf absent; fi'
  )"; then
    echo "Could not inspect the native OCR worker raster smoke capability in $MAXIM_MEDIA_ANALYSIS_SERVICE." >&2
    return 1
  fi
  case "$raster_smoke_capability" in
    present)
      ;;
    absent)
      if [[ "$raster_smoke_policy" == "required" ]]; then
        echo "$MAXIM_MEDIA_ANALYSIS_SERVICE is missing the required native OCR worker raster smoke." >&2
        return 1
      fi
      echo "Tesseract language smoke passed in legacy $MAXIM_MEDIA_ANALYSIS_SERVICE image: rus+eng; raster smoke unavailable."
      return 0
      ;;
    *)
      echo "$MAXIM_MEDIA_ANALYSIS_SERVICE returned an invalid raster smoke capability marker." >&2
      return 1
      ;;
  esac

  if ! output="$(
    docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      node apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js 2>&1
  )"; then
    echo "Native OCR worker raster smoke failed in $MAXIM_MEDIA_ANALYSIS_SERVICE." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi
  if ! grep -Fxq 'Commercial OCR worker smoke passed.' <<<"$output"; then
    echo "$MAXIM_MEDIA_ANALYSIS_SERVICE did not complete the native OCR worker raster smoke." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi

  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      node -e \
      'fetch("http://127.0.0.1:3001/api/health/ready", { signal: AbortSignal.timeout(3000) }).then(async (response) => { const body = await response.json(); if (!response.ok || body?.ok !== true || body?.checks?.ocr?.ready !== true) process.exit(1); }).catch(() => process.exit(1));' \
      >/dev/null 2>&1; then
      ready=1
      break
    fi
    [[ "$attempt" -eq 30 ]] || sleep 2
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "$MAXIM_MEDIA_ANALYSIS_SERVICE did not reach internal OCR readiness." >&2
    return 1
  fi

  echo "Tesseract rus+eng, shadow rollout, native worker raster, and internal OCR readiness smokes passed in $MAXIM_MEDIA_ANALYSIS_SERVICE."
}

maxim_topology_expand_api_services() {
  local services_var="$1"
  local reason="$2"
  # services_var intentionally names the caller's array.
  # shellcheck disable=SC2178
  local -n services_ref="$services_var"
  local service
  local added=()

  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    if maxim_topology_contains "$service" "${services_ref[@]}"; then
      continue
    fi
    services_ref+=("$service")
    added+=("$service")
  done

  if [[ "${#added[@]}" -gt 0 ]]; then
    echo "$reason Expanding deploy target to every shared API role: ${MAXIM_PRODUCTION_API_SERVICES[*]}"
  fi
}

maxim_topology_refuse_dirty_api_build_inputs() {
  local dirty_inputs_path
  local ignored_inputs_path
  local ignored_file
  local unsafe_ignored_input=0

  if ! dirty_inputs_path="$(mktemp)"; then
    echo "Could not create the API build-input preflight snapshot." >&2
    return 1
  fi
  if ! ignored_inputs_path="$(mktemp)"; then
    rm -f "$dirty_inputs_path"
    echo "Could not create the ignored API build-input preflight snapshot." >&2
    return 1
  fi
  if ! git status --porcelain=v1 --untracked-files=all -- \
    .dockerignore \
    package.json \
    package-lock.json \
    tsconfig.base.json \
    apps/admin/package.json \
    apps/api \
    apps/miniapp/package.json \
    packages/contracts \
    scripts \
    infra/certs >"$dirty_inputs_path"; then
    rm -f "$dirty_inputs_path" "$ignored_inputs_path"
    echo "Could not inspect API Docker build inputs against HEAD." >&2
    return 1
  fi
  if git ls-files --others --ignored --exclude-standard -z -- \
    apps/api \
    packages/contracts \
    scripts \
    infra/certs >"$ignored_inputs_path"; then
    while IFS= read -r -d '' ignored_file; do
      case "$ignored_file" in
        */node_modules/* | */dist/* | */coverage/* | apps/api/src/generated/* | *.log | *.env | */.env.* | *.codex-backup-*)
          ;;
        *)
          if [[ "$unsafe_ignored_input" -eq 0 ]]; then
            echo "Refusing shared API image build with Git-ignored inputs included by Docker:" >&2
          fi
          printf '  %q\n' "$ignored_file" >&2
          unsafe_ignored_input=1
          ;;
      esac
    done <"$ignored_inputs_path"
  else
    rm -f "$dirty_inputs_path" "$ignored_inputs_path"
    echo "Could not inspect ignored API Docker build inputs." >&2
    return 1
  fi
  rm -f "$ignored_inputs_path"

  if [[ -s "$dirty_inputs_path" ]]; then
    echo "Refusing shared API image build with Docker inputs that differ from HEAD:" >&2
    sed 's/^/  /' "$dirty_inputs_path" >&2
  fi
  if [[ ! -s "$dirty_inputs_path" && "$unsafe_ignored_input" -eq 0 ]]; then
    rm -f "$dirty_inputs_path"
    return 0
  fi
  rm -f "$dirty_inputs_path"
  echo "Commit, restore, remove, or add a reviewed Docker exclusion before building the production API image." >&2
  return 1
}

maxim_topology_build_shared_api_image() {
  local image_ref="$1"
  local expected_revision="${2:-}"
  local image_labels
  local source_image
  local service

  if [[ -z "$image_ref" ]]; then
    echo "An immutable shared API image ref is required." >&2
    return 1
  fi

  if [[ "$image_ref" != *:* && "$image_ref" != */* ]]; then
    source_image="${image_ref}-api-ingress:latest"
    maxim_topology_refuse_dirty_api_build_inputs
    echo "Building compatibility shared API image for Compose project: $source_image"
    docker buildx build --load --provenance=false -t "$source_image" -f apps/api/Dockerfile .
    for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
      [[ "$service" == "api-ingress" ]] || docker tag "$source_image" "${image_ref}-${service}:latest"
    done
    return 0
  fi

  if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo "An expected full lowercase Git SHA is required for immutable API image: $image_ref" >&2
    return 1
  fi

  source_image="$image_ref"
  if image_labels="$(
    docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}' \
      "$source_image" 2>/dev/null
  )"; then
    if [[ "$image_labels" != "${expected_revision}|true" ]]; then
      echo "Refusing existing immutable API image with unverified release labels: $source_image ($image_labels)" >&2
      return 1
    fi
    echo "Reusing existing immutable API image: $source_image"
    return 0
  fi
  echo "Building one shared API image without BuildKit provenance: $source_image"
  maxim_topology_refuse_dirty_api_build_inputs
  docker buildx build --load --provenance=false \
    --label "org.opencontainers.image.revision=$expected_revision" \
    --label com.maxim.release-protected=true \
    -t "$source_image" -f apps/api/Dockerfile .
}
