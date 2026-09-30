import {
  duplicateRevocationKey,
  MessageDuplicateAuthorizationService,
} from './message-duplicate-authorization.service';
import { buildMessageDuplicateJobId } from './message-duplicate.queue';
import type { MessageDuplicateBinding } from './message-duplicate-state';

function setup() {
  const prisma = {
    moderationViolationMessageClaim: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const ordering = {
    announce: jest.fn().mockResolvedValue({ kind: 'registered', actionEligible: false }),
    revokeActionEligibility: jest.fn().mockResolvedValue(undefined),
    readActionEligibility: jest.fn().mockResolvedValue(true),
  };
  const service = new MessageDuplicateAuthorizationService(prisma as never, ordering as never);
  const eventTimestampMs = Date.now() - 1000;
  const binding = {
    version: 3,
    compareMode: 'IMAGE',
    messageId: 'message',
    eventTimestampMs,
    hasPhotos: true,
    mediaHashes: ['a'.repeat(64)],
    authorization: {
      jobId: buildMessageDuplicateJobId('-123', 'message', eventTimestampMs, 'IMAGE'),
      eventTimestampMs,
      deadlineAtMs: eventTimestampMs + 600_000,
    },
  } as MessageDuplicateBinding;
  return { prisma, ordering, service, binding };
}

describe('message duplicate action authorization', () => {
  it('persists revocation before Redis and never takes another rule whole-message claim', async () => {
    const s = setup();
    await s.service.revoke({
      chatId: '-123',
      messageId: 'message',
      senderId: '123',
      eventTimestampMs: s.binding.eventTimestampMs,
    });
    expect(s.prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          dedupeKey: duplicateRevocationKey('-123', 'message', s.binding.eventTimestampMs),
          messageActionKey: null,
          ruleCode: 'MESSAGE_DUPLICATE_AUTHORIZATION_REVOKED',
        }),
      ],
      skipDuplicates: true,
    });
    expect(
      s.prisma.moderationViolationMessageClaim.createMany.mock.invocationCallOrder[0],
    ).toBeLessThan(s.ordering.revokeActionEligibility.mock.invocationCallOrder[0]!);
    expect(s.ordering.revokeActionEligibility).toHaveBeenCalledTimes(2);
    expect(s.ordering.announce).not.toHaveBeenCalled();
  });

  it('never publishes a volatile denial when durable persistence fails', async () => {
    const s = setup();
    s.prisma.moderationViolationMessageClaim.createMany.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(
      s.service.revoke({
        chatId: '-123',
        messageId: 'message',
        senderId: '123',
        eventTimestampMs: s.binding.eventTimestampMs,
      }),
    ).rejects.toThrow('database unavailable');
    expect(s.ordering.revokeActionEligibility).not.toHaveBeenCalled();
  });

  it('keeps durable denial effective even if Redis is lost afterward', async () => {
    const s = setup();
    s.ordering.revokeActionEligibility.mockRejectedValue(new Error('redis unavailable'));
    await s.service.revoke({
      chatId: '-123',
      messageId: 'message',
      senderId: '123',
      eventTimestampMs: s.binding.eventTimestampMs,
    });
    s.prisma.moderationViolationMessageClaim.findUnique.mockResolvedValue({ id: 'tombstone' });
    expect(await s.service.isAllowed('-123', s.binding)).toBe(false);
    expect(s.ordering.readActionEligibility).not.toHaveBeenCalled();
  });

  it.each(['actual', 'canonical'] as const)(
    'checks revocation of the %s event on cosmetic media replay',
    async (revokedTimestamp) => {
      const s = setup();
      const actual = s.binding.authorization!.eventTimestampMs;
      const canonical = actual - 1000;
      s.binding.eventTimestampMs = canonical;
      s.prisma.moderationViolationMessageClaim.findUnique.mockImplementation(
        async ({ where }: { where: { dedupeKey: string } }) =>
          where.dedupeKey ===
          duplicateRevocationKey(
            '-123',
            'message',
            revokedTimestamp === 'actual' ? actual : canonical,
          )
            ? { id: 'revoked' }
            : null,
      );
      expect(await s.service.isAllowed('-123', s.binding)).toBe(false);
      expect(s.ordering.readActionEligibility).not.toHaveBeenCalled();
    },
  );

  it('allows a live media binding only after durable and Redis checks', async () => {
    const s = setup();
    expect(await s.service.isAllowed('-123', s.binding)).toBe(true);
    expect(s.ordering.readActionEligibility).toHaveBeenCalledWith({
      chatId: '-123',
      jobId: s.binding.authorization!.jobId,
      sourceCreatedAt: new Date(s.binding.authorization!.eventTimestampMs).toISOString(),
      deadlineAtMs: s.binding.authorization!.deadlineAtMs,
    });
    expect(
      s.prisma.moderationViolationMessageClaim.findUnique.mock.invocationCallOrder[0],
    ).toBeLessThan(s.ordering.readActionEligibility.mock.invocationCallOrder[0]!);
  });

  it.each(['missing', 'false', 'unavailable'] as const)(
    'fails closed for Redis permission that is %s',
    async (condition) => {
      const s = setup();
      if (condition === 'unavailable') {
        s.ordering.readActionEligibility.mockRejectedValue(new Error('redis unavailable'));
        await expect(s.service.isAllowed('-123', s.binding)).rejects.toThrow('redis unavailable');
      } else {
        s.ordering.readActionEligibility.mockResolvedValue(false);
        expect(await s.service.isAllowed('-123', s.binding)).toBe(false);
      }
    },
  );

  it.each(['expired', 'extended', 'wrong_job', 'missing_authority', 'old_version'] as const)(
    'denies %s authority before checking Redis',
    async (condition) => {
      const s = setup();
      if (condition === 'expired') s.binding.authorization!.deadlineAtMs = Date.now();
      if (condition === 'extended') s.binding.authorization!.deadlineAtMs += 1;
      if (condition === 'wrong_job')
        s.binding.authorization!.jobId = buildMessageDuplicateJobId(
          '-123',
          'other',
          s.binding.eventTimestampMs,
          'IMAGE',
        );
      if (condition === 'missing_authority') delete s.binding.authorization;
      if (condition === 'old_version') s.binding.version = 2;
      expect(await s.service.isAllowed('-123', s.binding)).toBe(false);
      expect(s.ordering.readActionEligibility).not.toHaveBeenCalled();
    },
  );

  it('requires a Redis job permit for independently verified binary media', async () => {
    const s = setup();
    s.binding.compareMode = 'MESSAGE';
    s.binding.hasPhotos = false;
    delete s.binding.authorization!.jobId;
    expect(await s.service.isAllowed('-123', s.binding)).toBe(false);
  });

  it('allows synchronous text authority without creating a background permit', async () => {
    const s = setup();
    s.binding.compareMode = 'TEXT';
    s.binding.hasPhotos = false;
    s.binding.mediaHashes = [];
    delete s.binding.authorization!.jobId;
    expect(await s.service.isAllowed('-123', s.binding)).toBe(true);
    expect(s.ordering.readActionEligibility).not.toHaveBeenCalled();
  });
});
