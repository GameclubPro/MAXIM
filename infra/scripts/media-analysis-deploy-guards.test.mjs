import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const topologyPath = resolve(root, 'infra/scripts/lib/deploy-topology.sh');
const apiServices = [
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
];

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function runTopologyProbe(probe) {
  return spawnSync('bash', ['-c', `source "$TOPOLOGY_PATH"\n${probe}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TOPOLOGY_PATH: topologyPath },
  });
}

function commercialOcrComposeConfig(version, overrides = {}) {
  return JSON.stringify({
    services: Object.fromEntries(
      apiServices.map((service) => [
        service,
        {
          environment: {
            COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
            COMMERCIAL_OCR_VERSION: version,
            ...overrides[service],
          },
        },
      ]),
    ),
  });
}

test('detects media-analysis support from the target Git Compose source', () => {
  const present = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" ]]; then
    printf '%s\\n' 'services:' '  api-ingress:' '  api-media-analysis:'
    return 0
  fi
  return 2
}
maxim_topology_git_compose_has_service target-sha "$MAXIM_MEDIA_ANALYSIS_SERVICE"
`);
  assert.equal(present.status, 0, present.stderr);

  const absent = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" ]]; then
    printf '%s\\n' 'services:' '  api-ingress:' '    api-media-analysis: incidental-value'
    return 0
  fi
  return 2
}
maxim_topology_git_compose_has_service target-sha "$MAXIM_MEDIA_ANALYSIS_SERVICE"
`);
  assert.equal(absent.status, 1, absent.stderr);
});

test('extracts a single literal behavior version from the target Git source', () => {
  const literal = runTopologyProbe(`
git() {
  printf '%s\\n' "export const COMMERCIAL_OCR_DEFAULT_VERSION = 'tesseract-rus-eng-v1' as const;"
}
maxim_topology_git_commercial_ocr_version target-sha
`);
  assert.equal(literal.status, 0, literal.stderr);
  assert.equal(literal.stdout, 'tesseract-rus-eng-v1');

  for (const source of [
    'export const COMMERCIAL_OCR_DEFAULT_VERSION = resolveVersion();',
    "export const COMMERCIAL_OCR_DEFAULT_VERSION = 'valid';\\nexport const COMMERCIAL_OCR_DEFAULT_VERSION = 'duplicate';",
    "export const COMMERCIAL_OCR_DEFAULT_VERSION = 'unsafe value';",
  ]) {
    const invalid = runTopologyProbe(`
git() { printf '%b\\n' '${source}'; }
if maxim_topology_git_commercial_ocr_version target-sha; then exit 9; fi
`);
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.match(invalid.stderr, /COMMERCIAL_OCR_DEFAULT_VERSION/u);
  }
});

test('target preparation skips pre-feature commits and pins OCR commits to source version', () => {
  const withoutMediaAnalysis = runTopologyProbe(`
unset COMMERCIAL_OCR_VERSION
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" ]]; then printf '%s\\n' 'services:' '  api-ingress:'; return 0; fi
  return 2
}
docker() { echo 'docker must not be called' >&2; return 8; }
compose_args=(-p infra -f infra/docker-compose.yml)
has_media=9
version=sentinel
maxim_topology_prepare_commercial_ocr_target target-sha compose_args has_media version
printf '%s|%s|%s' "$has_media" "$version" "\${COMMERCIAL_OCR_VERSION-unset}"
`);
  assert.equal(withoutMediaAnalysis.status, 0, withoutMediaAnalysis.stderr);
  assert.equal(withoutMediaAnalysis.stdout, '0||unset');

  const config = commercialOcrComposeConfig('tesseract-rus-eng-v1');
  const withMediaAnalysis = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  case "$2" in
    *:infra/docker-compose.yml)
      printf '%s\\n' 'services:' '  api-ingress:' '  api-media-analysis:'
      ;;
    *:apps/api/src/moderation/commercial-ocr/commercial-ocr.queue.ts)
      printf '%s\\n' "export const COMMERCIAL_OCR_DEFAULT_VERSION = 'tesseract-rus-eng-v1';"
      ;;
    *) return 2 ;;
  esac
}
docker() { printf '%s' '${config}'; }
compose_args=(-p infra -f infra/docker-compose.yml)
has_media=0
version=''
maxim_topology_prepare_commercial_ocr_target target-sha compose_args has_media version
printf '%s|%s|%s' "$has_media" "$version" "$COMMERCIAL_OCR_VERSION"
`);
  assert.equal(withMediaAnalysis.status, 0, withMediaAnalysis.stderr);
  assert.equal(withMediaAnalysis.stdout, '1|tesseract-rus-eng-v1|tesseract-rus-eng-v1');
});

test('effective OCR version preflight requires the target version on all 13 API roles', () => {
  const matchingConfig = commercialOcrComposeConfig('tesseract-rus-eng-v2');
  const matching = runTopologyProbe(`
docker() { printf '%s' '${matchingConfig}'; }
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_require_api_commercial_ocr_version_config compose_args tesseract-rus-eng-v2
`);
  assert.equal(matching.status, 0, matching.stderr);

  for (const config of [
    commercialOcrComposeConfig('tesseract-rus-eng-v2', {
      'api-action': { COMMERCIAL_OCR_VERSION: 'stale-private-value' },
    }),
    JSON.stringify({
      services: Object.fromEntries(
        apiServices.slice(0, -1).map((service) => [
          service,
          {
            environment: {
              COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
              COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v2',
            },
          },
        ]),
      ),
    }),
  ]) {
    const rejected = runTopologyProbe(`
docker() { printf '%s' '${config}'; }
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_require_api_commercial_ocr_version_config compose_args tesseract-rus-eng-v2; then
  exit 9
fi
`);
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.match(rejected.stderr, /every production API role/u);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /stale-private-value/u);
  }
});

test('running OCR version verification inspects every production API container', () => {
  const passing = runTopologyProbe(`
docker() {
  if [[ "$1 $2" == "compose -p" && "$*" == *' ps -q '* ]]; then
    printf 'container-%s' "\${!#}"
    return 0
  fi
  if [[ "$1" == "inspect" ]]; then
    printf '%s\\n' 'NODE_ENV=production' 'COMMERCIAL_OCR_VERSION=tesseract-rus-eng-v2'
    return 0
  fi
  return 8
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_verify_api_commercial_ocr_version compose_args tesseract-rus-eng-v2
`);
  assert.equal(passing.status, 0, passing.stderr);

  const mismatch = runTopologyProbe(`
docker() {
  if [[ "$1 $2" == "compose -p" && "$*" == *' ps -q '* ]]; then
    printf 'container-%s' "\${!#}"
    return 0
  fi
  if [[ "$1" == "inspect" ]]; then
    if [[ "\${!#}" == 'container-api-action' ]]; then
      printf '%s\\n' 'COMMERCIAL_OCR_VERSION=stale-private-value'
    else
      printf '%s\\n' 'COMMERCIAL_OCR_VERSION=tesseract-rus-eng-v2'
    fi
    return 0
  fi
  return 8
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_verify_api_commercial_ocr_version compose_args tesseract-rus-eng-v2; then
  exit 9
fi
`);
  assert.equal(mismatch.status, 0, mismatch.stderr);
  assert.match(mismatch.stderr, /api-action does not run with the target/u);
  assert.doesNotMatch(`${mismatch.stdout}${mismatch.stderr}`, /stale-private-value/u);
});

test('removes only media-analysis from a pre-feature target service list', () => {
  const result = runTopologyProbe(`
services=(api-ingress api-media-analysis api-action)
maxim_topology_remove_service services "$MAXIM_MEDIA_ANALYSIS_SERVICE"
printf '%s\\n' "\${services[@]}"
`);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['api-ingress', 'api-action']);
});

test('full OCR smoke requires shadow mode, raster recognition, and internal readiness', () => {
  const passing = runTopologyProbe(`
order_file="$(mktemp)"
trap 'rm -f "$order_file"' EXIT
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' '/opt/ocr/tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' present ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'smoke-commercial-ocr-worker.js'*)
      printf '%s\\n' raster >> "$order_file"
      printf '%s\\n' 'Commercial OCR worker smoke passed.'
      ;;
    *'health/ready'*)
      printf '%s\\n' internal-ready >> "$order_file"
      return 0
      ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_smoke_media_analysis_tesseract compose_args required
cat "$order_file"
`);
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /internal OCR readiness smokes passed/u);
  assert.match(passing.stdout, /internal-ready\nraster/u);

  const missingRussian = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus_old ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args required; then exit 9; fi
`);
  assert.equal(missingRussian.status, 0, missingRussian.stderr);
  assert.match(missingRussian.stderr, /exact Tesseract language entries: rus and eng/u);

  const failedRaster = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' present ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'health/ready'*) return 0 ;;
    *'smoke-commercial-ocr-worker.js'*) return 7 ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args required; then exit 9; fi
`);
  assert.equal(failedRaster.status, 0, failedRaster.stderr);
  assert.match(failedRaster.stderr, /Native OCR worker raster smoke failed/u);

  const notReady = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' present ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'smoke-commercial-ocr-worker.js'*) return 7 ;;
    *'health/ready'*) return 1 ;;
    *) return 8 ;;
  esac
}
sleep() { :; }
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args required; then exit 9; fi
`);
  assert.equal(notReady.status, 0, notReady.stderr);
  assert.match(notReady.stderr, /did not reach internal OCR readiness/u);
});

test('legacy rollback keeps exact language smoke while new images require the raster marker', () => {
  const legacy = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' absent ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_smoke_media_analysis_tesseract compose_args if-present
`);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /legacy .* image: rus\+eng; raster smoke unavailable/u);

  const enforcingLegacy = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 1 ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' absent ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args if-present; then exit 9; fi
`);
  assert.equal(enforcingLegacy.status, 0, enforcingLegacy.stderr);
  assert.match(enforcingLegacy.stderr, /must run with COMMERCIAL_OCR_ROLLOUT_MODE=shadow/u);

  const required = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' absent ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args required; then exit 9; fi
`);
  assert.equal(required.status, 0, required.stderr);
  assert.match(required.stderr, /missing the required native OCR worker raster smoke/u);
});

test('shadow preflight is fail-closed without printing the effective value', () => {
  const shadow = runTopologyProbe(`
docker() {
  printf '%s' '{"services":{"api-media-analysis":{"environment":{"COMMERCIAL_OCR_ROLLOUT_MODE":"shadow"}}}}'
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_require_media_analysis_shadow_config compose_args
`);
  assert.equal(shadow.status, 0, shadow.stderr);

  const enforcing = runTopologyProbe(`
docker() {
  printf '%s' '{"services":{"api-media-analysis":{"environment":{"COMMERCIAL_OCR_ROLLOUT_MODE":"canary-sensitive-value"}}}}'
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_require_media_analysis_shadow_config compose_args; then exit 9; fi
`);
  assert.equal(enforcing.status, 0, enforcing.stderr);
  assert.match(enforcing.stderr, /effective COMMERCIAL_OCR_ROLLOUT_MODE=shadow/u);
  assert.doesNotMatch(`${enforcing.stdout}${enforcing.stderr}`, /canary-sensitive-value/u);
});

test('deploy and rollback pin OCR identity and order media before webhook roles', () => {
  const topology = read('infra/scripts/lib/deploy-topology.sh');
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const scaleDeploy = read('infra/scripts/vps-pull-build-up-scale.sh');
  const immutableRollback = read('infra/scripts/vps-release-rollback.sh');
  const refRollback = read('infra/scripts/vps-runtime-rollback.sh');

  assert.match(topology, /maxim_topology_git_commercial_ocr_version "\$commit_sha"/u);
  assert.match(deploy, /maxim_topology_prepare_commercial_ocr_target/u);
  assert.match(topology, /export COMMERCIAL_OCR_VERSION="\$resolved_version"/u);
  assert.match(deploy, /DEPLOY_RUNTIME_STARTED=0/u);
  assert.match(deploy, /DEPLOY_MANIFEST_RECORDED=0/u);
  assert.match(deploy, /invalidate_stale_release_inventory/u);
  assert.match(deploy, /current\.invalid-deploy-/u);
  assert.match(deploy, /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u);
  assert.ok(
    deploy.lastIndexOf('maxim_topology_prepare_commercial_ocr_target') <
      deploy.lastIndexOf('prepare_deploy_disk_capacity'),
  );
  assert.ok(
    deploy.lastIndexOf('maxim_topology_stop_media_analysis_before_api_transition') <
      deploy.lastIndexOf('recreate_service_wave "action and publisher"'),
  );
  assert.ok(
    deploy.lastIndexOf('recreate_service_wave "ingress"') <
      deploy.lastIndexOf('recreate_service_wave "media analysis"'),
  );
  assert.ok(
    deploy.lastIndexOf('recreate_service_wave "media analysis"') <
      deploy.lastIndexOf('recreate_service_wave "moderation"'),
  );
  assert.ok(
    deploy.lastIndexOf('recreate_service_wave "moderation"') <
      deploy.lastIndexOf('recreate_service_wave "enqueue"'),
  );
  assert.ok(
    deploy.lastIndexOf('recreate_service_wave "enqueue"') <
      deploy.lastIndexOf('maxim_topology_verify_api_commercial_ocr_version'),
  );
  assert.ok(
    deploy.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      deploy.lastIndexOf('record_successful_release'),
  );

  assert.match(scaleDeploy, /maxim_topology_prepare_commercial_ocr_target/u);
  assert.match(
    scaleDeploy,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u,
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_prepare_commercial_ocr_target') <
      scaleDeploy.lastIndexOf('prepare_scale_redis_named_volume'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') >
      scaleDeploy.lastIndexOf('ensure_requested_services_running'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_stop_media_analysis_before_api_transition') <
      scaleDeploy.lastIndexOf('recreate_service_wave "worker"'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('recreate_service_wave "ingress"') <
      scaleDeploy.lastIndexOf('recreate_service_wave "media analysis"'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('recreate_service_wave "media analysis"') <
      scaleDeploy.lastIndexOf('maxim_topology_verify_api_commercial_ocr_version'),
  );

  assert.match(
    immutableRollback,
    /maxim_topology_git_compose_has_service "\$API_SOURCE_SHA" "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.match(
    immutableRollback,
    /maxim_topology_remove_service SERVICES "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.match(
    immutableRollback,
    /maxim_topology_git_has_commercial_ocr_raster_smoke "\$API_SOURCE_SHA"/u,
  );
  assert.match(
    immutableRollback,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u,
  );
  assert.match(
    immutableRollback,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES if-present/u,
  );
  assert.ok(
    immutableRollback.indexOf('maxim_topology_prepare_commercial_ocr_target') <
      immutableRollback.indexOf('for component in "${SELECTED_COMPONENTS[@]}"'),
  );
  assert.match(immutableRollback, /maxim_topology_verify_api_commercial_ocr_version/u);
  assert.match(immutableRollback, /label=com\.docker\.compose\.project=infra/u);
  assert.match(
    immutableRollback,
    /label=com\.docker\.compose\.service=\$MAXIM_MEDIA_ANALYSIS_SERVICE/u,
  );
  assert.match(immutableRollback, /docker stop --time 30 "\$\{container_ids\[@\]\}"/u);
  assert.match(immutableRollback, /docker rm -f "\$\{container_ids\[@\]\}"/u);
  assert.ok(
    immutableRollback.lastIndexOf('maxim_topology_stop_media_analysis_before_api_transition') <
      immutableRollback.lastIndexOf('recreate_service api-admin'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('recreate_service api-ingress') <
      immutableRollback.lastIndexOf('recreate_service "$MAXIM_MEDIA_ANALYSIS_SERVICE"'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('recreate_service "$MAXIM_MEDIA_ANALYSIS_SERVICE"') <
      immutableRollback.lastIndexOf('recreate_service "$service"'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('recreate_service "$service"') <
      immutableRollback.lastIndexOf('recreate_service api-enqueue'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('recreate_service api-enqueue') <
      immutableRollback.lastIndexOf('maxim_topology_verify_api_commercial_ocr_version'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      immutableRollback.lastIndexOf('node infra/scripts/release-manifest.mjs'),
  );

  assert.match(
    refRollback,
    /maxim_topology_git_compose_has_service "\$TARGET_FULL_SHA" "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.match(
    refRollback,
    /maxim_topology_remove_service SERVICES "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.match(
    refRollback,
    /maxim_topology_git_has_commercial_ocr_raster_smoke "\$TARGET_FULL_SHA"/u,
  );
  assert.match(
    refRollback,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u,
  );
  assert.match(
    refRollback,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES if-present/u,
  );
  assert.ok(
    refRollback.indexOf('maxim_topology_prepare_commercial_ocr_target') <
      refRollback.indexOf('git switch --detach'),
  );
  assert.match(refRollback, /maxim_topology_verify_api_commercial_ocr_version/u);
  assert.match(refRollback, /label=com\.docker\.compose\.project=infra/u);
  assert.match(refRollback, /label=com\.docker\.compose\.service=\$MAXIM_MEDIA_ANALYSIS_SERVICE/u);
  assert.match(refRollback, /docker stop --time 30 "\$\{container_ids\[@\]\}"/u);
  assert.match(refRollback, /docker rm -f "\$\{container_ids\[@\]\}"/u);
  assert.ok(
    refRollback.lastIndexOf('maxim_topology_stop_media_analysis_before_api_transition') <
      refRollback.lastIndexOf('recreate_runtime_api_wave non-webhook'),
  );
  assert.ok(
    refRollback.lastIndexOf('recreate_runtime_api_wave non-webhook') <
      refRollback.lastIndexOf('recreate_runtime_api_wave media-analysis'),
  );
  assert.ok(
    refRollback.lastIndexOf('recreate_runtime_api_wave media-analysis') <
      refRollback.lastIndexOf('recreate_runtime_api_wave moderation'),
  );
  assert.ok(
    refRollback.lastIndexOf('recreate_runtime_api_wave moderation') <
      refRollback.lastIndexOf('recreate_runtime_api_wave enqueue'),
  );
  assert.ok(
    refRollback.lastIndexOf('wait_for_service_running "$service" 180') <
      refRollback.lastIndexOf('maxim_topology_verify_api_commercial_ocr_version'),
  );
  assert.ok(
    refRollback.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      refRollback.lastIndexOf('record_runtime_rollback_release'),
  );
});

test('read-only BullMQ monitor includes commercial image OCR', () => {
  const monitor = read('infra/scripts/vps-monitor-readonly.sh');
  assert.equal([...monitor.matchAll(/^ {2}commercial-image-ocr$/gmu)].length, 1);
});

test('read-only BullMQ monitor batches counters and includes every Publisher queue', () => {
  const monitor = read('infra/scripts/vps-monitor-readonly.sh');
  const queueBlock = monitor.match(/\nqueues=\(\n(?<queues>[\s\S]*?)\n\)\n/u)?.groups?.queues ?? '';
  assert.notEqual(queueBlock, '');
  assert.equal([...queueBlock.matchAll(/^ {2}moderation-default$/gmu)].length, 1);

  for (const queue of [
    'publisher-binding-refresh',
    'publisher-chat-comments',
    'publisher-auto-replies',
    'publisher-auto-reply-authoring',
    'publisher-post-import',
    'publisher-suggestion-publication',
    'publisher-suggestion-admin',
    'vk-parsing-publisher',
  ]) {
    assert.equal([...queueBlock.matchAll(new RegExp(`^ {2}${queue}$`, 'gmu'))].length, 1);
  }
  assert.doesNotMatch(monitor, /^ {2}managed-broadcast$/mu);
  assert.match(monitor, /redis-cli --raw eval "\$queue_counts_script"/u);
  assert.match(monitor, /local marker = redis\.call\(\\"LINDEX\\", key, -1\)/u);
  assert.match(monitor, /string\.sub\(marker, 1, 2\) == \\"0:\\"/u);
  assert.match(monitor, /failedTotal=%d/u);
  assert.match(monitor, /failedFresh=%d/u);
  assert.match(monitor, /failedFreshWindowSec=%d/u);
  assert.match(monitor, /failedFuture=%d/u);
  assert.match(monitor, /failedNewestAgeSec=%d/u);
  assert.match(monitor, /redis\.call\(\\"TIME\\"\)/u);
  assert.match(monitor, /ZCOUNT\\", KEYS\[5\], failedFreshCutoffMs, nowMs/u);
  assert.match(monitor, /ZCOUNT\\", KEYS\[5\], \\"\(\\" \.\. tostring\(nowMs\)/u);
  assert.match(monitor, /ZREVRANGE\\", KEYS\[5\], 0, 0, \\"WITHSCORES\\"/u);
  assert.doesNotMatch(monitor, /now_ms=.*date \+%s/u);
  assert.doesNotMatch(monitor, /RPOP/u);
  assert.doesNotMatch(monitor, /redis_count/u);
});

test('production media-analysis roles are singleton init-managed OCR sandboxes', () => {
  for (const [name, path] of [
    ['main', 'infra/docker-compose.yml'],
    ['scale', 'infra/docker-compose.scale.yml'],
  ]) {
    const compose = read(path);
    const service = compose.match(
      /\n {2}api-media-analysis:\n([\s\S]*?)(?=\n {2}[a-zA-Z0-9_-]+:|\nvolumes:|$)/u,
    )?.[1];

    assert.ok(service, `missing api-media-analysis service in ${name} Compose`);
    assert.match(service, /^\s+init:\s+true\s*$/mu);
    assert.match(service, /^\s+deploy:\n\s+replicas:\s+1\s*$/mu);
    assert.doesNotMatch(service, /^\s+COMMERCIAL_OCR_PROCESSOR_CONCURRENCY:/mu);
    assert.match(service, /^\s+COMMERCIAL_OCR_TESSERACT_CONCURRENCY:\s+1\s*$/mu);
    assert.match(service, /^\s+OMP_THREAD_LIMIT:\s+1\s*$/mu);
    assert.match(service, /^\s+read_only:\s+true\s*$/mu);
    assert.match(service, /^\s+cap_drop:\n\s+- ALL\s*$/mu);
    assert.match(
      service,
      new RegExp(
        `^\\s+security_opt:${name === 'scale' ? ' !override' : ''}\\n\\s+- no-new-privileges:true\\s*$`,
        'mu',
      ),
    );
    assert.match(service, /^\s+tmpfs:\n\s+- \/tmp:size=64m,mode=1777,uid=1000,gid=1000\s*$/mu);
  }
});
