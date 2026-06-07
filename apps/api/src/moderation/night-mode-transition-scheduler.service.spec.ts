import type { Queue } from 'bullmq';
import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import {
  NIGHT_MODE_TRANSITION_JOB_NAME,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';

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

  it('bootstraps a catch-up close job when the current night session already started', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const prisma = {
        chatSettings: {
          findMany: jest.fn().mockResolvedValue([
            {
              chatId: 'chat-1',
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
            },
          ]),
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

      expect(queue.add).toHaveBeenCalledTimes(3);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId: 'chat-1',
          transition: 'close',
          scheduledFor: '2026-05-30T20:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        }),
        expect.objectContaining({
          delay: 0,
        }),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        2,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId: 'chat-1',
          transition: 'open',
          scheduledFor: '2026-05-31T05:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        }),
        expect.any(Object),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        3,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId: 'chat-1',
          transition: 'close',
          scheduledFor: '2026-05-31T20:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        }),
        expect.any(Object),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not enqueue the current close again after a transition job completes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const prisma = {
        chatSettings: {
          findFirst: jest.fn().mockResolvedValue({
            chatId: 'chat-1',
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
          }),
        },
      };
      const queue = {
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.enqueueNextTransitionsForChat('chat-1');

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          transition: 'open',
          scheduledFor: '2026-05-31T05:00:00.000Z',
        }),
        expect.any(Object),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        2,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          transition: 'close',
          scheduledFor: '2026-05-31T20:00:00.000Z',
        }),
        expect.any(Object),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
