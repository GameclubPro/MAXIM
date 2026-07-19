import assert from 'node:assert/strict';
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
  'api-action',
];

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
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

test('validates deploy targets before synchronization or runtime side effects', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const validation = callIndexes(deploy, 'validate_requested_services')[0];
  const nodePreflight = callIndex(deploy, 'require_node_24');
  assert.ok(nodePreflight < callIndex(deploy, 'acquire_deploy_lock'));
  assert.ok(nodePreflight < callIndex(deploy, 'sync_branch'));
  assert.ok(validation < callIndex(deploy, 'acquire_deploy_lock'));
  assert.ok(validation < callIndex(deploy, 'sync_branch'));
  assert.ok(validation < callIndex(deploy, 'stop_conflicting_stacks'));
  assert.match(deploy, /Node 24 is required for production deploy/u);
  assert.match(deploy, /Unknown or unsafe deploy service/u);
  assert.match(
    deploy,
    /MAXIM_EXPECTED_DEPLOY_SHA is required for every mutating production deploy/u,
  );
  assert.match(deploy, /if \[\[ "\$DEPLOY_MODE" == "plan" \]\]/u);
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
