import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildReleaseManifest } from './release-manifest.mjs';
import { ACTIVE_RELEASE_COMPONENTS } from './release-manifest.mjs';
import {
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

test('default plan selects every active component and all twelve API roles', () => {
  const plan = buildRollbackPlan({
    manifest: completeManifest(),
    now: new Date('2026-07-19T12:34:56.789Z'),
    pid: 42,
  });

  assert.deepEqual(
    plan.components.map(({ id }) => id),
    ACTIVE_RELEASE_COMPONENTS,
  );
  assert.deepEqual(plan.services, [
    ...PRODUCTION_API_SERVICES,
    'miniapp-major-static',
    'admin-static',
  ]);
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
  assert.deepEqual(plan.services, [...PRODUCTION_API_SERVICES, 'admin-static']);
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

function resolveRepoFile(path) {
  return resolve(import.meta.dirname, '..', '..', path);
}

function readRepoFile(path) {
  return readFileSync(resolve(import.meta.dirname, '..', '..', path), 'utf8');
}
