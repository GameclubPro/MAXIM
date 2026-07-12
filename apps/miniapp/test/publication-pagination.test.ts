import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAmbiguousDeliveryPhaseComplete,
  mergeLegacyPublicationPages,
  mergePrioritizedPublicationPages,
  mergePublicationDeliveryPages,
  mergePublicationPages,
} from '../src/features/publications/publication-pagination';

test('legacy publication pagination keeps colliding ids from different stores', () => {
  assert.deepEqual(
    mergeLegacyPublicationPages([
      {
        items: [
          { id: 'same-id', kind: 'autopost', value: 1 },
          { id: 'same-id', kind: 'broadcast', value: 2 },
        ],
      },
      { items: [{ id: 'same-id', kind: 'autopost', value: 3 }] },
    ]),
    [
      { id: 'same-id', kind: 'autopost', value: 3 },
      { id: 'same-id', kind: 'broadcast', value: 2 },
    ],
  );
});

test('keeps general deliveries blocked after the first ambiguous page fails', () => {
  assert.equal(
    isAmbiguousDeliveryPhaseComplete({
      hasAmbiguous: true,
      hasData: false,
      hasNextPage: false,
      isError: true,
      isFetchingNextPage: false,
      isSuccess: false,
    }),
    false,
  );
  assert.equal(
    isAmbiguousDeliveryPhaseComplete({
      hasAmbiguous: true,
      hasData: true,
      hasNextPage: true,
      isError: true,
      isFetchingNextPage: false,
      isSuccess: false,
    }),
    true,
  );
});

test('merges publication cursor pages without duplicate cards', () => {
  const items = mergePublicationPages([
    {
      items: [
        { id: 'publication-1', version: 1 },
        { id: 'publication-2', version: 1 },
      ],
    },
    {
      items: [
        { id: 'publication-2', version: 2 },
        { id: 'publication-3', version: 1 },
      ],
    },
  ]);

  assert.deepEqual(items, [
    { id: 'publication-1', version: 1 },
    { id: 'publication-2', version: 2 },
    { id: 'publication-3', version: 1 },
  ]);
});

test('keeps ambiguous deliveries first while deduplicating the general feed', () => {
  const items = mergePrioritizedPublicationPages(
    [
      { items: [{ id: 'delivery-ambiguous-1', status: 'AMBIGUOUS' }] },
      { items: [{ id: 'delivery-ambiguous-2', status: 'AMBIGUOUS' }] },
    ],
    [
      {
        items: [
          { id: 'delivery-sent', status: 'SENT' },
          { id: 'delivery-ambiguous-1', status: 'AMBIGUOUS' },
        ],
      },
    ],
  );

  assert.deepEqual(items, [
    { id: 'delivery-ambiguous-1', status: 'AMBIGUOUS' },
    { id: 'delivery-ambiguous-2', status: 'AMBIGUOUS' },
    { id: 'delivery-sent', status: 'SENT' },
  ]);
});

test('drops cached ambiguous deliveries after the current count reaches zero', () => {
  const items = mergePublicationDeliveryPages(
    false,
    [{ items: [{ id: 'delivery-stale-priority', status: 'AMBIGUOUS' }] }],
    [
      {
        items: [
          { id: 'delivery-stale-general', status: 'AMBIGUOUS' },
          { id: 'delivery-sent', status: 'SENT' },
        ],
      },
    ],
  );

  assert.deepEqual(items, [{ id: 'delivery-sent', status: 'SENT' }]);
});
