import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyColdDigest } from './legacy-cold-journal.mjs';
import { refreezeSourceAbandonmentPreview } from './source-abandonment-refreeze.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import { legacyColdInventoryArtifactName } from './legacy-cold-host.mjs';

function fixture() {
  const hash = 'a'.repeat(64);
  const bindings = {
    targetSha: 'b'.repeat(40),
    targetImageId: `sha256:${hash}`,
    controllerNonce: 'controller',
    certificateId: 'certificate',
    selectionDigest: hash,
  };
  const base = {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    controllerNonce: bindings.controllerNonce,
    selectionDigest: bindings.selectionDigest,
  };
  const prior = {
    ...base,
    inventoryDigest: hash,
    previewDigest: hash,
    inventoryArtifactSha256: hash,
    inventory: {},
  };
  const pending = {
    ...prior,
    inventoryDigest: 'c'.repeat(64),
    inventoryArtifactSha256: 'd'.repeat(64),
    inventoryArtifactName: `inventory-${'d'.repeat(64)}.json`,
  };
  const original = {
    phase: 'STOPPED',
    revision: 9,
    bindings,
    proofs: { pendingInventory: '1'.repeat(64), reviewedPreview: '2'.repeat(64) },
    blockedReason: 'protocol_proof_failed',
  };
  const state = {
    journal: original,
    calls: [],
    evidence: new Map(),
    absentReads: 0,
    refuseSecond: false,
    driftFence: false,
    collectorDenied: false,
    certificateExists: false,
    casDenied: false,
    casCalls: 0,
  };
  const request = {
    version: 1,
    operation: 'refreeze-preview',
    expectedJournalDigest: legacyColdDigest(original),
    reviewedInventoryDigest: hash,
    reviewedPreviewDigest: hash,
  };
  const store = {
    read: () => ({ journal: state.journal }),
    readProof: () => prior,
    recordProof(value) {
      const digest = legacyColdDigest(value);
      state.evidence.set(digest, structuredClone(value));
      return digest;
    },
    refreezePreinstall(expected, proofs) {
      state.calls.push('journalCAS');
      state.casCalls++;
      assert.equal(expected, legacyColdDigest(original));
      if (state.casDenied) throw new Error('CAS_refused');
      const history = state.evidence.get(proofs.supersededPreview);
      assert.deepEqual(history.previousJournal, original);
      assert.equal(history.previousPendingInventory, original.proofs.pendingInventory);
      assert.equal(history.previousArtifactSha256, prior.inventoryArtifactSha256);
      const absence = state.evidence.get(proofs.refreezeAbsence);
      assert.equal(absence.before.state, 'ABSENT');
      assert.equal(absence.after.state, 'ABSENT');
      assert.deepEqual(state.evidence.get(proofs.pendingInventory), pending);
      state.journal = {
        ...original,
        phase: 'INVENTORIED',
        revision: 10,
        blockedReason: null,
        proofs: { ...original.proofs, ...proofs },
      };
      return state.journal;
    },
  };
  const adapters = {
    removeStoreClient() {
      state.calls.push('removeClient');
    },
    readStoppedRuntime() {
      state.calls.push('stopped16');
      return {
        ...base,
        unreviewedProducers: 0,
        services: LEGACY_COLD_API_SERVICES.map((serviceName) => ({
          serviceName,
          stopped: true,
          exactGeneration: true,
          restartPolicy: 'unless-stopped',
        })),
        auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map((serviceName) => ({
          serviceName,
          stopped: true,
          exactGeneration: true,
          restartPolicy: 'unless-stopped',
        })),
      };
    },
    readQueueFence() {
      state.calls.push('fence24');
      return {
        ...base,
        queueCount: 24,
        pausedCount: state.driftFence ? 23 : 24,
        activeCount: 0,
        ownerNonce: bindings.controllerNonce,
      };
    },
    readCertificateAbsent(_bindings, value) {
      state.calls.push('readbackABSENT');
      assert.equal(value, prior);
      state.absentReads++;
      if (state.certificateExists || (state.refuseSecond && state.absentReads === 2))
        throw new Error('certificate_not_absent');
      return { state: 'ABSENT', ordinal: state.absentReads };
    },
    snapshotRefrozenPending(_bindings, value) {
      state.calls.push('fullInventory');
      assert.equal(value, prior);
      if (state.collectorDenied) throw new Error('collector_DENY');
      return pending;
    },
    installDispositions() {
      assert.fail('Refreeze cannot install');
    },
    startBoundRuntime() {
      assert.fail('Refreeze cannot restart');
    },
    resumeQueues() {
      assert.fail('Refreeze cannot resume queues');
    },
  };
  return {
    state,
    request,
    original,
    store,
    adapters,
    run: () => refreezeSourceAbandonmentPreview({ store, adapters, request }),
  };
}

test('refreeze brackets full inventory with two old-artifact absence proofs and creates a separate review boundary', async () => {
  const h = fixture();
  const result = await h.run();
  assert.deepEqual(h.state.calls, [
    'removeClient',
    'stopped16',
    'fence24',
    'readbackABSENT',
    'fullInventory',
    'readbackABSENT',
    'removeClient',
    'stopped16',
    'fence24',
    'journalCAS',
    'removeClient',
  ]);
  assert.equal(result.installed, false);
  assert.equal(result.independentReviewRequired, true);
  assert.equal(result.previousInventoryDigest, h.request.reviewedInventoryDigest);
  assert.notEqual(result.inventoryDigest, result.previousInventoryDigest);
  assert.equal(result.journalDigest, legacyColdDigest(h.state.journal));
  assert.equal(h.original.phase, 'STOPPED');
  assert.equal(h.original.revision, 9);
});

for (const flag of ['certificateExists', 'refuseSecond', 'driftFence', 'collectorDenied'])
  test(`refreeze ${flag} preserves the old journal and never reaches replacement CAS`, async () => {
    const h = fixture();
    h.state[flag] = true;
    await assert.rejects(h.run);
    assert.equal(h.state.journal, h.original);
    assert.equal(h.state.casCalls, 0);
    assert.equal(h.state.calls.at(-1), 'removeClient');
    if (flag === 'certificateExists') assert(!h.state.calls.includes('fullInventory'));
  });

test('failed journal CAS preserves the previous review while retaining new immutable evidence', async () => {
  const h = fixture();
  h.state.casDenied = true;
  await assert.rejects(h.run, /CAS_refused/);
  assert.equal(h.state.journal, h.original);
  assert.equal(h.state.evidence.size, 4);
});

for (const phase of ['ADMITTED', 'STOPPING', 'INSTALLING', 'SEALED', 'RESUMING', 'COMPLETE'])
  test(`refreeze is unavailable in ${phase}`, async () => {
    const h = fixture();
    h.state.journal = { ...h.original, phase };
    h.request.expectedJournalDigest = legacyColdDigest(h.state.journal);
    await assert.rejects(h.run, /preinstall_journal/);
    assert.equal(h.state.calls.length, 0);
  });

test('a refrozen preview cannot be replaced again by the same one-time recovery', async () => {
  const h = fixture();
  h.state.journal.proofs.supersededPreview = 'f'.repeat(64);
  h.request.expectedJournalDigest = legacyColdDigest(h.state.journal);
  await assert.rejects(h.run, /preinstall_journal/);
  assert.equal(h.state.calls.length, 0);
});

test('versioned inventory names are derived only from the immutable artifact hash', () => {
  assert.equal(legacyColdInventoryArtifactName(null), 'inventory.json');
  assert.equal(legacyColdInventoryArtifactName({}), 'inventory.json');
  const hash = 'a'.repeat(64);
  assert.equal(
    legacyColdInventoryArtifactName({
      inventoryArtifactSha256: hash,
      inventoryArtifactName: `inventory-${hash}.json`,
    }),
    `inventory-${hash}.json`,
  );
  assert.equal(
    legacyColdInventoryArtifactName(
      { inventoryArtifactSha256: hash, inventoryArtifactName: `inventory-${hash}.json` },
      false,
    ),
    'inventory.json',
  );
  for (const name of [
    'inventory.json',
    '../inventory.json',
    '/tmp/inventory.json',
    `inventory-${'b'.repeat(64)}.json`,
    null,
  ])
    assert.throws(
      () =>
        legacyColdInventoryArtifactName({
          inventoryArtifactSha256: hash,
          inventoryArtifactName: name,
        }),
      /artifact_name/,
    );
});
