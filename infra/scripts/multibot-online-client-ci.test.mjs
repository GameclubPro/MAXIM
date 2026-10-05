import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { writeOnlineClientCiCompose } from './multibot-online-client-ci-fixture.mjs';
import { verifyMultibotOnlineClientConfiguration } from './multibot-online-client.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40);
const image = `maxim-api:${sha}`;
const smoke = resolve(root, 'infra/scripts/smoke-multibot-online-client-ci.sh');

test('CI migration Compose uses its effective private overlay, isolated non-infra project and internal network', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-online-client-ci-'));
  try {
    const project = `multibot_ci_${'b'.repeat(32)}`;
    const args = writeOnlineClientCiCompose(directory, project, image, 'fixture-owner');
    const result = spawnSync('docker', ['compose', ...args, 'config', '--format', 'json'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    const identity = verifyMultibotOnlineClientConfiguration(config, args, sha);
    assert.equal(identity.project, project);
    assert.equal(identity.networkName, `${project}_default`);
    assert.equal(config.networks.default.internal, true);
    assert.equal(
      config.services.postgres.environment.POSTGRES_PASSWORD,
      new URL(identity.databaseUrl).password,
    );
    assert.notEqual(new URL(identity.databaseUrl).password, 'invalid');
    assert.deepEqual(Object.keys(config.services).sort(), ['api-ingress', 'postgres']);
    assert.equal(config.services.postgres.ports, undefined);
    assert.equal(statSync(resolve(directory, 'ci.env')).mode & 0o777, 0o600);
    assert.equal(statSync(resolve(directory, 'compose.json')).mode & 0o777, 0o600);
    assert.equal(statSync(resolve(directory, 'overlay.json')).mode & 0o777, 0o600);
    const wrongContext = [
      '--env-file',
      resolve(directory, 'ci.env'),
      '-p',
      'infra',
      '-f',
      resolve(directory, 'compose.json'),
      '-f',
      resolve(directory, 'overlay.json'),
    ];
    assert.throws(
      () => verifyMultibotOnlineClientConfiguration(config, wrongContext, sha),
      /CONFIGURATION_INVALID/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CI migration smoke rejects non-CI, wrong image SHA and remote Docker selectors before Docker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-online-client-scope-'));
  try {
    const binary = resolve(directory, 'docker');
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

test('API image CI runs bounded migration client verification before image publication with Node24', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const dockerLane = workflow.slice(workflow.indexOf('  docker:'));
  assert.match(dockerLane, /timeout-minutes: 25/u);
  assert.match(
    dockerLane,
    /actions\/setup-node@[a-f0-9]{40}[^]*if: matrix\.component == 'api'[^]*node-version-file: \.nvmrc/u,
  );
  const smokePosition = dockerLane.indexOf(
    'run: bash infra/scripts/smoke-multibot-online-client-ci.sh "$IMAGE_REF"',
  );
  assert(smokePosition > dockerLane.indexOf('docker buildx build --load'));
  assert(smokePosition < dockerLane.indexOf('name: Package immutable production image'));
  assert.match(readFileSync(smoke, 'utf8'), /timeout --kill-after=8s 180s/u);
});
