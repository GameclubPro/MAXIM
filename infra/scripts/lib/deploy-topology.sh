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
  "api-action"
)

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

maxim_topology_build_shared_api_image() {
  local project_name="$1"
  local source_image
  local service

  if [[ -z "$project_name" ]]; then
    echo "Docker Compose project name is required to build the shared API image." >&2
    return 1
  fi

  source_image="${project_name}-api-ingress:latest"
  echo "Building one shared API image without BuildKit provenance: $source_image"
  docker buildx build --load --provenance=false -t "$source_image" -f apps/api/Dockerfile .

  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    if [[ "$service" == "api-ingress" ]]; then
      continue
    fi
    docker tag "$source_image" "${project_name}-${service}:latest"
  done
}
