import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../..', import.meta.url).pathname;
const helper = join(root, 'infra/scripts/pull-backup-to-local.sh');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixture({ mutateAfterCat = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-pull-backup-'));
  const bin = join(directory, 'bin');
  const source = join(directory, 'source.dump');
  const destination = join(directory, 'local');
  const recipient = join(directory, 'recipients.txt');
  const identity = join(directory, 'identity.txt');
  const ssh = join(bin, 'ssh');
  const age = join(bin, 'age');

  mkdirSync(bin);
  writeFileSync(source, 'validated backup bytes\n');
  writeFileSync(recipient, 'age1mockrecipient\n');
  writeFileSync(identity, 'AGE-SECRET-KEY-MOCK\n');
  chmodSync(identity, 0o600);
  writeFileSync(join(directory, 'source.dump.sha256'), `${sha256(source)}  source.dump\n`);
  writeFileSync(
    ssh,
    `#!/usr/bin/env bash
set -euo pipefail
command="\${!#}"
if [[ "$command" == *--check* ]]; then
  exit 0
fi
if [[ "$command" == *cat* ]]; then
  cat -- "$MOCK_SOURCE"
${mutateAfterCat ? '  printf %s changed >"$MOCK_SOURCE"' : '  :'}
  exit 0
fi
if [[ "$command" == *wc* ]]; then
  bytes="$(wc -c <"$MOCK_SOURCE")"
  bytes="\${bytes//[[:space:]]/}"
  checksum="$(sha256sum -- "$MOCK_SOURCE" | awk '{print $1}')"
  printf '%s %s\\n' "$bytes" "$checksum"
  exit 0
fi
echo "unexpected remote command: $command" >&2
exit 1
`,
  );
  writeFileSync(
    age,
    `#!/usr/bin/env bash
set -euo pipefail
decrypt=0
input=''
output=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == '-d' ]]; then
    decrypt=1
    shift
  elif [[ "$1" == '-i' || "$1" == '-R' || "$1" == '-r' ]]; then
    shift 2
  elif [[ "$1" == '-o' ]]; then
    output="$2"
    shift 2
  else
    input="$1"
    shift
  fi
done
if [[ "$decrypt" == 1 ]]; then
  tail -c +9 "$input"
else
  printf %s age-mock
  cat
fi
`,
  );
  chmodSync(ssh, 0o755);
  chmodSync(age, 0o755);
  return { directory, bin, source, destination, recipient, identity };
}

function runPull(fixtureData, extraArgs = []) {
  return spawnSync(
    'bash',
    [
      helper,
      '--ssh-target',
      'mock-vps',
      '--remote-path',
      '/remote/source.dump',
      '--local-dir',
      fixtureData.destination,
      '--age-recipient-file',
      fixtureData.recipient,
      '--age-identity-file',
      fixtureData.identity,
      '--require-sidecar',
      '--min-free-bytes',
      '1',
      ...extraArgs,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixtureData.bin}:${process.env.PATH}`,
        MOCK_SOURCE: fixtureData.source,
        MAXIM_VPS_ENV_FILE: join(fixtureData.directory, 'missing-vps-env'),
      },
    },
  );
}

test('pulls, verifies, encrypts, and ACKs a completed backup', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runPull(data);
  assert.equal(result.status, 0, result.stderr);

  const target = join(data.destination, 'source.dump.age');
  const checksum = join(data.destination, 'source.dump.age.sha256');
  const ack = join(data.destination, 'source.dump.age.ack');
  assert.equal(readFileSync(target, 'utf8'), 'age-mockvalidated backup bytes\n');
  assert.equal(readFileSync(checksum, 'utf8'), `${sha256(target)}  source.dump.age\n`);
  assert.match(readFileSync(ack, 'utf8'), /status=verified-encrypted\n/u);
  assert.match(readFileSync(ack, 'utf8'), new RegExp(`source_sha256=${sha256(data.source)}`));
  assert.equal(readFileSync(data.source, 'utf8'), 'validated backup bytes\n');
  assert.deepEqual(readdirSync(data.destination).sort(), [
    'source.dump.age',
    'source.dump.age.ack',
    'source.dump.age.sha256',
  ]);
});

test('refuses to publish when the remote artifact changes during transfer', (t) => {
  const data = fixture({ mutateAfterCat: true });
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const result = runPull(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed during transfer/u);
  assert.equal(readFileSync(data.source, 'utf8'), 'changed');
  assert.deepEqual(readdirSync(data.destination), []);
});
