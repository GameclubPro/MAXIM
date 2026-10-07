import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { legacyColdDigest } from './legacy-cold-journal.mjs';
import { emitLegacyColdDiagnostic } from './legacy-cold-protocol.mjs';

const hash = /^[0-9a-f]{64}$/u;
export function canonicalLegacyColdDigest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, canonical(val)]),
      );
    return item;
  };
  return legacyColdDigest(canonical(value));
}

function immutableInventory(path, value) {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('inventory_artifact_budget');
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== Buffer.byteLength(bytes) ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid() ||
        readFileSync(fd, 'utf8') !== bytes
      )
        throw new Error('inventory_artifact_changed');
      return legacyColdDigest(bytes);
    } finally {
      closeSync(fd);
    }
  }
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return legacyColdDigest(bytes);
}

// FLAG: Host previews are read-only. Only the fixed writer image can install the
// reviewed finite inventory; every writer result is followed by independent SQL
// readback after the exact disposable client has been removed.
export function createLegacyColdStoreAdapter({
  store,
  client,
  runtime,
  bindings,
  selection,
  publisherBotId,
  inventoryPath,
  now = Date.now,
  report,
}) {
  const base = {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    controllerNonce: bindings.controllerNonce,
    selectionDigest: bindings.selectionDigest,
  };
  if (legacyColdDigest(selection) !== bindings.selectionDigest)
    throw new Error('selection_binding_unproved');
  let currentPending = null;
  const pending = () => currentPending ?? store.readProof('pendingInventory');
  const request = (operation, value = pending(), page) => ({
    version: 1,
    operation,
    certificateId: bindings.certificateId,
    binding: value.inventory.binding,
    selection,
    expected: {
      inventorySha256: value.inventoryDigest,
      previewSha256: value.previewDigest,
      inventoryArtifactSha256: value.inventoryArtifactSha256,
    },
    ...(page ? { page } : {}),
  });
  const invoke = (operation, value, page) => {
    const input = request(operation, value, page);
    const result = client.invoke('store', input);
    if (
      result.version !== 1 ||
      result.operation !== operation ||
      result.certificateId !== bindings.certificateId ||
      result.activationAuthorized !== false ||
      result.bindingSha256 !== canonicalLegacyColdDigest(input.binding) ||
      result.inventorySha256 !== input.expected.inventorySha256 ||
      result.previewSha256 !== input.expected.previewSha256
    )
      throw new Error('store_result_binding_unproved');
    return result;
  };
  return {
    removeStoreClient: () => client.remove(),
    pauseQueues: () => client.invoke('queues', { version: 1, operation: 'pause' }),
    readQueueFence() {
      const result = client.invoke('queues', { version: 1, operation: 'wait-drained' });
      return { ...base, ...result, ownerNonce: bindings.controllerNonce };
    },
    resumeQueues() {
      const result = client.invoke('queues', { version: 1, operation: 'resume' });
      if (result.pausedCount !== 0) throw new Error('queue_resume_unproved');
      const readback = client.invoke('queues', { version: 1, operation: 'status' });
      if (readback.pausedCount !== 0 || readback.ownerPresent !== false)
        throw new Error('queue_resume_readback_unproved');
    },
    snapshotPending() {
      const journal = store.read().journal;
      const prior = journal.proofs.pendingInventory ? store.readProof('pendingInventory') : null;
      const stopped = runtime.readStoppedRuntime();
      const binding = prior?.inventory.binding ?? {
        maintenanceId: bindings.controllerNonce,
        queueFenceNonce: legacyColdDigest(bindings.controllerNonce),
        transitionJournalSha256: legacyColdDigest(journal),
        sourceSha: bindings.targetSha,
        imageId: bindings.targetImageId,
        ...(publisherBotId ? { publisherBotId } : {}),
        stoppedGenerations: [...stopped.services, ...stopped.auxiliaries]
          .map(({ serviceName, containerId, imageId, sourceSha }) => ({
            serviceName,
            containerId,
            imageId,
            sourceSha,
            stopped: true,
          }))
          .sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
      };
      if (binding.publisherBotId !== publisherBotId)
        throw new Error('publisher_catalog_binding_changed');
      const inventory = client.invoke('inventory', {
        version: 1,
        operation: 'inventory_preview',
        binding,
        selection,
        ...(prior ? { expectedInventorySha256: prior.inventoryDigest } : {}),
      });
      if (
        inventory.operation !== 'inventory_preview' ||
        inventory.applied !== false ||
        inventory.activationAuthorized !== false ||
        inventory.decision !== 'READY_TO_INSTALL' ||
        canonicalLegacyColdDigest(inventory.binding) !== canonicalLegacyColdDigest(binding) ||
        inventory.selectionSha256 !== canonicalLegacyColdDigest(selection) ||
        !hash.test(inventory.inventorySha256 ?? '') ||
        !hash.test(inventory.previewSha256 ?? '') ||
        !Array.isArray(inventory.issues) ||
        inventory.issues.length !== 0 ||
        !Array.isArray(inventory.selectedOwners) ||
        inventory.selectedOwners.length !== selection.ownerWebhookEventIds.length ||
        new Set(inventory.selectedOwners.map((row) => row.ownerWebhookEventId)).size !==
          selection.ownerWebhookEventIds.length ||
        inventory.selectedOwners.some(
          (row) => !selection.ownerWebhookEventIds.includes(row.ownerWebhookEventId),
        )
      )
        throw new Error('inventory_refused');
      // FLAG: Query plans and cache costs can change between equivalent read-only
      // snapshots. Keep the reviewed artifact immutable and independently bind
      // the fresh diagnostic proof; all decision/source/child fields must agree.
      if (prior) {
        const semantic = (value) =>
          Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !['sqlPlans', 'cost'].includes(key))
              .map(([key, item]) => [
                key,
                key === 'redisCatalogs' && Array.isArray(item)
                  ? item.map((catalog) =>
                      Object.fromEntries(
                        Object.entries(catalog).filter(([field]) => field !== 'cost'),
                      ),
                    )
                  : item,
              ]),
          );
        if (
          canonicalLegacyColdDigest(semantic(inventory)) !==
            canonicalLegacyColdDigest(semantic(prior.inventory)) ||
          immutableInventory(inventoryPath, prior.inventory) !== prior.inventoryArtifactSha256
        )
          throw new Error('reviewed_inventory_changed');
        currentPending = { ...prior, recheckProof: store.recordProof(inventory) };
        return currentPending;
      }
      const artifactSha256 = immutableInventory(inventoryPath, inventory);
      currentPending = {
        ...base,
        inventoryDigest: inventory.inventorySha256,
        previewDigest: inventory.previewSha256,
        inventoryArtifactSha256: artifactSha256,
        unknownSources: 0,
        saturated: false,
        inventory,
      };
      return currentPending;
    },
    installDispositions(_bindings, value) {
      const initial = invoke('readback', value);
      if (initial.state !== 'ABSENT') throw new Error('certificate_already_exists');
      try {
        const created = invoke('certificate_create', value);
        if (created.state !== 'UNSEALED') throw new Error('certificate_creation_unproved');
      } catch (error) {
        if (error.outcomeUnknown !== true) throw error;
        client.remove();
        if (invoke('readback', value).state !== 'UNSEALED') throw error;
      }
      const result = invoke('install', value);
      if (!['SEALED', 'MATERIALIZED'].includes(result.state))
        throw new Error('installation_unproved');
    },
    readSeal(_bindings, value) {
      const result = invoke('readback', value);
      const sealed = ['SEALED', 'MATERIALIZED'].includes(result.state);
      return {
        ...base,
        previewDigest: value.previewDigest,
        inventoryDigest: value.inventoryDigest,
        permanentHoldsComplete: sealed,
        ownerProofsComplete: sealed,
        reviewedChatCursorsComplete:
          result.state === 'MATERIALIZED' &&
          result.completeChats === result.requiredChats &&
          result.requiredChats > 0,
      };
    },
    materializeReceipts(_bindings, value) {
      const deadline = now() + 120_000;
      let pages = 0;
      const chats = [...new Set(value.inventory.selectedOwners.map((row) => row.chatId))].sort();
      for (const [chatIndex, chatId] of chats.entries()) {
        let complete = false;
        while (!complete) {
          if (++pages > 200 || now() >= deadline) throw new Error('materialization_budget');
          const startedAt = now();
          const result = invoke('materialize', value, { chatId, pageSize: 200 });
          if (
            !result.page ||
            result.page.blocked !== false ||
            typeof result.page.complete !== 'boolean' ||
            result.cursor?.chatId !== chatId ||
            result.cursor.complete !== result.page.complete
          )
            throw new Error('materialization_page_unproved');
          complete = result.page.complete;
          emitLegacyColdDiagnostic(report, {
            stage: 'materializeReceipts',
            event: 'page',
            page: pages,
            chatOrdinal: chatIndex + 1,
            chatCount: chats.length,
            elapsedMs: now() - startedAt,
            scanned: result.page.scanned,
            applied: result.page.applied,
            complete,
          });
        }
      }
    },
  };
}
