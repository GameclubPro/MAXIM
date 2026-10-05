import type { MaxUpdate } from '@maxim/contracts';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookStatus } from '../prisma/prisma-client';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { WebhookCanonicalExecutionService } from './webhook-canonical-execution.service';

function fixture(type: 'user_removed' | 'message_created', mirrorIsEarlier: boolean) {
  const update = {
    updateId: 'mirror-update',
    type,
    eventTimestampSource: 'payload',
    botId: 'bot-mirror',
    timestamp: 1_788_336_000_000,
    message: {
      chatId: '-100-mirror',
      messageId: 'message-1',
      senderId: 'user-1',
      text: 'hello',
      createdAt: '2026-09-02T08:00:00.000Z',
    },
    ...(type === 'user_removed'
      ? { membership: { action: 'removed', memberUserIds: ['user-1'] } }
      : {}),
  } as MaxUpdate;
  const semanticKey = buildWebhookSemanticEventKey(update)!;
  const event = {
    id: 'mirror',
    botId: 'bot-mirror',
    status: WebhookStatus.QUEUED,
    normalizedPayload: update,
    semanticKey,
    executionDeadlineAt: new Date('2026-09-02T08:05:00Z'),
    errorMessage: null,
    queuedAt: new Date('2026-09-02T08:00:01Z'),
    enqueueAttempts: 1,
    nextEnqueueAt: null,
    timeoutQuarantineExpiresAt: null,
    createdAt: new Date(mirrorIsEarlier ? '2026-09-02T08:00:00Z' : '2026-09-02T08:00:02Z'),
    processedAt: null,
    sourceIp: null,
    rawPayload: {},
    dedupKey: 'mirror-dedup',
    queueName: 'moderation-background',
  };
  const owner = {
    ...event,
    id: 'owner',
    botId: 'bot-owner',
    normalizedPayload: { ...update, botId: 'bot-owner' },
    createdAt: new Date('2026-09-02T08:00:01Z'),
  };
  const claim = {
    id: 'claim',
    createdAt: new Date(),
    kind: 'EXECUTION',
    semanticKey,
    webhookEventId: owner.id,
    executionBotId: 'bot-owner',
    enforced: true,
    status: 'PENDING',
    preparedAt: null as Date | null,
    completedAt: null,
    businessStartedAt: null,
    leaseToken: 'preparation-lease',
    leaseExpiresAt: new Date(Date.now() + 30_000),
  };
  const prisma = {
    webhookEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'owner' ? owner : event,
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webhookExecutionClaim: {
      findUnique: jest.fn(async () => claim),
      findFirst: jest.fn(),
      updateMany: jest.fn(async ({ data }: { data: object }) => {
        Object.assign(claim, data);
        return { count: 1 };
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ finishedAt: new Date('2020-01-01T00:00:00Z') }]),
  };
  Object.assign(prisma, {
    $transaction: jest.fn(async (work: (tx: object) => unknown) => work(prisma)),
  });
  return { claim, prisma, service: new WebhookCanonicalExecutionService(prisma as never) };
}

describe('WebhookCanonicalExecutionService preparation fence', () => {
  it('defers a queued shadow membership mirror while its owner is unprepared', async () => {
    const f = fixture('user_removed', false);
    await expect(f.service.prepareExecution('mirror', 'bot-default')).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    expect(f.claim.enforced).toBe(true);
    expect(f.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
  });

  it('keeps an earlier ordered mirror fenced while its later foreign owner is READY', async () => {
    const f = fixture('message_created', true);
    Object.assign(f.claim, {
      status: 'READY',
      preparedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(f.service.prepareExecution('mirror', 'bot-default')).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    expect(f.claim.enforced).toBe(true);
    expect(f.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
  });
});
