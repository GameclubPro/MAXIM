import assert from 'node:assert/strict';
import test from 'node:test';
import {
  combineManagedEntityLeaveGuards,
  managedEntityNavigationIdentity,
  managedEntityNavigationTargetIdentity,
} from '../src/lib/managed-entity-leave-guards';
import {
  buildNetworkRoute,
  networkSelectionTarget,
  readNetworkRoute,
  resolveNetworkRouteOperation,
  toggleNetworkRecipient,
  readNetworkRecipientSelection,
  saveNetworkRecipientSelection,
} from '../src/features/networks/network-route-state';

test('returning from settings restores selection only for the same actor, type, network and composition', () => {
  const state = readNetworkRoute('?type=chat&category=watch&range=30d&tab=communities');
  saveNetworkRecipientSelection('actor-a', state, 'composition-a', { mode: 'category' });
  assert.deepEqual(readNetworkRecipientSelection('actor-a', state, 'composition-a'), {
    mode: 'category',
  });
  for (const [actor, route, revision] of [
    ['actor-b', state, 'composition-a'],
    ['actor-a', { ...state, entityType: 'channel' as const }, 'composition-a'],
    ['actor-a', { ...state, favoriteType: 'test' as const }, 'composition-a'],
    ['actor-a', state, 'composition-b'],
  ] as const) {
    assert.deepEqual(readNetworkRecipientSelection(actor, route, revision), {
      mode: 'selected',
      entityIds: [],
    });
  }
  const ids = ['first', 'beyond-loaded-page'];
  saveNetworkRecipientSelection('actor-a', state, 'composition-a', {
    mode: 'selected',
    entityIds: ids,
  });
  ids.push('later');
  assert.deepEqual(readNetworkRecipientSelection('actor-a', state, 'composition-a'), {
    mode: 'selected',
    entityIds: ['first', 'beyond-loaded-page'],
  });
});

test('operation recovery requires an exact actor, scope, type and section receipt', () => {
  const receipt = {
    userId: 'u1',
    scopeId: 'scope-a',
    entityType: 'chat' as const,
    section: 'links' as const,
    operationId: 'operation-a',
    updatedAt: '2026-10-22T05:00:00Z',
  };
  const input = {
    userId: 'u1',
    scopeId: 'scope-a',
    entityType: 'chat' as const,
    section: 'links',
    receipts: [receipt],
  };
  assert.deepEqual(resolveNetworkRouteOperation(input), {
    kind: 'resume',
    operationId: 'operation-a',
  });
  for (const change of [
    { userId: 'u2' },
    { scopeId: 'scope-b' },
    { entityType: 'channel' as const },
    { section: 'greeting' },
  ]) {
    assert.deepEqual(
      resolveNetworkRouteOperation({ ...input, ...change, requestedOperationId: 'operation-a' }),
      { kind: 'unavailable' },
    );
  }
  assert.deepEqual(
    resolveNetworkRouteOperation({ ...input, requestedOperationId: 'operation-b' }),
    { kind: 'unavailable' },
  );
  assert.deepEqual(resolveNetworkRouteOperation({ ...input, scopeId: 'scope-b' }), {
    kind: 'none',
  });
  assert.deepEqual(
    resolveNetworkRouteOperation({
      ...input,
      receipts: [{ ...receipt, operationId: 'newer', updatedAt: '2026-10-22T05:10:00Z' }, receipt],
    }),
    { kind: 'resume', operationId: 'newer' },
  );
});

test('network route keeps type, category, period and tab, rejecting unknown categories', () => {
  const state = readNetworkRoute('?type=channel&category=partner&range=30d&tab=communities');
  assert.deepEqual(
    readNetworkRoute(new URL(buildNetworkRoute(state), 'https://local').search),
    state,
  );
  assert.deepEqual(readNetworkRoute('?type=other&category=custom&range=all&tab=settings'), {
    entityType: 'chat',
    favoriteType: null,
    range: '7d',
    tab: 'overview',
  });
});
test('whole network remains a server category target regardless of loaded or selected IDs', () => {
  const all = { mode: 'category' } as const;
  assert.deepEqual(networkSelectionTarget(all, 'watch'), {
    mode: 'category',
    favoriteType: 'watch',
  });
  assert.equal(toggleNetworkRecipient(all, 'unloaded'), all);
  assert.equal(networkSelectionTarget({ mode: 'selected', entityIds: [] }, 'watch'), null);
  const full = {
    mode: 'selected' as const,
    entityIds: Array.from({ length: 500 }, (_, i) => String(i)),
  };
  assert.equal(networkSelectionTarget(full, 'watch')?.mode, 'selected');
  assert.deepEqual(toggleNetworkRecipient(full, '501'), full);
  assert.equal(
    networkSelectionTarget({ mode: 'selected', entityIds: [...full.entityIds, '501'] }, 'watch'),
    null,
  );
  assert.equal(
    networkSelectionTarget({ mode: 'selected', entityIds: ['1', '1'] }, 'watch')?.mode,
    'selected',
  );
});
test('same-path group scope changes are dirty exits, individual query changes preserve prior behavior', () => {
  const path = '/networks/chat/settings/links';
  const current = managedEntityNavigationIdentity(path, '?scope=a');
  assert.notEqual(managedEntityNavigationTargetIdentity('?scope=b', path), current);
  assert.equal(managedEntityNavigationTargetIdentity({ search: '?scope=a' }, path), current);
  assert.notEqual(
    managedEntityNavigationTargetIdentity(`${path}?scope=a&operation=x`, path),
    current,
  );
  assert.equal(
    managedEntityNavigationTargetIdentity(`${path}?operation=x&scope=a`, path),
    managedEntityNavigationIdentity(path, '?scope=a&operation=x'),
  );
  assert.notEqual(managedEntityNavigationTargetIdentity(path, path), current);
  assert.equal(managedEntityNavigationTargetIdentity('relative', path), null);
  assert.equal(
    managedEntityNavigationIdentity('/chat/1/settings', '?section=links'),
    managedEntityNavigationTargetIdentity('/chat/1/settings?section=extra', '/chat/1/settings'),
  );
});
test('one dirty group guard forbids save-and-leave across combined guards', async () => {
  let writes = 0;
  let discarded = 0;
  const combined = combineManagedEntityLeaveGuards([
    () => ({
      dirty: true,
      save: async () => {
        writes += 1;
        return true;
      },
      discard: () => {
        discarded += 1;
      },
    }),
    () => ({
      dirty: true,
      discardOnly: true,
      save: async () => {
        writes += 1;
        return true;
      },
      discard: () => {
        discarded += 1;
      },
    }),
  ]);
  assert.equal(combined.discardOnly, true);
  assert.equal(await combined.save(), false);
  assert.equal(writes, 0);
  combined.discard();
  assert.equal(discarded, 2);
  const cleanGroup = combineManagedEntityLeaveGuards([
    () => ({ dirty: false, discardOnly: true, save: async () => true, discard: () => undefined }),
  ]);
  assert.equal(cleanGroup.discardOnly, false);
  assert.equal(await cleanGroup.save(), true);
});
