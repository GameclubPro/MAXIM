import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelStatsResponse } from '@maxim/contracts/channel-stats';
import {
  closeChannelManagedPoll,
  createChannelManagedPoll,
  deleteChannelManagedPoll,
  getChannelManagedPollVoters,
  getChannelManagedPolls,
  publishChannelManagedPoll,
  refreshChannelManagedPollPublication,
  resetChannelManagedPollPublication,
  updateChannelManagedPoll,
} from '../src/lib/api/channel-polls-client';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('preview channel polls support history, voters, and draft lifecycle', async () => {
  const api = createPreviewApiTransport();
  const initial = await getChannelManagedPolls(api, 'preview-channel');
  const firstPage = await getChannelManagedPolls(api, 'preview-channel', { limit: 1 });

  assert.equal(firstPage.items.length, 1);
  assert.equal(typeof firstPage.nextCursor, 'string');

  assert.equal(
    initial.items.some((poll) => poll.status === 'ACTIVE'),
    true,
  );
  assert.equal(
    initial.items.some((poll) => poll.status === 'CLOSED'),
    true,
  );
  await assert.rejects(
    createChannelManagedPoll(api, 'preview-channel', {
      question: 'Второй текущий опрос?',
      visibility: 'ANONYMOUS',
      options: [{ text: 'Да' }, { text: 'Нет' }],
    }),
    /Сначала завершите текущий опрос/u,
  );

  const voters = await getChannelManagedPollVoters(api, 'preview-channel', 'poll-channel-active', {
    limit: 2,
  });
  assert.equal(voters.items.length, 2);
  assert.equal(typeof voters.nextCursor, 'string');

  const repaired = await refreshChannelManagedPollPublication(
    api,
    'preview-channel',
    'poll-channel-closed',
  );
  assert.equal(repaired.renderRepairNeeded, false);
  await assert.rejects(
    resetChannelManagedPollPublication(api, 'preview-channel', 'poll-channel-active'),
    /Публикация не требует сброса/u,
  );

  await closeChannelManagedPoll(api, 'preview-channel', 'poll-channel-active');

  const created = await createChannelManagedPoll(api, 'preview-channel', {
    question: 'Какой день удобнее?',
    visibility: 'ANONYMOUS',
    options: [
      { id: 'client-option-1', text: 'Пятница' },
      { id: 'client-option-2', text: 'Суббота' },
    ],
  });
  assert.equal(created.status, 'DRAFT');
  assert.equal(
    created.options.some((option) => option.id.startsWith('client-option-')),
    false,
  );

  const updated = await updateChannelManagedPoll(api, 'preview-channel', created.id, {
    question: 'Когда встречаемся?',
    visibility: 'OPEN',
    options: created.options.map((option) => ({ id: option.id, text: option.text })),
  });
  assert.equal(updated.visibility, 'OPEN');

  const published = await publishChannelManagedPoll(api, 'preview-channel', created.id);
  assert.equal(published.status, 'ACTIVE');
  const closed = await closeChannelManagedPoll(api, 'preview-channel', created.id);
  assert.equal(closed.status, 'CLOSED');

  const disposable = await createChannelManagedPoll(api, 'preview-channel', {
    question: 'Удалить этот черновик?',
    visibility: 'ANONYMOUS',
    options: [{ text: 'Да' }, { text: 'Нет' }],
  });
  await deleteChannelManagedPoll(api, 'preview-channel', disposable.id);
  const final = await getChannelManagedPolls(api, 'preview-channel');
  assert.equal(
    final.items.some((poll) => poll.id === disposable.id),
    false,
  );
});

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

  const stats = (await api.request(
    '/channels/preview-channel/stats?range=24h',
  )) as ChannelStatsResponse;
  const currentViews = stats.official.series.views;
  const currentMembership = stats.official.series.membership;
  const currentParticipants = stats.official.series.participants;
  const previousViews = stats.comparison.series?.views ?? [];

  assert.equal(stats.period.bucket, 'hour');
  assert.equal(currentViews.length > 0, true);
  assert.equal(previousViews.length > 0, true);
  assert.deepEqual(
    currentMembership.map((point) => point.at),
    currentViews.map((point) => point.at),
  );
  assert.deepEqual(
    currentParticipants.map((point) => point.at),
    currentViews.map((point) => point.at),
  );
  for (let index = 1; index < currentViews.length; index += 1) {
    assert.equal(
      Date.parse(currentViews[index]!.at) - Date.parse(currentViews[index - 1]!.at),
      60 * 60 * 1000,
    );
  }
  assert.equal(
    currentViews.some((point) => point.posts > 0),
    true,
  );
  assert.equal(
    currentViews.some((point) => point.posts === 0 && point.views === 0),
    true,
  );
  assert.equal(
    previousViews.every((point) => Number.isInteger(point.posts)),
    true,
  );
  assert.equal(stats.summary.daily.at(-1)?.source, 'flow');
  assert.equal(stats.summary.daily.at(-1)?.confidence, 'medium');
});

test('preview channel stats overview mirrors production lightweight fields', async () => {
  const api = createPreviewApiTransport();

  const stats = (await api.request(
    '/channels/preview-channel/stats?range=7d&mode=overview&includeActivityPreview=false',
  )) as ChannelStatsResponse;
  const expectedAverage = Math.round(
    stats.official.content.views / Math.max(1, stats.official.content.posts),
  );

  assert.equal(stats.official.content.topPosts.length, 0);
  assert.equal(stats.official.content.topReactions.length, 0);
  assert.equal(stats.signals.bestWindows.length, 0);
  assert.equal(stats.comparison.series, undefined);
  assert.equal(stats.comparison.deltas.averageViewsPerPost.current, expectedAverage);
  assert.equal(stats.activityFeed.items.length, 0);
});
