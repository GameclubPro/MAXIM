import { SanctionAction } from '@prisma/client';
import { SanctionService } from './sanction.service';

describe('SanctionService', () => {
  it('returns WARN when threshold not reached', async () => {
    const prisma = {
      violation: {
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest.fn(),
      },
    };

    const service = new SanctionService(prisma as never);
    await expect(
      service.resolveAction({
        chatId: 'chat-1',
        userId: 'u-1',
        warnThreshold: 3,
      }),
    ).resolves.toBe(SanctionAction.WARN);
  });

  it('returns KICK on threshold without recent kick', async () => {
    const prisma = {
      violation: {
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    const service = new SanctionService(prisma as never);
    await expect(
      service.resolveAction({
        chatId: 'chat-1',
        userId: 'u-1',
        warnThreshold: 3,
      }),
    ).resolves.toBe(SanctionAction.KICK);
  });

  it('returns BAN on threshold with recent kick', async () => {
    const prisma = {
      violation: {
        count: jest.fn().mockResolvedValue(6),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue({ id: 'kick-1' }),
      },
    };

    const service = new SanctionService(prisma as never);
    await expect(
      service.resolveAction({
        chatId: 'chat-1',
        userId: 'u-1',
        warnThreshold: 3,
      }),
    ).resolves.toBe(SanctionAction.BAN);
  });

  it('resets escalation after a later manual unban', async () => {
    const prisma = {
      violation: {
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            createdAt: new Date('2026-03-25T10:00:00.000Z'),
          })
          .mockResolvedValueOnce(null),
      },
    };

    const service = new SanctionService(prisma as never);
    await expect(
      service.resolveAction({
        chatId: 'chat-1',
        userId: 'u-1',
        warnThreshold: 3,
      }),
    ).resolves.toBe(SanctionAction.WARN);

    expect(prisma.violation.count).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: 'u-1',
        createdAt: {
          gt: new Date('2026-03-25T10:00:00.000Z'),
        },
      },
    });
  });
});
