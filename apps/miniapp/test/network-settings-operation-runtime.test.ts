import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  NetworkSettingsOperationResponse,
  NetworkSettingsPreviewResponse,
  NetworkSettingsReadResponse,
} from '@maxim/contracts/network-settings';
import type { ApiTransport } from '../src/lib/api/transport';
import type { NetworkSettingsOperationReceipt } from '../src/lib/network-settings-operation-storage';
import type { NetworkSettingsEditorScope } from '../src/lib/network-settings-workspace-state';
import {
  mergeNetworkSettingsOperation,
  networkSettingsReceiptForStatus,
  readVerifiedNetworkSettingsOperation,
  withNetworkSettingsOperationRuntime,
} from '../src/features/network-settings/network-settings-controller';
import * as runtime from '../src/features/network-settings/network-settings-operation-runtime';
import type { NetworkSettingsOperationPort } from '../src/features/network-settings/network-settings-operation-runtime';
import { assertNetworkSettingsOperationCurrent } from '../src/features/network-settings/network-settings-operation-state';
import {
  applyNetworkSettings,
  previewNetworkSettings,
} from '../src/lib/api/network-settings-client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    persist?: (receipt: NetworkSettingsOperationReceipt) => Promise<void>;
    loseApplyResponse?: boolean;
  } = {},
) {
  const events: string[] = [];
  const operationId = crypto.randomUUID();
  const hash = 'a'.repeat(64);
  const scope: NetworkSettingsEditorScope = {
    entityType: 'chat',
    initialSection: 'limits',
    target: { mode: 'selected', entityIds: ['chat-a'] },
  };
  const read: NetworkSettingsReadResponse = {
    entityType: 'chat',
    target: scope.target,
    section: 'limits',
    compositionVersion: 'snapshot',
    recipients: [{ entityId: 'chat-a', title: 'A', revision: 1 }],
    fields: {},
    recipientCount: 1,
    complete: true,
    nextCursor: null,
  };
  const reviewed: NetworkSettingsPreviewResponse = {
    operationId,
    previewHash: hash,
    expiresAt: '2099-01-01T00:00:00.000Z',
    status: 'PREPARED',
    entityType: 'chat',
    section: 'limits',
    recipients: read.recipients,
    changes: [{ path: 'antiSpamEnabled', op: 'set', value: true }],
  };
  const prepared: NetworkSettingsOperationResponse = {
    operationId,
    entityType: 'chat',
    section: 'limits',
    status: 'PREPARED',
    expiresAt: reviewed.expiresAt,
    outcomes: [{ entityId: 'chat-a', status: 'VALIDATED' }],
  };
  const complete: NetworkSettingsOperationResponse = {
    ...prepared,
    status: 'COMPLETE',
    outcomes: [{ entityId: 'chat-a', status: 'COMPLETE' }],
  };
  let applyDispatched = false;
  const api: ApiTransport = {
    requestKeepalive() {},
    async request(path, init) {
      if (path.endsWith('/preview')) {
        events.push('api:preview');
        assert.equal(init?.retryMutationOnTransportError, false);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.operationId, operationId);
        return reviewed;
      }
      if (path.endsWith('/apply')) {
        events.push('api:apply');
        assert.equal(init?.retryMutationOnTransportError, false);
        assert.deepEqual(JSON.parse(String(init?.body)), { operationId, previewHash: hash });
        applyDispatched = true;
        if (options.loseApplyResponse) throw new Error('Response lost');
        return complete;
      }
      assert.equal(path, '/networks/settings/operations/' + operationId);
      events.push('api:status');
      return applyDispatched ? complete : prepared;
    },
  };
  let generation = 1;
  let draftKey = 'original';
  let receipt: NetworkSettingsOperationReceipt | null = null;
  let preview: NetworkSettingsPreviewResponse | null = null;
  let operation: NetworkSettingsOperationResponse | null = null;
  let statusIssue = true;
  const makeReceipt: NetworkSettingsOperationPort['makeReceipt'] = (
    id,
    launchState,
    extra = {},
  ) => ({
    version: 1,
    scopeId: '55555555-5555-4555-8555-555555555555',
    userId: 'actor',
    entityType: 'chat',
    section: 'limits',
    title: 'Important',
    operationId: id,
    launchState,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
  const port: NetworkSettingsOperationPort = {
    api,
    scope,
    isCurrent: () => generation === 1 && draftKey === 'original',
    isGenerationCurrent: () => generation === 1,
    makeReceipt,
    async persistNetworkSettingsOperationReceipt(value) {
      events.push('persist:' + value.launchState + ':start');
      await options.persist?.(value);
      events.push('durable:' + value.launchState);
    },
    readVerifiedNetworkSettingsOperation,
    mergeNetworkSettingsOperation,
    networkSettingsReceiptForStatus,
    setReceipt(next) {
      receipt = typeof next === 'function' ? next(receipt) : next;
      events.push('receipt:' + receipt?.launchState);
    },
    setPreview(next) {
      preview = typeof next === 'function' ? next(preview) : next;
      events.push('preview');
    },
    setOperation(next) {
      operation = typeof next === 'function' ? next(operation) : next;
      events.push('operation:' + operation?.status);
    },
    setStatusIssue(next) {
      statusIssue = typeof next === 'function' ? next(statusIssue) : next;
      events.push('statusIssue:' + statusIssue);
    },
  };
  const initial = makeReceipt(operationId, 'unconfirmed', { recipientIds: ['chat-a'] });
  return {
    events,
    port,
    read,
    reviewed,
    prepared,
    initial,
    operationId,
    prepare: () =>
      runtime.prepareNetworkSettingsOperation({
        port,
        initial,
        read,
        changes: reviewed.changes,
      }),
    apply: () => runtime.applyNetworkSettingsOperation({ port, reviewed, operation: prepared }),
    invalidate(reason: string) {
      if (reason === 'draft changed') draftKey = 'later';
      else generation++;
    },
    snapshot: () => ({ receipt, preview, operation, statusIssue }),
  };
}

for (const reason of ['actor or scope changed', 'unmounted', 'draft changed']) {
  for (const action of ['prepare', 'apply'] as const) {
    test(`delayed ${action} runtime causes no persistence or request after ${reason}`, async () => {
      const f = fixture();
      const loaded = deferred<typeof runtime>();
      const result = withNetworkSettingsOperationRuntime(
        f.port.isCurrent,
        () => f[action](),
        () => loaded.promise,
      );
      assert.deepEqual(f.events, []);
      f.invalidate(reason);
      loaded.resolve(runtime);
      await result;
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.snapshot(), {
        receipt: null,
        preview: null,
        operation: null,
        statusIssue: true,
      });
    });
  }
}

test('current delayed runtime prepares once and preserves persistence, preview and status update order', async () => {
  const f = fixture();
  const loaded = deferred<typeof runtime>();
  const result = withNetworkSettingsOperationRuntime(
    f.port.isCurrent,
    (module) =>
      module.prepareNetworkSettingsOperation({
        port: f.port,
        initial: f.initial,
        read: f.read,
        changes: f.reviewed.changes,
      }),
    () => loaded.promise,
  );
  assert.deepEqual(f.events, []);
  loaded.resolve(runtime);
  await result;
  assert.deepEqual(f.events, [
    'persist:unconfirmed:start',
    'durable:unconfirmed',
    'api:preview',
    'persist:unconfirmed:start',
    'durable:unconfirmed',
    'receipt:unconfirmed',
    'preview',
    'api:status',
    'operation:PREPARED',
    'statusIssue:false',
  ]);
  assert.equal(f.snapshot().receipt?.operationId, f.operationId);
  assert.equal(f.snapshot().preview?.previewHash, f.reviewed.previewHash);
});

test('draft change during initial receipt persistence stops preview dispatch', async () => {
  const gate = deferred<void>();
  const f = fixture({ persist: () => gate.promise });
  const result = f.prepare();
  assert.deepEqual(f.events, ['persist:unconfirmed:start']);
  f.invalidate('draft changed');
  gate.resolve();
  await result;
  assert.deepEqual(f.events, ['persist:unconfirmed:start', 'durable:unconfirmed']);
});

test('the durably readable launching receipt and its state update precede the sole apply request', async () => {
  const gate = deferred<void>();
  const f = fixture({
    persist: (receipt) => (receipt.launchState === 'launching' ? gate.promise : Promise.resolve()),
  });
  const result = f.apply();
  assert.deepEqual(f.events, ['persist:launching:start']);
  gate.resolve();
  await result;
  assert.deepEqual(f.events, [
    'persist:launching:start',
    'durable:launching',
    'receipt:launching',
    'api:apply',
    'receipt:submitted',
    'operation:COMPLETE',
    'persist:submitted:start',
    'durable:submitted',
  ]);
  assert.equal(f.events.filter((event) => event === 'api:apply').length, 1);
  assert.equal(f.snapshot().receipt?.operationId, f.operationId);
  assert.ok(f.snapshot().receipt?.completionConfirmedAt);
});

test('launching persistence failure blocks dispatch', async () => {
  const f = fixture({
    persist: async () => {
      throw new Error('Not durably readable');
    },
  });
  await assert.rejects(f.apply(), /Not durably readable/);
  assert.deepEqual(f.events, ['persist:launching:start']);
});

test('draft change during launching persistence preserves its receipt and stops apply dispatch', async () => {
  const gate = deferred<void>();
  const f = fixture({ persist: () => gate.promise });
  const result = f.apply();
  f.invalidate('draft changed');
  gate.resolve();
  await result;
  assert.deepEqual(f.events, ['persist:launching:start', 'durable:launching', 'receipt:launching']);
  assert.equal(f.snapshot().receipt?.operationId, f.operationId);
});

test('lost apply response never replays and status recovery uses the original operation UUID', async () => {
  const f = fixture({ loseApplyResponse: true });
  await assert.rejects(f.apply(), /Response lost/);
  assert.equal(f.events.filter((event) => event === 'api:apply').length, 1);
  assert.equal(f.snapshot().receipt?.launchState, 'launching');
  const status = await readVerifiedNetworkSettingsOperation(f.port.api, {
    operationId: f.operationId,
    entityType: 'chat',
    section: 'limits',
    recipientIds: ['chat-a'],
  });
  assert.equal(status.operationId, f.operationId);
  assert.equal(status.status, 'COMPLETE');
  assert.equal(f.events.filter((event) => event === 'api:apply').length, 1);
});

for (const action of ['preview', 'apply'] as const) {
  test(`canonical ${action} schema loading cannot dispatch for an obsolete draft`, async () => {
    const f = fixture();
    const assertDispatchCurrent = () => assertNetworkSettingsOperationCurrent(f.port.isCurrent);
    const request =
      action === 'preview'
        ? previewNetworkSettings(
            f.port.api,
            {
              entityType: f.read.entityType,
              section: f.read.section,
              target: f.read.target,
              operationId: f.operationId,
              compositionVersion: f.read.compositionVersion,
              recipients: f.read.recipients,
              changes: f.reviewed.changes,
            },
            assertDispatchCurrent,
          )
        : applyNetworkSettings(
            f.port.api,
            {
              operationId: f.operationId,
              previewHash: f.reviewed.previewHash,
            },
            assertDispatchCurrent,
          );
    f.invalidate('draft changed');
    await assert.rejects(request, { name: 'AbortError' });
    assert.deepEqual(f.events, []);
  });
}
