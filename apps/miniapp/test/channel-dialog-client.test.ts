import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelDialogMessage } from '../src/lib/api/channel-dialog-client';
import type { ApiTransport } from '../src/lib/api/transport';

const RESPONSE_MESSAGE = {
  id: 'suggestion-1',
  type: 'suggest' as const,
  text: 'Новая идея',
  authorUserId: 'user-1',
  authorDisplayName: 'Автор',
  createdAt: '2026-09-01T12:00:00.000Z',
};

test('channel dialog client validates and forwards suggestion request identities', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { ok: true, message: RESPONSE_MESSAGE };
    },
    requestKeepalive: () => undefined,
  } satisfies ApiTransport;

  const response = await createChannelDialogMessage(api, 'channel-1', 'suggest', {
    token: 'suggest-token-123456',
    requestId: 'publisher-suggestion_12345678',
    text: 'Новая идея',
    textFormat: 'markdown',
    images: [],
  });

  assert.equal(calls[0]?.path, '/channels/channel-1/dialog/suggest/messages');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    token: 'suggest-token-123456',
    requestId: 'publisher-suggestion_12345678',
    text: 'Новая идея',
    textFormat: 'markdown',
    attachments: [],
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    images: [],
  });
  assert.equal(response.message.id, 'suggestion-1');
  assert.equal(response.message.reviewStatus, undefined);
});

test('channel dialog client rejects malformed successful responses', async () => {
  const api = {
    request: async () => ({ ok: true, message: { id: 'incomplete' } }),
    requestKeepalive: () => undefined,
  } satisfies ApiTransport;

  await assert.rejects(
    createChannelDialogMessage(api, 'channel-1', 'suggest', {
      token: 'suggest-token-123456',
      requestId: 'publisher-suggestion_12345678',
      text: 'Новая идея',
      textFormat: 'markdown',
    }),
    { name: 'ZodError' },
  );
});
