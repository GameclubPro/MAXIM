import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertNoActiveLegacyColdMaintenance,
  createLegacyColdJournalStore,
  legacyColdDigest,
} from './legacy-cold-journal.mjs';
import {
  applyLegacyColdRecovery,
  prepareLegacyColdRecovery,
  retryLegacyColdPreview,
  observeLegacyColdAdapters,
  emitLegacyColdDiagnostic,
} from './legacy-cold-protocol.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cold-protocol-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createLegacyColdJournalStore({ directory, assertLock() {} });
  const hash = 'a'.repeat(64);
  const bindings = {
    clusterIdentity: '11111111-1111-4111-8111-111111111111',
    epoch: 1,
    controllerNonce: '22222222-2222-4222-8222-222222222222',
    certificateId: '33333333-3333-4333-8333-333333333333',
    baselineDigest: hash,
    sourceSha: 'b'.repeat(40),
    targetSha: 'b'.repeat(40),
    targetImageId: `sha256:${hash}`,
    topologyDigest: hash,
    selectionDigest: hash,
  };
  const base = {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    selectionDigest: bindings.selectionDigest,
    controllerNonce: bindings.controllerNonce,
  };
  const baseline = {
    ...base,
    compatible: true,
    singletonCount: 14,
    nativeCount: 2,
    unreviewedProducers: 0,
  };
  bindings.baselineDigest = legacyColdDigest(baseline);
  const pending = {
    ...base,
    previewDigest: hash,
    inventoryDigest: hash,
    unknownSources: 0,
    saturated: false,
  };
  const seal = {
    ...pending,
    permanentHoldsComplete: true,
    ownerProofsComplete: true,
    reviewedChatCursorsComplete: true,
  };
  let running = true;
  const events = [];
  const overrides = {};
  const implementations = {
    inspectRuntime: () => baseline,
    stopRuntime: () => {
      running = false;
    },
    readStoppedRuntime: () => ({
      ...base,
      unreviewedProducers: 0,
      services: LEGACY_COLD_API_SERVICES.map((serviceName) => ({
        serviceName,
        stopped: !running,
        exactGeneration: true,
        restartPolicy: 'unless-stopped',
      })),
      auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map((serviceName) => ({
        serviceName,
        stopped: !running,
        exactGeneration: true,
        restartPolicy: 'unless-stopped',
      })),
    }),
    pauseQueues: () => {},
    readQueueFence: () => ({
      ...base,
      queueCount: 24,
      pausedCount: 24,
      activeCount: 0,
      ownerNonce: bindings.controllerNonce,
    }),
    snapshotPending: () => pending,
    installDispositions: () => {},
    removeStoreClient: () => {},
    materializeReceipts: () => {},
    readSeal: () => seal,
    startBoundRuntime: () => {
      running = true;
    },
    readRuntimeIdentity: () => ({ ...base, exactGenerationCount: 14, unreviewedProducers: 0 }),
    readNativeIdentity: () => ({ ...base, exactGenerationCount: 2 }),
    resumeQueues: () => {},
    strictSmokes: () => ({
      ...base,
      ingressReady: true,
      adminReady: true,
      queuesResumed: true,
      actionableLagSeconds: 0,
    }),
  };
  const adapters = Object.fromEntries(
    Object.entries(implementations).map(([name, implementation]) => [
      name,
      async (...args) => {
        events.push(name);
        return (overrides[name] ?? implementation)(...args);
      },
    ]),
  );
  store.seed({
    version: 1,
    clusterIdentity: bindings.clusterIdentity,
    epoch: 0,
    phase: 'NEVER_ADMITTED',
    complete: true,
  });
  const prepare = () => prepareLegacyColdRecovery({ store, bindings, adapters });
  const apply = (preview, reconcile = false) =>
    applyLegacyColdRecovery({
      store,
      adapters,
      expectedJournalDigest: preview.journalDigest,
      reviewedPreviewDigest: preview.previewDigest,
      reviewedInventoryDigest: preview.inventoryDigest,
      reconcile,
    });
  return {
    store,
    directory,
    events,
    overrides,
    implementations,
    baseline,
    pending,
    seal,
    prepare,
    apply,
    retryPreview: () =>
      retryLegacyColdPreview({
        store,
        adapters,
        expectedJournalDigest: legacyColdDigest(store.read().journal),
      }),
    running: () => running,
  };
}

test('preview persists its exact evidence and leaves all producers stopped', async (t) => {
  const h = fixture(t);
  const preview = await h.prepare();
  assert.equal(preview.phase, 'INVENTORIED');
  assert.equal(h.running(), false);
  assert.equal(h.events.includes('startBoundRuntime'), false);
  assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory), /active cold epoch/);
  assert.equal(
    h.store.read().journal.proofs.pendingInventory,
    legacyColdDigest(`${JSON.stringify(h.pending)}\n`),
  );
});

test('holds and independent readbacks precede restart; completion does not claim a release', async (t) => {
  const h = fixture(t);
  const result = await h.apply(await h.prepare());
  assert.equal(result.coldRecoveryComplete, true);
  assert.equal(result.releaseRecorded, false);
  assert.equal(h.running(), true);
  assert.equal(assertNoActiveLegacyColdMaintenance(h.directory).journal.phase, 'COMPLETE');
  const install = h.events.indexOf('installDispositions');
  const cleanup = h.events.indexOf('removeStoreClient', install);
  const readback = h.events.indexOf('readSeal', cleanup);
  const materialized = h.events.indexOf('materializeReceipts', readback);
  const finalReadback = h.events.indexOf('readSeal', materialized);
  const start = h.events.indexOf('startBoundRuntime');
  assert.ok(
    install < cleanup &&
      cleanup < readback &&
      readback < materialized &&
      materialized < finalReadback &&
      finalReadback < start,
  );
  assert.ok(h.events.indexOf('readNativeIdentity') < h.events.indexOf('resumeQueues'));
});

for (const stage of [
  'stopRuntime',
  'readStoppedRuntime',
  'pauseQueues',
  'readQueueFence',
  'snapshotPending',
  'removeStoreClient',
]) {
  test(`preview failure at ${stage} never restarts`, async (t) => {
    const h = fixture(t);
    let first = true;
    h.overrides[stage] = (...args) => {
      if (first) {
        first = false;
        throw new Error('fixture failure');
      }
      return h.implementations[stage](...args);
    };
    await assert.rejects(h.prepare(), /no producers were resumed/);
    assert.equal(h.running(), false);
    assert.equal(h.events.includes('startBoundRuntime'), false);
    assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory));
  });
}

for (const stage of [
  'readStoppedRuntime',
  'readQueueFence',
  'snapshotPending',
  'installDispositions',
  'removeStoreClient',
  'readSeal',
  'materializeReceipts',
  'startBoundRuntime',
  'readRuntimeIdentity',
  'readNativeIdentity',
  'resumeQueues',
  'strictSmokes',
]) {
  test(`apply failure at ${stage} leaves the exact runtime stopped and journal blocked`, async (t) => {
    const h = fixture(t);
    const preview = await h.prepare();
    let first = true;
    h.overrides[stage] = (...args) => {
      if (first) {
        first = false;
        throw new Error('fixture failure');
      }
      return h.implementations[stage](...args);
    };
    await assert.rejects(h.apply(preview), /no successful recovery/);
    assert.equal(h.running(), false);
    assert.equal(h.store.read().journal.blockedReason, 'protocol_proof_failed');
    assert.throws(() => assertNoActiveLegacyColdMaintenance(h.directory));
  });
}

for (const [field, value] of [
  ['permanentHoldsComplete', false],
  ['ownerProofsComplete', false],
  ['reviewedChatCursorsComplete', false],
  ['complete', false],
  ['controllerNonce', 'foreign'],
]) {
  test(`reported install success with invalid ${field} never authorizes restart`, async (t) => {
    const h = fixture(t);
    const preview = await h.prepare();
    h.seal[field] = value;
    await assert.rejects(h.apply(preview), /no successful recovery/);
    assert.equal(h.events.includes('startBoundRuntime'), false);
    assert.equal(h.running(), false);
  });
}

test('lost commit response requires cleanup and independent proof without reinstalling', async (t) => {
  const h = fixture(t);
  const preview = await h.prepare();
  h.overrides.installDispositions = () => {
    throw Object.assign(new Error('lost response'), { outcomeUnknown: true });
  };
  const result = await h.apply(preview);
  assert.equal(result.coldRecoveryComplete, true);
  assert.equal(h.events.filter((name) => name === 'installDispositions').length, 1);
  const install = h.events.indexOf('installDispositions');
  assert.equal(h.events[install + 1], 'removeStoreClient');
  assert.equal(h.events[install + 2], 'readSeal');
});

test('changed pending inventory and stale operator review cannot start the fleet', async (t) => {
  const h = fixture(t);
  const preview = await h.prepare();
  h.pending.inventoryDigest = 'd'.repeat(64);
  await assert.rejects(h.apply(preview), /no successful recovery/);
  assert.equal(h.events.includes('installDispositions'), false);
  assert.equal(h.events.includes('startBoundRuntime'), false);
});

test('failed ready after restart stops producers before cleanup and queue containment', async (t) => {
  const h = fixture(t);
  const preview = await h.prepare();
  h.overrides.strictSmokes = () => ({ ...h.implementations.strictSmokes(), ingressReady: false });
  await assert.rejects(h.apply(preview), /no successful recovery/);
  const failed = h.events.lastIndexOf('strictSmokes');
  assert.deepEqual(h.events.slice(failed + 1, failed + 4), [
    'stopRuntime',
    'removeStoreClient',
    'pauseQueues',
  ]);
  assert.equal(h.running(), false);
});

test('interrupted sealed recovery reconciles by positive readback without another install or preview', async (t) => {
  const h = fixture(t);
  const preview = await h.prepare();
  h.overrides.strictSmokes = () => {
    throw new Error('temporary startup failure');
  };
  await assert.rejects(h.apply(preview));
  const failed = h.store.read().journal;
  assert.equal(failed.phase, 'RESUMING');
  delete h.overrides.strictSmokes;
  const offset = h.events.length;
  const result = await h.apply({ ...preview, journalDigest: legacyColdDigest(failed) }, true);
  assert.equal(result.coldRecoveryComplete, true);
  assert.deepEqual(h.events.slice(offset, offset + 3), [
    'stopRuntime',
    'removeStoreClient',
    'pauseQueues',
  ]);
  assert.equal(h.events.slice(offset).includes('installDispositions'), false);
  assert.equal(h.events.slice(offset).includes('snapshotPending'), false);
  assert.equal(h.store.read().journal.blockedReason, null);
});

test('unknown installation cannot be retried or resumed by reconciliation', async (t) => {
  const h = fixture(t);
  const preview = await h.prepare();
  h.overrides.installDispositions = () => {
    throw new Error('unknown commit');
  };
  await assert.rejects(h.apply(preview));
  const failed = h.store.read().journal;
  h.seal.permanentHoldsComplete = false;
  const offset = h.events.length;
  await assert.rejects(h.apply({ ...preview, journalDigest: legacyColdDigest(failed) }, true));
  assert.equal(h.running(), false);
  assert.equal(h.events.slice(offset).includes('installDispositions'), false);
  assert.equal(h.events.slice(offset).includes('startBoundRuntime'), false);
  await assert.rejects(h.retryPreview(), /preinstall_journal_unproved/);
});

test('preinstall snapshot interruption can retry the same stopped operation without any writer or restart', async (t) => {
  const h = fixture(t);
  h.overrides.snapshotPending = () => {
    throw new Error('temporary readonly error');
  };
  await assert.rejects(h.prepare());
  assert.equal(h.store.read().journal.phase, 'STOPPED');
  delete h.overrides.snapshotPending;
  const result = await h.retryPreview();
  assert.equal(result.phase, 'INVENTORIED');
  assert.equal(h.running(), false);
  assert.equal(h.events.includes('installDispositions'), false);
  assert.equal(h.events.includes('startBoundRuntime'), false);
  assert.equal((await h.apply(result)).coldRecoveryComplete, true);
});

test('preinstall retry retains reviewed evidence and cannot silently replace a changed inventory', async (t) => {
  const h = fixture(t);
  await h.prepare();
  h.pending.inventoryDigest = 'f'.repeat(64);
  await assert.rejects(h.retryPreview(), /producers remain stopped/);
  assert.equal(h.running(), false);
  assert.equal(h.events.includes('installDispositions'), false);
});

test('completed scope keeps healthy fleet running while unrelated backlog remains explicit', async (t) => {
  const h = fixture(t);
  const preview = await h.prepare();
  h.overrides.strictSmokes = () => ({
    ...h.implementations.strictSmokes(),
    ingressReady: false,
    adminReady: false,
    dependenciesReady: true,
    queueBacklogOnly: true,
    actionableLagSeconds: 40000,
  });
  const result = await h.apply(preview);
  assert.equal(result.coldRecoveryComplete, true);
  assert.equal(result.fleetReady, false);
  assert.equal(result.releaseRecorded, false);
  assert.equal(h.running(), true);
  assert.equal(h.store.read().journal.phase, 'COMPLETE');
});

test('stage diagnostics preserve failures and exclude all private values', async () => {
  const events = [];
  let now = 100;
  const failure = Object.assign(new Error('private-token-and-body'), { stderr: 'private-stderr' });
  const original = {
    privateState: 'private-state',
    async readSeal(argument) {
      assert.equal(this, original);
      assert.equal(argument, 'private-argument');
      now += 37;
      throw failure;
    },
    async materializeReceipts() {
      throw new Error('materialization_budget');
    },
    async inspectRuntime() {
      return { private: 'private-result' };
    },
  };
  const observed = observeLegacyColdAdapters(
    original,
    (event) => events.push(event),
    () => now,
  );
  await assert.rejects(observed.readSeal('private-argument'), (error) => error === failure);
  await assert.rejects(observed.materializeReceipts(), /materialization_budget/u);
  assert.deepEqual(await observed.inspectRuntime(), { private: 'private-result' });
  assert.deepEqual(events[1], {
    version: 1,
    diagnostic: 'legacy_cold_progress',
    stage: 'readSeal',
    event: 'failed',
    code: 'unclassified_failure',
    elapsedMs: 37,
  });
  assert.equal(events[3].code, 'materialization_budget');
  assert.doesNotMatch(JSON.stringify(events), /private-|stderr|argument/u);
  const brokenTransport = observeLegacyColdAdapters(original, () => {
    throw new Error('output failed');
  });
  assert.deepEqual(await brokenTransport.inspectRuntime(), { private: 'private-result' });
});

test('diagnostics discard unknown fields, malformed counters and unreviewed stage names', () => {
  const events = [];
  const report = (value) => events.push(value);
  emitLegacyColdDiagnostic(report, {
    stage: 'materializeReceipts',
    event: 'page',
    page: 1,
    chatOrdinal: 1,
    chatCount: 2,
    elapsedMs: 100,
    scanned: 200,
    applied: 0,
    complete: false,
    chatId: 'private-chat',
    cursor: { afterId: 'private-receipt' },
    token: 'private-token',
  });
  emitLegacyColdDiagnostic(report, {
    stage: 'materializeReceipts',
    event: 'page',
    page: 201,
    scanned: -1,
    applied: 'private-number',
    elapsedMs: Infinity,
    chatCount: 201,
  });
  emitLegacyColdDiagnostic(report, { stage: 'private-stage', event: 'failed' });
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], {
    version: 1,
    diagnostic: 'legacy_cold_progress',
    stage: 'materializeReceipts',
    event: 'page',
  });
  assert.equal(events[0].scanned, 200);
  assert.doesNotMatch(JSON.stringify(events), /private-|token|cursor|chatId/u);
});

test('failed diagnostics retain only allowlisted runtime and process metadata', async () => {
  const events = [];
  const failure = Object.assign(new Error('native_startup_deadline'), {
    status: 137,
    code: 'ETIMEDOUT',
    signal: 'SIGKILL',
    stdout: 'private-output',
    stderr: 'private-stderr',
    path: '/private/executable',
    spawnargs: ['private-argument'],
    cause: new Error('private-cause'),
  });
  emitLegacyColdDiagnostic((event) => events.push(event), {
    stage: 'startBoundRuntime',
    event: 'failed',
    runtimePhase: 'wait_native_health',
    command: 'inspect',
    error: failure,
  });
  assert.deepEqual(events[0], {
    version: 1,
    diagnostic: 'legacy_cold_progress',
    stage: 'startBoundRuntime',
    event: 'failed',
    code: 'native_startup_deadline',
    runtimePhase: 'wait_native_health',
    command: 'inspect',
    exitCode: 137,
    spawnCode: 'ETIMEDOUT',
    signal: 'SIGKILL',
  });
  const observed = observeLegacyColdAdapters(
    {
      readRuntimeIdentity() {
        throw failure;
      },
    },
    (event) => events.push(event),
  );
  await assert.rejects(observed.readRuntimeIdentity(), (error) => error === failure);
  assert.equal(events[2].spawnCode, 'ETIMEDOUT');
  assert.doesNotMatch(JSON.stringify(events), /private-|stdout|stderr|spawnargs|cause|path/u);

  for (const status of [-1, 256, 1.5, '137']) {
    emitLegacyColdDiagnostic((event) => events.push(event), {
      stage: 'startBoundRuntime',
      event: 'failed',
      runtimePhase: 'private-phase',
      command: 'private-command',
      error: { message: 'private-message', status, code: 'private-code', signal: 'private-signal' },
    });
    assert.deepEqual(events.at(-1), {
      version: 1,
      diagnostic: 'legacy_cold_progress',
      stage: 'startBoundRuntime',
      event: 'failed',
      code: 'unclassified_failure',
    });
  }
});

test('throwing diagnostic getters and transport cannot replace the operation failure', async () => {
  const failure = new Error();
  for (const key of ['message', 'status', 'code', 'signal', 'cause']) {
    Object.defineProperty(failure, key, {
      get() {
        throw new Error('private-getter');
      },
    });
  }
  for (const report of [
    () => {},
    () => {
      throw new Error('private-transport');
    },
  ]) {
    const observed = observeLegacyColdAdapters(
      {
        startBoundRuntime() {
          throw failure;
        },
      },
      report,
    );
    await assert.rejects(observed.startBoundRuntime(), (error) => error === failure);
    assert.doesNotThrow(() =>
      emitLegacyColdDiagnostic(report, {
        get stage() {
          throw new Error('private-stage-getter');
        },
      }),
    );
  }
});

test('diagnostic fields are read once before their allowlist checks', () => {
  const value = {};
  const expected = {
    stage: 'startBoundRuntime',
    event: 'failed',
    code: 'native_startup_unproved',
    runtimePhase: 'wait_native_health',
    command: 'inspect',
    elapsedMs: 12,
    complete: false,
  };
  for (const [key, first] of Object.entries(expected)) {
    let reads = 0;
    Object.defineProperty(value, key, {
      get() {
        return ++reads === 1 ? first : 'private-changed-value';
      },
    });
  }
  const events = [];
  emitLegacyColdDiagnostic((event) => events.push(event), value);
  assert.deepEqual(events, [{ version: 1, diagnostic: 'legacy_cold_progress', ...expected }]);
});
