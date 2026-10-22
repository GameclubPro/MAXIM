import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { getManagedEntityNetworkEntries } from '../src/lib/api/managed-entity-networks-client';
import {
  readCompleteNetworkSettings,
  mergeNetworkSettingsOperation,
  readVerifiedNetworkSettingsOperation,
  networkSettingsReceiptForStatus,
  isNetworkSettingsOperationSettled,
  networkSettingsFailedRecipients,
  networkSettingsResultReadOnly,
} from '../src/features/network-settings/network-settings-controller';
import {
  previewNetworkSettings,
  getNetworkSettingsOperation,
  applyNetworkSettings,
  readNetworkNavigationAllowlist,
} from '../src/lib/api/network-settings-client';
import type { NetworkSettingsOperationResponse } from '@maxim/contracts/network-settings';
import type { ApiTransport } from '../src/lib/api/transport';
import type { NetworkSettingsOperationReceipt } from '../src/lib/network-settings-operation-storage';
async function prepare(scenario = '') {
  const api = createPreviewApiTransport({
    search: '?networks=1' + (scenario ? '&networksScenario=' + scenario : ''),
  });
  const entries = await getManagedEntityNetworkEntries(api, 'chat', {
    favoriteType: 'important',
    limit: 2,
  });
  const scope = {
    entityType: 'chat',
    target: { mode: 'selected', entityIds: entries.items.map((row) => row.id) },
    section: 'links',
  } as const;
  const read = await readCompleteNetworkSettings(api, scope);
  const preview = await previewNetworkSettings(api, {
    ...scope,
    operationId: crypto.randomUUID(),
    compositionVersion: read.compositionVersion,
    recipients: read.recipients,
    changes: [{ op: 'set', path: 'linkBotMessageText', value: 'Authored shared' }],
  });
  const status = await getNetworkSettingsOperation(api, preview.operationId);
  assert.equal(status.status, 'PREPARED');
  return { api, scope, read, preview };
}
test('preview source is read-only until explicit apply, and the original operation never rewrites a saved target', async () => {
  const f = await prepare();
  assert.deepEqual(
    (await readCompleteNetworkSettings(f.api, f.scope)).recipients,
    f.read.recipients,
  );
  await applyNetworkSettings(f.api, {
    operationId: f.preview.operationId,
    previewHash: f.preview.previewHash,
  });
  assert.equal(
    (await getNetworkSettingsOperation(f.api, f.preview.operationId)).status,
    'COMPLETE',
  );
  const saved = await readCompleteNetworkSettings(f.api, f.scope);
  assert.deepEqual(saved.fields.linkBotMessageText, { kind: 'common', value: 'Authored shared' });
  await applyNetworkSettings(f.api, {
    operationId: f.preview.operationId,
    previewHash: f.preview.previewHash,
  });
  await getNetworkSettingsOperation(f.api, f.preview.operationId);
  assert.deepEqual(
    (await readCompleteNetworkSettings(f.api, f.scope)).recipients,
    saved.recipients,
  );
});
test('lost apply response is recoverable through original status UUID', async () => {
  const f = await prepare('uncertain');
  await assert.rejects(
    applyNetworkSettings(f.api, {
      operationId: f.preview.operationId,
      previewHash: f.preview.previewHash,
    }),
  );
  const result = await getNetworkSettingsOperation(f.api, f.preview.operationId);
  assert.equal(result.operationId, f.preview.operationId);
  assert.equal(result.status, 'COMPLETE');
});
test('prepared simulated server operation survives a document reload as status-only', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
  try {
    const f = await prepare();
    const fresh = createPreviewApiTransport({ search: '?networks=1' });
    const status = await getNetworkSettingsOperation(fresh, f.preview.operationId);
    assert.equal(status.status, 'PREPARED');
    assert.deepEqual(
      (await readCompleteNetworkSettings(fresh, f.scope)).recipients,
      f.read.recipients,
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
test('list-only intent has exact stable per-recipient impact and does not replace scalar settings', async () => {
  const f = await prepare();
  const requestId = crypto.randomUUID();
  const recipients = [];
  for (const row of f.read.recipients) {
    const result = await readNetworkNavigationAllowlist(f.api, {
      ...f.scope,
      compositionVersion: f.read.compositionVersion,
      requestId,
      entityId: row.entityId,
      includeEntries: false,
    });
    recipients.push({ ...row, navigationAllowlistWitness: result.witness });
  }
  const preview = await previewNetworkSettings(f.api, {
    ...f.scope,
    operationId: crypto.randomUUID(),
    compositionVersion: f.read.compositionVersion,
    recipients,
    changes: [],
    navigationAllowlist: { mode: 'replace', entries: [] },
  });
  const reviewed = await getNetworkSettingsOperation(f.api, preview.operationId);
  assert.equal(reviewed.navigationAllowlistImpacts?.length, recipients.length);
  assert.ok(
    reviewed.navigationAllowlistImpacts?.every(
      (row) => row.before === 1 && row.after === 0 && row.removed === 1,
    ),
  );
  await applyNetworkSettings(f.api, {
    operationId: preview.operationId,
    previewHash: preview.previewHash,
  });
  const complete = await getNetworkSettingsOperation(f.api, preview.operationId);
  assert.deepEqual(complete.navigationAllowlistImpacts, reviewed.navigationAllowlistImpacts);
  assert.deepEqual((await readCompleteNetworkSettings(f.api, f.scope)).fields, f.read.fields);
});
test('a delayed operation phase cannot regress a launched or committed view', () => {
  const base: NetworkSettingsOperationResponse = {
    operationId: crypto.randomUUID(),
    entityType: 'chat',
    section: 'links',
    expiresAt: new Date().toISOString(),
    status: 'RUNNING',
    outcomes: [{ entityId: 'a', status: 'COMMITTED' }],
  };
  assert.equal(
    mergeNetworkSettingsOperation(base, {
      ...base,
      status: 'PREPARED',
      outcomes: [{ entityId: 'a', status: 'VALIDATED' }],
    }),
    base,
  );
});

test('initial operation restore rejects another UUID, section, type or frozen recipient set', async () => {
  const expected = {
    operationId: crypto.randomUUID(),
    entityType: 'chat',
    section: 'links',
    recipientIds: ['chat-a'],
  } as const;
  const base: NetworkSettingsOperationResponse = {
    operationId: expected.operationId,
    entityType: 'chat',
    section: 'links',
    status: 'COMPLETE',
    expiresAt: new Date().toISOString(),
    outcomes: [{ entityId: 'chat-a', status: 'COMPLETE' }],
  };
  for (const wrong of [
    { ...base, operationId: crypto.randomUUID() },
    { ...base, section: 'greeting' },
    { ...base, entityType: 'channel' },
    { ...base, outcomes: [{ entityId: 'chat-other', status: 'COMPLETE' }] },
    {
      ...base,
      outcomes: [
        { entityId: 'chat-a', status: 'COMPLETE' },
        { entityId: 'chat-a', status: 'COMPLETE' },
      ],
    },
  ]) {
    const api: ApiTransport = {
      requestKeepalive() {},
      async request() {
        return wrong;
      },
    };
    await assert.rejects(
      readVerifiedNetworkSettingsOperation(api, {
        ...expected,
        recipientIds: [...expected.recipientIds],
      }),
    );
  }
  const api: ApiTransport = {
    requestKeepalive() {},
    async request() {
      return base;
    },
  };
  assert.equal(
    (
      await readVerifiedNetworkSettingsOperation(api, {
        ...expected,
        recipientIds: [...expected.recipientIds],
      })
    ).operationId,
    expected.operationId,
  );
});

test('operation merge preserves terminal identity and monotonic recipient progress', () => {
  const base: NetworkSettingsOperationResponse = {
    operationId: crypto.randomUUID(),
    entityType: 'chat',
    section: 'links',
    status: 'RUNNING',
    expiresAt: new Date().toISOString(),
    outcomes: [{ entityId: 'chat-a', status: 'COMMITTED' }],
  };
  assert.equal(
    mergeNetworkSettingsOperation(base, { ...base, operationId: crypto.randomUUID() }),
    base,
  );
  assert.equal(
    mergeNetworkSettingsOperation(base, {
      ...base,
      outcomes: [{ entityId: 'chat-a', status: 'AUTHORIZED' }],
    }).outcomes[0].status,
    'COMMITTED',
  );
  const complete: NetworkSettingsOperationResponse = {
    ...base,
    status: 'COMPLETE',
    outcomes: [{ entityId: 'chat-a', status: 'COMPLETE' }],
  };
  assert.equal(mergeNetworkSettingsOperation(complete, { ...base, status: 'FAILED' }), complete);
  const followupPending: NetworkSettingsOperationResponse = { ...base, status: 'COMPLETE' };
  assert.equal(isNetworkSettingsOperationSettled(followupPending), false);
  assert.equal(
    mergeNetworkSettingsOperation(followupPending, complete).outcomes[0].status,
    'COMPLETE',
  );
  assert.equal(isNetworkSettingsOperationSettled(complete), true);
  assert.throws(() => mergeNetworkSettingsOperation(base, { ...base, section: 'greeting' }));
  assert.throws(() =>
    mergeNetworkSettingsOperation(base, {
      ...base,
      outcomes: [{ entityId: 'other', status: 'COMMITTED' }],
    }),
  );
});

test('completion proof requires COMPLETE for the exact operation and every frozen recipient', () => {
  const receipt: NetworkSettingsOperationReceipt = {
    version: 1,
    scopeId: crypto.randomUUID(),
    userId: 'actor',
    entityType: 'chat',
    section: 'links',
    title: 'Важное',
    operationId: crypto.randomUUID(),
    launchState: 'uncertain',
    updatedAt: new Date().toISOString(),
    recipientIds: ['chat-a'],
  };
  const operation: NetworkSettingsOperationResponse = {
    operationId: receipt.operationId,
    entityType: 'chat',
    section: 'links',
    status: 'COMPLETE',
    expiresAt: new Date().toISOString(),
    outcomes: [{ entityId: 'chat-a', status: 'COMMITTED' }],
  };
  assert.equal(
    networkSettingsReceiptForStatus(receipt, operation).completionConfirmedAt,
    undefined,
  );
  assert.equal(
    networkSettingsReceiptForStatus(receipt, {
      ...operation,
      status: 'PARTIAL',
      outcomes: [{ entityId: 'chat-a', status: 'COMPLETE' }],
    }).completionConfirmedAt,
    undefined,
  );
  const complete = networkSettingsReceiptForStatus(receipt, {
    ...operation,
    outcomes: [{ entityId: 'chat-a', status: 'COMPLETE' }],
  });
  assert.ok(complete.completionConfirmedAt);
  assert.equal(complete.launchState, 'submitted');
  assert.throws(() =>
    networkSettingsReceiptForStatus(receipt, { ...operation, operationId: crypto.randomUUID() }),
  );
});

test('preflight abort exposes every proven-unwritten recipient for retry only after atomic settlement', () => {
  const previous: NetworkSettingsOperationResponse = {
    operationId: crypto.randomUUID(),
    entityType: 'chat',
    section: 'links',
    status: 'AUTHORIZING',
    expiresAt: new Date().toISOString(),
    outcomes: [
      { entityId: 'denied', status: 'FAILED', failureCode: 'DENIED' },
      { entityId: 'pending', status: 'PENDING' },
      { entityId: 'validated', status: 'VALIDATED' },
      { entityId: 'authorized', status: 'AUTHORIZED' },
    ],
  };
  const incomplete = { ...previous, status: 'FAILED' as const };
  assert.equal(isNetworkSettingsOperationSettled(incomplete), false);
  assert.deepEqual(networkSettingsFailedRecipients(incomplete), []);
  const settled = mergeNetworkSettingsOperation(incomplete, {
    ...incomplete,
    outcomes: previous.outcomes.map((row) =>
      row.status === 'FAILED'
        ? row
        : { entityId: row.entityId, status: 'FAILED', failureCode: 'PREFLIGHT_ABORTED' },
    ),
  });
  assert.equal(isNetworkSettingsOperationSettled(settled), true);
  assert.deepEqual(networkSettingsFailedRecipients(settled), [
    'denied',
    'pending',
    'validated',
    'authorized',
  ]);
  assert.equal(settled.outcomes[0].failureCode, 'DENIED');
  const stale = mergeNetworkSettingsOperation(settled, incomplete);
  assert.deepEqual(
    networkSettingsFailedRecipients(stale),
    networkSettingsFailedRecipients(settled),
  );
  assert.equal(isNetworkSettingsOperationSettled(stale), true);
});

test('failed operation never offers retry while any recipient is pending or has an uncertain followup', () => {
  const base: NetworkSettingsOperationResponse = {
    operationId: crypto.randomUUID(),
    entityType: 'chat',
    section: 'links',
    status: 'FAILED',
    expiresAt: new Date().toISOString(),
    outcomes: [{ entityId: 'conflict', status: 'FAILED', failureCode: 'CONFLICT' }],
  };
  for (const status of ['PENDING', 'VALIDATED', 'AUTHORIZED', 'COMMITTED'] as const) {
    const incomplete: NetworkSettingsOperationResponse = {
      ...base,
      outcomes: [...base.outcomes, { entityId: 'unresolved', status }],
    };
    assert.equal(isNetworkSettingsOperationSettled(incomplete), false, status);
    assert.deepEqual(networkSettingsFailedRecipients(incomplete), [], status);
  }
  const committed: NetworkSettingsOperationResponse = {
    ...base,
    outcomes: [...base.outcomes, { entityId: 'committed', status: 'COMMITTED' }],
  };
  const settled = mergeNetworkSettingsOperation(committed, {
    ...committed,
    outcomes: [...base.outcomes, { entityId: 'committed', status: 'COMPLETE' }],
  });
  assert.equal(isNetworkSettingsOperationSettled(settled), true);
  assert.deepEqual(networkSettingsFailedRecipients(settled), ['conflict']);
  assert.equal(settled.outcomes[0].failureCode, 'CONFLICT');
  assert.deepEqual(networkSettingsFailedRecipients(null), []);
});

test('launched results stay read-only through every terminal status until a fresh scope is opened', () => {
  const receipt: NetworkSettingsOperationReceipt = {
    version: 1,
    scopeId: crypto.randomUUID(),
    userId: 'actor',
    entityType: 'chat',
    section: 'links',
    title: 'Важное',
    operationId: crypto.randomUUID(),
    launchState: 'submitted',
    updatedAt: new Date().toISOString(),
  };
  for (const lastKnownStatus of ['COMPLETE', 'PARTIAL', 'FAILED'] as const) {
    assert.equal(networkSettingsResultReadOnly({ ...receipt, lastKnownStatus }), true);
  }
  assert.equal(networkSettingsResultReadOnly({ ...receipt, launchState: 'launching' }), true);
  assert.equal(networkSettingsResultReadOnly({ ...receipt, launchState: 'uncertain' }), true);
  assert.equal(networkSettingsResultReadOnly(null, receipt.operationId), true);
  assert.equal(networkSettingsResultReadOnly(null), false);
  assert.equal(networkSettingsResultReadOnly({ ...receipt, launchState: 'unconfirmed' }), false);
});
