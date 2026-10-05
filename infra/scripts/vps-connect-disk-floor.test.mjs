import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
const start = connector.indexOf('prepend_deploy_disk_floor_env() {');
const end = connector.indexOf('\nrollback_entrypoint_bootstrap_source() {', start);
assert.ok(start >= 0 && end > start);
const helper = connector.slice(start, end);

function forward(minimum) {
  return spawnSync(
    'bash',
    [
      '-c',
      `${helper}\ncommand='deploy main'\nprepend_deploy_disk_floor_env command || exit $?\nprintf '%s' "$command"`,
    ],
    { encoding: 'utf8', env: { ...process.env, DEPLOY_DISK_MIN_FREE_BYTES_FROM_CALLER: minimum } },
  );
}

test('deploy forwards the caller disk reserve before SSH, preserving the remote component floor', () => {
  const raised = forward('21474836480');
  assert.equal(raised.status, 0, raised.stderr);
  assert.equal(raised.stdout, 'MAXIM_DEPLOY_DISK_MIN_FREE_BYTES=21474836480 deploy main');
  const absent = forward('');
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, 'deploy main');
  assert.ok(
    connector.indexOf('DEPLOY_DISK_MIN_FREE_BYTES_FROM_CALLER=') <
      connector.indexOf('source "$ENV_FILE"'),
  );
  const deploy = connector.slice(
    connector.indexOf('deploy_main() {'),
    connector.indexOf('\nfinalize_release_recovery() {'),
  );
  assert.match(deploy, /prepend_deploy_disk_floor_env remote_command/u);
});

test('invalid caller reserves cannot inject a remote command', () => {
  for (const minimum of ['-1', '20GiB', '1; touch /tmp/maxim-injected', '$(id)', '1\n2']) {
    const result = forward(minimum);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /must be a non-negative integer/u);
  }
});
