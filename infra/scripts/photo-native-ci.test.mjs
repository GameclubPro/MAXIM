import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { isolatedCompose, assertCgroupLimits } = require('./photo-native-ci-fixture.cjs');
const { isReviewedPhotoNativeSandboxConfig } = require('./photo-native-runtime-boundary.cjs');
const root = resolve(import.meta.dirname, '../..');
const image = `maxim-api:${'a'.repeat(40)}`;

test('CI extracts the real production sandbox and passes the unchanged strict inspector', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'maxim-photo-ci-config-'));
  try {
    const source = readFileSync(join(root, 'infra/docker-compose.yml'), 'utf8');
    const file = join(temporary, 'compose.yml');
    writeFileSync(file, isolatedCompose(source, image, 'test-owned'));
    const result = spawnSync(
      'docker',
      [
        'compose',
        '--env-file',
        '/dev/null',
        '-p',
        'infra',
        '-f',
        file,
        'config',
        '--format',
        'json',
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, MAXIM_API_IMAGE: image },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(isReviewedPhotoNativeSandboxConfig(config), true);
    assert.deepEqual(Object.keys(config.services).sort(), [
      'api-moderation-background',
      'photo-native-sandbox',
    ]);
    assert.equal(config.services['photo-native-sandbox'].image, image);
    assert.equal(
      config.services['photo-native-sandbox'].labels['com.maxim.photo-native-ci'],
      'test-owned',
    );
    assert.equal(config.volumes.photo_native_ipc.external, true);
    assert.equal(config.services['photo-native-sandbox'].env_file, undefined);
    config.services['photo-native-sandbox'].network_mode = 'bridge';
    assert.equal(isReviewedPhotoNativeSandboxConfig(config), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

const cgroups = {
  '/sys/fs/cgroup/memory.max': '1073741824',
  '/sys/fs/cgroup/pids.max': '64',
  '/sys/fs/cgroup/cpu.max': '100000 100000',
  '/proc/self/status': 'Uid:\t1000\t1000\t1000\t1000\nNoNewPrivs:\t1\nCapEff:\t0000000000000000',
};
test('live cgroup assertion rejects missing limits and elevated process authority', () => {
  assert.doesNotThrow(() => assertCgroupLimits((key) => cgroups[key]));
  for (const [field, value] of [
    ['/sys/fs/cgroup/memory.max', 'max'],
    ['/sys/fs/cgroup/pids.max', 'max'],
    ['/sys/fs/cgroup/cpu.max', 'max 100000'],
    ['/sys/fs/cgroup/cpu.max', '200000 100000'],
    ['/proc/self/status', cgroups['/proc/self/status'].replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0')],
    [
      '/proc/self/status',
      cgroups['/proc/self/status'].replace('0000000000000000', '0000000000000001'),
    ],
    [
      '/proc/self/status',
      cgroups['/proc/self/status'].replace('1000\t1000\t1000\t1000', '0\t0\t0\t0'),
    ],
  ]) {
    assert.throws(() => assertCgroupLimits((key) => (key === field ? value : cgroups[key])));
  }
});

test('container smoke refuses execution outside its exact GitHub Actions image scope', () => {
  for (const overrides of [
    { GITHUB_ACTIONS: 'false', GITHUB_SHA: 'a'.repeat(40) },
    { GITHUB_ACTIONS: 'true', GITHUB_SHA: 'b'.repeat(40) },
  ]) {
    const result = spawnSync('bash', ['infra/scripts/smoke-photo-native-ci.sh', image], {
      cwd: root,
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, ...overrides },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /exact GitHub Actions image/u);
  }
});

test('stdin execution used inside the canonical container actually evaluates the fixture', () => {
  const result = spawnSync(process.execPath, ['-', 'unknown-operation'], {
    input: readFileSync(join(root, 'infra/scripts/photo-native-ci-fixture.cjs'), 'utf8'),
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Photo native CI fixture failed/u);
});

test('outer timeout terminates a blocked Docker CLI and runs owned cleanup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-photo-ci-timeout-'));
  let childPid;
  try {
    const source = readFileSync(join(root, 'infra/scripts/smoke-photo-native-ci.sh'), 'utf8');
    // Exercise the real script and trap with a shortened deadline, without a daemon.
    const script = join(directory, 'smoke.sh');
    assert.equal(source.split('--kill-after=8s 110s').length, 2);
    writeFileSync(script, source.replace('--kill-after=8s 110s', '--kill-after=2s 1s'));
    writeFileSync(
      join(directory, 'docker'),
      `#!/usr/bin/env bash
case "$1" in
  context) echo 'unix:///var/run/docker.sock' ;;
  image)
    case "$*" in
      *Config.Labels*) echo "$GITHUB_SHA" ;;
      *) echo 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ;;
    esac ;;
  info)
    echo "$$" > "$PHOTO_TIMEOUT_TEST_DIR/child.pid"
    exec sleep 30 ;;
  ps)
    echo cleanup > "$PHOTO_TIMEOUT_TEST_DIR/cleanup-ran" ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = spawnSync('bash', [script, image], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: 'a'.repeat(40),
        DOCKER_HOST: '',
        DOCKER_CONTEXT: '',
        PHOTO_TIMEOUT_TEST_DIR: directory,
        TMPDIR: directory,
      },
    });
    childPid = Number(readFileSync(join(directory, 'child.pid'), 'utf8'));
    assert.equal(result.status, 124, result.stderr);
    assert.equal(existsSync(join(directory, 'cleanup-ran')), true);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally {
    // Clean up only the exact synthetic process if the regression itself fails.
    const marker = join(directory, 'child.pid');
    if (!childPid && existsSync(marker)) childPid = Number(readFileSync(marker, 'utf8'));
    if (Number.isSafeInteger(childPid) && childPid > 1) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // Best-effort fallback must preserve the original test failure.
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
