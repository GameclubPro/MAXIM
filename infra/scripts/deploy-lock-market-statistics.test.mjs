import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deployLockEnvironment, deployLockFixture } from './test-fixtures/deploy-lock.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'market-floor-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = deployLockFixture(directory);
  const trustedParent = join(directory, 'trusted');
  const trusted = join(trustedParent, 'market-statistics');
  mkdirSync(trusted, { recursive: true, mode: 0o755 });
  const helper = readFileSync(data.helper, 'utf8')
    .replaceAll('/etc/maxim-deploy', trustedParent)
    .replace('in /etc ', `in ${quote(directory)} `);
  writeFileSync(data.helper, helper);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  // Model the VPS's root-owned trust files while keeping actual inode, mode,
  // symlink and hard-link checks. Production has no ownership/path override.
  writeFileSync(
    join(bin, 'stat'),
    `#!/usr/bin/env bash
set -euo pipefail
target="\${!#}"
case "$target" in
  ${quote(directory)}|${quote(trustedParent)}|${quote(trusted)}|${quote(join(trusted, 'admission.mjs'))})
    value="$(/usr/bin/stat "$@")"
    printf '0 %s\\n' "\${value#* }"
    ;;
  *) exec /usr/bin/stat "$@" ;;
esac
`,
  );
  chmodSync(join(bin, 'stat'), 0o755);
  writeFileSync(
    join(trusted, 'admission.mjs'),
    `
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(join(directory, 'calls'))}, JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv[4] === 'a'.repeat(40)) process.exitCode=1;
`,
  );
  const env = deployLockEnvironment({ PATH: `${bin}:${process.env.PATH}` });
  const run = (script) =>
    spawnSync('bash', ['-c', `set -euo pipefail\nsource "$1"\n${script}`, 'fixture', data.helper], {
      env,
      encoding: 'utf8',
      timeout: 4000,
    });
  return { ...data, directory, trusted, run };
}

function gitCandidate(data, transform = (source) => source) {
  const repository = join(data.directory, 'candidate');
  if (!existsSync(repository)) {
    mkdirSync(repository);
    const init = spawnSync('git', ['init', '-q', repository], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
  }
  for (const path of [
    'infra/scripts/lib/deploy-lock.sh',
    'infra/scripts/vps-pull-build-up.sh',
    'infra/scripts/vps-runtime-rollback.sh',
    'infra/scripts/vps-connect.sh',
  ]) {
    const destination = join(repository, path);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(
      destination,
      transform(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), path),
    );
  }
  for (const args of [
    ['add', '.'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'candidate',
    ],
  ]) {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return repository;
}

test('fresh Market admission invokes the fixed installed reader and preserves the persistent lock', (t) => {
  const data = fixture(t);
  const release = 'b'.repeat(40);
  const result = data.run(`root=/var/www/svyazka
release=${release}
source_dir="$root/releases/$release"
acquire_deploy_lock
require_deploy_lock
release_deploy_lock`);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(data.directory, 'calls'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(calls, [['--admit', `/var/www/svyazka/releases/${release}`, release]]);
  const inode = statSync(data.file).ino;
  assert.equal(data.run('acquire_deploy_lock; require_deploy_lock').status, 0);
  assert.equal(statSync(data.file).ino, inode);
});

test('a legacy Market caller is denied before mutation and releases only its owned descriptor', (t) => {
  const data = fixture(t);
  const result = data.run(`root=/var/www/svyazka
release=${'a'.repeat(40)}
source_dir="$root/releases/$release"
if acquire_deploy_lock; then printf BAD; exit 91; fi
[[ -z "\${MAXIM_DEPLOY_LOCK_FD:-}" ]]`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(data.run('acquire_deploy_lock; require_deploy_lock').status, 0);
});

test('same-owner inherited reacquisition cannot bypass the Market floor', (t) => {
  const data = fixture(t);
  const result = data.run(`acquire_deploy_lock
root=/var/www/svyazka
release=${'a'.repeat(40)}
source_dir="$root/releases/$release"
if acquire_deploy_lock; then exit 91; fi
require_deploy_lock
release_deploy_lock`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(data.directory, 'calls'), 'utf8').trim().split('\n').length, 1);
});

test('missing or writable Market admission fails closed while other project scopes retain admission', (t) => {
  const data = fixture(t);
  chmodSync(data.trusted, 0o777);
  const scope = `root=/var/www/svyazka; source_dir="$root/releases/${'b'.repeat(40)}"; release=${'b'.repeat(40)}; acquire_deploy_lock`;
  assert.notEqual(data.run(scope).status, 0);
  rmSync(data.trusted, { recursive: true });
  assert.notEqual(data.run(scope).status, 0);
  for (const project of ['/var/www/Chat_bot', '/var/www/max-delivery-platform']) {
    const result = data.run(
      `root=${project}; source_dir="$root"; acquire_deploy_lock; require_deploy_lock`,
    );
    assert.equal(result.status, 0, result.stderr);
  }
});

test('installed Market floor refuses candidate Git tooling that loses dispatch or future retention', (t) => {
  const data = fixture(t);
  const repository = gitCandidate(data);
  const guard = () =>
    data.run(`cd ${quote(repository)}\nrequire_market_statistics_lock_dispatch HEAD`);
  assert.equal(guard().status, 0);
  const before = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout;
  gitCandidate(data, (source, path) =>
    path.endsWith('deploy-lock.sh')
      ? source.replace('    validate_market_statistics_deploy_admission || return 1\n', '')
      : source,
  );
  assert.notEqual(guard().status, 0);
  gitCandidate(data, (source, path) =>
    path.endsWith('vps-runtime-rollback.sh')
      ? source.replace('require_market_statistics_lock_dispatch "$TARGET_FULL_SHA" || exit 1\n', '')
      : source,
  );
  assert.notEqual(guard().status, 0);
  const after = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout;
  assert.notEqual(after, before);
  // The guard neither checks out the accepted older commit nor changes candidate bytes.
  const status = spawnSync('git', ['-C', repository, 'status', '--porcelain'], {
    encoding: 'utf8',
  });
  assert.equal(status.stdout, '');
  rmSync(data.trusted, { recursive: true });
  assert.equal(guard().status, 0);
});
