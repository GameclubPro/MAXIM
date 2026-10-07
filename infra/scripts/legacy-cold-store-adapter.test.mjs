import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { legacyColdDigest } from './legacy-cold-journal.mjs';
import {
  createLegacyColdStoreAdapter,
  canonicalLegacyColdDigest,
} from './legacy-cold-store-adapter.mjs';

function fixture(t, publisherBotId) {
  const dir = mkdtempSync(join(tmpdir(), 'maxim-cold-store-adapter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const selection = { ownerWebhookEventIds: ['owner'], majorBotIds: ['major'] };
  const bindings = {
    targetSha: 'a'.repeat(40),
    targetImageId: `sha256:${'b'.repeat(64)}`,
    controllerNonce: '11111111-1111-4111-8111-111111111111',
    certificateId: '22222222-2222-4222-8222-222222222222',
    selectionDigest: legacyColdDigest(selection),
  };
  const inventoryPath = join(dir, 'inventory.json');
  const state = {
    certificate: 'ABSENT',
    calls: [],
    pending: null,
    deny: false,
    lostCreate: false,
    wrongBinding: false,
    blocked: false,
    pages: 0,
    diagnostics: [],
    forever: false,
    diagnosticCost: 1,
    catalogs: undefined,
    ownerChat: 'chat',
  };
  const journal = { proofs: {} };
  const client = {
    remove() {
      state.calls.push('remove');
    },
    invoke(kind, request) {
      state.calls.push(request.operation);
      if (kind === 'inventory') {
        assert.equal(request.binding.queueFenceNonce, legacyColdDigest(bindings.controllerNonce));
        return {
          version: 1,
          operation: 'inventory_preview',
          applied: false,
          activationAuthorized: false,
          binding: request.binding,
          selectionSha256: canonicalLegacyColdDigest(selection),
          decision: state.deny ? 'DENY' : 'READY_TO_INSTALL',
          registrySha256: 'c'.repeat(64),
          inventorySha256: 'd'.repeat(64),
          previewSha256: 'e'.repeat(64),
          selectedOwners: [{ ownerWebhookEventId: 'owner', chatId: state.ownerChat }],
          children: [],
          sqlPlans: [],
          ...(state.catalogs ? { redisCatalogs: structuredClone(state.catalogs) } : {}),
          issues: [],
          cost: { rows: 1, pages: 1, probes: 1, bytes: state.diagnosticCost },
        };
      }
      if (kind === 'queues')
        return {
          version: 1,
          queueCount: 24,
          activeCount: 0,
          pausedCount: request.operation === 'resume' || request.operation === 'status' ? 0 : 24,
          ownerPresent: false,
        };
      assert.equal(
        legacyColdDigest(readFileSync(inventoryPath, 'utf8')),
        request.expected.inventoryArtifactSha256,
      );
      const base = {
        version: 1,
        operation: request.operation,
        certificateId: request.certificateId,
        activationAuthorized: false,
        bindingSha256: state.wrongBinding
          ? 'f'.repeat(64)
          : canonicalLegacyColdDigest(request.binding),
        inventorySha256: request.expected.inventorySha256,
        previewSha256: request.expected.previewSha256,
      };
      if (request.operation === 'certificate_create') {
        state.certificate = 'UNSEALED';
        if (state.lostCreate)
          throw Object.assign(new Error('response lost'), { outcomeUnknown: true });
      }
      if (request.operation === 'install') state.certificate = 'SEALED';
      if (request.operation === 'materialize') {
        state.pages += 1;
        const complete = !state.forever && state.pages === 2;
        if (complete) state.certificate = 'MATERIALIZED';
        return {
          ...base,
          state: 'SEALED',
          page: { complete, scanned: 1, applied: 1, blocked: state.blocked },
          cursor: { chatId: request.page.chatId, complete },
        };
      }
      return {
        ...base,
        state: state.certificate,
        requiredChats: 1,
        completeChats: state.certificate === 'MATERIALIZED' ? 1 : 0,
      };
    },
  };
  const adapter = createLegacyColdStoreAdapter({
    bindings,
    selection,
    ...(publisherBotId ? { publisherBotId } : {}),
    inventoryPath,
    report: (event) => state.diagnostics.push(event),
    client,
    store: {
      read: () => ({ journal }),
      readProof: () => state.pending,
      recordProof: (value) => legacyColdDigest(`${JSON.stringify(value)}\n`),
    },
    runtime: { readStoppedRuntime: () => ({ services: [], auxiliaries: [] }) },
  });
  return { adapter, state, bindings, journal };
}

test('host adapter preserves actual artifact bytes through install and independent materialization proof', (t) => {
  const h = fixture(t);
  const preview = h.adapter.snapshotPending();
  h.state.pending = preview;
  h.journal.proofs.pendingInventory = 'fixture';
  h.state.diagnosticCost = 1024;
  const { recheckProof, ...rechecked } = h.adapter.snapshotPending();
  assert.match(recheckProof, /^[0-9a-f]{64}$/u);
  assert.deepEqual(rechecked, preview);
  h.adapter.installDispositions(h.bindings, preview);
  h.adapter.removeStoreClient();
  assert.equal(h.adapter.readSeal(h.bindings, preview).permanentHoldsComplete, true);
  assert.equal(h.adapter.readSeal(h.bindings, preview).reviewedChatCursorsComplete, false);
  h.adapter.materializeReceipts(h.bindings, preview);
  assert.equal(h.adapter.readSeal(h.bindings, preview).reviewedChatCursorsComplete, true);
  assert.equal(h.state.pages, 2);
  assert.equal(h.state.diagnostics.length, 2);
  assert.deepEqual(
    h.state.diagnostics.map(({ page, scanned, applied, complete }) => ({
      page,
      scanned,
      applied,
      complete,
    })),
    [
      { page: 1, scanned: 1, applied: 1, complete: false },
      { page: 2, scanned: 1, applied: 1, complete: true },
    ],
  );
  assert.doesNotMatch(JSON.stringify(h.state.diagnostics), /chatId|owner|inventory|certificate/u);
});

test('stable inventory hash cannot mask a changed source envelope', (t) => {
  const h = fixture(t);
  h.state.pending = h.adapter.snapshotPending();
  h.journal.proofs.pendingInventory = 'fixture';
  h.state.ownerChat = 'different-chat';
  assert.throws(() => h.adapter.snapshotPending(), /reviewed_inventory_changed/);
});

test('separate attested Publisher identity is immutable across both cold inventories', (t) => {
  const h = fixture(t, 'publisher');
  const pending = h.adapter.snapshotPending();
  assert.equal(pending.inventory.binding.publisherBotId, 'publisher');
  h.state.pending = pending;
  h.journal.proofs.pendingInventory = 'fixture';
  h.state.pending.inventory.binding.publisherBotId = 'changed-publisher';
  assert.throws(() => h.adapter.snapshotPending(), /publisher_catalog_binding_changed/);
});

test('lost certificate-create response is independently read before the sole install', (t) => {
  const h = fixture(t);
  const pending = h.adapter.snapshotPending();
  h.state.lostCreate = true;
  h.adapter.installDispositions(h.bindings, pending);
  assert.deepEqual(h.state.calls.slice(1), [
    'readback',
    'certificate_create',
    'remove',
    'readback',
    'install',
  ]);
});

test('denied preview and mismatched readback never grant installation or restart', (t) => {
  const h = fixture(t);
  h.state.deny = true;
  assert.throws(() => h.adapter.snapshotPending(), /inventory_refused/);
  h.state.deny = false;
  const pending = h.adapter.snapshotPending();
  h.state.wrongBinding = true;
  assert.throws(() => h.adapter.installDispositions(h.bindings, pending), /binding_unproved/);
  assert.equal(h.state.calls.includes('certificate_create'), false);
});

test('blocked or unbounded pages cannot become a completed seal', (t) => {
  const h = fixture(t);
  const pending = h.adapter.snapshotPending();
  h.state.blocked = true;
  assert.throws(() => h.adapter.materializeReceipts(h.bindings, pending), /page_unproved/);
  h.state.blocked = false;
  h.state.forever = true;
  h.state.pages = 0;
  assert.throws(() => h.adapter.materializeReceipts(h.bindings, pending), /materialization_budget/);
  assert.equal(h.state.pages, 200);
});

function catalog(cost = 1) {
  return {
    version: 2,
    complete: true,
    issue: null,
    namespaceKeyCounts: { 'max-actions': 3 },
    cost: {
      pages: 2,
      scanCountHints: 8192,
      matchedKeys: 3,
      keyBytes: 64,
      bytes: 128,
      measurementBytes: 64,
      databaseKeysMax: 5000,
      serverDurationUs: cost + 1,
      maxCallDurationUs: cost,
      durationMs: cost,
    },
  };
}
function reviewedCatalogFixture(t) {
  const h = fixture(t, 'publisher');
  h.state.catalogs = [catalog(1), catalog(2)];
  h.state.pending = h.adapter.snapshotPending();
  h.journal.proofs.pendingInventory = 'fixture';
  return h;
}
test('equivalent stopped inventories retain original artifact and separately record changed catalog costs', (t) => {
  const h = reviewedCatalogFixture(t);
  const original = structuredClone(h.state.pending);
  h.state.catalogs = [catalog(1300), catalog(2400)];
  h.state.diagnosticCost = 999;
  const { recheckProof, ...result } = h.adapter.snapshotPending();
  assert.deepEqual(result, original);
  assert.match(recheckProof, /^[a-f0-9]{64}$/u);
  assert.notEqual(recheckProof, legacyColdDigest(`${JSON.stringify(original.inventory)}\n`));
  assert.equal(result.inventory.redisCatalogs[0].cost.durationMs, 1);
  assert.equal(h.state.calls.includes('certificate_create'), false);
});
for (const [label, mutate] of [
  [
    'changed namespace',
    (proof) => {
      proof.namespaceKeyCounts = { 'max-actions-new': 3 };
    },
  ],
  [
    'changed count',
    (proof) => {
      proof.namespaceKeyCounts['max-actions'] = 4;
    },
  ],
  [
    'incomplete census',
    (proof) => {
      proof.complete = false;
    },
  ],
  [
    'catalog issue',
    (proof) => {
      proof.issue = 'CATALOG_DEADLINE_EXCEEDED';
    },
  ],
  [
    'version changed',
    (proof) => {
      proof.version = 3;
    },
  ],
  [
    'unexpected field',
    (proof) => {
      proof.unreviewed = true;
    },
  ],
])
  test(`catalog cost projection still rejects ${label}`, (t) => {
    const h = reviewedCatalogFixture(t);
    mutate(h.state.catalogs[1]);
    assert.throws(() => h.adapter.snapshotPending(), /reviewed_inventory_changed/);
    assert.equal(h.state.calls.includes('certificate_create'), false);
  });
test('missing catalog pass is refused with stable effect and preview hashes', (t) => {
  const h = reviewedCatalogFixture(t);
  h.state.catalogs.pop();
  assert.throws(() => h.adapter.snapshotPending(), /reviewed_inventory_changed/);
});
test('invalid fresh decision remains denied even when catalog structure agrees', (t) => {
  const h = reviewedCatalogFixture(t);
  h.state.deny = true;
  assert.throws(() => h.adapter.snapshotPending(), /inventory_refused/);
});
