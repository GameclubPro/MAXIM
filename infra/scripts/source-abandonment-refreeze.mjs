import { legacyColdDigest } from './legacy-cold-journal.mjs';
import { assertLegacyColdStopped } from './legacy-cold-protocol.mjs';

function assertFence(value, bindings) {
  if (
    !value ||
    value.version !== 1 ||
    value.complete !== true ||
    value.sourceSha !== bindings.targetSha ||
    value.imageId !== bindings.targetImageId ||
    value.controllerNonce !== bindings.controllerNonce ||
    value.selectionDigest !== bindings.selectionDigest ||
    value.queueCount !== 24 ||
    value.pausedCount !== 24 ||
    value.activeCount !== 0 ||
    value.ownerNonce !== bindings.controllerNonce
  )
    throw new Error('refreeze_queue_fence_unproved');
}

// FLAG: Refreezing is a separate review boundary, never permission to install.
// Both certificate reads use the immutable old artifact and the same writer image.
// Failures leave the old journal and all historical inventory artifacts intact.
export async function refreezeSourceAbandonmentPreview({ store, adapters, request }) {
  const initial = store.read().journal;
  if (
    !initial ||
    !['STOPPED', 'INVENTORIED'].includes(initial.phase) ||
    legacyColdDigest(initial) !== request.expectedJournalDigest ||
    !initial.proofs.pendingInventory ||
    !initial.proofs.reviewedPreview ||
    initial.proofs.supersededPreview
  )
    throw new Error('refreeze_preinstall_journal_required');
  const bindings = initial.bindings;
  const prior = store.readProof('pendingInventory');
  if (
    prior.inventoryDigest !== request.reviewedInventoryDigest ||
    prior.previewDigest !== request.reviewedPreviewDigest
  )
    throw new Error('refreeze_reviewed_inventory_required');
  try {
    await adapters.removeStoreClient(bindings);
    assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    assertFence(await adapters.readQueueFence(bindings), bindings);
    const before = await adapters.readCertificateAbsent(bindings, prior);
    const pending = await adapters.snapshotRefrozenPending(bindings, prior);
    const after = await adapters.readCertificateAbsent(bindings, prior);
    await adapters.removeStoreClient(bindings);
    assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    assertFence(await adapters.readQueueFence(bindings), bindings);
    if (legacyColdDigest(store.read().journal) !== request.expectedJournalDigest)
      throw new Error('refreeze_journal_changed');
    const refreezeAbsence = store.recordProof({
      version: 1,
      operation: 'refreeze-certificate-absence',
      certificateId: bindings.certificateId,
      sourceSha: bindings.targetSha,
      imageId: bindings.targetImageId,
      controllerNonce: bindings.controllerNonce,
      selectionDigest: bindings.selectionDigest,
      inventoryDigest: prior.inventoryDigest,
      previewDigest: prior.previewDigest,
      before,
      after,
    });
    const pendingInventory = store.recordProof(pending);
    const reviewedPreview = store.recordProof({
      version: 1,
      previewDigest: pending.previewDigest,
      inventoryDigest: pending.inventoryDigest,
      selectionDigest: bindings.selectionDigest,
    });
    const supersededPreview = store.recordProof({
      version: 1,
      operation: 'refreeze-preview',
      previousJournal: initial,
      previousJournalDigest: request.expectedJournalDigest,
      previousPendingInventory: initial.proofs.pendingInventory,
      previousReviewedPreview: initial.proofs.reviewedPreview,
      previousArtifactSha256: prior.inventoryArtifactSha256,
      replacementPendingInventory: pendingInventory,
      replacementReviewedPreview: reviewedPreview,
      absenceProof: refreezeAbsence,
    });
    const journal = store.refreezePreinstall(request.expectedJournalDigest, {
      supersededPreview,
      refreezeAbsence,
      pendingInventory,
      reviewedPreview,
    });
    return {
      version: 1,
      operation: 'refreeze-preview',
      prepared: true,
      installed: false,
      phase: journal.phase,
      previousInventoryDigest: prior.inventoryDigest,
      inventoryDigest: pending.inventoryDigest,
      previewDigest: pending.previewDigest,
      inventoryArtifactSha256: pending.inventoryArtifactSha256,
      journalDigest: legacyColdDigest(journal),
      supersededPreview,
      independentReviewRequired: true,
    };
  } finally {
    await adapters.removeStoreClient(bindings);
  }
}
