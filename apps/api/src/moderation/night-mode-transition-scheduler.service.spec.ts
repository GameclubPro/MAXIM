import type { Queue } from 'bullmq';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import {
  buildNightModeTransitionJobId,
  NIGHT_MODE_TRANSITION_JOB_NAME,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';

describe('NightModeTransitionSchedulerService', () => {
  it.each([
    {
      name: 'all memberships are removed',
      memberships: [{ botId: 'bot-1', status: ChatBotMembershipStatus.REMOVED }],
      actionableBotIds: ['bot-1'],
      expected: false,
    },
    {
      name: 'an actionable membership has fresh confirmed access',
      memberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          botAccessExpiresAt: new Date(Date.now() + 60_000),
        },
      ],
      actionableBotIds: ['bot-1'],
      expected: true,
    },
    {
      name: 'an actionable confirmed membership has expired evidence for live refresh',
      memberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          botAccessExpiresAt: new Date(Date.now() - 1),
        },
      ],
      actionableBotIds: ['bot-1'],
      expected: true,
    },
    {
      name: 'only a dormant bot has active membership',
      memberships: [
        {
          botId: 'bot-dormant',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_OWNER,
          botAccessExpiresAt: new Date(Date.now() + 60_000),
        },
      ],
      actionableBotIds: ['bot-1'],
      expected: false,
    },
    {
      name: 'an actionable unknown membership can reach live refresh',
      memberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.UNKNOWN,
        },
      ],
      actionableBotIds: ['bot-1'],
      expected: true,
    },
    {
      name: 'an actionable stale membership can reach live refresh',
      memberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.STALE,
        },
      ],
      actionableBotIds: ['bot-1'],
      expected: true,
    },
    ...[
      ChatBotAccessState.CONFIRMED_MEMBER,
      ChatBotAccessState.DENIED,
      ChatBotAccessState.LOST,
    ].map((botAccessState) => ({
      name: `an actionable membership is explicitly ${botAccessState}`,
      memberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState,
        },
      ],
      actionableBotIds: ['bot-1'],
      expected: false,
    })),
    {
      name: 'the chat is legacy and has no memberships',
      memberships: [],
      actionableBotIds: [],
      expected: true,
    },
  ])(
    'guards transition execution when $name',
    async ({ memberships, actionableBotIds, expected }) => {
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: ChatEntityType.CHAT,
            botMemberships: memberships,
          }),
        },
      };
      const maxBotRegistry = {
        getActionableBots: jest.fn().mockReturnValue(actionableBotIds.map((id) => ({ id }))),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        undefined,
        undefined,
        maxBotRegistry as never,
      );

      await expect(service.shouldProcessChatTransitions('chat-1')).resolves.toBe(expected);

      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    },
  );

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
                    botAccessState: {
                      in: [
                        ChatBotAccessState.UNKNOWN,
                        ChatBotAccessState.STALE,
                        ChatBotAccessState.CONFIRMED_ADMIN,
                        ChatBotAccessState.CONFIRMED_OWNER,
                      ],
                    },
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

  it('does not bootstrap a schedule backed only by a non-actionable bot', async () => {
    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-dormant',
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
          },
        ]),
      },
      chat: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'chat-dormant',
            entityType: ChatEntityType.CHAT,
            botMemberships: [
              {
                botId: 'bot-dormant',
                status: ChatBotMembershipStatus.ACTIVE,
                botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
                botAccessExpiresAt: new Date(Date.now() + 60_000),
              },
            ],
            accessEdges: [],
          },
        ]),
      },
    };
    const queue = {
      add: jest.fn(),
    };
    const maxBotRegistry = {
      getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-actionable' }]),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
      undefined,
      maxBotRegistry as never,
    );

    await service.bootstrapEnabledChats();

    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.chatSettings.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chat: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                botMemberships: {
                  some: {
                    status: ChatBotMembershipStatus.ACTIVE,
                    botAccessState: {
                      in: [
                        ChatBotAccessState.UNKNOWN,
                        ChatBotAccessState.STALE,
                        ChatBotAccessState.CONFIRMED_ADMIN,
                        ChatBotAccessState.CONFIRMED_OWNER,
                      ],
                    },
                    botId: { in: ['bot-actionable'] },
                  },
                },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it('does not enqueue reconciled settings for chats without active bot membership', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          botMemberships: [{ botId: 'bot-1', status: ChatBotMembershipStatus.REMOVED }],
          accessEdges: [],
        }),
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

    expect(prisma.chat.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'chat-removed' } }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not enqueue reconciled settings for channels', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHANNEL,
          botMemberships: [],
          accessEdges: [],
        }),
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

    expect(prisma.chat.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'channel-1' } }),
    );
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

  it('requeues a legacy failed current open job when it vanishes during catch-up removal', async () => {
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
        remove: jest.fn().mockRejectedValue(new Error(`Missing key for job ${jobId}. removeJob`)),
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
        accessEdges: [],
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
        accessEdges: [],
        botMemberships: [
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
            botAccessExpiresAt: new Date('2026-05-30T21:00:00.000Z'),
            permissionsSnapshot: null,
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
        queueAvailable: true,
        scheduleEnabled: true,
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

  it('does not repeat reconciliation when fresh access evidence refreshes without changing access', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const settings = {
        chatId: 'chat-1',
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const buildSnapshot = (checkedAt: string, expiresAt: string) => ({
        entityType: ChatEntityType.CHAT,
        settings,
        accessEdges: [],
        botMemberships: [
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
            botAccessExpiresAt: new Date(expiresAt),
            permissionsSnapshot: {
              checkedAt,
              isAdmin: true,
              isOwner: false,
              permissions: ['write'],
            },
          },
        ],
      });
      const prisma = {
        chat: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(
              buildSnapshot('2026-05-30T20:35:00.000Z', '2026-05-30T20:39:00.000Z'),
            )
            .mockResolvedValue(
              buildSnapshot('2026-05-30T20:39:00.000Z', '2026-05-30T21:04:00.000Z'),
            ),
        },
      };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([]),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await expect(service.reconcileChat('chat-1')).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });

      expect(queue.getJobs).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(3);
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports an unavailable queue without claiming that jobs were cleared', async () => {
    const service = new NightModeTransitionSchedulerService({} as never);

    await expect(service.reconcileChat('chat-1')).resolves.toEqual({
      queueAvailable: false,
      scheduleEnabled: null,
      passes: 0,
    });
  });

  it('reports an enabled zero-occurrence schedule', async () => {
    const settings = {
      chatId: 'chat-1',
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 8 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    };
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings,
          botMemberships: [],
          accessEdges: [],
        }),
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

    await expect(service.reconcileChat('chat-1')).resolves.toEqual({
      queueAvailable: true,
      scheduleEnabled: true,
      passes: 1,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips a job that vanishes while BullMQ materializes getJobs results', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: null,
          botMemberships: [{ botId: 'bot-1', status: ChatBotMembershipStatus.REMOVED }],
          accessEdges: [],
        }),
      },
    };
    const queue = {
      getJobs: jest.fn().mockResolvedValue([undefined]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );

    await expect(service.reconcileChat('chat-1')).resolves.toEqual({
      queueAvailable: true,
      scheduleEnabled: false,
      passes: 1,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('treats BullMQ missing-key removal as an already vanished job', async () => {
    const snapshot = {
      entityType: ChatEntityType.CHAT,
      settings: null,
      botMemberships: [{ botId: 'bot-1', status: ChatBotMembershipStatus.REMOVED }],
    };
    const jobId = buildNightModeTransitionJobId(
      'chat-1',
      'close',
      '2026-05-30T20:00:00.000Z',
      'v1:Europe/Moscow:23:00:08:00:2026-05-30',
    );
    const vanishedJob = {
      id: jobId,
      remove: jest.fn().mockRejectedValue(new Error(`Missing key for job ${jobId}. removeJob`)),
    };
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue(snapshot),
      },
    };
    const queue = {
      getJobs: jest.fn().mockResolvedValue([vanishedJob]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );

    await expect(service.reconcileChat('chat-1')).resolves.toEqual({
      queueAvailable: true,
      scheduleEnabled: false,
      passes: 1,
    });

    expect(vanishedJob.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('propagates an active-lock removal race from strict reconciliation', async () => {
    const removeError = new Error(
      'Job could not be removed because it is locked by another worker',
    );
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
          accessEdges: [],
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
