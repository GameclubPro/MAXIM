#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != --bounded ]]; then
  # FLAG: Signal the owned process group so a blocked foreground Docker CLI exits
  # before Bash runs cleanup; --foreground would leave that child outside the timeout.
  exec timeout --kill-after=8s 110s bash "$0" --bounded "$@"
fi
shift
[[ "$#" -eq 1 && "$1" =~ ^maxim-api:[a-f0-9]{40}$ ]] || exit 2
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_SHA:-}" == "${1#maxim-api:}" ]] || {
  echo 'Photo native container smoke requires the exact GitHub Actions image.' >&2
  exit 2
}
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || exit 2
[[ "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || exit 2

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="$1"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$GITHUB_SHA" ]] || exit 2
fixture_dir="$(mktemp -d)"
owner="photo-native-ci-${BASHPID}-${RANDOM}"
volume=infra_photo_native_ipc
native=infra-photo-native-sandbox-1
fault="${owner}-fault"
client="${owner}-client"
runner="${owner}-runner"
wait_pid=''
volume_owned=0
native_id=''
cleanup() {
  local status=$? cleanup_failed=0 ids_raw
  local ids=()
  [[ -z "$wait_pid" ]] || kill "$wait_pid" >/dev/null 2>&1 || true
  # FLAG: Delete only objects created by this invocation; never pre-clean a known name.
  ids_raw="$(timeout 2s docker ps -aq --no-trunc --filter "label=com.maxim.photo-native-ci=$owner" 2>/dev/null)" || cleanup_failed=1
  [[ -z "$ids_raw" ]] || mapfile -t ids <<< "$ids_raw"
  [[ "${#ids[@]}" -eq 0 ]] || timeout 2s docker rm -f "${ids[@]}" >/dev/null 2>&1 || cleanup_failed=1
  if [[ "$volume_owned" -eq 1 ]]; then
    timeout 2s docker volume rm "$volume" >/dev/null 2>&1 || cleanup_failed=1
  fi
  rm -rf "$fixture_dir"
  if [[ "$status" -eq 0 && "$cleanup_failed" -eq 1 ]]; then
    echo 'Photo CI owned resource cleanup failed.' >&2
    exit 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker info >/dev/null
if docker container inspect "$native" >/dev/null 2>&1 || docker volume inspect "$volume" >/dev/null 2>&1; then
  echo 'Photo CI fixture names are already occupied; refusing to reuse them.' >&2
  exit 1
fi
docker volume create --label "com.maxim.photo-native-ci=$owner" "$volume" >/dev/null
[[ "$(docker volume inspect --format '{{index .Labels "com.maxim.photo-native-ci"}}' "$volume")" == "$owner" ]] || exit 1
volume_owned=1
cp "$ROOT_DIR/infra/scripts/photo-native-ci-fixture.cjs" "$fixture_dir/fixture.cjs"
cp "$ROOT_DIR/infra/scripts/test-fixtures/photo-native-ci-hang.cjs" "$fixture_dir/photo-native-ci-hang.cjs"
chmod 0755 "$fixture_dir"
chmod 0644 "$fixture_dir"/*.cjs
node "$fixture_dir/fixture.cjs" compose "$ROOT_DIR/infra/docker-compose.yml" "$fixture_dir/compose.yml" "$image" "$owner"
export MAXIM_API_IMAGE="$image"
compose=(--env-file /dev/null -p infra -f "$fixture_dir/compose.yml")
docker compose "${compose[@]}" config --format json |
  node "$ROOT_DIR/infra/scripts/photo-native-runtime-boundary.cjs" config
docker compose "${compose[@]}" up -d --no-deps --no-build --pull never photo-native-sandbox >/dev/null
native_id="$(docker compose "${compose[@]}" ps -q photo-native-sandbox)"
[[ "$native_id" =~ ^[a-f0-9]{64}$ ]] || exit 1

isolated=(--init --read-only --user 1000:1000 --network none
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 64 --memory 1g --cpus 1
  --tmpfs '/tmp:size=64m,mode=1777,uid=1000,gid=1000' --label "com.maxim.photo-native-ci=$owner")
native_env=(--env NODE_ENV=production --env PHOTO_NATIVE_SANDBOX_SOCKET_PATH=/run/maxim-photo/native-photo.sock
  --env PHOTO_DUPLICATE_MAX_BYTES=16777216 --env PHOTO_DUPLICATE_MAX_PIXELS=40000000 --env VIPS_CONCURRENCY=1)
entry=apps/api/dist/apps/api/src/moderation/photo-duplicate/native-photo-sandbox.entrypoint.js
wait_healthy() {
  local container="$1" attempts=0
  until [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy ]]; do
    (( attempts < 25 )) || return 1
    attempts=$((attempts + 1))
    sleep 1
  done
}
client_fixture() {
  docker run --rm --name "$client" "${isolated[@]}" "${native_env[@]}" \
    --mount "type=volume,source=$volume,target=/run/maxim-photo,readonly" \
    --mount "type=bind,source=$fixture_dir,target=/ci,readonly" \
    --entrypoint node "$image" /ci/fixture.cjs "$@"
}
smoke() {
  docker run --rm --name "$client" "${isolated[@]}" "${native_env[@]}" \
    --mount "type=volume,source=$volume,target=/run/maxim-photo,readonly" \
    --entrypoint node "$image" "$entry" --smoke
}
wait_healthy "$native_id"
docker inspect "$native_id" > "$fixture_dir/inspect.json"
node "$fixture_dir/fixture.cjs" attest "$ROOT_DIR/infra/scripts/photo-native-runtime-boundary.cjs" "$fixture_dir/inspect.json" "$image_id"
docker exec -i "$native_id" node - limits < "$fixture_dir/fixture.cjs"
smoke
echo 'PASS photo native canonical image, isolation, real cgroups and exact raster hash'

docker run --rm --name "$runner" "${isolated[@]}" \
  --mount "type=bind,source=$fixture_dir,target=/ci,readonly" \
  --entrypoint node "$image" /ci/fixture.cjs runner
echo 'PASS controlled child hang, physical kill/reap and next exact decode'
docker rm -f "$native_id" >/dev/null
native_id=''

# FLAG: Fault injection has its own container and extra fixture mount. Never weaken
# the production inspector to accept it. The canonical container passed above.
docker run -d --name "$fault" "${isolated[@]}" "${native_env[@]}" --restart unless-stopped \
  --mount "type=volume,source=$volume,target=/run/maxim-photo" \
  --mount "type=bind,source=$fixture_dir,target=/ci,readonly" \
  --health-cmd "node $entry --probe" --health-interval 10s --health-timeout 8s \
  --health-start-period 20s --health-retries 3 \
  --entrypoint node "$image" /ci/fixture.cjs fatal-server >/dev/null
wait_healthy "$fault"
before="$(client_fixture instance)"
docker wait "$fault" > "$fixture_dir/exit-code" &
wait_pid=$!
client_fixture fault-request
wait "$wait_pid"
wait_pid=''
[[ "$(cat "$fixture_dir/exit-code")" == 70 ]] || exit 1
attempts=0
until [[ "$(docker inspect --format '{{.RestartCount}}' "$fault")" -gt 0 ]]; do
  (( attempts < 15 )) || exit 1
  attempts=$((attempts + 1))
  sleep 1
done
wait_healthy "$fault"
after="$(client_fixture instance)"
[[ -n "$before" && -n "$after" && "$before" != "$after" ]] || exit 1
docker exec -i "$fault" node - limits < "$fixture_dir/fixture.cjs"
smoke
echo 'PASS sandbox fatal exit 70, Docker restart, changed instance and next exact hash'
