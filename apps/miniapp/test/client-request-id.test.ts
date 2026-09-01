import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceContentBoundRequestIdentity,
  createClientRequestId,
  createContentBoundRequestIdentity,
  resolveContentBoundRequestIdentity,
} from '../src/lib/client-request-id';

test('creates a contract-safe suggestion request identity', () => {
  const requestId = createClientRequestId('publisher-suggestion');
  assert.match(requestId, /^[A-Za-z0-9_-]{8,128}$/u);
  assert.ok(requestId.startsWith('publisher-suggestion_'));
});

test('reuses the request identity for an identical ambiguous retry', () => {
  const initial = createContentBoundRequestIdentity();
  const first = resolveContentBoundRequestIdentity(initial, 'publisher-suggestion');
  const retry = resolveContentBoundRequestIdentity(first.identity, 'publisher-suggestion');

  assert.equal(retry.requestId, first.requestId);
  assert.deepEqual(retry.identity, first.identity);
});

test('rotates the request identity after the draft content changes', () => {
  const first = resolveContentBoundRequestIdentity(
    createContentBoundRequestIdentity(),
    'publisher-suggestion',
  );
  const changed = advanceContentBoundRequestIdentity(first.identity);
  const next = resolveContentBoundRequestIdentity(changed, 'publisher-suggestion');

  assert.notEqual(next.requestId, first.requestId);
  assert.equal(next.identity.requestRevision, next.identity.draftRevision);
});
