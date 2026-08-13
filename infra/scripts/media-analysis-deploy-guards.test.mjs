import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const topologyPath = resolve(root, 'infra/scripts/lib/deploy-topology.sh');

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
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' '/opt/ocr/tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' present ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'smoke-commercial-ocr-worker.js'*) printf '%s\\n' 'Commercial OCR worker smoke passed.' ;;
    *'health/ready'*) return 0 ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_smoke_media_analysis_tesseract compose_args required
`);
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /internal OCR readiness smokes passed/u);

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
    *'smoke-commercial-ocr-worker.js'*) printf '%s\\n' 'Commercial OCR worker smoke passed.' ;;
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

test('deploy and rollback guard target topology and smoke Tesseract before manifest commit', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const scaleDeploy = read('infra/scripts/vps-pull-build-up-scale.sh');
  const immutableRollback = read('infra/scripts/vps-release-rollback.sh');
  const refRollback = read('infra/scripts/vps-runtime-rollback.sh');

  assert.match(
    deploy,
    /maxim_topology_git_compose_has_service "\$TARGET_SHA" "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.match(deploy, /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u);
  assert.ok(
    deploy.indexOf('maxim_topology_require_media_analysis_shadow_config COMPOSE_FILES') <
      deploy.lastIndexOf('prepare_deploy_disk_capacity'),
  );
  assert.ok(
    deploy.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      deploy.lastIndexOf('record_successful_release'),
  );

  assert.match(
    scaleDeploy,
    /contains_service "\$MAXIM_MEDIA_ANALYSIS_SERVICE" "\$\{SERVICES\[@\]\}"/u,
  );
  assert.match(
    scaleDeploy,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u,
  );
  assert.ok(
    scaleDeploy.indexOf('maxim_topology_require_media_analysis_shadow_config COMPOSE_FILES') <
      scaleDeploy.lastIndexOf('prepare_scale_redis_named_volume'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') >
      scaleDeploy.lastIndexOf('ensure_requested_services_running'),
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
    immutableRollback.indexOf(
      'maxim_topology_require_media_analysis_shadow_config COMPOSE_FILES',
    ) < immutableRollback.indexOf("for component in \"${SELECTED_COMPONENTS[@]}\""),
  );
  assert.match(
    immutableRollback,
    /if \[\[ "\$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 \]\]; then\n {4}maxim_topology_require_media_analysis_shadow_config COMPOSE_FILES/u,
  );
  assert.match(immutableRollback, /label=com\.docker\.compose\.project=infra/u);
  assert.match(
    immutableRollback,
    /label=com\.docker\.compose\.service=\$MAXIM_MEDIA_ANALYSIS_SERVICE/u,
  );
  assert.match(immutableRollback, /docker stop --time 30 "\$\{container_ids\[@\]\}"/u);
  assert.match(immutableRollback, /docker rm -f "\$\{container_ids\[@\]\}"/u);
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
    refRollback.indexOf('maxim_topology_require_media_analysis_shadow_config COMPOSE_FILES') <
      refRollback.indexOf('git switch --detach'),
  );
  assert.match(
    refRollback,
    /if \[\[ "\$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 \]\]; then\n {2}maxim_topology_require_media_analysis_shadow_config COMPOSE_FILES/u,
  );
  assert.match(refRollback, /label=com\.docker\.compose\.project=infra/u);
  assert.match(refRollback, /label=com\.docker\.compose\.service=\$MAXIM_MEDIA_ANALYSIS_SERVICE/u);
  assert.match(refRollback, /docker stop --time 30 "\$\{container_ids\[@\]\}"/u);
  assert.match(refRollback, /docker rm -f "\$\{container_ids\[@\]\}"/u);
  assert.ok(
    refRollback.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      refRollback.lastIndexOf('record_runtime_rollback_release'),
  );
});

test('read-only BullMQ monitor includes commercial image OCR', () => {
  const monitor = read('infra/scripts/vps-monitor-readonly.sh');
  assert.equal([...monitor.matchAll(/^ {2}commercial-image-ocr$/gmu)].length, 1);
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
