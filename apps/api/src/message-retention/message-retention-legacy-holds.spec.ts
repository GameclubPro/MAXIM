import { ConfigService } from '@nestjs/config';
import { Prisma } from '../prisma/prisma-client';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import {
  WebhookLegacyHoldRejectedError,
  WebhookLegacyHoldService,
} from '../webhook/webhook-legacy-hold.service';
import { MessageRetentionStore } from './message-retention-store.service';

const input = {
  chatId: '-1',
  messageId: 'message',
  authorId: 'author',
  originBotId: 'bot',
  sourceAt: new Date(),
};

function fixture() {
  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    moderationDeleteIntent: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
    },
    moderationDeleteIntentReason: { create: jest.fn() },
    messageRetentionCandidate: {
      findUnique: jest.fn().mockResolvedValue({
        ...input,
        activationId: 'activation',
        status: 'pending',
        policy: { enabled: true, activationId: 'activation' },
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = { $transaction: jest.fn(async (run) => run(tx)) };
  const holds = {
    isMessageHeld: jest.fn().mockResolvedValue(false),
    isMemberHeld: jest.fn().mockResolvedValue(false),
    isGlobalUserHeld: jest.fn().mockResolvedValue(false),
  };
  const store = new MessageRetentionStore(
    prisma as never,
    new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
    holds as never,
  );
  const deletes = Object.create(ModerationDeleteIntentService.prototype) as any;
  Object.assign(deletes, { prisma, legacyHolds: holds });
  return { tx, prisma, holds, store, deletes };
}

describe('retention admission under permanent automatic effect holds', () => {
  it.each(['isMessageHeld', 'isMemberHeld', 'isGlobalUserHeld'] as const)(
    'preserves receipt admission but creates no candidate, quota charge or pause under %s',
    async (scope) => {
      const f = fixture();
      f.holds[scope].mockResolvedValue(true);
      f.tx.$queryRaw.mockResolvedValue([{ shard: 0 }]);
      await expect(f.store.capture(f.tx as never, input)).resolves.toBeUndefined();
      expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect((f.tx.$queryRaw.mock.calls[0]![0] as Prisma.Sql).text).not.toContain('FOR UPDATE');
      expect(f.tx.$executeRaw).not.toHaveBeenCalled();
      expect(f.holds[scope]).toHaveBeenCalledWith(
        ...(scope === 'isGlobalUserHeld'
          ? [input.authorId, f.tx]
          : [input.chatId, scope === 'isMessageHeld' ? input.messageId : input.authorId, f.tx]),
      );
    },
  );

  it('uses the registered production reader when hand-built callers omit optional injection', async () => {
    const f = fixture();
    new WebhookLegacyHoldService(f.prisma as never);
    f.tx.$queryRaw.mockResolvedValueOnce([{ shard: 0 }]).mockResolvedValueOnce([{ held: true }]);
    const store = new MessageRetentionStore(
      f.prisma as never,
      new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
    );
    await store.capture(f.tx as never, input);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect((f.tx.$queryRaw.mock.calls[1]![0] as Prisma.Sql).text).toContain(
      'webhook_legacy_recoveries',
    );
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('does not spend hold lookups on a chat without an eligible retention policy', async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValue([]);
    await f.store.capture(f.tx as never, input);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(f.holds.isMessageHeld).not.toHaveBeenCalled();
    expect(f.holds.isMemberHeld).not.toHaveBeenCalled();
    expect(f.holds.isGlobalUserHeld).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('still admits an unrelated unheld source through the existing bounded quota path', async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValueOnce([{ shard: 0 }]).mockResolvedValueOnce([
      {
        enabled: true,
        captureAfter: new Date(0),
        activationId: 'activation',
        hours: 24,
        pausedAt: null,
        quotaPausedAt: null,
        pendingCount: 0,
        quotaCount: 0,
      },
    ]);
    await f.store.capture(f.tx as never, input);
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect((f.tx.$executeRaw.mock.calls[0]![0] as Prisma.Sql).text).toContain(
      'INSERT INTO "message_retention_candidates"',
    );
    expect(f.holds.isGlobalUserHeld).toHaveBeenCalledWith(input.authorId, f.tx);
  });

  it.each(['isMessageHeld', 'isMemberHeld', 'isGlobalUserHeld'] as const)(
    'denies retention materialization before a new intent/reason/attachment under %s',
    async (scope) => {
      const f = fixture();
      f.holds[scope].mockResolvedValue(true);
      await expect(
        f.deletes.ensureRetentionIntent({ ...input, activationId: 'activation' }),
      ).rejects.toBeInstanceOf(WebhookLegacyHoldRejectedError);
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
      expect(f.tx.moderationDeleteIntentReason.create).not.toHaveBeenCalled();
      expect(f.tx.messageRetentionCandidate.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 'SUCCEEDED' },
    { status: 'ALREADY_ABSENT' },
    {
      status: 'AMBIGUOUS',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot',
    },
  ])('reads exact positive receipt $status before held source admission', async (receipt) => {
    const f = fixture();
    f.tx.moderationDeleteIntent.findUnique.mockResolvedValue({ id: 'saved', ...receipt });
    f.holds.isMessageHeld.mockResolvedValue(true);
    expect(await f.deletes.ensureRetentionIntent(input)).toBe('saved');
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    expect(f.tx.moderationDeleteIntentReason.create).not.toHaveBeenCalled();
    expect(f.tx.messageRetentionCandidate.updateMany).not.toHaveBeenCalled();
    expect(f.holds.isMessageHeld).not.toHaveBeenCalled();
  });

  it.each([
    { remoteDeleteSucceededAt: new Date() },
    { remoteDeleteSucceededBotId: 'bot' },
    { deleteDispatchStartedAt: new Date(), deleteDispatchStartedBotId: 'bot' },
  ])('keeps incomplete/unknown receipt $remoteDeleteSucceededBotId fenced', async (receipt) => {
    const f = fixture();
    f.tx.moderationDeleteIntent.findUnique.mockResolvedValue({
      id: 'unknown',
      status: 'AMBIGUOUS',
      ...receipt,
    });
    f.holds.isGlobalUserHeld.mockResolvedValue(true);
    await expect(f.deletes.ensureRetentionIntent(input)).rejects.toBeInstanceOf(
      WebhookLegacyHoldRejectedError,
    );
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    expect(f.tx.moderationDeleteIntentReason.create).not.toHaveBeenCalled();
  });

  it('rechecks before creating a reason after an insertion wait', async () => {
    const f = fixture();
    f.holds.isGlobalUserHeld.mockResolvedValueOnce(false).mockResolvedValue(true);
    f.tx.$queryRaw.mockResolvedValue([{ id: 'new-intent' }]);
    await expect(
      f.deletes.ensureRetentionIntent({ ...input, activationId: 'activation' }),
    ).rejects.toBeInstanceOf(WebhookLegacyHoldRejectedError);
    expect(f.tx.moderationDeleteIntentReason.create).not.toHaveBeenCalled();
    expect(f.tx.messageRetentionCandidate.updateMany).not.toHaveBeenCalled();
  });

  it('materializes one unheld retention reason and attaches the existing activation', async () => {
    const f = fixture();
    f.tx.$queryRaw.mockResolvedValueOnce([{ id: 'new-intent' }]).mockResolvedValueOnce([]);
    expect(await f.deletes.ensureRetentionIntent({ ...input, activationId: 'activation' })).toBe(
      'new-intent',
    );
    expect(f.tx.moderationDeleteIntentReason.create).toHaveBeenCalledTimes(1);
    expect(f.tx.messageRetentionCandidate.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: input.chatId,
        messageId: input.messageId,
        activationId: 'activation',
        status: { in: ['pending', 'retry'] },
      },
      data: { intentId: 'new-intent' },
    });
  });
});
