import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildReleaseManifest,
  commitReleaseManifest,
  readCurrentManifest,
  readReleaseManifest,
} from './release-manifest.mjs';

const sha = (digit) => digit.repeat(40);
const imageId = (digit) => `sha256:${digit.repeat(64)}`;

function component(id, digit) {
  return { id, sourceSha: sha(digit), imageRef: `maxim-${id}:${sha(digit)}`, imageId: imageId(digit) };
}

test('atomically records a release and merges partial component updates', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-'));
  const first = buildReleaseManifest({
    releaseId: 'release-1',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    smokes: ['api-live', 'miniapp-major'],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: first });

  const second = buildReleaseManifest({
    releaseId: 'release-2',
    targetSha: sha('b'),
    current: readCurrentManifest(stateDir),
    components: [component('admin-static', 'b')],
    smokes: ['admin-static'],
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: second });

  const current = readCurrentManifest(stateDir);
  assert.equal(current.releaseId, 'release-2');
  assert.equal(current.components['api-shared'].sourceSha, sha('a'));
  assert.equal(current.components['admin-static'].sourceSha, sha('b'));
  assert.equal(readReleaseManifest(stateDir, 'release-1').releaseId, 'release-1');
});

test('does not move current when an existing release id has different content', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-conflict-'));
  const first = buildReleaseManifest({
    releaseId: 'same-id',
    targetSha: sha('a'),
    components: [component('api-shared', 'a')],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: first });
  const before = readFileSync(join(stateDir, 'current.json'), 'utf8');
  const conflict = buildReleaseManifest({
    releaseId: 'same-id',
    targetSha: sha('b'),
    components: [component('api-shared', 'b')],
    createdAt: '2026-01-02T00:00:00.000Z',
  });

  assert.throws(() => commitReleaseManifest({ stateDir, manifest: conflict }), /different content/u);
  assert.equal(readFileSync(join(stateDir, 'current.json'), 'utf8'), before);
});

test('retains at least five release manifests', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-retain-'));
  for (let index = 0; index < 7; index += 1) {
    const digit = String(index + 1);
    const manifest = buildReleaseManifest({
      releaseId: `release-${index}`,
      targetSha: sha(digit),
      components: [component('api-shared', digit)],
      createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    });
    commitReleaseManifest({ stateDir, manifest, retain: 5 });
  }
  assert.throws(() => readReleaseManifest(stateDir, 'release-0'), /not found/u);
  assert.equal(readReleaseManifest(stateDir, 'release-6').releaseId, 'release-6');
});
