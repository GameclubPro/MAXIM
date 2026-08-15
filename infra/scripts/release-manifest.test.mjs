import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  archiveReleaseTransition,
  beginReleaseTransition,
  buildReleaseManifest,
  commitReleaseManifest,
  findRecoveryBaseManifest,
  readCurrentManifest,
  readRecoveryBaseManifest,
  readReleaseManifest,
  validateCompleteReleaseManifest,
} from './release-manifest.mjs';

const sha = (digit) => digit.repeat(40);
const imageId = (digit) => `sha256:${digit.repeat(64)}`;

function component(id, digit) {
  return {
    id,
    sourceSha: sha(digit),
    imageRef: `maxim-${id}:${sha(digit)}`,
    imageId: imageId(digit),
  };
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

  assert.throws(
    () => commitReleaseManifest({ stateDir, manifest: conflict }),
    /different content/u,
  );
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

test('can merge a recovery release from an explicit validated current manifest file', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-recovery-'));
  const recoveryBasePath = join(stateDir, 'current.invalid-runtime-rollback.json');
  const recoveryBase = buildReleaseManifest({
    releaseId: 'release-before-interruption',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  writeFileSync(recoveryBasePath, `${JSON.stringify(recoveryBase)}\n`);

  const nextApi = component('api-shared', 'b');
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, 'release-manifest.mjs'),
      'commit',
      '--state-dir',
      stateDir,
      '--release-id',
      'runtime-recovery',
      '--target-sha',
      sha('b'),
      '--current-manifest-file',
      recoveryBasePath,
      '--component',
      `${nextApi.id}|${nextApi.sourceSha}|${nextApi.imageRef}|${nextApi.imageId}`,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const current = readCurrentManifest(stateDir);
  assert.equal(current.components['api-shared'].sourceSha, sha('b'));
  assert.equal(current.components['miniapp-major-static'].sourceSha, sha('a'));
  assert.equal(current.components['admin-static'].sourceSha, sha('a'));
});

test('discovers exactly one complete interrupted release manifest', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-discovery-'));
  const candidatePath = join(stateDir, 'current.invalid-deploy-20260815T120000Z-123.json');
  const manifest = buildReleaseManifest({
    releaseId: 'release-before-deploy',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  writeFileSync(candidatePath, `${JSON.stringify(manifest)}\n`);
  writeFileSync(`${candidatePath}.recovered-20260815T121000Z-124`, 'ignored\n');

  assert.equal(findRecoveryBaseManifest(stateDir), candidatePath);

  writeFileSync(
    join(stateDir, 'current.invalid-release-rollback-20260815T122000Z-125.json'),
    `${JSON.stringify(manifest)}\n`,
  );
  assert.throws(
    () => findRecoveryBaseManifest(stateDir),
    /requires exactly one invalid current manifest/u,
  );
});

test('rejects an incomplete recovery base and an unknown completed release', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-invalid-recovery-'));
  const incompletePath = join(stateDir, 'incomplete.json');
  const incomplete = buildReleaseManifest({
    releaseId: 'incomplete-release',
    targetSha: sha('a'),
    components: [component('api-shared', 'a')],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  writeFileSync(incompletePath, `${JSON.stringify(incomplete)}\n`);
  assert.throws(
    () => readRecoveryBaseManifest(incompletePath),
    /missing active component: miniapp-major-static/u,
  );

  const unknown = buildReleaseManifest({
    releaseId: 'inventory-release',
    targetSha: 'unknown',
    components: [
      { ...component('api-shared', 'a'), sourceSha: 'unknown', imageId: 'unknown' },
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  validateCompleteReleaseManifest(unknown, { allowUnknown: true });
  assert.throws(() => validateCompleteReleaseManifest(unknown), /targetSha must be known/u);
});

test('atomically journals current before a release runtime transition', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-transition-'));
  const current = buildReleaseManifest({
    releaseId: 'release-before-transition',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: current });

  const recoveryPath = beginReleaseTransition({
    stateDir,
    kind: 'deploy',
    now: new Date('2026-08-15T12:30:45.000Z'),
    pid: 456,
  });

  assert.equal(recoveryPath, join(stateDir, 'current.invalid-deploy-20260815T123045Z-456.json'));
  assert.equal(existsSync(join(stateDir, 'current.json')), false);
  assert.equal(readRecoveryBaseManifest(recoveryPath).releaseId, current.releaseId);

  commitReleaseManifest({ stateDir, manifest: current });
  assert.throws(
    () =>
      beginReleaseTransition({
        stateDir,
        kind: 'release-rollback-api',
        now: new Date('2026-08-15T12:31:45.000Z'),
        pid: 457,
      }),
    /coexists with 1 unresolved transition journal/u,
  );
});

test('durably archives only a transition journal superseded by a completed current release', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-transition-archive-'));
  const previous = buildReleaseManifest({
    releaseId: 'release-before-archive',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: previous });
  const recoveryPath = beginReleaseTransition({
    stateDir,
    kind: 'deploy',
    now: new Date('2026-08-15T12:30:00.000Z'),
    pid: 100,
  });

  assert.throws(
    () =>
      archiveReleaseTransition({
        stateDir,
        recoveryPath,
        now: new Date('2026-08-15T12:31:00.000Z'),
        pid: 101,
      }),
    /completed current release is required/u,
  );

  const completed = buildReleaseManifest({
    releaseId: 'release-after-archive',
    targetSha: sha('b'),
    current: previous,
    components: [component('api-shared', 'b')],
    createdAt: '2026-08-15T12:32:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: completed });
  const archivedPath = archiveReleaseTransition({
    stateDir,
    recoveryPath,
    disposition: 'superseded',
    now: new Date('2026-08-15T12:33:00.000Z'),
    pid: 102,
  });

  assert.equal(archivedPath, `${recoveryPath}.superseded-20260815T123300Z-102`);
  assert.equal(existsSync(recoveryPath), false);
  assert.equal(existsSync(archivedPath), true);
  assert.equal(findRecoveryBaseManifest(stateDir), null);
});

test('fsyncs manifest contents and parent directories around transition renames', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'release-manifest.mjs'), 'utf8');

  assert.match(
    source,
    /syncPath\(currentPath\);\n {2}renameSync\(currentPath, recoveryPath\);\n {2}syncDirectory\(stateDir\);/u,
  );
  assert.match(
    source,
    /syncPath\(resolvedRecoveryPath\);\n {2}renameSync\(resolvedRecoveryPath, archivedPath\);\n {2}syncDirectory\(resolvedStateDir\);/u,
  );
  assert.match(
    source,
    /syncPath\(tempPath\);\n {4}renameSync\(tempPath, path\);\n {4}syncDirectory\(parentDir\);/u,
  );
});
