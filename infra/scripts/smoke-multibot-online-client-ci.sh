#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${1:-}" != --bounded ]]; then
  # FLAG: The owned process group is bounded before creating any Docker objects.
  exec timeout --kill-after=8s 180s bash "$0" --bounded "$@"
fi
shift
[[ "$#" -eq 1 && "$1" =~ ^maxim-api:[a-f0-9]{40}$ ]] || exit 2
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_SHA:-}" == "${1#maxim-api:}" ]] || exit 2
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || exit 2
[[ "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || exit 2
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || exit 2
image="$1"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$GITHUB_SHA" ]] || exit 2
[[ "$(docker image inspect --format '{{index .Config.Labels "com.maxim.release-protected"}}' "$image")" == true ]] || exit 2
fixture_dir="$(mktemp -d)"
owner="multibot-client-ci-${BASHPID}-${RANDOM}"
project="multibot_ci_$(node -p 'require("node:crypto").randomUUID().replaceAll("-", "")')"
good_tag="maxim-online-$(node -p 'require("node:crypto").randomUUID()')"
cancel_tag="maxim-online-$(node -p 'require("node:crypto").randomUUID()')"
resolver_tag="maxim-online-$(node -p 'require("node:crypto").randomUUID()')"
attempt_owned=0
cleanup() {
  local status=$? cleanup_failed=0 object label id
  local ids=()
  local clients=("$good_tag" "$cancel_tag" "$resolver_tag")
  if [[ -f "$fixture_dir/additional-owned-client" ]]; then
    object="$(cat "$fixture_dir/additional-owned-client")"
    if [[ "$object" =~ ^maxim-online-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]]; then
      clients+=("$object")
    else
      cleanup_failed=1
    fi
  fi
  if [[ "$attempt_owned" -eq 1 ]]; then
    # FLAG: UUID client names were proven absent before this invocation. PostgreSQL
    # and both isolated networks are removed only with this invocation's owner label.
    for object in "${clients[@]}"; do
      if docker container inspect "$object" >/dev/null 2>&1; then
        timeout 3s docker rm -f "$object" >/dev/null 2>&1 || cleanup_failed=1
      fi
    done
    id="$(timeout 3s docker ps -aq --no-trunc --filter "label=com.maxim.multibot-client-ci=$owner")" || cleanup_failed=1
    [[ -z "$id" ]] || mapfile -t ids <<< "$id"
    [[ "${#ids[@]}" -eq 0 ]] || timeout 3s docker rm -f "${ids[@]}" >/dev/null 2>&1 || cleanup_failed=1
    for object in "${project}_default" infra_default; do
      if label="$(timeout 3s docker network inspect --format '{{index .Labels "com.maxim.multibot-client-ci"}}' "$object" 2>/dev/null)"; then
        if [[ "$label" == "$owner" ]]; then
          timeout 3s docker network rm "$object" >/dev/null 2>&1 || cleanup_failed=1
        else
          cleanup_failed=1
        fi
      fi
    done
  fi
  rm -rf "$fixture_dir"
  if [[ "$cleanup_failed" -eq 1 ]]; then
    echo MULTIBOT_CLIENT_CI_CLEANUP_UNCONFIRMED >&2
    [[ "$status" -ne 0 ]] || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker info >/dev/null
for object in "$good_tag" "$cancel_tag" "$resolver_tag"; do
  ! docker container inspect "$object" >/dev/null 2>&1 || exit 1
done
for object in "${project}_default" infra_default; do
  ! docker network inspect "$object" >/dev/null 2>&1 || exit 1
done
node infra/scripts/multibot-online-client-ci-fixture.mjs compose "$fixture_dir" "$project" "$image" "$owner"
compose=(--env-file "$fixture_dir/ci.env" -p "$project" -f "$fixture_dir/compose.json" -f "$fixture_dir/overlay.json")
attempt_owned=1
docker compose "${compose[@]}" up -d --no-deps --no-build postgres >/dev/null
ready=0
for ((attempt=0; attempt<30; attempt++)); do
  if docker compose "${compose[@]}" exec -T postgres pg_isready -U maxim -d maxim >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || exit 1
export MAXIM_EXPECTED_DEPLOY_SHA="$GITHUB_SHA"
node infra/scripts/multibot-online-client-ci-fixture.mjs run "$fixture_dir" "$project" "$ROOT_DIR" "$image_id" "$good_tag" "$cancel_tag" "$resolver_tag" "$owner"
