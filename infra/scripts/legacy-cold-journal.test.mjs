import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoActiveLegacyColdMaintenance,
  createLegacyColdJournalStore,
  legacyColdDigest,
  LEGACY_COLD_JOURNAL,
  LEGACY_COLD_MARKER,
  readLegacyColdState,
} from './legacy-cold-journal.mjs';

const proof = { test: true };
const hash = legacyColdDigest(`${JSON.stringify(proof)}\n`);
const clusterIdentity = '11111111-1111-4111-8111-111111111111';
const nonce = '22222222-2222-4222-8222-222222222222';
const bindings = {
  clusterIdentity,
  epoch: 1,
  controllerNonce: nonce,
  certificateId: '33333333-3333-4333-8333-333333333333',
  baselineDigest: hash,
  sourceSha: 'b'.repeat(40),
  targetSha: 'c'.repeat(40),
  targetImageId: `sha256:${hash}`,
  topologyDigest: hash,
  selectionDigest: hash,
};
const seed = { version: 1, clusterIdentity, epoch: 0, phase: 'NEVER_ADMITTED', complete: true };
const steps = [
  ['STOPPING', {}],
  ['STOPPED', { stoppedInventory: hash }],
  ['INVENTORIED', { pendingInventory: hash, reviewedPreview: hash }],
  ['INSTALLING', {}],
  ['SEALED', { sealedReadback: hash }],
  ['RESUMING', {}],
  [
    'COMPLETE',
    { runtimeIdentity: hash, nativeIdentity: hash, strictSmokes: hash, releaseManifest: hash },
  ],
];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cold-journal-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let lockCalls = 0;
  const store = createLegacyColdJournalStore({
    directory,
    assertLock: () => {
      lockCalls++;
    },
    now: () => '2026-10-06T01:30:00.000Z',
  });
  store.seed(seed);
  assert.equal(store.recordProof(proof), hash);
  return { directory, store, lockCalls: () => lockCalls };
}

test('host admission requires a positive identity and cannot be reseeded', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.seed({ ...seed, complete: false }), /positive host admission/);
  assert.throws(() => store.seed({ ...seed, phase: 'REVOKED' }), /positive host admission/);
  assert.throws(() => store.seed({ ...seed, clusterIdentity: nonce }), /identity changed/);
});

test('every incomplete durable boundary blocks ordinary paths, including after reload', (t) => {
  const { directory, store, lockCalls } = fixture(t);
  let journal = store.admit(bindings, hash);
  assert.throws(() => assertNoActiveLegacyColdMaintenance(directory), /active cold epoch/);
  for (const [phase, proofs] of steps) {
    journal = store.advance(legacyColdDigest(journal), phase, proofs);
    assert.equal(readLegacyColdState(directory).journal.phase, phase);
    if (phase !== 'COMPLETE')
      assert.throws(() => assertNoActiveLegacyColdMaintenance(directory), /active cold epoch/);
  }
  assert.equal(assertNoActiveLegacyColdMaintenance(directory).journal.phase, 'COMPLETE');
  assert.equal(lockCalls(), 10);
});

test('phase jumps, stale controller revision and missing readback never advance', (t) => {
  const { directory, store } = fixture(t);
  const initial = store.admit(bindings, hash);
  assert.throws(
    () => store.advance(legacyColdDigest(initial), 'SEALED', { sealedReadback: hash }),
    /phase CAS/,
  );
  const stopping = store.advance(legacyColdDigest(initial), 'STOPPING');
  assert.throws(
    () => store.advance(legacyColdDigest(initial), 'STOPPED', { stoppedInventory: hash }),
    /phase CAS/,
  );
  assert.throws(() => store.advance(legacyColdDigest(stopping), 'STOPPED'), /missing positive/);
  assert.deepEqual(readLegacyColdState(directory).journal, stopping);
});

test('unknown install outcome stays blocked; no reset or new admission can overwrite it', (t) => {
  const { directory, store } = fixture(t);
  let journal = store.admit(bindings, hash);
  for (const [phase, proofs] of steps.slice(0, 4))
    journal = store.advance(legacyColdDigest(journal), phase, proofs);
  journal = store.block(legacyColdDigest(journal), 'unknown_commit');
  assert.equal(journal.phase, 'INSTALLING');
  assert.throws(
    () => store.advance(legacyColdDigest(journal), 'SEALED', { sealedReadback: hash }),
    /phase CAS/,
  );
  assert.throws(() => store.admit({ ...bindings, epoch: 2 }, hash), /active cold epoch/);
  assert.throws(() => store.seed(seed), /cannot be reseeded/);
  assert.throws(() => assertNoActiveLegacyColdMaintenance(directory), /active cold epoch/);
});

test('proofs and operation identity cannot change during a legitimate transition', (t) => {
  const { store } = fixture(t);
  const journal = store.admit(bindings, hash);
  assert.throws(
    () => store.advance(legacyColdDigest(journal), 'STOPPING', { hostAdmission: 'd'.repeat(64) }),
    /immutable proof/,
  );
  assert.throws(
    () => store.block(legacyColdDigest(journal), 'refused', { hostAdmission: 'd'.repeat(64) }),
    /immutable proof/,
  );
  const stopping = store.advance(legacyColdDigest(journal), 'STOPPING');
  assert.deepEqual(stopping.bindings, journal.bindings);
  assert.equal(stopping.operationId, journal.operationId);
});

test('missing host journal cannot mask an admitted sticky host marker', (t) => {
  const { directory, store } = fixture(t);
  store.admit(bindings, hash);
  rmSync(join(directory, LEGACY_COLD_JOURNAL));
  assert.throws(() => assertNoActiveLegacyColdMaintenance(directory), /admitted journal missing/);
  assert.throws(() => store.seed(seed), /admitted journal missing/);
});

test('unsafe, corrupt, foreign and interrupted file state fails closed', (t) => {
  const { directory, store } = fixture(t);
  store.admit(bindings, hash);
  const path = join(directory, LEGACY_COLD_JOURNAL);
  const original = readFileSync(path);
  writeFileSync(path, '{broken');
  assert.throws(() => assertNoActiveLegacyColdMaintenance(directory));
  writeFileSync(path, original);
  chmodSync(path, 0o644);
  assert.throws(() => assertNoActiveLegacyColdMaintenance(directory), /unsafe private evidence/);
  chmodSync(path, 0o600);
  const marker = JSON.parse(readFileSync(join(directory, LEGACY_COLD_MARKER), 'utf8'));
  writeFileSync(
    join(directory, LEGACY_COLD_MARKER),
    JSON.stringify({ ...marker, clusterIdentity: nonce }),
  );
  assert.throws(() => assertNoActiveLegacyColdMaintenance(directory), /identity mismatch/);
  writeFileSync(join(directory, LEGACY_COLD_MARKER), JSON.stringify(marker));
  writeFileSync(join(directory, `.${LEGACY_COLD_JOURNAL}.interrupted.tmp`), original, {
    mode: 0o600,
  });
  assert.throws(() => assertNoActiveLegacyColdMaintenance(directory), /interrupted durable write/);
});

test('symlinks, writable state directories and caller without a real lock are refused', (t) => {
  const { directory } = fixture(t);
  const privateMarker = join(directory, LEGACY_COLD_MARKER);
  const content = readFileSync(privateMarker);
  rmSync(privateMarker);
  const foreign = join(directory, 'foreign');
  writeFileSync(foreign, content, { mode: 0o600 });
  symlinkSync(foreign, privateMarker);
  assert.throws(() => readLegacyColdState(directory));
  rmSync(privateMarker);
  writeFileSync(privateMarker, content, { mode: 0o600 });
  chmodSync(directory, 0o777);
  assert.throws(() => readLegacyColdState(directory), /unsafe state directory/);
  chmodSync(directory, 0o700);
  assert.throws(() => createLegacyColdJournalStore({ directory }).seed(seed), /deploy lock/);
});

test('missing or modified referenced evidence blocks a completed host journal', (t) => {
  const { directory, store } = fixture(t);
  let journal = store.admit(bindings, hash);
  for (const [phase, proofs] of steps)
    journal = store.advance(legacyColdDigest(journal), phase, proofs);
  const evidence = join(directory, 'legacy-cold-evidence', `${hash}.json`);
  writeFileSync(evidence, JSON.stringify({ changed: true }));
  assert.throws(() => assertNoActiveLegacyColdMaintenance(directory), /referenced proof/);
  rmSync(evidence);
  assert.throws(() => assertNoActiveLegacyColdMaintenance(directory), /referenced proof/);
});

test('bounded inventory proofs larger than the journal limit remain readable and immutable', (t) => {
  const { store } = fixture(t);
  const value = { version: 1, inventory: 'x'.repeat(256 * 1024) };
  const proof = store.recordProof(value);
  let journal = store.admit(bindings, hash);
  journal = store.advance(legacyColdDigest(journal), 'STOPPING');
  journal = store.advance(legacyColdDigest(journal), 'STOPPED', { stoppedInventory: hash });
  store.advance(legacyColdDigest(journal), 'INVENTORIED', {
    pendingInventory: proof,
    reviewedPreview: hash,
  });
  assert.deepEqual(store.readProof('pendingInventory'), value);
  assert.equal(store.recordProof(value), proof);
  assert.throws(() => store.recordProof({ data: 'x'.repeat(8 * 1024 * 1024) }), /budget/);
});
