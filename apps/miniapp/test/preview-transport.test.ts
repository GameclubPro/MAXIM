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

test('preview settings include schema-complete managed broadcast summaries', async () => {
  const api = createPreviewApiTransport();

  const chatSettings = (await api.request('/chats/preview-chat/settings-screen')) as {
    managedBroadcasts: Array<{
      id: string;
      targetMode: string;
      blockedChats: number;
      failureBreakdown: {
        transient: number;
        permanentTarget: number;
        quarantined: number;
        unknown: number;
      };
    }>;
  };
  const channelSettings = (await api.request('/channels/preview-channel/settings-screen')) as {
    managedBroadcasts: Array<{
      id: string;
      targetMode: string;
      blockedChats: number;
      failureBreakdown: {
        transient: number;
        permanentTarget: number;
        quarantined: number;
        unknown: number;
      };
    }>;
  };

  assert.equal(chatSettings.managedBroadcasts[0]?.targetMode, 'current');
  assert.equal(chatSettings.managedBroadcasts[0]?.blockedChats, 0);
  assert.deepEqual(chatSettings.managedBroadcasts[0]?.failureBreakdown, {
    transient: 0,
    permanentTarget: 0,
    quarantined: 0,
    unknown: 0,
  });
  assert.equal(channelSettings.managedBroadcasts[0]?.targetMode, 'current');
  assert.equal(channelSettings.managedBroadcasts[0]?.blockedChats, 0);
  assert.deepEqual(channelSettings.managedBroadcasts[0]?.failureBreakdown, {
    transient: 0,
    permanentTarget: 0,
    quarantined: 0,
    unknown: 0,
  });
});
