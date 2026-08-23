import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../..', import.meta.url).pathname;
const helper = join(root, 'infra/scripts/stream-live-postgres-backup-to-local.sh');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-live-postgres-'));
  const bin = join(directory, 'bin');
  const local = join(directory, 'local');
  const recipient = join(directory, 'recipients.txt');
  const identity = join(directory, 'identity.txt');
  const ssh = join(bin, 'ssh');
  const age = join(bin, 'age');
  const pgRestore = join(bin, 'pg_restore');
  const sigpipeMarker = join(directory, 'age-sigpipe-once');
  const cleanupMarker = join(directory, 'cleanup-called');

  mkdirSync(bin);
  writeFileSync(recipient, 'age1mockrecipient\n');
  writeFileSync(identity, 'AGE-SECRET-KEY-MOCK\n');
  chmodSync(identity, 0o600);
  writeFileSync(
    ssh,
    `#!/usr/bin/env bash
set -euo pipefail
command="\${!#}"
all_args="$*"
if [[ "$command" == *pg_database_size* ]]; then
  printf '%s\\n' 4096
  exit 0
fi
if [[ "$all_args" == *pg_terminate_backend* ]]; then
  : >"$MOCK_CLEANUP_MARKER"
  exit 0
fi
if [[ "$command" == *'bash -s'* ]]; then
  cat >/dev/null
  printf '%s' "$MOCK_DUMP"
  if [[ "\${MOCK_STREAM_FAIL:-0}" == 1 ]]; then
    exit 7
  fi
  exit 0
fi
echo 'unexpected ssh command' >&2
exit 1
`,
  );
  writeFileSync(
    age,
    `#!/usr/bin/env bash
set -euo pipefail
decrypt=0
input=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d) decrypt=1; shift ;;
    -i|-R|-r) shift 2 ;;
    *) input="$1"; shift ;;
  esac
done
  if [[ "$decrypt" == 1 ]]; then
  tail -c +10 "$input"
  if [[ "\${MOCK_AGE_SIGPIPE:-0}" == 1 && ! -e "\${MOCK_SIGPIPE_MARKER:-}" ]]; then
    : >"$MOCK_SIGPIPE_MARKER"
    exit 141
  fi
else
  printf 'AGE-MOCK\\n'
  cat
fi
`,
  );
  writeFileSync(
    pgRestore,
    `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
if [[ "\${MOCK_RESTORE_FAIL:-0}" == 1 ]]; then
  exit 9
fi
printf '%s\\n' '1; 1259 16390 TABLE public _prisma_migrations maxim' '2; 1259 16391 TABLE public users maxim'
`,
  );
  for (const executable of [ssh, age, pgRestore]) {
    chmodSync(executable, 0o755);
  }
  return { directory, bin, local, recipient, identity, sigpipeMarker, cleanupMarker };
}

function runHelper(data, extraEnv = {}) {
  return spawnSync(
    'bash',
    [
      helper,
      '--local-dir',
      data.local,
      '--output-name',
      'maxim_20990101T000000Z.dump',
      '--age-recipient-file',
      data.recipient,
      '--age-identity-file',
      data.identity,
      '--min-free-bytes',
      '1',
      '--rate-limit',
      '0',
      '--allow-degraded',
      '--max-duration-sec',
      '60',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${data.bin}:${process.env.PATH}`,
        MOCK_DUMP: 'custom dump payload\n',
        MOCK_CLEANUP_MARKER: data.cleanupMarker,
        MAXIM_VPS_ENV_FILE: join(data.directory, 'missing-vps-env'),
        ...extraEnv,
      },
    },
  );
}

function createCompletePair(data, stamp, ageSeconds) {
  const name = `maxim_${stamp}.dump.age`;
  const path = join(data.local, name);
  writeFileSync(path, `old encrypted ${stamp}\n`);
  const encryptedSha = sha256(path);
  writeFileSync(`${path}.sha256`, `${encryptedSha}  ${name}\n`);
  writeFileSync(
    `${path}.ack`,
    `version=1\nstatus=verified-encrypted\nsource_kind=live-postgres\nencrypted_basename=${name}\nencrypted_sha256=${encryptedSha}\n`,
  );
  const mtime = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(path, mtime, mtime);
  utimesSync(`${path}.sha256`, mtime, mtime);
  utimesSync(`${path}.ack`, mtime, mtime);
}

test('streams, encrypts, restore-list verifies, and publishes atomically', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runHelper(data);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(data.cleanupMarker), true);

  const target = join(data.local, 'maxim_20990101T000000Z.dump.age');
  const checksum = `${target}.sha256`;
  const ack = `${target}.ack`;
  assert.equal(readFileSync(target, 'utf8'), 'AGE-MOCK\ncustom dump payload\n');
  assert.equal(readFileSync(checksum, 'utf8'), `${sha256(target)}  ${target.split('/').pop()}\n`);
  const ackText = readFileSync(ack, 'utf8');
  assert.match(ackText, /status=verified-encrypted\n/u);
  assert.match(ackText, /source_kind=live-postgres\n/u);
  assert.match(ackText, /remote_database_size_bytes=4096\n/u);
  assert.match(ackText, /postgres_application_name=maxim-live-backup-[A-Za-z0-9T-]+\n/u);
  assert.match(ackText, /restore_list_entries=2\n/u);
  assert.deepEqual(readdirSync(data.local).sort(), [
    '.live-postgres-stream.lock',
    'maxim_20990101T000000Z.dump.age',
    'maxim_20990101T000000Z.dump.age.ack',
    'maxim_20990101T000000Z.dump.age.sha256',
  ]);
});

test('fails closed when the remote pg_dump stream exits nonzero', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runHelper(data, { MOCK_STREAM_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stream failed|no destination files were published/iu);
  assert.deepEqual(readdirSync(data.local), ['.live-postgres-stream.lock']);
});

test('fails closed when restore-list verification fails', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runHelper(data, { MOCK_RESTORE_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /restore-list verification failed|no destination files were published/iu,
  );
  assert.deepEqual(readdirSync(data.local), ['.live-postgres-stream.lock']);
});

test('accepts the expected age SIGPIPE after a successful restore-list', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runHelper(data, {
    MOCK_AGE_SIGPIPE: '1',
    MOCK_SIGPIPE_MARKER: data.sigpipeMarker,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified live encrypted PostgreSQL dump/u);
});

test('retains two newest complete live pairs and removes only expired pairs', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  mkdirSync(data.local);
  createCompletePair(data, '20200101T000000Z', 32 * 86400);
  createCompletePair(data, '20200102T000000Z', 31 * 86400);
  createCompletePair(data, '20200103T000000Z', 30 * 86400);
  writeFileSync(join(data.local, 'maxim_20191231T000000Z.dump.age'), 'incomplete');

  const result = runHelper(data);
  assert.equal(result.status, 0, result.stderr);
  const names = readdirSync(data.local).sort();
  assert.ok(names.includes('maxim_20200103T000000Z.dump.age'));
  assert.ok(names.includes('maxim_20990101T000000Z.dump.age'));
  assert.ok(names.includes('maxim_20191231T000000Z.dump.age'));
  assert.ok(!names.includes('maxim_20200101T000000Z.dump.age'));
  assert.ok(!names.includes('maxim_20200102T000000Z.dump.age'));
  assert.ok(!names.includes('maxim_20200101T000000Z.dump.age.ack'));
  assert.ok(!names.includes('maxim_20200102T000000Z.dump.age.sha256'));
});

test('fails closed when another live stream owns the local lock', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  mkdirSync(data.local);
  const lockPath = join(data.local, '.live-postgres-stream.lock');
  const holder = spawn('flock', ['-n', lockPath, 'sleep', '3'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGTERM'));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const result = runHelper(data);
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /already running/u);
});
