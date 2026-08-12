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

test('Tesseract smoke requires exact rus and eng language lines', () => {
  const passing = runTopologyProbe(`
docker() { printf '%s\\n' 'List of available languages (2):' eng rus; }
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_smoke_media_analysis_tesseract compose_args
`);
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /rus\+eng/u);

  const missingRussian = runTopologyProbe(`
docker() { printf '%s\\n' 'List of available languages (2):' eng rus_old; }
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args; then exit 9; fi
`);
  assert.equal(missingRussian.status, 0, missingRussian.stderr);
  assert.match(missingRussian.stderr, /exact Tesseract language entries: rus and eng/u);
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
  assert.ok(
    deploy.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      deploy.lastIndexOf('record_successful_release'),
  );

  assert.match(
    scaleDeploy,
    /contains_service "\$MAXIM_MEDIA_ANALYSIS_SERVICE" "\$\{SERVICES\[@\]\}"/u,
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

test('production media-analysis role sandboxes native OCR parsing', () => {
  const compose = read('infra/docker-compose.yml');
  const service = compose.match(
    /\n {2}api-media-analysis:\n([\s\S]*?)(?=\n {2}[a-zA-Z0-9_-]+:|\nvolumes:|$)/u,
  )?.[1];

  assert.ok(service, 'missing api-media-analysis service');
  assert.match(service, /^\s+read_only:\s+true\s*$/mu);
  assert.match(service, /^\s+cap_drop:\n\s+- ALL\s*$/mu);
  assert.match(service, /^\s+security_opt:\n\s+- no-new-privileges:true\s*$/mu);
  assert.match(service, /^\s+tmpfs:\n\s+- \/tmp:size=64m,mode=1777,uid=1000,gid=1000\s*$/mu);
});
