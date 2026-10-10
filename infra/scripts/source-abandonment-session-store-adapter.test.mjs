import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyColdDigest } from './legacy-cold-journal.mjs';
import { canonicalLegacyColdDigest as canonical } from './legacy-cold-store-adapter.mjs';
import { createSourceAbandonmentSessionStoreBatchAdapter } from './source-abandonment-session-store-adapter.mjs';

function fixture() {
  const selection = { owners: ['a'] };
  const bindings = {
    certificateId: '11111111-1111-4111-8111-111111111111',
    selectionDigest: legacyColdDigest(selection),
  };
  const pending = {
    inventory: {
      binding: { sourceSha: 'b'.repeat(40) },
      selectedOwners: [{ chatId: '-1' }, { chatId: '-2' }],
    },
    inventoryDigest: 'a'.repeat(64),
    previewDigest: 'b'.repeat(64),
    inventoryArtifactSha256: 'c'.repeat(64),
  };
  const calls = [];
  const state = { initial: 'ABSENT', error: null, mutate: null };
  const result = (request, operation) => ({
    version: 1,
    operation,
    certificateId: request.certificateId,
    activationAuthorized: false,
    bindingSha256: canonical(request.binding),
    inventorySha256: request.expected.inventorySha256,
    previewSha256: request.expected.previewSha256,
    state: operation === 'readback' ? state.initial : 'SEALED',
  });
  const client = {
    invoke(kind, input) {
      calls.push({ kind, input });
      if (kind === 'store') return result(input, 'readback');
      if (state.error) throw state.error;
      const request = input.items[0].request;
      let item = {
        inventoryIndex: 0,
        certificateId: request.certificateId,
        result: result(request, 'install'),
      };
      if (input.phase === 'materialize') {
        const pages = ['-1', '-2'].map((chatId) => ({
          ...result(request, 'materialize'),
          page: { complete: true, blocked: false, scanned: 2, applied: 2 },
          cursor: { chatId, complete: true },
        }));
        item = { ...item, result: pages.at(-1), pages };
      }
      const output = {
        version: 1,
        kind: 'source_abandonment_session_store_batch_result',
        phase: input.phase,
        results: [item],
      };
      state.mutate?.(output);
      return output;
    },
  };
  const readSeal = () => ({ stock: true });
  const adapter = createSourceAbandonmentSessionStoreBatchAdapter({
    stockAdapter: { readSeal },
    client,
    bindings,
    selection,
    now: () => 1000,
  });
  return { adapter, pending, calls, state, readSeal };
}
test('independent ABSENT readback precedes one create/install batch and the stock seal remains independent', () => {
  const h = fixture();
  h.adapter.installDispositions(null, h.pending);
  assert.deepEqual(
    h.calls.map((row) => [row.kind, row.input.operation ?? row.input.phase]),
    [
      ['store', 'readback'],
      ['source-store-batch', 'install'],
    ],
  );
  assert.equal(h.adapter.readSeal, h.readSeal);
  assert.equal(h.calls[1].input.deadlineAtMs, 91_000);
});
test('lost writer acknowledgement is propagated without create/install replay', () => {
  const h = fixture();
  h.state.error = Object.assign(new Error('unknown'), { outcomeUnknown: true });
  assert.throws(
    () => h.adapter.installDispositions(null, h.pending),
    (error) => error.outcomeUnknown === true,
  );
  assert.equal(h.calls.length, 2);
});
test('existing certificate cannot enter the install batch', () => {
  const h = fixture();
  h.state.initial = 'UNSEALED';
  assert.throws(() => h.adapter.installDispositions(null, h.pending), /already_exists/);
  assert.equal(h.calls.length, 1);
});
test('all finite materialization pages share one batch and every selected chat must complete', () => {
  const h = fixture();
  h.adapter.materializeReceipts(null, h.pending);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].input.deadlineAtMs, 121_000);
});
for (const mutation of [
  'certificate',
  'chat',
  'missing',
  'blocked',
  'oversized',
  'incomplete',
  'final',
])
  test(`materialization refuses ${mutation} response`, () => {
    const h = fixture();
    h.state.mutate = (output) => {
      const item = output.results[0];
      if (mutation === 'certificate') item.pages[0].certificateId = 'foreign';
      if (mutation === 'chat') item.pages[0].cursor.chatId = 'other';
      if (mutation === 'missing') item.pages.pop();
      if (mutation === 'blocked') item.pages[0].page.blocked = true;
      if (mutation === 'oversized') item.pages[0].page.scanned = 201;
      if (mutation === 'incomplete') {
        item.pages[0].page.complete = false;
        item.pages[0].cursor.complete = false;
      }
      if (mutation === 'final') item.result = { ...item.result, state: 'ABSENT' };
    };
    assert.throws(() => h.adapter.materializeReceipts(null, h.pending));
  });
