import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelStatsResponse } from '@maxim/contracts/channel-stats';
import {
  closeChannelManagedPoll,
  createChannelManagedPoll,
  deleteChannelManagedPoll,
  getChannelManagedPoll,
  getChannelManagedPollVoters,
  getChannelManagedPolls,
  publishChannelManagedPoll,
  refreshChannelManagedPollPublication,
  resetChannelManagedPollPublication,
  updateChannelManagedPoll,
} from '../src/lib/api/channel-polls-client';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  cancelPublication,
  createPublication,
  getPublication,
  listLegacyPublications,
  listPublicationDeliveries,
  listPublications,
  pausePublication,
  resolvePublicationAmbiguousDelivery,
  resumePublication,
  retryPublicationOccurrence,
  testPublication,
  updatePublication,
} from '../src/lib/api/publication-client';

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
    question: '**Какой день** удобнее?',
    questionFormat: 'markdown',
    visibility: 'ANONYMOUS',
    images: [
      {
        base64: 'cHJldmlldy1wb2xsLWltYWdl',
        mimeType: 'image/jpeg',
        fileName: 'poll.jpg',
      },
    ],
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
  assert.equal(created.questionFormat, 'markdown');
  assert.equal(created.images.length, 1);

  const createdSummary = (await getChannelManagedPolls(api, 'preview-channel')).items.find(
    (poll) => poll.id === created.id,
  );
  assert.equal(createdSummary?.imageCount, 1);
  assert.equal('images' in (createdSummary ?? {}), false);

  const createdDetails = await getChannelManagedPoll(api, 'preview-channel', created.id);
  assert.deepEqual(createdDetails.images, created.images);

  const legacyUpdated = await updateChannelManagedPoll(api, 'preview-channel', created.id, {
    question: 'Когда встречаемся?',
    visibility: 'ANONYMOUS',
    options: created.options.map((option) => ({ id: option.id, text: option.text })),
  });
  assert.equal(legacyUpdated.questionFormat, 'markdown');
  assert.deepEqual(legacyUpdated.images, created.images);

  const updated = await updateChannelManagedPoll(api, 'preview-channel', created.id, {
    question: 'Когда встречаемся?',
    questionFormat: 'plain',
    visibility: 'OPEN',
    images: [],
    options: created.options.map((option) => ({ id: option.id, text: option.text })),
  });
  assert.equal(updated.visibility, 'OPEN');
  assert.equal(updated.questionFormat, 'plain');
  assert.equal(updated.imageCount, 0);

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
    botSpeechPreviewProfile: {
      persona: string;
      characterName: string;
    };
    header: {
      primaryBotId: string | null;
      assignedBots: unknown[];
    };
    requiredSubscriptionChannels: Array<{
      primaryBotId: string | null;
      assignedBots: unknown[];
    }>;
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

  assert.deepEqual(chatSettings.botSpeechPreviewProfile, {
    persona: 'male',
    characterName: 'Майор Максимов',
  });
  assert.equal(chatSettings.header.primaryBotId, null);
  assert.deepEqual(chatSettings.header.assignedBots, []);
  assert.equal(chatSettings.requiredSubscriptionChannels[0]?.primaryBotId, null);
  assert.deepEqual(chatSettings.requiredSubscriptionChannels[0]?.assignedBots, []);
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

test('preview publications support list, CRUD, actions, and delivery review', async () => {
  const api = createPreviewApiTransport();
  const plan = await listPublications(api, { view: 'plan', limit: 100 });
  const schedules = await listPublications(api, { view: 'schedules', limit: 100 });
  const history = await listPublications(api, { view: 'history', limit: 100 });
  const channelSchedules = await listPublications(api, {
    view: 'schedules',
    entityType: 'channel',
    limit: 100,
  });
  const failed = await listPublications(api, { view: 'plan', status: 'failed', limit: 100 });
  const firstPlanPage = await listPublications(api, { view: 'plan', limit: 1 });

  assert.equal(
    plan.items.some((publication) => publication.lifecycle === 'ACTIVE'),
    true,
  );
  assert.equal(
    plan.items.some((publication) => publication.lifecycle === 'PAUSED'),
    true,
  );
  assert.equal(
    history.items.some((publication) => publication.lifecycle === 'COMPLETED'),
    true,
  );
  assert.ok(schedules.items.length > 0);
  assert.equal(
    schedules.items.every(
      (publication) =>
        publication.schedule?.mode === 'once' ||
        publication.schedule?.mode === 'slots' ||
        publication.schedule?.mode === 'recurrence',
    ),
    true,
  );
  assert.ok(channelSchedules.items.length > 0);
  assert.equal(
    channelSchedules.items.every(
      (publication) =>
        publication.audienceSelection === 'ALL_MANAGED' ||
        publication.audienceSelection === 'ALL_CHANNELS' ||
        publication.targetPreviews.some((target) => target.entityType === 'channel'),
    ),
    true,
  );
  assert.ok(failed.items.length > 0);
  assert.equal(
    failed.items.every(
      (publication) =>
        publication.lifecycle === 'ERROR' ||
        publication.delivery.failed > 0 ||
        publication.delivery.ambiguous > 0,
    ),
    true,
  );
  assert.equal(typeof firstPlanPage.nextCursor, 'string');
  const secondPlanPage = await listPublications(api, {
    view: 'plan',
    limit: 1,
    cursor: firstPlanPage.nextCursor ?? undefined,
  });
  assert.notEqual(secondPlanPage.items[0]?.id, firstPlanPage.items[0]?.id);

  const review = await getPublication(api, 'publication-delivery-review');
  const ambiguousDeliveries = await listPublicationDeliveries(api, review.id, {
    status: 'AMBIGUOUS',
    limit: 1,
  });
  assert.equal(
    ambiguousDeliveries.items.every((delivery) => delivery.status === 'AMBIGUOUS'),
    true,
  );
  const regularDeliveries = await listPublicationDeliveries(api, review.id, {
    excludeStatus: 'AMBIGUOUS',
    limit: 100,
  });
  assert.equal(
    regularDeliveries.items.every((delivery) => delivery.status !== 'AMBIGUOUS'),
    true,
  );
  const ambiguous = ambiguousDeliveries.items[0];
  assert.ok(ambiguous);

  const resolved = await resolvePublicationAmbiguousDelivery(
    api,
    review.id,
    ambiguous.occurrenceId,
    {
      requestId: 'resolve_request_001',
      deliveryId: ambiguous.id,
      resolution: 'mark_failed',
    },
  );
  assert.equal(resolved.occurrences[0]?.canRetry, true);

  const retried = await retryPublicationOccurrence(api, review.id, ambiguous.occurrenceId, {
    requestId: 'retry_request_001',
  });
  assert.equal(retried.delivery.failed, 0);
  assert.equal(retried.delivery.sent > 0, true);

  await testPublication(api, {
    requestId: 'test_request_001',
    content: {
      text: 'Тестовая отправка',
      textFormat: 'markdown',
      buttons: [],
      media: [],
    },
    sourceTarget: { chatId: 'preview-chat', entityType: 'chat' },
  });

  const created = await createPublication(api, {
    requestId: 'create_request_001',
    title: 'Новая публикация',
    content: {
      text: 'Один пост для чата и канала',
      textFormat: 'markdown',
      buttons: [],
      media: [],
    },
    audience: {
      selection: 'SELECTED',
      mode: 'SNAPSHOT',
      targets: [
        { chatId: 'preview-chat', entityType: 'chat' },
        { chatId: 'preview-channel', entityType: 'channel' },
      ],
    },
    schedule: {
      mode: 'once',
      timezone: 'Europe/Moscow',
      at: '2027-01-01T09:00:00.000Z',
      replaceConflicts: false,
    },
    intent: 'publish',
  });
  assert.equal(created.targetCount, 2);
  const schedulesWithCreated = await listPublications(api, { view: 'schedules', limit: 100 });
  assert.equal(
    schedulesWithCreated.items.some((publication) => publication.id === created.id),
    true,
  );

  const updated = await updatePublication(api, created.id, {
    expectedRevision: created.version,
    requestId: 'update_request_001',
    title: 'Обновлённая публикация',
  });
  assert.equal(updated.title, 'Обновлённая публикация');

  const paused = await pausePublication(api, updated.id, {
    expectedRevision: updated.version,
    requestId: 'pause_request_001',
  });
  assert.equal(paused.lifecycle, 'PAUSED');
  const resumed = await resumePublication(api, paused.id, {
    expectedRevision: paused.version,
    requestId: 'resume_request_001',
  });
  assert.equal(resumed.lifecycle, 'ACTIVE');
  const canceled = await cancelPublication(api, resumed.id, {
    expectedRevision: resumed.version,
    requestId: 'cancel_request_001',
  });
  assert.equal(canceled.lifecycle, 'CANCELED');
});

test('preview legacy publications support bound cursors, filters, and history', async () => {
  const api = createPreviewApiTransport();
  const active = await listLegacyPublications(api, { view: 'active', limit: 30 });

  assert.equal(active.totalCount, 4);
  assert.equal(active.items.length, 4);
  assert.equal(
    active.items.every((item) =>
      item.kind === 'autopost'
        ? item.status === 'ACTIVE' || item.status === 'PAUSED' || item.status === 'ERROR'
        : item.status === 'ACTIVE' || item.status === 'PARTIAL' || item.status === 'FAILED',
    ),
    true,
  );
  assert.equal(
    active.items.every((item) => item.source.title.length > 0),
    true,
  );

  const autoposts = await listLegacyPublications(api, {
    view: 'active',
    kind: 'autopost',
    limit: 30,
  });
  assert.equal(autoposts.totalCount, 2);
  assert.equal(
    autoposts.items.every((item) => item.kind === 'autopost'),
    true,
  );

  const channels = await listLegacyPublications(api, {
    view: 'active',
    entityType: 'channel',
    limit: 30,
  });
  assert.equal(channels.totalCount, 2);
  assert.equal(
    channels.items.every((item) => item.source.entityType === 'channel'),
    true,
  );

  const searched = await listLegacyPublications(api, {
    view: 'active',
    query: 'грунты',
    limit: 30,
  });
  assert.deepEqual(
    searched.items.map((item) => `${item.kind}:${item.id}`),
    ['autopost:autopost-preview-soil'],
  );

  const history = await listLegacyPublications(api, { view: 'history', limit: 30 });
  assert.equal(history.totalCount, 2);
  assert.equal(
    history.items.every((item) =>
      item.kind === 'autopost'
        ? item.status === 'COMPLETED'
        : item.status === 'COMPLETED' || item.status === 'CANCELED',
    ),
    true,
  );

  const firstPage = await listLegacyPublications(api, { view: 'active', limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(typeof firstPage.nextCursor, 'string');
  const secondPage = await listLegacyPublications(api, {
    view: 'active',
    limit: 1,
    cursor: firstPage.nextCursor ?? undefined,
  });
  assert.notEqual(
    `${secondPage.items[0]?.kind}:${secondPage.items[0]?.id}`,
    `${firstPage.items[0]?.kind}:${firstPage.items[0]?.id}`,
  );

  await assert.rejects(
    listLegacyPublications(api, {
      view: 'active',
      kind: 'broadcast',
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    }),
    /cursor is invalid/u,
  );
});

test('preview publications expose schedule conflicts and allow explicit replacement', async () => {
  const api = createPreviewApiTransport();
  const existing = await getPublication(api, 'publication-neighborhood-digest');
  const occupiedAt = existing.occurrences[0]?.scheduledAt;
  assert.ok(occupiedAt);
  const request = {
    requestId: 'conflict_request_001',
    title: 'Конфликт',
    content: {
      text: 'Проверка конфликта',
      textFormat: 'markdown' as const,
      buttons: [],
      media: [],
    },
    audience: {
      selection: 'SELECTED' as const,
      mode: 'SNAPSHOT' as const,
      targets: [{ chatId: 'preview-chat', entityType: 'chat' as const }],
    },
    schedule: {
      mode: 'once' as const,
      timezone: 'Europe/Moscow',
      at: occupiedAt,
      replaceConflicts: false,
    },
    intent: 'publish' as const,
  };

  await assert.rejects(
    createPublication(api, request),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === 'PUBLICATION_SCHEDULE_CONFLICT',
  );

  const replaced = await createPublication(api, {
    ...request,
    requestId: 'conflict_request_002',
    schedule: { ...request.schedule, replaceConflicts: true },
  });
  assert.equal(replaced.lifecycle, 'ACTIVE');
});
