#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != --bounded ]]; then
  exec timeout --kill-after=20s 180s bash "$0" --bounded "$@"
fi
shift
[[ "$#" -eq 1 && "$1" =~ ^maxim-api:[a-f0-9]{40}$ ]] || exit 2
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_SHA:-}" == "${1#maxim-api:}" ]] || exit 2
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || exit 2
[[ "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || exit 2
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="$1"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$GITHUB_SHA" ]] || exit 2
owner="antiduplicate-mixed-ci-${BASHPID}-${RANDOM}"
fixture_dir="$(mktemp -d)"
# FLAG: Never adopt or pre-clean resources from an earlier invocation.
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$owner")" ]] || exit 1
for kind in photo ocr; do
  if docker volume inspect "${owner}_${kind}_native_ipc" >/dev/null 2>&1; then exit 1; fi
done
cleanup() {
  local status=$? cleanup_failed=0 ids_raw
  local ids=()
  ids_raw="$(timeout 2s docker ps -aq --no-trunc --filter "label=com.maxim.mixed-native-ci=$owner" 2>/dev/null)" || cleanup_failed=1
  [[ -z "$ids_raw" ]] || mapfile -t ids <<< "$ids_raw"
  [[ "${#ids[@]}" -eq 0 ]] || timeout 3s docker rm -f "${ids[@]}" >/dev/null 2>&1 || cleanup_failed=1
  timeout 8s docker compose --env-file /dev/null -p "$owner" -f "$fixture_dir/compose.yml" down --volumes >/dev/null 2>&1 || cleanup_failed=1
  rm -rf "$fixture_dir"
  if [[ "$status" -eq 0 && "$cleanup_failed" -ne 0 ]]; then exit 1; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$ROOT_DIR/infra/scripts/antiduplicate-mixed-native-fixture.cjs" "$fixture_dir/fixture.cjs"
chmod 0755 "$fixture_dir"
chmod 0644 "$fixture_dir/fixture.cjs"
node "$fixture_dir/fixture.cjs" compose "$ROOT_DIR/infra/docker-compose.yml" "$fixture_dir/compose.yml" "$owner"
export MAXIM_API_IMAGE="$image"
compose=(--env-file /dev/null -p "$owner" -f "$fixture_dir/compose.yml")
native_env=(--env NODE_ENV=production --env APP_SERVICE_NAME=api-media-analysis --env APP_ROLE=moderation
  --env COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH=/run/maxim-ocr/native-ocr.sock
  --env PHOTO_DUPLICATE_MAX_BYTES=16777216 --env COMMERCIAL_OCR_MAX_INPUT_PIXELS=40000000
  --env COMMERCIAL_OCR_MAX_OUTPUT_PIXELS=3000000 --env COMMERCIAL_OCR_MAX_SIDE=2000
  --env COMMERCIAL_OCR_TESSERACT_BINARY=tesseract --env COMMERCIAL_OCR_TESSERACT_CONCURRENCY=1
  --env COMMERCIAL_OCR_TESSERACT_MAX_QUEUE=4 --env COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS=250
  --env COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS=10000 --env COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES=16777216
  --env COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES=4194304 --env OMP_THREAD_LIMIT=1)
client() {
  docker run --rm --name "${owner}-client" --init --read-only --user 1000:1000 --network none \
    --label "com.maxim.mixed-native-ci=$owner" --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 64 --memory 1g --cpus 1 \
    --tmpfs '/tmp:size=64m,mode=1777,uid=1000,gid=1000' "${native_env[@]}" \
    --mount "type=volume,source=${owner}_photo_native_ipc,target=/run/maxim-photo,readonly" \
    --mount "type=volume,source=${owner}_ocr_native_ipc,target=/run/maxim-ocr,readonly" \
    --mount "type=bind,source=$fixture_dir,target=/ci,readonly" \
    --entrypoint node "$image" /ci/fixture.cjs "$1"
}
for mode in photo ocr mixed; do
  docker compose "${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 35 photo-native-sandbox ocr-native-sandbox >/dev/null
  client warmup >/dev/null
  for kind in photo ocr; do
    container="$(docker compose "${compose[@]}" ps -q "$kind-native-sandbox")"
    docker exec -i "$container" node - resources < "$fixture_dir/fixture.cjs" > "$fixture_dir/$kind-before.json"
  done
  client "$mode" > "$fixture_dir/workload.json"
  for kind in photo ocr; do
    container="$(docker compose "${compose[@]}" ps -q "$kind-native-sandbox")"
    [[ "$(docker inspect --format '{{.RestartCount}}|{{.State.OOMKilled}}|{{.HostConfig.NetworkMode}}' "$container")" == '0|false|none' ]] || exit 1
    docker exec -i "$container" node - resources < "$fixture_dir/fixture.cjs" > "$fixture_dir/$kind-after.json"
  done
  node - "$fixture_dir" <<'NODE'
const fs = require('node:fs');
const dir = process.argv[2];
const read = (name) => JSON.parse(fs.readFileSync(`${dir}/${name}.json`, 'utf8'));
const report = read('workload');
report.resources = Object.fromEntries(['photo', 'ocr'].map((kind) => {
  const before = read(`${kind}-before`), after = read(`${kind}-after`);
  return [kind, { cpuUsec: after.cpuUsec - before.cpuUsec, memoryPeakBytes: after.memoryPeakBytes, memoryPeakBasis: 'fresh-container-including-warmup-and-probes' }];
}));
console.log(JSON.stringify(report));
NODE
  docker compose "${compose[@]}" down --volumes >/dev/null
done
