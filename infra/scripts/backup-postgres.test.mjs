import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const helper = join(root, 'infra/scripts/backup-postgres.sh');
const rateLimiter = join(root, 'infra/scripts/rate-limit-stream.mjs');
const installer = join(root, 'infra/scripts/vps-install-postgres-backup-timers.sh');
const envExample = join(root, 'infra/env/postgres-backup.env.example');

const READY_JSON = JSON.stringify({
  ok: true,
  checks: {
    database: true,
    redis: true,
    queueLag: { rawOk: true, softWarning: false },
  },
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-postgres-backup-'));
  const bin = join(directory, 'bin');
  const backup = join(directory, 'backup');
  const dockerLog = join(directory, 'docker.log');
  const cleanupMarker = join(directory, 'cleanup-called');
  const readyCounter = join(directory, 'ready-counter');
  const dumpPid = join(directory, 'dump.pid');
  const lock = join(directory, 'backup.lock');
  mkdirSync(bin);
  mkdirSync(backup);

  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${MOCK_READY_FAIL:-0}" == 1 ]]; then
  exit 22
fi
if [[ -n "\${MOCK_READY_COUNTER_FILE:-}" ]]; then
  count=0
  if [[ -f "\${MOCK_READY_COUNTER_FILE}" ]]; then
    count="$(cat "\${MOCK_READY_COUNTER_FILE}")"
  fi
  count=$((count + 1))
  printf '%s' "$count" >"\${MOCK_READY_COUNTER_FILE}"
  if [[ -n "\${MOCK_DEGRADE_AFTER_CALL:-}" ]] && ((count > MOCK_DEGRADE_AFTER_CALL)); then
    printf '%s' "\${MOCK_DEGRADED_READY_JSON}"
    exit 0
  fi
fi
printf '%s' "\${MOCK_READY_JSON}"
`,
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"\${MOCK_DOCKER_LOG}"
all_args="$*"
if [[ "$all_args" == *pg_database_size* ]]; then
  printf '%s\n' "\${MOCK_DATABASE_BYTES:-4096}"
  exit 0
fi
if [[ "$all_args" == *pg_terminate_backend* ]]; then
  : >"\${MOCK_CLEANUP_MARKER}"
  exit 0
fi
if [[ "$all_args" == *pg_restore* ]]; then
  cat >/dev/null
  if [[ "\${MOCK_RESTORE_FAIL:-0}" == 1 ]]; then
    exit 9
  fi
  exit 0
fi
if [[ "$all_args" == *pg_dump* ]]; then
  if [[ -n "\${MOCK_DUMP_PID_FILE:-}" ]]; then
    printf '%s' "$$" >"\${MOCK_DUMP_PID_FILE}"
  fi
  sleep "\${MOCK_DUMP_SLEEP_SEC:-0}"
  if [[ "\${MOCK_DUMP_FAIL:-0}" == 1 ]]; then
    exit 7
  fi
  printf '%s' "\${MOCK_DUMP:-custom dump payload}"
  exit 0
fi
echo 'unexpected docker invocation' >&2
exit 1
`,
  );
  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == *rate-limit-stream.mjs && "\${MOCK_LIMITER_FAIL:-0}" == 1 ]]; then
  exit 8
fi
exec "\${MOCK_REAL_NODE}" "$@"
`,
  );
  for (const executable of ['curl', 'docker', 'node']) {
    chmodSync(join(bin, executable), 0o755);
  }
  return {
    directory,
    bin,
    backup,
    dockerLog,
    cleanupMarker,
    readyCounter,
    dumpPid,
    lock,
  };
}

function helperEnv(data, extraEnv = {}) {
  return {
    ...process.env,
    PATH: `${data.bin}:${process.env.PATH}`,
    MAXIM_BACKUP_DIR: data.backup,
    MAXIM_BACKUP_COMPOSE_FILE: join(data.directory, 'compose.yml'),
    MAXIM_BACKUP_MIN_FREE_BYTES: '1',
    MAXIM_BACKUP_REQUIRE_DEDICATED_FILESYSTEM: '0',
    MAXIM_BACKUP_LOCK_FILE: data.lock,
    MAXIM_BACKUP_MAX_DURATION_SEC: '5',
    MOCK_READY_JSON: READY_JSON,
    MOCK_DOCKER_LOG: data.dockerLog,
    MOCK_CLEANUP_MARKER: data.cleanupMarker,
    MOCK_READY_COUNTER_FILE: data.readyCounter,
    MOCK_DUMP_PID_FILE: data.dumpPid,
    MOCK_REAL_NODE: process.execPath,
    ...extraEnv,
  };
}

function runHelper(data, args = [], extraEnv = {}) {
  return spawnSync('bash', [helper, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: helperEnv(data, extraEnv),
  });
}

function dumpFiles(data) {
  return readdirSync(data.backup).filter((name) => name.includes('.dump'));
}

test('creates a rate-limited low-priority dump and publishes the validated pair atomically', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runHelper(data);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);

  const names = readdirSync(data.backup).sort();
  const dumpName = names.find((name) => /^maxim_.*\.dump$/u.test(name));
  assert.ok(dumpName);
  assert.deepEqual(names, [dumpName, `${dumpName}.sha256`].sort());
  assert.equal(readFileSync(join(data.backup, dumpName), 'utf8'), 'custom dump payload');
  assert.equal(statSync(join(data.backup, dumpName)).mode & 0o777, 0o600);

  const dockerLog = readFileSync(data.dockerLog, 'utf8');
  assert.match(dockerLog, /PGAPPNAME="\$3" ionice -c2 -n7 nice -n19 pg_dump/u);
  assert.match(dockerLog, /--compress=gzip:3/u);
  assert.match(dockerLog, /--lock-wait-timeout=10s/u);
  assert.match(dockerLog, /maxim-postgres-backup-[0-9TZ]+-[0-9]+/u);
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.doesNotMatch(names.join('\n'), /\.tmp$/u);
});

test('rejects degraded raw queue lag before sizing or creating a temporary dump', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const degraded = JSON.stringify({
    ok: true,
    checks: {
      database: true,
      redis: true,
      queueLag: { rawOk: false, softWarning: true },
    },
  });

  const result = runHelper(data, [], { MOCK_READY_JSON: degraded });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /raw queue lag is degraded/u);
  assert.equal(existsSync(data.dockerLog), false);
  assert.deepEqual(readdirSync(data.backup), []);
});

test('uses a nonblocking lock and does not enter readiness while another run owns it', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const readyMarker = join(data.directory, 'lock-ready');
  const holder = spawn('flock', [data.lock, 'bash', '-c', `: >${readyMarker}; sleep 5`], {
    stdio: 'ignore',
  });
  t.after(() => holder.kill('SIGTERM'));
  for (let attempt = 0; attempt < 50 && !existsSync(readyMarker); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(readyMarker), true);

  const result = runHelper(data);
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /already running/u);
  assert.equal(existsSync(data.dockerLog), false);
});

test('bounds dump duration, terminates its exact backend, and removes temporary output', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const startedAt = Date.now();
  const result = runHelper(data, [], {
    MAXIM_BACKUP_MAX_DURATION_SEC: '1',
    MOCK_DUMP_SLEEP_SEC: '5',
  });
  const elapsedMs = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  assert.ok(elapsedMs < 3_000, `backup timeout took ${elapsedMs}ms`);
  assert.match(result.stderr, /bounded resource envelope/u);
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.deepEqual(dumpFiles(data), []);
  assert.doesNotMatch(readdirSync(data.backup).join('\n'), /\.tmp$/u);
});

test('SIGTERM terminates the exact backend and every local pipeline process', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const child = spawn('bash', [helper], {
    cwd: root,
    stdio: 'ignore',
    env: helperEnv(data, {
      MAXIM_BACKUP_MAX_DURATION_SEC: '20',
      MOCK_DUMP_SLEEP_SEC: '10',
    }),
  });
  t.after(() => child.kill('SIGKILL'));
  for (let attempt = 0; attempt < 100 && !existsSync(data.dumpPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(data.dumpPid), true);

  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 143);
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.deepEqual(dumpFiles(data), []);
  assert.doesNotMatch(readdirSync(data.backup).join('\n'), /\.tmp$/u);
  const dumpPid = Number(readFileSync(data.dumpPid, 'utf8'));
  assert.throws(() => process.kill(dumpPid, 0), { code: 'ESRCH' });
});

test('does not publish dump bytes that fail restore-list validation', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runHelper(data, [], { MOCK_RESTORE_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(dumpFiles(data), []);
  assert.doesNotMatch(readdirSync(data.backup).join('\n'), /\.tmp$/u);
});

test('stops the dump backend immediately when the stream limiter fails', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const startedAt = Date.now();
  const result = runHelper(data, [], {
    MAXIM_BACKUP_MAX_DURATION_SEC: '20',
    MOCK_DUMP_SLEEP_SEC: '10',
    MOCK_LIMITER_FAIL: '1',
  });
  const elapsedMs = Date.now() - startedAt;

  assert.notEqual(result.status, 0);
  assert.ok(elapsedMs < 3_000, `limiter failure cleanup took ${elapsedMs}ms`);
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.deepEqual(dumpFiles(data), []);
  const dumpPid = Number(readFileSync(data.dumpPid, 'utf8'));
  assert.throws(() => process.kill(dumpPid, 0), { code: 'ESRCH' });
});

test('aborts the exact dump backend after two consecutive watchdog failures', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const degraded = JSON.stringify({
    ok: true,
    checks: {
      database: true,
      redis: true,
      queueLag: { rawOk: false, softWarning: true },
    },
  });

  const startedAt = Date.now();
  const result = runHelper(data, [], {
    MAXIM_BACKUP_MAX_DURATION_SEC: '20',
    MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC: '1',
    MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD: '2',
    MOCK_DEGRADE_AFTER_CALL: '1',
    MOCK_DEGRADED_READY_JSON: degraded,
    MOCK_DUMP_SLEEP_SEC: '10',
  });
  const elapsedMs = Date.now() - startedAt;

  assert.notEqual(result.status, 0);
  assert.ok(elapsedMs < 5_000, `watchdog abort took ${elapsedMs}ms`);
  assert.match(result.stderr, /watchdog observed degraded readiness.*1\/2/iu);
  assert.match(result.stderr, /watchdog observed degraded readiness.*2\/2/iu);
  assert.match(result.stderr, /aborted after sustained readiness/iu);
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.deepEqual(dumpFiles(data), []);
  const dumpPid = Number(readFileSync(data.dumpPid, 'utf8'));
  assert.throws(() => process.kill(dumpPid, 0), { code: 'ESRCH' });
});

test('preflight checks readiness and capacity without deleting or starting a dump', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const oldDump = join(data.backup, 'maxim_20200101T000000Z.dump');
  writeFileSync(oldDump, 'old dump');
  writeFileSync(`${oldDump}.sha256`, 'old checksum');
  const oldTime = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(oldDump, oldTime, oldTime);
  utimesSync(`${oldDump}.sha256`, oldTime, oldTime);

  const result = runHelper(data, ['--preflight-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /readiness and capacity preflight passed/u);
  assert.equal(existsSync(oldDump), true);
  assert.equal(existsSync(`${oldDump}.sha256`), true);
  assert.doesNotMatch(readFileSync(data.dockerLog, 'utf8'), /pg_dump/u);
});

test('repository stream limiter enforces its configured average byte rate', () => {
  const input = Buffer.alloc(65_536, 0x61);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [rateLimiter, '131072'], {
    input,
    maxBuffer: input.length * 2,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, input);
  assert.ok(elapsedMs >= 400, `rate limiter emitted too quickly in ${elapsedMs}ms`);
  assert.ok(elapsedMs < 2_000, `rate limiter emitted too slowly in ${elapsedMs}ms`);
});

test('timer and environment keep the scheduled backup bounded and fail closed', () => {
  const installerSource = readFileSync(installer, 'utf8');
  const envSource = readFileSync(envExample, 'utf8');

  assert.match(installerSource, /SuccessExitStatus=75/u);
  assert.match(installerSource, /TimeoutStartSec=12h15m/u);
  assert.match(installerSource, /TimeoutStopSec=1m/u);
  assert.match(installerSource, /KillSignal=SIGTERM/u);
  assert.match(installerSource, /Restart=no/u);
  assert.match(installerSource, /MAXIM_ENABLE_POSTGRES_BACKUP_TIMER:-0/u);
  assert.match(envSource, /MAXIM_BACKUP_RATE_LIMIT_BYTES_PER_SEC=1048576/u);
  assert.match(envSource, /MAXIM_BACKUP_MAX_DURATION_SEC=43200/u);
  assert.match(envSource, /MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC=30/u);
  assert.match(envSource, /MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD=2/u);
  assert.match(envSource, /MAXIM_BACKUP_READINESS_URL=http:\/\/127\.0\.0\.1:3001/u);
});
