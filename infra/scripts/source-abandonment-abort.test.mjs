import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLegacyColdJournalStore,
  legacyColdDigest,
  assertNoActiveLegacyColdMaintenance,
  LEGACY_COLD_JOURNAL,
} from './legacy-cold-journal.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import { canonicalLegacyColdDigest } from './legacy-cold-store-adapter.mjs';
import { abortSourceAbandonmentPreinstall } from './source-abandonment-abort.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-abort-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createLegacyColdJournalStore({ directory, assertLock() {} });
  const bindings = {
    clusterIdentity: '11111111-1111-4111-8111-111111111111',
    epoch: 1,
    controllerNonce: '22222222-2222-4222-8222-222222222222',
    certificateId: '33333333-3333-4333-8333-333333333333',
    baselineDigest: 'a'.repeat(64),
    sourceSha: 'b'.repeat(40),
    targetSha: 'b'.repeat(40),
    targetImageId: `sha256:${'c'.repeat(64)}`,
    topologyDigest: 'd'.repeat(64),
    selectionDigest: 'e'.repeat(64),
  };
  const base = {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    controllerNonce: bindings.controllerNonce,
    selectionDigest: bindings.selectionDigest,
  };
  const stopped = {
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
  store.seed({
    version: 1,
    clusterIdentity: bindings.clusterIdentity,
    epoch: 0,
    phase: 'NEVER_ADMITTED',
    complete: true,
  });
  let journal = store.admit(bindings, store.recordProof(base));
  journal = store.advance(legacyColdDigest(journal), 'STOPPING');
  store.advance(legacyColdDigest(journal), 'STOPPED', {
    stoppedInventory: store.recordProof(stopped),
  });
  const events = [],
    overrides = {};
  const implementations = {
    stopRuntime() {},
    removeStoreClient() {},
    pauseQueues() {},
    readStoppedRuntime: () => stopped,
    readQueueFence: () => ({
      ...base,
      queueCount: 24,
      pausedCount: 24,
      activeCount: 0,
      ownerNonce: bindings.controllerNonce,
    }),
    readAbortCertificateAbsent: () => ({
      version: 1,
      state: 'ABSENT',
      certificateId: bindings.certificateId,
      sourceSha: bindings.targetSha,
      imageId: bindings.targetImageId,
      readOnly: true,
    }),
    startBoundRuntime() {},
    readRuntimeIdentity: () => ({ ...base, exactGenerationCount: 14, unreviewedProducers: 0 }),
    readNativeIdentity: () => ({ ...base, exactGenerationCount: 2 }),
    resumeQueues() {},
    strictSmokes: () => ({
      ...base,
      ingressReady: true,
      adminReady: true,
      queuesResumed: true,
      actionableLagSeconds: 0,
    }),
  };
  const adapters = Object.fromEntries(
    Object.entries(implementations).map(([name, fn]) => [
      name,
      async (...args) => {
        events.push(name);
        return (overrides[name] ?? fn)(...args);
      },
    ]),
  );
  return {
    store,
    bindings,
    base,
    directory,
    events,
    overrides,
    implementations,
    abort: () =>
      abortSourceAbandonmentPreinstall({
        store,
        adapters,
        expectedJournalDigest: legacyColdDigest(store.read().journal),
      }),
  };
}

test('two independent absence proofs precede exact restart and typed ABORTED completion', async (t) => {
  const h = fixture(t),
    initial = h.store.read().journal;
  const result = await h.abort();
  assert.equal(result.aborted, true);
  assert.equal(result.installed, false);
  assert.equal(result.coldRecoveryComplete, false);
  assert.equal(h.store.read().journal.phase, 'ABORTED');
  assert.equal(h.store.readProof('abortOrigin').journalDigest, legacyColdDigest(initial));
  assert.deepEqual(h.store.readProof('abortOrigin').journal, initial);
  assert.equal(h.events.filter((name) => name === 'readAbortCertificateAbsent').length, 2);
  assert(
    h.events.lastIndexOf('readAbortCertificateAbsent') < h.events.indexOf('startBoundRuntime'),
  );
  assert.equal(assertNoActiveLegacyColdMaintenance(h.directory).journal.phase, 'ABORTED');
});

for (const change of [
  { state: 'PRESENT' },
  { readOnly: false },
  { certificateId: 'wrong' },
  { sourceSha: 'f'.repeat(40) },
  { imageId: `sha256:${'f'.repeat(64)}` },
])
  test(`absence mismatch refuses before restart ${JSON.stringify(change)}`, async (t) => {
    const h = fixture(t);
    h.overrides.readAbortCertificateAbsent = () => ({
      ...h.implementations.readAbortCertificateAbsent(),
      ...change,
    });
    await assert.rejects(async () => h.abort());
    assert(!h.events.includes('startBoundRuntime'));
    assert.equal(h.store.read().journal.phase, 'STOPPED');
    assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory));
  });

test('failure of second independent read refuses before restart', async (t) => {
  const h = fixture(t);
  let reads = 0;
  h.overrides.readAbortCertificateAbsent = () => {
    if (++reads === 2) throw new Error('read_failed');
    return h.implementations.readAbortCertificateAbsent();
  };
  await assert.rejects(async () => h.abort());
  assert(!h.events.includes('startBoundRuntime'));
  assert.equal(reads, 2);
});

for (const stage of [
  'startBoundRuntime',
  'readRuntimeIdentity',
  'readNativeIdentity',
  'resumeQueues',
  'strictSmokes',
])
  test(`failed ${stage} retains blocking ABORTING and permits only a new reviewed retry`, async (t) => {
    const h = fixture(t);
    h.overrides[stage] = () => {
      throw new Error('failed');
    };
    await assert.rejects(async () => h.abort());
    assert.equal(h.store.read().journal.phase, 'ABORTING');
    assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory));
    assert.deepEqual(h.events.slice(-3), ['stopRuntime', 'removeStoreClient', 'pauseQueues']);
    delete h.overrides[stage];
    assert.equal((await h.abort()).aborted, true);
  });

test('known backlog can remain after safe abort without claiming fleet recovery', async (t) => {
  const h = fixture(t);
  h.overrides.strictSmokes = () => ({
    ...h.base,
    ingressReady: false,
    adminReady: false,
    dependenciesReady: true,
    queueBacklogOnly: true,
    queuesResumed: true,
    actionableLagSeconds: 999,
  });
  assert.equal((await h.abort()).fleetReady, false);
});

test('an inventoried source without a complete refreeze cannot cross this abort boundary', async (t) => {
  const h = fixture(t),
    journal = h.store.read().journal;
  h.store.advance(legacyColdDigest(journal), 'INVENTORIED', {
    pendingInventory: h.store.recordProof({ a: 1 }),
    reviewedPreview: h.store.recordProof({ b: 1 }),
  });
  await assert.rejects(h.abort(), /abort_preinstall_journal_unproved/);
  assert.deepEqual(h.events, []);
});

function addRefrozenPreview(h) {
  const inventory = {
    inventorySha256: 'a'.repeat(64),
    previewSha256: 'b'.repeat(64),
    selectionSha256: 'c'.repeat(64),
    binding: { sourceSha: h.bindings.targetSha, imageId: h.bindings.targetImageId },
  };
  const pending = (value) => ({
    ...h.base,
    inventoryDigest: value.inventorySha256,
    previewDigest: value.previewSha256,
    inventoryArtifactSha256: legacyColdDigest(`${JSON.stringify(value)}\n`),
    inventory: value,
    unknownSources: 0,
    saturated: false,
  });
  const review = (value) => ({
    version: 1,
    previewDigest: value.previewDigest,
    inventoryDigest: value.inventoryDigest,
    selectionDigest: h.bindings.selectionDigest,
  });
  const previous = pending(inventory);
  const journal = h.store.advance(legacyColdDigest(h.store.read().journal), 'INVENTORIED', {
    pendingInventory: h.store.recordProof(previous),
    reviewedPreview: h.store.recordProof(review(previous)),
  });
  const replacement = pending({ ...inventory, inventorySha256: 'd'.repeat(64) });
  replacement.inventoryArtifactName = `inventory-${replacement.inventoryArtifactSha256}.json`;
  const readback = {
    version: 1,
    operation: 'readback',
    state: 'ABSENT',
    certificateId: h.bindings.certificateId,
    activationAuthorized: false,
    inventorySha256: previous.inventoryDigest,
    previewSha256: previous.previewDigest,
    bindingSha256: canonicalLegacyColdDigest(inventory.binding),
  };
  const refs = {
    pendingInventory: h.store.recordProof(replacement),
    reviewedPreview: h.store.recordProof(review(replacement)),
    refreezeAbsence: h.store.recordProof({
      version: 1,
      operation: 'refreeze-certificate-absence',
      certificateId: h.bindings.certificateId,
      sourceSha: h.bindings.targetSha,
      imageId: h.bindings.targetImageId,
      controllerNonce: h.bindings.controllerNonce,
      selectionDigest: h.bindings.selectionDigest,
      inventoryDigest: previous.inventoryDigest,
      previewDigest: previous.previewDigest,
      before: readback,
      after: structuredClone(readback),
    }),
  };
  refs.supersededPreview = h.store.recordProof({
    version: 1,
    operation: 'refreeze-preview',
    previousJournal: journal,
    previousJournalDigest: legacyColdDigest(journal),
    previousPendingInventory: journal.proofs.pendingInventory,
    previousReviewedPreview: journal.proofs.reviewedPreview,
    previousArtifactSha256: previous.inventoryArtifactSha256,
    replacementPendingInventory: refs.pendingInventory,
    replacementReviewedPreview: refs.reviewedPreview,
    absenceProof: refs.refreezeAbsence,
  });
  return h.store.refreezePreinstall(legacyColdDigest(journal), refs);
}

test('blocked inventoried abort preserves the complete refreeze chain and all immutable bytes', async (t) => {
  const h = fixture(t);
  const prepared = addRefrozenPreview(h);
  const initial = h.store.block(legacyColdDigest(prepared), 'protocol_proof_failed');
  const evidenceDir = join(h.directory, 'legacy-cold-evidence');
  const saved = readdirSync(evidenceDir).map((name) => [
    name,
    readFileSync(join(evidenceDir, name)),
  ]);
  const result = await h.abort();
  assert.equal(result.aborted, true);
  assert.equal(result.installed, false);
  const finished = assertNoActiveLegacyColdMaintenance(h.directory).journal;
  assert.equal(finished.phase, 'ABORTED');
  for (const [name, hash] of Object.entries(initial.proofs))
    assert.equal(finished.proofs[name], hash);
  for (const [name, bytes] of saved) assert.deepEqual(readFileSync(join(evidenceDir, name)), bytes);
  assert.deepEqual(h.store.readProof('abortOrigin').journal, initial);
  assert.equal(h.events.filter((name) => name === 'readAbortCertificateAbsent').length, 2);
  assert(
    h.events.lastIndexOf('readAbortCertificateAbsent') < h.events.indexOf('startBoundRuntime'),
  );
});

for (const name of ['pendingInventory', 'reviewedPreview', 'supersededPreview', 'refreezeAbsence'])
  test(`inventoried abort refuses a missing retained ${name}`, async (t) => {
    const h = fixture(t);
    const journal = addRefrozenPreview(h);
    delete journal.proofs[name];
    writeFileSync(join(h.directory, LEGACY_COLD_JOURNAL), JSON.stringify(journal));
    await assert.rejects(async () => h.abort());
    assert(!h.events.includes('startBoundRuntime'));
  });

for (const name of [
  'pendingRecheck',
  'sealedReadback',
  'runtimeIdentity',
  'nativeIdentity',
  'strictSmokes',
  'releaseManifest',
])
  test(`inventoried abort refuses writer or restart evidence ${name}`, async (t) => {
    const h = fixture(t);
    const journal = addRefrozenPreview(h);
    h.store.block(legacyColdDigest(journal), 'refused', {
      [name]: h.store.recordProof({ test: true }),
    });
    await assert.rejects(async () => h.abort());
    assert(!h.events.includes('startBoundRuntime'));
  });

for (const phase of ['INSTALLING', 'SEALED', 'RESUMING', 'COMPLETE'])
  test(`retained preview cannot permit abort after ${phase}`, async (t) => {
    const h = fixture(t);
    const journal = addRefrozenPreview(h);
    journal.phase = phase;
    if (['SEALED', 'RESUMING'].includes(phase))
      journal.proofs.sealedReadback = h.store.recordProof({ test: true });
    if (phase === 'COMPLETE')
      for (const name of ['runtimeIdentity', 'nativeIdentity', 'strictSmokes'])
        journal.proofs[name] = h.store.recordProof({ test: true });
    writeFileSync(join(h.directory, LEGACY_COLD_JOURNAL), JSON.stringify(journal));
    await assert.rejects(async () => h.abort());
    assert(!h.events.includes('startBoundRuntime'));
  });

for (const change of ['prior_binding', 'replacement_hash', 'prior_proof_missing'])
  test(`retained preview history ${change} refuses restart`, async (t) => {
    const h = fixture(t);
    const journal = addRefrozenPreview(h);
    const history = h.store.readProof('supersededPreview');
    if (change === 'prior_binding') {
      history.previousJournal.bindings.selectionDigest = 'f'.repeat(64);
      history.previousJournalDigest = legacyColdDigest(history.previousJournal);
    } else if (change === 'replacement_hash') {
      history.replacementPendingInventory = 'f'.repeat(64);
    } else {
      rmSync(join(h.directory, 'legacy-cold-evidence', `${history.previousPendingInventory}.json`));
    }
    if (change !== 'prior_proof_missing') {
      journal.proofs.supersededPreview = h.store.recordProof(history);
      writeFileSync(join(h.directory, LEGACY_COLD_JOURNAL), JSON.stringify(journal));
    }
    await assert.rejects(async () => h.abort());
    assert(!h.events.includes('startBoundRuntime'));
  });

test('failed inventoried restart reloads ABORTING with its retained proof chain before reviewed retry', async (t) => {
  const h = fixture(t);
  const prepared = addRefrozenPreview(h);
  h.overrides.startBoundRuntime = () => {
    throw new Error('restart_failed');
  };
  await assert.rejects(async () => h.abort());
  const reloaded = h.store.read().journal;
  assert.equal(reloaded.phase, 'ABORTING');
  for (const [name, hash] of Object.entries(prepared.proofs))
    assert.equal(reloaded.proofs[name], hash);
  delete h.overrides.startBoundRuntime;
  assert.equal((await h.abort()).aborted, true);
  assert.equal(h.events.filter((name) => name === 'readAbortCertificateAbsent').length, 4);
});
