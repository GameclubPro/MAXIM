import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { patchPublisherDispatchEnv } from './publisher-dispatch-rollout-state.mjs';

const root = resolve(import.meta.dirname, '../..');
const rollout = readFileSync(
  resolve(root, 'infra/scripts/vps-publisher-dispatch-rollout.sh'),
  'utf8',
);
const connect = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
const compose = readFileSync(resolve(root, 'infra/docker-compose.yml'), 'utf8');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');

const productionServices = [
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

function functionBlock(script, name) {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `Missing shell function: ${name}`);
  const end = script.indexOf('\n}', start);
  assert.notEqual(end, -1, `Unterminated shell function: ${name}`);
  return script.slice(start, end + 2);
}

test('keeps publisher dispatch false by default and previews mutations unless apply is explicit', () => {
  assert.match(envExample, /^MAX_PUBLISHER_DISPATCH_ENABLED=false$/mu);
  assert.match(
    compose,
    /MAX_PUBLISHER_DISPATCH_ENABLED: \$\{MAX_PUBLISHER_DISPATCH_ENABLED:-false\}/u,
  );
  assert.match(rollout, /APPLY=0/u);
  assert.match(rollout, /if \[\[ "\$APPLY" -ne 1 \]\]; then[\s\S]*no state changed/u);
  assert.match(rollout, /Status does not accept --apply/u);
});

test('renders a private false-to-true preview across all 13 env_file consumers', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'publisher-compose-preview-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const envPath = resolve(directory, '.env');
  const image = `maxim-api:${'a'.repeat(40)}`;
  const render = (contents) => {
    writeFileSync(envPath, contents, { mode: 0o600 });
    const environment = { ...process.env };
    delete environment.MAX_PUBLISHER_DISPATCH_ENABLED;
    environment.MAXIM_COMPOSE_SERVICE_ENV_FILE = envPath;
    environment.MAXIM_API_IMAGE = image;
    const result = spawnSync(
      'docker',
      [
        'compose',
        '--env-file',
        envPath,
        '-p',
        'infra-publisher-preview-test',
        '-f',
        'infra/docker-compose.yml',
        'config',
        '--format',
        'json',
      ],
      { cwd: root, encoding: 'utf8', env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const current = render(envExample);
  const preview = render(patchPublisherDispatchEnv(envExample, true));
  for (const service of productionServices) {
    assert.equal(current.services[service].environment.MAX_PUBLISHER_DISPATCH_ENABLED, 'false');
    assert.equal(preview.services[service].environment.MAX_PUBLISHER_DISPATCH_ENABLED, 'true');
  }
});

test('serializes through the shared deploy lock and fences the exact active 13-role image', () => {
  const entrypoint = rollout.lastIndexOf('parse_args "$@"');
  assert.ok(rollout.indexOf('source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"') >= 0);
  assert.ok(rollout.indexOf('source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"') >= 0);
  assert.ok(rollout.indexOf('acquire_deploy_lock', entrypoint) > entrypoint);
  assert.match(rollout, /MAXIM_PRODUCTION_API_SERVICES\[@\][\s\S]*-eq 13/u);
  assert.match(rollout, /MANIFEST_IMAGE_ID/u);
  assert.match(rollout, /org\.opencontainers\.image\.revision/u);
  assert.match(rollout, /com\.maxim\.release-protected/u);
  assert.match(rollout, /commercial-ocr-runtime-inventory\.mjs/u);
  for (const service of productionServices) {
    assert.match(rollout, new RegExp(`"${service}"`, 'u'));
  }
});

test('arms the operator pause before dotenv or runtime mutation and leaves it on failure', () => {
  const apply = functionBlock(rollout, 'apply_rollout');
  assert.ok(apply.indexOf('arm_operator_pause') < apply.indexOf('patch_dispatch_env'));
  assert.ok(apply.indexOf('patch_dispatch_env') < apply.indexOf('recreate_all_api_roles'));
  const cleanup = functionBlock(rollout, 'cleanup');
  assert.match(cleanup, /OPERATOR_PAUSE_ARMED/u);
  assert.match(cleanup, /publisher-dispatch-disable --apply/u);
  assert.doesNotMatch(cleanup, /clear_operator_pause|publisher_control clear/u);

  const execution = spawnSync(
    'bash',
    [
      '-c',
      `set +e
${cleanup}
maxim_webhook_rollout_warn_if_paused() { :; }
release_deploy_lock() { :; }
APPLY=1
OPERATOR_PAUSE_ARMED=1
ROLLOUT_COMPLETE=0
false
cleanup`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /operator pause remains armed/u);
  assert.match(execution.stderr, /publisher-dispatch-disable --apply/u);
});

test('reuses webhook quiescence and the reviewed wave order without builds or migrations', () => {
  const recreate = functionBlock(rollout, 'recreate_all_api_roles');
  const calls = [
    'maxim_webhook_quiesce_for_api_rollout',
    '"action and publisher"',
    '"admin"',
    '"ingress"',
    '"media analysis"',
    '"moderation"',
    '"enqueue"',
    'maxim_webhook_assert_api_rollout_quiescence',
  ].map((needle) => recreate.indexOf(needle));
  assert.ok(calls.every((index) => index >= 0));
  assert.deepEqual(
    calls,
    [...calls].sort((left, right) => left - right),
  );
  assert.match(rollout, /up -d --no-deps --no-build --pull never[\s\\]+--force-recreate/u);
  assert.doesNotMatch(rollout, /docker (?:build|buildx)|prisma migrate|migrate deploy/u);
  assert.doesNotMatch(
    rollout,
    /up[^\n]*(?:postgres|redis)|force-recreate[^\n]*(?:postgres|redis)/u,
  );
  assert.doesNotMatch(rollout, /MAX_API_GLOBAL_RPS|30 rps|30 RPS/iu);
  assert.match(rollout, /maxim_topology_verify_api_commercial_ocr_version/u);
  assert.match(rollout, /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u);
});

test('attests fixed-output identity before enabling heartbeat and clears only owned pause', () => {
  const apply = functionBlock(rollout, 'apply_rollout');
  const probe = apply.indexOf('run_publisher_identity_probe');
  const clear = apply.indexOf('clear_operator_pause', probe);
  const enabledHeartbeat = apply.indexOf('wait_for_heartbeat true', clear);
  assert.ok(probe >= 0 && probe < clear && clear < enabledHeartbeat);
  assert.match(rollout, /apps\/api\/dist\/apps\/api\/src\/scripts\/attest-publisher-identity\.js/u);
  assert.match(rollout, /PUBLISHER_IDENTITY_ATTESTED/u);
  assert.match(rollout, /\[\[ "\$output" == "\$PUBLISHER_IDENTITY_PROBE_SUCCESS" \]\]/u);
  assert.match(
    rollout,
    /IDENTITY_PROBE_TIMEOUT_SEC="\$\{MAXIM_PUBLISHER_IDENTITY_PROBE_TIMEOUT_SEC:-20\}"/u,
  );
  const probeBlock = functionBlock(rollout, 'run_publisher_identity_probe');
  assert.match(probeBlock, /"\$\{IDENTITY_PROBE_TIMEOUT_SEC\}s"/u);
  assert.doesNotMatch(probeBlock, /"\$\{COMMAND_TIMEOUT_SEC\}s"/u);
  assert.match(rollout, /wait_for_heartbeat false[\s\S]*maxim_webhook_resume_after_api_fence/u);
});

test('rejects identity probe budgets below both sequential MAX request deadlines', () => {
  const limits = functionBlock(rollout, 'require_operational_limits');
  assert.match(limits, /IDENTITY_PROBE_TIMEOUT_SEC < 20/u);
  assert.match(limits, /IDENTITY_PROBE_TIMEOUT_SEC > 120/u);
  assert.match(limits, /between 20 and 120 seconds/u);
});

test('requires publisher secrets only for enable and exposes guarded wrapper commands', () => {
  const preflight = functionBlock(rollout, 'rollout_preflight');
  assert.match(
    preflight,
    /if \[\[ "\$COMMAND" == "enable" \]\]; then[\s\S]*maxim_topology_require_publisher_secret_files/u,
  );
  assert.match(connect, /publisher-dispatch-enable \[--apply\]/u);
  assert.match(connect, /publisher-dispatch-disable \[--apply\]/u);
  assert.match(connect, /publisher-dispatch-status/u);
  const wrapper = functionBlock(connect, 'publisher_dispatch_command');
  assert.match(wrapper, /vps-publisher-dispatch-rollout\.sh/u);
  assert.match(wrapper, /if \[\[ "\$apply" == "--apply" \]\]/u);
});

test('fixed disable recovery adopts both owned fences and tolerates stopped reviewed workers', () => {
  const wrapper = functionBlock(connect, 'publisher_dispatch_command');
  assert.match(
    wrapper,
    /action" == "disable" && "\$apply" == "--apply"[\s\S]*MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1/u,
  );
  const preflight = functionBlock(rollout, 'rollout_preflight');
  assert.match(
    preflight,
    /MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE[\s\S]*runtime_state_policy=allow-stopped/u,
  );
  const control = functionBlock(rollout, 'publisher_control');
  assert.match(control, /run --rm --no-deps --pull never -T/u);
  assert.match(control, /api-action node - "\$action"/u);
  assert.match(control, /exec -T[\s\S]*api-admin node - "\$action"/u);
});

test('does not claim stale operator ownership after clear restores an authorization pause', () => {
  const clear = functionBlock(rollout, 'clear_operator_pause');
  const ownershipDrop = clear.indexOf('OPERATOR_PAUSE_ARMED=0');
  const enableValidation = clear.indexOf('if [[ "$COMMAND" == "enable" ]]');
  assert.ok(ownershipDrop >= 0 && ownershipDrop < enableValidation);
});

test('never prints or passes publisher token material through the rollout CLI', () => {
  assert.doesNotMatch(rollout, /MAX_PUBLISHER_BOT_TOKEN(?:_FILE)?/u);
  assert.doesNotMatch(rollout, /(?:^|[/ ])token(?:$|[ ."'])/imu);
  assert.doesNotMatch(
    rollout,
    /publik-bot-token|publik-webhook\.json|publik-init-data-keys\.json/u,
  );
  assert.doesNotMatch(rollout, /docker inspect[^\n]*Config\.Env[^|\n]*$/mu);
  assert.match(rollout, /container_env_summary/u);
});
