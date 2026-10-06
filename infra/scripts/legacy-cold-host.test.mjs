import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLegacyColdHostRequest } from './legacy-cold-host.mjs';

test('host selection is finite and canonical, with distinct online and exact apply requests', () => {
  const request = {
    version: 1,
    operation: 'preflight',
    targetSha: 'a'.repeat(40),
    selection: { ownerWebhookEventIds: ['second', 'first'], majorBotIds: ['major'] },
  };
  assert.deepEqual(
    parseLegacyColdHostRequest(JSON.stringify(request)).selection.ownerWebhookEventIds,
    ['first', 'second'],
  );
  assert.deepEqual(parseLegacyColdHostRequest('{"version":1,"operation":"status"}'), {
    version: 1,
    operation: 'status',
  });
  const retry = {
    version: 1,
    operation: 'retry-preview',
    targetSha: 'a'.repeat(40),
    expectedJournalDigest: 'b'.repeat(64),
  };
  assert.deepEqual(parseLegacyColdHostRequest(JSON.stringify(retry)), retry);
  assert.throws(
    () => parseLegacyColdHostRequest(JSON.stringify({ ...retry, selection: request.selection })),
    /unknown_request_field/,
  );
  assert.throws(
    () => parseLegacyColdHostRequest(JSON.stringify({ ...request, operation: 'apply' })),
    /unknown_request_field/,
  );
  for (const selection of [
    { ownerWebhookEventIds: ['first', 'first'], majorBotIds: ['major'] },
    { ownerWebhookEventIds: ['first'], majorBotIds: [] },
    { ownerWebhookEventIds: ['../path'], majorBotIds: ['major'] },
  ])
    assert.throws(
      () => parseLegacyColdHostRequest(JSON.stringify({ ...request, selection })),
      /finite_selection/,
    );
});

test('neither an environment override nor a guessed source enables a host request', () => {
  for (const value of [
    { version: 1, operation: 'status', bypass: true },
    { version: 1, operation: 'activate' },
    { version: 1, operation: 'prepare', targetSha: 'main' },
    {
      version: 1,
      operation: 'apply',
      targetSha: 'a'.repeat(40),
      expectedJournalDigest: 'b'.repeat(64),
      reviewedPreviewDigest: 'c'.repeat(64),
    },
  ])
    assert.throws(() => parseLegacyColdHostRequest(JSON.stringify(value)));
  assert.throws(() => parseLegacyColdHostRequest(' '.repeat(65537)), /budget/);
});
