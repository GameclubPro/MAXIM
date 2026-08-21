import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
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
];

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function functionBlock(script, name) {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `Missing shell function: ${name}`);
  const end = script.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `Unterminated shell function: ${name}`);
  return script.slice(start, end + 2);
}

function callIndex(script, call) {
  const indexes = callIndexes(script, call);
  return indexes.at(-1);
}

function callIndexes(script, call) {
  const expression = new RegExp(
    `^\\s*${call.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\s|$)`,
    'gmu',
  );
  let match;
  const indexes = [];
  while ((match = expression.exec(script))) {
    indexes.push(match.index);
  }
  assert.notEqual(indexes.length, 0, `Missing shell call: ${call}`);
  return indexes;
}

function readShellArray(script, name) {
  const match = new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)`, 'mu').exec(script);
  assert.ok(match?.[1], `Missing shell array ${name}`);
  return [...match[1].matchAll(/^\s+"([^"]+)"\s*$/gmu)].map((entry) => entry[1]);
}

function validateApiReadyTimeout(value) {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const validation = functionBlock(deploy, 'validate_api_ready_timeout');
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail\n${validation}\nAPI_READY_TIMEOUT_SEC="$1"\nvalidate_api_ready_timeout`,
      'ready-timeout-test',
      value,
    ],
    { encoding: 'utf8' },
  );
}

test('keeps shared API topology centralized and complete', () => {
  const topology = read('infra/scripts/lib/deploy-topology.sh');
  const monitor = read('infra/scripts/vps-monitor-readonly.sh');
  assert.deepEqual(readShellArray(topology, 'MAXIM_PRODUCTION_API_SERVICES'), apiServices);
  assert.match(monitor, /SERVICES=\("\$\{MAXIM_PRODUCTION_API_SERVICES\[@\]\}"\)/u);
  assert.match(topology, /docker buildx build --load --provenance=false/u);
});

test('copies deterministic root build helpers into workspace Docker build stages', () => {
  const apiDockerfile = read('apps/api/Dockerfile');
  const miniappDockerfile = read('apps/miniapp/Dockerfile');

  assert.match(apiDockerfile, /^COPY scripts scripts$/mu);
  assert.match(miniappDockerfile, /^COPY scripts scripts$/mu);
  assert.match(
    miniappDockerfile,
    /^COPY apps\/api\/jest\.config\.cjs apps\/api\/jest\.config\.cjs$/mu,
  );
});

test('validates Compose with the public env while keeping the runtime env default', () => {
  const compose = read('infra/docker-compose.yml');
  const scaleCompose = read('infra/docker-compose.scale.yml');
  const infraCheck = read('infra/scripts/check-infra.sh');
  const runtimeEnvReference = /\$\{MAXIM_COMPOSE_SERVICE_ENV_FILE:-\.\.\/\.env\}/gu;

  assert.equal([...compose.matchAll(runtimeEnvReference)].length, apiServices.length);
  assert.equal([...scaleCompose.matchAll(runtimeEnvReference)].length, apiServices.length);
  assert.match(infraCheck, /MAXIM_COMPOSE_SERVICE_ENV_FILE=\.\.\/\.env\.example/u);
  assert.match(infraCheck, /docker compose --env-file \.env\.example/u);
});

test('caps json-file logs for stateful services in both Compose topologies', () => {
  for (const path of ['infra/docker-compose.yml', 'infra/docker-compose.scale.yml']) {
    const compose = read(path);
    const postgresBlock = compose.slice(
      compose.indexOf('  postgres:\n'),
      compose.indexOf('  redis:\n'),
    );
    const redisBlock = compose.slice(
      compose.indexOf('  redis:\n'),
      compose.indexOf('  api-ingress:\n'),
    );

    assert.match(postgresBlock, /logging: \*default-logging/u, `${path} postgres logging`);
    assert.match(redisBlock, /logging: \*default-logging/u, `${path} redis logging`);
  }
});

test('validates deploy targets before synchronization or runtime side effects', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const validation = callIndexes(deploy, 'validate_requested_services')[0];
  const readyTimeoutValidation = callIndexes(deploy, 'validate_api_ready_timeout')[0];
  const nodePreflight = callIndex(deploy, 'require_node_24');
  assert.ok(nodePreflight < callIndex(deploy, 'acquire_deploy_lock'));
  assert.ok(nodePreflight < callIndex(deploy, 'sync_branch'));
  assert.ok(validation < callIndex(deploy, 'acquire_deploy_lock'));
  assert.ok(validation < callIndex(deploy, 'sync_branch'));
  assert.ok(readyTimeoutValidation < callIndex(deploy, 'acquire_deploy_lock'));
  assert.ok(readyTimeoutValidation < callIndex(deploy, 'sync_branch'));
  assert.ok(validation < callIndex(deploy, 'stop_conflicting_stacks'));
  assert.match(deploy, /Node 24 is required for production deploy/u);
  assert.match(deploy, /Unknown or unsafe deploy service/u);
  assert.match(
    deploy,
    /MAXIM_EXPECTED_DEPLOY_SHA is required for every mutating production deploy/u,
  );
  assert.match(deploy, /if \[\[ "\$DEPLOY_MODE" == "plan" \]\]/u);
  assert.match(deploy, /MAXIM_DEPLOY_API_READY_TIMEOUT_SEC:-900/u);
});

test('bounds the post-resume API readiness window without weakening readiness', () => {
  for (const value of ['180', '900', '3600']) {
    assert.equal(validateApiReadyTimeout(value).status, 0, value);
  }
  for (const value of ['', '0', '0179', '179', '3601', '9999', '-1', '1e3', '900s']) {
    const result = validateApiReadyTimeout(value);
    assert.equal(result.status, 2, value);
    assert.match(result.stderr, /must be an integer between 180 and 3600/u, value);
  }
});

test('re-executes deploy entrypoints when the loaded disk-capacity library changes', () => {
  for (const path of [
    'infra/scripts/vps-pull-build-up.sh',
    'infra/scripts/vps-pull-build-up-scale.sh',
  ]) {
    const deploy = read(path);
    const reexecBlock = deploy.slice(
      deploy.indexOf('reexec_if_current_script_changed()'),
      deploy.indexOf('\n}', deploy.indexOf('reexec_if_current_script_changed()')) + 2,
    );

    assert.match(reexecBlock, /infra\/scripts\/lib\/deploy-disk-capacity\.sh/u, path);
    if (path.endsWith('vps-pull-build-up.sh')) {
      assert.match(reexecBlock, /infra\/scripts\/lib\/webhook-rollout-quiescence\.sh/u, path);
    }
  }
});

test('forwards explicit webhook pause recovery only through guarded rollout entrypoints', () => {
  const connect = read('infra/scripts/vps-connect.sh');
  const recoveryHelper = functionBlock(connect, 'prepend_webhook_rollout_recovery_env');

  assert.match(recoveryHelper, /MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE:-0/u);
  assert.match(recoveryHelper, /MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1/u);
  assert.match(recoveryHelper, /must be 0 or 1/u);
  for (const name of ['deploy_main', 'rollback_runtime', 'rollback_release']) {
    assert.match(
      functionBlock(connect, name),
      /prepend_webhook_rollout_recovery_env remote_command/u,
      name,
    );
  }
});

test('synchronizes rollback entrypoints to reviewed main under the shared deploy lock', () => {
  const connect = read('infra/scripts/vps-connect.sh');
  const bootstrapStart = connect.indexOf('rollback_entrypoint_bootstrap_source()');
  const bootstrap = connect.slice(
    bootstrapStart,
    connect.indexOf('\nBOOTSTRAP\n}', bootstrapStart) + '\nBOOTSTRAP\n}'.length,
  );
  const builder = functionBlock(connect, 'build_guarded_rollback_command');

  assert.match(bootstrap, /lock_dir=\/tmp\/maxim-main-deploy\.lock/u);
  assert.ok(
    bootstrap.indexOf('grep -Fq -- "$capability_marker" "$entrypoint"') <
      bootstrap.indexOf('git status --porcelain --untracked-files=no'),
  );
  assert.match(bootstrap, /git status --porcelain --untracked-files=no/u);
  assert.doesNotMatch(bootstrap, /git fetch|git pull/u);
  assert.match(bootstrap, /git cat-file -e "\$\{expected_tooling_sha\}\^\{commit\}"/u);
  assert.match(bootstrap, /git rev-parse --verify refs\/heads\/main/u);
  assert.match(bootstrap, /source "\$entrypoint" "\$@"/u);
  assert.match(builder, /git rev-parse --verify --end-of-options 'main\^\{commit\}'/u);
  for (const name of ['rollback_runtime', 'rollback_release']) {
    assert.match(
      functionBlock(connect, name),
      /build_guarded_rollback_command[\s\\]+remote_command/u,
      name,
    );
  }
});

test('uses component manifests, immutable refs, conditional migrations, and strict smokes', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const compose = read('infra/docker-compose.yml');
  assert.match(deploy, /impact_plan_selects_component api-shared/u);
  assert.match(deploy, /change-impact-components\.generated\.sh/u);
  assert.match(deploy, /maxim_impact_classify_path "\$path"/u);
  assert.match(deploy, /component_manifest_matches_runtime/u);
  assert.match(deploy, /Component manifest\/runtime drift detected/u);
  assert.doesNotMatch(deploy, /node scripts\/agent\/plan\.mjs/u);
  assert.match(deploy, /maxim-api:\$\{TARGET_SHA\}/u);
  assert.match(deploy, /if \[\[ "\$BUILD_API_IMAGE" -eq 1 \]\]; then[\s\S]*run_migrations/u);
  assert.match(deploy, /require_stateful_services_ready/u);
  assert.doesNotMatch(deploy, /up -d postgres redis/u);
  assert.ok(
    callIndex(deploy, 'require_stateful_services_ready') <
      callIndex(deploy, 'maxim_topology_build_shared_api_image'),
  );
  assert.ok(
    callIndex(deploy, 'require_stateful_services_ready') < callIndex(deploy, 'run_migrations'),
  );
  assert.doesNotMatch(deploy, /curl -i/u);
  assert.ok(
    callIndex(deploy, 'record_successful_release') > deploy.lastIndexOf('scripts/smoke-http.mjs'),
  );
  assert.match(compose, /image: \$\{MAXIM_API_IMAGE:-maxim-api:local\}/u);
  assert.match(compose, /NODE_ENV: production/u);
  assert.match(compose, /com\.maxim\.release-protected: 'true'/u);
});

test('journals release inventory before mutation and fences inherited components', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const immutableRollback = read('infra/scripts/vps-release-rollback.sh');
  const runtimeRollback = read('infra/scripts/vps-runtime-rollback.sh');

  assert.ok(
    callIndexes(deploy, 'begin_release_runtime_transition')[0] <
      deploy.indexOf('if ! run_migrations'),
  );
  assert.match(deploy, /Interrupted release recovery selected every active component/u);
  assert.match(deploy, /verify_inherited_release_components/u);

  assert.ok(
    callIndex(immutableRollback, 'begin_release_runtime_transition') <
      callIndex(immutableRollback, 'maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES'),
  );
  assert.match(immutableRollback, /verify_inherited_release_components/u);
  assert.match(immutableRollback, /release-rollback-api/u);
  assert.match(immutableRollback, /release-rollback-static/u);
  assert.match(immutableRollback, /requires selecting api-shared for queue fencing/u);

  assert.ok(
    callIndex(runtimeRollback, 'begin_runtime_rollback_transition') <
      runtimeRollback.indexOf('./node_modules/.bin/prisma migrate deploy'),
  );
  assert.match(runtimeRollback, /verify_inherited_static_components/u);
});

test('keeps backup preflight read-only and reclaims only manifest-aware release images', () => {
  const backup = read('infra/scripts/backup-postgres.sh');
  const reclaim = read('infra/scripts/vps-docker-space-reclaim.sh');
  assert.match(
    backup,
    /if \[\[ "\$MODE" != "--preflight-only" \]\]; then[\s\S]*rm -f -- "\$expired_dump"/u,
  );
  assert.match(reclaim, /release-image-reclaim\.mjs reclaim/u);
  assert.match(reclaim, /Node 24 is required for release image reclaim/u);
  assert.ok(reclaim.indexOf('Node 24 is required') < callIndex(reclaim, 'acquire_deploy_lock'));
  assert.match(reclaim, /acquire_deploy_lock/u);
  assert.doesNotMatch(reclaim, /docker image prune/u);
  assert.doesNotMatch(reclaim, /docker (?:builder|buildx|system) prune/u);
  assert.doesNotMatch(reclaim, /docker volume prune/u);
  assert.doesNotMatch(reclaim, /docker container (?:prune|rm)/u);
});

test('submit helper is staged-only by default and pushes the exact HEAD', () => {
  const submit = read('infra/scripts/local-commit-push.sh');
  assert.match(submit, /STAGE_ALL=0/u);
  assert.match(submit, /git diff --cached --name-only/u);
  assert.match(submit, /npm run agent:verify -- --staged/u);
  assert.match(submit, /git push origin "HEAD:refs\/heads\/\$BRANCH"/u);
});

test('keeps legacy and scale entrypoints fail-closed before destructive work', () => {
  const legacy = read('infra/scripts/deploy.sh');
  const scale = read('infra/scripts/vps-pull-build-up-scale.sh');
  assert.ok(callIndex(legacy, 'require_legacy_deploy_confirmation') < legacy.indexOf('npm ci'));
  assert.match(scale, /MAXIM_ALLOW_SCALE_DEPLOY/u);
  assert.match(scale, /prepare_scale_redis_named_volume/u);
  assert.ok(
    callIndex(scale, 'prepare_scale_redis_named_volume') <
      callIndex(scale, 'stop_conflicting_stacks'),
  );
});
