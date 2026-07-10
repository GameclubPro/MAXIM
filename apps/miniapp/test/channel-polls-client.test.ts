import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANAGED_POLL_MUTATION_TIMEOUT_MS,
  createChannelManagedPoll,
  publishChannelManagedPoll,
  updateChannelManagedPoll,
} from '../src/lib/api/channel-polls-client';
import type { ApiRequestInit, ApiTransport } from '../src/lib/api/transport';

test('channel poll mutations reserve time for image uploads and publication', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      throw new Error('stop after request options');
    },
    requestKeepalive: () => undefined,
  };
  const payload = {
    question: 'Когда встречаемся?',
    questionFormat: 'plain' as const,
    visibility: 'ANONYMOUS' as const,
    images: [],
    options: [
      { id: 'option-1', text: 'В пятницу' },
      { id: 'option-2', text: 'В субботу' },
    ],
  };

  await assert.rejects(
    () => createChannelManagedPoll(api, 'channel-1', payload),
    /stop after request/u,
  );
  await assert.rejects(
    () => updateChannelManagedPoll(api, 'channel-1', 'poll-1', payload),
    /stop after request/u,
  );
  await assert.rejects(
    () => publishChannelManagedPoll(api, 'channel-1', 'poll-1'),
    /stop after request/u,
  );

  assert.deepEqual(
    calls.map((call) => call.init?.timeoutMs),
    [
      MANAGED_POLL_MUTATION_TIMEOUT_MS,
      MANAGED_POLL_MUTATION_TIMEOUT_MS,
      MANAGED_POLL_MUTATION_TIMEOUT_MS,
    ],
  );
});
