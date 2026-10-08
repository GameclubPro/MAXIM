import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLegacyColdJournalStore,
  legacyColdDigest,
  assertNoActiveLegacyColdMaintenance,
} from './legacy-cold-journal.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
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
    await assert.rejects(h.abort());
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
  await assert.rejects(h.abort());
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
    await assert.rejects(h.abort());
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

test('an inventoried source cannot cross this abort boundary', async (t) => {
  const h = fixture(t),
    journal = h.store.read().journal;
  h.store.advance(legacyColdDigest(journal), 'INVENTORIED', {
    pendingInventory: h.store.recordProof({ a: 1 }),
    reviewedPreview: h.store.recordProof({ b: 1 }),
  });
  await assert.rejects(h.abort(), /abort_preinstall_journal_unproved/);
  assert.deepEqual(h.events, []);
});
