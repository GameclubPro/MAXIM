import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getManagedEntityFavoriteLabels,
  updateManagedEntityFavoriteLabels,
} from '../src/lib/api/managed-entity-favorites-client';
import type { ApiRequestInit, ApiTransport } from '../src/lib/api/transport';

test('loads server-authoritative favorite category labels', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      return {
        initialized: true,
        labels: { important: 'VIP чаты', watch: 'Особый контроль' },
        revision: 3,
      };
    },
  };

  await assert.doesNotReject(async () => {
    assert.deepEqual(await getManagedEntityFavoriteLabels(api), {
      initialized: true,
      labels: { important: 'VIP чаты', watch: 'Особый контроль' },
      revision: 3,
    });
  });
  assert.equal(calls[0]?.path, '/managed-entities/favorite-labels');
  assert.equal(calls[0]?.init?.method, undefined);
});

test('initializes legacy local labels without requesting a destructive replace', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      return {
        initialized: true,
        labels: { important: 'Серверное название' },
        revision: 5,
      };
    },
  };

  const result = await updateManagedEntityFavoriteLabels(
    api,
    { important: 'Локальное название' },
    { mode: 'initialize' },
  );

  assert.deepEqual(result, {
    initialized: true,
    labels: { important: 'Серверное название' },
    revision: 5,
  });
  assert.equal(calls[0]?.path, '/managed-entities/favorite-labels');
  assert.equal(calls[0]?.init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    labels: { important: 'Локальное название' },
    mode: 'initialize',
  });
});

test('replaces labels with the latest expected revision', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      return { initialized: true, labels: { important: 'VIP' }, revision: 8 };
    },
  };

  await updateManagedEntityFavoriteLabels(api, { important: 'VIP' }, { expectedRevision: 7 });

  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    labels: { important: 'VIP' },
    mode: 'replace',
    expectedRevision: 7,
  });
});

test('rejects malformed favorite label responses instead of replacing the local cache', async () => {
  const api: ApiTransport = {
    request: async () => ({
      initialized: true,
      labels: { important: '' },
      revision: 1,
    }),
  };

  await assert.rejects(
    () => getManagedEntityFavoriteLabels(api),
    /Invalid managed entity favorite labels response/u,
  );
});

test('rejects contradictory or unknown favorite label responses', async () => {
  const responses = [
    { initialized: false, labels: { important: 'VIP' }, revision: null },
    { initialized: true, labels: { unknown: 'VIP' }, revision: 1 },
    { initialized: true, labels: { important: 'VIP\u0000' }, revision: 1 },
    { initialized: true, labels: { important: 'VIP' } },
    { initialized: true, labels: { important: 'VIP' }, revision: 1.5 },
    { initialized: true, labels: { important: 'VIP' }, revision: 1, extra: true },
  ];

  for (const response of responses) {
    const api: ApiTransport = { request: async () => response };
    await assert.rejects(
      () => getManagedEntityFavoriteLabels(api),
      /Invalid managed entity favorite labels response/u,
    );
  }
});
