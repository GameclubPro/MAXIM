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
import { canonicalLegacyColdDigest } from './legacy-cold-store-adapter.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';

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

function refreezeFixture(t, { stopped = false, blocked = true } = {}) {
  const h = fixture(t);
  const inventoryBinding = {
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    maintenanceId: nonce,
    queueFenceNonce: '1'.repeat(64),
    stoppedGenerations: [{ sourceSha: bindings.targetSha, stopped: true }],
  };
  const inventory = {
    version: 1,
    binding: inventoryBinding,
    selectionSha256: '8'.repeat(64),
    inventorySha256: '1'.repeat(64),
    previewSha256: '2'.repeat(64),
  };
  const previous = {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    controllerNonce: nonce,
    selectionDigest: bindings.selectionDigest,
    inventoryDigest: inventory.inventorySha256,
    previewDigest: inventory.previewSha256,
    inventoryArtifactSha256: legacyColdDigest(`${JSON.stringify(inventory)}\n`),
    unknownSources: 0,
    saturated: false,
    inventory,
  };
  const review = (pending) => ({
    version: 1,
    previewDigest: pending.previewDigest,
    inventoryDigest: pending.inventoryDigest,
    selectionDigest: bindings.selectionDigest,
  });
  let journal = h.store.admit(bindings, hash);
  journal = h.store.advance(legacyColdDigest(journal), 'STOPPING');
  journal = h.store.advance(legacyColdDigest(journal), 'STOPPED', { stoppedInventory: hash });
  journal = h.store.advance(legacyColdDigest(journal), 'INVENTORIED', {
    pendingInventory: h.store.recordProof(previous),
    reviewedPreview: h.store.recordProof(review(previous)),
  });
  if (stopped)
    journal = h.store.retryPreinstall(legacyColdDigest(journal), {
      stoppedInventory: hash,
      repausedQueues: hash,
    });
  if (blocked)
    journal = h.store.block(legacyColdDigest(journal), 'reviewed_inventory_changed', {
      revocation: hash,
    });
  const replacement = structuredClone(previous);
  replacement.inventoryDigest = '3'.repeat(64);
  replacement.inventory.inventorySha256 = replacement.inventoryDigest;
  replacement.inventoryArtifactSha256 = legacyColdDigest(
    `${JSON.stringify(replacement.inventory)}\n`,
  );
  replacement.inventoryArtifactName = `inventory-${replacement.inventoryArtifactSha256}.json`;
  const readback = {
    version: 1,
    operation: 'readback',
    state: 'ABSENT',
    certificateId: bindings.certificateId,
    activationAuthorized: false,
    inventorySha256: previous.inventoryDigest,
    previewSha256: previous.previewDigest,
    bindingSha256: canonicalLegacyColdDigest(inventoryBinding),
    completeChats: 0,
    requiredChats: 0,
  };
  const absence = {
    version: 1,
    operation: 'refreeze-certificate-absence',
    certificateId: bindings.certificateId,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    controllerNonce: nonce,
    selectionDigest: bindings.selectionDigest,
    inventoryDigest: previous.inventoryDigest,
    previewDigest: previous.previewDigest,
    before: readback,
    after: structuredClone(readback),
  };
  const artifact = join(h.directory, 'inventory.json');
  writeFileSync(artifact, `${JSON.stringify(previous.inventory)}\n`, { mode: 0o600 });
  return { ...h, journal, previous, replacement, absence, review, artifact };
}

function refreezeProofs(h, overrides = {}) {
  const pending = overrides.pending ?? h.replacement;
  const pendingInventory = h.store.recordProof(pending);
  const reviewedPreview = h.store.recordProof(overrides.review ?? h.review(pending));
  const refreezeAbsence = h.store.recordProof(overrides.absence ?? h.absence);
  const supersededPreview = h.store.recordProof({
    version: 1,
    operation: 'refreeze-preview',
    previousJournal: h.journal,
    previousJournalDigest: legacyColdDigest(h.journal),
    previousPendingInventory: h.journal.proofs.pendingInventory,
    previousReviewedPreview: h.journal.proofs.reviewedPreview,
    previousArtifactSha256: h.previous.inventoryArtifactSha256,
    replacementPendingInventory: pendingInventory,
    replacementReviewedPreview: reviewedPreview,
    absenceProof: refreezeAbsence,
    ...overrides.history,
  });
  return { supersededPreview, refreezeAbsence, pendingInventory, reviewedPreview };
}

test('one typed preinstall refreeze retains original evidence and changes only the reviewed preview', (t) => {
  for (const stopped of [false, true]) {
    const h = refreezeFixture(t, { stopped });
    const oldBytes = readFileSync(h.artifact);
    const oldProofs = new Map(
      Object.values(h.journal.proofs).map((id) => [
        id,
        readFileSync(join(h.directory, 'legacy-cold-evidence', `${id}.json`)),
      ]),
    );
    const proofs = refreezeProofs(h);
    const next = h.store.refreezePreinstall(legacyColdDigest(h.journal), proofs);
    assert.deepEqual(next, {
      ...h.journal,
      phase: 'INVENTORIED',
      revision: h.journal.revision + 1,
      blockedReason: null,
      proofs: { ...h.journal.proofs, ...proofs },
    });
    assert.deepEqual(h.store.readProof('supersededPreview').previousJournal, h.journal);
    assert.deepEqual(h.store.readProof('pendingInventory'), h.replacement);
    assert.deepEqual(readFileSync(h.artifact), oldBytes);
    for (const [id, bytes] of oldProofs)
      assert.deepEqual(
        readFileSync(join(h.directory, 'legacy-cold-evidence', `${id}.json`)),
        bytes,
      );
    assert.throws(() => h.store.refreezePreinstall(legacyColdDigest(next), proofs), /refreeze CAS/);
    assert.throws(
      () => h.store.block(legacyColdDigest(next), 'refused', { pendingInventory: hash }),
      /immutable proof/,
    );
    assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory), /active cold epoch/);
  }
});

test('refreeze rejects stale revisions, broad proof changes and installation boundaries', (t) => {
  const h = refreezeFixture(t);
  const proofs = refreezeProofs(h);
  for (const [expected, input] of [
    ['f'.repeat(64), proofs],
    [legacyColdDigest(h.journal), { ...proofs, hostAdmission: hash }],
    [legacyColdDigest(h.journal), { ...proofs, refreezeAbsence: undefined }],
  ])
    assert.throws(() => h.store.refreezePreinstall(expected, input), /refreeze CAS/);
  assert.deepEqual(h.store.read().journal, h.journal);
  for (const name of [
    'pendingRecheck',
    'sealedReadback',
    'runtimeIdentity',
    'nativeIdentity',
    'strictSmokes',
    'releaseManifest',
    'restoppedInventory',
  ]) {
    const guarded = refreezeFixture(t);
    guarded.journal = guarded.store.block(legacyColdDigest(guarded.journal), 'refused', {
      [name]: hash,
    });
    assert.throws(
      () =>
        guarded.store.refreezePreinstall(
          legacyColdDigest(guarded.journal),
          refreezeProofs(guarded),
        ),
      /refreeze CAS/,
    );
  }
  const started = refreezeFixture(t, { blocked: false });
  for (const [phase, additions] of steps.slice(3)) {
    started.journal = started.store.advance(legacyColdDigest(started.journal), phase, additions);
    assert.throws(
      () =>
        started.store.refreezePreinstall(
          legacyColdDigest(started.journal),
          refreezeProofs(started),
        ),
      /refreeze CAS/,
    );
  }
});

test('refreeze requires exact historical links and immutable original journal', (t) => {
  for (const field of [
    'previousJournalDigest',
    'previousPendingInventory',
    'previousReviewedPreview',
    'previousArtifactSha256',
    'replacementPendingInventory',
    'replacementReviewedPreview',
    'absenceProof',
  ]) {
    const h = refreezeFixture(t);
    const proofs = refreezeProofs(h, { history: { [field]: 'f'.repeat(64) } });
    assert.throws(
      () => h.store.refreezePreinstall(legacyColdDigest(h.journal), proofs),
      /superseded/,
    );
    assert.deepEqual(h.store.read().journal, h.journal);
  }
  const h = refreezeFixture(t);
  const proofs = refreezeProofs(h, {
    history: { previousJournal: { ...h.journal, revision: h.journal.revision + 1 } },
  });
  assert.throws(
    () => h.store.refreezePreinstall(legacyColdDigest(h.journal), proofs),
    /superseded/,
  );
});

test('both bound certificate reads must positively prove absence for the old review', (t) => {
  for (const side of ['before', 'after']) {
    for (const [field, value] of [
      ['state', 'UNSEALED'],
      ['state', 'SEALED'],
      ['state', 'UNKNOWN'],
      ['operation', 'install'],
      ['version', 2],
      ['certificateId', nonce],
      ['activationAuthorized', true],
      ['inventorySha256', 'f'.repeat(64)],
      ['previewSha256', 'f'.repeat(64)],
      ['bindingSha256', 'f'.repeat(64)],
    ]) {
      const h = refreezeFixture(t);
      const absence = structuredClone(h.absence);
      absence[side][field] = value;
      const proofs = refreezeProofs(h, { absence });
      assert.throws(
        () => h.store.refreezePreinstall(legacyColdDigest(h.journal), proofs),
        /absence/,
      );
      assert.deepEqual(h.store.read().journal, h.journal);
    }
  }
});

test('refreeze rejects replacement identity, artifact and review drift', (t) => {
  for (const [field, value] of [
    ['sourceSha', 'f'.repeat(40)],
    ['imageId', `sha256:${'f'.repeat(64)}`],
    ['controllerNonce', clusterIdentity],
    ['selectionDigest', 'f'.repeat(64)],
    ['previewDigest', 'f'.repeat(64)],
    ['inventoryArtifactSha256', 'f'.repeat(64)],
    ['inventoryArtifactName', '../inventory.json'],
    ['complete', false],
    ['unknownSources', 1],
    ['saturated', true],
  ]) {
    const h = refreezeFixture(t);
    const proofs = refreezeProofs(h, { pending: { ...h.replacement, [field]: value } });
    assert.throws(() => h.store.refreezePreinstall(legacyColdDigest(h.journal), proofs), /binding/);
    assert.deepEqual(h.store.read().journal, h.journal);
  }
  const h = refreezeFixture(t);
  const proofs = refreezeProofs(h, {
    review: { ...h.review(h.replacement), inventoryDigest: 'f'.repeat(64) },
  });
  assert.throws(() => h.store.refreezePreinstall(legacyColdDigest(h.journal), proofs), /binding/);
});

test('new proof hashes do not authorize absent or modified evidence files', (t) => {
  for (const remove of [false, true]) {
    const h = refreezeFixture(t);
    const proofs = refreezeProofs(h);
    const path = join(h.directory, 'legacy-cold-evidence', `${proofs.refreezeAbsence}.json`);
    if (remove) rmSync(path);
    else writeFileSync(path, '{"forged":true}\n');
    assert.throws(
      () => h.store.refreezePreinstall(legacyColdDigest(h.journal), proofs),
      /absent or changed/,
    );
    assert.deepEqual(h.store.read().journal, h.journal);
  }
});

function abortFixture(t, { stoppedOverrides = {}, blocked = true, existingFence = false } = {}) {
  const h = fixture(t);
  const base = {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    controllerNonce: bindings.controllerNonce,
    selectionDigest: bindings.selectionDigest,
  };
  const stoppedRow = (serviceName) => ({
    serviceName,
    stopped: true,
    exactGeneration: true,
    restartPolicy: 'unless-stopped',
  });
  const stopped = {
    ...base,
    unreviewedProducers: 0,
    services: LEGACY_COLD_API_SERVICES.map(stoppedRow),
    auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map(stoppedRow),
    ...stoppedOverrides,
  };
  const fence = {
    ...base,
    queueCount: 24,
    pausedCount: 24,
    activeCount: 0,
    ownerNonce: nonce,
  };
  let journal = h.store.admit(bindings, hash);
  journal = h.store.advance(legacyColdDigest(journal), 'STOPPING');
  journal = h.store.advance(legacyColdDigest(journal), 'STOPPED', {
    stoppedInventory: h.store.recordProof(stopped),
  });
  if (blocked)
    journal = h.store.block(legacyColdDigest(journal), 'inventory_refused', {
      revocation: hash,
      restoppedInventory: h.store.recordProof(stopped),
      ...(existingFence ? { repausedQueues: h.store.recordProof(fence) } : {}),
    });
  const read = {
    version: 1,
    state: 'ABSENT',
    certificateId: bindings.certificateId,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    readOnly: true,
  };
  const absence = {
    ...base,
    operation: 'abort-before-install',
    certificateId: bindings.certificateId,
    reads: [read, structuredClone(read)],
  };
  const origin = {
    version: 1,
    operation: 'abort-before-install',
    journal,
    journalDigest: legacyColdDigest(journal),
  };
  const runtime = { ...base, exactGenerationCount: 14, unreviewedProducers: 0 };
  const native = { ...base, exactGenerationCount: 2 };
  const smokes = {
    ...base,
    ingressReady: true,
    adminReady: true,
    queuesResumed: true,
    actionableLagSeconds: 0,
  };
  return { ...h, journal, origin, absence, stopped, fence, runtime, native, smokes };
}

function abortBeginProofs(h, overrides = {}) {
  return Object.fromEntries(
    Object.entries({
      abortOrigin: h.origin,
      abortAbsence: h.absence,
      stoppedInventory: h.stopped,
      repausedQueues: h.fence,
      ...overrides,
    }).map(([name, value]) => [name, h.store.recordProof(value)]),
  );
}

function abortFinishProofs(h, overrides = {}) {
  return Object.fromEntries(
    Object.entries({
      runtimeIdentity: h.runtime,
      nativeIdentity: h.native,
      strictSmokes: h.smokes,
      ...overrides,
    }).map(([name, value]) => [name, h.store.recordProof(value)]),
  );
}

test('typed abort retains the original stopped journal and evidence through retry and completion', (t) => {
  const h = abortFixture(t, { existingFence: true });
  const oldBytes = new Map(
    Object.values(h.journal.proofs).map((id) => [
      id,
      readFileSync(join(h.directory, 'legacy-cold-evidence', `${id}.json`)),
    ]),
  );
  const marker = readFileSync(join(h.directory, LEGACY_COLD_MARKER));
  const begin = abortBeginProofs(h);
  for (const name of ['stoppedInventory', 'repausedQueues'])
    assert.throws(
      () => h.store.beginAbortPreinstall(legacyColdDigest(h.journal), { ...begin, [name]: hash }),
      /immutable proof/,
    );
  let next = h.store.beginAbortPreinstall(legacyColdDigest(h.journal), begin);
  assert.equal(next.phase, 'ABORTING');
  assert.equal(next.blockedReason, null);
  assert.deepEqual(h.store.readProof('abortOrigin'), h.origin);
  assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory), /active cold epoch/);
  next = h.store.block(legacyColdDigest(next), 'restart_refused');
  assert.throws(
    () => h.store.finishAbortPreinstall(legacyColdDigest(next), abortFinishProofs(h)),
    /finish CAS/,
  );
  next = h.store.beginAbortPreinstall(legacyColdDigest(next), begin);
  next = h.store.finishAbortPreinstall(legacyColdDigest(next), abortFinishProofs(h));
  assert.equal(next.phase, 'ABORTED');
  assert.deepEqual(assertNoActiveLegacyColdMaintenance(h.directory).journal, next);
  assert.deepEqual(h.store.readProof('abortOrigin').journal, h.journal);
  assert.deepEqual(readFileSync(join(h.directory, LEGACY_COLD_MARKER)), marker);
  for (const [id, bytes] of oldBytes)
    assert.deepEqual(readFileSync(join(h.directory, 'legacy-cold-evidence', `${id}.json`)), bytes);
  for (const phase of ['ABORTING', 'ABORTED', 'ADMITTED', 'COMPLETE'])
    assert.throws(() => h.store.advance(legacyColdDigest(next), phase), /phase CAS/);
  assert.throws(() => h.store.block(legacyColdDigest(next), 'refused'), /blocked journal CAS/);
  assert.throws(() => h.store.beginAbortPreinstall(legacyColdDigest(next), begin), /abort CAS/);
  assert.throws(
    () => h.store.finishAbortPreinstall(legacyColdDigest(next), abortFinishProofs(h)),
    /finish CAS/,
  );
  assert.throws(() => h.store.seed(seed), /cannot be reseeded/);
  assert.equal(h.store.admit({ ...bindings, epoch: 2 }, hash).bindings.epoch, 2);
});

test('abort rejects stale CAS, broad proof keys, invalid phase and any install-related evidence', (t) => {
  const h = abortFixture(t, { blocked: false });
  const proofs = abortBeginProofs(h);
  assert.throws(() => h.store.beginAbortPreinstall('f'.repeat(64), proofs), /abort CAS/);
  assert.throws(
    () =>
      h.store.beginAbortPreinstall(legacyColdDigest(h.journal), {
        ...proofs,
        releaseManifest: hash,
      }),
    /abort CAS/,
  );
  const incomplete = { ...proofs };
  delete incomplete.abortAbsence;
  assert.throws(
    () => h.store.beginAbortPreinstall(legacyColdDigest(h.journal), incomplete),
    /abort CAS/,
  );
  for (const phase of ['ABORTING', 'ABORTED'])
    assert.throws(() => h.store.advance(legacyColdDigest(h.journal), phase, proofs), /phase CAS/);
  for (const name of [
    'pendingInventory',
    'reviewedPreview',
    'pendingRecheck',
    'sealedReadback',
    'releaseManifest',
    'runtimeIdentity',
    'nativeIdentity',
    'strictSmokes',
    'supersededPreview',
    'refreezeAbsence',
  ]) {
    const guarded = abortFixture(t);
    guarded.journal = guarded.store.block(legacyColdDigest(guarded.journal), 'refused', {
      [name]: hash,
    });
    assert.throws(
      () =>
        guarded.store.beginAbortPreinstall(
          legacyColdDigest(guarded.journal),
          abortBeginProofs(guarded),
        ),
      /abort CAS/,
    );
  }
  for (const [phase, additions] of steps.slice(2)) {
    h.journal = h.store.advance(legacyColdDigest(h.journal), phase, additions);
    assert.throws(
      () => h.store.beginAbortPreinstall(legacyColdDigest(h.journal), proofs),
      /abort CAS|abort ordinary preview unproved/,
    );
  }
  const early = fixture(t);
  let initial = early.store.admit(bindings, hash);
  for (const phase of ['ADMITTED', 'STOPPING']) {
    if (phase === 'STOPPING') initial = early.store.advance(legacyColdDigest(initial), phase);
    assert.throws(
      () => early.store.beginAbortPreinstall(legacyColdDigest(initial), proofs),
      /abort CAS/,
    );
  }
});

test('abort requires exact immutable origin and both bound read-only ABSENT proofs', (t) => {
  for (const side of [0, 1]) {
    for (const [field, value] of [
      ['state', 'SEALED'],
      ['state', 'UNSEALED'],
      ['state', 'UNKNOWN'],
      ['version', 2],
      ['certificateId', nonce],
      ['sourceSha', bindings.sourceSha],
      ['imageId', `sha256:${'f'.repeat(64)}`],
      ['readOnly', false],
      ['unknown', true],
    ]) {
      const h = abortFixture(t);
      const absence = structuredClone(h.absence);
      absence.reads[side][field] = value;
      assert.throws(
        () =>
          h.store.beginAbortPreinstall(
            legacyColdDigest(h.journal),
            abortBeginProofs(h, { abortAbsence: absence }),
          ),
        /absence/,
      );
      assert.deepEqual(h.store.read().journal, h.journal);
    }
  }
  for (const [field, value] of [
    ['operation', 'install'],
    ['complete', false],
    ['controllerNonce', clusterIdentity],
    ['selectionDigest', 'f'.repeat(64)],
    ['certificateId', nonce],
    ['reads', []],
    ['reads', [{ version: 1, state: 'ABSENT' }]],
  ]) {
    const h = abortFixture(t);
    assert.throws(
      () =>
        h.store.beginAbortPreinstall(
          legacyColdDigest(h.journal),
          abortBeginProofs(h, {
            abortAbsence: { ...h.absence, [field]: value },
          }),
        ),
      /absence/,
    );
  }
  for (const [field, value] of [
    ['version', 2],
    ['operation', 'install'],
    ['journalDigest', 'f'.repeat(64)],
    ['journal', {}],
  ]) {
    const h = abortFixture(t);
    assert.throws(
      () =>
        h.store.beginAbortPreinstall(
          legacyColdDigest(h.journal),
          abortBeginProofs(h, {
            abortOrigin: { ...h.origin, [field]: value },
          }),
        ),
      /original journal/,
    );
  }
  const h = abortFixture(t);
  const proofs = abortBeginProofs(h);
  const next = h.store.beginAbortPreinstall(legacyColdDigest(h.journal), proofs);
  for (const name of Object.keys(proofs))
    assert.throws(
      () => h.store.beginAbortPreinstall(legacyColdDigest(next), { ...proofs, [name]: hash }),
      /immutable proof/,
    );
});

test('abort proves every stopped role and the owned paused queue fence', (t) => {
  for (const stoppedOverrides of [
    { complete: false },
    { sourceSha: bindings.sourceSha },
    { services: [] },
    { auxiliaries: [] },
    { unreviewedProducers: 1 },
  ]) {
    const h = abortFixture(t, { stoppedOverrides });
    assert.throws(
      () => h.store.beginAbortPreinstall(legacyColdDigest(h.journal), abortBeginProofs(h)),
      /stopped inventory/,
    );
  }
  for (const [field, value] of [
    ['queueCount', 23],
    ['pausedCount', 23],
    ['activeCount', 1],
    ['ownerNonce', clusterIdentity],
    ['complete', false],
    ['controllerNonce', clusterIdentity],
  ]) {
    const h = abortFixture(t);
    assert.throws(
      () =>
        h.store.beginAbortPreinstall(
          legacyColdDigest(h.journal),
          abortBeginProofs(h, {
            repausedQueues: { ...h.fence, [field]: value },
          }),
        ),
      /queue fence/,
    );
  }
});

test('abort completion requires exact restarted identities and positive dependency smokes', (t) => {
  for (const [name, field, value] of [
    ['runtimeIdentity', 'exactGenerationCount', 13],
    ['runtimeIdentity', 'unreviewedProducers', 1],
    ['runtimeIdentity', 'sourceSha', bindings.sourceSha],
    ['nativeIdentity', 'exactGenerationCount', 1],
    ['nativeIdentity', 'imageId', `sha256:${'f'.repeat(64)}`],
    ['strictSmokes', 'ingressReady', false],
    ['strictSmokes', 'queuesResumed', false],
    ['strictSmokes', 'actionableLagSeconds', -1],
    ['strictSmokes', 'actionableLagSeconds', 11],
    ['strictSmokes', 'actionableLagSeconds', null],
    ['strictSmokes', 'complete', false],
  ]) {
    const h = abortFixture(t);
    const next = h.store.beginAbortPreinstall(legacyColdDigest(h.journal), abortBeginProofs(h));
    const values = { runtimeIdentity: h.runtime, nativeIdentity: h.native, strictSmokes: h.smokes };
    assert.throws(
      () =>
        h.store.finishAbortPreinstall(
          legacyColdDigest(next),
          abortFinishProofs(h, {
            [name]: { ...values[name], [field]: value },
          }),
        ),
      /identity unproved|smokes unproved/,
    );
    assert.deepEqual(h.store.read().journal, next);
    assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory), /active cold epoch/);
  }
  const h = abortFixture(t);
  const next = h.store.beginAbortPreinstall(legacyColdDigest(h.journal), abortBeginProofs(h));
  const proofs = abortFinishProofs(h, {
    strictSmokes: {
      ...h.smokes,
      ingressReady: false,
      actionableLagSeconds: 90,
      dependenciesReady: true,
      queueBacklogOnly: true,
    },
  });
  assert.throws(() => h.store.finishAbortPreinstall('f'.repeat(64), proofs), /finish CAS/);
  assert.throws(
    () =>
      h.store.finishAbortPreinstall(legacyColdDigest(next), { ...proofs, releaseManifest: hash }),
    /finish CAS/,
  );
  assert.equal(h.store.finishAbortPreinstall(legacyColdDigest(next), proofs).phase, 'ABORTED');
});

test('abort evidence must exist unchanged and terminal reload checks its contents', (t) => {
  for (const remove of [false, true]) {
    const h = abortFixture(t);
    const proofs = abortBeginProofs(h);
    const path = join(h.directory, 'legacy-cold-evidence', `${proofs.abortAbsence}.json`);
    if (remove) rmSync(path);
    else writeFileSync(path, '{"changed":true}\n');
    assert.throws(
      () => h.store.beginAbortPreinstall(legacyColdDigest(h.journal), proofs),
      /absent or changed/,
    );
    assert.deepEqual(h.store.read().journal, h.journal);
  }
  const h = abortFixture(t);
  let next = h.store.beginAbortPreinstall(legacyColdDigest(h.journal), abortBeginProofs(h));
  next = h.store.finishAbortPreinstall(legacyColdDigest(next), abortFinishProofs(h));
  const forged = { ...next, proofs: { ...next.proofs, runtimeIdentity: hash } };
  writeFileSync(join(h.directory, LEGACY_COLD_JOURNAL), `${JSON.stringify(forged)}\n`);
  assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory), /restarted identity/);
  writeFileSync(join(h.directory, LEGACY_COLD_JOURNAL), `${JSON.stringify(next)}\n`);
  rmSync(join(h.directory, 'legacy-cold-evidence', `${next.proofs.abortOrigin}.json`));
  assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory), /absent or changed/);
});
