import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(import.meta.dirname, 'publisher-dispatch-rollout-control.cjs');
const rollout = readFileSync(
  resolve(import.meta.dirname, 'vps-publisher-dispatch-rollout.sh'),
  'utf8',
);
const containerId = 'a'.repeat(64);
const imageId = `sha256:${'b'.repeat(64)}`;

function functionBlock(name) {
  const start = rollout.indexOf(`${name}() {`);
  assert.notEqual(start, -1);
  return rollout.slice(start, rollout.indexOf('\n}', start) + 2);
}

function runControl(
  t,
  { mode = 'running', output = 'valid', command = 'disable', action = 'arm' } = {},
) {
  const directory = mkdtempSync(resolve(tmpdir(), 'publisher-control-transport-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const redisModule = resolve(directory, 'node_modules/ioredis');
  mkdirSync(redisModule, { recursive: true });
  writeFileSync(
    resolve(redisModule, 'index.js'),
    `const fs = require('node:fs');
const file = process.env.FIXTURE_MARKER;
module.exports = class Redis {
  status = 'wait';
  on() {}
  async connect() { this.status = 'ready'; }
  async get() { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; }
  async set(key, value) {
    if (fs.existsSync(file)) return null;
    fs.writeFileSync(file, value);
    return 'OK';
  }
  async eval(script, count, key, owner) {
    if (!fs.existsSync(file)) return 0;
    if (JSON.parse(fs.readFileSync(file, 'utf8')).ownerToken !== owner) return 0;
    fs.unlinkSync(file);
    return 1;
  }
  async quit() { this.status = 'end'; }
  disconnect() { this.status = 'end'; }
};
`,
  );
  const dockerPath = resolve(directory, 'docker.cjs');
  writeFileSync(
    dockerPath,
    String.raw`const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const env = process.env;
if (args[0] === 'compose' && args.includes('ps')) {
  process.stdout.write(env.FIXTURE_MODE === 'duplicate' ? '${containerId}\n${containerId}\n' : '${containerId}\n');
} else if (args[0] === 'inspect') {
  if (args[2].includes('.Config.Env')) {
    process.stdout.write('APP_SERVICE_NAME=api-admin\nAPP_ROLE=' + (env.FIXTURE_MODE === 'wrong-role' ? 'action' : 'admin') + '\nMAX_PUBLISHER_DISPATCH_ENABLED=true\n');
  } else {
    process.stdout.write((env.FIXTURE_MODE === 'wrong-image' ? 'sha256:wrong' : '${imageId}') + ' ' + (env.FIXTURE_MODE === 'stopped' ? 'false' : 'true') + ' infra api-admin');
  }
} else {
  const recovery = args[0] === 'compose' && args.includes('run');
  assert.ok(recovery || args[0] === 'exec');
  const input = fs.readFileSync(0);
  if (recovery) {
    assert.equal(input.length, 0, 'Compose must not consume helper source as prompt input');
    for (const required of ['--rm', '--no-deps', '--pull', 'never', '-T', '--interactive=false', 'api-action']) assert.ok(args.includes(required));
    assert.ok(!args.includes('--yes'));
    process.stdout.write('Volume infra_redis differs. Recreate (data will be lost)? [y/N] ');
  } else {
    assert.ok(args.includes('${containerId}'), 'exec must target the inspected ID');
    assert.ok(input.length > 0);
  }
  fs.appendFileSync(env.FIXTURE_CALLS, recovery ? 'run\n' : 'exec\n');
  const nodeIndex = args.indexOf('node');
  assert.ok(nodeIndex >= 0);
  const childEnv = { ...env, REDIS_URL: 'redis://fixture.invalid' };
  for (let index = 0; index < nodeIndex; index += 1) {
    if (args[index] !== '-e') continue;
    const assignment = args[++index];
    const split = assignment.indexOf('=');
    childEnv[assignment.slice(0, split)] = assignment.slice(split + 1);
  }
  const child = spawnSync(process.execPath, args.slice(nodeIndex + 1), {
    cwd: env.FIXTURE_DIRECTORY, env: childEnv, input, encoding: 'utf8',
  });
  process.stderr.write(child.stderr);
  if (child.status !== 0) process.exit(child.status ?? 1);
  const output = args.at(-1) === 'clear' ? env.FIXTURE_OUTPUT.replace('clear-', '') : env.FIXTURE_OUTPUT;
  if (output === 'lost') process.exit(124);
  if (output === 'malformed') process.stdout.write('{"result":"acquired","pauseKind":"operator"}');
  else process.stdout.write(child.stdout);
}
`,
  );
  const script = `set -euo pipefail
${[
  'fail',
  'container_env_summary',
  'publisher_control_admin_id',
  'publisher_control',
  'control_field',
  'arm_operator_pause',
  'clear_operator_pause',
  'cleanup',
]
  .map(functionBlock)
  .join('\n')}
timeout() { shift 3; "$@"; }
docker() { node "$FIXTURE_DOCKER" "$@"; }
maxim_webhook_rollout_warn_if_paused() { :; }
maxim_require_ordinary_effect_authority() { :; }
release_deploy_lock() { :; }
COMPOSE_FILES=()
COMMAND_TIMEOUT_SEC=30
APPLY=1
OPERATOR_OWNER_TOKEN='publisher-rollout:${'c'.repeat(64)}'
OPERATOR_PAUSE_ARMED=0
OPERATOR_PAUSE_UNCERTAIN=0
ROLLOUT_COMPLETE=0
PREVIEW_ENV_FILE=''
trap cleanup EXIT
${
  action.startsWith('legacy-')
    ? `unset MAXIM_PUBLISHER_CONTROL_NONCE
docker exec -i -e MAX_PUBLISHER_BOT_ID=se14088825_bot '${containerId}' node - '${action.slice(7)}' <"$CONTROL_HELPER"`
    : action === 'arm'
      ? 'arm_operator_pause'
      : 'arm_operator_pause\nclear_operator_pause'
}
printf 'confirmed=%s uncertain=%s\n' "$OPERATOR_PAUSE_ARMED" "$OPERATOR_PAUSE_UNCERTAIN"
`;
  const markerPath = resolve(directory, 'marker.json');
  const callsPath = resolve(directory, 'calls.txt');
  const result = spawnSync('bash', ['-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ROOT_DIR: root,
      CONTROL_HELPER: helper,
      STATE_HELPER: resolve(import.meta.dirname, 'publisher-dispatch-rollout-state.mjs'),
      MANIFEST_IMAGE_ID: imageId,
      COMMAND: command,
      FIXTURE_DIRECTORY: directory,
      FIXTURE_DOCKER: dockerPath,
      FIXTURE_MARKER: markerPath,
      FIXTURE_CALLS: callsPath,
      FIXTURE_MODE: mode,
      FIXTURE_OUTPUT: output,
    },
  });
  return {
    ...result,
    marker: existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null,
    calls: existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n') : [],
  };
}

test('runs control in the exact live admin without a Compose create path', (t) => {
  const result = runControl(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['exec']);
  assert.equal(result.marker.reason, 'operator_rollout');
  assert.match(result.stdout, /confirmed=1 uncertain=0/u);
});

test('stopped-admin recovery declines volume prompts and validates the helper frame', (t) => {
  const result = runControl(t, { mode: 'stopped', action: 'arm-and-clear' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['run', 'run']);
  assert.equal(result.marker, null);
  assert.match(result.stdout, /confirmed=0 uncertain=0/u);
  assert.doesNotMatch(result.stdout, /Recreate/u);
});

test('lost or malformed acquisition acknowledgements cannot hide a Redis pause or trigger retry', (t) => {
  for (const mode of ['running', 'stopped']) {
    for (const output of ['lost', 'malformed']) {
      const result = runControl(t, { mode, output });
      assert.equal(result.status, 1, `${mode}/${output}: ${result.stderr}`);
      assert.equal(result.marker.reason, 'operator_rollout');
      assert.equal(result.calls.length, 1);
      assert.match(result.stderr, /operator pause could not be confirmed/u);
      assert.match(result.stderr, /publisher-dispatch-disable --apply/u);
      assert.doesNotMatch(result.stderr, /operator pause remains armed/u);
      assert.doesNotMatch(result.stdout, /operator pause armed/u);
    }
  }
});

test('identity drift and stopped enable fail before issuing any Redis mutation', (t) => {
  for (const mode of ['wrong-image', 'wrong-role', 'duplicate', 'stopped']) {
    const result = runControl(t, { mode, command: 'enable' });
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.equal(result.marker, null);
    assert.deepEqual(result.calls, []);
  }
});

test('a lost clear acknowledgement reports uncertainty instead of asserting the pause survived', (t) => {
  for (const output of ['clear-lost', 'clear-malformed']) {
    const result = runControl(t, { output, action: 'arm-and-clear' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.marker, null);
    assert.deepEqual(result.calls, ['exec', 'exec']);
    assert.match(result.stderr, /operator pause could not be confirmed/u);
    assert.doesNotMatch(result.stderr, /operator pause remains armed/u);
    assert.doesNotMatch(result.stdout, /operator pause released/u);
  }
});

test('preserves the existing read-only monitor JSON while rejecting mutations without a nonce', (t) => {
  const status = runControl(t, { action: 'legacy-status' });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout.split('\n')[0]), {
    result: 'observed',
    pauseKind: 'missing',
    heartbeatKind: 'missing',
    heartbeatEnabled: null,
  });
  assert.equal(status.marker, null);
  const mutation = runControl(t, { action: 'legacy-arm-disable' });
  assert.equal(mutation.status, 1, mutation.stderr);
  assert.equal(mutation.marker, null);
});
