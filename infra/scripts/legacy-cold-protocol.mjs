import { legacyColdDigest } from './legacy-cold-journal.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';

const stages = [
  'inspectRuntime',
  'stopRuntime',
  'readStoppedRuntime',
  'pauseQueues',
  'readQueueFence',
  'snapshotPending',
  'installDispositions',
  'removeStoreClient',
  'materializeReceipts',
  'readSeal',
  'startBoundRuntime',
  'readRuntimeIdentity',
  'readNativeIdentity',
  'resumeQueues',
  'strictSmokes',
];

const diagnosticFailures = new Set([
  'materialization_budget',
  'materialization_page_unproved',
  'client_result_unknown',
  'client_removal_unproved',
  'store_result_binding_unproved',
  'installation_unproved',
  'certificate_creation_unproved',
  'inventory_refused',
  'reviewed_inventory_changed',
  'native_startup_unproved',
  'native_startup_deadline',
  'runtime_generation_unproved',
  'native_boundary_changed',
  'unreviewed_runtime_producer',
  'runtime_baseline_missing',
  'runtime_baseline_invalid',
  'role_identity_unproved',
  'runtime_inventory_budget',
  'stopped_baseline_missing',
]);

const runtimePhases = new Set([
  'stopped_inventory',
  'start_native',
  'wait_native_health',
  'start_api',
]);
const spawnCodes = new Set(['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'ENOSPC']);
const processSignals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGPIPE']);
const diagnosticProperty = (value, key) => {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
};

// FLAG: Diagnostics carry no identities, arguments, exception text, stderr or
// inventory. They cannot grant authority or alter fail-closed protocol behavior.
export function emitLegacyColdDiagnostic(report, value) {
  try {
    const stage = diagnosticProperty(value, 'stage');
    const event = diagnosticProperty(value, 'event');
    if (
      typeof report !== 'function' ||
      !stages.includes(stage) ||
      !['begin', 'complete', 'failed', 'page'].includes(event)
    )
      return;
    const safe = {
      version: 1,
      diagnostic: 'legacy_cold_progress',
      stage,
      event,
    };
    if (event === 'failed') {
      const error = diagnosticProperty(value, 'error');
      const code = diagnosticProperty(value, 'code') ?? diagnosticProperty(error, 'message');
      safe.code = diagnosticFailures.has(code) ? code : 'unclassified_failure';
      const runtimePhase = diagnosticProperty(value, 'runtimePhase');
      const command = diagnosticProperty(value, 'command');
      if (runtimePhases.has(runtimePhase)) safe.runtimePhase = runtimePhase;
      if (['ps', 'inspect', 'start', 'stop'].includes(command)) safe.command = command;
      const exitCode = diagnosticProperty(error, 'status');
      const spawnCode = diagnosticProperty(error, 'code');
      const signal = diagnosticProperty(error, 'signal');
      if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) safe.exitCode = exitCode;
      if (spawnCodes.has(spawnCode)) safe.spawnCode = spawnCode;
      if (processSignals.has(signal)) safe.signal = signal;
    }
    for (const [key, maximum] of Object.entries({
      elapsedMs: 86_400_000,
      page: 200,
      chatOrdinal: 200,
      chatCount: 200,
      scanned: 200,
      applied: 200,
    })) {
      const count = diagnosticProperty(value, key);
      if (Number.isSafeInteger(count) && count >= 0 && count <= maximum) safe[key] = count;
    }
    const complete = diagnosticProperty(value, 'complete');
    if (typeof complete === 'boolean') safe.complete = complete;
    report(safe);
  } catch {
    // Diagnostic transport is independent from the durable recovery protocol.
  }
}

export function observeLegacyColdAdapters(adapters, report, now = Date.now) {
  return Object.fromEntries(
    Object.entries(adapters).map(([stage, operation]) => [
      stage,
      stages.includes(stage) && typeof operation === 'function'
        ? async (...args) => {
            const startedAt = now();
            emitLegacyColdDiagnostic(report, { stage, event: 'begin' });
            try {
              const result = await operation.apply(adapters, args);
              emitLegacyColdDiagnostic(report, {
                stage,
                event: 'complete',
                elapsedMs: now() - startedAt,
              });
              return result;
            } catch (error) {
              emitLegacyColdDiagnostic(report, {
                stage,
                event: 'failed',
                elapsedMs: now() - startedAt,
                error,
              });
              throw error;
            }
          }
        : operation,
    ]),
  );
}

function assertProof(value, name) {
  if (!value || value.version !== 1 || value.complete !== true) throw new Error(`${name}_unproved`);
  return value;
}

function assertBinding(value, bindings, name) {
  assertProof(value, name);
  if (
    value.sourceSha !== bindings.targetSha ||
    value.imageId !== bindings.targetImageId ||
    value.selectionDigest !== bindings.selectionDigest ||
    value.controllerNonce !== bindings.controllerNonce
  )
    throw new Error(`${name}_binding_unproved`);
  return value;
}

export function assertLegacyColdStopped(value, bindings) {
  assertBinding(value, bindings, 'stopped_inventory');
  if (
    !Array.isArray(value.services) ||
    value.services.length !== LEGACY_COLD_API_SERVICES.length ||
    LEGACY_COLD_API_SERVICES.some(
      (name) =>
        value.services.filter(
          (row) =>
            row.serviceName === name &&
            row.stopped === true &&
            row.exactGeneration === true &&
            row.restartPolicy === 'unless-stopped',
        ).length !== 1,
    ) ||
    !Array.isArray(value.auxiliaries) ||
    value.auxiliaries.length !== 2 ||
    ['ocr-native-sandbox', 'photo-native-sandbox'].some(
      (name) =>
        value.auxiliaries.filter(
          (row) =>
            row.serviceName === name &&
            row.stopped === true &&
            row.exactGeneration === true &&
            row.restartPolicy === 'unless-stopped',
        ).length !== 1,
    ) ||
    value.unreviewedProducers !== 0
  )
    throw new Error('stopped_inventory_unproved');
  return value;
}

function assertFence(value, bindings) {
  assertBinding(value, bindings, 'queue_fence');
  if (
    value.queueCount !== 24 ||
    value.pausedCount !== 24 ||
    value.activeCount !== 0 ||
    value.ownerNonce !== bindings.controllerNonce
  )
    throw new Error('queue_fence_unproved');
  return value;
}

function assertPending(value, bindings) {
  assertBinding(value, bindings, 'pending_inventory');
  if (
    !/^[0-9a-f]{64}$/u.test(value.previewDigest ?? '') ||
    !/^[0-9a-f]{64}$/u.test(value.inventoryDigest ?? '') ||
    value.unknownSources !== 0 ||
    value.saturated !== false
  )
    throw new Error('pending_inventory_unproved');
  return value;
}

function context({ store, adapters }) {
  if (!store || !adapters || stages.some((name) => typeof adapters[name] !== 'function'))
    throw new Error('invalid_protocol_request');
}

async function contain(store, bindings, adapters) {
  const containment = [];
  // FLAG: Stop first: a failed post-resume smoke must not leave producers live
  // while slower store cleanup is attempted. Never restore the old baseline.
  for (const name of ['stopRuntime', 'removeStoreClient', 'pauseQueues']) {
    try {
      await adapters[name](bindings);
      containment.push({ name, confirmed: true });
    } catch {
      containment.push({ name, confirmed: false });
    }
  }
  try {
    assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
  } catch {
    containment.push({ name: 'stopped_readback', confirmed: false });
  }
  try {
    assertFence(await adapters.readQueueFence(bindings), bindings);
  } catch {
    containment.push({ name: 'paused_readback', confirmed: false });
  }
  try {
    const journal = store.read().journal;
    if (journal && journal.phase !== 'COMPLETE')
      store.block(legacyColdDigest(journal), 'protocol_proof_failed', {
        revocation: store.recordProof({ version: 1, containment }),
      });
  } catch {
    containment.push({ name: 'journal_block', confirmed: false });
  }
  return containment;
}

// FLAG: Successful online admission precedes this operation. Cold preview
// intentionally leaves every producer stopped for exact evidence review.
export async function prepareLegacyColdRecovery({ store, bindings, adapters }) {
  context({ store, adapters });
  let admitted = false;
  try {
    const baseline = assertBinding(await adapters.inspectRuntime(bindings), bindings, 'baseline');
    if (
      baseline.compatible !== true ||
      baseline.singletonCount !== 14 ||
      baseline.nativeCount !== 2 ||
      baseline.unreviewedProducers !== 0
    )
      throw new Error('baseline_unproved');
    if (legacyColdDigest(baseline) !== bindings.baselineDigest) throw new Error('baseline_changed');
    // FLAG: Mark possible admission before the first durable write, including an fsync
    // whose success response is lost. Containment never restarts on uncertainty.
    admitted = true;
    let journal = store.admit(bindings, store.recordProof(baseline));
    journal = store.advance(legacyColdDigest(journal), 'STOPPING');
    await adapters.stopRuntime(bindings);
    const stopped = assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    journal = store.advance(legacyColdDigest(journal), 'STOPPED', {
      stoppedInventory: store.recordProof(stopped),
    });
    await adapters.pauseQueues(bindings);
    assertFence(await adapters.readQueueFence(bindings), bindings);
    const pending = assertPending(await adapters.snapshotPending(bindings), bindings);
    await adapters.removeStoreClient(bindings);
    journal = store.advance(legacyColdDigest(journal), 'INVENTORIED', {
      pendingInventory: store.recordProof(pending),
      reviewedPreview: store.recordProof({
        version: 1,
        previewDigest: pending.previewDigest,
        inventoryDigest: pending.inventoryDigest,
        selectionDigest: bindings.selectionDigest,
      }),
    });
    return {
      version: 1,
      prepared: true,
      phase: journal.phase,
      previewDigest: pending.previewDigest,
      inventoryDigest: pending.inventoryDigest,
      journalDigest: legacyColdDigest(journal),
    };
  } catch (cause) {
    const containment = admitted ? await contain(store, bindings, adapters) : [];
    throw Object.assign(new Error('Cold preview refused; no producers were resumed', { cause }), {
      containment,
    });
  }
}

export async function retryLegacyColdPreview({ store, adapters, expectedJournalDigest }) {
  context({ store, adapters });
  const initial = store.read().journal;
  if (
    !initial ||
    !['ADMITTED', 'STOPPING', 'STOPPED', 'INVENTORIED'].includes(initial.phase) ||
    legacyColdDigest(initial) !== expectedJournalDigest
  )
    throw new Error('preinstall_journal_unproved');
  const bindings = initial.bindings;
  try {
    await adapters.stopRuntime(bindings);
    await adapters.removeStoreClient(bindings);
    await adapters.pauseQueues(bindings);
    const stopped = assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    const fence = assertFence(await adapters.readQueueFence(bindings), bindings);
    let journal = store.retryPreinstall(expectedJournalDigest, {
      stoppedInventory: store.recordProof(stopped),
      repausedQueues: store.recordProof(fence),
    });
    const fresh = assertPending(await adapters.snapshotPending(bindings), bindings);
    const pending = Object.fromEntries(
      Object.entries(fresh).filter(([name]) => name !== 'recheckProof'),
    );
    await adapters.removeStoreClient(bindings);
    journal = store.advance(legacyColdDigest(journal), 'INVENTORIED', {
      pendingInventory: store.recordProof(pending),
      reviewedPreview: store.recordProof({
        version: 1,
        previewDigest: pending.previewDigest,
        inventoryDigest: pending.inventoryDigest,
        selectionDigest: bindings.selectionDigest,
      }),
    });
    return {
      version: 1,
      prepared: true,
      phase: journal.phase,
      previewDigest: pending.previewDigest,
      inventoryDigest: pending.inventoryDigest,
      journalDigest: legacyColdDigest(journal),
    };
  } catch (cause) {
    const containment = await contain(store, bindings, adapters);
    throw Object.assign(
      new Error('Cold preview retry refused; producers remain stopped', { cause }),
      { containment },
    );
  }
}

export async function applyLegacyColdRecovery({
  store,
  adapters,
  expectedJournalDigest,
  reviewedPreviewDigest,
  reviewedInventoryDigest,
  reconcile = false,
}) {
  context({ store, adapters });
  const initial = store.read().journal;
  if (
    !initial ||
    (reconcile
      ? !['INSTALLING', 'SEALED', 'RESUMING'].includes(initial.phase)
      : initial.phase !== 'INVENTORIED' || initial.blockedReason) ||
    legacyColdDigest(initial) !== expectedJournalDigest ||
    !/^[0-9a-f]{64}$/u.test(reviewedPreviewDigest ?? '') ||
    !/^[0-9a-f]{64}$/u.test(reviewedInventoryDigest ?? '')
  )
    throw new Error('reviewed_journal_unproved');
  const bindings = initial.bindings;
  let journal = initial;
  const advance = (phase, proofs = {}) => {
    journal = store.advance(legacyColdDigest(journal), phase, proofs);
  };
  try {
    if (reconcile) {
      await adapters.stopRuntime(bindings);
      await adapters.removeStoreClient(bindings);
      await adapters.pauseQueues(bindings);
    }
    assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    assertFence(await adapters.readQueueFence(bindings), bindings);
    const pending = assertPending(
      reconcile ? store.readProof('pendingInventory') : await adapters.snapshotPending(bindings),
      bindings,
    );
    const { recheckProof, ...reviewedPending } = pending;
    if (
      pending.previewDigest !== reviewedPreviewDigest ||
      pending.inventoryDigest !== reviewedInventoryDigest ||
      store.recordProof(reviewedPending) !== journal.proofs.pendingInventory ||
      (recheckProof !== undefined && !/^[0-9a-f]{64}$/u.test(recheckProof))
    )
      throw new Error('reviewed_preview_changed');
    if (!reconcile) {
      advance('INSTALLING', recheckProof ? { pendingRecheck: recheckProof } : {});
      try {
        await adapters.installDispositions(bindings, pending);
      } catch (error) {
        if (error.outcomeUnknown !== true) throw error;
      }
    }
    // FLAG: The writer must be gone before an independent positive SQL readback,
    // even after reported success. An ambiguous response never permits replay.
    await adapters.removeStoreClient(bindings);
    const installed = assertBinding(
      await adapters.readSeal(bindings, pending),
      bindings,
      'installed_seal',
    );
    if (
      installed.previewDigest !== reviewedPreviewDigest ||
      installed.inventoryDigest !== reviewedInventoryDigest ||
      installed.permanentHoldsComplete !== true ||
      installed.ownerProofsComplete !== true
    )
      throw new Error('seal_readback_unproved');
    await adapters.materializeReceipts(bindings, pending, installed);
    await adapters.removeStoreClient(bindings);
    const seal = assertBinding(
      await adapters.readSeal(bindings, pending),
      bindings,
      'materialized_seal',
    );
    if (
      seal.previewDigest !== reviewedPreviewDigest ||
      seal.inventoryDigest !== reviewedInventoryDigest ||
      seal.permanentHoldsComplete !== true ||
      seal.ownerProofsComplete !== true ||
      seal.reviewedChatCursorsComplete !== true
    )
      throw new Error('materialization_readback_unproved');
    const stopped = assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    const fence = assertFence(await adapters.readQueueFence(bindings), bindings);
    if (reconcile)
      journal = store.reconcileSealed(legacyColdDigest(journal), {
        sealedReadback: store.recordProof(seal),
        restoppedInventory: store.recordProof(stopped),
        repausedQueues: store.recordProof(fence),
      });
    else advance('SEALED', { sealedReadback: store.recordProof(seal) });
    advance('RESUMING');
    await adapters.startBoundRuntime(bindings);
    const runtime = assertBinding(
      await adapters.readRuntimeIdentity(bindings),
      bindings,
      'runtime_identity',
    );
    const native = assertBinding(
      await adapters.readNativeIdentity(bindings),
      bindings,
      'native_identity',
    );
    if (
      runtime.exactGenerationCount !== 14 ||
      runtime.unreviewedProducers !== 0 ||
      native.exactGenerationCount !== 2
    )
      throw new Error('restarted_identity_unproved');
    await adapters.resumeQueues(bindings);
    const smokes = assertBinding(await adapters.strictSmokes(bindings), bindings, 'strict_smokes');
    const fleetReady =
      smokes.ingressReady === true &&
      smokes.adminReady === true &&
      smokes.actionableLagSeconds <= 10;
    // FLAG: Positive seal and cursor proof completes only this selected scope. A different
    // backlog may remain visible while the verified fleet runs; final release stays strict.
    if (
      (!fleetReady && !(smokes.dependenciesReady === true && smokes.queueBacklogOnly === true)) ||
      smokes.queuesResumed !== true ||
      smokes.actionableLagSeconds < 0 ||
      !Number.isFinite(smokes.actionableLagSeconds)
    )
      throw new Error('strict_smokes_unproved');
    advance('COMPLETE', {
      runtimeIdentity: store.recordProof(runtime),
      nativeIdentity: store.recordProof(native),
      strictSmokes: store.recordProof(smokes),
    });
    // FLAG: Release manifests are finalized separately through the existing guarded
    // finalizer after this complete journal permits ordinary host operations.
    return {
      version: 1,
      coldRecoveryComplete: true,
      fleetReady,
      releaseRecorded: false,
      journalDigest: legacyColdDigest(journal),
    };
  } catch (cause) {
    const containment = await contain(store, bindings, adapters);
    throw Object.assign(
      new Error('Cold recovery refused; no successful recovery is claimed', { cause }),
      { containment },
    );
  }
}
