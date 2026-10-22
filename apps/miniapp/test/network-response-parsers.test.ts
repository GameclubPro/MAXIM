import assert from 'node:assert/strict';
import test from 'node:test';
import {
  managedEntityNetworksResponseSchema,
  managedEntityNetworkEntriesResponseSchema,
  managedEntityNetworkCompositionResponseSchema,
} from '@maxim/contracts/managed-entities';
import {
  parseManagedEntityNetworksResponse,
  parseManagedEntityNetworkEntriesResponse,
} from '../src/lib/api/managed-entity-networks-response';
import { parseManagedEntityNetworkCompositionResponse } from '../src/lib/api/managed-entity-network-composition-response';

const catalogue = {
  entityType: 'chat',
  compositionVersion: 'v1',
  labelsRevision: 1,
  items: ['important', 'watch', 'broadcast', 'test', 'partner', 'service'].map((favoriteType) => ({
    favoriteType,
    label: '  Моя   сетка  ',
    entityCount: 0,
    compositionVersion: 'v1',
  })),
};
const entries = {
  entityType: 'channel',
  compositionVersion: 'v1',
  nextCursor: null,
  items: [{ id: ' -1 ', entityType: 'channel', title: '', avatarUrl: null, favoriteType: 'watch' }],
};
const composition = {
  entityType: 'chat',
  changes: [{ entityId: ' -1 ', expectedFavoriteType: null, favoriteType: 'important' }],
};
type Oracle = { safeParse(value: unknown): { success: boolean; data?: unknown } };
function equivalent(schema: Oracle, parse: (value: unknown) => unknown, value: unknown) {
  const expected = schema.safeParse(value);
  if (!expected.success) assert.throws(() => parse(value));
  else assert.deepEqual(parse(value), expected.data);
}

test('focused network wire parsers preserve canonical normalization and unknown-key handling', () => {
  for (const [schema, parse, values] of [
    [
      managedEntityNetworksResponseSchema,
      parseManagedEntityNetworksResponse,
      [
        catalogue,
        {
          ...catalogue,
          labelsRevision: null,
          extra: 'stripped',
          items: catalogue.items.map((item) => ({
            ...item,
            extra: 'stripped',
            label: '😀'.repeat(24),
          })),
        },
      ],
    ],
    [
      managedEntityNetworkEntriesResponseSchema,
      parseManagedEntityNetworkEntriesResponse,
      [
        entries,
        { ...entries, nextCursor: '', extra: true, items: [] },
        {
          ...entries,
          items: [{ ...entries.items[0], extra: true, avatarUrl: '', favoriteType: null }],
        },
      ],
    ],
    [
      managedEntityNetworkCompositionResponseSchema,
      parseManagedEntityNetworkCompositionResponse,
      [composition, { ...composition, extra: true, changes: [] }],
    ],
  ] as const) {
    for (const value of values) equivalent(schema, parse, value);
    for (const value of [undefined, null, [], '', 1, {}, { ...values[0], entityType: 'other' }])
      equivalent(schema, parse, value);
  }
});

test('network response boundary rejects malformed values with canonical limits', () => {
  for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined])
    equivalent(managedEntityNetworksResponseSchema, parseManagedEntityNetworksResponse, {
      ...catalogue,
      labelsRevision: value,
    });
  for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', undefined])
    equivalent(managedEntityNetworksResponseSchema, parseManagedEntityNetworksResponse, {
      ...catalogue,
      items: catalogue.items.map((item) => ({ ...item, entityCount: value })),
    });
  for (const value of ['', '  ', '\u0000', '😀'.repeat(25), undefined, 7])
    equivalent(managedEntityNetworksResponseSchema, parseManagedEntityNetworksResponse, {
      ...catalogue,
      items: catalogue.items.map((item) => ({ ...item, label: value })),
    });
  for (const value of [undefined, null, [], {}, '', ' ', 1]) {
    equivalent(managedEntityNetworksResponseSchema, parseManagedEntityNetworksResponse, {
      ...catalogue,
      compositionVersion: value,
    });
    equivalent(
      managedEntityNetworkEntriesResponseSchema,
      parseManagedEntityNetworkEntriesResponse,
      { ...entries, items: [{ ...entries.items[0], id: value }] },
    );
  }
  for (const favoriteType of [undefined, false, '', 'unknown', []])
    equivalent(
      managedEntityNetworkEntriesResponseSchema,
      parseManagedEntityNetworkEntriesResponse,
      { ...entries, items: [{ ...entries.items[0], favoriteType }] },
    );
  for (const item of [
    { ...composition.changes[0], extra: true },
    { ...composition.changes[0], entityId: 'x'.repeat(129) },
    { ...composition.changes[0], expectedFavoriteType: undefined },
    { ...composition.changes[0], favoriteType: 'unknown' },
  ])
    equivalent(
      managedEntityNetworkCompositionResponseSchema,
      parseManagedEntityNetworkCompositionResponse,
      { ...composition, changes: [item] },
    );
  for (const length of [5, 7])
    equivalent(managedEntityNetworksResponseSchema, parseManagedEntityNetworksResponse, {
      ...catalogue,
      items: Array.from({ length }, () => catalogue.items[0]),
    });
  equivalent(managedEntityNetworkEntriesResponseSchema, parseManagedEntityNetworkEntriesResponse, {
    ...entries,
    items: Array.from({ length: 101 }, () => entries.items[0]),
  });
  equivalent(
    managedEntityNetworkCompositionResponseSchema,
    parseManagedEntityNetworkCompositionResponse,
    { ...composition, changes: Array.from({ length: 501 }, () => composition.changes[0]) },
  );
});
