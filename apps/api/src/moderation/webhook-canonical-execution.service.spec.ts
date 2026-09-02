import { WebhookStatus } from '../prisma/prisma-client';
import { WebhookCanonicalExecutionService } from './webhook-canonical-execution.service';

describe('WebhookCanonicalExecutionService preparation fence', () => {
  it('does not execute a queued shadow mirror while its foreign owner is unprepared', async () => {
    const webhookEventId = 'event-shadow-mirror-queued';
    const ownerWebhookEventId = 'event-shadow-owner-pending';
    const update = {
      updateId: 'update-shadow-membership',
      type: 'user_removed',
      botId: 'bot-mirror',
      timestamp: 1_788_336_000_000,
      message: {
        chatId: '-100-shadow-membership',
        messageId: 'user_removed:update-shadow-membership',
        senderId: 'user-1',
        text: '',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
      membership: {
        action: 'removed',
        memberUserIds: ['user-1'],
      },
    };
    const claimUpdateMany = jest.fn();
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: webhookEventId,
          botId: 'bot-mirror',
          status: WebhookStatus.QUEUED,
          normalizedPayload: update,
          errorMessage: null,
          queuedAt: new Date('2026-09-02T08:00:01.000Z'),
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          createdAt: new Date('2026-09-02T08:00:00.000Z'),
          processedAt: null,
          sourceIp: null,
          rawPayload: {},
          dedupKey: 'bot-mirror:update-shadow-membership',
          queueName: 'moderation-background',
        }),
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-shadow-membership',
          semanticKey:
            'membership:user_removed:-100-shadow-membership:user-1:2026-09-02T08:00:00.000Z',
          webhookEventId: ownerWebhookEventId,
          executionBotId: 'bot-owner',
          enforced: false,
          status: 'PENDING',
          preparedAt: null,
          completedAt: null,
          leaseToken: 'preparation-lease',
          leaseExpiresAt: new Date('2026-09-02T08:00:30.000Z'),
        }),
        findFirst: jest.fn(),
        updateMany: claimUpdateMany,
      },
      $queryRaw: jest.fn(),
    };
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(service.prepareExecution(webhookEventId, 'bot-default')).resolves.toBeNull();

    expect(claimUpdateMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('keeps an ordered message mirror executable while its newer foreign owner is pending', async () => {
    const webhookEventId = 'event-shadow-message-older';
    const update = {
      updateId: 'update-shadow-message',
      type: 'message_created',
      botId: 'bot-mirror',
      timestamp: 1_788_336_000_000,
      message: {
        chatId: '-100-shadow-message',
        messageId: 'message-shadow-1',
        senderId: 'user-1',
        text: 'hello',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
    };
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: webhookEventId,
          botId: 'bot-mirror',
          status: WebhookStatus.QUEUED,
          normalizedPayload: update,
          errorMessage: null,
          queuedAt: new Date('2026-09-02T08:00:01.000Z'),
          enqueueAttempts: 1,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          createdAt: new Date('2026-09-02T08:00:00.000Z'),
          processedAt: null,
          sourceIp: null,
          rawPayload: {},
          dedupKey: 'bot-mirror:update-shadow-message',
          queueName: 'moderation-default-0',
        }),
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-shadow-message',
          semanticKey: 'message:message_created:-100-shadow-message:message-shadow-1',
          webhookEventId: 'event-shadow-message-newer-owner',
          executionBotId: 'bot-owner',
          enforced: false,
          status: 'PENDING',
          preparedAt: null,
          completedAt: null,
          leaseToken: 'preparation-lease',
          leaseExpiresAt: new Date('2026-09-02T08:00:30.000Z'),
        }),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(service.prepareExecution(webhookEventId, 'bot-default')).resolves.toEqual(
      expect.objectContaining({
        webhookEvent: expect.objectContaining({ id: webhookEventId }),
        update,
        activeBotId: 'bot-owner',
        businessLeaseToken: null,
      }),
    );
  });
});
