import { legacyColdDigest } from './legacy-cold-journal.mjs';
import { assertLegacyColdStopped } from './legacy-cold-protocol.mjs';

function bound(value, bindings, name) {
  if (
    value?.version !== 1 ||
    value.complete !== true ||
    value.sourceSha !== bindings.targetSha ||
    value.imageId !== bindings.targetImageId ||
    value.controllerNonce !== bindings.controllerNonce ||
    value.selectionDigest !== bindings.selectionDigest
  )
    throw new Error(`${name}_unproved`);
  return value;
}
function fence(value, bindings) {
  bound(value, bindings, 'abort_fence');
  if (
    value.queueCount !== 24 ||
    value.pausedCount !== 24 ||
    value.activeCount !== 0 ||
    value.ownerNonce !== bindings.controllerNonce
  )
    throw new Error('abort_fence_unproved');
  return value;
}
const forbidden = [
  'pendingRecheck',
  'sealedReadback',
  'releaseManifest',
  'runtimeIdentity',
  'nativeIdentity',
  'strictSmokes',
];

// FLAG: Abort proves that installation never began and the exact certificate is
// absent. It restores only captured generations and never claims queue recovery.
export async function abortSourceAbandonmentPreinstall({ store, adapters, expectedJournalDigest }) {
  const original = store.read().journal;
  if (
    !original ||
    !['STOPPED', 'INVENTORIED', 'ABORTING'].includes(original.phase) ||
    legacyColdDigest(original) !== expectedJournalDigest ||
    forbidden.some((name) => original.proofs[name])
  )
    throw new Error('abort_preinstall_journal_unproved');
  const retained = ['pendingInventory', 'reviewedPreview', 'supersededPreview', 'refreezeAbsence'];
  if (
    (original.phase === 'STOPPED' && retained.some((name) => original.proofs[name])) ||
    (original.phase === 'INVENTORIED' &&
      (!original.proofs.pendingInventory ||
        !original.proofs.reviewedPreview ||
        Boolean(original.proofs.supersededPreview) !== Boolean(original.proofs.refreezeAbsence)))
  )
    throw new Error('abort_preinstall_journal_unproved');
  const bindings = original.bindings;
  const base = {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    controllerNonce: bindings.controllerNonce,
    selectionDigest: bindings.selectionDigest,
  };
  try {
    await adapters.stopRuntime(bindings);
    await adapters.removeStoreClient(bindings);
    const stopped = assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    // This is the existing operation's fence, not a new queue adoption.
    const paused = fence(await adapters.readQueueFence(bindings), bindings);
    const reads = [];
    for (let index = 0; index < 2; index++) {
      const proof = await adapters.readAbortCertificateAbsent(bindings);
      if (
        proof?.version !== 1 ||
        proof.state !== 'ABSENT' ||
        proof.readOnly !== true ||
        proof.certificateId !== bindings.certificateId ||
        proof.sourceSha !== bindings.targetSha ||
        proof.imageId !== bindings.targetImageId
      )
        throw new Error('abort_certificate_absence_unproved');
      reads.push(proof);
      await adapters.removeStoreClient(bindings);
    }
    assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    fence(await adapters.readQueueFence(bindings), bindings);
    const journal = store.beginAbortPreinstall(expectedJournalDigest, {
      abortOrigin:
        original.phase === 'ABORTING'
          ? original.proofs.abortOrigin
          : store.recordProof({
              version: 1,
              operation: 'abort-before-install',
              journal: original,
              journalDigest: expectedJournalDigest,
            }),
      abortAbsence: store.recordProof({
        ...base,
        operation: 'abort-before-install',
        certificateId: bindings.certificateId,
        reads,
      }),
      stoppedInventory: store.recordProof(stopped),
      repausedQueues: store.recordProof(paused),
    });
    await adapters.startBoundRuntime(bindings);
    const runtime = bound(await adapters.readRuntimeIdentity(bindings), bindings, 'abort_runtime');
    const native = bound(await adapters.readNativeIdentity(bindings), bindings, 'abort_native');
    if (
      runtime.exactGenerationCount !== 14 ||
      runtime.unreviewedProducers !== 0 ||
      native.exactGenerationCount !== 2
    )
      throw new Error('abort_restarted_identity_unproved');
    await adapters.resumeQueues(bindings);
    const smokes = bound(await adapters.strictSmokes(bindings), bindings, 'abort_smokes');
    const fleetReady =
      smokes.ingressReady === true &&
      smokes.adminReady === true &&
      smokes.actionableLagSeconds <= 10;
    if (
      (!fleetReady && !(smokes.dependenciesReady === true && smokes.queueBacklogOnly === true)) ||
      smokes.queuesResumed !== true ||
      !Number.isFinite(smokes.actionableLagSeconds) ||
      smokes.actionableLagSeconds < 0
    )
      throw new Error('abort_smokes_unproved');
    const complete = store.finishAbortPreinstall(legacyColdDigest(journal), {
      runtimeIdentity: store.recordProof(runtime),
      nativeIdentity: store.recordProof(native),
      strictSmokes: store.recordProof(smokes),
    });
    return {
      version: 1,
      operation: 'abort-before-install',
      aborted: true,
      installed: false,
      coldRecoveryComplete: false,
      fleetReady,
      releaseRecorded: false,
      journalDigest: legacyColdDigest(complete),
    };
  } catch (cause) {
    // FLAG: A failed restart/absence check cannot leave producers running beside
    // uncertain state. Preserve ABORTING for a separately reviewed retry.
    for (const action of ['stopRuntime', 'removeStoreClient', 'pauseQueues']) {
      try {
        await adapters[action](bindings);
      } catch {
        /* Preserve original failure and durable phase. */
      }
    }
    throw new Error('Preinstall abort refused; inspect unchanged durable evidence', { cause });
  }
}
