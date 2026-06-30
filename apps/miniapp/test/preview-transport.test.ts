import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelStatsResponse } from '@maxim/contracts/channel-stats';
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

test('preview apply section without target stays scoped to current chat', async () => {
  const api = createPreviewApiTransport();

  const preview = (await api.request('/chats/preview-chat/settings/apply-section-preview', {
    method: 'POST',
    body: JSON.stringify({}),
  })) as {
    targetMode: string;
    updatedChats: number;
    appliedChatIds: string[];
  };
  const applied = (await api.request('/chats/preview-chat/settings/apply-section-to-all', {
    method: 'POST',
    body: JSON.stringify({ section: 'links' }),
  })) as {
    targetMode: string;
    updatedChats: number;
    appliedChatIds: string[];
  };

  assert.equal(preview.targetMode, 'current');
  assert.equal(preview.updatedChats, 1);
  assert.deepEqual(preview.appliedChatIds, ['preview-chat']);
  assert.equal(applied.targetMode, 'current');
  assert.equal(applied.updatedChats, 1);
  assert.deepEqual(applied.appliedChatIds, ['preview-chat']);
});

test('preview channel stats marks empty view buckets with zero posts', async () => {
  const api = createPreviewApiTransport();

  const stats = (await api.request('/channels/preview-channel/stats?range=24h')) as
    ChannelStatsResponse;
  const currentViews = stats.official.series.views;
  const previousViews = stats.comparison.series?.views ?? [];

  assert.equal(currentViews.length > 0, true);
  assert.equal(previousViews.length > 0, true);
  assert.equal(currentViews.some((point) => point.posts > 0), true);
  assert.equal(currentViews.some((point) => point.posts === 0 && point.views === 0), true);
  assert.equal(previousViews.every((point) => Number.isInteger(point.posts)), true);
});
