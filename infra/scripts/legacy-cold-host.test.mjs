import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLegacyColdHostRequest, readLegacyColdPublisherCatalog } from './legacy-cold-host.mjs';

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

test('Publisher catalog is separate, generation-derived, exact and never supplied by an operator', () => {
  const admin = ['MAX_PUBLISHER_BOT_ID=publisher', 'MAX_BOT_ID=major'];
  const publisher = [
    'MAX_PUBLISHER_BOT_ID=publisher',
    'MAX_BOT_ID=publisher',
    'APP_ROLE=publisher',
  ];
  assert.equal(readLegacyColdPublisherCatalog(admin, publisher, ['major']), 'publisher');
  for (const [a, p, m] of [
    [[], publisher, ['major']],
    [[...admin, 'MAX_PUBLISHER_BOT_ID=publisher'], publisher, ['major']],
    [admin, [...publisher, 'MAX_BOT_ID=publisher'], ['major']],
    [
      admin,
      publisher.map((value) => (value === 'MAX_BOT_ID=publisher' ? 'MAX_BOT_ID=other' : value)),
      ['major'],
    ],
    [
      admin,
      publisher.map((value) => (value === 'APP_ROLE=publisher' ? 'APP_ROLE=admin' : value)),
      ['major'],
    ],
    [admin, publisher, ['major', 'publisher']],
    [['MAX_PUBLISHER_BOT_ID= publisher'], publisher, ['major']],
  ])
    assert.throws(() => readLegacyColdPublisherCatalog(a, p, m), /publisher_catalog_unproved/);
  const request = {
    version: 1,
    operation: 'preflight',
    targetSha: 'a'.repeat(40),
    selection: { ownerWebhookEventIds: ['owner'], majorBotIds: ['major'] },
  };
  assert.throws(
    () => parseLegacyColdHostRequest(JSON.stringify({ ...request, publisherBotId: 'publisher' })),
    /unknown_request_field/,
  );
  assert.throws(
    () =>
      parseLegacyColdHostRequest(
        JSON.stringify({
          ...request,
          selection: { ...request.selection, publisherBotId: 'publisher' },
        }),
      ),
    /unknown_request_field/,
  );
});
