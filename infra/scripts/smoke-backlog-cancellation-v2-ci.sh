#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${1:-}" != --bounded ]]; then
  # FLAG: Bound the owned process group before any Docker fixture resources exist.
  exec timeout --kill-after=45s 600s bash "$0" --bounded "$@"
fi
shift
[[ "$#" -eq 1 && "$1" =~ ^maxim-api:[a-f0-9]{40}$ ]] || exit 2
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_SHA:-}" == "${1#maxim-api:}" ]] || exit 2
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || exit 2
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || exit 2
[[ "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || exit 2
# FLAG: The rootless local rehearsal cannot attest enforced cgroup limits. This
# separate rootful CI gate refuses that gap rather than relaxing helper budgets.
docker info --format '{{json .}}' | node -e '
let input="";process.stdin.on("data",value=>input+=value);process.stdin.on("end",()=>{
const info=JSON.parse(input);
if(!["systemd","cgroupfs"].includes(info.CgroupDriver)||info.MemoryLimit!==true||
info.CpuCfsQuota!==true||info.SecurityOptions?.some(value=>value.includes("rootless")))process.exitCode=2;
});'
image="$1"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$GITHUB_SHA" ]] || exit 2
[[ "$(docker image inspect --format '{{index .Config.Labels "com.maxim.release-protected"}}' "$image")" == true ]] || exit 2
fixture_dir="$(mktemp -d)"
owner="backlog-v2-ci-$(node -p 'require("node:crypto").randomUUID().replaceAll("-", "")')"
cleanup() {
  local status=$?
  # The fixture removes only exact owner-labelled Docker objects and waits for its
  # helper CLIs before returning. A failed fixture retains its private evidence.
  if [[ "$status" -eq 0 ]]; then
    rm -rf "$fixture_dir"
  else
    echo BACKLOG_CANCELLATION_V2_CI_PRIVATE_EVIDENCE_RETAINED >&2
  fi
  exit "$status"
}
trap cleanup EXIT
export MAXIM_EXPECTED_DEPLOY_SHA="$GITHUB_SHA"
node infra/scripts/backlog-cancellation-v2-ci-fixture.mjs "$image_id" "$image" "$fixture_dir" "$owner"
