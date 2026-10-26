import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deployLockEnvironment, deployLockFixture } from './test-fixtures/deploy-lock.mjs';

const source = readFileSync(new URL('./vps-apply-major-site.sh', import.meta.url), 'utf8');
const remote = source.split("<<'REMOTE'\n")[1]?.split('\nREMOTE\n')[0];
assert.ok(remote, 'Missing canonical nginx transaction');

function fixture(t, { smokeFails = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-major-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  const lock = deployLockFixture(directory, join(repo, 'infra/scripts/lib/deploy-lock.sh'));
  writeFileSync(lock.file, '', { mode: 0o600 });
  // The ordinary journal is outside this fixture; retain its real lock precondition.
  writeFileSync(
    join(repo, 'infra/scripts/lib/legacy-cold-maintenance.sh'),
    'maxim_require_ordinary_effect_authority() { require_deploy_lock; }\n',
  );
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const events = join(directory, 'events.log');
  const assertLocked = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if flock -n "$FIXTURE_LOCK_FILE" true; then',
    "  echo 'Nginx mutation or smoke ran without the protected lock.' >&2",
    '  exit 97',
    'fi',
    'printf "%s\\n" "$*" >> "$FIXTURE_EVENTS"',
  ];
  writeFileSync(
    join(bin, 'sudo'),
    [
      ...assertLocked,
      'case "$1" in',
      '  nginx|systemctl) exit 0 ;;',
      '  *) exec "$@" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'curl'),
    [
      ...assertLocked,
      'url=""',
      'for arg in "$@"; do url="$arg"; done',
      'status=200',
      'ingress=""',
      'if [[ "$FIXTURE_SMOKE_FAILS" == 1 ]]; then',
      '  status=500',
      'elif [[ "$url" == *"/api/health/live" ]]; then',
      '  ingress=webhook',
      'elif [[ "$url" == *"/api/v1/"* ]]; then',
      '  status=401',
      '  ingress=admin',
      'fi',
      'printf "HTTP/1.1 %s OK\\r\\n" "$status"',
      'printf "Strict-Transport-Security: max-age=31536000\\r\\nX-Content-Type-Options: nosniff\\r\\nReferrer-Policy: strict-origin-when-cross-origin\\r\\n"',
      'if [[ -n "$ingress" ]]; then printf "X-Maxim-Ingress: %s\\r\\n" "$ingress"; fi',
      'if [[ "$url" == *"/robots.txt" ]]; then printf "Cache-Control: public, max-age=3600\\r\\n"; fi',
      'if [[ "$url" == *"/ios-canary/ping.txt" ]]; then printf "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\\r\\n"; fi',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const stage = join(directory, 'staging');
  const paths = {
    REMOTE_STAGE_DIR: stage,
    REMOTE_CONF_TMP: join(stage, 'major.conf'),
    REMOTE_SITE_TMP: join(stage, 'site'),
    REMOTE_SNIPPET_TMP_DIR: join(stage, 'snippets'),
    REMOTE_CONF: join(directory, 'sites-available/major.conf'),
    REMOTE_ENABLED_CONF: join(directory, 'sites-enabled/major.conf'),
    REMOTE_SITE_DIR: join(directory, 'site'),
    REMOTE_BACKUP_DIR: join(directory, 'backups'),
    REMOTE_SNIPPET_DIR: join(directory, 'snippets'),
  };
  for (const name of [
    'staging/site',
    'staging/snippets',
    'sites-available',
    'sites-enabled',
    'site',
    'snippets',
  ])
    mkdirSync(join(directory, name), { recursive: true });
  writeFileSync(paths.REMOTE_CONF, 'old config');
  symlinkSync(paths.REMOTE_CONF, paths.REMOTE_ENABLED_CONF);
  writeFileSync(join(paths.REMOTE_SITE_DIR, 'index.html'), 'old index');
  writeFileSync(paths.REMOTE_CONF_TMP, 'new config');
  writeFileSync(join(paths.REMOTE_SITE_TMP, 'index.html'), 'new index');
  for (const snippet of ['karavan-sse-locations.conf', 'karavan-sse-proxy-common.conf']) {
    writeFileSync(join(paths.REMOTE_SNIPPET_DIR, snippet), 'old snippet');
    writeFileSync(join(paths.REMOTE_SNIPPET_TMP_DIR, snippet), 'new snippet');
  }
  const transaction = join(directory, 'transaction.sh');
  writeFileSync(
    transaction,
    remote
      .replace('cd /var/www/Chat_bot', 'cd "$FIXTURE_REPO"')
      .replace('LOCAL_SMOKE_MAX_ATTEMPTS=10', 'LOCAL_SMOKE_MAX_ATTEMPTS=2')
      .replace('LOCAL_SMOKE_RETRY_DELAY_SECONDS=1', 'LOCAL_SMOKE_RETRY_DELAY_SECONDS=0'),
  );
  const env = deployLockEnvironment({
    ...paths,
    PATH: bin + ':' + process.env.PATH,
    FIXTURE_EVENTS: events,
    FIXTURE_LOCK_FILE: lock.file,
    FIXTURE_REPO: repo,
    FIXTURE_SMOKE_FAILS: smokeFails ? '1' : '0',
  });
  const run = (lockBusy = false) =>
    spawnSync(
      lockBusy ? 'flock' : 'bash',
      lockBusy ? ['-n', lock.file, 'bash', transaction] : [transaction],
      { env, encoding: 'utf8', timeout: 10000 },
    );
  const assertReleased = () => {
    const result = spawnSync(
      'bash',
      ['-c', 'source "$1"; acquire_deploy_lock; release_deploy_lock', 'lock-probe', lock.helper],
      { env, encoding: 'utf8', timeout: 3000 },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  return { paths, events, lock, run, assertReleased };
}

test('canonical nginx refuses an occupied deploy lock before persistent mutation', (t) => {
  const h = fixture(t);
  const inode = statSync(h.lock.file).ino;
  const result = h.run(true);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /holds the deploy lock/u);
  assert.equal(existsSync(h.events), false);
  assert.equal(readFileSync(h.paths.REMOTE_CONF, 'utf8'), 'old config');
  assert.equal(statSync(h.lock.file).ino, inode);
  h.assertReleased();
});

test('canonical nginx holds its protected lock through reload and complete local route smoke', (t) => {
  const h = fixture(t);
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  const events = readFileSync(h.events, 'utf8');
  assert.match(events, /systemctl reload nginx/u);
  assert.match(events, /https:\/\/major-maksimov\.ru\/api\/v1\/channels\//u);
  assert.equal(readFileSync(h.paths.REMOTE_CONF, 'utf8'), 'new config');
  assert.equal(readFileSync(join(h.paths.REMOTE_SITE_DIR, 'index.html'), 'utf8'), 'new index');
  assert.equal(existsSync(h.paths.REMOTE_STAGE_DIR), false);
  h.assertReleased();
});

test('failed local route smoke restores prior config while retaining the same lock', (t) => {
  const h = fixture(t, { smokeFails: true });
  const result = h.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /rolling back/u);
  const events = readFileSync(h.events, 'utf8');
  assert.equal(events.match(/systemctl reload nginx/gu)?.length, 2);
  assert.equal(readFileSync(h.paths.REMOTE_CONF, 'utf8'), 'old config');
  assert.equal(readFileSync(join(h.paths.REMOTE_SITE_DIR, 'index.html'), 'utf8'), 'old index');
  assert.equal(existsSync(h.paths.REMOTE_STAGE_DIR), false);
  h.assertReleased();
});
