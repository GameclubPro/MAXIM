import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildReleaseManifest } from './release-manifest.mjs';
import { ACTIVE_RELEASE_COMPONENTS } from './release-manifest.mjs';
import {
  API_SHARED_SERVICES,
  PRODUCTION_API_SERVICES,
  buildRollbackPlan,
  buildRollbackReleaseId,
  renderRollbackPlanTsv,
} from './release-rollback-plan.mjs';

const sha = (digit) => digit.repeat(40);
const imageId = (digit) => `sha256:${digit.repeat(64)}`;

function component(id, digit) {
  const imageName = {
    'api-shared': 'maxim-api',
    'miniapp-major-static': 'maxim-miniapp-major',
    'admin-static': 'maxim-admin',
  }[id];
  return {
    id,
    sourceSha: sha(digit),
    imageRef: `${imageName}:${sha(digit)}`,
    imageId: imageId(digit),
  };
}

function completeManifest() {
  return buildReleaseManifest({
    releaseId: 'release-source',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'b'),
      component('admin-static', 'c'),
    ],
    migrations: ['20260101000000_initial'],
    createdAt: '2026-07-19T00:00:00.000Z',
  });
}

test('default plan selects every active component, fourteen API roles, and its sandboxes', () => {
  const plan = buildRollbackPlan({
    manifest: completeManifest(),
    now: new Date('2026-07-19T12:34:56.789Z'),
    pid: 42,
  });

  assert.deepEqual(
    plan.components.map(({ id }) => id),
    ACTIVE_RELEASE_COMPONENTS,
  );
  assert.deepEqual(plan.services, [...API_SHARED_SERVICES, 'miniapp-major-static', 'admin-static']);
  assert.equal(plan.targetSha, sha('a'));
  assert.equal(plan.rollbackReleaseId, `rollback-20260719T123456789Z-${sha('a').slice(0, 12)}-42`);
});

test('component arguments are safe, deduplicated by rejection, and emitted in canonical order', () => {
  const plan = buildRollbackPlan({
    manifest: completeManifest(),
    requestedComponents: ['admin-static', 'api-shared'],
  });

  assert.deepEqual(
    plan.components.map(({ id }) => id),
    ['api-shared', 'admin-static'],
  );
  assert.deepEqual(plan.services, [...API_SHARED_SERVICES, 'admin-static']);
  assert.throws(
    () =>
      buildRollbackPlan({
        manifest: completeManifest(),
        requestedComponents: ['api-shared', 'api-shared'],
      }),
    /Duplicate rollback component/u,
  );
  assert.throws(
    () =>
      buildRollbackPlan({
        manifest: completeManifest(),
        requestedComponents: ['miniapp-static'],
      }),
    /Unknown rollback component/u,
  );
});

test('rejects inventory, incomplete, mutable, or unsafe image metadata', () => {
  const inventory = buildReleaseManifest({
    releaseId: 'inventory-only',
    targetSha: 'unknown',
    components: [
      {
        id: 'api-shared',
        sourceSha: 'unknown',
        imageRef: 'maxim-api:unknown',
        imageId: 'unknown',
      },
    ],
  });
  assert.throws(() => buildRollbackPlan({ manifest: inventory }), /known full targetSha/u);

  const missing = buildReleaseManifest({
    releaseId: 'missing-static',
    targetSha: sha('a'),
    components: [component('api-shared', 'a')],
  });
  assert.throws(() => buildRollbackPlan({ manifest: missing }), /has no miniapp-major-static/u);

  const unknownId = structuredClone(completeManifest());
  unknownId.components['api-shared'].imageId = 'unknown';
  assert.throws(
    () => buildRollbackPlan({ manifest: unknownId, requestedComponents: ['api-shared'] }),
    /unknown Docker image id/u,
  );

  const unsafeRef = structuredClone(completeManifest());
  unsafeRef.components['api-shared'].imageRef = '--help';
  assert.throws(
    () => buildRollbackPlan({ manifest: unsafeRef, requestedComponents: ['api-shared'] }),
    /unsafe Docker image ref/u,
  );

  const mutableRef = structuredClone(completeManifest());
  mutableRef.components['api-shared'].imageRef = 'maxim-api:latest';
  assert.throws(
    () => buildRollbackPlan({ manifest: mutableRef, requestedComponents: ['api-shared'] }),
    /image ref is mutable or does not match sourceSha/u,
  );

  const digestRef = structuredClone(completeManifest());
  digestRef.components['api-shared'].imageRef = `registry.example/maxim-api@${imageId('d')}`;
  assert.doesNotThrow(() =>
    buildRollbackPlan({ manifest: digestRef, requestedComponents: ['api-shared'] }),
  );

  const refFallback = structuredClone(completeManifest());
  refFallback.components['api-shared'].imageRef = `maxim-api:runtime-rollback-${sha('a')}`;
  assert.doesNotThrow(() =>
    buildRollbackPlan({ manifest: refFallback, requestedComponents: ['api-shared'] }),
  );
});

test('renders deterministic validated TSV without dormant delivery targets', () => {
  const plan = buildRollbackPlan({
    manifest: completeManifest(),
    requestedComponents: ['miniapp-major-static'],
    now: new Date('2026-07-19T12:34:56.789Z'),
    pid: 7,
  });
  const rendered = renderRollbackPlanTsv(plan);

  assert.match(rendered, /^source-release-id\trelease-source$/mu);
  assert.match(rendered, /^component\tminiapp-major-static\t[0-9a-f]+\tmaxim-miniapp-major:/mu);
  assert.match(rendered, /^service\tminiapp-major-static\tminiapp-major-static$/mu);
  assert.doesNotMatch(rendered, /app2|cdn|object-storage|miniapp-static/iu);
  assert.equal(
    buildRollbackReleaseId(sha('a'), new Date('2026-07-19T12:34:56.789Z'), 7),
    `rollback-20260719T123456789Z-${sha('a').slice(0, 12)}-7`,
  );
});

test('API service fixture stays aligned with deploy topology', () => {
  const topology = readRepoFile('infra/scripts/lib/deploy-topology.sh');
  const match = topology.match(/^MAXIM_PRODUCTION_API_SERVICES=\(\n([\s\S]*?)^\)/mu);
  assert.ok(match?.[1]);
  const shellServices = [...match[1].matchAll(/^\s+"([^"]+)"$/gmu)].map((item) => item[1]);
  assert.deepEqual(PRODUCTION_API_SERVICES, shellServices);
});

test('rollback shell is syntactically valid and has no build, migration, or Git-switch path', () => {
  const scriptPath = resolveRepoFile('infra/scripts/vps-release-rollback.sh');
  execFileSync('bash', ['-n', scriptPath]);
  const script = readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(script, /git (?:switch|checkout)/u);
  assert.doesNotMatch(script, /prisma migrate|migrate deploy/u);
  assert.doesNotMatch(script, /docker (?:build|buildx)|maxim_topology_build_shared_api_image/u);
  assert.match(script, /docker image inspect --format '\{\{\.Id\}\}'/u);
  assert.match(script, /docker inspect --format '\{\{\.Image\}\}'/u);
  assert.match(script, /--no-deps --no-build --force-recreate/u);
  assert.match(script, /scripts\/smoke-http\.mjs/u);
  assert.match(script, /release-manifest\.mjs/u);
  assert.match(script, /Node 24 is required for immutable release rollback/u);
  assert.ok(
    script.indexOf('Node 24 is required for immutable release rollback') <
      script.indexOf('acquire_deploy_lock'),
  );
  assert.match(script, /redis-cli ping/u);
  assert.doesNotMatch(script, /up -d (?:postgres|redis)/u);
  assert.match(
    script,
    /if \[\[ "\$SELECT_API" -eq 1 \]\]; then\n {2}if ! docker compose[^\n]+grep -qx postgres; then/u,
  );
  assert.match(script, /if \[\[ "\$SELECT_API" -eq 1 \]\]; then\n {2}require_command git/u);
  const inheritedApiFenceStart = script.indexOf('verify_inherited_api_component()');
  const inheritedApiFence = script.slice(
    inheritedApiFenceStart,
    script.indexOf('\n}\n', inheritedApiFenceStart) + 2,
  );
  assert.doesNotMatch(inheritedApiFence, /\bgit\b|sourceSha|cat-file/u);
  assert.match(inheritedApiFence, /MAXIM_PRODUCTION_API_SERVICES/u);
  assert.match(
    script,
    /if \[\[ "\$SELECT_API" -eq 1 \]\]; then\n {2}COMMIT_ARGS\+=\(--migrations-file/u,
  );
  assert.match(script, /MAXIM_API_IMAGE/u);
  assert.match(script, /MAXIM_MINIAPP_MAJOR_IMAGE/u);
  assert.match(script, /MAXIM_ADMIN_IMAGE/u);
  assert.match(script, /ensure_commit_has_applied_migrations/u);
  assert.match(script, /is_applied_migration_superseded_in_source/u);
  assert.match(script, /20260311153000_add_night_mode_open_message_enabled/u);
  assert.match(script, /20260311160000_add_night_mode_open_message_text/u);
  assert.match(script, /20260316113000_add_night_mode_open_message/u);
  assert.ok(
    script.indexOf('grep -Fxq "$replacement_migration" "$APPLIED_MIGRATIONS_FILE"') <
      script.indexOf('superseded_migrations+=("$migration")'),
  );
  assert.ok(
    script.indexOf('grep -Fxq "$replacement_migration" "$SOURCE_MIGRATIONS_FILE"') <
      script.indexOf('superseded_migrations+=("$migration")'),
  );
  assert.match(script, /ROLLBACK_RUNTIME_STARTED=0/u);
  assert.match(script, /ROLLBACK_MANIFEST_RECORDED=0/u);
  assert.match(script, /invalidate_stale_release_inventory/u);
  assert.match(script, /current\.invalid-release-rollback-/u);
  assert.ok(
    script.indexOf('ROLLBACK_RUNTIME_STARTED=1') <
      script.indexOf(
        'docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate',
      ),
  );
  assert.ok(
    script.indexOf('node infra/scripts/release-manifest.mjs "${COMMIT_ARGS[@]}"') <
      script.indexOf('ROLLBACK_MANIFEST_RECORDED=1'),
  );
  assert.match(script, /API_SOURCE_SHA="\$\{COMPONENT_SOURCE_SHA\[api-shared\]\}"/u);
  assert.match(script, /git cat-file -e "\$\{API_SOURCE_SHA\}\^\{commit\}"/u);
  assert.doesNotMatch(script, /git cat-file -e "\$\{TARGET_SHA\}\^\{commit\}"/u);
  assert.doesNotMatch(script, /ensure_commit_has_applied_migrations "\$TARGET_SHA"/u);
  assert.match(
    script,
    /ensure_commit_has_applied_migrations "\$API_SOURCE_SHA" "API component source"/u,
  );
  assert.ok(
    script.indexOf('Prisma compatibility preflight passed') <
      script.indexOf('recreate_service api-admin'),
  );
  assert.ok(
    script.lastIndexOf('for service in "${SERVICES[@]}"; do') <
      script.indexOf('wait_for_strict_smoke json-ok'),
  );
  assert.ok(
    script.indexOf('wait_for_strict_smoke json-ok') <
      script.indexOf('node infra/scripts/release-manifest.mjs "${COMMIT_ARGS[@]}"'),
  );
});

test('legacy ref rollback is API-only and builds a SHA-scoped temporary image tag', () => {
  const scriptPath = resolveRepoFile('infra/scripts/vps-runtime-rollback.sh');
  execFileSync('bash', ['-n', scriptPath]);
  const script = readFileSync(scriptPath, 'utf8');

  assert.match(script, /validate_requested_api_services/u);
  assert.match(script, /Runtime ref rollback supports API roles only/u);
  assert.match(script, /maxim_topology_expand_api_services SERVICES/u);
  assert.match(script, /TARGET_FULL_SHA="\$\(git rev-parse/u);
  assert.match(script, /ROLLBACK_API_IMAGE="maxim-api:runtime-rollback-\$\{TARGET_FULL_SHA\}"/u);
  assert.match(
    script,
    /maxim_topology_build_shared_api_image "\$ROLLBACK_API_IMAGE" "\$TARGET_FULL_SHA"/u,
  );
  assert.match(script, /ensure_stateful_services_ready/u);
  assert.match(script, /refuse_conflicting_scale_stack/u);
  assert.match(script, /redis-cli ping/u);
  assert.doesNotMatch(script, /up -d (?:postgres|redis)/u);
  assert.doesNotMatch(script, /SCALE_COMPOSE_FILES\[@\][^\n]+down/u);
  assert.match(script, /PRESERVED_COMPOSE_FILE/u);
  assert.match(script, /cp infra\/docker-compose\.yml/u);
  assert.match(script, /cp infra\/scripts\/release-manifest\.mjs/u);
  assert.match(script, /cp scripts\/smoke-http\.mjs/u);
  assert.match(script, /verify_service_image_id/u);
  assert.match(script, /strict_smoke_json_ok/u);
  assert.match(script, /record_runtime_rollback_release/u);
  assert.match(script, /invalidate_stale_release_inventory/u);
  assert.ok(
    script.lastIndexOf('strict_smoke_json_ok') <
      script.lastIndexOf('record_runtime_rollback_release'),
  );
  assert.doesNotMatch(script, /maxim_topology_build_shared_api_image infra/u);
});

for (const rollbackKind of ['immutable', 'runtime-ref']) {
  for (const hasPublisher of [true, false]) {
    test(`${rollbackKind} recreation converges every API role with Publisher ${hasPublisher ? 'present' : 'absent'}`, () => {
      const result = runApiRecreationFixture(rollbackKind, { hasPublisher });
      assert.equal(result.status, 0, result.stderr);
      const events = fixtureEvents(result.stdout);
      const expectedServices = PRODUCTION_API_SERVICES.filter(
        (service) => hasPublisher || service !== 'api-publisher',
      );
      const recreated = events.filter(([event]) => event === 'recreate').map(([, role]) => role);
      const verified = events.filter(([event]) => event === 'verify').map(([, role]) => role);
      assert.deepEqual([...recreated].sort(), [...expectedServices].sort());
      assert.deepEqual(verified, expectedServices);
      const retentionIndex = recreated.indexOf('api-message-retention');
      const firstConsumerIndex = recreated.findIndex((role) => role.startsWith('api-moderation'));
      assert.ok(retentionIndex < firstConsumerIndex);
      assert.equal(recreated.at(-1), 'api-enqueue');
      assert.ok(eventIndex(events, 'media-stop') < eventIndex(events, 'ocr-recreate'));
      assert.ok(
        eventIndex(events, 'ocr-smoke') < eventIndex(events, 'recreate', 'api-media-analysis'),
      );
      assert.ok(
        eventIndex(events, 'photo-reconcile') <
          eventIndex(events, 'recreate', 'api-moderation-background'),
      );
      assert.ok(
        eventIndex(events, 'verify', 'api-message-retention') < eventIndex(events, 'resume'),
      );
      assert.ok(eventIndex(events, 'live-smoke') < eventIndex(events, 'resume'));
      assert.equal(events.at(-1)?.[0], 'resume');
    });
  }

  test(`${rollbackKind} recreation failure at retention preserves the paused queue fence`, () => {
    const result = runApiRecreationFixture(rollbackKind, { failService: 'api-message-retention' });
    assert.equal(result.status, 17, result.stderr);
    const events = fixtureEvents(result.stdout);
    assert.ok(eventIndex(events, 'quiesce') >= 0);
    assert.equal(eventIndex(events, 'resume'), -1);
    assert.equal(eventIndex(events, 'recreate', 'api-enqueue'), -1);
    assert.equal(eventIndex(events, 'verify', 'api-message-retention'), -1);
  });
}

function fixtureEvents(output) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('fixture-event\t'))
    .map((line) => line.split('\t').slice(1));
}

function eventIndex(events, name, value) {
  return events.findIndex(
    ([event, detail]) => event === name && (value === undefined || detail === value),
  );
}

function scriptSection(script, start, end, includeEnd = false) {
  const startIndex = script.indexOf(start);
  const endIndex = script.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing Bash fixture section: ${start}`);
  return script.slice(startIndex, endIndex + (includeEnd ? end.length : 0));
}

function shellFunction(script, name) {
  return scriptSection(script, `${name}() {\n`, '\n}\n', true);
}

function runApiRecreationFixture(rollbackKind, { hasPublisher = true, failService = '' } = {}) {
  const script = readRepoFile(
    rollbackKind === 'immutable'
      ? 'infra/scripts/vps-release-rollback.sh'
      : 'infra/scripts/vps-runtime-rollback.sh',
  );
  const recreation =
    rollbackKind === 'immutable'
      ? shellFunction(script, 'recreate_service') +
        '\n' +
        scriptSection(script, 'SMOKE_RESULTS=()', '\nif [[ "$SELECT_MINIAPP" -eq 1 ]]')
      : scriptSection(
          script,
          'recreate_runtime_api_wave() {\n',
          '\nwait_for_url "http://127.0.0.1:3001/api/health/ready"',
        );
  const verifyFunction = shellFunction(script, 'verify_service_image_id').replace(
    'verify_service_image_id()',
    'verify_service_image_id_impl()',
  );
  const services = PRODUCTION_API_SERVICES.filter(
    (service) => hasPublisher || service !== 'api-publisher',
  );
  const fixture = `
ROOT_DIR=/fixture
maxim_require_ordinary_effect_authority() { return 0; }
COMPOSE_FILES=(-f fixture-compose.yml)
SERVICES=(${services.join(' ')})
MAXIM_WEBHOOK_MODERATION_SERVICES=(${PRODUCTION_API_SERVICES.filter((service) => service.startsWith('api-moderation')).join(' ')})
SELECT_API=1
TARGET_HAS_PUBLISHER=${hasPublisher ? 1 : 0}
TARGET_HAS_MEDIA_ANALYSIS=1
TARGET_HAS_OCR_NATIVE_SANDBOX=1
MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=1
MAXIM_MEDIA_ANALYSIS_SERVICE=api-media-analysis
TARGET_COMMERCIAL_OCR_VERSION=fixture-ocr-version
ROLLBACK_API_IMAGE_ID=sha256:fixture-target
declare -A COMPONENT_IMAGE_ID=([api-shared]="$ROLLBACK_API_IMAGE_ID")
declare -A running_images=()
for service in "\${SERVICES[@]}"; do running_images["$service"]=sha256:fixture-old; done
paused=0
quiescence_permit=0
event() { printf 'fixture-event\t%s\t%s\n' "$1" "\${2:-}"; }
maxim_webhook_quiesce_for_api_rollout() { paused=1; event quiesce; }
maxim_webhook_assert_api_rollout_quiescence() { [[ "$paused" -eq 1 ]]; quiescence_permit=1; }
maxim_topology_is_api_service() { [[ -v "running_images[$1]" ]]; }
maxim_topology_require_publisher_secret_files() { :; }
remove_incompatible_publisher_container() { event publisher-remove; }
maxim_topology_stop_media_analysis_before_api_transition() { event media-stop; }
maxim_topology_recreate_ocr_native_sandbox() { event ocr-recreate; }
maxim_topology_smoke_ocr_native_sandbox_uds() { event ocr-smoke; }
maxim_topology_verify_ocr_native_sandbox_runtime() { :; }
maxim_topology_reconcile_photo_native_sandbox() { event photo-reconcile; }
maxim_topology_verify_api_commercial_ocr_version() { :; }
maxim_topology_verify_photo_native_sandbox_for_image() { :; }
maxim_topology_smoke_photo_native_sandbox_uds() { :; }
wait_for_strict_smoke() { event live-smoke; }
wait_for_url() { event live-smoke; }
wait_for_service_running() { [[ "\${running_images[$1]}" == "$ROLLBACK_API_IMAGE_ID" ]]; }
contains_service() {
  local expected="$1" service
  shift
  for service in "$@"; do [[ "$service" != "$expected" ]] || return 0; done
  return 1
}
docker() {
  if [[ "$1" == compose && "\${4:-}" == up ]]; then
    [[ "$paused" -eq 1 && "$quiescence_permit" -eq 1 ]]
    quiescence_permit=0
    shift 8
    local service
    for service in "$@"; do
      [[ -v "running_images[$service]" ]]
      [[ "$service" != '${failService}' ]] || return 17
      running_images["$service"]="$ROLLBACK_API_IMAGE_ID"
      event recreate "$service"
    done
  elif [[ "$1" == compose && "\${4:-}" == ps ]]; then
    printf '%s\n' "\${@: -1}"
  elif [[ "$1" == inspect ]]; then
    printf '%s\n' "\${running_images[\${@: -1}]}"
  else
    printf 'Unexpected Docker fixture invocation\n' >&2
    return 99
  fi
}
${verifyFunction}
verify_service_image_id() { verify_service_image_id_impl "$@"; event verify "$1"; }
maxim_webhook_resume_after_api_fence() {
  local service
  for service in "\${SERVICES[@]}"; do [[ "\${running_images[$service]}" == "$ROLLBACK_API_IMAGE_ID" ]]; done
  paused=0
  event resume
}
${rollbackKind === 'runtime-ref' ? 'maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES\nmaxim_topology_stop_media_analysis_before_api_transition COMPOSE_FILES' : ''}
${recreation}
`;
  return spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-s'], {
    input: fixture,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function resolveRepoFile(path) {
  return resolve(import.meta.dirname, '..', '..', path);
}

function readRepoFile(path) {
  return readFileSync(resolve(import.meta.dirname, '..', '..', path), 'utf8');
}
