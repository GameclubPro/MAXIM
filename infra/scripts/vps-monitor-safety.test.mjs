import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
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
const monitorPath = resolve(root, 'infra/scripts/vps-monitor-readonly.sh');
const holderPath = resolve(root, 'infra/scripts/vps-monitor-lock-holder.sh');
const guardianPath = resolve(root, 'infra/scripts/vps-monitor-process-guardian.sh');
const processTreePath = resolve(root, 'infra/scripts/lib/monitor-process-tree.sh');
const monitor = readFileSync(monitorPath, 'utf8');
const marker = 'MAXIM_REMOTE_MONITOR_LOCK_ACQUIRED\n';

function waitForHolderOutcome(child) {
  return new Promise((resolveOutcome, rejectOutcome) => {
    let stdout = '';
    let settled = false;
    const timeout = setTimeout(() => {
      rejectOutcome(new Error(`Timed out waiting for holder outcome; stdout=${stdout}`));
    }, 5_000);
    timeout.unref();

    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveOutcome(outcome);
    };
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(marker)) settle({ acquired: true, stdout });
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectOutcome(error);
    });
    child.once('close', (status) => settle({ acquired: false, status, stdout }));
  });
}

function isLivePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path, pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let content = '';
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      // The producer has not created the file yet.
    }
    if (pattern.test(content)) return content;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${path}`);
}

test('kernel flock admits exactly one of 40 holders over a stale lock file', async (t) => {
  const lockFile = `/tmp/maxim-vps-monitor-readonly.test-${process.pid}-${Date.now()}.lock`;
  writeFileSync(lockFile, 'stale-pid=999999\n', { mode: 0o600 });
  const env = {
    ...process.env,
    MAXIM_MONITOR_REMOTE_LOCK_FILE: lockFile,
  };
  const children = [];
  t.after(() => {
    for (const child of children) {
      child.stdin?.end();
      child.kill('SIGTERM');
    }
    rmSync(lockFile, { force: true });
  });

  for (let index = 0; index < 40; index += 1) {
    children.push(
      spawn(holderPath, [], {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  }
  const outcomes = await Promise.all(children.map(waitForHolderOutcome));
  const winners = outcomes
    .map((outcome, index) => ({ outcome, child: children[index] }))
    .filter(({ outcome }) => outcome.acquired);
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  for (const outcome of outcomes) {
    if (!outcome.acquired) assert.equal(outcome.status, 3);
  }

  winners[0].child.stdin.end();
  const [winnerStatus] = await once(winners[0].child, 'close');
  assert.equal(winnerStatus, 0);

  const reacquired = spawnSync(holderPath, [], {
    cwd: root,
    env,
    encoding: 'utf8',
    input: '',
  });
  assert.equal(reacquired.status, 0, reacquired.stderr);
  assert.equal(reacquired.stdout, marker);
});

test('process cleanup rejects a reused numeric PID with a different starttime', () => {
  const script = `
set -euo pipefail
source "$1"
setsid sleep 30 &
unrelated_pid=$!
actual_starttime="$(monitor_wait_for_session_leader "$unrelated_pid")"
stale_starttime="$((actual_starttime - 1))"
monitor_terminate_owned_tree \
  "$unrelated_pid" "$stale_starttime" \
  "$unrelated_pid" "$stale_starttime" || true
kill -0 "$unrelated_pid"
kill -TERM "$unrelated_pid"
wait "$unrelated_pid" 2>/dev/null || true
`;
  const result = spawnSync('bash', ['-c', script, 'pid-reuse-test', processTreePath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('process cleanup kills TERM-resistant descendants in the owned session', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'maxim-monitor-tree-'));
  const descendantFile = join(temp, 'descendant.pid');
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  const script = `
set -euo pipefail
source "$1"
descendant_file="$2"
setsid bash -c '''
  trap "" TERM
  (trap "" TERM; while true; do sleep 1; done) &
  printf "%s\\n" "$!" >"$1"
  wait
''' bash "$descendant_file" &
leader_pid=$!
leader_starttime="$(monitor_wait_for_session_leader "$leader_pid")"
monitor_terminate_owned_tree \
  "$leader_pid" "$leader_starttime" "$leader_pid" "$leader_starttime"
wait "$leader_pid" 2>/dev/null || true
descendant_pid="$(cat "$descendant_file")"
if kill -0 "$descendant_pid" 2>/dev/null; then exit 1; fi
`;
  const result = spawnSync(
    'bash',
    ['-c', script, 'descendant-cleanup-test', processTreePath, descendantFile],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('process cleanup catches a descendant created during TERM shutdown', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'maxim-monitor-late-tree-'));
  const workerPath = join(temp, 'late-worker.sh');
  const lateDescendantFile = join(temp, 'late-descendant.pid');
  const readyFile = join(temp, 'ready');
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  writeFileSync(
    workerPath,
    `#!/usr/bin/env bash
set -u
late_descendant_file="$1"
ready_file="$2"
trap '' TERM
(
  spawn_late_descendant() {
    (trap '' TERM; while true; do sleep 1; done) &
    printf '%s\\n' "$!" >"$late_descendant_file"
  }
  trap spawn_late_descendant TERM
  : >"$ready_file"
  while true; do sleep 1; done
) &
wait
`,
    { mode: 0o755 },
  );
  const script = `
set -euo pipefail
source "$1"
worker="$2"
late_descendant_file="$3"
ready_file="$4"
setsid "$worker" "$late_descendant_file" "$ready_file" &
leader_pid=$!
leader_starttime="$(monitor_wait_for_session_leader "$leader_pid")"
for ((attempt = 0; attempt < 100; attempt += 1)); do
  if [[ -e "$ready_file" ]]; then break; fi
  sleep 0.01
done
[[ -e "$ready_file" ]]
monitor_terminate_owned_tree \
  "$leader_pid" "$leader_starttime" "$leader_pid" "$leader_starttime"
wait "$leader_pid" 2>/dev/null || true
late_descendant_pid="$(cat "$late_descendant_file")"
if kill -0 "$late_descendant_pid" 2>/dev/null; then exit 1; fi
`;
  const result = spawnSync(
    'bash',
    [
      '-c',
      script,
      'late-descendant-cleanup-test',
      processTreePath,
      workerPath,
      lateDescendantFile,
      readyFile,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('process cleanup treats a killed but unreaped session leader as exited', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'maxim-monitor-zombie-tree-'));
  const workerPath = join(temp, 'zombie-worker.sh');
  const leaderFile = join(temp, 'leader.pid');
  t.after(() => rmSync(temp, { force: true, recursive: true }));
  writeFileSync(
    workerPath,
    `#!/usr/bin/env bash
set -u
leader_file="$1"
trap '' TERM
printf '%s\\n' "$$" >"$leader_file"
while true; do sleep 1; done
`,
    { mode: 0o755 },
  );
  const script = `
set -euo pipefail
source "$1"
worker="$2"
leader_file="$3"
bash -c 'setsid "$1" "$2" & exec sleep 30' zombie-keeper "$worker" "$leader_file" &
keeper_pid=$!
cleanup_keeper() {
  kill -TERM "$keeper_pid" 2>/dev/null || true
  wait "$keeper_pid" 2>/dev/null || true
}
trap cleanup_keeper EXIT
for ((attempt = 0; attempt < 100; attempt += 1)); do
  if [[ -s "$leader_file" ]]; then break; fi
  sleep 0.01
done
leader_pid="$(cat "$leader_file")"
leader_starttime="$(monitor_wait_for_session_leader "$leader_pid")"
monitor_terminate_owned_tree \
  "$leader_pid" "$leader_starttime" "$leader_pid" "$leader_starttime"
identity="$(monitor_read_process_identity "$leader_pid")"
IFS=$'\\t' read -r observed_pid state ppid pgrp session observed_starttime <<<"$identity"
[[ "$observed_pid" == "$leader_pid" && "$state" == 'Z' ]]
`;
  const result = spawnSync(
    'bash',
    ['-c', script, 'zombie-session-cleanup-test', processTreePath, workerPath, leaderFile],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test(
  'a marker-only hung transport cannot authorize the first sample',
  { timeout: 12_000 },
  async (t) => {
    const fixture = mkdtempSync(join(tmpdir(), 'maxim-monitor-stale-transport-'));
    const scriptsDir = join(fixture, 'infra/scripts');
    const libDir = join(scriptsDir, 'lib');
    const fixtureMonitor = join(scriptsDir, 'vps-monitor-readonly.sh');
    const fixtureConnect = join(scriptsDir, 'vps-connect.sh');
    const eventLog = join(fixture, 'events.log');
    const localLock = join(fixture, 'local.lock');
    const remoteLock = join(fixture, 'remote.lock');
    const monitorLog = join(fixture, 'monitor.log');
    let wrapper;
    let wrapperStderr = '';
    t.after(() => {
      wrapper?.kill('SIGKILL');
      rmSync(fixture, { force: true, recursive: true });
    });

    mkdirSync(libDir, { recursive: true });
    copyFileSync(monitorPath, fixtureMonitor);
    copyFileSync(guardianPath, join(scriptsDir, 'vps-monitor-process-guardian.sh'));
    copyFileSync(processTreePath, join(libDir, 'monitor-process-tree.sh'));
    writeFileSync(
      join(libDir, 'deploy-topology.sh'),
      'MAXIM_PRODUCTION_API_SERVICES=(api-ingress)\nMAXIM_MEDIA_ANALYSIS_SERVICE=api-media-analysis\n',
    );
    writeFileSync(
      join(libDir, 'deploy-disk-capacity.sh'),
      'MAXIM_API_BUILD_HARD_MIN_FREE_BYTES=21474836480\n',
    );
    writeFileSync(
      fixtureConnect,
      `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  exec)
    if [[ "$*" == *vps-monitor-lock-holder.sh* ]]; then
      exec {lock_fd}>>"$TEST_REMOTE_LOCK_FILE"
      flock -n "$lock_fd" || exit 3
      printf 'MAXIM_REMOTE_MONITOR_LOCK_ACQUIRED\\n'
      exec {lock_fd}>&-
      printf 'holder_lock_lost\\n' >>"$TEST_EVENT_LOG"
      cat >/dev/null
      exit 0
    fi
    ;;
  health)
    printf 'sample_started\\n' >>"$TEST_EVENT_LOG"
    ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(fixtureMonitor, 0o755);
    chmodSync(join(scriptsDir, 'vps-monitor-process-guardian.sh'), 0o755);

    wrapper = spawn(fixtureMonitor, ['60', '15'], {
      cwd: fixture,
      env: {
        ...process.env,
        MAXIM_MONITOR_LOCK_FILE: localLock,
        MAXIM_MONITOR_LOG: monitorLog,
        TEST_EVENT_LOG: eventLog,
        TEST_REMOTE_LOCK_FILE: remoteLock,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    wrapper.stderr.on('data', (chunk) => {
      wrapperStderr += String(chunk);
    });
    const [status] = await once(wrapper, 'close');
    wrapper = undefined;

    assert.equal(status, 3, wrapperStderr);
    assert.match(wrapperStderr, /did not acknowledge its live challenge/u);
    assert.equal(readFileSync(eventLog, 'utf8').trim(), 'holder_lock_lost');
    assert.equal(spawnSync('flock', ['-n', remoteLock, 'true']).status, 0);
  },
);

test(
  'wrapper SIGTERM stops and waits for the active sample before releasing the remote lock',
  { timeout: 15_000 },
  async (t) => {
    const fixture = mkdtempSync(join(tmpdir(), 'maxim-monitor-wrapper-'));
    const scriptsDir = join(fixture, 'infra/scripts');
    const libDir = join(scriptsDir, 'lib');
    const fixtureMonitor = join(scriptsDir, 'vps-monitor-readonly.sh');
    const fixtureConnect = join(scriptsDir, 'vps-connect.sh');
    const eventLog = join(fixture, 'events.log');
    const descendantFile = join(fixture, 'sample-descendant.pid');
    const holderDescendantFile = join(fixture, 'holder-descendant.pid');
    const localLock = join(fixture, 'local.lock');
    const remoteLock = join(fixture, 'remote.lock');
    const monitorLog = join(fixture, 'monitor.log');
    let wrapper;
    let wrapperStderr = '';
    t.after(() => {
      wrapper?.kill('SIGKILL');
      rmSync(fixture, { force: true, recursive: true });
    });

    mkdirSync(libDir, { recursive: true });
    copyFileSync(monitorPath, fixtureMonitor);
    copyFileSync(guardianPath, join(scriptsDir, 'vps-monitor-process-guardian.sh'));
    copyFileSync(processTreePath, join(libDir, 'monitor-process-tree.sh'));
    writeFileSync(
      join(libDir, 'deploy-topology.sh'),
      'MAXIM_PRODUCTION_API_SERVICES=(api-ingress)\nMAXIM_MEDIA_ANALYSIS_SERVICE=api-media-analysis\n',
    );
    writeFileSync(
      join(libDir, 'deploy-disk-capacity.sh'),
      'MAXIM_API_BUILD_HARD_MIN_FREE_BYTES=21474836480\n',
    );
    writeFileSync(
      fixtureConnect,
      `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  exec)
    if [[ "$*" == *vps-monitor-lock-holder.sh* ]]; then
      exec {lock_fd}>>"$TEST_REMOTE_LOCK_FILE"
      flock -n "$lock_fd" || exit 3
      trap 'printf "holder_released\\n" >>"$TEST_EVENT_LOG"' EXIT
      (
        trap '' TERM
        while true; do sleep 1; done
      ) &
      holder_descendant=$!
      printf '%s\\n' "$holder_descendant" >"$TEST_HOLDER_DESCENDANT_FILE"
      printf 'MAXIM_REMOTE_MONITOR_LOCK_ACQUIRED\\n'
      while IFS=' ' read -r command challenge extra; do
        [[ "$command" == 'MAXIM_REMOTE_MONITOR_LOCK_PING' && -n "$challenge" && -z "$extra" ]]
        printf 'holder_ack\\n' >>"$TEST_EVENT_LOG"
        printf 'MAXIM_REMOTE_MONITOR_LOCK_ACK %s\\n' "$challenge"
      done
      wait "$holder_descendant"
    fi
    exit 0
    ;;
  health)
    printf 'sample_started\\n' >>"$TEST_EVENT_LOG"
    (
      trap 'exit 0' TERM INT
      while true; do
        printf 'sample_continued\\n' >>"$TEST_EVENT_LOG"
        sleep 0.05
      done
    ) &
    descendant=$!
    printf '%s\\n' "$descendant" >"$TEST_DESCENDANT_FILE"
    stopped=0
    cleanup_sample() {
      if ((stopped == 0)); then
        stopped=1
        kill -TERM "$descendant" 2>/dev/null || true
        wait "$descendant" 2>/dev/null || true
        printf 'sample_stopped\\n' >>"$TEST_EVENT_LOG"
      fi
    }
    trap 'cleanup_sample; exit 143' TERM INT
    trap cleanup_sample EXIT
    wait "$descendant" 2>/dev/null || true
    ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(fixtureMonitor, 0o755);
    chmodSync(join(scriptsDir, 'vps-monitor-process-guardian.sh'), 0o755);

    wrapper = spawn(fixtureMonitor, ['60', '15'], {
      cwd: fixture,
      env: {
        ...process.env,
        MAXIM_MONITOR_LOCK_FILE: localLock,
        MAXIM_MONITOR_LOG: monitorLog,
        TEST_DESCENDANT_FILE: descendantFile,
        TEST_EVENT_LOG: eventLog,
        TEST_HOLDER_DESCENDANT_FILE: holderDescendantFile,
        TEST_REMOTE_LOCK_FILE: remoteLock,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    wrapper.stderr.on('data', (chunk) => {
      wrapperStderr += String(chunk);
    });
    try {
      await waitForFile(eventLog, /sample_started/u);
    } catch (error) {
      let monitorOutput = '';
      try {
        monitorOutput = readFileSync(monitorLog, 'utf8');
      } catch {
        // The wrapper may fail before creating its output file.
      }
      throw new Error(
        `${error.message}\nwrapper stderr:\n${wrapperStderr}\nmonitor output:\n${monitorOutput}`,
      );
    }
    const descendantPid = Number(readFileSync(descendantFile, 'utf8').trim());
    await waitForFile(holderDescendantFile, /[0-9]+/u);
    const holderDescendantPid = Number(readFileSync(holderDescendantFile, 'utf8').trim());
    assert.equal(isLivePid(descendantPid), true);
    assert.equal(isLivePid(holderDescendantPid), true);

    wrapper.kill('SIGTERM');
    const [status] = await once(wrapper, 'close');
    const eventText = readFileSync(eventLog, 'utf8');
    assert.equal(status, 143, eventText);
    wrapper = undefined;

    const events = eventText.trim().split('\n');
    const acknowledgedAt = events.indexOf('holder_ack');
    const startedAt = events.indexOf('sample_started');
    const stoppedAt = events.lastIndexOf('sample_stopped');
    const releasedAt = events.lastIndexOf('holder_released');
    assert.ok(acknowledgedAt >= 0 && startedAt > acknowledgedAt, events.join(','));
    assert.ok(stoppedAt >= 0, events.join(','));
    assert.ok(releasedAt > stoppedAt, events.join(','));
    assert.equal(isLivePid(descendantPid), false);
    assert.equal(isLivePid(holderDescendantPid), false);
    const eventBytes = readFileSync(eventLog).byteLength;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    assert.equal(
      readFileSync(eventLog).byteLength,
      eventBytes,
      'sample continued after wrapper exit',
    );
    assert.equal(spawnSync('flock', ['-n', remoteLock, 'true']).status, 0);
  },
);

test('VPS monitor lock holder rejects arbitrary lock targets', () => {
  const result = spawnSync(holderPath, [], {
    cwd: root,
    env: {
      ...process.env,
      MAXIM_MONITOR_REMOTE_LOCK_FILE: '/tmp/unrelated-monitor-target',
    },
    encoding: 'utf8',
    input: '',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /canonical monitor lock path/u);
});

test('monitor configuration rejects unsafe ranges before lock acquisition', () => {
  const cases = [
    {
      args: ['21601', '300'],
      env: {},
      error: /DURATION_SEC must be an integer between 1 and 21600/u,
    },
    {
      args: ['60', '14'],
      env: {},
      error: /INTERVAL_SEC must be an integer of at least 15/u,
    },
    {
      args: ['60', '15'],
      env: { MAXIM_MONITOR_FAILED_FRESH_WINDOW_SEC: '86401' },
      error: /must be between INTERVAL_SEC and 86400/u,
    },
    {
      args: ['60', '15'],
      env: { MAXIM_MONITOR_FAILED_FRESH_WINDOW_SEC: '14' },
      error: /must be between INTERVAL_SEC and 86400/u,
    },
  ];

  for (const entry of cases) {
    const result = spawnSync('bash', [monitorPath, ...entry.args], {
      cwd: root,
      env: { ...process.env, ...entry.env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, entry.error);
    assert.doesNotMatch(result.stdout, /Readonly VPS monitor started/u);
  }

  assert.match(monitor, /^MIN_MONITOR_INTERVAL_SEC=15$/mu);
  assert.match(monitor, /^MAX_MONITOR_DURATION_SEC=21600$/mu);
  assert.match(monitor, /^MAX_MONITOR_FAILED_FRESH_WINDOW_SEC=86400$/mu);
  assert.match(monitor, /read -r -t 15 marker/u);
  assert.match(monitor, /monitor_terminate_owned_tree/u);
  assert.match(monitor, /stop_monitor_runner\n\s+release_remote_monitor_lock/u);
});
