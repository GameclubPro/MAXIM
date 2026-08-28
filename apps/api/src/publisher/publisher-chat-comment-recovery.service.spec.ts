import type { Job } from 'bullmq';
import {
  PUBLISHER_CHAT_COMMENT_RECOVERY_BATCH_SIZE,
  PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS,
  PUBLISHER_CHAT_COMMENT_RECOVERY_MAX_AGE_MS,
  PUBLISHER_CHAT_COMMENT_RECOVERY_MIN_AGE_MS,
  PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS,
  PublisherChatCommentRecoveryService,
} from './publisher-chat-comment-recovery.service';
import {
  buildPublisherChatCommentAttachJobId,
  type PublisherChatCommentAttachJob,
  type PublisherChatCommentJob,
} from './publisher-chat-comment.queue';
import { PublisherDispatchPausedError } from './publisher-dispatch-health.service';
import { PublisherSetupRequiredException } from './publisher-errors';

const MARKER_ID = `ccr1_${'d'.repeat(32)}`;
const LOCK_TOKEN = 'publisher-chat-comment:v1:7:3:exhausted-lock-1';

function buildMarker(overrides: Record<string, unknown> = {}) {
  return {
    id: MARKER_ID,
    chatId: 'chat-1',
    messageId: 'message-1',
    lockToken: LOCK_TOKEN,
    lockedAt: new Date('2026-08-26T09:00:00.000Z'),
    createdAt: new Date(),
    replacementMessageId: null,
    replyMessageId: null,
    replacementSendStartedAt: null,
    ...overrides,
  };
}

function buildJobData(): PublisherChatCommentAttachJob {
  return {
    version: 1,
    kind: 'attach_chat_reply',
    markerId: MARKER_ID,
    lockToken: LOCK_TOKEN,
    chatId: 'chat-1',
    messageId: 'message-1',
    senderId: 'admin-1',
    requiredBotId: 'publik-bot',
    dialogBotId: 'main-bot',
    publisherSettingsRevision: 7,
    publicationPolicyRevision: 3,
    button: { type: 'link', text: 'Comments', url: 'https://example.test/dialog' },
    idempotencyKey: MARKER_ID,
    sourceTag: 'chat_auto_comment',
    retryPolicyName: 'publisher-chat-comment',
    createdAt: '2026-08-26T09:00:00.000Z',
  };
}

function createHarness(
  options: {
    marker?: ReturnType<typeof buildMarker>;
    state?: string;
    readinessError?: Error;
    globallyPaused?: boolean;
    dispatchAllowedError?: Error;
  } = {},
) {
  const marker = options.marker ?? buildMarker();
  const job = {
    data: buildJobData(),
    getState: jest.fn().mockResolvedValue(options.state ?? 'failed'),
    retry: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  } as unknown as Job<PublisherChatCommentJob>;
  const prisma = {
    chatAutoCommentAttachMarker: {
      findMany: jest.fn().mockResolvedValue([marker]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    publisherEntitySettings: {
      findUnique: jest.fn().mockResolvedValue({
        revision: 7,
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
      }),
    },
    managedEntityPublicationPolicy: {
      findUnique: jest.fn().mockResolvedValue({
        revision: 3,
        publikEnabled: true,
      }),
    },
  };
  const queue = {
    getJob: jest.fn().mockResolvedValue(job),
  };
  const readiness = {
    assertEntityReady: options.readinessError
      ? jest.fn().mockRejectedValue(options.readinessError)
      : jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          entityType: 'chat',
          requiredBotId: 'publik-bot',
          policyRevision: 1,
        }),
  };
  const boundary = { dispatchEnabled: true, assertDispatchEnabled: jest.fn() };
  const health = {
    assertDispatchAllowed: options.dispatchAllowedError
      ? jest.fn().mockRejectedValue(options.dispatchAllowedError)
      : jest.fn().mockResolvedValue(undefined),
    isGloballyPaused: jest.fn().mockResolvedValue(options.globallyPaused ?? false),
  };
  const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
  const backgroundWork = {
    runExclusive: jest.fn((_lane: string, operation: () => Promise<unknown>) => operation()),
  };
  const service = new PublisherChatCommentRecoveryService(
    prisma as never,
    queue as never,
    readiness as never,
    boundary as never,
    health as never,
    { getBotId: () => 'publik-bot' } as never,
    identityAttestation as never,
    backgroundWork as never,
  );
  return {
    boundary,
    backgroundWork,
    health,
    identityAttestation,
    job,
    marker,
    prisma,
    queue,
    readiness,
    service,
  };
}

describe('PublisherChatCommentRecoveryService', () => {
  it('resets exhausted attempts for a stale authoritative marker when readiness returns', async () => {
    const harness = createHarness();
    const now = new Date('2026-08-26T10:00:00.000Z');

    const result = await harness.service.recoverOnce(now);

    expect(harness.prisma.chatAutoCommentAttachMarker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: 'publik-bot',
          status: 'IN_PROGRESS',
          lockToken: { not: null },
          replacementMessageId: null,
          updatedAt: {
            lte: new Date(now.getTime() - PUBLISHER_CHAT_COMMENT_RECOVERY_MIN_AGE_MS),
          },
          OR: [
            { replyMessageId: { not: null } },
            { replacementSendStartedAt: { not: null } },
            {
              replyMessageId: null,
              replacementSendStartedAt: null,
              OR: [
                {
                  lockToken: {
                    startsWith: 'publisher-chat-comment:v1:',
                  },
                },
                {
                  createdAt: {
                    gte: new Date(now.getTime() - PUBLISHER_CHAT_COMMENT_RECOVERY_MAX_AGE_MS),
                  },
                  chat: {
                    OR: [
                      { publicationPolicy: { is: null } },
                      { publicationPolicy: { is: { publikEnabled: true } } },
                    ],
                    publisherSettings: {
                      is: {
                        chatCommentsEnabled: true,
                        chatCommentsAdminsEnabled: true,
                      },
                    },
                  },
                },
              ],
            },
          ],
        }),
        take: PUBLISHER_CHAT_COMMENT_RECOVERY_BATCH_SIZE,
      }),
    );
    expect(harness.queue.getJob).toHaveBeenCalledWith(
      buildPublisherChatCommentAttachJobId(MARKER_ID, LOCK_TOKEN),
    );
    expect(harness.job.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(result).toMatchObject({ scanned: 1, retried: 1, deferred: 0, errors: 0 });
  });

  it('never retries a remote send for a legacy envelope without settings revision', async () => {
    const legacyLockToken = 'legacy-exhausted-lock-1';
    const harness = createHarness({ marker: buildMarker({ lockToken: legacyLockToken }) });
    (harness.job.data as { lockToken: string }).lockToken = legacyLockToken;
    (harness.job.data as { publisherSettingsRevision?: number }).publisherSettingsRevision =
      undefined;

    const result = await harness.service.recoverOnce();

    expect(result).toMatchObject({ scanned: 1, deferred: 1, retried: 0 });
    expect(harness.prisma.publisherEntitySettings.findUnique).not.toHaveBeenCalled();
    expect(harness.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(harness.job.retry).not.toHaveBeenCalled();
  });

  it('terminalizes remote-send recovery after settings revision changes', async () => {
    const harness = createHarness();
    harness.prisma.publisherEntitySettings.findUnique.mockResolvedValueOnce({
      revision: 8,
      chatCommentsEnabled: true,
      chatCommentsAdminsEnabled: true,
    });

    const result = await harness.service.recoverOnce();

    expect(result).toMatchObject({ scanned: 1, skipped: 1, deferred: 0, retried: 0 });
    expect(harness.prisma.chatAutoCommentAttachMarker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lockToken: LOCK_TOKEN, status: 'IN_PROGRESS' }),
        data: expect.objectContaining({
          status: 'SKIPPED',
          lastError: 'Publisher chat-comment settings changed before recovery dispatch',
        }),
      }),
    );
    expect(harness.job.remove).toHaveBeenCalledTimes(1);
    expect(harness.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(harness.job.retry).not.toHaveBeenCalled();
  });

  it('terminalizes remote-send recovery after the main Publik toggle epoch changes', async () => {
    const harness = createHarness();
    harness.prisma.managedEntityPublicationPolicy.findUnique.mockResolvedValueOnce({
      revision: 5,
      publikEnabled: true,
    });

    const result = await harness.service.recoverOnce();

    expect(result).toMatchObject({ scanned: 1, skipped: 1, deferred: 0, retried: 0 });
    expect(harness.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(harness.job.retry).not.toHaveBeenCalled();
  });

  it('terminalizes a new-epoch marker with no queue job after the module is disabled', async () => {
    const harness = createHarness();
    harness.prisma.publisherEntitySettings.findUnique.mockResolvedValueOnce({
      revision: 8,
      chatCommentsEnabled: false,
      chatCommentsAdminsEnabled: false,
    });
    harness.queue.getJob.mockResolvedValueOnce(null);

    const result = await harness.service.recoverOnce();

    expect(result).toMatchObject({ scanned: 1, skipped: 1, missingJobs: 0 });
    expect(harness.prisma.chatAutoCommentAttachMarker.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.queue.getJob).toHaveBeenCalledTimes(1);
  });

  it('keeps a current-epoch no-job marker for its deferred webhook owner within 24 hours', async () => {
    const harness = createHarness();
    harness.queue.getJob.mockResolvedValueOnce(null);

    const result = await harness.service.recoverOnce();

    expect(result).toMatchObject({ scanned: 1, skipped: 0, missingJobs: 1 });
    expect(harness.prisma.chatAutoCommentAttachMarker.updateMany).not.toHaveBeenCalled();
  });

  it('still retries local confirmed-reply recovery for a legacy envelope', async () => {
    const harness = createHarness({
      marker: buildMarker({ replyMessageId: 'publisher-reply-legacy' }),
      globallyPaused: true,
      dispatchAllowedError: new PublisherDispatchPausedError('2026-08-26T09:30:00.000Z'),
    });
    (harness.job.data as { publisherSettingsRevision?: number }).publisherSettingsRevision =
      undefined;

    const result = await harness.service.recoverOnce();

    expect(result).toMatchObject({ scanned: 1, deferred: 0, retried: 1 });
    expect(harness.prisma.publisherEntitySettings.findUnique).not.toHaveBeenCalled();
    expect(harness.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(harness.job.retry).toHaveBeenCalledTimes(1);
  });

  it('does not scan an old marker after settings are re-enabled beyond the recovery horizon', async () => {
    const harness = createHarness();
    const now = new Date('2026-08-26T10:00:00.000Z');
    const oldCreatedAt = new Date(now.getTime() - PUBLISHER_CHAT_COMMENT_RECOVERY_MAX_AGE_MS - 1);
    harness.prisma.chatAutoCommentAttachMarker.findMany.mockImplementationOnce(async (args) => {
      const preSendBranch = args.where.OR[2];
      const gte = preSendBranch.OR[1].createdAt.gte as Date;
      return oldCreatedAt >= gte ? [harness.marker] : [];
    });

    const result = await harness.service.recoverOnce(now);

    expect(result).toMatchObject({ scanned: 0, retried: 0, deferred: 0 });
    expect(harness.queue.getJob).not.toHaveBeenCalled();
    expect(harness.job.retry).not.toHaveBeenCalled();
  });

  it('terminalizes an old dual-epoch pre-send marker instead of retrying it', async () => {
    const now = new Date('2026-08-28T10:00:00.000Z');
    const harness = createHarness({
      marker: buildMarker({
        createdAt: new Date(now.getTime() - PUBLISHER_CHAT_COMMENT_RECOVERY_MAX_AGE_MS - 1),
      }),
    });

    const result = await harness.service.recoverOnce(now);

    expect(result).toMatchObject({ scanned: 1, skipped: 1, retried: 0 });
    expect(harness.prisma.chatAutoCommentAttachMarker.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: 'Publisher chat-comment recovery window expired before dispatch',
        }),
      }),
    );
    expect(harness.job.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps old post-send recovery independent from toggles and the age horizon', async () => {
    const marker = buildMarker({ replyMessageId: 'publisher-reply-old' });
    const harness = createHarness({ marker, globallyPaused: true });
    (harness.job.data as { publisherSettingsRevision?: number }).publisherSettingsRevision =
      undefined;
    harness.prisma.publisherEntitySettings.findUnique.mockResolvedValue(null);
    harness.prisma.chatAutoCommentAttachMarker.findMany.mockImplementationOnce(async (args) => {
      expect(args.where.OR).toEqual(
        expect.arrayContaining([
          { replyMessageId: { not: null } },
          { replacementSendStartedAt: { not: null } },
        ]),
      );
      return [marker];
    });

    const result = await harness.service.recoverOnce(new Date('2026-08-28T10:00:00.000Z'));

    expect(result).toMatchObject({ scanned: 1, retried: 1, deferred: 0 });
    expect(harness.prisma.publisherEntitySettings.findUnique).not.toHaveBeenCalled();
    expect(harness.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(harness.job.retry).toHaveBeenCalledTimes(1);
  });

  it('defers through a long disabled window and retries the retained job after enablement', async () => {
    const harness = createHarness({
      readinessError: new PublisherSetupRequiredException(['chat-1'], 'bot_not_connected'),
    });

    const disabled = await harness.service.recoverOnce();
    expect(disabled).toMatchObject({ scanned: 1, deferred: 1, retried: 0 });
    expect(harness.job.retry).not.toHaveBeenCalled();

    harness.readiness.assertEntityReady.mockReset().mockResolvedValue({
      chatId: 'chat-1',
      entityType: 'chat',
      requiredBotId: 'publik-bot',
      policyRevision: 2,
    });
    const enabled = await harness.service.recoverOnce();

    expect(enabled).toMatchObject({ scanned: 1, retried: 1, deferred: 0 });
    expect(harness.job.retry).toHaveBeenCalledTimes(1);
    expect(harness.job.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
  });

  it.each([
    {
      label: 'a confirmed reply awaiting its audit',
      marker: buildMarker({ replyMessageId: 'publisher-reply-1' }),
    },
    {
      label: 'an ambiguous send fence awaiting quarantine',
      marker: buildMarker({
        replacementSendStartedAt: new Date('2026-08-26T09:00:01.000Z'),
      }),
    },
  ])('requeues $label without authorizing another remote send', async ({ marker }) => {
    const harness = createHarness({
      marker,
      globallyPaused: true,
      dispatchAllowedError: new PublisherDispatchPausedError('2026-08-26T09:30:00.000Z'),
      readinessError: new Error('readiness must not gate local recovery'),
    });

    const result = await harness.service.recoverOnce();

    expect(result).toMatchObject({ retried: 1, deferred: 0 });
    expect(harness.boundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(harness.health.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(harness.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(harness.job.retry).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a failed-job retry that another instance already moved', async () => {
    const harness = createHarness({ state: 'waiting' });

    const result = await harness.service.recoverOnce();

    expect(result).toMatchObject({ retried: 0, skipped: 1 });
    expect(harness.job.retry).not.toHaveBeenCalled();
  });

  it('coalesces explicit recovery calls while waiting for the background coordinator', async () => {
    const harness = createHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.backgroundWork.runExclusive.mockImplementation(
      async (_lane: string, operation: () => Promise<unknown>) => {
        await gate;
        return operation();
      },
    );

    const first = harness.service.recoverOnce();
    const second = harness.service.recoverOnce();
    await Promise.resolve();

    expect(harness.backgroundWork.runExclusive).toHaveBeenCalledTimes(1);
    expect(harness.prisma.chatAutoCommentAttachMarker.findMany).not.toHaveBeenCalled();
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.alreadyRunning).toBe(false);
    expect(secondResult.alreadyRunning).toBe(true);
    expect(harness.prisma.chatAutoCommentAttachMarker.findMany).toHaveBeenCalledTimes(1);
  });

  it('runs a bounded startup recovery after a publisher restart', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();

      harness.service.onModuleInit();
      await jest.advanceTimersByTimeAsync(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);

      expect(harness.prisma.chatAutoCommentAttachMarker.findMany).toHaveBeenCalledTimes(1);
      expect(harness.job.retry).toHaveBeenCalledTimes(1);
      harness.service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps enabled recovery timers idle before identity, DB, or queue work while paused', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness({ globallyPaused: true });

      harness.service.onModuleInit();
      await jest.advanceTimersByTimeAsync(PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS);

      expect(harness.identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(harness.prisma.chatAutoCommentAttachMarker.findMany).not.toHaveBeenCalled();
      expect(harness.queue.getJob).not.toHaveBeenCalled();

      harness.health.isGloballyPaused.mockResolvedValue(false);
      await jest.advanceTimersByTimeAsync(PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS);

      expect(harness.health.isGloballyPaused).toHaveBeenCalledTimes(4);
      expect(harness.identityAttestation.assertAttested).toHaveBeenCalledTimes(1);
      expect(harness.prisma.chatAutoCommentAttachMarker.findMany).toHaveBeenCalledTimes(1);
      expect(harness.queue.getJob).toHaveBeenCalledTimes(1);
      harness.service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rechecks an operator pause after waiting for the shared background lane', async () => {
    const harness = createHarness();
    let globallyPaused = false;
    harness.health.isGloballyPaused.mockImplementation(async () => globallyPaused);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.backgroundWork.runExclusive.mockImplementation(
      async (_lane: string, operation: () => Promise<unknown>) => {
        await gate;
        return operation();
      },
    );

    const recovery = (harness.service as any).runScheduledRecovery() as Promise<void>;
    while (harness.backgroundWork.runExclusive.mock.calls.length === 0) await Promise.resolve();
    globallyPaused = true;
    release();
    await recovery;

    expect(harness.health.isGloballyPaused).toHaveBeenCalledTimes(2);
    expect(harness.identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(harness.prisma.chatAutoCommentAttachMarker.findMany).not.toHaveBeenCalled();
  });

  it('defers an explicit remote-send recovery while dispatch is paused', async () => {
    const harness = createHarness({
      globallyPaused: true,
      dispatchAllowedError: new PublisherDispatchPausedError('2026-08-26T09:30:00.000Z'),
    });

    const result = await harness.service.recoverOnce();

    expect(harness.health.isGloballyPaused).not.toHaveBeenCalled();
    expect(harness.identityAttestation.assertAttested).toHaveBeenCalledTimes(1);
    expect(harness.prisma.chatAutoCommentAttachMarker.findMany).toHaveBeenCalledTimes(1);
    expect(harness.health.assertDispatchAllowed).toHaveBeenCalledTimes(1);
    expect(harness.job.retry).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, deferred: 1, retried: 0 });
  });

  it('does not schedule automatic recovery while dispatch is disabled', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      harness.boundary.dispatchEnabled = false;
      const recover = jest.spyOn(harness.service, 'recoverOnce');

      harness.service.onModuleInit();
      await jest.advanceTimersByTimeAsync(
        PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS +
          PUBLISHER_CHAT_COMMENT_RECOVERY_INTERVAL_MS * 2,
      );

      expect(harness.health.isGloballyPaused).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      harness.service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
