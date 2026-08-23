import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const wrapper = join(root, 'infra/scripts/pull-latest-backup-to-local.sh');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeSidecar(path) {
  writeFileSync(`${path}.sha256`, `${sha256File(path)}  ${path.split('/').pop()}\n`);
}

function fixture(kind, { remoteName = 'remote' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), `maxim-latest-${kind}-`));
  const bin = join(directory, 'bin');
  const remote = join(directory, remoteName);
  const local = join(directory, 'local');
  const recipient = join(directory, 'recipient.txt');
  const identity = join(directory, 'identity.txt');
  const pullLog = join(directory, 'pull.log');
  const ssh = join(bin, 'ssh');
  const fakePull = join(bin, 'fake-pull.sh');
  mkdirSync(bin);
  mkdirSync(remote);
  writeFileSync(recipient, 'age1test-recipient\n');
  writeFileSync(identity, 'AGE-SECRET-KEY-TEST\n');
  chmodSync(identity, 0o600);

  const names =
    kind === 'postgres'
      ? {
          valid: 'maxim_20260823T010000Z.dump',
          invalidNewest: 'maxim_20260823T020000Z.dump',
        }
      : {
          valid: 'karavan-20260823T010000Z.tar.gz',
          invalidNewest: 'karavan-20260823T020000Z.tar.gz',
        };
  const validPath = join(remote, names.valid);
  const invalidPath = join(remote, names.invalidNewest);
  writeFileSync(validPath, `${kind} validated archive\n`);
  writeSidecar(validPath);
  writeFileSync(invalidPath, `${kind} corrupt newest archive\n`);
  writeFileSync(`${invalidPath}.sha256`, `not-a-checksum  ${names.invalidNewest}\n`);

  writeFileSync(
    ssh,
    `#!/usr/bin/env bash
set -euo pipefail
raw="\${!#}"
if [[ "$raw" == bash\\ -c* ]]; then
  eval "set -- $raw"
  bash -c "$3"
  exit $?
fi
echo "unexpected ssh command: $raw" >&2
exit 1
`,
  );
  writeFileSync(
    fakePull,
    `#!/usr/bin/env bash
set -euo pipefail
remote_path=''
local_dir=''
recipient_file=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote-path) remote_path="$2"; shift 2 ;;
    --local-dir) local_dir="$2"; shift 2 ;;
    --age-recipient-file) recipient_file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$remote_path" >>"$MOCK_PULL_LOG"
base="\${remote_path##*/}"
source_path="$MOCK_REMOTE_DIR/$base"
target="$local_dir/$base.age"
mkdir -p "$local_dir"
printf 'age-test-' >"$target"
cat "$source_path" >>"$target"
encrypted_sha256=$(sha256sum -- "$target" | awk '{print $1}')
source_sha256=$(sha256sum -- "$source_path" | awk '{print $1}')
source_size=$(wc -c <"$source_path")
source_size="\${source_size//[[:space:]]/}"
recipient_sha256=$(sha256sum -- "$recipient_file" | awk '{print $1}')
printf '%s  %s\\n' "$encrypted_sha256" "$base.age" >"$target.sha256"
{
  printf 'version=1\\n'
  printf 'status=verified-encrypted\\n'
  printf 'source_basename=%s\\n' "$base"
  printf 'source_size_bytes=%s\\n' "$source_size"
  printf 'source_sha256=%s\\n' "$source_sha256"
  printf 'encrypted_basename=%s\\n' "$base.age"
  printf 'encrypted_sha256=%s\\n' "$encrypted_sha256"
  printf 'age_recipient_file_sha256=%s\\n' "$recipient_sha256"
  printf 'copied_at_utc=2026-08-23T01:30:00Z\\n'
} >"$target.ack"
`,
  );
  chmodSync(ssh, 0o755);
  chmodSync(fakePull, 0o755);
  return {
    kind,
    directory,
    bin,
    remote,
    local,
    recipient,
    identity,
    pullLog,
    fakePull,
    validName: names.valid,
  };
}

function run(data, extraArgs = []) {
  return spawnSync(
    'bash',
    [
      wrapper,
      '--kind',
      data.kind,
      '--remote-dir',
      data.remote,
      '--local-dir',
      data.local,
      ...extraArgs,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${data.bin}:${process.env.PATH}`,
        MAXIM_VPS_ENV_FILE: join(data.directory, 'missing-vps-env'),
        MAXIM_VPS_SSH_TARGET: 'mock-vps',
        MAXIM_BACKUP_PULL_SCRIPT: data.fakePull,
        MAXIM_BACKUP_AGE_RECIPIENT_FILE: data.recipient,
        MAXIM_BACKUP_AGE_IDENTITY_FILE: data.identity,
        MAXIM_BACKUP_LOCAL_RETENTION_DAYS: '30',
        MAXIM_BACKUP_LOCAL_KEEP_COUNT: '2',
        MOCK_REMOTE_DIR: data.remote,
        MOCK_PULL_LOG: data.pullLog,
      },
    },
  );
}

function createOldPair(data, base) {
  const agePath = join(data.local, `${base}.age`);
  mkdirSync(data.local, { recursive: true });
  writeFileSync(agePath, 'old encrypted bytes\n');
  writeSidecar(agePath);
  writeFileSync(`${agePath}.ack`, 'status=verified-encrypted\n');
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  utimesSync(agePath, old, old);
  utimesSync(`${agePath}.sha256`, old, old);
  utimesSync(`${agePath}.ack`, old, old);
  return agePath;
}

for (const kind of ['postgres', 'karavan']) {
  test(`${kind}: discovers checksum-backed latest, pulls once, ACK-skips, and retains encrypted pairs`, (t) => {
    const data = fixture(kind);
    t.after(() => rmSync(data.directory, { force: true, recursive: true }));

    const first = run(data);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Pulling latest checksum-backed backup/u);
    const target = join(data.local, `${data.validName}.age`);
    assert.equal(existsSync(target), true);
    assert.equal(existsSync(join(data.local, `${data.validName}.dump`)), false);
    assert.equal(readFileSync(data.pullLog, 'utf8').trim(), join(data.remote, data.validName));

    const second = run(data);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Already ACKed encrypted backup/u);
    assert.deepEqual(readFileSync(data.pullLog, 'utf8').trim().split('\n'), [
      join(data.remote, data.validName),
    ]);

    const oldBase =
      kind === 'postgres' ? 'maxim_20260801T010000Z.dump' : 'karavan-20260801T010000Z.tar.gz';
    const oldPath = createOldPair(data, oldBase);
    const retained = run(data, ['--retention-days', '7', '--keep-count', '1']);
    assert.equal(retained.status, 0, retained.stderr);
    assert.equal(existsSync(oldPath), false);
    assert.equal(existsSync(`${oldPath}.sha256`), false);
    assert.equal(existsSync(`${oldPath}.ack`), false);
  });
}

test('refuses an incomplete local pair without silently overwriting it', (t) => {
  const data = fixture('postgres');
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  assert.equal(run(data).status, 0);
  rmSync(join(data.local, `${data.validName}.age.ack`));
  const result = run(data);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--repair-partial/u);
  assert.equal(readFileSync(data.pullLog, 'utf8').trim().split('\n').length, 1);
});

test('dry-run does not invoke the pull helper or remove an expired pair', (t) => {
  const data = fixture('postgres');
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const oldPath = createOldPair(data, 'maxim_20260801T010000Z.dump');
  const result = run(data, ['--dry-run', '--retention-days', '7', '--keep-count', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would pull and encrypt/u);
  assert.equal(existsSync(oldPath), true);
  assert.equal(existsSync(data.pullLog), false);
});

test('quotes remote and local directories without changing the selected archive', (t) => {
  const data = fixture('postgres', { remoteName: "remote dir's" });
  data.local = join(data.directory, "local dir's");
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = run(data);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(data.local, `${data.validName}.age`)), true);
});
