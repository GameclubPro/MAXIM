import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assessMultibotPrepareCapacity,
  checkMultibotPrepareCapacity,
  parseCapacityFilesystem,
} from './multibot-prepare-capacity.mjs';

const root = resolve(import.meta.dirname, '../..');
const library = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
const GiB = 1024 ** 3;
const productionComposeArgs = [
  '--env-file',
  '.env',
  '-p',
  'infra',
  '-f',
  'infra/docker-compose.yml',
];
const productionComposeInitializer = readFileSync(
  resolve(root, 'infra/scripts/vps-pull-build-up.sh'),
  'utf8',
).match(/^COMPOSE_FILES=\(.+\)$/mu)?.[0];
assert.ok(productionComposeInitializer, 'The production Compose caller must be covered');
const metadata = {
  tableBytes: 70 * GiB,
  approxRows: 47_000_000,
  orderedIndexBytes: 2.5 * GiB,
  maxWalBytes: GiB,
  dataDirectory: '/var/lib/postgresql/data',
  tempTablespaces: '',
  defaultLayout: true,
};
const filesystem = (device, availableBytes) => ({ device, availableBytes, mount: '/' });
const sharedFilesystems = (availableBytes) =>
  Object.fromEntries(
    ['data', 'temp', 'wal', 'docker'].map((role) => [
      role,
      filesystem('/dev/shared', availableBytes),
    ]),
  );

test('early capacity preflight reads the cutoff before any build or transition', () => {
  const result = probeEarlyPreflight();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready\ncapacity\nafter-preflight/u);
  assert.doesNotMatch(result.stdout, /Unexpected mutation/u);
});

test('early preflight preserves the production Compose context with a runtime overlay', () => {
  const result = probeEarlyPreflight('none', '0', '1', true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready\ncapacity\nafter-preflight/u);
});

for (const failure of ['capacity', 'receipt', 'malformed'])
  test(`early ${failure} failure preserves the current inventory and live runtime`, () => {
    const result = probeEarlyPreflight(failure, failure === 'malformed' ? 'unknown' : '0');
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stdout,
      /images=unbuilt journal=current ingress=live workers=live paused=0 cutoff=0/u,
    );
    assert.doesNotMatch(result.stdout, /after-preflight|Unexpected mutation/u);
    if (failure !== 'capacity') assert.doesNotMatch(result.stdout, /^capacity$/mu);
  });

test('early preflight skips capacity when the exact effects cutoff is already applied', () => {
  const result = probeEarlyPreflight('none', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /after-preflight/u);
  assert.doesNotMatch(result.stdout, /^capacity$/mu);
});

test('static-only deploy does not require an early multibot capacity or receipt probe', () => {
  const result = probeEarlyPreflight('receipt', '0', '0');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /after-preflight/u);
  assert.doesNotMatch(result.stdout, /^(?:ready|capacity)$/mu);
});

function probeEarlyPreflight(
  failure = 'none',
  receipt = '0',
  buildApiImage = '1',
  overlay = false,
) {
  const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
  const block = deploy.match(
    /\nif \[\[ "\$BUILD_API_IMAGE" -eq 1 \]\]; then\n {2}require_stateful_services_ready\n {2}maxim_webhook_preflight_multibot_prepare_capacity COMPOSE_FILES\nfi\n/u,
  )?.[0];
  assert.ok(block, 'An early API-only preflight block is required');
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
ROOT_DIR="$1"
source "$2"
failure="$3"
receipt="$4"
BUILD_API_IMAGE="$5"
MAIN_PROJECT_NAME=infra
${productionComposeInitializer}
${overlay ? 'COMPOSE_FILES+=(-f "infra/runtime overlay.yml")' : ''}
images=unbuilt journal=current ingress=live workers=live paused=0 cutoff=0
trap 'printf "images=%s journal=%s ingress=%s workers=%s paused=%s cutoff=%s\\n" "$images" "$journal" "$ingress" "$workers" "$paused" "$cutoff"' EXIT
require_stateful_services_ready() { echo ready; }
timeout() { [[ "$failure" != receipt ]] || return 1; printf '%s\\n' "$receipt"; }
node() {
  [[ "$1" == "$ROOT_DIR/infra/scripts/multibot-prepare-capacity.mjs" ]]
  shift
  expected=(--env-file .env -p infra -f infra/docker-compose.yml ${overlay ? '-f "infra/runtime overlay.yml"' : ''})
  [[ "$#" -eq "\${#expected[@]}" ]]
  for value in "\${expected[@]}"; do [[ "$1" == "$value" ]]; shift; done
  echo capacity
  [[ "$failure" != capacity ]]
}
docker() { echo 'Unexpected mutation' >&2; return 99; }
run_online_multibot_migrations() { echo 'Unexpected mutation' >&2; return 99; }
${block}
echo after-preflight
images=built journal=transitioned
`,
      'multibot-early-capacity',
      root,
      library,
      failure,
      receipt,
      buildApiImage,
    ],
    { encoding: 'utf8' },
  );
}

test('online preparation succeeds before quiescence without applying the effects cutoff', () => {
  const result = probeHook();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /capacity\nprepare\nexact-indexes/u);
  assert.match(result.stdout, /status=0 ingress=live workers=live paused=0 cutoff=0/u);
});

for (const failure of ['capacity', 'prepare', 'indexes'])
  test(`${failure} failure leaves old ingress, workers, queues and cutoff unchanged`, () => {
    const result = probeHook(failure);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /status=1 ingress=live workers=live paused=0 cutoff=0/u);
    if (failure === 'capacity') assert.doesNotMatch(result.stdout, /^prepare$/mu);
    if (failure === 'prepare') assert.doesNotMatch(result.stdout, /^exact-indexes$/mu);
  });

test('a successful existing cutoff skips all online preparation work', () => {
  const result = probeHook('none', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^(?:capacity|prepare|exact-indexes)$/mu);
  assert.match(result.stdout, /status=0 ingress=live workers=live paused=0 cutoff=0/u);
});

function probeHook(failure = 'none', receipt = '0') {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
ROOT_DIR="$1"
source "$2"
failure="$3"
receipt="$4"
MAIN_PROJECT_NAME=infra
${productionComposeInitializer}
ingress=live workers=live paused=0 cutoff=0
maxim_webhook_read_multibot_cutover_receipt() { printf '%s\\n' "$receipt"; }
node() {
  [[ "$1" == "$ROOT_DIR/infra/scripts/multibot-prepare-capacity.mjs" ]]
  shift
  expected=(--env-file .env -p infra -f infra/docker-compose.yml)
  [[ "$#" -eq "\${#expected[@]}" ]]
  for value in "\${expected[@]}"; do [[ "$1" == "$value" ]]; shift; done
  echo capacity
  [[ "$failure" != capacity ]]
}
run_online_multibot_migrations() { echo prepare; [[ "$failure" != prepare ]]; }
maxim_webhook_assert_multibot_migration_indexes() { echo exact-indexes; [[ "$failure" != indexes ]]; }
docker() { echo 'Unexpected container mutation' >&2; return 99; }
if maxim_webhook_prepare_multibot_before_quiescence COMPOSE_FILES; then status=0; else status=$?; fi
printf 'status=%s ingress=%s workers=%s paused=%s cutoff=%s\\n' "$status" "$ingress" "$workers" "$paused" "$cutoff"
`,
      'multibot-online-hook',
      root,
      library,
      failure,
      receipt,
    ],
    { encoding: 'utf8' },
  );
}

test('online prep follows all image builds and precedes queue fence, ingress stop and full migrations', () => {
  const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
  const earlyPreflight = deploy.indexOf(
    '\n  maxim_webhook_preflight_multibot_prepare_capacity COMPOSE_FILES',
  );
  const buildCapacity = deploy.indexOf('\nprepare_deploy_disk_capacity\n');
  const alternateShutdown = deploy.indexOf('\nstop_conflicting_stacks\n');
  const apiBuild = deploy.indexOf('\n    maxim_topology_build_shared_api_image ');
  const staticBuild = deploy.indexOf('\n    docker compose "${COMPOSE_FILES[@]}" build');
  const transition = deploy.indexOf('\n  begin_release_runtime_transition', earlyPreflight);
  const prepare = deploy.indexOf(
    '\n  maxim_webhook_prepare_multibot_before_quiescence COMPOSE_FILES',
  );
  const quiesce = deploy.indexOf('\n  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES');
  const ingress = deploy.indexOf(
    '\n  maxim_webhook_quiesce_legacy_ingress_for_multibot_cutover COMPOSE_FILES',
  );
  const migrations = deploy.indexOf('\n  if ! run_migrations');
  assert.ok(earlyPreflight >= 0 && buildCapacity > earlyPreflight);
  assert.ok(alternateShutdown > buildCapacity && apiBuild > alternateShutdown);
  assert.ok(transition > apiBuild && staticBuild > transition && prepare > staticBuild);
  assert.ok(quiesce > prepare && ingress > quiesce && migrations > ingress);
  const beforePrepare = deploy.slice(apiBuild, prepare);
  assert.doesNotMatch(beforePrepare, /recreate_service_wave|up -d.*--force-recreate/u);
  const runner = deploy.slice(
    deploy.indexOf('run_online_multibot_migrations()'),
    deploy.indexOf('\nif ! command -v docker'),
  );
  assert.match(runner, /run --rm --no-deps --pull never api-ingress/u);
  assert.match(runner, /node scripts\/agent\/multibot-online-prepare\.mjs/u);
});

test('capacity sums simultaneous data, sort and WAL budgets on the shared Docker device', () => {
  const report = assessMultibotPrepareCapacity(metadata, sharedFilesystems(40 * GiB));
  assert.equal(report.devices.length, 1);
  assert.deepEqual(report.devices[0].roles, ['data', 'temp', 'wal', 'docker']);
  assert.equal(report.fullIndexes, 1);
  assert.equal(report.partialIndexes, 2);
  assert.equal(report.partialIndexAllowanceBytes, GiB);
  assert.equal(report.serializedIndexBuilds, true);
  assert.equal(report.devices[0].sufficient, true);
  const insufficient = assessMultibotPrepareCapacity(metadata, sharedFilesystems(25 * GiB));
  assert.equal(insufficient.devices[0].sufficient, false);
});

test('capacity verifies each distinct data, WAL and Docker filesystem and uses minimum observed free bytes', () => {
  const report = assessMultibotPrepareCapacity(metadata, {
    data: filesystem('/dev/data', 30 * GiB),
    temp: filesystem('/dev/data', 20 * GiB),
    wal: filesystem('/dev/wal', 15 * GiB),
    docker: filesystem('/dev/docker', 25 * GiB),
  });
  assert.equal(report.devices.length, 3);
  assert.equal(report.devices[0].availableBytes, 20 * GiB);
  assert.equal(report.devices[0].sufficient, false);
  assert.equal(report.devices[1].sufficient, false);
  assert.equal(report.devices[2].sufficient, true);
});

test('unknown or external storage layouts fail before any migration is started', () => {
  for (const change of [
    { defaultLayout: false },
    { tempTablespaces: 'external_temp' },
    { approxRows: -1 },
  ])
    assert.throws(() =>
      assessMultibotPrepareCapacity({ ...metadata, ...change }, sharedFilesystems(100 * GiB)),
    );
  assert.throws(() => assessMultibotPrepareCapacity(metadata, {}));
  assert.throws(() => parseCapacityFilesystem('unknown'));
});

for (const composeArgs of [
  ['-f', 'fixture.yml'],
  productionComposeArgs,
  [...productionComposeArgs, '-f', 'infra/docker-compose.runtime-no-build.yml'],
  [
    '--env-file',
    'env files/runtime.env',
    '-p',
    'infra_test-1',
    '-f',
    'compose files/base.yml',
    '-f',
    'compose files/overlay.yml',
  ],
])
  test(`typed capacity probe preserves context ${JSON.stringify(composeArgs)}`, () => {
    const frozenArgs = Object.freeze([...composeArgs]);
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('psql')) {
        assert.match(options.input, /BEGIN READ ONLY;/u);
        assert.match(options.input, /statement_timeout = '10s'/u);
        assert.doesNotMatch(options.input, /FROM\s+(?:"?public"?\.)?"?webhook_events"?\b/iu);
        return JSON.stringify(metadata);
      }
      if (args.includes('sh')) return '/var/lib/postgresql/data/pg_wal\n';
      return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/shared 100000000 1000 50000000 1% /\n';
    };
    const report = checkMultibotPrepareCapacity(frozenArgs, run);
    assert.equal(report.devices.length, 1);
    assert.ok(calls.every((call) => call.options.timeout === 30_000));
    assert.ok(calls.some((call) => call.args.at(-1) === metadata.dataDirectory));
    assert.ok(calls.some((call) => call.args.at(-1) === '/var/lib/postgresql/data/pg_wal'));
    assert.ok(
      calls.some((call) => call.command === 'df' && call.args.at(-1) === '/var/lib/docker'),
    );
    const dockerCalls = calls.filter((call) => call.command === 'docker');
    assert.equal(dockerCalls.length, 4);
    for (const call of dockerCalls) {
      assert.deepEqual(call.args.slice(0, 1 + frozenArgs.length), ['compose', ...frozenArgs]);
      assert.deepEqual(call.args.slice(1 + frozenArgs.length, 4 + frozenArgs.length), [
        'exec',
        '-T',
        'postgres',
      ]);
    }
    assert.deepEqual(frozenArgs, composeArgs);
  });

test('invalid Compose arguments fail before any catalog or filesystem command', () => {
  for (const args of [
    undefined,
    null,
    '-f fixture.yml',
    [],
    ['--unsafe'],
    ['--unsafe', 'value', '-f', 'fixture.yml'],
    ['-f'],
    ['-f', 'fixture.yml', '-p'],
    ['--env-file', '.env'],
    ['-p', 'infra'],
    ['-f', ''],
    ['-f', '  '],
    ['-f', '--env-file'],
    ['-f', 'bad\0path'],
    ['-f', 'bad\npath'],
    ['-f', 'bad\rpath'],
    ['-f', 1],
    [1, 'fixture.yml'],
    ['-f', 'fixture.yml', '-p', 'Infra'],
    ['-f', 'fixture.yml', '-p', 'bad project'],
    ['-f', 'fixture.yml', '-p', 'infra', '-p', 'other'],
    ['-f', 'fixture.yml', '--env-file', '.env', '--env-file', 'other.env'],
    Object.assign(new Array(2), { 0: '-f' }),
    Object.assign(new Array(4), { 0: '-f', 1: 'fixture.yml' }),
  ]) {
    let runnerCalls = 0;
    assert.throws(
      () =>
        checkMultibotPrepareCapacity(args, () => {
          runnerCalls++;
        }),
      /MULTIBOT_PREPARE_COMPOSE_ARGUMENTS_INVALID/u,
      JSON.stringify(args),
    );
    assert.equal(runnerCalls, 0);
  }
});
