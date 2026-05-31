import type { Queue } from 'bullmq';
import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import type { NightModeTransitionJob } from './night-mode-transition.queue';

describe('NightModeTransitionSchedulerService', () => {
  it('bootstraps only chats with active bot membership or legacy chats without memberships', async () => {
    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const queue = {
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );

    await service.bootstrapEnabledChats();

    expect(prisma.chatSettings.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          nightModeEnabled: true,
          chat: {
            OR: [
              {
                botMemberships: {
                  some: {
                    status: ChatBotMembershipStatus.ACTIVE,
                  },
                },
              },
              {
                botMemberships: {
                  none: {},
                },
              },
            ],
          },
        },
      }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not enqueue reconciled settings for chats without active bot membership', async () => {
    const prisma = {
      chatBotMembership: {
        count: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
      },
    };
    const queue = {
      getJobs: jest.fn().mockResolvedValue([]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );

    await service.reconcileChatSettings('chat-removed', {
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    });

    expect(prisma.chatBotMembership.count).toHaveBeenNthCalledWith(1, {
      where: {
        chatId: 'chat-removed',
      },
    });
    expect(prisma.chatBotMembership.count).toHaveBeenNthCalledWith(2, {
      where: {
        chatId: 'chat-removed',
        status: ChatBotMembershipStatus.ACTIVE,
      },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
