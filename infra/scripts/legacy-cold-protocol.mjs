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
    // Mark possible admission before the first durable write, including an fsync
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
    if (
      smokes.ingressReady !== true ||
      smokes.adminReady !== true ||
      smokes.queuesResumed !== true ||
      smokes.actionableLagSeconds > 10 ||
      smokes.actionableLagSeconds < 0 ||
      !Number.isFinite(smokes.actionableLagSeconds)
    )
      throw new Error('strict_smokes_unproved');
    advance('COMPLETE', {
      runtimeIdentity: store.recordProof(runtime),
      nativeIdentity: store.recordProof(native),
      strictSmokes: store.recordProof(smokes),
    });
    // Release manifests are finalized separately through the existing guarded
    // finalizer after this complete journal permits ordinary host operations.
    return {
      version: 1,
      coldRecoveryComplete: true,
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
