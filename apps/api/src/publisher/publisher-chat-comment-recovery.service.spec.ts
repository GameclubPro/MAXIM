import type { Job } from 'bullmq';
import {
  PUBLISHER_CHAT_COMMENT_RECOVERY_BATCH_SIZE,
  PUBLISHER_CHAT_COMMENT_RECOVERY_MIN_AGE_MS,
  PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS,
  PublisherChatCommentRecoveryService,
} from './publisher-chat-comment-recovery.service';
import {
  buildPublisherChatCommentAttachJobId,
  type PublisherChatCommentAttachJob,
  type PublisherChatCommentJob,
} from './publisher-chat-comment.queue';

const MARKER_ID = `ccr1_${'d'.repeat(32)}`;
const LOCK_TOKEN = 'exhausted-lock-1';

function buildMarker(overrides: Record<string, unknown> = {}) {
  return {
    id: MARKER_ID,
    chatId: 'chat-1',
    messageId: 'message-1',
    lockToken: LOCK_TOKEN,
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
  } = {},
) {
  const marker = options.marker ?? buildMarker();
  const job = {
    data: buildJobData(),
    getState: jest.fn().mockResolvedValue(options.state ?? 'failed'),
    retry: jest.fn().mockResolvedValue(undefined),
  } as unknown as Job<PublisherChatCommentJob>;
  const prisma = {
    chatAutoCommentAttachMarker: {
      findMany: jest.fn().mockResolvedValue([marker]),
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
  const boundary = { assertDispatchEnabled: jest.fn() };
  const health = { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) };
  const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
  const service = new PublisherChatCommentRecoveryService(
    prisma as never,
    queue as never,
    readiness as never,
    boundary as never,
    health as never,
    { getBotId: () => 'publik-bot' } as never,
    identityAttestation as never,
  );
  return { boundary, health, job, marker, prisma, queue, readiness, service };
}

describe('PublisherChatCommentRecoveryService', () => {
  it('resets exhausted attempts for a stale authoritative marker when readiness returns', async () => {
    const harness = createHarness();
    const now = new Date('2026-08-26T10:00:00.000Z');

    const result = await harness.service.recoverOnce(now);

    expect(harness.prisma.chatAutoCommentAttachMarker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'IN_PROGRESS',
          lockToken: { not: null },
          replacementMessageId: null,
          updatedAt: {
            lte: new Date(now.getTime() - PUBLISHER_CHAT_COMMENT_RECOVERY_MIN_AGE_MS),
          },
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

  it('defers through a long disabled window and retries the retained job after enablement', async () => {
    const harness = createHarness({ readinessError: new Error('publisher disabled') });

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

  it('runs a bounded startup recovery after a publisher restart', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      const recover = jest.spyOn(harness.service, 'recoverOnce').mockResolvedValue({
        scanned: 1,
        retried: 1,
        deferred: 0,
        missingJobs: 0,
        skipped: 0,
        races: 0,
        errors: 0,
        alreadyRunning: false,
      });

      harness.service.onModuleInit();
      await jest.advanceTimersByTimeAsync(PUBLISHER_CHAT_COMMENT_RECOVERY_STARTUP_DELAY_MS);

      expect(recover).toHaveBeenCalledTimes(1);
      harness.service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
