import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const helper = readFileSync(new URL('./lib/eraser-deploy.sh', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('./vps-eraser-bootstrap.sh', import.meta.url), 'utf8');
const guard = bootstrap.slice(
  bootstrap.indexOf('for store in postgres redis; do'),
  bootstrap.indexOf('\nif [[ "$mode" != --stores-only ]]'),
);
assert.ok(guard.startsWith('for store in postgres redis; do') && guard.endsWith('\ndone'));

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'lastik-store-metadata-'));
  const protectedParent = resolve(directory, 'protected-runtime');
  // FLAG: Equivalent privileged metadata is mocked; no test gains root or relaxes a host path.
  mkdirSync(protectedParent, { mode: 0o000 });
  const events = resolve(directory, 'events');
  const secret = resolve(directory, 'service.env');
  const password = resolve(directory, 'postgres-password');
  writeFileSync(secret, 'test-only', { mode: 0o600 });
  writeFileSync(password, 'test-only', { mode: 0o600 });
  t.after(() => {
    chmodSync(protectedParent, 0o700);
    rmSync(directory, { recursive: true, force: true });
  });
  const cold = `${protectedParent}/cold`;
  const stores = [`${cold}/runtime/eraser/postgres`, `${cold}/runtime/eraser/redis`];
  const commands = `
record() { printf '%s\\n' "$*" >>"$ERASER_FIXTURE_EVENTS"; }
mountpoint() { [[ "$*" == "-q $ERASER_FIXTURE_COLD" ]]; }
sudo() {
  record "sudo $*"
  [[ "$1" == -n ]] || return 79
  shift
  local path="\${@: -1}" kind
  [[ "$path" == "$ERASER_FIXTURE_COLD/runtime/eraser/postgres" || "$path" == "$ERASER_FIXTURE_COLD/runtime/eraser/redis" ]] || return 79
  if [[ "$ERASER_FIXTURE_FAILURE" == denied ]]; then return 1; fi
  if [[ "$#" == 3 && "$1" == test && "$2" == -d ]]; then
    [[ "$ERASER_FIXTURE_FAILURE" != missing && "$ERASER_FIXTURE_FAILURE" != dangling-link ]]
  elif [[ "$#" == 4 && "$1" == test && "$2" == '!' && "$3" == -L ]]; then
    [[ "$ERASER_FIXTURE_FAILURE" != symlink && "$ERASER_FIXTURE_FAILURE" != dangling-link && "$ERASER_FIXTURE_FAILURE" != link-denied ]]
  elif [[ "$#" == 4 && "$1" == test && "$2" == '!' && "$3" == -e ]]; then
    [[ "$ERASER_FIXTURE_FAILURE" == missing || "$ERASER_FIXTURE_FAILURE" == dangling-link ]]
  elif [[ "$#" == 5 && "$1" == install && "$2" == -d && "$3" == -m && "$4" == 0700 ]]; then
    [[ "$ERASER_FIXTURE_FAILURE" == missing ]]
  else
    return 79
  fi
}
docker() {
  record "docker $*"
  if [[ "$#" == 5 && "$1" == volume && "$2" == inspect && "$3" == --format ]]; then
    case "$5" in
      infra_eraser_postgres_data) printf 'local|%s/runtime/eraser/postgres|bind\\n' "$ERASER_FIXTURE_COLD" ;;
      infra_eraser_redis_data) printf 'local|%s/runtime/eraser/redis|bind\\n' "$ERASER_FIXTURE_COLD" ;;
      *) return 80 ;;
    esac
  elif [[ "$*" == 'compose -f fixture.yml ps -q eraser-postgres' ]]; then
    printf 'own-postgres\\n'
  elif [[ "$*" == 'compose -f fixture.yml ps -q eraser-redis' ]]; then
    printf 'own-redis\\n'
  elif [[ "$#" == 4 && "$1" == inspect && "$2" == --format && ( "$4" == own-postgres || "$4" == own-redis ) ]]; then
    printf 'healthy\\n'
  else
    return 80
  fi
}
`;
  const run = (source, failure = 'none') => {
    writeFileSync(events, '');
    const result = spawnSync(
      'bash',
      ['-c', `set -euo pipefail\n${commands}\n${source.replaceAll('/mnt/maxim-cold', cold)}\n`],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          ERASER_FIXTURE_EVENTS: events,
          ERASER_FIXTURE_COLD: cold,
          ERASER_FIXTURE_FAILURE: failure,
          MAXIM_ERASER_ENV_FILE: secret,
          MAXIM_ERASER_POSTGRES_PASSWORD_FILE: password,
        },
      },
    );
    assert.equal(
      statSync(protectedParent).mode & 0o777,
      0o000,
      'the helper must not mutate ancestor permissions',
    );
    return { ...result, events: readFileSync(events, 'utf8').split('\n').filter(Boolean) };
  };
  return { run, stores };
}
const readiness = (source) =>
  `${source}\ncompose=(-f fixture.yml)\nmaxim_eraser_require_stores compose\nprintf 'READY\\n'`;

test('readiness uses only privileged metadata for its two fixed stores and retains volume/container checks', (t) => {
  const h = fixture(t);
  const result = h.run(readiness(helper));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'READY\n');
  assert.deepEqual(
    result.events.filter((line) => line.startsWith('sudo ')),
    h.stores.flatMap((path) => [`sudo -n test -d ${path}`, `sudo -n test ! -L ${path}`]),
  );
  assert.equal(result.events.filter((line) => line.startsWith('docker ')).length, 6);
  const old = helper.replace(
    'sudo -n test -d "$path" && sudo -n test ! -L "$path"',
    '[[ -d "$path" && ! -L "$path" ]]',
  );
  assert.notEqual(old, helper);
  const regression = h.run(readiness(old));
  assert.equal(regression.status, 1);
  assert.match(regression.stderr, /store directory is not provisioned/u);
});

test('readiness refuses absent stores, symlinks and either privileged check denial before Docker', (t) => {
  const h = fixture(t);
  for (const failure of ['missing', 'symlink', 'dangling-link', 'denied', 'link-denied']) {
    const result = h.run(readiness(helper), failure);
    assert.equal(result.status, 1, failure);
    assert.ok(!result.events.some((line) => line.startsWith('docker ')), failure);
    assert.ok(
      result.events.every((line) => line.startsWith('sudo -n test ')),
      failure,
    );
  }
});

test('bootstrap preserves existing protected stores and creates only positively proved absent directories', (t) => {
  const h = fixture(t);
  const existing = h.run(guard);
  assert.equal(existing.status, 0, existing.stderr);
  assert.ok(existing.events.every((line) => line.startsWith('sudo -n test ')));
  assert.equal(existing.events.length, 4);
  const missing = h.run(guard, 'missing');
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual(
    missing.events.filter((line) => line.includes(' install ')),
    h.stores.map((path) => `sudo -n install -d -m 0700 ${path}`),
  );
  for (const path of h.stores) {
    const index = missing.events.indexOf(`sudo -n install -d -m 0700 ${path}`);
    assert.deepEqual(missing.events.slice(index - 2, index), [
      `sudo -n test ! -e ${path}`,
      `sudo -n test ! -L ${path}`,
    ]);
  }
});

test('bootstrap refuses symlinks and unknown privileged metadata without installing anything', (t) => {
  const h = fixture(t);
  for (const failure of ['symlink', 'dangling-link', 'denied', 'link-denied']) {
    const result = h.run(guard, failure);
    assert.equal(result.status, 1, failure);
    assert.match(result.stderr, /unsafe or its metadata/u);
    assert.ok(
      result.events.every((line) => line.startsWith('sudo -n test ')),
      failure,
    );
  }
});
