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
  "api-publisher"
)

MAXIM_MEDIA_ANALYSIS_SERVICE="api-media-analysis"
MAXIM_OCR_NATIVE_SANDBOX_SERVICE="ocr-native-sandbox"
MAXIM_OCR_NATIVE_SANDBOX_CAPABILITY_LABEL="com.maxim.ocr-native-sandbox-capable"
MAXIM_IMAGE_TEXT_STOP_LIST_BINDING_SOURCE="apps/api/src/moderation/commercial-ocr/image-text-stop-list-binding.ts"
MAXIM_IMAGE_TEXT_STOP_LIST_DELETE_EXECUTOR_SOURCE="apps/api/src/moderation/moderation-delete-intent.service.ts"
MAXIM_PUBLISHER_SERVICE="api-publisher"
MAXIM_PUBLISHER_SECRET_FILES=(
  "/var/lib/maxim-secrets/publik-bot-token"
  "/var/lib/maxim-secrets/publik-webhook.json"
  "/var/lib/maxim-secrets/publik-init-data-keys.json"
  "/var/lib/maxim-secrets/publik-dialog-signing-keys.json"
)

maxim_topology_require_publisher_secret_files() {
  local path
  local mode
  local size

  for path in "${MAXIM_PUBLISHER_SECRET_FILES[@]}"; do
    if [[ ! -f "$path" || -L "$path" ]]; then
      echo "Publisher runtime secret file is missing or unsafe: $path" >&2
      return 1
    fi
    mode="$(stat -c '%a' "$path" 2>/dev/null || true)"
    size="$(stat -c '%s' "$path" 2>/dev/null || true)"
    if [[ "$mode" != "600" || ! "$size" =~ ^[1-9][0-9]{0,4}$ || "$size" -gt 16384 ]]; then
      echo "Publisher runtime secret file must be a bounded regular 0600 file: $path" >&2
      return 1
    fi
  done
}

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

maxim_topology_git_has_ocr_native_sandbox() {
  maxim_topology_git_compose_has_service "$1" "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE"
}

maxim_topology_require_image_text_stop_list_delete_guard() {
  local commit_sha="$1"
  local binding_source
  local executor_source
  local source_path

  for source_path in \
    "$MAXIM_IMAGE_TEXT_STOP_LIST_BINDING_SOURCE" \
    "$MAXIM_IMAGE_TEXT_STOP_LIST_DELETE_EXECUTOR_SOURCE"; do
    if ! git cat-file -e "${commit_sha}:${source_path}" 2>/dev/null; then
      echo "Rollback target predates the image-text stop-list delete guard." >&2
      return 1
    fi
  done
  if ! binding_source="$(
    git show "${commit_sha}:${MAXIM_IMAGE_TEXT_STOP_LIST_BINDING_SOURCE}" 2>/dev/null
  )"; then
    echo "Could not inspect the rollback target image-text binding source." >&2
    return 1
  fi
  if ! executor_source="$(
    git show "${commit_sha}:${MAXIM_IMAGE_TEXT_STOP_LIST_DELETE_EXECUTOR_SOURCE}" 2>/dev/null
  )"; then
    echo "Could not inspect the rollback target delete executor source." >&2
    return 1
  fi

  if ! printf '%s\0%s' "$binding_source" "$executor_source" | node -e '
      const { readFileSync } = require("node:fs");
      const input = readFileSync(0);
      if (input.byteLength < 1 || input.byteLength > 4 * 1024 * 1024) process.exit(1);
      const separator = input.indexOf(0);
      if (separator < 1 || input.indexOf(0, separator + 1) !== -1) process.exit(1);
      const binding = input.subarray(0, separator).toString("utf8");
      const executor = input.subarray(separator + 1).toString("utf8");
      const exactCount = (source, expression) => [...source.matchAll(expression)].length;
      const bindingVersion =
        /export const IMAGE_TEXT_STOP_LIST_BINDING_VERSION\s*=\s*1\s+as\s+const;/gu;
      const methodDefinition =
        /private async assertImageTextStopListDeleteIntentStillActionable\s*\(/gu;
      const methodCall =
        /await\s+this\.assertImageTextStopListDeleteIntentStillActionable\(intent,\s*botId\);/gu;
      if (
        exactCount(binding, bindingVersion) !== 1 ||
        exactCount(executor, methodDefinition) !== 1 ||
        exactCount(executor, methodCall) !== 1 ||
        exactCount(
          executor,
          /from\s+[\x22\x27]\.\/commercial-ocr\/image-text-stop-list-binding[\x22\x27];/gu,
        ) !== 1
      ) process.exit(1);
      const guardStart = executor.indexOf("private async runDeletePreDispatchGuards(");
      const guardEnd = executor.indexOf("\n  private ", guardStart + 1);
      const callAt = executor.search(methodCall);
      const dispatchAt = executor.indexOf("await options?.beforeDeleteMutation?.();", guardStart);
      const valid =
        guardStart >= 0 && guardEnd > guardStart && callAt > guardStart && callAt < guardEnd &&
        dispatchAt > callAt && dispatchAt < guardEnd;
      process.exit(valid ? 0 : 1);
    ' >/dev/null 2>&1; then
    echo "Rollback target lacks the reviewed image-text stop-list pre-dispatch guard capability." >&2
    return 1
  fi
}

maxim_topology_image_has_ocr_native_sandbox() {
  local image="$1"
  local capability

  if ! capability="$(
    docker image inspect \
      --format "{{index .Config.Labels \"$MAXIM_OCR_NATIVE_SANDBOX_CAPABILITY_LABEL\"}}" \
      "$image" 2>/dev/null
  )"; then
    echo "Could not inspect the OCR sandbox capability on API image: $image" >&2
    return 2
  fi
  case "$capability" in
    true) return 0 ;;
    '' | '<no value>') return 1 ;;
    *)
      echo "API image has an invalid OCR sandbox capability label." >&2
      return 2
      ;;
  esac
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
  local publisher_policy="${3:-required}"
  local -n compose_args_ref="$compose_args_var"
  local config

  if ! config="$(docker compose "${compose_args_ref[@]}" config --format json 2>/dev/null)"; then
    echo "Could not resolve effective Compose configuration for the commercial OCR version." >&2
    return 1
  fi
  if ! printf '%s' "$config" | node -e '
      const { readFileSync } = require("node:fs");
      const expectedVersion = process.argv[1];
      const publisherPolicy = process.argv[2];
      const services = process.argv.slice(3);
      const config = JSON.parse(readFileSync(0, "utf8"));
      const configuredServices = services.filter((service) => config?.services?.[service]);
      const missingServices = services.filter((service) => !config?.services?.[service]);
      const valid =
        services.length === 13 &&
        new Set(services).size === services.length &&
        (missingServices.length === 0 ||
          (publisherPolicy === "allow-absent" &&
            missingServices.length === 1 &&
            missingServices[0] === "api-publisher")) &&
        configuredServices.every(
          (service) =>
            config?.services?.[service]?.environment?.COMMERCIAL_OCR_VERSION === expectedVersion,
        );
      process.exit(valid ? 0 : 1);
    ' "$expected_version" "$publisher_policy" "${MAXIM_PRODUCTION_API_SERVICES[@]}" >/dev/null 2>&1; then
    echo "Refusing API rollout unless every production API role has the target COMMERCIAL_OCR_VERSION." >&2
    return 1
  fi
}

maxim_topology_prepare_commercial_ocr_target() {
  local commit_sha="$1"
  local compose_args_var="$2"
  local has_media_analysis_var="$3"
  local version_var="$4"
  local has_ocr_native_sandbox_var="${5:-}"
  local topology_status
  local resolved_version
  local publisher_policy="required"
  local has_ocr_native_sandbox=0

  printf -v "$has_media_analysis_var" '%s' 0
  printf -v "$version_var" '%s' ''
  if [[ -n "$has_ocr_native_sandbox_var" ]]; then
    printf -v "$has_ocr_native_sandbox_var" '%s' 0
  fi
  if maxim_topology_git_has_ocr_native_sandbox "$commit_sha"; then
    has_ocr_native_sandbox=1
    if [[ -n "$has_ocr_native_sandbox_var" ]]; then
      printf -v "$has_ocr_native_sandbox_var" '%s' 1
    fi
  else
    topology_status=$?
    if [[ "$topology_status" -ne 1 ]]; then
      return "$topology_status"
    fi
  fi
  if maxim_topology_git_compose_has_service "$commit_sha" "$MAXIM_MEDIA_ANALYSIS_SERVICE"; then
    printf -v "$has_media_analysis_var" '%s' 1
  else
    topology_status=$?
    if [[ "$topology_status" -eq 1 ]]; then
      if [[ "$has_ocr_native_sandbox" -eq 1 ]]; then
        echo "Target source defines $MAXIM_OCR_NATIVE_SANDBOX_SERVICE without $MAXIM_MEDIA_ANALYSIS_SERVICE." >&2
        return 1
      fi
      return 0
    fi
    return "$topology_status"
  fi

  if ! resolved_version="$(maxim_topology_git_commercial_ocr_version "$commit_sha")"; then
    return 1
  fi
  printf -v "$version_var" '%s' "$resolved_version"
  export COMMERCIAL_OCR_VERSION="$resolved_version"
  if maxim_topology_git_compose_has_service "$commit_sha" "$MAXIM_PUBLISHER_SERVICE"; then
    :
  else
    local publisher_status=$?
    if [[ "$publisher_status" -eq 1 ]]; then
      publisher_policy="allow-absent"
    else
      return "$publisher_status"
    fi
  fi
  maxim_topology_require_api_commercial_ocr_version_config \
    "$compose_args_var" "$resolved_version" "$publisher_policy"
  maxim_topology_require_media_analysis_shadow_config "$compose_args_var"
  if [[ "$has_ocr_native_sandbox" -eq 1 ]]; then
    maxim_topology_require_ocr_native_sandbox_config "$compose_args_var"
  fi
}

maxim_topology_verify_api_commercial_ocr_version() {
  local compose_args_var="$1"
  local expected_version="$2"
  local publisher_policy="${3:-required}"
  local -n compose_args_ref="$compose_args_var"
  local service
  local container_id
  local container_env
  local entry
  local actual_version
  local matches

  if [[ "${#MAXIM_PRODUCTION_API_SERVICES[@]}" -ne 13 ]]; then
    echo "Commercial OCR version verification requires the reviewed 13-role API topology." >&2
    return 1
  fi
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    if [[ "$service" == "$MAXIM_PUBLISHER_SERVICE" && "$publisher_policy" == "allow-absent" ]]; then
      continue
    fi
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
  local container_id
  local running
  local service

  for service in "$MAXIM_MEDIA_ANALYSIS_SERVICE" "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE"; do
    if ! container_list="$(
      docker compose "${compose_args_ref[@]}" ps -a -q "$service" 2>/dev/null
    )"; then
      echo "Could not inspect the current $service container." >&2
      return 1
    fi
    [[ -n "$container_list" ]] || continue
    mapfile -t container_ids <<<"$container_list"
    echo "Stopping the current $service before API behavior transition..."
    docker stop --time 30 "${container_ids[@]}" >/dev/null
    for container_id in "${container_ids[@]}"; do
      running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null)" || {
        echo "Could not verify stopped OCR runtime container for $service." >&2
        return 1
      }
      if [[ "$running" != "false" ]]; then
        echo "OCR runtime container remained active after stopping $service." >&2
        return 1
      fi
    done
    container_ids=()
  done
}

maxim_topology_remove_ocr_native_sandbox_container() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"
  local container_list
  local container_ids=()

  if ! container_list="$(
    docker compose "${compose_args_ref[@]}" ps -a -q "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
  )"; then
    echo "Could not inspect the current $MAXIM_OCR_NATIVE_SANDBOX_SERVICE container." >&2
    return 1
  fi
  [[ -n "$container_list" ]] || return 0
  mapfile -t container_ids <<<"$container_list"
  echo "Stopping and removing $MAXIM_OCR_NATIVE_SANDBOX_SERVICE for a pre-sandbox API target..."
  docker stop --time 30 "${container_ids[@]}" >/dev/null 2>&1 || true
  docker rm -f "${container_ids[@]}" >/dev/null
}

maxim_topology_require_ocr_native_sandbox_absent() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"
  local container_list

  if ! container_list="$(
    docker compose "${compose_args_ref[@]}" ps -a -q \
      "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
  )"; then
    echo "Could not verify absence of $MAXIM_OCR_NATIVE_SANDBOX_SERVICE." >&2
    return 1
  fi
  if [[ -n "$container_list" ]]; then
    echo "A pre-sandbox API runtime still has $MAXIM_OCR_NATIVE_SANDBOX_SERVICE." >&2
    return 1
  fi
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

maxim_topology_require_ocr_native_sandbox_config() {
  local compose_args_var="$1"
  local -n compose_args_ref="$compose_args_var"

  if ! docker compose "${compose_args_ref[@]}" config --format json 2>/dev/null \
    | node -e '
        const { readFileSync } = require("node:fs");
        const config = JSON.parse(readFileSync(0, "utf8"));
        const sandbox = config?.services?.["ocr-native-sandbox"];
        const media = config?.services?.["api-media-analysis"];
        const expectedCommand = [
          "node",
          "apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js",
        ];
        const expectedProbe = ["CMD", ...expectedCommand, "--probe"];
        const expectedEnvironment = {
          COMMERCIAL_OCR_MAX_INPUT_PIXELS: "40000000",
          COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: "3000000",
          COMMERCIAL_OCR_MAX_SIDE: "2000",
          COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: "/run/maxim-ocr/native-ocr.sock",
          COMMERCIAL_OCR_TESSERACT_BINARY: "tesseract",
          COMMERCIAL_OCR_TESSERACT_CONCURRENCY: "1",
          COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: "16777216",
          COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: "4194304",
          COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: "4",
          COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: "250",
          COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: "10000",
          NODE_ENV: "production",
          OMP_THREAD_LIMIT: "1",
          PHOTO_DUPLICATE_MAX_BYTES: "16777216",
        };
        const sameStrings = (left, right) =>
          Array.isArray(left) && left.length === right.length &&
          left.every((value, index) => value === right[index]);
        const exactObject = (left, right) =>
          left && typeof left === "object" && !Array.isArray(left) &&
          Object.keys(left).length === Object.keys(right).length &&
          Object.entries(right).every(([key, value]) => left[key] === value);
        const sandboxVolumes = Array.isArray(sandbox?.volumes) ? sandbox.volumes : [];
        const mediaVolumes = Array.isArray(media?.volumes) ? media.volumes : [];
        const ipcConsumers = Object.entries(config?.services ?? {})
          .filter(([, service]) =>
            (service?.volumes ?? []).some((volume) => volume?.source === "ocr_native_ipc"),
          )
          .map(([name]) => name)
          .sort();
        const sandboxVolume = sandboxVolumes[0];
        const mediaVolume = mediaVolumes.find((volume) => volume?.target === "/run/maxim-ocr");
        const valid =
          sandbox && media &&
          sandbox.labels?.["com.maxim.ocr-native-sandbox"] === "true" &&
          sandbox.network_mode === "none" && sandbox.networks === undefined &&
          sandbox.user === "1000:1000" && sandbox.init === true &&
          sandbox.read_only === true && sandbox.privileged !== true &&
          sandbox.cpus === 1 && sandbox.mem_limit === "1073741824" &&
          sandbox.pids_limit === 128 && sandbox.deploy?.replicas === 1 &&
          sandbox.restart === "unless-stopped" &&
          sameStrings(sandbox.cap_drop, ["ALL"]) &&
          sameStrings(sandbox.security_opt, ["no-new-privileges:true"]) &&
          sameStrings(sandbox.tmpfs, ["/tmp:size=64m,mode=1777,uid=1000,gid=1000"]) &&
          sameStrings(sandbox.command, expectedCommand) &&
          sameStrings(sandbox.healthcheck?.test, expectedProbe) &&
          sandbox.healthcheck?.timeout === "8s" &&
          sandbox.healthcheck?.interval === "10s" &&
          sandbox.healthcheck?.retries === 3 &&
          sandbox.healthcheck?.start_period === "20s" &&
          exactObject(sandbox.environment, expectedEnvironment) &&
          sandbox.secrets === undefined && sandbox.configs === undefined &&
          sandbox.ports === undefined && sandbox.expose === undefined &&
          sandboxVolumes.length === 1 && sandboxVolume?.type === "volume" &&
          sandboxVolume?.source === "ocr_native_ipc" &&
          sandboxVolume?.target === "/run/maxim-ocr" && sandboxVolume?.read_only !== true &&
          mediaVolume?.type === "volume" && mediaVolume?.source === "ocr_native_ipc" &&
          mediaVolume?.read_only === true &&
          sameStrings(ipcConsumers, ["api-media-analysis", "ocr-native-sandbox"]) &&
          Object.entries(expectedEnvironment).every(
            ([key, value]) => media?.environment?.[key] === value,
          ) &&
          media?.depends_on?.["ocr-native-sandbox"]?.condition === "service_healthy";
        process.exit(valid ? 0 : 1);
      ' >/dev/null 2>&1; then
    echo "Refusing OCR sandbox rollout unless the effective no-network/no-secret Compose boundary is exact." >&2
    return 1
  fi
}

maxim_topology_wait_for_ocr_native_sandbox() {
  local compose_args_var="$1"
  local timeout_sec="${2:-180}"
  local -n compose_args_ref="$compose_args_var"
  local deadline=$((SECONDS + timeout_sec))
  local container_list
  local container_ids=()
  local health

  while ((SECONDS < deadline)); do
    container_list="$(
      docker compose "${compose_args_ref[@]}" ps --status running -q \
        "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null || true
    )"
    container_ids=()
    [[ -z "$container_list" ]] || mapfile -t container_ids <<<"$container_list"
    if [[ "${#container_ids[@]}" -eq 1 ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
        "${container_ids[0]}" 2>/dev/null || true)"
      if [[ "$health" == "healthy" ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE did not become a unique healthy container." >&2
  return 1
}

maxim_topology_recreate_ocr_native_sandbox() {
  local compose_args_var="$1"
  local expected_image_id="${2:-}"
  local -n compose_args_ref="$compose_args_var"

  echo "Recreating isolated OCR native sandbox..."
  docker compose "${compose_args_ref[@]}" up -d --no-deps --no-build --force-recreate \
    "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE"
  maxim_topology_wait_for_ocr_native_sandbox "$compose_args_var" 180
  maxim_topology_verify_ocr_native_sandbox_runtime \
    "$compose_args_var" "$expected_image_id" sandbox-only
}

maxim_topology_verify_ocr_native_sandbox_runtime() {
  local compose_args_var="$1"
  local expected_image_id="${2:-}"
  local media_policy="${3:-with-media}"
  local -n compose_args_ref="$compose_args_var"
  local sandbox_list
  local media_list
  local sandbox_ids=()
  local media_ids=()
  local inspect_ids=()
  local socket_volume_name
  local volume_consumers_raw
  local volume_consumers=()
  local expected_consumers=()

  case "$media_policy" in
    sandbox-only | with-media) ;;
    *)
      echo "Unknown OCR sandbox runtime media policy: $media_policy" >&2
      return 2
      ;;
  esac
  sandbox_list="$(
    docker compose "${compose_args_ref[@]}" ps --status running -q \
      "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
  )" || return 1
  [[ -z "$sandbox_list" ]] || mapfile -t sandbox_ids <<<"$sandbox_list"
  if [[ "${#sandbox_ids[@]}" -ne 1 ]]; then
    echo "OCR sandbox runtime must contain exactly one running container." >&2
    return 1
  fi
  inspect_ids=("${sandbox_ids[0]}")
  if [[ "$media_policy" == "with-media" ]]; then
    media_list="$(
      docker compose "${compose_args_ref[@]}" ps --status running -q \
        "$MAXIM_MEDIA_ANALYSIS_SERVICE" 2>/dev/null
    )" || return 1
    [[ -z "$media_list" ]] || mapfile -t media_ids <<<"$media_list"
    if [[ "${#media_ids[@]}" -ne 1 ]]; then
      echo "OCR sandbox attestation requires exactly one running media-analysis container." >&2
      return 1
    fi
    inspect_ids+=("${media_ids[0]}")
  fi

  socket_volume_name="$(
    docker inspect --format \
      '{{range .Mounts}}{{if eq .Destination "/run/maxim-ocr"}}{{.Name}}{{end}}{{end}}' \
      "${sandbox_ids[0]}" 2>/dev/null
  )" || return 1
  if [[ ! "$socket_volume_name" =~ ^infra(-scale)?_ocr_native_ipc$ ]]; then
    echo "OCR sandbox uses an invalid IPC volume identity." >&2
    return 1
  fi
  volume_consumers_raw="$(
    docker ps --no-trunc -q --filter "volume=$socket_volume_name" 2>/dev/null
  )" || return 1
  [[ -z "$volume_consumers_raw" ]] || mapfile -t volume_consumers <<<"$volume_consumers_raw"
  expected_consumers=("${sandbox_ids[0]}")
  if [[ "$media_policy" == "with-media" ]]; then
    expected_consumers+=("${media_ids[0]}")
  fi
  mapfile -t volume_consumers < <(printf '%s\n' "${volume_consumers[@]}" | sort)
  mapfile -t expected_consumers < <(printf '%s\n' "${expected_consumers[@]}" | sort)
  if [[ "${volume_consumers[*]}" != "${expected_consumers[*]}" ]]; then
    echo "OCR sandbox IPC volume is mounted by an unexpected running container." >&2
    return 1
  fi

  # shellcheck disable=SC2016
  if ! docker inspect "${inspect_ids[@]}" 2>/dev/null \
    | node -e '
        const { readFileSync } = require("node:fs");
        const expectedImageId = process.argv[1];
        const mediaPolicy = process.argv[2];
        const containers = JSON.parse(readFileSync(0, "utf8"));
        const sandbox = containers[0];
        const media = containers[1];
        const labels = sandbox?.Config?.Labels ?? {};
        const project = labels["com.docker.compose.project"];
        const env = new Map();
        let envValid = Array.isArray(sandbox?.Config?.Env);
        for (const entry of sandbox?.Config?.Env ?? []) {
          if (typeof entry !== "string") { envValid = false; continue; }
          const separator = entry.indexOf("=");
          if (separator < 1) { envValid = false; continue; }
          const key = entry.slice(0, separator);
          if (env.has(key)) envValid = false;
          env.set(key, entry.slice(separator + 1));
        }
        const allowedEnv = new Set([
          "COMMERCIAL_OCR_MAX_INPUT_PIXELS", "COMMERCIAL_OCR_MAX_OUTPUT_PIXELS",
          "COMMERCIAL_OCR_MAX_SIDE",
          "COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH",
          "COMMERCIAL_OCR_TESSERACT_BINARY",
          "COMMERCIAL_OCR_TESSERACT_CONCURRENCY",
          "COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES",
          "COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES",
          "COMMERCIAL_OCR_TESSERACT_MAX_QUEUE",
          "COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS",
          "COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS",
          "HOME", "HOSTNAME", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "NODE_VERSION",
          "OMP_THREAD_LIMIT", "PATH", "PHOTO_DUPLICATE_MAX_BYTES", "YARN_VERSION",
        ]);
        envValid = envValid && [...env.keys()].every((key) => allowedEnv.has(key));
        const sandboxMounts = Array.isArray(sandbox?.Mounts) ? sandbox.Mounts : [];
        const socketMount = sandboxMounts[0];
        const tmpfs = sandbox?.HostConfig?.Tmpfs ?? {};
        const securityOpt = sandbox?.HostConfig?.SecurityOpt ?? [];
        const capDrop = sandbox?.HostConfig?.CapDrop ?? [];
        const expectedCommand = [
          "node",
          "apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js",
        ];
        const sameStrings = (left, right) =>
          Array.isArray(left) && left.length === right.length &&
          left.every((value, index) => value === right[index]);
        let valid =
          Array.isArray(containers) && containers.length === (mediaPolicy === "with-media" ? 2 : 1) &&
          sandbox?.State?.Running === true && sandbox?.State?.Status === "running" &&
          sandbox?.State?.Health?.Status === "healthy" &&
          (!expectedImageId || sandbox?.Image === expectedImageId) &&
          labels["com.docker.compose.service"] === "ocr-native-sandbox" &&
          labels["com.maxim.ocr-native-sandbox"] === "true" &&
          labels["com.maxim.ocr-native-sandbox-capable"] === "true" &&
          typeof project === "string" && /^(?:infra|infra-scale)$/u.test(project) &&
          (project !== "infra" || labels["com.maxim.release-protected"] === "true") &&
          sandbox?.Config?.User === "1000:1000" &&
          sameStrings(sandbox?.Config?.Cmd, expectedCommand) &&
          envValid &&
          env.get("NODE_ENV") === "production" &&
          env.get("COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH") ===
            "/run/maxim-ocr/native-ocr.sock" &&
          env.get("PHOTO_DUPLICATE_MAX_BYTES") === "16777216" &&
          env.get("COMMERCIAL_OCR_MAX_INPUT_PIXELS") === "40000000" &&
          env.get("COMMERCIAL_OCR_MAX_OUTPUT_PIXELS") === "3000000" &&
          env.get("COMMERCIAL_OCR_MAX_SIDE") === "2000" &&
          env.get("COMMERCIAL_OCR_TESSERACT_BINARY") === "tesseract" &&
          env.get("COMMERCIAL_OCR_TESSERACT_CONCURRENCY") === "1" &&
          env.get("COMMERCIAL_OCR_TESSERACT_MAX_QUEUE") === "4" &&
          env.get("COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS") === "250" &&
          env.get("COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS") === "10000" &&
          env.get("COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES") === "16777216" &&
          env.get("COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES") === "4194304" &&
          env.get("OMP_THREAD_LIMIT") === "1" &&
          sandbox?.HostConfig?.NetworkMode === "none" &&
          sandbox?.HostConfig?.ReadonlyRootfs === true &&
          sandbox?.HostConfig?.Privileged === false &&
          sandbox?.HostConfig?.Init === true &&
          sandbox?.HostConfig?.RestartPolicy?.Name === "unless-stopped" &&
          sandbox?.HostConfig?.PidsLimit === 128 &&
          sandbox?.HostConfig?.Memory === 1073741824 &&
          sandbox?.HostConfig?.NanoCpus === 1000000000 &&
          sameStrings(capDrop, ["ALL"]) &&
          securityOpt.includes("no-new-privileges:true") &&
          Object.keys(tmpfs).length === 1 &&
          typeof tmpfs["/tmp"] === "string" && tmpfs["/tmp"].includes("size=64m") &&
          sandboxMounts.length === 1 && socketMount?.Type === "volume" &&
          socketMount?.Name === `${project}_ocr_native_ipc` &&
          socketMount?.Destination === "/run/maxim-ocr" && socketMount?.RW === true &&
          Object.keys(sandbox?.NetworkSettings?.Networks ?? {}).length === 0;
        if (mediaPolicy === "with-media") {
          const mediaMounts = (media?.Mounts ?? []).filter(
            (mount) => mount?.Destination === "/run/maxim-ocr",
          );
          const mediaEnvironment = new Map();
          let mediaEnvironmentValid = Array.isArray(media?.Config?.Env);
          for (const entry of media?.Config?.Env ?? []) {
            if (typeof entry !== "string") { mediaEnvironmentValid = false; continue; }
            const separator = entry.indexOf("=");
            if (separator < 1) { mediaEnvironmentValid = false; continue; }
            const key = entry.slice(0, separator);
            if (mediaEnvironment.has(key)) mediaEnvironmentValid = false;
            mediaEnvironment.set(key, entry.slice(separator + 1));
          }
          const nativeProfileKeys = [
            "COMMERCIAL_OCR_MAX_INPUT_PIXELS", "COMMERCIAL_OCR_MAX_OUTPUT_PIXELS",
            "COMMERCIAL_OCR_MAX_SIDE", "COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH",
            "COMMERCIAL_OCR_TESSERACT_BINARY", "COMMERCIAL_OCR_TESSERACT_CONCURRENCY",
            "COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES",
            "COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES", "COMMERCIAL_OCR_TESSERACT_MAX_QUEUE",
            "COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS",
            "COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS", "OMP_THREAD_LIMIT",
            "PHOTO_DUPLICATE_MAX_BYTES",
          ];
          valid = valid && media?.State?.Running === true &&
            (!expectedImageId || media?.Image === expectedImageId) &&
            mediaEnvironmentValid &&
            nativeProfileKeys.every((key) => mediaEnvironment.get(key) === env.get(key)) &&
            mediaMounts.length === 1 && mediaMounts[0]?.Type === "volume" &&
            mediaMounts[0]?.Name === socketMount?.Name && mediaMounts[0]?.RW === false;
        }
        process.exit(valid ? 0 : 1);
      ' "$expected_image_id" "$media_policy" >/dev/null 2>&1; then
    echo "OCR sandbox runtime failed image, isolation, health, or IPC-volume attestation." >&2
    return 1
  fi
}

maxim_topology_verify_ocr_native_sandbox_for_image() {
  local compose_args_var="$1"
  local image="$2"
  local capability_status

  if maxim_topology_image_has_ocr_native_sandbox "$image"; then
    maxim_topology_verify_ocr_native_sandbox_runtime "$compose_args_var" "$image" with-media
    return
  fi
  capability_status=$?
  if [[ "$capability_status" -ne 1 ]]; then
    return "$capability_status"
  fi
  maxim_topology_require_ocr_native_sandbox_absent "$compose_args_var"
}

maxim_topology_require_ocr_native_sandbox_image_capability() {
  local image="$1"
  local expected="$2"
  local capability_status

  if [[ "$expected" != "0" && "$expected" != "1" ]]; then
    echo "OCR sandbox image capability expectation must be 0 or 1." >&2
    return 2
  fi
  if maxim_topology_image_has_ocr_native_sandbox "$image"; then
    if [[ "$expected" -eq 1 ]]; then
      return 0
    fi
    echo "Pre-sandbox target image unexpectedly declares OCR sandbox capability." >&2
    return 1
  fi
  capability_status=$?
  if [[ "$capability_status" -ne 1 ]]; then
    return "$capability_status"
  fi
  if [[ "$expected" -eq 0 ]]; then
    return 0
  fi
  echo "OCR sandbox target source requires an image with the matching capability label." >&2
  return 1
}

maxim_topology_smoke_ocr_native_sandbox_uds() {
  local compose_args_var="$1"
  local expected_image_id="${2:-}"
  local client_mode="${3:-running-media}"
  local -n compose_args_ref="$compose_args_var"
  local output
  local sandbox_id
  local runtime_media_policy="with-media"

  case "$client_mode" in
    running-media) ;;
    prestart) runtime_media_policy="sandbox-only" ;;
    *)
      echo "Unknown native OCR UDS smoke client mode: $client_mode" >&2
      return 2
      ;;
  esac

  maxim_topology_require_ocr_native_sandbox_config "$compose_args_var"
  maxim_topology_wait_for_ocr_native_sandbox "$compose_args_var" 180
  maxim_topology_verify_ocr_native_sandbox_runtime \
    "$compose_args_var" "$expected_image_id" "$runtime_media_policy"

  if [[ "$client_mode" == "prestart" ]]; then
    output="$(
      docker compose "${compose_args_ref[@]}" run --rm --no-deps --pull never \
        --entrypoint node "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
        apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js 2>&1
    )" || {
      echo "Pre-fence native OCR UDS raster smoke failed." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    }
  elif ! output="$(
    docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_MEDIA_ANALYSIS_SERVICE" \
      node apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js 2>&1
  )"; then
    echo "Pre-fence native OCR UDS raster smoke failed." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi
  if ! grep -Fxq 'Commercial OCR worker smoke passed.' <<<"$output"; then
    echo "Pre-fence native OCR UDS raster smoke returned an invalid marker." >&2
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi

  sandbox_id="$(
    docker compose "${compose_args_ref[@]}" ps --status running -q \
      "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
  )" || return 1
  if [[ -z "$sandbox_id" || "$sandbox_id" == *$'\n'* ]]; then
    echo "Pre-fence native OCR UDS smoke lost the unique sandbox container." >&2
    return 1
  fi
  if ! docker top "$sandbox_id" -eo comm 2>/dev/null \
    | awk 'NR > 1 && $1 == "tesseract" { found=1 } END { exit found ? 1 : 0 }'; then
    echo "Pre-fence native OCR UDS smoke left a Tesseract process behind." >&2
    return 1
  fi
  maxim_topology_verify_ocr_native_sandbox_runtime \
    "$compose_args_var" "$expected_image_id" "$runtime_media_policy"
}

maxim_topology_smoke_media_analysis_tesseract() {
  local compose_args_var="$1"
  local raster_smoke_policy="${2:-required}"
  local native_boundary_policy="${3:-legacy}"
  local -n compose_args_ref="$compose_args_var"
  local raster_smoke_capability
  local native_service="$MAXIM_MEDIA_ANALYSIS_SERVICE"
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
  case "$native_boundary_policy" in
    legacy)
      ;;
    sandbox)
      native_service="$MAXIM_OCR_NATIVE_SANDBOX_SERVICE"
      maxim_topology_require_ocr_native_sandbox_config "$compose_args_var"
      maxim_topology_wait_for_ocr_native_sandbox "$compose_args_var" 180
      maxim_topology_verify_ocr_native_sandbox_runtime "$compose_args_var" '' with-media
      ;;
    *)
      echo "Unknown native OCR boundary smoke policy: $native_boundary_policy" >&2
      return 2
      ;;
  esac

  if [[ "$native_boundary_policy" == "sandbox" ]]; then
    if ! output="$(
      docker compose "${compose_args_ref[@]}" exec -T "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" \
        node apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js \
        --probe 2>&1
    )"; then
      echo "Native OCR sandbox probe failed." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    fi
    if ! grep -Fxq 'Native OCR sandbox probe passed.' <<<"$output"; then
      echo "Native OCR sandbox did not return its exact probe marker." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    fi
  else
    if ! binary="$(
      docker compose "${compose_args_ref[@]}" exec -T "$native_service" \
        sh -c 'printf "%s" "${COMMERCIAL_OCR_TESSERACT_BINARY:-tesseract}"' 2>&1
    )"; then
      echo "Could not resolve the configured Tesseract binary in $native_service." >&2
      [[ -z "$binary" ]] || printf '%s\n' "$binary" >&2
      return 1
    fi
    if [[ -z "$binary" || "$binary" == *$'\n'* || "$binary" == *$'\r'* ]]; then
      echo "$native_service has an invalid configured Tesseract binary." >&2
      return 1
    fi

    if ! output="$(
      docker compose "${compose_args_ref[@]}" exec -T "$native_service" \
        "$binary" --list-langs 2>&1
    )"; then
      echo "Tesseract language smoke failed in $native_service." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    fi
    if ! grep -Fxq rus <<<"$output" || ! grep -Fxq eng <<<"$output"; then
      echo "$native_service must provide exact Tesseract language entries: rus and eng." >&2
      [[ -z "$output" ]] || printf '%s\n' "$output" >&2
      return 1
    fi
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
      echo "Tesseract language smoke passed in legacy $native_service image: rus+eng; raster smoke unavailable."
      return 0
      ;;
    *)
      echo "$MAXIM_MEDIA_ANALYSIS_SERVICE returned an invalid raster smoke capability marker." >&2
      return 1
      ;;
  esac

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

  if [[ "$native_boundary_policy" == "sandbox" ]]; then
    local sandbox_container_id
    sandbox_container_id="$(
      docker compose "${compose_args_ref[@]}" ps --status running -q \
        "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" 2>/dev/null
    )" || return 1
    if [[ -z "$sandbox_container_id" || "$sandbox_container_id" == *$'\n'* ]]; then
      echo "Could not resolve the unique OCR sandbox after raster smoke." >&2
      return 1
    fi
    if ! docker top "$sandbox_container_id" -eo comm 2>/dev/null \
      | awk 'NR > 1 && $1 == "tesseract" { found=1 } END { exit found ? 1 : 0 }'; then
      echo "OCR sandbox retained a Tesseract process after raster smoke." >&2
      return 1
    fi
    echo "No-network OCR sandbox, Tesseract rus+eng, UDS raster, shadow rollout, and internal OCR readiness smokes passed."
  else
    echo "Tesseract rus+eng, shadow rollout, native worker raster, and internal OCR readiness smokes passed in $MAXIM_MEDIA_ANALYSIS_SERVICE."
  fi
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
