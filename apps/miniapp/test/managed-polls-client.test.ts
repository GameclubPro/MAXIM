import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedEntityType } from '@maxim/contracts';
import {
  MANAGED_POLL_MUTATION_TIMEOUT_MS,
  createManagedPoll,
  getManagedPolls,
  publishManagedPoll,
  updateManagedPoll,
} from '../src/lib/api/managed-polls-client';
import { managedPollQueryKeys } from '../src/lib/managed-poll-query-keys';
import type { ApiRequestInit, ApiTransport } from '../src/lib/api/transport';

for (const entityType of ['chat', 'channel'] as const satisfies readonly ManagedEntityType[]) {
  test(`${entityType} poll mutations preserve authored text and reserve publication time`, async () => {
    const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
    const api: ApiTransport = {
      request: async (path, init) => {
        calls.push({ path, init });
        throw new Error('stop after request options');
      },
      requestKeepalive: () => undefined,
    };
    const payload = {
      question: 'Только текст администратора',
      questionFormat: 'plain' as const,
      visibility: 'ANONYMOUS' as const,
      images: [],
      options: [
        { id: 'option-1', text: 'Первый ответ' },
        { id: 'option-2', text: 'Второй ответ' },
      ],
    };
    const expectedUpdatedAt = '2026-08-19T10:00:00.000Z';
    const collection = entityType === 'chat' ? 'chats' : 'channels';

    await assert.rejects(
      () => createManagedPoll(api, entityType, 'entity-1', payload),
      /stop after request/u,
    );
    await assert.rejects(
      () =>
        updateManagedPoll(api, entityType, 'entity-1', 'poll-1', {
          ...payload,
          expectedUpdatedAt,
        }),
      /stop after request/u,
    );
    await assert.rejects(
      () => publishManagedPoll(api, entityType, 'entity-1', 'poll-1'),
      /stop after request/u,
    );

    assert.deepEqual(
      calls.map((call) => call.path),
      [
        `/${collection}/entity-1/polls`,
        `/${collection}/entity-1/polls/poll-1`,
        `/${collection}/entity-1/polls/poll-1/publish`,
      ],
    );
    assert.deepEqual(
      calls.map((call) => call.init?.timeoutMs),
      [
        MANAGED_POLL_MUTATION_TIMEOUT_MS,
        MANAGED_POLL_MUTATION_TIMEOUT_MS,
        MANAGED_POLL_MUTATION_TIMEOUT_MS,
      ],
    );

    const bodies = calls.slice(0, 2).map((call) => JSON.parse(String(call.init?.body)));
    for (const body of bodies) {
      assert.equal(body.question, payload.question);
      assert.deepEqual(
        body.options.map((option: { text: string }) => option.text),
        payload.options.map((option) => option.text),
      );
      assert.equal(JSON.stringify(body).includes('Опрос'), false);
      assert.equal(JSON.stringify(body).includes('голос'), false);
    }
    assert.equal('expectedUpdatedAt' in bodies[0], false);
    assert.equal(bodies[1].expectedUpdatedAt, expectedUpdatedAt);
  });
}

test('poll list client serializes scope and pagination', async () => {
  const calls: string[] = [];
  const api: ApiTransport = {
    request: async (path) => {
      calls.push(path);
      return { items: [], nextCursor: null, total: 0 };
    },
    requestKeepalive: () => undefined,
  };

  await getManagedPolls(api, 'chat', 'entity/1', {
    scope: 'archive',
    cursor: 'cursor value',
    limit: 7,
  });

  assert.deepEqual(calls, ['/chats/entity%2F1/polls?scope=archive&cursor=cursor+value&limit=7']);
});

test('poll query keys isolate entities and list scopes', () => {
  assert.notDeepEqual(
    managedPollQueryKeys.list('chat', 'same-id', 'current'),
    managedPollQueryKeys.list('channel', 'same-id', 'current'),
  );
  assert.notDeepEqual(
    managedPollQueryKeys.list('chat', 'same-id', 'current'),
    managedPollQueryKeys.list('chat', 'same-id', 'archive'),
  );
});
