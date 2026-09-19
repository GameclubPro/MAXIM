import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(root, 'infra/scripts/lib/deploy-git-transport.sh');
function probe(body, env = {}) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
source "$1"
git() {
  case "$1 $2" in
    'remote get-url') printf '%s' "$TEST_ORIGIN" ;;
    'config --get') printf '%s' "$TEST_SSH_COMMAND" ;;
    *) return 1 ;;
  esac
}
${body}`,
      'transport-test',
      helper,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_SSH_COMMAND: '',
        GIT_SSH: '',
        GIT_SSH_VARIANT: '',
        TEST_ORIGIN: 'git@github.com:example/repo.git',
        TEST_SSH_COMMAND: "ssh -i '/private/deploy identity' -o IdentitiesOnly=yes",
        ...env,
      },
    },
  );
}

test('443 transport preserves the configured deploy identity and enforces noninteractive host verification', () => {
  const result = probe('maxim_configure_git_ssh_transport 443\nprintf "%s" "$GIT_SSH_COMMAND"');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith("ssh -i '/private/deploy identity' -o IdentitiesOnly=yes "));
  for (const flag of [
    'HostName=ssh.github.com',
    'HostKeyAlias=github.com',
    '-p 443',
    'ConnectTimeout=10',
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
  ])
    assert.ok(result.stdout.includes(flag), flag);
});

test('caller SSH command takes precedence and default mode is unchanged', () => {
  const env = { GIT_SSH_COMMAND: 'ssh -i /caller/identity' };
  const selected = probe(
    'maxim_configure_git_ssh_transport 22\nprintf "%s" "$GIT_SSH_COMMAND"',
    env,
  );
  assert.equal(selected.status, 0, selected.stderr);
  assert.ok(selected.stdout.startsWith(`${env.GIT_SSH_COMMAND} `));
  assert.match(selected.stdout, /HostName=github\.com.*-p 22/u);
  const unchanged = probe(
    'maxim_configure_git_ssh_transport default\nprintf "%s" "$GIT_SSH_COMMAND"',
    env,
  );
  assert.equal(unchanged.stdout, env.GIT_SSH_COMMAND);
});

test('rejects invalid ports and non-GitHub/non-SSH origins without exposing their contents', () => {
  for (const port of ['444', '443;false']) {
    const result = probe('maxim_configure_git_ssh_transport "$TEST_PORT"', { TEST_PORT: port });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  for (const origin of [
    'https://github.com/example/repo.git',
    'git@elsewhere.invalid:example/repo.git',
  ]) {
    const result = probe('maxim_configure_git_ssh_transport 443', { TEST_ORIGIN: origin });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(origin));
  }
});

test('transport bootstrap works before the VPS has the new helper file', () => {
  const result = probe(`remote_command='printf "%s" "$GIT_SSH_COMMAND"'
maxim_prepend_git_ssh_transport remote_command 443
export -f git
bash -c "$remote_command"`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deploy identity.*HostName=ssh.github.com/u);
});

test('ordinary deploy retains exact-SHA CI before selecting remote transport', () => {
  const wrapper = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
  const deploy = wrapper.slice(
    wrapper.indexOf('deploy_main() {'),
    wrapper.indexOf('\nfinalize_release_recovery()'),
  );
  assert.ok(
    deploy.indexOf('node scripts/ci/assert-green.mjs') <
      deploy.indexOf('maxim_prepend_git_ssh_transport'),
  );
  assert.match(deploy, /MAXIM_EXPECTED_DEPLOY_SHA/u);
  assert.match(deploy, /maxim_prepend_git_ssh_transport remote_command/u);
  assert.equal(deploy.match(/remote_exec /gu)?.length, 1);
});
