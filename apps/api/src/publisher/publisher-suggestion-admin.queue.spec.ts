import {
  buildPublisherSuggestionAdminDeliveryJobId,
  buildPublisherSuggestionAdminReviewCallbackPayload,
  buildPublisherSuggestionAdminReviewJobId,
  buildPublisherSuggestionAdminSyncJobId,
  buildPublisherSuggestionAdminSyncMarker,
  PUBLISHER_SUGGESTION_ADMIN_CALLBACK_PREFIX,
  PublisherSuggestionAdminQueueService,
} from './publisher-suggestion-admin.queue';

const actor = {
  userId: '42',
  username: 'editor',
  displayName: 'Иван Петров',
  avatarUrl: null,
  profileUrl: null,
};

describe('PublisherSuggestionAdminQueueService', () => {
  it('uses one stable delivery job id per suggestion and Publisher bot', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const service = new PublisherSuggestionAdminQueueService({ add } as never);

    await service.enqueueDelivery({
      suggestionId: 'psg_1',
      requiredBotId: 'publik_bot',
      requestedAt: new Date('2026-09-01T12:00:00.000Z'),
    });
    await service.enqueueDelivery({
      suggestionId: 'psg_1',
      requiredBotId: 'publik_bot',
      requestedAt: new Date('2026-09-01T12:05:00.000Z'),
    });
    await service.enqueueDelivery({
      suggestionId: 'psg_1',
      requiredBotId: 'replacement_publik_bot',
      requestedAt: new Date('2026-09-01T12:10:00.000Z'),
    });

    expect(add.mock.calls[0]?.[2]?.jobId).toBe(
      buildPublisherSuggestionAdminDeliveryJobId('publik_bot', 'psg_1'),
    );
    expect(add.mock.calls[1]?.[2]?.jobId).toBe(add.mock.calls[0]?.[2]?.jobId);
    expect(add.mock.calls[2]?.[2]?.jobId).toBe(
      buildPublisherSuggestionAdminDeliveryJobId('replacement_publik_bot', 'psg_1'),
    );
    expect(add.mock.calls[2]?.[2]?.jobId).not.toBe(add.mock.calls[0]?.[2]?.jobId);
    expect(add.mock.calls[0]?.[1]).toMatchObject({
      version: 1,
      kind: 'deliver',
      suggestionId: 'psg_1',
      requiredBotId: 'publik_bot',
    });
  });

  it('retries the stable failed delivery job during recovery instead of adding a duplicate', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const retry = jest.fn().mockResolvedValue(undefined);
    const getJob = jest.fn().mockResolvedValue({
      getState: jest.fn().mockResolvedValue('failed'),
      retry,
    });
    const service = new PublisherSuggestionAdminQueueService({ add, getJob } as never);

    await service.enqueueDelivery({
      suggestionId: 'psg_recovery_1',
      requiredBotId: 'publik_bot',
      recoverExisting: true,
    });

    expect(getJob).toHaveBeenCalledWith(
      buildPublisherSuggestionAdminDeliveryJobId('publik_bot', 'psg_recovery_1'),
    );
    expect(retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it('deduplicates repeated review callbacks by publisher bot and callback id', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const service = new PublisherSuggestionAdminQueueService({ add } as never);
    const base = {
      suggestionId: 'psg_1',
      requiredBotId: 'publik_bot',
      action: 'publish' as const,
      actor,
      callbackId: 'callback-1',
      privateChatId: '42',
      messageId: 'admin-card-1',
      webhookEventId: 'webhook-1',
      updateId: 'update-1',
      dedupeKey: 'callback-1',
    };

    await service.enqueueReview({
      ...base,
      requestedAt: new Date('2026-09-01T12:00:00.000Z'),
    });
    await service.enqueueReview({
      ...base,
      requestedAt: new Date('2026-09-01T12:01:00.000Z'),
    });

    const expectedJobId = buildPublisherSuggestionAdminReviewJobId('publik_bot', 'callback-1');
    expect(add.mock.calls[0]?.[2]?.jobId).toBe(expectedJobId);
    expect(add.mock.calls[1]?.[2]?.jobId).toBe(expectedJobId);
    expect(add.mock.calls[0]?.[1]).toMatchObject({
      version: 1,
      kind: 'review',
      suggestionId: 'psg_1',
      action: 'publish',
      actor,
      callbackId: 'callback-1',
      privateChatId: '42',
      messageId: 'admin-card-1',
    });
  });

  it('keeps terminal sync idempotent per Publisher bot, suggestion, and review status', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const service = new PublisherSuggestionAdminQueueService({ add } as never);

    await service.enqueueSync({
      suggestionId: 'psg_1',
      requiredBotId: 'publik_bot',
      reviewStatus: 'published',
    });
    await service.enqueueSync({
      suggestionId: 'psg_1',
      requiredBotId: 'publik_bot',
      reviewStatus: 'published',
    });
    await service.enqueueSync({
      suggestionId: 'psg_1',
      requiredBotId: 'publik_bot',
      reviewStatus: 'cancelled',
    });
    await service.enqueueSync({
      suggestionId: 'psg_1',
      requiredBotId: 'replacement_publik_bot',
      reviewStatus: 'published',
    });

    expect(add.mock.calls[0]?.[2]?.jobId).toBe(
      buildPublisherSuggestionAdminSyncJobId('publik_bot', 'psg_1', 'published'),
    );
    expect(add.mock.calls[1]?.[2]?.jobId).toBe(add.mock.calls[0]?.[2]?.jobId);
    expect(add.mock.calls[2]?.[2]?.jobId).toBe(
      buildPublisherSuggestionAdminSyncJobId('publik_bot', 'psg_1', 'cancelled'),
    );
    expect(add.mock.calls[2]?.[2]?.jobId).not.toBe(add.mock.calls[0]?.[2]?.jobId);
    expect(add.mock.calls[3]?.[2]?.jobId).toBe(
      buildPublisherSuggestionAdminSyncJobId('replacement_publik_bot', 'psg_1', 'published'),
    );
    expect(add.mock.calls[3]?.[2]?.jobId).not.toBe(add.mock.calls[0]?.[2]?.jobId);
  });

  it('recycles only bounded failed sync jobs', async () => {
    const retrySync = jest.fn().mockResolvedValue(undefined);
    const retryDeliver = jest.fn().mockResolvedValue(undefined);
    const getJobs = jest.fn().mockResolvedValue([
      { data: { kind: 'deliver' }, retry: retryDeliver },
      { data: { kind: 'sync', requiredBotId: 'publik_bot' }, retry: retrySync },
    ]);
    const service = new PublisherSuggestionAdminQueueService({ getJobs } as never);

    await expect(service.recoverFailedSyncJobs('publik_bot', 25)).resolves.toBe(1);

    expect(getJobs).toHaveBeenCalledWith(['failed'], 0, 99, true);
    expect(retryDeliver).not.toHaveBeenCalled();
    expect(retrySync).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
  });

  it('builds a bot-scoped durable terminal-card sync marker', () => {
    const marker = buildPublisherSuggestionAdminSyncMarker('publik_bot', 'published');

    expect(marker).toBe(buildPublisherSuggestionAdminSyncMarker('publik_bot', 'published'));
    expect(marker).not.toBe(
      buildPublisherSuggestionAdminSyncMarker('replacement_publik_bot', 'published'),
    );
    expect(marker).not.toBe(buildPublisherSuggestionAdminSyncMarker('publik_bot', 'cancelled'));
  });

  it('advances a bounded failed-job cursor past unrelated backlog', async () => {
    const retrySync = jest.fn().mockResolvedValue(undefined);
    const getJobs = jest
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, () => ({ data: { kind: 'review' }, retry: jest.fn() })),
      )
      .mockResolvedValueOnce([
        { data: { kind: 'sync', requiredBotId: 'publik_bot' }, retry: retrySync },
      ]);
    const service = new PublisherSuggestionAdminQueueService({ getJobs } as never);

    await expect(service.recoverFailedSyncJobs('publik_bot', 25)).resolves.toBe(0);
    await expect(service.recoverFailedSyncJobs('publik_bot', 25)).resolves.toBe(1);

    expect(getJobs.mock.calls[0]).toEqual([['failed'], 0, 99, true]);
    expect(getJobs.mock.calls[1]).toEqual([['failed'], 100, 199, true]);
    expect(retrySync).toHaveBeenCalledTimes(1);
  });

  it('builds a versioned Publisher-only review callback payload', () => {
    expect(buildPublisherSuggestionAdminReviewCallbackPayload('cancel', 'psg_1')).toBe(
      `${PUBLISHER_SUGGESTION_ADMIN_CALLBACK_PREFIX}cancel:psg_1`,
    );
  });
});
