import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
const start = connector.indexOf('prepend_deploy_ready_timeout_env() {');
const end = connector.indexOf('\nprepend_deploy_disk_floor_env() {', start);
assert.ok(start >= 0 && end > start);
const helper = connector.slice(start, end);

function forward(timeout) {
  return spawnSync(
    'bash',
    [
      '-c',
      `${helper}\ncommand='deploy main'\nprepend_deploy_ready_timeout_env command || exit $?\nprintf '%s' "$command"`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_API_READY_TIMEOUT_SEC_FROM_CALLER: timeout },
    },
  );
}

test('forwards an explicit bounded readiness timeout while preserving the remote default', () => {
  for (const timeout of ['180', '900', '3600']) {
    const result = forward(timeout);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `MAXIM_DEPLOY_API_READY_TIMEOUT_SEC=${timeout} deploy main`);
  }
  assert.equal(forward('').stdout, 'deploy main');
  assert.ok(
    connector.indexOf('DEPLOY_API_READY_TIMEOUT_SEC_FROM_CALLER=') <
      connector.indexOf('source "$ENV_FILE"'),
  );
  const deploy = connector.slice(
    connector.indexOf('deploy_main() {'),
    connector.indexOf('\nfinalize_release_recovery() {'),
  );
  assert.match(deploy, /prepend_deploy_ready_timeout_env remote_command/u);
});

test('rejects out of range and executable timeout values before SSH', () => {
  for (const timeout of ['0', '179', '3601', '0180', '1; id', '$(id)', '180\n900']) {
    const result = forward(timeout);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /must be an integer between 180 and 3600/u);
  }
});
