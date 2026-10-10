import { legacyColdDigest } from './legacy-cold-journal.mjs';
import { assertLegacyColdStopped } from './legacy-cold-protocol.mjs';
import { canonicalLegacyColdDigest } from './legacy-cold-store-adapter.mjs';
import { parseSourceAbandonmentHostRequest } from './source-abandonment-host.mjs';

const hash = /^[0-9a-f]{64}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const phases = ['PENDING', 'REVIEWED', 'ATTEMPTED', 'MATERIALIZED'];
const proofNames = [
  'pendingInventory',
  'reviewedPreview',
  'pendingRecheck',
  'attemptEvidence',
  'installedSeal',
  'materializedSeal',
  'stoppedInventory',
  'queueFence',
  'clientRemoval',
  'failureEvidence',
];
const storeMethods = [
  'read',
  'readProof',
  'recordProof',
  'markAttempted',
  'markMaterialized',
  'block',
];
const adapterMethods = [
  'readStoppedRuntime',
  'readQueueFence',
  'snapshotPending',
  'installDispositions',
  'removeStoreClient',
  'readSeal',
  'materializeReceipts',
];
function requireFact(value, code = 'session_child_record_unproved') {
  if (!value) throw new Error(code);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keysExactly(value, keys) {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function identity(child) {
  return {
    version: child.version,
    kind: child.kind,
    sessionId: child.sessionId,
    manifestDigest: child.manifestDigest,
    childIndex: child.childIndex,
    bindings: child.bindings,
    selection: child.selection,
  };
}
const identityDigest = (child) => legacyColdDigest(identity(child));
const proofDigest = (proof) => legacyColdDigest(`${JSON.stringify(proof)}\n`);

// FLAG: This record is a child of a separately fenced maintenance session. It is
// never a legacy journal and MATERIALIZED never opens the host maintenance guard.
export function validateSourceAbandonmentSessionChild(value, now = Date.now()) {
  requireFact(
    keysExactly(value, [
      'version',
      'kind',
      'sessionId',
      'manifestDigest',
      'childIndex',
      'revision',
      'phase',
      'bindings',
      'selection',
      'proofs',
      'blockedReason',
    ]),
  );
  requireFact(
    value.version === 1 &&
      value.kind === 'source_abandonment_session_child' &&
      uuid.test(value.sessionId ?? '') &&
      hash.test(value.manifestDigest ?? '') &&
      Number.isSafeInteger(value.childIndex) &&
      value.childIndex >= 0 &&
      value.childIndex < 10000 &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 1 &&
      phases.includes(value.phase) &&
      [null, 'child_proof_failed'].includes(value.blockedReason),
  );
  const bindings = value.bindings;
  requireFact(
    keysExactly(bindings, [
      'clusterIdentity',
      'epoch',
      'controllerNonce',
      'certificateId',
      'baselineDigest',
      'sourceSha',
      'targetSha',
      'targetImageId',
      'topologyDigest',
      'selectionDigest',
    ]),
  );
  requireFact(
    uuid.test(bindings.clusterIdentity ?? '') &&
      uuid.test(bindings.controllerNonce ?? '') &&
      uuid.test(bindings.certificateId ?? '') &&
      Number.isSafeInteger(bindings.epoch) &&
      bindings.epoch >= 1 &&
      ['baselineDigest', 'topologyDigest', 'selectionDigest'].every((key) =>
        hash.test(bindings[key] ?? ''),
      ) &&
      /^[0-9a-f]{40}$/u.test(bindings.targetSha ?? '') &&
      bindings.sourceSha === bindings.targetSha &&
      /^sha256:[0-9a-f]{64}$/u.test(bindings.targetImageId ?? ''),
  );
  const parsed = parseSourceAbandonmentHostRequest(
    JSON.stringify({
      version: 1,
      operation: 'preflight',
      targetSha: bindings.targetSha,
      selection: value.selection,
    }),
    now,
  ).selection;
  requireFact(
    legacyColdDigest(value.selection) === bindings.selectionDigest &&
      canonicalLegacyColdDigest(parsed) === canonicalLegacyColdDigest(value.selection),
  );
  requireFact(
    object(value.proofs) &&
      Object.entries(value.proofs).every(
        ([name, digest]) => proofNames.includes(name) && hash.test(digest ?? ''),
      ),
  );
  const required = value.phase === 'PENDING' ? [] : ['pendingInventory', 'reviewedPreview'];
  if (['ATTEMPTED', 'MATERIALIZED'].includes(value.phase)) required.push('attemptEvidence');
  if (value.phase === 'MATERIALIZED')
    required.push(
      'installedSeal',
      'materializedSeal',
      'stoppedInventory',
      'queueFence',
      'clientRemoval',
    );
  requireFact(
    required.every((key) => value.proofs[key]) &&
      (value.phase !== 'MATERIALIZED' || value.blockedReason === null),
  );
  return value;
}

// The existing adapter consumes only journal/proof reads. Expose the real typed
// child bytes so its frozen inventory binds this child, never a sibling or parent.
export function createSourceAbandonmentChildStoreView(store) {
  requireFact(
    storeMethods.every((name) => typeof store?.[name] === 'function'),
    'session_child_store_required',
  );
  return Object.freeze({
    read: () => ({ journal: validateSourceAbandonmentSessionChild(store.read().child) }),
    readProof: (name) => store.readProof(name),
    recordProof: (value) => store.recordProof(value),
  });
}
function boundProof(value, bindings, name) {
  requireFact(
    value?.version === 1 &&
      value.complete === true &&
      value.sourceSha === bindings.targetSha &&
      value.imageId === bindings.targetImageId &&
      value.controllerNonce === bindings.controllerNonce &&
      value.selectionDigest === bindings.selectionDigest,
    `${name}_binding_unproved`,
  );
  return value;
}
function fenceProof(value, bindings) {
  boundProof(value, bindings, 'session_child_fence');
  requireFact(
    value.queueCount === 24 &&
      value.pausedCount === 24 &&
      value.activeCount === 0 &&
      value.ownerNonce === bindings.controllerNonce,
    'session_child_fence_unproved',
  );
  return value;
}
function pendingProof(value, child, previewDigest, inventoryDigest) {
  boundProof(value, child.bindings, 'session_child_pending');
  requireFact(
    value.previewDigest === previewDigest &&
      value.inventoryDigest === inventoryDigest &&
      value.unknownSources === 0 &&
      value.saturated === false &&
      hash.test(value.inventoryArtifactSha256 ?? ''),
    'session_child_pending_unproved',
  );
  const binding = value.inventory?.binding;
  requireFact(
    binding?.maintenanceId === child.bindings.controllerNonce &&
      binding.queueFenceNonce === legacyColdDigest(child.bindings.controllerNonce) &&
      binding.sourceSha === child.bindings.targetSha &&
      binding.imageId === child.bindings.targetImageId &&
      hash.test(binding.transitionJournalSha256 ?? ''),
    'session_child_inventory_binding_unproved',
  );
  const owners = value.inventory?.selectedOwners;
  const expected = child.selection.ownerWebhookEventIds;
  requireFact(
    Array.isArray(owners) &&
      owners.length === expected.length &&
      new Set(owners.map((row) => row.ownerWebhookEventId)).size === expected.length &&
      owners.every((row) => expected.includes(row.ownerWebhookEventId)),
    'session_child_selection_unproved',
  );
  return value;
}
function sealProof(value, child, pending, complete) {
  boundProof(value, child.bindings, 'session_child_seal');
  requireFact(
    value.previewDigest === pending.previewDigest &&
      value.inventoryDigest === pending.inventoryDigest &&
      value.permanentHoldsComplete === true &&
      value.ownerProofsComplete === true &&
      typeof value.reviewedChatCursorsComplete === 'boolean' &&
      (!complete || value.reviewedChatCursorsComplete),
    'session_child_seal_unproved',
  );
  return value;
}
function envelope(child, kind, proof) {
  return {
    version: 1,
    kind,
    childBindingDigest: identityDigest(child),
    certificateId: child.bindings.certificateId,
    proof,
  };
}
function persistProof(store, value) {
  const digest = store.recordProof(value);
  requireFact(digest === proofDigest(value), 'session_child_proof_persistence_unproved');
  return digest;
}
function readProof(store, child, name) {
  const value = store.readProof(name);
  requireFact(proofDigest(value) === child.proofs[name], 'session_child_retained_proof_changed');
  return value;
}
function transition(store, initial, phase, proofs) {
  const method = phase === 'ATTEMPTED' ? 'markAttempted' : 'markMaterialized';
  const written = store[method](legacyColdDigest(initial), proofs);
  const readback = validateSourceAbandonmentSessionChild(store.read().child);
  requireFact(
    legacyColdDigest(written) === legacyColdDigest(readback) &&
      identityDigest(initial) === identityDigest(readback) &&
      readback.phase === phase &&
      readback.revision === initial.revision + 1 &&
      readback.blockedReason === null &&
      Object.entries(initial.proofs).every(([name, digest]) => readback.proofs[name] === digest) &&
      Object.entries(proofs).every(([name, digest]) => readback.proofs[name] === digest),
    'session_child_transition_unproved',
  );
  return readback;
}

// FLAG: Only the parent owns stop/start, pause/resume, common maintenance guard,
// cumulative work budgets, global source conflicts and final fleet acceptance.
// No runtime-changing callback is invoked here, including on failure.
export async function runSourceAbandonmentSessionChild({
  store,
  adapters,
  expectedChildDigest,
  reviewedPreviewDigest,
  reviewedInventoryDigest,
  reconcile = false,
}) {
  requireFact(
    storeMethods.every((name) => typeof store?.[name] === 'function') &&
      adapterMethods.every((name) => typeof adapters?.[name] === 'function'),
    'session_child_context_required',
  );
  let child = validateSourceAbandonmentSessionChild(store.read().child);
  requireFact(
    hash.test(expectedChildDigest ?? '') &&
      legacyColdDigest(child) === expectedChildDigest &&
      hash.test(reviewedPreviewDigest ?? '') &&
      hash.test(reviewedInventoryDigest ?? '') &&
      typeof reconcile === 'boolean' &&
      (reconcile
        ? ['ATTEMPTED', 'MATERIALIZED'].includes(child.phase)
        : child.phase === 'REVIEWED' && child.blockedReason === null),
    'session_child_review_required',
  );
  const originalIdentity = identityDigest(child);
  const bindings = child.bindings;
  const retained = pendingProof(
    readProof(store, child, 'pendingInventory'),
    child,
    reviewedPreviewDigest,
    reviewedInventoryDigest,
  );
  const review = readProof(store, child, 'reviewedPreview');
  requireFact(
    review?.version === 1 &&
      review.previewDigest === reviewedPreviewDigest &&
      review.inventoryDigest === reviewedInventoryDigest &&
      review.selectionDigest === bindings.selectionDigest,
    'session_child_review_changed',
  );
  try {
    await adapters.removeStoreClient(bindings);
    assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    fenceProof(await adapters.readQueueFence(bindings), bindings);
    let pending = retained;
    if (!reconcile) {
      pending = pendingProof(
        await adapters.snapshotPending(bindings),
        child,
        reviewedPreviewDigest,
        reviewedInventoryDigest,
      );
      const { recheckProof, ...reviewedPending } = pending;
      requireFact(
        proofDigest(reviewedPending) === child.proofs.pendingInventory &&
          (recheckProof === undefined || hash.test(recheckProof)),
        'session_child_preview_changed',
      );
      await adapters.removeStoreClient(bindings);
      // FLAG: An acknowledged durable attempt marker precedes the entire existing
      // create/install operation. Lost marker or writer responses never permit replay.
      const attemptEvidence = persistProof(
        store,
        envelope(child, 'source_abandonment_child_attempt', {
          beforeChildDigest: legacyColdDigest(child),
          pendingInventory: child.proofs.pendingInventory,
          reviewedPreview: child.proofs.reviewedPreview,
        }),
      );
      child = transition(store, child, 'ATTEMPTED', {
        attemptEvidence,
        ...(recheckProof ? { pendingRecheck: recheckProof } : {}),
      });
      try {
        await adapters.installDispositions(bindings, pending);
      } catch (error) {
        if (error?.outcomeUnknown !== true) throw error;
      }
    }
    await adapters.removeStoreClient(bindings);
    const installed = sealProof(await adapters.readSeal(bindings, pending), child, pending, false);
    if (child.phase === 'MATERIALIZED')
      requireFact(installed.reviewedChatCursorsComplete, 'session_child_completed_cursor_changed');
    if (!installed.reviewedChatCursorsComplete)
      await adapters.materializeReceipts(bindings, pending, installed);
    await adapters.removeStoreClient(bindings);
    const materialized = sealProof(
      await adapters.readSeal(bindings, pending),
      child,
      pending,
      true,
    );
    await adapters.removeStoreClient(bindings);
    const stopped = assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    const fence = fenceProof(await adapters.readQueueFence(bindings), bindings);
    await adapters.removeStoreClient(bindings);
    const proofs = {
      installedSeal: persistProof(
        store,
        envelope(child, 'source_abandonment_child_installed_seal', installed),
      ),
      materializedSeal: persistProof(
        store,
        envelope(child, 'source_abandonment_child_materialized_seal', materialized),
      ),
      stoppedInventory: persistProof(
        store,
        envelope(child, 'source_abandonment_child_stopped', stopped),
      ),
      queueFence: persistProof(store, envelope(child, 'source_abandonment_child_fence', fence)),
      clientRemoval: persistProof(
        store,
        envelope(child, 'source_abandonment_child_client_removal', { complete: true }),
      ),
    };
    if (child.phase !== 'MATERIALIZED') child = transition(store, child, 'MATERIALIZED', proofs);
    else {
      const current = validateSourceAbandonmentSessionChild(store.read().child);
      requireFact(legacyColdDigest(current) === legacyColdDigest(child), 'session_child_changed');
    }
    return {
      version: 1,
      operation: 'source_abandonment_session_child',
      childMaterialized: true,
      reconciled: reconcile,
      childDigest: legacyColdDigest(child),
      evidence: proofs,
      runtimeStarted: false,
      queuesResumed: false,
      parentComplete: false,
      fleetRecoveryProven: false,
    };
  } catch (cause) {
    const containment = {
      clientRemoved: false,
      stoppedProven: false,
      fenceProven: false,
      journalBlocked: false,
    };
    try {
      await adapters.removeStoreClient(bindings);
      containment.clientRemoved = true;
    } catch {
      /* Parent must contain. */
    }
    try {
      assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
      containment.stoppedProven = true;
    } catch {
      /* Parent must contain. */
    }
    try {
      fenceProof(await adapters.readQueueFence(bindings), bindings);
      containment.fenceProven = true;
    } catch {
      /* Parent must contain. */
    }
    try {
      await adapters.removeStoreClient(bindings);
    } catch {
      containment.clientRemoved = false;
    }
    try {
      const current = validateSourceAbandonmentSessionChild(store.read().child);
      requireFact(identityDigest(current) === originalIdentity, 'session_child_changed');
      const failureEvidence = persistProof(
        store,
        envelope(current, 'source_abandonment_child_failure', containment),
      );
      store.block(legacyColdDigest(current), 'child_proof_failed', { failureEvidence });
      containment.journalBlocked = true;
    } catch {
      /* Preserve uncertain child and original error; parent remains fenced. */
    }
    throw Object.assign(new Error('session_child_refused', { cause }), {
      containment,
      parentContainmentRequired: true,
      runtimeStarted: false,
      queuesResumed: false,
    });
  }
}
