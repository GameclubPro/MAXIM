import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { deployLockFixture, deployLockEnvironment } from './test-fixtures/deploy-lock.mjs';

for (const scenario of ['valid', 'invalid-schema', 'foreign-checksum']) {
  const valid = scenario === 'valid';
  const foreignChecksum = scenario === 'foreign-checksum';
  test(`restore is isolated, cleaned and receipts require authority schema; scenario=${scenario}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'maxim-restore-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const lock = deployLockFixture(dir);
    const bin = join(dir, 'bin');
    const backup = join(dir, 'backup');
    const data = join(dir, 'restore');
    for (const path of [bin, backup, data]) mkdirSync(path);
    const log = join(dir, 'docker.log');
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh
echo '{"ok":true,"checks":{"database":true,"redis":true,"queueLag":{"rawOk":true,"softWarning":false}}}'
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
case "$*" in
  *pg_database_size*) echo 1024 ;;
  *pg_restore*) cat >/dev/null ;;
  *psql*critical*) echo "$TEST_SCHEMA_VALID" ;;
  *psql*) echo 1 ;;
esac
`,
      { mode: 0o700 },
    );
    const script = join(dir, 'restore.sh');
    writeFileSync(
      script,
      readFileSync(resolve(import.meta.dirname, 'restore-postgres-backup-smoke.sh'), 'utf8')
        .replace(/^ROOT_DIR=.*$/mu, `ROOT_DIR='${resolve(import.meta.dirname, '../..')}'`)
        .replace('source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"', `source '${lock.helper}'`),
    );
    const name = 'maxim_20261013T000000Z.dump';
    const dump = join(backup, name);
    const bytes = 'synthetic restore fixture';
    writeFileSync(dump, bytes);
    writeFileSync(
      `${dump}.sha256`,
      `${createHash('sha256').update(bytes).digest('hex')}  ${foreignChecksum ? 'unrelated.dump' : name}\n`,
    );
    writeFileSync(join(backup, 'unrelated.dump'), bytes);
    const env = deployLockEnvironment({
      PATH: `${bin}:${process.env.PATH}`,
      MAXIM_BACKUP_DIR: backup,
      MAXIM_RESTORE_SMOKE_DATA_ROOT: data,
      MAXIM_RESTORE_SMOKE_MIN_FREE_BYTES: '1024',
      MAXIM_RESTORE_SMOKE_REQUIRE_DEDICATED_FILESYSTEM: '0',
      MAXIM_BACKUP_POSTGRES_IMAGE: 'sha256:fixture',
      TEST_DOCKER_LOG: log,
      TEST_SCHEMA_VALID: valid ? '1' : '0',
    });
    const result = spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status === 0, valid, result.stderr);
    assert.equal(existsSync(`${dump}.restore-verified.json`), valid);
    assert.deepEqual(readdirSync(data), []);
    if (foreignChecksum) {
      assert.equal(existsSync(log), false);
      assert.equal(spawnSync('flock', ['-n', lock.file, 'true']).status, 0);
      return;
    }
    const operations = readFileSync(log, 'utf8');
    assert.match(operations, /--network none --cpus 2 --memory 4g --pids-limit 128/u);
    assert.match(operations, /rm -f maxim-postgres-restore-smoke-/u);
    assert.doesNotMatch(operations, /compose.*(?:up|down)|rm -f (?:postgres|infra-postgres)/u);
    assert.equal(spawnSync('flock', ['-n', lock.file, 'true']).status, 0);
  });
}
