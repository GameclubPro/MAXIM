#!/usr/bin/env bash

MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE="photo-native-sandbox"
MAXIM_PHOTO_NATIVE_CONSUMER="api-moderation-background"
MAXIM_PHOTO_NATIVE_ENTRYPOINT="apps/api/dist/apps/api/src/moderation/photo-duplicate/native-photo-sandbox.entrypoint.js"
MAXIM_PHOTO_NATIVE_BOUNDARY_HELPER="${MAXIM_PHOTO_NATIVE_BOUNDARY_HELPER:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/photo-native-runtime-boundary.cjs}"
MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=0

maxim_topology_git_has_photo_native_sandbox() {
  maxim_topology_git_compose_has_service "$1" "$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE"
}

maxim_topology_image_has_photo_native_sandbox() {
  local capability
  capability="$(docker image inspect --format '{{index .Config.Labels "com.maxim.photo-native-sandbox-capable"}}' "$1" 2>/dev/null)" || return 2
  case "$capability" in
    true) return 0 ;;
    '' | '<no value>') return 1 ;;
    *) echo "Invalid photo native sandbox image capability." >&2; return 2 ;;
  esac
}

maxim_topology_require_photo_native_sandbox_config() {
  local -n photo_compose_args="$1"
  docker compose "${photo_compose_args[@]}" config --format json 2>/dev/null |
    node "$MAXIM_PHOTO_NATIVE_BOUNDARY_HELPER" config || {
      echo "Photo sandbox Compose boundary is not the reviewed no-network/no-secret configuration." >&2
      return 1
    }
}

maxim_topology_prepare_photo_native_target() {
  local source_sha="$1" compose_args_var="$2" status
  MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=0
  if maxim_topology_git_has_photo_native_sandbox "$source_sha"; then
    MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=1
    maxim_topology_require_photo_native_sandbox_config "$compose_args_var"
  else
    status=$?
    [[ "$status" -eq 1 ]] || return "$status"
  fi
}

maxim_topology_require_photo_native_image_capability() {
  local status
  if maxim_topology_image_has_photo_native_sandbox "$1"; then
    [[ "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" -eq 1 ]] && return 0
  else
    status=$?
    [[ "$status" -eq 1 ]] || return "$status"
    [[ "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" -eq 0 ]] && return 0
  fi
  echo "Photo sandbox capability does not match the selected API source." >&2
  return 1
}

maxim_topology_photo_project() {
  local -n photo_compose_args="$1"
  docker compose "${photo_compose_args[@]}" config --format json 2>/dev/null |
    node -e 'const c=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if (!["infra","infra-scale"].includes(c.name)) process.exit(1); process.stdout.write(c.name);'
}

maxim_topology_photo_container_ids() {
  local compose_args_var="$1" service="$2" state="${3:-all}" project
  project="$(maxim_topology_photo_project "$compose_args_var")" || return 1
  local args=(ps --no-trunc -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")
  [[ "$state" != all ]] || args+=(-a)
  docker "${args[@]}"
}

maxim_topology_require_photo_native_sandbox_absent() {
  local ids
  ids="$(maxim_topology_photo_container_ids "$1" "$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE")" || return 1
  [[ -z "$ids" ]] || { echo "Legacy API target still has a photo native sandbox container." >&2; return 1; }
}

maxim_topology_stop_photo_native_before_transition() {
  local compose_args_var="$1" service ids id state
  # FLAG: Stop the sole IPC consumer before native processes; never mix API image generations.
  for service in "$MAXIM_PHOTO_NATIVE_CONSUMER" "$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE"; do
    ids="$(maxim_topology_photo_container_ids "$compose_args_var" "$service")" || return 1
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      docker stop --time 30 "$id" >/dev/null || return 1
      state="$(docker inspect --format '{{.State.Running}}' "$id")" || return 1
      [[ "$state" == false ]] || return 1
    done <<<"$ids"
  done
}

maxim_topology_verify_photo_native_sandbox_runtime() {
  local compose_args_var="$1" image_id="$2" policy="${3:-with-consumer}"
  local ids sandbox_id consumer_id='' project volume consumers expected inspection
  [[ "$policy" == with-consumer || "$policy" == sandbox-only ]] || return 2
  project="$(maxim_topology_photo_project "$compose_args_var")" || return 1
  ids="$(maxim_topology_photo_container_ids "$compose_args_var" "$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE" running)" || return 1
  [[ -n "$ids" && "$ids" != *$'\n'* ]] || return 1
  sandbox_id="$ids"
  inspection="$(docker inspect "$sandbox_id")" || return 1
  node -e 'const a=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(a.length!==1) process.exit(1); process.stdout.write(JSON.stringify(a[0]));' <<<"$inspection" |
    node "$MAXIM_PHOTO_NATIVE_BOUNDARY_HELPER" runtime "$project" "$image_id" || return 1
  volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/maxim-photo"}}{{.Name}}{{end}}{{end}}' "$sandbox_id")" || return 1
  [[ "$volume" == "${project}_photo_native_ipc" ]] || return 1
  expected="$sandbox_id"
  if [[ "$policy" == with-consumer ]]; then
    consumer_id="$(maxim_topology_photo_container_ids "$compose_args_var" "$MAXIM_PHOTO_NATIVE_CONSUMER" running)" || return 1
    [[ -n "$consumer_id" && "$consumer_id" != *$'\n'* ]] || return 1
    docker inspect "$consumer_id" | node -e '
      const a=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const c=a[0];
      const mounts=c?.Mounts?.filter(m=>m.Destination==="/run/maxim-photo")??[];
      const env=c?.Config?.Env??[]; const socket=env.filter(v=>v.startsWith("PHOTO_NATIVE_SANDBOX_SOCKET_PATH="));
      const valid=a.length===1&&c.State?.Running===true&&c.Image===process.argv[1]&&
        mounts.length===1&&mounts[0].Type==="volume"&&mounts[0].Name===process.argv[2]&&mounts[0].RW===false&&
        socket.length===1&&socket[0]==="PHOTO_NATIVE_SANDBOX_SOCKET_PATH=/run/maxim-photo/native-photo.sock";
      process.exit(valid?0:1);
    ' "$image_id" "$volume" || return 1
    expected+=$'\n'"$consumer_id"
  fi
  consumers="$(docker ps --no-trunc -q --filter "volume=$volume" | sort)" || return 1
  expected="$(sort <<<"$expected")"
  [[ "$consumers" == "$expected" ]] || { echo "Photo IPC has an unexpected running consumer." >&2; return 1; }
}

maxim_topology_verify_photo_native_sandbox_for_image() {
  local status
  if maxim_topology_image_has_photo_native_sandbox "$2"; then
    maxim_topology_verify_photo_native_sandbox_runtime "$1" "$2" with-consumer
  else
    status=$?
    [[ "$status" -eq 1 ]] || return "$status"
    maxim_topology_require_photo_native_sandbox_absent "$1"
  fi
}

maxim_topology_smoke_photo_native_sandbox_uds() {
  local compose_args_var="$1" image_id="$2" mode="${3:-running}" policy=with-consumer
  local -n photo_compose_args="$compose_args_var"
  local sandbox_id before after smoke_name
  [[ "$mode" == running || "$mode" == prestart ]] || return 2
  [[ "$mode" != prestart ]] || policy=sandbox-only
  maxim_topology_verify_photo_native_sandbox_runtime "$compose_args_var" "$image_id" "$policy" || return 1
  sandbox_id="$(maxim_topology_photo_container_ids "$compose_args_var" "$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE" running)" || return 1
  before="$(docker inspect --format '{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}' "$sandbox_id")" || return 1
  # FLAG: Separate native budget; this fixture cannot send MAX messages or execute moderation.
  if [[ "$mode" == prestart ]]; then
    smoke_name="maxim-photo-smoke-${BASHPID}-${RANDOM}"
    if ! timeout --foreground --kill-after=2s 20s docker compose "${photo_compose_args[@]}" \
      run --name "$smoke_name" --rm --no-deps --pull never --entrypoint node "$MAXIM_PHOTO_NATIVE_CONSUMER" \
      "$MAXIM_PHOTO_NATIVE_ENTRYPOINT" --smoke; then
      docker rm -f "$smoke_name" >/dev/null 2>&1 || true
      return 1
    fi
  else
    timeout --foreground --kill-after=2s 20s docker compose "${photo_compose_args[@]}" \
      exec -T "$MAXIM_PHOTO_NATIVE_CONSUMER" node "$MAXIM_PHOTO_NATIVE_ENTRYPOINT" --smoke || return 1
  fi
  after="$(docker inspect --format '{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}' "$sandbox_id")" || return 1
  [[ "$before" == "$after" ]] || { echo "Photo sandbox restarted during smoke." >&2; return 1; }
  maxim_topology_verify_photo_native_sandbox_runtime "$compose_args_var" "$image_id" "$policy"
}

maxim_topology_reconcile_photo_native_sandbox() {
  local compose_args_var="$1" image_id="$2" ids id health deadline
  local -n photo_compose_args="$compose_args_var"
  maxim_topology_stop_photo_native_before_transition "$compose_args_var" || return 1
  if [[ "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" -eq 0 ]]; then
    ids="$(maxim_topology_photo_container_ids "$compose_args_var" "$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE")" || return 1
    while IFS= read -r id; do
      [[ -z "$id" ]] || docker rm "$id" >/dev/null || return 1
    done <<<"$ids"
    maxim_topology_require_photo_native_sandbox_absent "$compose_args_var"
    return
  fi
  maxim_topology_require_photo_native_sandbox_config "$compose_args_var" || return 1
  docker compose "${photo_compose_args[@]}" up -d --no-deps --no-build --force-recreate "$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE" || return 1
  deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    ids="$(maxim_topology_photo_container_ids "$compose_args_var" "$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE" running)" || return 1
    if [[ -n "$ids" && "$ids" != *$'\n'* ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$ids")" || return 1
      if [[ "$health" == healthy ]]; then
        maxim_topology_smoke_photo_native_sandbox_uds "$compose_args_var" "$image_id" prestart
        return
      fi
    fi
    sleep 1
  done
  echo "Photo sandbox did not become uniquely healthy within its native budget." >&2
  return 1
}
