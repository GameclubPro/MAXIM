import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { Prisma, WebhookStatus } from '../prisma/prisma-client';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WebhookService } from './webhook.service';

const publisherBotId = 'fixture-publisher';
function message(botId = publisherBotId, type = 'message_created'): MaxUpdate {
  return {
    updateId: 'fixture-update',
    botId,
    type,
    eventTimestampSource: 'payload',
    timestamp: Date.parse('2026-10-06T20:00:00Z'),
    message: {
      messageId: 'fixture-message',
      chatId: '-100',
      senderId: 'fixture-author',
      text: 'fixture content',
      createdAt: '2026-10-06T20:00:00Z',
    },
    raw: {
      message: { body: { mid: 'fixture-message', text: 'fixture content' } },
    },
  } as MaxUpdate;
}

type ReceiptInternals = {
  persistReceipt(
    update: MaxUpdate,
    sourceIp: null,
    rawPayload: Prisma.InputJsonValue,
  ): Promise<string>;
  loadWebhookReceipt(
    id: string,
    fallbackUpdate?: MaxUpdate,
  ): Promise<{
    semanticKey: string | null;
    normalizedPayload: unknown;
  } | null>;
};

function fixture(semanticKey: string | null = null) {
  const update = message();
  const event = {
    id: 'fixture-receipt',
    dedupKey: 'fixture-dedup',
    botId: publisherBotId,
    status: WebhookStatus.RECEIVED,
    semanticKey,
    normalizedPayload: update,
    createdAt: new Date('2026-10-06T20:00:00Z'),
    executionDeadlineAt: new Date('2026-10-06T20:05:00Z'),
    errorMessage: null,
    timeoutQuarantineExpiresAt: null,
    nextEnqueueAt: null,
  };
  const prisma = {
    webhookEvent: {
      findUnique: jest.fn().mockResolvedValue(event),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webhookExecutionClaim: {
      createMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(async () => {
      throw new Error('Publisher must not consult moderation abandonment authority');
    }),
    $transaction: jest.fn(),
  };
  const lifecycle = { observeWebhook: jest.fn().mockResolvedValue(undefined) };
  const service = new WebhookService(
    prisma as never,
    new ConfigService({ MAX_PUBLISHER_BOT_ID: publisherBotId }),
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lifecycle as never,
  );
  return {
    service,
    internals: service as unknown as ReceiptInternals,
    prisma,
    lifecycle,
    event,
    update,
  };
}

describe('Publisher observation receipt semantic namespace', () => {
  it.each(['message_created', 'message_edited'])(
    'isolates %s receipts while keeping the moderation identity',
    (type) => {
      const publisher = message(publisherBotId, type);
      const moderator = { ...publisher, botId: 'fixture-moderator' };
      const base = buildWebhookSemanticEventKey(publisher);
      expect(base).not.toBeNull();
      expect(buildWebhookSemanticEventKey(moderator)).toBe(base);
      expect(buildWebhookReceiptSemanticKey(publisher, publisherBotId)).toBe(
        `publisher-observation:v1:${publisherBotId}:${base}`,
      );
      expect(buildWebhookReceiptSemanticKey(moderator, publisherBotId)).toBe(base);
    },
  );

  it('matches the configured Publisher identity after trimming the receiving bot id', () => {
    expect(buildWebhookReceiptSemanticKey(message(` ${publisherBotId} `), publisherBotId)).toBe(
      buildWebhookReceiptSemanticKey(message(), publisherBotId),
    );
    expect(buildWebhookReceiptSemanticKey(message('other-publisher'), publisherBotId)).toBe(
      buildWebhookSemanticEventKey(message('other-publisher')),
    );
  });

  it('does not invent semantic authority for a Publisher event without a supported identity', () => {
    const update = { botId: publisherBotId, type: 'unknown_fixture_event' } as MaxUpdate;
    expect(buildWebhookSemanticEventKey(update)).toBeNull();
    expect(buildWebhookReceiptSemanticKey(update, publisherBotId)).toBeNull();
  });

  it('persists the observation namespace and preserves the ordinary receipt key', async () => {
    const f = fixture();
    await f.internals.persistReceipt(f.update, null, {});
    await f.internals.persistReceipt(message('fixture-moderator'), null, {});
    expect(f.prisma.webhookEvent.createMany.mock.calls[0]?.[0].data[0].semanticKey).toBe(
      buildWebhookReceiptSemanticKey(f.update, publisherBotId),
    );
    expect(f.prisma.webhookEvent.createMany.mock.calls[1]?.[0].data[0].semanticKey).toBe(
      buildWebhookSemanticEventKey(f.update),
    );
    await f.service.onModuleDestroy();
  });

  it.each([true, false])(
    'uses the receipt namespace in fallback loading (Publisher=%s)',
    async (publisher) => {
      const f = fixture();
      f.prisma.webhookEvent.findUnique.mockResolvedValue(null);
      const update = message(publisher ? publisherBotId : 'fixture-moderator');
      const receipt = await f.internals.loadWebhookReceipt('missing-fixture', update);
      expect(receipt?.semanticKey).toBe(buildWebhookReceiptSemanticKey(update, publisherBotId));
      expect(receipt?.normalizedPayload).toBe(update);
      await f.service.onModuleDestroy();
    },
  );

  it('fills a missing key and observes Publisher without moderation claims or abandonment lookup', async () => {
    const f = fixture();
    await expect(f.service.preparePersistedWebhookEvent(f.event.id)).resolves.toMatchObject({
      canonical: false,
      prepared: true,
      executionBotId: null,
    });
    expect(f.prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { id: f.event.id, semanticKey: null },
      data: { semanticKey: buildWebhookReceiptSemanticKey(f.update, publisherBotId) },
    });
    expect(f.lifecycle.observeWebhook).toHaveBeenCalledWith(f.update);
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.createMany).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.findUnique).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
    await f.service.onModuleDestroy();
  });

  it('requires reviewed recovery before observing a Publisher receipt with an existing shared key', async () => {
    const f = fixture(buildWebhookSemanticEventKey(message()));
    await expect(f.service.preparePersistedWebhookEvent(f.event.id)).rejects.toMatchObject({
      name: WebhookPreparationDeferredError.name,
      message: 'Publisher receipt semantic namespace requires reviewed recovery',
    });
    expect(f.lifecycle.observeWebhook).not.toHaveBeenCalled();
    expect(f.prisma.webhookEvent.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.findUnique).not.toHaveBeenCalled();
    await f.service.onModuleDestroy();
  });

  it('defers before Publisher effects when a concurrent writer wins the missing-key backfill', async () => {
    const f = fixture();
    f.prisma.webhookEvent.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.service.preparePersistedWebhookEvent(f.event.id)).rejects.toMatchObject({
      name: WebhookPreparationDeferredError.name,
      message: 'Publisher receipt semantic backfill changed',
    });
    expect(f.prisma.webhookEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.observeWebhook).not.toHaveBeenCalled();
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.findUnique).not.toHaveBeenCalled();
    expect(f.prisma.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
    await f.service.onModuleDestroy();
  });
});
