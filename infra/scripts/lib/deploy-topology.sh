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

maxim_topology_smoke_media_analysis_tesseract() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"
  local output

  if ! output="$(
    docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      tesseract --list-langs 2>&1
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
  echo "Tesseract language smoke passed in $MAXIM_MEDIA_ANALYSIS_SERVICE: rus+eng."
}

maxim_topology_expand_api_services() {
  local services_var="$1"
  local reason="$2"
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

maxim_topology_refuse_untracked_api_build_inputs() {
  local untracked_file
  local untracked_files_path

  if ! untracked_files_path="$(mktemp)"; then
    echo "Could not create the API build-input preflight snapshot." >&2
    return 1
  fi
  if ! git ls-files --others --exclude-standard -z -- \
    apps/api \
    packages/contracts \
    scripts \
    infra/certs >"$untracked_files_path"; then
    rm -f "$untracked_files_path"
    echo "Could not inspect untracked API Docker build inputs." >&2
    return 1
  fi
  if [[ ! -s "$untracked_files_path" ]]; then
    rm -f "$untracked_files_path"
    return 0
  fi

  echo "Refusing shared API image build with untracked Docker build inputs:" >&2
  while IFS= read -r -d '' untracked_file; do
    printf '  %q\n' "$untracked_file" >&2
  done <"$untracked_files_path"
  rm -f "$untracked_files_path"
  echo "Commit, remove, or ignore these files before building the production API image." >&2
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
    maxim_topology_refuse_untracked_api_build_inputs
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
  maxim_topology_refuse_untracked_api_build_inputs
  docker buildx build --load --provenance=false \
    --label "org.opencontainers.image.revision=$expected_revision" \
    --label com.maxim.release-protected=true \
    -t "$source_image" -f apps/api/Dockerfile .
}
