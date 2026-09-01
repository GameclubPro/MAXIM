import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('preview channel comment threads stay isolated per token', async () => {
  const api = createPreviewApiTransport();
  const tokenA = 'preview-comments-token-0001';
  const tokenB = 'preview-comments-token-0002';

  const initialThreadA = (await api.request(
    `/channels/preview-channel/dialog/comments?token=${tokenA}`,
  )) as {
    messages: Array<{ text: string }>;
  };
  const initialThreadB = (await api.request(
    `/channels/preview-channel/dialog/comments?token=${tokenB}`,
  )) as {
    messages: Array<{ text: string }>;
  };

  assert.equal(initialThreadA.messages.length, initialThreadB.messages.length);

  await api.request('/channels/preview-channel/dialog/comments/messages', {
    method: 'POST',
    body: JSON.stringify({
      token: tokenA,
      text: 'Комментарий только для первого поста',
    }),
  });

  const nextThreadA = (await api.request(
    `/channels/preview-channel/dialog/comments?token=${tokenA}`,
  )) as {
    messages: Array<{ text: string }>;
  };
  const nextThreadB = (await api.request(
    `/channels/preview-channel/dialog/comments?token=${tokenB}`,
  )) as {
    messages: Array<{ text: string }>;
  };

  assert.equal(nextThreadA.messages.length, initialThreadA.messages.length + 1);
  assert.equal(nextThreadB.messages.length, initialThreadB.messages.length);
  assert.equal(nextThreadA.messages.at(-1)?.text, 'Комментарий только для первого поста');
  assert.equal(
    nextThreadB.messages.some((message) => message.text === 'Комментарий только для первого поста'),
    false,
  );
});

test('preview suggestion history includes an unreachable-editor delivery state', async () => {
  const api = createPreviewApiTransport();
  const response = (await api.request(
    '/channels/preview-channel/dialog/suggest?token=preview-suggest-token-0001',
  )) as {
    messages: Array<{
      id: string;
      suggestionDelivery?: {
        state: string;
        deliveredCount: number;
        targetCount: number;
        pendingCount: number;
        unreachableCount: number;
      };
    }>;
  };
  const unreachable = response.messages.find((message) => message.id === 'channel-suggest-3');

  assert.deepEqual(unreachable?.suggestionDelivery, {
    state: 'no_reachable_editor',
    deliveredCount: 0,
    targetCount: 0,
    pendingCount: 0,
    unreachableCount: 0,
  });
});
