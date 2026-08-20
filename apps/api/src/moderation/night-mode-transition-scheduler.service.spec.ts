import type { Queue } from 'bullmq';
import { ChatBotMembershipStatus, ChatEntityType } from '../prisma/prisma-client';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import {
  buildNightModeTransitionJobId,
  NIGHT_MODE_TRANSITION_JOB_NAME,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';

describe('NightModeTransitionSchedulerService', () => {
  it.each([
    { name: 'all memberships are removed', counts: [2, 0], expected: false },
    { name: 'an active membership remains', counts: [2, 1], expected: true },
    { name: 'the chat is legacy and has no memberships', counts: [0], expected: true },
  ])('guards transition execution when $name', async ({ counts, expected }) => {
    const remainingCounts = [...counts];
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHAT }),
      },
      chatBotMembership: {
        count: jest.fn(async () => remainingCounts.shift() ?? 0),
      },
    };
    const service = new NightModeTransitionSchedulerService(prisma as never);

    await expect(service.shouldProcessChatTransitions('chat-1')).resolves.toBe(expected);

    expect(prisma.chatBotMembership.count).toHaveBeenCalledTimes(counts.length);
  });

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
            entityType: ChatEntityType.CHAT,
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
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHAT }),
      },
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

    expect(prisma.chat.findUnique).toHaveBeenCalledWith({
      where: { id: 'chat-removed' },
      select: {
        entityType: true,
      },
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

  it('does not enqueue reconciled settings for channels', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHANNEL }),
      },
      chatBotMembership: {
        count: jest.fn(),
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

    await service.reconcileChatSettings('channel-1', {
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    });

    expect(prisma.chat.findUnique).toHaveBeenCalledWith({
      where: { id: 'channel-1' },
      select: {
        entityType: true,
      },
    });
    expect(prisma.chatBotMembership.count).not.toHaveBeenCalled();
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
          transitionRuntimeVersion: 2,
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

  it('bootstraps a catch-up open job when the current night session already ended', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
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
          transition: 'open',
          scheduledFor: '2026-05-31T05:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
          transitionRuntimeVersion: 2,
        }),
        expect.objectContaining({
          delay: 0,
        }),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        2,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          transition: 'close',
          scheduledFor: '2026-05-31T20:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        }),
        expect.any(Object),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        3,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          transition: 'open',
          scheduledFor: '2026-06-01T05:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        }),
        expect.any(Object),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('reconciles a catch-up open job when the current night session already ended', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const queue = {
        getJobs: jest.fn().mockResolvedValue([]),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        {} as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.reconcileChatSettings('chat-1', {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      });

      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId: 'chat-1',
          transition: 'open',
          scheduledFor: '2026-05-31T05:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        }),
        expect.objectContaining({
          delay: 0,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('requeues a legacy failed current open job after a known pre-send delete rejection', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const jobId = buildNightModeTransitionJobId(
        'chat-1',
        'open',
        '2026-05-31T05:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      );
      const failedJob = {
        id: jobId,
        failedReason: 'user.not.admin',
        data: {},
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn().mockResolvedValue(undefined),
      };
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
        getJob: jest.fn().mockResolvedValue(failedJob),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.bootstrapEnabledChats();

      expect(queue.getJob).toHaveBeenCalledWith(jobId);
      expect(failedJob.getState).toHaveBeenCalledTimes(1);
      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          transition: 'open',
          scheduledFor: '2026-05-31T05:00:00.000Z',
        }),
        expect.objectContaining({ jobId }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not re-add a legacy current open job when the failed job cannot be removed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const jobId = buildNightModeTransitionJobId(
        'chat-1',
        'open',
        '2026-05-31T05:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      );
      const failedJob = {
        id: jobId,
        failedReason: 'user.not.admin',
        data: {},
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn().mockRejectedValue(new Error('queue unavailable')),
      };
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
        getJob: jest.fn().mockResolvedValue(failedJob),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.bootstrapEnabledChats();

      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.any(Object),
        expect.objectContaining({ jobId }),
      );
      expect(queue.add).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not revive a versioned current open job after a user.not.admin failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const jobId = buildNightModeTransitionJobId(
        'chat-1',
        'open',
        '2026-05-31T05:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      );
      const failedJob = {
        id: jobId,
        failedReason: 'user.not.admin',
        data: { transitionRuntimeVersion: 2 },
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn(),
      };
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
        getJob: jest.fn().mockResolvedValue(failedJob),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.bootstrapEnabledChats();

      expect(failedJob.remove).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
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

  it('revives a versioned current job after the exact legacy pre-dispatch no-route failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const jobId = buildNightModeTransitionJobId(
        'chat-1',
        'open',
        '2026-05-31T05:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      );
      const failedJob = {
        id: jobId,
        failedReason: 'MAX SEND_MESSAGE has no executable routed bot candidate for chat chat-1',
        data: { transitionRuntimeVersion: 2 },
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn().mockResolvedValue(undefined),
      };
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
        getJob: jest.fn().mockResolvedValue(failedJob),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.bootstrapEnabledChats();

      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId: 'chat-1',
          transition: 'open',
          scheduledFor: '2026-05-31T05:00:00.000Z',
        }),
        expect.objectContaining({ jobId }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('revives a versioned current close job after an exact pre-dispatch route quarantine', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:12:00.000Z'));
    try {
      const jobId = buildNightModeTransitionJobId(
        'chat-1',
        'close',
        '2026-05-30T20:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      );
      const failedJob = {
        id: jobId,
        failedReason: 'MAX SEND_MESSAGE route is quarantined for chat chat-1',
        data: { transitionRuntimeVersion: 2 },
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn().mockResolvedValue(undefined),
      };
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
        getJob: jest.fn().mockResolvedValue(failedJob),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.bootstrapEnabledChats();

      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId: 'chat-1',
          transition: 'close',
          scheduledFor: '2026-05-30T20:00:00.000Z',
        }),
        expect.objectContaining({ jobId }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not enqueue a stale opening catch-up after its recovery window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T12:00:00.000Z'));
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

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
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

  it('repeats reconciliation when a fresh grant commits while removed jobs are cleared', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const settings = {
        chatId: 'chat-1',
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const removedSnapshot = {
        entityType: ChatEntityType.CHAT,
        settings,
        botMemberships: [
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.REMOVED,
            lifecycleEventAt: new Date('2026-05-30T20:00:00.000Z'),
            lifecycleEventType: 'bot_removed',
            lifecycleSource: 'webhook',
          },
        ],
      };
      const activeSnapshot = {
        entityType: ChatEntityType.CHAT,
        settings,
        botMemberships: [
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.ACTIVE,
            lifecycleEventAt: new Date('2026-05-30T20:00:01.000Z'),
            lifecycleEventType: 'bot_added',
            lifecycleSource: 'webhook',
          },
        ],
      };
      const staleJob = {
        id: buildNightModeTransitionJobId(
          'chat-1',
          'close',
          '2026-05-30T20:00:00.000Z',
          'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        ),
        remove: jest.fn().mockResolvedValue(undefined),
      };
      const prisma = {
        chat: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(removedSnapshot)
            .mockResolvedValue(activeSnapshot),
        },
      };
      const queue = {
        getJobs: jest.fn().mockResolvedValueOnce([staleJob]).mockResolvedValue([]),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await expect(service.reconcileChat('chat-1')).resolves.toEqual({
        jobsScheduled: true,
        passes: 2,
      });

      expect(staleJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.getJobs).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({ chatId: 'chat-1' }),
        expect.any(Object),
      );
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('propagates a queued-job removal failure from strict reconciliation', async () => {
    const removeError = new Error('redis remove failed');
    const settings = {
      chatId: 'chat-1',
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    };
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings,
          botMemberships: [
            {
              botId: 'bot-1',
              status: ChatBotMembershipStatus.REMOVED,
              lifecycleEventAt: new Date('2026-05-30T20:00:00.000Z'),
              lifecycleEventType: 'bot_removed',
              lifecycleSource: 'webhook',
            },
          ],
        }),
      },
    };
    const staleJob = {
      id: buildNightModeTransitionJobId(
        'chat-1',
        'close',
        '2026-05-30T20:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      ),
      remove: jest.fn().mockRejectedValue(removeError),
    };
    const queue = {
      getJobs: jest.fn().mockResolvedValue([staleJob]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );

    await expect(service.reconcileChat('chat-1')).rejects.toBe(removeError);

    expect(staleJob.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
  });
});
