import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { buildReleaseManifest } from './release-manifest.mjs';
import {
  buildReleaseImageReclaimPlan,
  isImmutableMaximReleaseRef,
  parseReclaimCutoff,
  readRetainedReleaseImages,
} from './release-image-reclaim.mjs';

const helperPath = resolve(import.meta.dirname, 'release-image-reclaim.mjs');
const gitSha = (digit) => digit.repeat(40);
const imageId = (digit) => `sha256:${digit.repeat(64)}`;
const containerId = (digit) => digit.repeat(64);

test('selects only old unused immutable release images outside retained inventory', () => {
  const cutoffMs = Date.parse('2026-07-12T00:00:00.000Z');
  const old = '2026-07-01T00:00:00.000Z';
  const recent = '2026-07-18T00:00:00.000Z';
  const images = [
    image('a', old, [`maxim-api:${gitSha('a')}`]),
    image('b', old, [`maxim-admin:${gitSha('b')}`]),
    image('c', old, [`maxim-miniapp-major:${gitSha('c')}`]),
    image('d', old, ['postgres:16']),
    image('e', old, [`maxim-api:${gitSha('e')}`, 'local-api:debug']),
    image('f', recent, [`maxim-admin:${gitSha('f')}`]),
    image('1', old, [`maxim-api:${gitSha('1')}`], ['registry/maxim-api@sha256:abc']),
  ];

  const plan = buildReleaseImageReclaimPlan({
    images,
    retainedImageIds: [imageId('a')],
    retainedImageRefs: [],
    containerImageIds: [imageId('b')],
    cutoffMs,
  });

  assert.deepEqual(plan, [
    {
      id: imageId('c'),
      createdAt: old,
      refs: [`maxim-miniapp-major:${gitSha('c')}`],
    },
  ]);
});

test('accepts only full-SHA release refs and parses Docker cutoff forms', () => {
  assert.equal(isImmutableMaximReleaseRef(`maxim-api:${gitSha('a')}`), true);
  assert.equal(isImmutableMaximReleaseRef(`maxim-api:runtime-rollback-${gitSha('b')}`), true);
  assert.equal(isImmutableMaximReleaseRef('maxim-api:latest'), false);
  assert.equal(isImmutableMaximReleaseRef(`registry/maxim-api:${gitSha('a')}`), false);
  assert.equal(
    parseReclaimCutoff('2h30m', Date.parse('2026-07-19T12:00:00.000Z')),
    Date.parse('2026-07-19T09:30:00.000Z'),
  );
  assert.equal(parseReclaimCutoff('2026-07-01T00:00:00Z'), Date.parse('2026-07-01T00:00:00Z'));
  assert.throws(() => parseReclaimCutoff('7d'), /Invalid reclaim cutoff/u);
});

test('validates every retained manifest before returning its image allowlist', () => {
  const stateDir = createReleaseState('a');
  const retained = readRetainedReleaseImages(stateDir);
  assert.deepEqual(retained.imageIds, [imageId('a')]);
  assert.deepEqual(retained.imageRefs, [`maxim-api:${gitSha('a')}`]);

  writeFileSync(join(stateDir, 'releases', 'broken.json'), '{bad json\n');
  assert.throws(() => readRetainedReleaseImages(stateDir), /Invalid retained release manifest/u);
});

test('CLI preserves retained unlabeled and container images while removing stale protected releases', () => {
  const root = mkdtempSync(join(tmpdir(), 'maxim-release-reclaim-cli-'));
  const stateDir = createReleaseState('a', root);
  const logPath = join(root, 'docker-log.jsonl');
  const fakeDocker = createFakeDocker(root, {
    images: [
      dockerImage('a', `maxim-api:${gitSha('a')}`),
      dockerImage('b', `maxim-miniapp-major:${gitSha('b')}`, {
        'com.maxim.release-protected': 'true',
      }),
      dockerImage('c', `maxim-admin:${gitSha('c')}`, {
        'com.maxim.release-protected': 'true',
      }),
      dockerImage('d', 'postgres:16'),
    ],
    containers: [{ Id: containerId('c'), Image: imageId('c') }],
  });

  execFileSync(
    process.execPath,
    [helperPath, 'reclaim', '--state-dir', stateDir, '--until', '1h'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeDocker.binDir}:${process.env.PATH}`,
        FAKE_DOCKER_FIXTURE: fakeDocker.fixturePath,
        FAKE_DOCKER_LOG: logPath,
      },
    },
  );

  const calls = readJsonLines(logPath);
  assert.deepEqual(calls, [['image', 'rm', `maxim-miniapp-major:${gitSha('b')}`]]);
});

test('CLI fails closed before Docker mutation when any retained manifest is malformed', () => {
  const root = mkdtempSync(join(tmpdir(), 'maxim-release-reclaim-invalid-'));
  const stateDir = createReleaseState('a', root);
  const logPath = join(root, 'docker-log.jsonl');
  writeFileSync(join(stateDir, 'releases', 'broken.json'), '{bad json\n');
  const fakeDocker = createFakeDocker(root, {
    images: [dockerImage('b', `maxim-miniapp-major:${gitSha('b')}`)],
    containers: [],
  });

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [helperPath, 'reclaim', '--state-dir', stateDir, '--until', '1h'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${fakeDocker.binDir}:${process.env.PATH}`,
            FAKE_DOCKER_FIXTURE: fakeDocker.fixturePath,
            FAKE_DOCKER_LOG: logPath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    /Invalid retained release manifest/u,
  );
  assert.equal(existsSync(logPath), false);
});

function image(digit, createdAt, repoTags, repoDigests = []) {
  return { id: imageId(digit), createdAt, repoTags, repoDigests };
}

function dockerImage(digit, ref, labels = {}) {
  return {
    Id: imageId(digit),
    Created: '2020-01-01T00:00:00.000Z',
    RepoTags: [ref],
    RepoDigests: [],
    Config: { Labels: labels },
  };
}

function createReleaseState(digit, root = mkdtempSync(join(tmpdir(), 'maxim-release-state-'))) {
  const stateDir = join(root, 'state');
  const releasesDir = join(stateDir, 'releases');
  mkdirSync(releasesDir, { recursive: true });
  const manifest = buildReleaseManifest({
    releaseId: 'release-retained',
    targetSha: gitSha(digit),
    components: [
      {
        id: 'api-shared',
        sourceSha: gitSha(digit),
        imageRef: `maxim-api:${gitSha(digit)}`,
        imageId: imageId(digit),
      },
    ],
    createdAt: '2026-07-01T00:00:00.000Z',
  });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(stateDir, 'current.json'), serialized);
  writeFileSync(join(releasesDir, 'release-retained.json'), serialized);
  return stateDir;
}

function createFakeDocker(root, fixture) {
  const binDir = join(root, 'bin');
  const fixturePath = join(root, 'docker-fixture.json');
  const dockerPath = join(binDir, 'docker');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(fixturePath, JSON.stringify(fixture));
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(process.env.FAKE_DOCKER_FIXTURE, 'utf8'));
const ids = (items) => items.map((item) => JSON.stringify(item.Id)).join('\\n') + (items.length ? '\\n' : '');
if (args[0] === 'image' && args[1] === 'ls') process.stdout.write(ids(fixture.images));
else if (args[0] === 'container' && args[1] === 'ls') process.stdout.write(ids(fixture.containers));
else if (args[0] === 'image' && args[1] === 'inspect') process.stdout.write(JSON.stringify(fixture.images.filter((item) => args.includes(item.Id))));
else if (args[0] === 'container' && args[1] === 'inspect') process.stdout.write(JSON.stringify(fixture.containers.filter((item) => args.includes(item.Id))));
else if (args[0] === 'image' && args[1] === 'rm') appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
else { process.stderr.write('unexpected fake docker call: ' + args.join(' ') + '\\n'); process.exitCode = 2; }
`,
  );
  chmodSync(dockerPath, 0o755);
  return { binDir, fixturePath };
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
