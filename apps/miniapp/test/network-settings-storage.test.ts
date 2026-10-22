import assert from 'node:assert/strict';
import test from 'node:test';
import { networkSettingsRetryCandidates } from '../src/features/network-settings/network-settings-retry';
import {
  createNetworkSettingsScope,
  readNetworkSettingsScope,
  removeNetworkSettingsScope,
} from '../src/lib/network-settings-workspace-state';
import {
  persistNetworkSettingsOperationReceipt,
  listNetworkSettingsOperationReceipts,
  hydrateNetworkSettingsOperationReceipts,
  mergeNetworkSettingsReceipt,
  removeNetworkSettingsOperationReceipt,
  type NetworkSettingsOperationReceipt,
} from '../src/lib/network-settings-operation-storage';
function environment(fail = false, native?: Map<string, string>) {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      ...(native
        ? {
            WebApp: {
              initData: 'test',
              DeviceStorage: {
                getItem: async (key: string) => ({ value: native.get(key) ?? null }),
                setItem: async (key: string, value: string) => {
                  native.set(key, value);
                  return { value };
                },
              },
            },
          }
        : {}),
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (fail) throw new Error('quota');
          values.set(key, value);
        },
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
  return {
    values,
    restore: () => {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}
const input = {
  userId: 'actor',
  scope: {
    entityType: 'chat',
    target: { mode: 'selected', entityIds: ['chat-a'] },
    initialSection: 'links',
  },
  title: 'Важное',
  returnTo: '/networks/chat',
} as const;
test('immutable scope is cloned and bound to exact actor/type; launched receipts preserve its recovery reference', async () => {
  const env = environment();
  try {
    const stored = createNetworkSettingsScope({
      ...input,
      scope: { ...input.scope, target: { mode: 'selected', entityIds: ['chat-a'] } },
    });
    stored.scope.target = { mode: 'selected', entityIds: ['mutated'] };
    const exact = { userId: 'actor', scopeId: stored.scopeId, entityType: 'chat' } as const;
    assert.deepEqual(readNetworkSettingsScope(exact)?.scope.target, {
      mode: 'selected',
      entityIds: ['chat-a'],
    });
    assert.equal(readNetworkSettingsScope({ ...exact, userId: 'other' }), null);
    assert.equal(readNetworkSettingsScope({ ...exact, entityType: 'channel' }), null);
    const receipt: NetworkSettingsOperationReceipt = {
      version: 1,
      userId: 'actor',
      scopeId: stored.scopeId,
      entityType: 'chat',
      section: 'links',
      title: 'Важное',
      operationId: crypto.randomUUID(),
      launchState: 'launching',
      updatedAt: new Date().toISOString(),
      previewHash: 'a'.repeat(64),
    };
    await persistNetworkSettingsOperationReceipt(receipt);
    assert.equal(listNetworkSettingsOperationReceipts('actor')[0].operationId, receipt.operationId);
    await removeNetworkSettingsScope(exact);
    assert.ok(readNetworkSettingsScope(exact));
  } finally {
    env.restore();
  }
});

function historyReceipt(
  index: number,
  extra: Partial<NetworkSettingsOperationReceipt> = {},
): NetworkSettingsOperationReceipt {
  return {
    version: 1,
    userId: 'actor',
    scopeId: '1354b877-71f9-4fab-a38a-7022eb548ffd',
    entityType: 'chat',
    section: 'links',
    title: 'Важное',
    operationId: crypto.randomUUID(),
    launchState: 'submitted',
    lastKnownStatus: 'COMPLETE',
    recipientIds: ['chat-a'],
    completionConfirmedAt: new Date(Date.UTC(2026, 9, 22, 0, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 22, 0, 0, index)).toISOString(),
    ...extra,
  };
}
const historyKey = 'maxim.network.settings.receipts.v1:actor';
test('large retry batches preserve launched ownership after child archive and stale parent reads', async () => {
  const env = environment();
  try {
    const ids = Array.from({ length: 503 }, (_, index) => `chat-${index}`);
    const parent = historyReceipt(1, {
      lastKnownStatus: 'FAILED',
      recipientIds: ids,
      completionConfirmedAt: undefined,
    });
    await persistNetworkSettingsOperationReceipt(parent);
    const child = historyReceipt(2, {
      retryOfOperationId: parent.operationId,
      recipientIds: ids.slice(0, 500),
      launchState: 'uncertain',
      lastKnownStatus: 'RUNNING',
      completionConfirmedAt: undefined,
    });
    await persistNetworkSettingsOperationReceipt(child);
    assert.deepEqual(
      networkSettingsRetryCandidates(ids, parent, listNetworkSettingsOperationReceipts('actor')),
      ids.slice(500),
    );
    await assert.rejects(
      persistNetworkSettingsOperationReceipt({ ...child, operationId: crypto.randomUUID() }),
      /уже создан повтор/u,
    );
    await persistNetworkSettingsOperationReceipt({
      ...child,
      launchState: 'submitted',
      lastKnownStatus: 'COMPLETE',
      completionConfirmedAt: new Date().toISOString(),
    });
    await removeNetworkSettingsOperationReceipt('actor', child.operationId);
    await assert.rejects(
      persistNetworkSettingsOperationReceipt({ ...child, operationId: crypto.randomUUID() }),
      /уже создан повтор/u,
    );
    await persistNetworkSettingsOperationReceipt({
      ...parent,
      updatedAt: new Date().toISOString(),
    });
    assert.deepEqual(
      networkSettingsRetryCandidates(ids, parent, listNetworkSettingsOperationReceipts('actor')),
      ids.slice(500),
    );
    assert.deepEqual(
      networkSettingsRetryCandidates(
        ids,
        { ...parent, userId: 'someone-else' },
        listNetworkSettingsOperationReceipts('actor'),
      ),
      [],
    );
  } finally {
    env.restore();
  }
});
test('archiving preserves terminal operations with unsettled outcomes until settlement is verified', async () => {
  const env = environment();
  try {
    const receipt = historyReceipt(1, {
      lastKnownStatus: 'PARTIAL',
      completionConfirmedAt: undefined,
    });
    await persistNetworkSettingsOperationReceipt(receipt);
    await removeNetworkSettingsOperationReceipt('actor', receipt.operationId);
    assert.equal(listNetworkSettingsOperationReceipts('actor').length, 1);
    await persistNetworkSettingsOperationReceipt({
      ...receipt,
      settlementConfirmedAt: new Date().toISOString(),
    });
    await removeNetworkSettingsOperationReceipt('actor', receipt.operationId);
    assert.equal(listNetworkSettingsOperationReceipts('actor').length, 0);
  } finally {
    env.restore();
  }
});

test('more than 100 proven completed receipts make space for a new operation by pruning oldest only', async () => {
  const env = environment();
  try {
    const completed = Array.from({ length: 125 }, (_, index) => historyReceipt(index));
    env.values.set(historyKey, JSON.stringify(completed));
    const next = historyReceipt(126, {
      launchState: 'unconfirmed',
      lastKnownStatus: 'PREPARED',
      completionConfirmedAt: undefined,
    });
    await persistNetworkSettingsOperationReceipt(next);
    const retained = listNetworkSettingsOperationReceipts('actor');
    assert.equal(retained.length, 100);
    assert.equal(retained[0].operationId, next.operationId);
    assert.deepEqual(
      new Set(retained.slice(1).map((row) => row.operationId)),
      new Set(completed.slice(26).map((row) => row.operationId)),
    );
  } finally {
    env.restore();
  }
});

test('capacity pruning preserves every uncertain, nonterminal, FAILED and PARTIAL recovery', async () => {
  const env = environment();
  try {
    const protectedRows = [
      historyReceipt(0, { launchState: 'uncertain' }),
      historyReceipt(1, { lastKnownStatus: 'RUNNING', completionConfirmedAt: undefined }),
      historyReceipt(2, { lastKnownStatus: 'FAILED', completionConfirmedAt: undefined }),
      historyReceipt(3, { lastKnownStatus: 'PARTIAL', completionConfirmedAt: undefined }),
      historyReceipt(4, { completionConfirmedAt: undefined }),
      ...Array.from({ length: 93 }, (_, index) =>
        historyReceipt(index + 5, {
          launchState: 'unconfirmed',
          lastKnownStatus: 'PREPARED',
          completionConfirmedAt: undefined,
        }),
      ),
    ];
    const completed = Array.from({ length: 5 }, (_, index) => historyReceipt(index + 100));
    env.values.set(historyKey, JSON.stringify([...protectedRows, ...completed]));
    const next = historyReceipt(106, {
      launchState: 'launching',
      lastKnownStatus: 'PREPARED',
      completionConfirmedAt: undefined,
    });
    await persistNetworkSettingsOperationReceipt(next);
    const retained = listNetworkSettingsOperationReceipts('actor');
    assert.equal(retained.length, 100);
    for (const receipt of protectedRows)
      assert.ok(retained.some((row) => row.operationId === receipt.operationId));
    assert.ok(retained.some((row) => row.operationId === completed.at(-1)?.operationId));
    assert.equal(
      retained.filter((row) => completed.some((old) => old.operationId === row.operationId)).length,
      1,
    );
  } finally {
    env.restore();
  }
});

test('a full unresolved history refuses a new receipt while allowing existing status progress', async () => {
  const env = environment();
  try {
    const unresolved = Array.from({ length: 101 }, (_, index) =>
      historyReceipt(index, {
        launchState: 'uncertain',
        lastKnownStatus: 'RUNNING',
        completionConfirmedAt: undefined,
      }),
    );
    env.values.set(historyKey, JSON.stringify(unresolved));
    await assert.rejects(
      persistNetworkSettingsOperationReceipt(historyReceipt(102)),
      /Слишком много/u,
    );
    assert.equal(listNetworkSettingsOperationReceipts('actor').length, 101);
    await persistNetworkSettingsOperationReceipt({ ...unresolved[0], lastKnownStatus: 'PARTIAL' });
    const retained = listNetworkSettingsOperationReceipts('actor');
    assert.equal(retained.length, 101);
    assert.equal(
      retained.find((row) => row.operationId === unresolved[0].operationId)?.lastKnownStatus,
      'PARTIAL',
    );
  } finally {
    env.restore();
  }
});

test('newer stale poll timestamps cannot regress a terminal status or replace frozen witnesses', async () => {
  const env = environment();
  try {
    const complete = historyReceipt(1, { previewHash: 'a'.repeat(64) });
    await persistNetworkSettingsOperationReceipt(complete);
    await persistNetworkSettingsOperationReceipt({
      ...complete,
      launchState: 'unconfirmed',
      lastKnownStatus: 'PREPARED',
      completionConfirmedAt: undefined,
      recipientIds: undefined,
      previewHash: undefined,
      updatedAt: historyReceipt(2).updatedAt,
    });
    const retained = listNetworkSettingsOperationReceipts('actor')[0];
    assert.equal(retained.lastKnownStatus, 'COMPLETE');
    assert.equal(retained.launchState, 'submitted');
    assert.equal(retained.completionConfirmedAt, complete.completionConfirmedAt);
    assert.deepEqual(retained.recipientIds, ['chat-a']);
    assert.equal(retained.previewHash, complete.previewHash);
    await assert.rejects(
      persistNetworkSettingsOperationReceipt({ ...complete, recipientIds: ['other'] }),
    );
    await assert.rejects(
      persistNetworkSettingsOperationReceipt({ ...complete, previewHash: 'b'.repeat(64) }),
    );
  } finally {
    env.restore();
  }
});

test('native hydration preserves terminal progress and the local exact identity against stale copies', async () => {
  const native = new Map<string, string>();
  const env = environment(false, native);
  try {
    const complete = historyReceipt(0);
    const conflict = historyReceipt(1);
    env.values.set(historyKey, JSON.stringify([complete, conflict]));
    native.set(
      historyKey,
      JSON.stringify([
        {
          ...complete,
          launchState: 'launching',
          lastKnownStatus: 'RUNNING',
          completionConfirmedAt: undefined,
          updatedAt: historyReceipt(2).updatedAt,
        },
        { ...conflict, scopeId: crypto.randomUUID(), updatedAt: historyReceipt(3).updatedAt },
      ]),
    );
    const retained = await hydrateNetworkSettingsOperationReceipts('actor');
    assert.equal(
      retained.find((row) => row.operationId === complete.operationId)?.lastKnownStatus,
      'COMPLETE',
    );
    assert.equal(
      retained.find((row) => row.operationId === complete.operationId)?.launchState,
      'submitted',
    );
    assert.equal(
      retained.find((row) => row.operationId === conflict.operationId)?.scopeId,
      conflict.scopeId,
    );
  } finally {
    env.restore();
  }
});
test('scope and launching receipt refuse non-readable persistence', async () => {
  const env = environment(true);
  try {
    assert.throws(() =>
      createNetworkSettingsScope({
        ...input,
        scope: { ...input.scope, target: { mode: 'selected', entityIds: ['chat-a'] } },
      }),
    );
    await assert.rejects(
      persistNetworkSettingsOperationReceipt({
        version: 1,
        userId: 'actor',
        scopeId: crypto.randomUUID(),
        entityType: 'chat',
        section: 'links',
        title: 'Важное',
        operationId: crypto.randomUUID(),
        launchState: 'launching',
        updatedAt: new Date().toISOString(),
      }),
    );
    assert.deepEqual(listNetworkSettingsOperationReceipts('actor'), []);
  } finally {
    env.restore();
  }
});

test('a delayed PREPARED status receipt cannot reopen a launched operation', async () => {
  const env = environment();
  try {
    const scope = createNetworkSettingsScope({
      ...input,
      scope: { ...input.scope, target: { mode: 'selected', entityIds: ['chat-a'] } },
    });
    const base: NetworkSettingsOperationReceipt = {
      version: 1,
      userId: 'actor',
      scopeId: scope.scopeId,
      entityType: 'chat',
      section: 'links',
      title: 'Важное',
      operationId: crypto.randomUUID(),
      launchState: 'launching',
      updatedAt: new Date().toISOString(),
    };
    await persistNetworkSettingsOperationReceipt(base);
    const delayed = {
      ...base,
      launchState: 'unconfirmed' as const,
      lastKnownStatus: 'PREPARED' as const,
    };
    assert.equal(mergeNetworkSettingsReceipt(base, delayed).launchState, 'launching');
    await persistNetworkSettingsOperationReceipt(delayed);
    assert.equal(listNetworkSettingsOperationReceipts('actor')[0].launchState, 'launching');
    assert.throws(() =>
      mergeNetworkSettingsReceipt(base, { ...delayed, scopeId: crypto.randomUUID() }),
    );
  } finally {
    env.restore();
  }
});

test('a fresh editor scope preserves the settled result and its durable recovery receipt', async () => {
  const env = environment();
  try {
    const original = createNetworkSettingsScope({
      ...input,
      scope: { ...input.scope, target: { mode: 'selected', entityIds: ['chat-a'] } },
      origin: { locationKey: 'origin', historyIndex: 2, scrollY: 120 },
    });
    const receipt: NetworkSettingsOperationReceipt = {
      version: 1,
      userId: 'actor',
      scopeId: original.scopeId,
      entityType: 'chat',
      section: 'links',
      title: 'Важное',
      operationId: crypto.randomUUID(),
      launchState: 'submitted',
      lastKnownStatus: 'COMPLETE',
      recipientIds: ['chat-a'],
      completionConfirmedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await persistNetworkSettingsOperationReceipt(receipt);
    const fresh = createNetworkSettingsScope({
      userId: original.userId,
      scope: original.scope,
      title: original.title,
      returnTo: original.returnTo,
      origin: original.origin,
    });
    assert.notEqual(fresh.scopeId, original.scopeId);
    assert.deepEqual(fresh.scope, original.scope);
    assert.deepEqual(fresh.origin, original.origin);
    assert.deepEqual(listNetworkSettingsOperationReceipts('actor'), [receipt]);
    assert.deepEqual(
      readNetworkSettingsScope({
        userId: 'actor',
        scopeId: original.scopeId,
        entityType: 'chat',
      }),
      original,
    );
    assert.deepEqual(
      readNetworkSettingsScope({
        userId: 'actor',
        scopeId: fresh.scopeId,
        entityType: 'chat',
      }),
      fresh,
    );
    assert.equal(
      listNetworkSettingsOperationReceipts('actor').some((row) => row.scopeId === fresh.scopeId),
      false,
    );
  } finally {
    env.restore();
  }
});
