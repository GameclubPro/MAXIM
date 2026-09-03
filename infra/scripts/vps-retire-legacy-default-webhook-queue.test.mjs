import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const wrapper = resolve(root, 'infra/scripts/vps-retire-legacy-default-webhook-queue.sh');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-default-retirement-wrapper-'));
  const bin = join(directory, 'bin');
  const dockerLog = join(directory, 'docker.log');
  const lifecycleLog = join(directory, 'lifecycle.log');
  const runtimeState = join(directory, 'runtime.state');
  const restartCount = join(directory, 'restart-count');
  const startAttempts = join(directory, 'start-attempts');
  const snapshot = join(directory, 'private-snapshot.json');
  const lock = join(directory, 'deploy.lock');
  mkdirSync(bin);
  writeFileSync(runtimeState, 'running\n');
  writeFileSync(restartCount, '7\n');
  writeFileSync(startAttempts, '0\n');
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
case "$*" in
  *" settlement")
    printf '%s\n' barrier >>"$MOCK_LIFECYCLE_LOG"
    printf '%s\n' '{"version":1,"mode":"settlement","settled":true,"queue":{"version":1,"queue":"moderation-default","present":false,"paused":false,"workerCount":0,"jobSchedulerCount":0,"totalJobs":0}}'
    ;;
  *" apply")
    printf '%s\n' remote-apply >>"$MOCK_LIFECYCLE_LOG"
    sleep "\${MOCK_APPLY_SLEEP_SEC:-0}"
    ;;
  *" stop api-enqueue")
    printf '%s\n' stopped >"$MOCK_RUNTIME_STATE"
    printf '%s\n' docker-stop >>"$MOCK_LIFECYCLE_LOG"
    ;;
  *" start api-enqueue")
    start_attempt=$(( $(cat "$MOCK_START_ATTEMPTS") + 1 ))
    printf '%s\n' "$start_attempt" >"$MOCK_START_ATTEMPTS"
    printf '%s\n' docker-start-attempt >>"$MOCK_LIFECYCLE_LOG"
    if ((start_attempt <= \${MOCK_START_FAILURES:-0})); then
      exit 19
    fi
    printf '%s\n' running >"$MOCK_RUNTIME_STATE"
    printf '%s\n' docker-start >>"$MOCK_LIFECYCLE_LOG"
    ;;
  *" ps --status running -q api-enqueue")
    if [[ "$(cat "$MOCK_RUNTIME_STATE")" == "running" ]]; then
      printf '%064d\n' 1
    fi
    ;;
esac
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  return {
    directory,
    bin,
    dockerLog,
    lifecycleLog,
    runtimeState,
    restartCount,
    startAttempts,
    snapshot,
    lock,
  };
}

function baseEnv(data) {
  return {
    ...process.env,
    PATH: `${data.bin}:${process.env.PATH}`,
    MAXIM_DEPLOY_LOCK_DIR: data.lock,
    MOCK_DOCKER_LOG: data.dockerLog,
    MOCK_LIFECYCLE_LOG: data.lifecycleLog,
    MOCK_RUNTIME_STATE: data.runtimeState,
    MOCK_RESTART_COUNT: data.restartCount,
    MOCK_START_ATTEMPTS: data.startAttempts,
    MOCK_PRIVATE_SNAPSHOT: data.snapshot,
  };
}

const sourceAndMocks = `
source ${JSON.stringify(wrapper)}
require_preconditions() { :; }
resolve_release_fence() { :; }
require_stateful_services_ready() { :; }
verify_webhook_producer_topology() { :; }
verify_queue_fence_released() { :; }
print_queue_summary() { :; }
inspect_active_shards() { printf '%s\n' shards >>"$MOCK_LIFECYCLE_LOG"; }
sleep() { :; }
run_readiness_smokes() {
  printf '%s\n' health >>"$MOCK_LIFECYCLE_LOG"
}
read_api_fleet() {
  local running_count=13
  if [[ "$(cat "$MOCK_RUNTIME_STATE")" == "stopped" ]]; then
    running_count=12
  fi
  printf '{"available":true,"expectedRoleCount":13,"observedRoleCount":13,"singletonRoleCount":13,"runningRoleCount":%s,"identityRoleCount":13,"exactImageRoleCount":13,"duplicateContainerCount":0,"unexpectedApiContainerCount":0,"unexpectedMainContainerCount":0,"unexpectedScaleContainerCount":0,"unexpectedManualContainerCount":0,"totalRestartCount":%s}\n' \
    "$running_count" "$(cat "$MOCK_RESTART_COUNT")"
}
create_private_snapshot() {
  printf '%s\n' '{"fixture":true}' >"$MOCK_PRIVATE_SNAPSHOT"
  chmod 0600 "$MOCK_PRIVATE_SNAPSHOT"
  PRIVATE_SNAPSHOT="$MOCK_PRIVATE_SNAPSHOT"
  QUEUE_SUMMARY='{"paused":false}'
  LEGACY_QUEUE_PAUSED_COUNT=0
  printf '%s\n' snapshot >>"$MOCK_LIFECYCLE_LOG"
}
`;

const failureAfterStop = `${sourceAndMocks}
database_audit_calls=0
run_database_crosscheck() {
  database_audit_calls=$((database_audit_calls + 1))
  printf 'db-%s\n' "$database_audit_calls" >>"$MOCK_LIFECYCLE_LOG"
  if ((database_audit_calls == 2)); then
    return 42
  fi
}
apply_retirement() { printf '%s\n' apply >>"$MOCK_LIFECYCLE_LOG"; }
main --apply
`;

test('failure after enqueue stop restores a stable fleet and cleans snapshot and deploy lock', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = spawnSync('bash', ['-c', failureAfterStop], {
    cwd: root,
    encoding: 'utf8',
    env: { ...baseEnv(data), MOCK_START_FAILURES: '1' },
  });

  assert.equal(result.status, 42, result.stderr);
  assert.equal(existsSync(data.snapshot), false);
  assert.equal(existsSync(data.lock), false);
  assert.equal(readFileSync(data.runtimeState, 'utf8').trim(), 'running');
  assert.equal(readFileSync(data.startAttempts, 'utf8').trim(), '2');
  const dockerCalls = readFileSync(data.dockerLog, 'utf8').trim().split('\n');
  const stopIndex = dockerCalls.findIndex((line) => line.endsWith('stop api-enqueue'));
  const startIndex = dockerCalls.findIndex((line) => line.endsWith('start api-enqueue'));
  assert.ok(stopIndex >= 0 && startIndex > stopIndex, dockerCalls.join('\n'));
  const lifecycle = readFileSync(data.lifecycleLog, 'utf8').trim().split('\n');
  assert.equal(lifecycle.filter((entry) => entry === 'snapshot').length, 2);
  assert.equal(lifecycle.filter((entry) => entry === 'health').length, 3);
  assert.ok(lifecycle.indexOf('db-2') > lifecycle.indexOf('db-1'));
  const lifecycleStartIndex = lifecycle.indexOf('docker-start');
  assert.ok(lifecycleStartIndex > lifecycle.indexOf('db-2'));
  assert.equal(
    lifecycle.slice(lifecycleStartIndex + 1).filter((entry) => entry === 'health').length,
    2,
  );
  assert.equal(lifecycle.includes('apply'), false);
});

test('restored fleet validation rejects a restart-count increase', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = spawnSync(
    'bash',
    [
      '-c',
      `${sourceAndMocks}
verify_exact_api_fleet
printf '%s\n' 8 >"$MOCK_RESTART_COUNT"
verify_exact_api_fleet
printf '%s\n' UNREACHABLE
`,
    ],
    { cwd: root, encoding: 'utf8', env: baseEnv(data) },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restart count changed/u);
  assert.doesNotMatch(result.stdout, /UNREACHABLE/u);
});

test('release fence allows only the reviewed operator patch above the active API source', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const repository = join(data.directory, 'repo');
  const scripts = join(repository, 'infra', 'scripts');
  const runtime = join(repository, 'apps', 'api', 'src');
  const webhook = join(runtime, 'webhook');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(webhook, { recursive: true });
  writeFileSync(join(scripts, 'vps-retire-legacy-default-webhook-queue.sh'), 'base\n');
  writeFileSync(join(scripts, 'legacy-default-webhook-queue-retirement.test.mjs'), 'base\n');
  writeFileSync(join(scripts, 'vps-retire-legacy-default-webhook-queue.test.mjs'), 'base\n');
  writeFileSync(join(runtime, 'runtime.ts'), 'base\n');
  writeFileSync(
    join(webhook, 'webhook-outbox.service.ts'),
    "this.enabled = roleRunsEnqueue(getAppRole());\nconst jobName = 'process-webhook-event';\n",
  );
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  const activeSource = git('rev-parse', 'HEAD');
  writeFileSync(join(scripts, 'vps-retire-legacy-default-webhook-queue.sh'), 'operator fix\n');
  writeFileSync(join(scripts, 'legacy-default-webhook-queue-retirement.test.mjs'), 'test fix\n');
  writeFileSync(
    join(scripts, 'vps-retire-legacy-default-webhook-queue.test.mjs'),
    'process test fix\n',
  );
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'operator');
  const operatorHead = git('rev-parse', 'HEAD');
  const invoke = (sourceSha, checkoutSha) =>
    spawnSync(
      'bash',
      [
        '-c',
        `source ${JSON.stringify(wrapper)}; cd ${JSON.stringify(repository)}; ` +
          `verify_checkout_compatible_with_active_api_source ${sourceSha} ${checkoutSha}`,
      ],
      { cwd: root, encoding: 'utf8', env: baseEnv(data) },
    );
  const releaseHelper = join(data.directory, 'release-helper.mjs');
  writeFileSync(
    releaseHelper,
    `process.stdout.write(${JSON.stringify(
      JSON.stringify({
        targetSha: activeSource,
        components: {
          'api-shared': {
            sourceSha: activeSource,
            imageRef: `maxim-api:${activeSource}`,
            imageId: `sha256:${'a'.repeat(64)}`,
          },
        },
      }),
    )});\n`,
  );
  const invokeReleaseFence = () =>
    spawnSync(
      'bash',
      [
        '-c',
        `source ${JSON.stringify(wrapper)}; cd ${JSON.stringify(repository)}; ` +
          `RELEASE_HELPER=${JSON.stringify(releaseHelper)}; ` +
          `RELEASE_STATE_DIR=${JSON.stringify(data.directory)}; ` +
          `SHARDING_FLOOR_SHA=${activeSource}; resolve_release_fence`,
      ],
      { cwd: root, encoding: 'utf8', env: baseEnv(data) },
    );

  assert.equal(invoke(activeSource, operatorHead).status, 0);
  const allowedReleaseFence = invokeReleaseFence();
  assert.equal(allowedReleaseFence.status, 0, allowedReleaseFence.stderr);
  const reverseAncestry = invoke(operatorHead, activeSource);
  assert.notEqual(reverseAncestry.status, 0);
  assert.match(reverseAncestry.stderr, /does not descend/u);

  writeFileSync(join(runtime, 'runtime.ts'), 'unstaged runtime change\n');
  const unstaged = invokeReleaseFence();
  assert.notEqual(unstaged.status, 0);
  assert.match(unstaged.stderr, /Tracked VPS checkout changes/u);
  git('restore', join('apps', 'api', 'src', 'runtime.ts'));

  writeFileSync(join(runtime, 'runtime.ts'), 'staged runtime change\n');
  git('add', join('apps', 'api', 'src', 'runtime.ts'));
  const staged = invokeReleaseFence();
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /Staged VPS checkout changes/u);
  git('restore', '--staged', '--worktree', join('apps', 'api', 'src', 'runtime.ts'));

  const untrackedPath = join(repository, 'untracked.txt');
  writeFileSync(untrackedPath, 'untracked\n');
  const untracked = invokeReleaseFence();
  assert.notEqual(untracked.status, 0);
  assert.match(untracked.stderr, /unclean VPS checkout/u);
  rmSync(untrackedPath, { force: true });

  writeFileSync(join(runtime, 'runtime.ts'), 'runtime changed\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'runtime');
  const unsafeHead = git('rev-parse', 'HEAD');
  const unsafe = invoke(activeSource, unsafeHead);
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /outside the reviewed queue-retirement operator patch/u);
});

test('ambiguous local apply timeout waits for the barrier before restoring enqueue', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = spawnSync(
    'bash',
    [
      '-c',
      `${sourceAndMocks}
run_database_crosscheck() { :; }
COMMAND_TIMEOUT_SEC=2
REMOTE_APPLY_TIMEOUT_MARGIN_SEC=1
main --apply
`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...baseEnv(data), MOCK_APPLY_SLEEP_SEC: '3' },
      timeout: 10_000,
    },
  );

  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(existsSync(data.snapshot), false);
  assert.equal(existsSync(data.lock), false);
  assert.equal(readFileSync(data.runtimeState, 'utf8').trim(), 'running');
  const lifecycle = readFileSync(data.lifecycleLog, 'utf8').trim().split('\n');
  const applyIndex = lifecycle.indexOf('remote-apply');
  const barrierIndex = lifecycle.indexOf('barrier');
  const startIndex = lifecycle.indexOf('docker-start');
  assert.ok(
    applyIndex >= 0 && barrierIndex > applyIndex && startIndex > barrierIndex,
    lifecycle.join('\n'),
  );
  assert.equal(lifecycle.slice(startIndex + 1).filter((entry) => entry === 'health').length, 2);
  assert.match(
    readFileSync(data.dockerLog, 'utf8'),
    /MAXIM_LEGACY_DEFAULT_QUEUE_REMOTE_DEADLINE_MS/u,
  );
});
