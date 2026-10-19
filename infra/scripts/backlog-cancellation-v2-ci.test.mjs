import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  backlogCancellationCiCompose,
  backlogCancellationCiScripts,
} from './backlog-cancellation-v2-ci-fixture.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40);
const image = `maxim-api:${sha}`;
const smoke = resolve(root, 'infra/scripts/smoke-backlog-cancellation-v2-ci.sh');
const owner = `backlog-v2-ci-${'b'.repeat(32)}`;

test('v2 fixture preserves real native boundaries, all14 role identities and store-only internal networking', () => {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env.example',
      '-f',
      'infra/docker-compose.yml',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, MAXIM_COMPOSE_SERVICE_ENV_FILE: resolve(root, '.env.example') },
    },
  );
  // FLAG: Compose stdout includes a disposable password and must stay private.
  assert.equal(result.error, undefined, 'Effective native Compose parser failed');
  assert.equal(result.signal, null, 'Effective native Compose parser was interrupted');
  assert.equal(result.status, 0, 'Effective native Compose parser refused');
  const native = JSON.parse(result.stdout).services;
  const config = backlogCancellationCiCompose(image, sha, owner, 'c'.repeat(32), native);
  assert.equal(Object.keys(config.services).length, 18);
  assert.equal(config.networks.default.name, 'infra_default');
  assert.equal(config.networks.default.internal, true);
  assert.equal(config.services.postgres.tmpfs[0], '/var/lib/postgresql/data:rw,nosuid,size=512m');
  for (const name of LEGACY_COLD_API_SERVICES) {
    const service = config.services[name];
    assert.equal(service.image, image);
    assert.equal(service.restart, 'unless-stopped');
    assert.equal(service.environment.APP_SERVICE_NAME, name);
    assert.equal(
      service.environment.APP_ROLE,
      name.startsWith('api-moderation') || name === 'api-media-analysis'
        ? 'moderation'
        : name.slice(4),
    );
    assert.deepEqual(service.command, ['node', '-e', 'setInterval(() => {}, 1000)']);
    assert.doesNotMatch(JSON.stringify(service.environment), /TOKEN|SECRET|https?:/u);
  }
  for (const name of ['ocr-native-sandbox', 'photo-native-sandbox']) {
    const actual = config.services[name];
    const ignored = new Set(['image', 'labels', 'build', 'deploy', 'logging', 'networks']);
    const boundary = Object.fromEntries(
      Object.entries(native[name]).filter(([key]) => !ignored.has(key)),
    );
    assert.deepEqual(
      Object.fromEntries(Object.keys(boundary).map((key) => [key, actual[key]])),
      boundary,
    );
    assert.equal(actual.network_mode, 'none');
    assert.equal(actual.user, '1000:1000');
    assert.equal(actual.cpus, 1);
    assert.equal(actual.mem_limit, '1073741824');
    assert.equal(actual.labels['org.opencontainers.image.revision'], sha);
    assert.equal(actual.labels['com.maxim.backlog-v2-ci'], owner);
    assert.equal(actual.image, image);
  }
  for (const service of Object.values(config.services)) assert.equal(service.ports, undefined);
});

test('v2 generated installed-image data clients parse and keep diagnostics free of source/errors', () => {
  for (const [name, source] of Object.entries(backlogCancellationCiScripts)) {
    assert.doesNotThrow(() => new vm.Script(source, { filename: name }));
    assert.match(source, /finally\{await redis\.quit\(\);await db\.\$disconnect\(\)/u);
    assert.match(source, /catch\(\(\)=>\{process\.stderr\.write\('CI_STORE_CLIENT_FAILED\\n'\)/u);
    assert.doesNotMatch(source, /MAX_BOT_TOKEN|fetch\(|https?:\/\//u);
  }
  assert.match(backlogCancellationCiScripts.seedCode, /businessStartedAt:at/u);
  assert.match(backlogCancellationCiScripts.seedCode, /moderationSource:\{version:1/u);
});

test('v2 CI smoke rejects non-CI, wrong SHA and remote Docker before any Docker call', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-backlog-v2-ci-scope-'));
  try {
    const binary = join(directory, 'docker');
    writeFileSync(binary, '#!/usr/bin/env bash\necho UNEXPECTED_DOCKER_ACCESS >&2\nexit 99\n');
    chmodSync(binary, 0o755);
    for (const scope of [
      { GITHUB_ACTIONS: 'false', GITHUB_SHA: sha, DOCKER_HOST: '', DOCKER_CONTEXT: '' },
      { GITHUB_ACTIONS: 'true', GITHUB_SHA: 'b'.repeat(40), DOCKER_HOST: '', DOCKER_CONTEXT: '' },
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: sha,
        DOCKER_HOST: 'tcp://remote.example:2375',
        DOCKER_CONTEXT: '',
      },
      { GITHUB_ACTIONS: 'true', GITHUB_SHA: sha, DOCKER_HOST: '', DOCKER_CONTEXT: 'remote' },
    ]) {
      const result = spawnSync('bash', [smoke, '--bounded', image], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, ...scope, PATH: `${directory}:${process.env.PATH}` },
      });
      assert.equal(result.status, 2);
      assert.doesNotMatch(result.stderr, /UNEXPECTED_DOCKER_ACCESS/u);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v2 rootful Docker gate runs bounded full-schema helpers before immutable image packaging', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const lane = workflow.slice(workflow.indexOf('  docker:'));
  const position = lane.indexOf(
    'run: bash infra/scripts/smoke-backlog-cancellation-v2-ci.sh "$IMAGE_REF"',
  );
  assert(position > lane.indexOf('docker buildx build --load'));
  assert(position < lane.indexOf('name: Package immutable production image'));
  const wrapper = readFileSync(smoke, 'utf8');
  assert.match(wrapper, /timeout --kill-after=45s 600s/u);
  assert.match(wrapper, /info\.MemoryLimit!==true/u);
  assert.match(wrapper, /info\.CpuCfsQuota!==true/u);
  assert.match(wrapper, /includes\("rootless"\)/u);
  const fixture = readFileSync(
    join(root, 'infra/scripts/backlog-cancellation-v2-ci-fixture.mjs'),
    'utf8',
  );
  assert.match(fixture, /'migrate',\s*'deploy'/u);
  assert.doesNotMatch(fixture, /20260925103000_multibot_preparation_state/u);
  assert.match(fixture, /productionHttpAcceptance: false/u);
  assert.match(fixture, /CI_INJECTED_BEFORE_WRITER_LAUNCH/u);
});
