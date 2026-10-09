import { canonicalLegacyColdDigest as canonical } from './legacy-cold-store-adapter.mjs';
import { legacyColdDigest } from './legacy-cold-journal.mjs';

const requireFact = (value, code) => {
  if (!value) throw new Error(code);
};
export function sourceAbandonmentSessionStoreRequest(bindings, selection, pending) {
  requireFact(
    legacyColdDigest(selection) === bindings.selectionDigest,
    'session_batch_selection_changed',
  );
  return {
    version: 1,
    operation: 'readback',
    certificateId: bindings.certificateId,
    binding: pending.inventory.binding,
    selection,
    expected: {
      inventorySha256: pending.inventoryDigest,
      previewSha256: pending.previewDigest,
      inventoryArtifactSha256: pending.inventoryArtifactSha256,
    },
  };
}
export function assertSourceAbandonmentSessionStoreResult(result, request, operation) {
  requireFact(
    result?.version === 1 &&
      result.operation === operation &&
      result.certificateId === request.certificateId &&
      result.activationAuthorized === false &&
      result.bindingSha256 === canonical(request.binding) &&
      result.inventorySha256 === request.expected.inventorySha256 &&
      result.previewSha256 === request.expected.previewSha256,
    'session_batch_result_binding_unproved',
  );
  return result;
}
export function sourceAbandonmentSessionStoreSeal(bindings, pending, request, result) {
  assertSourceAbandonmentSessionStoreResult(result, request, 'readback');
  const sealed = ['SEALED', 'MATERIALIZED'].includes(result.state);
  return {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    controllerNonce: bindings.controllerNonce,
    selectionDigest: bindings.selectionDigest,
    previewDigest: pending.previewDigest,
    inventoryDigest: pending.inventoryDigest,
    permanentHoldsComplete: sealed,
    ownerProofsComplete: sealed,
    reviewedChatCursorsComplete:
      result.state === 'MATERIALIZED' &&
      Number.isSafeInteger(result.requiredChats) &&
      result.requiredChats > 0 &&
      result.completeChats === result.requiredChats,
  };
}

// FLAG: The durable child ATTEMPTED marker remains outside this adapter. Each
// finite writer batch is removed by its transport before an independent stock
// read-only seal; a lost create/install acknowledgement never retries either write.
export function createSourceAbandonmentSessionStoreBatchAdapter({
  stockAdapter,
  client,
  bindings,
  selection,
  now = Date.now,
}) {
  const invoke = (phase, pending) => {
    const request = sourceAbandonmentSessionStoreRequest(bindings, selection, pending);
    const output = client.invoke('source-store-batch', {
      version: 1,
      kind: 'source_abandonment_session_store_batch',
      phase,
      deadlineAtMs: now() + (phase === 'install' ? 90_000 : 120_000),
      items: [{ inventoryIndex: 0, request }],
    });
    requireFact(
      output?.version === 1 &&
        output.kind === 'source_abandonment_session_store_batch_result' &&
        output.phase === phase &&
        output.results?.length === 1 &&
        output.results[0].inventoryIndex === 0 &&
        output.results[0].certificateId === bindings.certificateId,
      'session_batch_response_unproved',
    );
    return { request, item: output.results[0] };
  };
  return {
    ...stockAdapter,
    installDispositions(_bindings, pending) {
      const request = sourceAbandonmentSessionStoreRequest(bindings, selection, pending);
      const initial = assertSourceAbandonmentSessionStoreResult(
        client.invoke('store', request),
        request,
        'readback',
      );
      requireFact(initial.state === 'ABSENT', 'certificate_already_exists');
      const { item } = invoke('install', pending);
      const installed = assertSourceAbandonmentSessionStoreResult(item.result, request, 'install');
      requireFact(['SEALED', 'MATERIALIZED'].includes(installed.state), 'installation_unproved');
    },
    materializeReceipts(_bindings, pending) {
      const { request, item } = invoke('materialize', pending);
      requireFact(
        Array.isArray(item.pages) && item.pages.length > 0 && item.pages.length <= 200,
        'session_batch_materialization_budget',
      );
      const chats = [...new Set(pending.inventory.selectedOwners.map((row) => row.chatId))].sort();
      let chatIndex = 0;
      for (const page of item.pages) {
        assertSourceAbandonmentSessionStoreResult(page, request, 'materialize');
        requireFact(
          chatIndex < chats.length &&
            page.cursor?.chatId === chats[chatIndex] &&
            typeof page.page?.complete === 'boolean' &&
            page.page.blocked === false &&
            page.cursor.complete === page.page.complete &&
            Number.isSafeInteger(page.page.scanned) &&
            page.page.scanned >= 0 &&
            page.page.scanned <= 200 &&
            Number.isSafeInteger(page.page.applied) &&
            page.page.applied >= 0 &&
            page.page.applied <= page.page.scanned,
          'materialization_page_unproved',
        );
        if (page.page.complete) chatIndex += 1;
      }
      requireFact(
        chatIndex === chats.length && canonical(item.result) === canonical(item.pages.at(-1)),
        'session_batch_materialization_incomplete',
      );
    },
  };
}
