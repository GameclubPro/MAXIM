import type { Queue } from 'bullmq';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  MaxActionLedgerStatus,
} from '../prisma/prisma-client';
import { buildNightModeTransitionScheduleFingerprint } from './night-mode-transition-generation.util';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import {
  buildNightModeTransitionJobId,
  buildNightModeTransitionRecoveryJobId,
  NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
  NIGHT_MODE_TRANSITION_JOB_NAME,
  NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';

const CLOSE_SESSION_A = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
const SCHEDULE_FINGERPRINT = buildNightModeTransitionScheduleFingerprint({
  nightModeEnabled: true,
  nightModeStartTimeMinutes: 23 * 60,
  nightModeEndTimeMinutes: 8 * 60,
  nightModeTimezone: 'Europe/Moscow',
});
const ACTIVE_TRANSITION_MEMBERSHIP = {
  botId: 'bot-1',
  status: ChatBotMembershipStatus.ACTIVE,
  botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
  permissionsSnapshot: null,
} as const;

function buildCloseRecoveryA(chatId: string) {
  return {
    kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
    version: 1 as const,
    sessionKey: CLOSE_SESSION_A,
    messageId: `close-message-${chatId}`,
    botId: 'bot-a',
    timezone: 'Europe/Moscow',
    startMinutes: 23 * 60,
    endMinutes: 8 * 60,
  };
}

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return Array.isArray(strings) ? strings.join(' ') : String(query);
}

function extractSqlValues(query: unknown): readonly unknown[] {
  const values = (query as { values?: readonly unknown[] } | null)?.values;
  return Array.isArray(values) ? values : [];
}

async function seedRegisteredJob(
  service: NightModeTransitionSchedulerService,
  params: {
    chatId: string;
    jobId: string;
    transition?: 'open' | 'close';
    sessionKey?: string;
    scheduledFor?: string;
    runtimeVersion?: number;
  },
): Promise<void> {
  await (
    service as unknown as {
      upsertScheduledJobRegistryIntent(row: {
        chat_id: string;
        job_id: string;
        transition: 'open' | 'close';
        session_key: string;
        scheduled_for: Date;
        schedule_fingerprint: string;
        runtime_version: number;
      }): Promise<void>;
    }
  ).upsertScheduledJobRegistryIntent({
    chat_id: params.chatId,
    job_id: params.jobId,
    transition: params.transition ?? 'close',
    session_key: params.sessionKey ?? 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
    scheduled_for: new Date(params.scheduledFor ?? '2026-05-30T20:00:00.000Z'),
    schedule_fingerprint: `sha256:${'a'.repeat(64)}`,
    runtime_version: params.runtimeVersion ?? 4,
  });
}

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
      name: 'an actionable membership has an explicit non-admin snapshot',
      memberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          permissionsSnapshot: {
            checkedAt: '2026-09-02T10:00:00.000Z',
            isAdmin: false,
            isOwner: false,
            permissions: ['write'],
          },
        },
      ],
      actionableBotIds: ['bot-1'],
      expected: false,
    },
    {
      name: 'an actionable membership has a null permissions snapshot',
      memberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          permissionsSnapshot: null,
        },
      ],
      actionableBotIds: ['bot-1'],
      expected: true,
    },
    {
      name: 'an actionable membership has a valid admin snapshot without write permissions',
      memberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          permissionsSnapshot: {
            checkedAt: '2026-09-02T10:00:00.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
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
      name: 'the chat has no proven bot membership',
      memberships: [],
      actionableBotIds: [],
      expected: false,
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

  it('bootstraps only chats with an active refreshable bot membership', async () => {
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
        },
      }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('retries the bootstrap after a transient page query failure', async () => {
    jest.useFakeTimers();
    try {
      const prisma = {
        chatSettings: {
          findMany: jest
            .fn()
            .mockRejectedValueOnce(new Error('temporary database failure'))
            .mockResolvedValueOnce([]),
        },
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        { add: jest.fn() } as unknown as Queue<NightModeTransitionJob>,
      );

      await service.bootstrapEnabledChats();
      expect(prisma.chatSettings.findMany).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30_000);
      expect(prisma.chatSettings.findMany).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
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
        }),
      }),
    );
  });

  it('does not bootstrap jobs for an explicit non-admin membership snapshot', async () => {
    const chatId = 'chat-explicit-non-admin';
    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId,
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
            id: chatId,
            entityType: ChatEntityType.CHAT,
            botMemberships: [
              {
                botId: 'bot-1',
                status: ChatBotMembershipStatus.ACTIVE,
                botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
                permissionsSnapshot: {
                  checkedAt: '2026-09-02T10:00:00.000Z',
                  isAdmin: false,
                  isOwner: false,
                  permissions: ['write'],
                },
              },
            ],
          },
        ]),
      },
    };
    const queue = { add: jest.fn() };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
      undefined,
      { getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }]) } as never,
    );

    await service.bootstrapEnabledChats();

    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.chat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          botMemberships: expect.objectContaining({
            select: expect.objectContaining({ permissionsSnapshot: true }),
          }),
        }),
      }),
    );
  });

  it('removes jobs added by a bootstrap pass that races with a committed disable', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const settings = {
        chatId: 'chat-bootstrap-disable-race',
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const activeSnapshot = {
        entityType: ChatEntityType.CHAT,
        settings,
        botMemberships: [
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          },
        ],
      };
      const disabledSnapshot = {
        ...activeSnapshot,
        settings: { ...settings, nightModeEnabled: false },
      };
      const prisma = {
        chatSettings: {
          findMany: jest.fn().mockResolvedValue([settings]),
        },
        chat: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: settings.chatId,
              entityType: ChatEntityType.CHAT,
              botMemberships: activeSnapshot.botMemberships,
            },
          ]),
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(activeSnapshot)
            .mockResolvedValue(disabledSnapshot),
        },
      };
      const storedJobs = new Map<
        string,
        { id: string; data: NightModeTransitionJob; remove: jest.Mock }
      >();
      const queue = {
        getJob: jest.fn(async (jobId: string) => storedJobs.get(jobId) ?? null),
        getJobs: jest.fn(async () => Array.from(storedJobs.values())),
        add: jest
          .fn()
          .mockImplementation(
            async (_name: string, data: NightModeTransitionJob, options: { jobId: string }) => {
              const job = {
                id: options.jobId,
                data,
                remove: jest.fn(async () => {
                  storedJobs.delete(options.jobId);
                }),
              };
              storedJobs.set(options.jobId, job);
              return job;
            },
          ),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.bootstrapEnabledChats();

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.getJobs).not.toHaveBeenCalled();
      expect(storedJobs.size).toBe(0);
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses the same distributed per-chat lock for bootstrap and enqueue-next mutations', async () => {
    const chatId = 'chat-shared-queue-lock';
    const settings = {
      chatId,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 8 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    };
    const snapshot = {
      entityType: ChatEntityType.CHAT,
      settings,
      botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
    };
    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([settings]),
        findFirst: jest.fn().mockResolvedValue(settings),
      },
      chat: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: chatId,
            entityType: ChatEntityType.CHAT,
            botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
          },
        ]),
        findUnique: jest.fn().mockResolvedValue(snapshot),
      },
    };
    const queue = {
      getJobs: jest.fn().mockResolvedValue([]),
      add: jest.fn(),
    };
    const redisCounter = {
      acquireLock: jest
        .fn()
        .mockResolvedValueOnce('bootstrap-token')
        .mockResolvedValueOnce('enqueue-next-token'),
      renewLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
      undefined,
      undefined,
      redisCounter as never,
    );

    await service.bootstrapEnabledChats();
    await service.enqueueNextTransitionsForChat(chatId);

    const lockKey = `night-mode-transition-queue-mutation:v1:${chatId}`;
    expect(redisCounter.acquireLock).toHaveBeenNthCalledWith(1, lockKey, 120_000);
    expect(redisCounter.acquireLock).toHaveBeenNthCalledWith(2, lockKey, 120_000);
    expect(redisCounter.releaseLock).toHaveBeenNthCalledWith(1, lockKey, 'bootstrap-token');
    expect(redisCounter.releaseLock).toHaveBeenNthCalledWith(2, lockKey, 'enqueue-next-token');
  });

  it('continues bootstrap after one chat keeps its distributed lock busy', async () => {
    jest.useFakeTimers();
    try {
      const settingsRows = ['chat-bootstrap-busy', 'chat-bootstrap-ok'].map((chatId) => ({
        chatId,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 8 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      }));
      const prisma = {
        chatSettings: {
          findMany: jest.fn().mockResolvedValue(settingsRows),
        },
        chat: {
          findMany: jest.fn().mockResolvedValue(
            settingsRows.map(({ chatId }) => ({
              id: chatId,
              entityType: ChatEntityType.CHAT,
              botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
            })),
          ),
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
            entityType: ChatEntityType.CHAT,
            settings: settingsRows.find((settings) => settings.chatId === where.id),
            botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
          })),
        },
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([]),
        add: jest.fn(),
      };
      const redisCounter = {
        acquireLock: jest.fn(async (key: string) =>
          key.endsWith(':chat-bootstrap-busy') ? null : 'chat-ok-token',
        ),
        renewLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        redisCounter as never,
      );

      const bootstrap = service.bootstrapEnabledChats();
      await jest.advanceTimersByTimeAsync(4_100);
      await bootstrap;

      expect(redisCounter.acquireLock).toHaveBeenCalledWith(
        'night-mode-transition-queue-mutation:v1:chat-bootstrap-ok',
        120_000,
      );
      expect(redisCounter.releaseLock).toHaveBeenCalledWith(
        'night-mode-transition-queue-mutation:v1:chat-bootstrap-ok',
        'chat-ok-token',
      );
      expect(prisma.chat.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'chat-bootstrap-ok' } }),
      );
      expect(
        prisma.$executeRaw.mock.calls.some(([query]) => {
          const sql = extractSqlText(query);
          const values = extractSqlValues(query);
          return (
            sql.includes('enqueue_night_mode_transition_reconcile_request') &&
            values.includes('chat-bootstrap-busy')
          );
        }),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains a bootstrap retry requested while a later chat is still in flight', async () => {
    jest.useFakeTimers();
    try {
      const settingsRows = ['chat-bootstrap-request-fails', 'chat-bootstrap-slow'].map(
        (chatId) => ({
          chatId,
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 8 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
        }),
      );
      let releaseSlowChat: () => void = () => undefined;
      const slowChatGate = new Promise<void>((resolve) => {
        releaseSlowChat = resolve;
      });
      let markSlowChatStarted: () => void = () => undefined;
      const slowChatStarted = new Promise<void>((resolve) => {
        markSlowChatStarted = resolve;
      });
      const prisma = {
        chatSettings: {
          findMany: jest.fn().mockResolvedValueOnce(settingsRows).mockResolvedValueOnce([]),
        },
        chat: {
          findMany: jest.fn().mockResolvedValue(
            settingsRows.map(({ chatId }) => ({
              id: chatId,
              entityType: ChatEntityType.CHAT,
              botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
            })),
          ),
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
            if (where.id === 'chat-bootstrap-slow') {
              markSlowChatStarted();
              await slowChatGate;
            }
            return {
              entityType: ChatEntityType.CHAT,
              settings: settingsRows.find((settings) => settings.chatId === where.id),
              botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
            };
          }),
        },
        $executeRaw: jest.fn().mockRejectedValueOnce(new Error('request database unavailable')),
      };
      const redisCounter = {
        acquireLock: jest.fn(async (key: string) =>
          key.endsWith(':chat-bootstrap-request-fails') ? null : 'slow-chat-token',
        ),
        renewLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        { add: jest.fn() } as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        redisCounter as never,
      );

      const bootstrap = service.bootstrapEnabledChats();
      await jest.advanceTimersByTimeAsync(4_100);
      await slowChatStarted;
      await jest.advanceTimersByTimeAsync(30_000);
      expect(prisma.chatSettings.findMany).toHaveBeenCalledTimes(1);

      releaseSlowChat();
      await bootstrap;
      await jest.advanceTimersByTimeAsync(30_000);

      expect(prisma.chatSettings.findMany).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
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

  it('ignores stale caller settings after a committed disable and clears old jobs', async () => {
    const chatId = 'chat-stale-settings-caller';
    const staleJob = {
      id: buildNightModeTransitionJobId(
        chatId,
        'open',
        '2026-05-31T05:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      ),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: {
            chatId,
            nightModeEnabled: false,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
          },
          botMemberships: [],
        }),
      },
    };
    const queue = {
      getJob: jest.fn(async (jobId: string) => (jobId === staleJob.id ? staleJob : null)),
      getJobs: jest.fn().mockResolvedValue([staleJob]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );
    await seedRegisteredJob(service, { chatId, jobId: staleJob.id, transition: 'open' });

    await service.reconcileChatSettings(chatId, {
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    });

    expect(staleJob.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
  });

  it('revalidates bulk settings rows under their locks before replacing jobs', async () => {
    const chatId = 'chat-stale-bulk-row';
    const staleSettings = {
      chatId,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    };
    const staleJob = {
      id: buildNightModeTransitionJobId(
        chatId,
        'close',
        '2026-05-31T20:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-31',
      ),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([staleSettings]),
      },
      chat: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: chatId,
            entityType: ChatEntityType.CHAT,
            botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
          },
        ]),
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: { ...staleSettings, nightModeEnabled: false },
          botMemberships: [],
        }),
      },
    };
    const queue = {
      getJob: jest.fn(async (jobId: string) => (jobId === staleJob.id ? staleJob : null)),
      getJobs: jest.fn().mockResolvedValue([staleJob]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );
    await seedRegisteredJob(service, { chatId, jobId: staleJob.id });

    await service.reconcileChats([chatId]);

    expect(staleJob.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
  });

  it('continues reconciling more than one former lock batch after a chat failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T10:12:00.000Z'));
    try {
      const chatIds = Array.from({ length: 12 }, (_, index) => `chat-batch-${index + 1}`);
      const prisma = {
        chat: {
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
            entityType: ChatEntityType.CHAT,
            settings: {
              chatId: where.id,
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
            },
            botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
          })),
        },
      };
      const queue = {
        getJobs: jest.fn(),
        getJob: jest.fn().mockResolvedValue(null),
        add: jest
          .fn()
          .mockRejectedValueOnce(new Error('first chat queue failure'))
          .mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.reconcileChats(chatIds);

      expect(queue.getJobs).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(23);
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(23);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bootstraps only future jobs when the current night session already started', async () => {
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

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId: 'chat-1',
          transition: 'open',
          scheduledFor: '2026-05-31T05:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
          transitionRuntimeVersion: 4,
        }),
        expect.any(Object),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        2,
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

  it('reconstructs a current boundary at startup only from a durable v4 intent', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const chatId = 'chat-startup-v4-current';
      const settings = {
        chatId,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const scheduledFor = '2026-05-30T20:00:00.000Z';
      const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, CLOSE_SESSION_A);
      const prisma = {
        chatSettings: { findMany: jest.fn().mockResolvedValue([settings]) },
        maxActionLedgerEntry: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };
      const queue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );
      await seedRegisteredJob(service, {
        chatId,
        jobId,
        transition: 'close',
        sessionKey: CLOSE_SESSION_A,
        scheduledFor,
        runtimeVersion: 4,
      });

      await service.bootstrapEnabledChats();

      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId,
          transition: 'close',
          scheduledFor,
          transitionRuntimeVersion: 4,
        }),
        expect.objectContaining({ jobId }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not treat process startup before a boundary as proof without an exact ledger', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T19:55:00.000Z'));
    try {
      const chatId = 'chat-enabled-after-boundary';
      const settings = {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const ledgerLookup = jest.fn();
      const queue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        {
          maxActionLedgerEntry: { findUnique: ledgerLookup },
        } as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );
      jest.setSystemTime(new Date('2026-05-30T20:12:00.000Z'));

      await expect(
        (
          service as unknown as {
            enqueueChatSettingsOccurrences(
              targetChatId: string,
              targetSettings: typeof settings,
              options: { includeCurrentClose: boolean; includeFuture: boolean },
            ): Promise<{ manualReview: unknown }>;
          }
        ).enqueueChatSettingsOccurrences(chatId, settings, {
          includeCurrentClose: true,
          includeFuture: false,
        }),
      ).resolves.toEqual(expect.objectContaining({ manualReview: null }));

      expect(queue.getJob).toHaveBeenCalledTimes(1);
      expect(ledgerLookup).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            jobId: `night-mode:close:${chatId}:session:${CLOSE_SESSION_A}`,
          },
        }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('bootstraps only future jobs when the current night session already ended', async () => {
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

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId: 'chat-1',
          transition: 'close',
          scheduledFor: '2026-05-31T20:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        }),
        expect.any(Object),
      );
      expect(queue.add).toHaveBeenNthCalledWith(
        2,
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

  it('does not synthesize a missing current job during explicit reconciliation', async () => {
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

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).not.toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({ scheduledFor: '2026-05-31T05:00:00.000Z' }),
        expect.any(Object),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('retires a legacy pre-start current job without re-enqueueing it during bootstrap', async () => {
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
        getJob: jest.fn(async (requestedJobId: string) =>
          requestedJobId === jobId ? failedJob : null,
        ),
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

  it('does not re-add a legacy current open job after a removal failure', async () => {
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

      await (
        service as unknown as {
          enqueueChatSettingsOccurrences(
            chatId: string,
            settings: {
              nightModeEnabled: boolean;
              nightModeStartTimeMinutes: number;
              nightModeEndTimeMinutes: number;
              nightModeTimezone: string;
            },
            options: { includeCurrentOpen: boolean; includeFuture: boolean },
          ): Promise<unknown>;
        }
      ).enqueueChatSettingsOccurrences(
        'chat-1',
        {
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
        },
        { includeCurrentOpen: true, includeFuture: false },
      );

      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.any(Object),
        expect.objectContaining({ jobId }),
      );
      expect(queue.add).not.toHaveBeenCalled();
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

      await (
        service as unknown as {
          enqueueChatSettingsOccurrences(
            chatId: string,
            settings: {
              nightModeEnabled: boolean;
              nightModeStartTimeMinutes: number;
              nightModeEndTimeMinutes: number;
              nightModeTimezone: string;
            },
            options: { includeCurrentOpen: boolean; includeFuture: boolean },
          ): Promise<unknown>;
        }
      ).enqueueChatSettingsOccurrences(
        'chat-1',
        {
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
        },
        { includeCurrentOpen: true, includeFuture: false },
      );

      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retires a pre-v4 current job after the exact legacy pre-dispatch no-route failure', async () => {
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

      await (
        service as unknown as {
          enqueueChatSettingsOccurrences(
            chatId: string,
            settings: {
              nightModeEnabled: boolean;
              nightModeStartTimeMinutes: number;
              nightModeEndTimeMinutes: number;
              nightModeTimezone: string;
            },
            options: { includeCurrentOpen: boolean; includeFuture: boolean },
          ): Promise<unknown>;
        }
      ).enqueueChatSettingsOccurrences(
        'chat-1',
        {
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
        },
        { includeCurrentOpen: true, includeFuture: false },
      );

      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retires a pre-v4 current close job after an exact pre-dispatch route quarantine', async () => {
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

      await (
        service as unknown as {
          enqueueChatSettingsOccurrences(
            chatId: string,
            settings: {
              nightModeEnabled: boolean;
              nightModeStartTimeMinutes: number;
              nightModeEndTimeMinutes: number;
              nightModeTimezone: string;
            },
            options: { includeCurrentClose: boolean; includeFuture: boolean },
          ): Promise<unknown>;
        }
      ).enqueueChatSettingsOccurrences(
        'chat-1',
        {
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
        },
        { includeCurrentClose: true, includeFuture: false },
      );

      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalled();
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

  it('clears jobs when a disable commits during enqueue-next scheduling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const chatId = 'chat-enqueue-next-disable-race';
      const enabledSettings = {
        chatId,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const enabledSnapshot = {
        entityType: ChatEntityType.CHAT,
        settings: enabledSettings,
        botMemberships: [
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          },
        ],
      };
      const disabledSnapshot = {
        entityType: ChatEntityType.CHAT,
        settings: { ...enabledSettings, nightModeEnabled: false },
        botMemberships: enabledSnapshot.botMemberships,
      };
      const prisma = {
        chat: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(enabledSnapshot)
            .mockResolvedValue(disabledSnapshot),
        },
      };
      const storedJobs = new Map<
        string,
        { id: string; data: NightModeTransitionJob; remove: jest.Mock }
      >();
      const queue = {
        getJob: jest.fn(async (jobId: string) => storedJobs.get(jobId) ?? null),
        getJobs: jest.fn(async () => Array.from(storedJobs.values())),
        add: jest
          .fn()
          .mockImplementation(
            async (_name: string, data: NightModeTransitionJob, options: { jobId: string }) => {
              const job = {
                id: options.jobId,
                data,
                remove: jest.fn(async () => {
                  storedJobs.delete(options.jobId);
                }),
              };
              storedJobs.set(options.jobId, job);
              return job;
            },
          ),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.enqueueNextTransitionsForChat(chatId);

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.getJobs).not.toHaveBeenCalled();
      expect(storedJobs.size).toBe(0);
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(3);
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
        getJob: jest.fn(async (jobId: string) => (jobId === staleJob.id ? staleJob : null)),
        getJobs: jest.fn().mockResolvedValueOnce([staleJob]).mockResolvedValue([]),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );
      await seedRegisteredJob(service, { chatId: 'chat-1', jobId: staleJob.id });

      await expect(service.reconcileChat('chat-1')).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 2,
      });

      expect(staleJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.getJobs).not.toHaveBeenCalled();
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

      expect(queue.getJobs).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('durably repairs missing access-schedule jobs without clearing the eligible queue', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const settings = {
        chatId: 'chat-recovered',
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
                status: ChatBotMembershipStatus.ACTIVE,
                botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
              },
            ],
          }),
        },
      };
      const storedJobs = new Map<string, { id: string; getState: jest.Mock }>();
      const queue = {
        getJob: jest.fn(async (jobId: string) => storedJobs.get(jobId) ?? null),
        getJobs: jest.fn(),
        add: jest
          .fn()
          .mockImplementation(
            async (_name: string, _data: NightModeTransitionJob, options: { jobId: string }) => {
              const job = {
                id: options.jobId,
                getState: jest.fn().mockResolvedValue('waiting'),
              };
              storedJobs.set(options.jobId, job);
              return job;
            },
          ),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await expect(service.repairAccessSchedule('chat-recovered')).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });

      expect(queue.getJobs).not.toHaveBeenCalled();
      expect(queue.getJob).toHaveBeenCalledTimes(7);
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({ chatId: 'chat-recovered', transition: 'close' }),
        expect.any(Object),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears a zero-membership schedule and restores it after active membership recovery', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T10:12:00.000Z'));
    try {
      const chatId = 'chat-late-membership-recovery';
      const settings = {
        chatId,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const staleJobId = buildNightModeTransitionJobId(
        chatId,
        'close',
        '2026-05-31T20:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-31',
      );
      let memberships: Array<typeof ACTIVE_TRANSITION_MEMBERSHIP> = [];
      const storedJobs = new Map<
        string,
        {
          id: string;
          data?: NightModeTransitionJob;
          getState: jest.Mock;
          remove: jest.Mock;
        }
      >();
      const staleJob = {
        id: staleJobId,
        getState: jest.fn().mockResolvedValue('delayed'),
        remove: jest.fn(async () => {
          storedJobs.delete(staleJobId);
        }),
      };
      storedJobs.set(staleJobId, staleJob);
      const prisma = {
        chat: {
          findUnique: jest.fn().mockImplementation(async () => ({
            entityType: ChatEntityType.CHAT,
            settings,
            botMemberships: memberships,
          })),
        },
      };
      const queue = {
        getJob: jest.fn(async (jobId: string) => storedJobs.get(jobId) ?? null),
        getJobs: jest.fn(),
        add: jest.fn(
          async (_name: string, data: NightModeTransitionJob, options: { jobId: string }) => {
            const existing = storedJobs.get(options.jobId);
            if (existing) {
              return existing;
            }
            const job = {
              id: options.jobId,
              data,
              getState: jest.fn().mockResolvedValue('waiting'),
              remove: jest.fn(async () => {
                storedJobs.delete(options.jobId);
              }),
            };
            storedJobs.set(options.jobId, job);
            return job;
          },
        ),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        { getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }]) } as never,
      );
      await seedRegisteredJob(service, {
        chatId,
        jobId: staleJobId,
        transition: 'close',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        scheduledFor: '2026-05-31T20:00:00.000Z',
      });

      await expect(service.repairAccessSchedule(chatId)).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: false,
        passes: 1,
      });
      expect(staleJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalled();
      expect(storedJobs.size).toBe(0);

      memberships = [ACTIVE_TRANSITION_MEMBERSHIP];
      await expect(service.repairAccessSchedule(chatId)).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({ chatId, transition: 'close' }),
        expect.any(Object),
      );
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({ chatId, transition: 'open' }),
        expect.any(Object),
      );
      expect(storedJobs.size).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers an exact failed v4 open after definitive non-delivery and fresh access', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const chatId = 'chat-ledger-recovery';
      const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
      const currentJobId = buildNightModeTransitionJobId(
        chatId,
        'open',
        '2026-05-31T05:00:00.000Z',
        sessionKey,
      );
      const failedJob = {
        id: currentJobId,
        failedReason:
          `MAX SEND_MESSAGE ledger entry night-mode:open:${chatId}:session:${sessionKey} ` +
          'is no longer executable (FAILED_TERMINAL)',
        data: { transitionRuntimeVersion: 4 },
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn(),
        retry: jest.fn().mockResolvedValue(undefined),
      };
      const storedJobs = new Map<string, unknown>();
      const settings = {
        chatId,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      for (const occurrence of [
        {
          transition: 'close' as const,
          scheduledFor: '2026-05-31T20:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        },
        {
          transition: 'open' as const,
          scheduledFor: '2026-06-01T05:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        },
      ]) {
        storedJobs.set(
          buildNightModeTransitionJobId(
            chatId,
            occurrence.transition,
            occurrence.scheduledFor,
            occurrence.sessionKey,
          ),
          { id: occurrence.scheduledFor },
        );
      }
      storedJobs.set(currentJobId, failedJob);
      const tx = {
        chatBotMembership: {
          findFirst: jest.fn().mockResolvedValue({ id: 'membership-1' }),
        },
        maxActionLedgerEntry: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: ChatEntityType.CHAT,
            settings,
            botMemberships: [
              {
                botId: 'bot-1',
                status: ChatBotMembershipStatus.ACTIVE,
                botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
                botAccessCheckedAt: new Date('2026-05-31T06:10:00.000Z'),
                botAccessExpiresAt: new Date('2026-05-31T06:25:00.000Z'),
              },
            ],
          }),
        },
        $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx),
        ),
      };
      const queue = {
        getJob: jest.fn(async (jobId: string) => storedJobs.get(jobId) ?? null),
        getJobs: jest.fn(),
        add: jest
          .fn()
          .mockImplementation(
            async (_name: string, data: NightModeTransitionJob, options: { jobId: string }) => {
              const job = {
                id: options.jobId,
                data,
                getState: jest.fn().mockResolvedValue('waiting'),
              };
              storedJobs.set(options.jobId, job);
              return job;
            },
          ),
      };
      const redisCounter = {
        getString: jest.fn().mockResolvedValue(JSON.stringify({ status: 'closed', sessionKey })),
      };
      const maxBotRegistry = {
        getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }]),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        maxBotRegistry as never,
        redisCounter as never,
      );

      await expect(service.repairAccessSchedule(chatId)).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(failedJob.retry).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({ chatId, transition: 'open', sessionKey }),
        expect.objectContaining({ jobId: currentJobId }),
      );
      expect(storedJobs.get(currentJobId)).toEqual(expect.objectContaining({ id: currentJobId }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps durable repair pending when the terminal open ledger CAS is unsafe', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const chatId = 'chat-ledger-blocked';
      const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
      const currentJobId = buildNightModeTransitionJobId(
        chatId,
        'open',
        '2026-05-31T05:00:00.000Z',
        sessionKey,
      );
      const failedJob = {
        id: currentJobId,
        failedReason:
          `MAX SEND_MESSAGE ledger entry night-mode:open:${chatId}:session:${sessionKey} ` +
          'is no longer executable (FAILED_TERMINAL)',
        data: { transitionRuntimeVersion: 4 },
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn(),
      };
      const tx = {
        chatBotMembership: {
          findFirst: jest.fn().mockResolvedValue({ id: 'membership-1' }),
        },
        maxActionLedgerEntry: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: ChatEntityType.CHAT,
            settings: {
              chatId,
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
            },
            botMemberships: [
              {
                botId: 'bot-1',
                status: ChatBotMembershipStatus.ACTIVE,
                botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
              },
            ],
          }),
        },
        $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx),
        ),
      };
      const storedFutureJobIds = new Set<string>();
      const queue = {
        getJob: jest.fn(async (jobId: string) =>
          jobId === currentJobId ? failedJob : storedFutureJobIds.has(jobId) ? { id: jobId } : null,
        ),
        getJobs: jest.fn(),
        add: jest.fn(async (_name: string, _data: unknown, options: { jobId: string }) => {
          storedFutureJobIds.add(options.jobId);
        }),
      };
      const redisCounter = {
        getString: jest.fn().mockResolvedValue(JSON.stringify({ status: 'closed', sessionKey })),
      };
      const maxBotRegistry = {
        getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }]),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        maxBotRegistry as never,
        redisCounter as never,
      );

      await expect(service.repairAccessSchedule(chatId)).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
        manualReview: expect.objectContaining({
          category: 'unsafe_prior_provenance',
          reason: `Night mode catch-up cannot safely recover terminal ledger state (night-mode:open:${chatId}:session:${sessionKey})`,
          sessionKey,
        }),
      });
      expect(failedJob.remove).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({ chatId, transition: 'close' }),
        expect.any(Object),
      );
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('serializes durable observation against a concurrent destructive reconciliation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const chatId = 'chat-queue-mutation-race';
      const currentSessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
      const settings = {
        chatId,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const snapshot = {
        entityType: ChatEntityType.CHAT,
        settings,
        botMemberships: [
          {
            botId: 'bot-1',
            status: ChatBotMembershipStatus.ACTIVE,
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          },
        ],
      };
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue(snapshot),
        },
      };
      const storedJobs = new Map<
        string,
        { id: string; data?: NightModeTransitionJob; remove: jest.Mock }
      >();
      for (const occurrence of [
        {
          transition: 'open' as const,
          scheduledFor: '2026-05-31T05:00:00.000Z',
          sessionKey: currentSessionKey,
        },
        {
          transition: 'close' as const,
          scheduledFor: '2026-05-31T20:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        },
      ]) {
        const jobId = buildNightModeTransitionJobId(
          chatId,
          occurrence.transition,
          occurrence.scheduledFor,
          occurrence.sessionKey,
        );
        storedJobs.set(jobId, {
          id: jobId,
          remove: jest.fn(async () => {
            storedJobs.delete(jobId);
          }),
        });
      }
      let releaseFirstRead: () => void = () => undefined;
      const firstReadGate = new Promise<void>((resolve) => {
        releaseFirstRead = resolve;
      });
      let markFirstReadStarted: () => void = () => undefined;
      const firstReadStarted = new Promise<void>((resolve) => {
        markFirstReadStarted = resolve;
      });
      let firstRead = true;
      const queue = {
        getJob: jest.fn(async (jobId: string) => {
          if (firstRead) {
            firstRead = false;
            markFirstReadStarted();
            await firstReadGate;
          }
          return storedJobs.get(jobId) ?? null;
        }),
        getJobs: jest.fn(async () => Array.from(storedJobs.values())),
        add: jest
          .fn()
          .mockImplementation(
            async (_name: string, data: NightModeTransitionJob, options: { jobId: string }) => {
              const job = {
                id: options.jobId,
                data,
                remove: jest.fn(async () => {
                  storedJobs.delete(options.jobId);
                }),
              };
              storedJobs.set(options.jobId, job);
              return job;
            },
          ),
      };
      const redisCounter = {
        getString: jest
          .fn()
          .mockResolvedValue(JSON.stringify({ status: 'closed', sessionKey: currentSessionKey })),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        redisCounter as never,
      );

      const repair = service.repairAccessSchedule(chatId);
      await firstReadStarted;
      const destructive = service.reconcileChat(chatId);
      await Promise.resolve();
      expect(queue.getJobs).not.toHaveBeenCalled();

      releaseFirstRead();
      await expect(repair).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });
      await expect(destructive).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });

      expect(queue.getJobs).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(storedJobs.size).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('confirms Redis lock ownership before reporting a short queue mutation successful', async () => {
    const queue = {
      getJobs: jest.fn().mockResolvedValue([]),
    };
    const redisCounter = {
      acquireLock: jest.fn().mockResolvedValue('lock-token'),
      renewLock: jest.fn().mockResolvedValue(false),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      {} as never,
      queue as unknown as Queue<NightModeTransitionJob>,
      undefined,
      undefined,
      redisCounter as never,
    );

    await expect(service.clearChatJobs('chat-short-lock')).rejects.toThrow(
      'Night mode queue mutation lock was lost (chat-short-lock)',
    );

    expect(queue.getJobs).not.toHaveBeenCalled();
    expect(redisCounter.renewLock).toHaveBeenCalledWith(
      'night-mode-transition-queue-mutation:v1:chat-short-lock',
      'lock-token',
      120_000,
    );
    expect(redisCounter.releaseLock).toHaveBeenCalledWith(
      'night-mode-transition-queue-mutation:v1:chat-short-lock',
      'lock-token',
    );
  });

  it('serializes separate scheduler processes with the shared Redis lock', async () => {
    jest.useFakeTimers();
    try {
      let heldToken: string | null = null;
      const redisCounter = {
        acquireLock: jest.fn(async () => {
          if (heldToken) {
            return null;
          }
          heldToken = 'process-one-token';
          return heldToken;
        }),
        renewLock: jest.fn(async (_key: string, token: string) => token === heldToken),
        releaseLock: jest.fn(async (_key: string, token: string) => {
          if (heldToken === token) {
            heldToken = null;
          }
        }),
      };
      let releaseFirstQueueRead: () => void = () => undefined;
      const firstQueueReadGate = new Promise<void>((resolve) => {
        releaseFirstQueueRead = resolve;
      });
      let markFirstQueueRead: () => void = () => undefined;
      const firstQueueReadStarted = new Promise<void>((resolve) => {
        markFirstQueueRead = resolve;
      });
      const firstPrisma = {
        $queryRaw: jest.fn(async () => {
          markFirstQueueRead();
          await firstQueueReadGate;
          return [];
        }),
      };
      const secondPrisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
      const firstQueue = { getJobs: jest.fn() };
      const secondQueue = { getJobs: jest.fn() };
      const firstService = new NightModeTransitionSchedulerService(
        firstPrisma as never,
        firstQueue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        redisCounter as never,
      );
      const secondService = new NightModeTransitionSchedulerService(
        secondPrisma as never,
        secondQueue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        redisCounter as never,
      );

      const firstMutation = firstService.clearChatJobs('chat-cross-process');
      await firstQueueReadStarted;
      const secondMutation = secondService.clearChatJobs('chat-cross-process');
      const secondMutationExpectation = expect(secondMutation).rejects.toThrow(
        'Night mode queue mutation lock is busy (chat-cross-process)',
      );
      await jest.advanceTimersByTimeAsync(4_100);

      await secondMutationExpectation;
      expect(secondQueue.getJobs).not.toHaveBeenCalled();

      releaseFirstQueueRead();
      await firstMutation;
      expect(redisCounter.releaseLock).toHaveBeenCalledWith(
        'night-mode-transition-queue-mutation:v1:chat-cross-process',
        'process-one-token',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses bounded reads and no queue writes for an intact candidate refresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: ChatEntityType.CHAT,
            settings: {
              chatId: 'chat-intact',
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
            },
            botMemberships: [
              {
                botId: 'bot-1',
                status: ChatBotMembershipStatus.ACTIVE,
                botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
              },
            ],
          }),
        },
      };
      const queue = {
        getJob: jest.fn().mockResolvedValue({
          id: 'already-scheduled',
          remove: jest.fn().mockResolvedValue(undefined),
        }),
        getJobs: jest.fn(),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await expect(service.repairAccessSchedule('chat-intact')).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });

      expect(queue.getJob).toHaveBeenCalledTimes(4);
      expect(queue.getJobs).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps durable repair pending when an expected future job is failed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const chatId = 'chat-failed-future';
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: ChatEntityType.CHAT,
            settings: {
              chatId,
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
            },
            botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
          }),
        },
      };
      const failedFutureJob = {
        id: 'failed-future',
        getState: jest.fn().mockResolvedValue('failed'),
      };
      const queue = {
        getJob: jest.fn().mockResolvedValue(failedFutureJob),
        getJobs: jest.fn(),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await expect(service.repairAccessSchedule(chatId)).rejects.toThrow(
        'future job is failed during durable repair',
      );

      expect(failedFutureJob.getState).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the durable request leased until an active catch-up finishes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const chatId = 'chat-active-catch-up';
      const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
      const currentJobId = buildNightModeTransitionJobId(
        chatId,
        'close',
        '2026-05-30T20:00:00.000Z',
        sessionKey,
      );
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: ChatEntityType.CHAT,
            settings: {
              chatId,
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
            },
            botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
          }),
        },
      };
      const activeJob = {
        id: currentJobId,
        data: { transitionRuntimeVersion: 4 },
        getState: jest.fn().mockResolvedValue('active'),
      };
      const queue = {
        getJob: jest.fn(async (jobId: string) =>
          jobId === currentJobId ? activeJob : { id: jobId },
        ),
        getJobs: jest.fn(),
        add: jest.fn().mockResolvedValue(activeJob),
      };
      const redisCounter = {
        getString: jest.fn().mockResolvedValue(JSON.stringify({ status: 'open', sessionKey })),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        redisCounter as never,
      );

      await expect(service.repairAccessSchedule(chatId)).rejects.toThrow(
        'catch-up is still active during durable repair',
      );

      expect(activeJob.getState).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('restores a missing current close once even when both future jobs survived access loss', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: ChatEntityType.CHAT,
            settings: {
              chatId: 'chat-current-recovery',
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
            },
            botMemberships: [
              {
                botId: 'bot-1',
                status: ChatBotMembershipStatus.ACTIVE,
                botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
              },
            ],
          }),
        },
      };
      const queue = {
        getJob: jest.fn().mockResolvedValue({
          id: 'already-scheduled',
          remove: jest.fn().mockResolvedValue(undefined),
        }),
        getJobs: jest.fn(),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const redisCounter = {
        getString: jest
          .fn()
          .mockResolvedValueOnce(JSON.stringify({ status: 'open', sessionKey }))
          .mockResolvedValueOnce(JSON.stringify({ status: 'closed', sessionKey })),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        redisCounter as never,
      );

      await expect(service.repairAccessSchedule('chat-current-recovery')).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });
      await expect(service.repairAccessSchedule('chat-current-recovery')).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });

      expect(redisCounter.getString).toHaveBeenCalledTimes(4);
      expect(redisCounter.getString).toHaveBeenCalledWith(
        'night-mode-transition-state:v1:chat-current-recovery',
      );
      expect(queue.getJobs).not.toHaveBeenCalled();
      expect(queue.getJob).toHaveBeenCalledTimes(10);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId: 'chat-current-recovery',
          transition: 'close',
          sessionKey,
        }),
        expect.any(Object),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('requires the matching current close while close-notice event recovery is pending', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
      const redisCounter = {
        getString: jest.fn().mockResolvedValue(
          JSON.stringify({
            status: 'closed',
            sessionKey,
            closeNoticeMessageId: 'close-notice-1',
            closeNoticeEventRecovery: { version: 1, pending: true },
          }),
        ),
      };
      const service = new NightModeTransitionSchedulerService(
        {} as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await expect(
        (
          service as unknown as {
            isCurrentCatchUpRequired(settings: {
              chatId: string;
              nightModeEnabled: boolean;
              nightModeStartTimeMinutes: number;
              nightModeEndTimeMinutes: number;
              nightModeTimezone: string;
            }): Promise<boolean | null>;
          }
        ).isCurrentCatchUpRequired({
          chatId: 'chat-close-event-recovery',
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
        }),
      ).resolves.toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('gates the exact current tombstone before Redis/Bull while future intent stays durable', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const chatId = 'chat-manual-tombstone';
      const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
      const settings = {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const fingerprint = buildNightModeTransitionScheduleFingerprint(settings);
      const currentJobId = buildNightModeTransitionJobId(
        chatId,
        'close',
        '2026-05-30T20:00:00.000Z',
        sessionKey,
      );
      const prisma = {
        nightModeTransitionReconcileRequest: {
          findUnique: jest.fn().mockResolvedValue({
            manualBlockedAt: new Date('2026-05-30T20:30:00.000Z'),
            manualBlockedReason: 'operator review required',
            manualBlockedCategory: 'unsafe_prior_dispatch',
            manualBlockedJobId: currentJobId,
            manualBlockedLedgerJobId: null,
            manualBlockedSessionKey: sessionKey,
            manualBlockedFingerprint: fingerprint,
          }),
        },
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const queueError = new Error('queue unavailable after future SQL intent');
      const queue = {
        getJob: jest.fn((requestedJobId: string) => {
          if (requestedJobId === currentJobId) {
            throw new Error('Bull must not be read for an exact tombstone');
          }
          return null;
        }),
        add: jest.fn().mockRejectedValue(queueError),
      };
      const redisCounter = {
        getString: jest.fn(() => {
          throw new Error('Redis must not be read for an exact tombstone');
        }),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        redisCounter as never,
      );

      await expect(
        (
          service as unknown as {
            enqueueChatSettingsOccurrences(
              targetChatId: string,
              targetSettings: typeof settings,
              options: { includeCurrentClose: boolean; includeFuture: boolean },
            ): Promise<unknown>;
          }
        ).enqueueChatSettingsOccurrences(chatId, settings, {
          includeCurrentClose: true,
          includeFuture: true,
        }),
      ).rejects.toBe(queueError);

      expect(queue.getJob).not.toHaveBeenCalledWith(currentJobId);
      expect(redisCounter.getString).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({ chatId, transition: 'open' }),
        expect.not.objectContaining({ jobId: currentJobId }),
      );
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const intentSql = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
      expect(intentSql).toContain('"generation" + 1');
      expect(intentSql).not.toContain('"manual_blocked_reason" =');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps an acknowledged exact occurrence retired across restarts while scheduling future work', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const chatId = 'chat-acknowledged-tombstone';
      const sessionKey = CLOSE_SESSION_A;
      const settings = {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const fingerprint = buildNightModeTransitionScheduleFingerprint(settings);
      const currentJobId = buildNightModeTransitionJobId(
        chatId,
        'close',
        '2026-05-30T20:00:00.000Z',
        sessionKey,
      );
      const acknowledgedRow = {
        manualBlockedAt: new Date('2026-05-30T20:30:00.000Z'),
        manualBlockedReason: 'operator accepted the exact unsafe occurrence',
        manualBlockedCategory: 'unsafe_prior_dispatch',
        manualBlockedJobId: currentJobId,
        manualBlockedLedgerJobId: null,
        manualBlockedSessionKey: sessionKey,
        manualBlockedFingerprint: fingerprint,
        manualAcknowledgedAt: new Date('2026-05-30T20:35:00.000Z'),
      };

      for (const existingBullJob of [null, { id: currentJobId, getState: jest.fn() }]) {
        const queue = {
          getJob: jest.fn().mockResolvedValue(existingBullJob),
          add: jest.fn().mockResolvedValue(undefined),
        };
        const redisCounter = {
          getString: jest.fn(() => {
            throw new Error('acknowledged occurrence must not consult mutable Redis state');
          }),
        };
        const service = new NightModeTransitionSchedulerService(
          {
            nightModeTransitionReconcileRequest: {
              findUnique: jest.fn().mockResolvedValue(acknowledgedRow),
            },
          } as never,
          queue as unknown as Queue<NightModeTransitionJob>,
          undefined,
          undefined,
          redisCounter as never,
        );

        await expect(
          (
            service as unknown as {
              enqueueChatSettingsOccurrences(
                targetChatId: string,
                targetSettings: typeof settings,
                options: { includeCurrentClose: boolean; includeFuture: boolean },
              ): Promise<unknown>;
            }
          ).enqueueChatSettingsOccurrences(chatId, settings, {
            includeCurrentClose: true,
            includeFuture: true,
          }),
        ).resolves.toEqual(expect.objectContaining({ manualReview: null }));

        expect(queue.getJob).toHaveBeenCalledTimes(3);
        expect(queue.getJob).toHaveBeenCalledWith(currentJobId);
        expect(redisCounter.getString).not.toHaveBeenCalled();
        expect(queue.add).toHaveBeenCalledTimes(2);
        expect(queue.add).not.toHaveBeenCalledWith(
          NIGHT_MODE_TRANSITION_JOB_NAME,
          expect.objectContaining({ sessionKey, transition: 'close' }),
          expect.objectContaining({ jobId: currentJobId }),
        );
        expect(queue.add).toHaveBeenCalledWith(
          NIGHT_MODE_TRANSITION_JOB_NAME,
          expect.objectContaining({
            transition: 'open',
            sessionKey,
          }),
          expect.any(Object),
        );
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('reopens an acknowledged occurrence when its unsafe category changes', async () => {
    const chatId = 'chat-ack-category-change';
    const sessionKey = CLOSE_SESSION_A;
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const jobId = buildNightModeTransitionJobId(
      chatId,
      'open',
      '2026-05-31T05:00:00.000Z',
      sessionKey,
    );
    const failedJob = {
      id: jobId,
      data: { transitionRuntimeVersion: 4 },
      failedReason: 'Ambiguous MAX SEND_MESSAGE transport outcome',
      getState: jest.fn().mockResolvedValue('failed'),
      remove: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      {
        nightModeTransitionReconcileRequest: {
          findUnique: jest.fn().mockResolvedValue({
            manualBlockedAt: new Date('2026-05-31T05:05:00.000Z'),
            manualBlockedReason: 'previously no fresh access',
            manualBlockedCategory: 'no_fresh_access',
            manualBlockedJobId: jobId,
            manualBlockedLedgerJobId: `night-mode:open:${chatId}:session:${sessionKey}`,
            manualBlockedSessionKey: sessionKey,
            manualBlockedFingerprint: fingerprint,
            manualAcknowledgedAt: new Date('2026-05-31T05:10:00.000Z'),
          }),
        },
      } as never,
      { getJob: jest.fn().mockResolvedValue(failedJob) } as never,
    );

    await expect(
      (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'open';
            fingerprint: string;
          }): Promise<{ kind: string; manualReview?: { category: string } }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition: 'open',
        fingerprint,
      }),
    ).resolves.toEqual({
      kind: 'blocked',
      manualReview: expect.objectContaining({ category: 'unsafe_prior_dispatch' }),
    });
    expect(failedJob.remove).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'unacknowledged block', acknowledgedAt: null },
    {
      name: 'acknowledged block',
      acknowledgedAt: new Date('2026-05-31T05:10:00.000Z'),
    },
  ])('fences a legacy Bull job with an exact $name', async ({ acknowledgedAt }) => {
    const chatId = 'chat-legacy-manual-fence';
    const job: NightModeTransitionJob = {
      chatId,
      transition: 'open',
      scheduledFor: '2026-05-31T05:00:00.000Z',
      sessionKey: CLOSE_SESSION_A,
    };
    const jobId = buildNightModeTransitionJobId(
      chatId,
      job.transition,
      job.scheduledFor,
      job.sessionKey,
    );
    const fingerprint = buildNightModeTransitionScheduleFingerprint({
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    });
    const service = new NightModeTransitionSchedulerService({
      nightModeTransitionReconcileRequest: {
        findUnique: jest.fn().mockResolvedValue({
          manualBlockedAt: new Date('2026-05-31T05:05:00.000Z'),
          manualBlockedCategory: 'unsafe_prior_dispatch',
          manualBlockedJobId: jobId,
          manualBlockedSessionKey: job.sessionKey,
          manualBlockedFingerprint: fingerprint,
          manualAcknowledgedAt: acknowledgedAt,
        }),
      },
    } as never);

    await expect(service.isTransitionManuallyFenced(job, jobId)).resolves.toBe(true);
    await expect(
      service.isTransitionManuallyFenced(
        {
          ...job,
          scheduledFor: '2026-06-01T05:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        },
        buildNightModeTransitionJobId(
          chatId,
          'open',
          '2026-06-01T05:00:00.000Z',
          'v1:Europe/Moscow:23:00:08:00:2026-05-31',
        ),
      ),
    ).resolves.toBe(false);
  });

  it('uses exact job and session fencing for a malformed legacy envelope', async () => {
    const job: NightModeTransitionJob = {
      chatId: 'chat-malformed-legacy-fence',
      transition: 'open',
      scheduledFor: 'legacy-time',
      sessionKey: 'legacy-session',
    };
    const jobId = buildNightModeTransitionJobId(
      job.chatId,
      job.transition,
      job.scheduledFor,
      job.sessionKey,
    );
    const service = new NightModeTransitionSchedulerService({
      nightModeTransitionReconcileRequest: {
        findUnique: jest.fn().mockResolvedValue({
          manualBlockedAt: new Date('2026-05-31T05:05:00.000Z'),
          manualBlockedCategory: 'failed_job_unclassified',
          manualBlockedJobId: jobId,
          manualBlockedSessionKey: job.sessionKey,
          manualBlockedFingerprint: `sha256:${'f'.repeat(64)}`,
        }),
      },
    } as never);

    await expect(service.isTransitionManuallyFenced(job, jobId)).resolves.toBe(true);
  });

  it('deletes only the completed recovery registry identity when a newer recovery exists', async () => {
    const chatId = 'chat-recovery-aba';
    const olderRecovery = buildCloseRecoveryA(chatId);
    const newerRecovery = { ...olderRecovery, messageId: `${olderRecovery.messageId}-new` };
    const olderJobId = buildNightModeTransitionRecoveryJobId(chatId, olderRecovery);
    const newerJobId = buildNightModeTransitionRecoveryJobId(chatId, newerRecovery);
    const service = new NightModeTransitionSchedulerService({} as never);
    await seedRegisteredJob(service, {
      chatId,
      jobId: olderJobId,
      sessionKey: olderRecovery.sessionKey,
    });
    await seedRegisteredJob(service, {
      chatId,
      jobId: newerJobId,
      sessionKey: newerRecovery.sessionKey,
    });

    await service.completeScheduledJob(
      {
        chatId,
        transition: 'close',
        scheduledFor: '2026-05-30T20:00:00.000Z',
        sessionKey: olderRecovery.sessionKey,
        recoveryOnly: olderRecovery,
      },
      olderJobId,
    );

    const rows = await (
      service as unknown as {
        listScheduledJobRegistryRows(
          chatIds: readonly string[],
        ): Promise<Array<{ job_id: string }>>;
      }
    ).listScheduledJobRegistryRows([chatId]);
    expect(olderJobId).not.toBe(newerJobId);
    expect(rows).toEqual([expect.objectContaining({ job_id: newerJobId })]);
  });

  it('retries an exhausted generic open cleanup failure only with pristine ledger state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const chatId = 'chat-open-recovery-only';
      const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
      const settings = {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const fingerprint = buildNightModeTransitionScheduleFingerprint(settings);
      const failedJob = {
        id: buildNightModeTransitionJobId(chatId, 'open', '2026-05-31T05:00:00.000Z', sessionKey),
        data: { transitionRuntimeVersion: 4, scheduleFingerprint: fingerprint },
        attemptsMade: 4,
        failedReason: `${NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX}: db unavailable`,
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn().mockResolvedValue(undefined),
        retry: jest.fn().mockResolvedValue(undefined),
      };
      const closeLedgerJobId = `night-mode:close:${chatId}:session:${sessionKey}`;
      const prisma = {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: {
          findUnique: jest.fn(async ({ where }: { where: { jobId: string } }) =>
            where.jobId === closeLedgerJobId
              ? {
                  actionType: 'SEND_MESSAGE',
                  chatId,
                  sourceTag: 'night_mode_transition',
                  status: MaxActionLedgerStatus.SUCCEEDED,
                  ambiguous: false,
                  terminal: true,
                  completedAt: new Date('2026-05-30T20:00:01.000Z'),
                  dispatchBotId: 'bot-1',
                  remoteMessageId: 'close-message-1',
                }
              : null,
          ),
        },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const queue = {
        getJob: jest.fn().mockResolvedValue(failedJob),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const redisCounter = {
        getString: jest.fn().mockResolvedValue(
          JSON.stringify({
            status: 'closed',
            sessionKey,
            closeNoticeMessageId: 'close-message-1',
            closeNoticeBotId: 'bot-1',
            closeNoticeEventRecovery: {
              version: 2,
              pending: true,
              timezone: 'Europe/Moscow',
              startMinutes: 23 * 60,
              endMinutes: 8 * 60,
            },
          }),
        ),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        redisCounter as never,
      );

      await expect(
        (
          service as unknown as {
            enqueueChatSettingsOccurrences(
              targetChatId: string,
              targetSettings: typeof settings,
              options: { includeCurrentOpen: boolean; includeFuture: boolean },
            ): Promise<unknown>;
          }
        ).enqueueChatSettingsOccurrences(chatId, settings, {
          includeCurrentOpen: true,
          includeFuture: false,
        }),
      ).resolves.toEqual({ manualReview: null });

      expect(failedJob.attemptsMade).toBeGreaterThan(3);
      expect(failedJob.retry).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId,
          transition: 'open',
        }),
        expect.not.objectContaining({ recoveryOnly: expect.anything() }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    MaxActionLedgerStatus.ENQUEUED,
    MaxActionLedgerStatus.IN_PROGRESS,
    MaxActionLedgerStatus.FAILED_RETRYABLE,
  ])('retries post-execution cleanup with exact no-dispatch %s ledger state', async (status) => {
    const chatId = `chat-cleanup-${status.toLowerCase()}`;
    const sessionKey = CLOSE_SESSION_A;
    const jobId = buildNightModeTransitionJobId(
      chatId,
      'open',
      '2026-05-31T05:00:00.000Z',
      sessionKey,
    );
    const failedJob = {
      id: jobId,
      data: { transitionRuntimeVersion: 4 },
      attemptsMade: 5,
      failedReason: `${NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX}: db unavailable`,
      getState: jest.fn().mockResolvedValue('failed'),
      remove: jest.fn().mockResolvedValue(undefined),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: {
          findUnique: jest.fn().mockResolvedValue({
            actionType: 'SEND_MESSAGE',
            chatId,
            sourceTag: 'night_mode_transition',
            status,
            ambiguous: false,
            terminal: false,
            attemptCount: 2,
            completedAt: null,
            lastError: status === MaxActionLedgerStatus.FAILED_RETRYABLE ? 'db unavailable' : null,
            dispatchToken: null,
            dispatchStartedAt: null,
            dispatchBotId: null,
            remoteMessageId: null,
          }),
        },
      } as never,
      { getJob: jest.fn().mockResolvedValue(failedJob) } as never,
    );

    await expect(
      (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'open';
            fingerprint: string;
          }): Promise<{ kind: string }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition: 'open',
        fingerprint: `sha256:${'a'.repeat(64)}`,
      }),
    ).resolves.toEqual({ kind: 'enqueue' });
    expect(failedJob.attemptsMade).toBeGreaterThan(3);
    expect(failedJob.retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    MaxActionLedgerStatus.ENQUEUED,
    MaxActionLedgerStatus.IN_PROGRESS,
    MaxActionLedgerStatus.FAILED_RETRYABLE,
  ])('retries a versioned close after exact pre-dispatch %s ledger proof', async (status) => {
    const chatId = `chat-safe-close-${status.toLowerCase()}`;
    const sessionKey = CLOSE_SESSION_A;
    const jobId = buildNightModeTransitionJobId(
      chatId,
      'close',
      '2026-05-30T20:00:00.000Z',
      sessionKey,
    );
    const failedJob = {
      id: jobId,
      data: { transitionRuntimeVersion: 4 },
      failedReason: 'MAX API background rate limit exceeded before dispatch',
      getState: jest.fn().mockResolvedValue('failed'),
      remove: jest.fn().mockResolvedValue(undefined),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: {
          findUnique: jest.fn().mockResolvedValue({
            actionType: 'SEND_MESSAGE',
            chatId,
            sourceTag: 'night_mode_transition',
            status,
            ambiguous: false,
            terminal: false,
            dispatchToken: null,
            dispatchStartedAt: null,
            dispatchBotId: null,
            remoteMessageId: null,
          }),
        },
      } as never,
      { getJob: jest.fn().mockResolvedValue(failedJob) } as never,
    );

    await expect(
      (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'close';
            fingerprint: string;
          }): Promise<{ kind: string }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition: 'close',
        fingerprint: `sha256:${'a'.repeat(64)}`,
      }),
    ).resolves.toEqual({ kind: 'enqueue' });
    expect(failedJob.retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'exact Bull envelope',
      slug: 'exact',
      bullSessionKey: CLOSE_SESSION_A,
      bullFingerprint: `sha256:${'a'.repeat(64)}`,
      expectedKind: 'enqueue',
    },
    {
      name: 'mismatched Bull session',
      slug: 'session-mismatch',
      bullSessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-29',
      bullFingerprint: `sha256:${'a'.repeat(64)}`,
      expectedKind: 'blocked',
    },
    {
      name: 'mismatched Bull schedule fingerprint',
      slug: 'fingerprint-mismatch',
      bullSessionKey: CLOSE_SESSION_A,
      bullFingerprint: `sha256:${'b'.repeat(64)}`,
      expectedKind: 'blocked',
    },
  ])(
    'recovers a missing ledger only with an $name',
    async ({ slug, bullSessionKey, bullFingerprint, expectedKind }) => {
      const chatId = `chat-safe-missing-ledger-${slug}`;
      const sessionKey = CLOSE_SESSION_A;
      const scheduledFor = '2026-05-30T20:00:00.000Z';
      const fingerprint = `sha256:${'a'.repeat(64)}`;
      const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, sessionKey);
      const failedJob = {
        id: jobId,
        data: {
          chatId,
          transition: 'close' as const,
          scheduledFor,
          sessionKey: bullSessionKey,
          transitionRuntimeVersion: 4 as const,
          scheduleFingerprint: bullFingerprint,
        },
        failedReason: 'MAX API background rate limit exceeded before dispatch',
        getState: jest.fn().mockResolvedValue('failed'),
        retry: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        {
          nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
          maxActionLedgerEntry: { findUnique: jest.fn().mockResolvedValue(null) },
        } as never,
        { getJob: jest.fn().mockResolvedValue(failedJob) } as never,
      );
      await seedRegisteredJob(service, {
        chatId,
        jobId,
        transition: 'close',
        sessionKey,
        scheduledFor,
        runtimeVersion: 4,
      });

      const resolution = await (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'close';
            scheduledFor: string;
            fingerprint: string;
          }): Promise<{ kind: string; manualReview?: { category: string } }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition: 'close',
        scheduledFor,
        fingerprint,
      });

      expect(resolution).toEqual(
        expectedKind === 'enqueue'
          ? { kind: 'enqueue' }
          : {
              kind: 'blocked',
              manualReview: expect.objectContaining({ category: 'unsafe_prior_dispatch' }),
            },
      );
      expect(failedJob.retry).toHaveBeenCalledTimes(expectedKind === 'enqueue' ? 1 : 0);
    },
  );

  it.each([
    'Night mode close send ledger provenance is unsafe',
    'Exact completed night mode close send is not proven',
  ])('blocks an exact v4 job after deterministic close-ledger failure: %s', async (reason) => {
    const chatId = 'chat-unsafe-close-ledger-recovery';
    const sessionKey = CLOSE_SESSION_A;
    const scheduledFor = '2026-05-31T05:00:00.000Z';
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const jobId = buildNightModeTransitionJobId(
      chatId,
      'open',
      scheduledFor,
      sessionKey,
    );
    const closeLedgerJobId = `night-mode:close:${chatId}:session:${sessionKey}`;
    const failedJob = {
      id: jobId,
      data: {
        chatId,
        transition: 'open' as const,
        scheduledFor,
        sessionKey,
        transitionRuntimeVersion: 4 as const,
        scheduleFingerprint: fingerprint,
      },
      failedReason: `${reason} (${closeLedgerJobId})`,
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: { findUnique: jest.fn().mockResolvedValue(null) },
      } as never,
      { getJob: jest.fn().mockResolvedValue(failedJob) } as never,
    );
    await seedRegisteredJob(service, {
      chatId,
      jobId,
      transition: 'open',
      sessionKey,
      scheduledFor,
      runtimeVersion: 4,
    });

    await expect(
      (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'open';
            scheduledFor: string;
            fingerprint: string;
          }): Promise<{ kind: string; manualReview?: Record<string, unknown> }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition: 'open',
        scheduledFor,
        fingerprint,
      }),
    ).resolves.toEqual({
      kind: 'blocked',
      manualReview: expect.objectContaining({
        category: 'unsafe_prior_provenance',
        jobId,
        ledgerJobId: closeLedgerJobId,
        sessionKey,
        fingerprint,
      }),
    });
    expect(failedJob.retry).not.toHaveBeenCalled();
  });

  it('reloads a job that becomes failed before classifying its terminal reason', async () => {
    const chatId = 'chat-failed-state-race';
    const sessionKey = CLOSE_SESSION_A;
    const scheduledFor = '2026-05-31T05:00:00.000Z';
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const jobId = buildNightModeTransitionJobId(
      chatId,
      'open',
      scheduledFor,
      sessionKey,
    );
    const closeLedgerJobId = `night-mode:close:${chatId}:session:${sessionKey}`;
    const data = {
      chatId,
      transition: 'open' as const,
      scheduledFor,
      sessionKey,
      transitionRuntimeVersion: 4 as const,
      scheduleFingerprint: fingerprint,
    };
    const staleActiveSnapshot = {
      id: jobId,
      data,
      failedReason: undefined,
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const freshFailedJob = {
      id: jobId,
      data,
      failedReason: `Night mode close send ledger provenance is unsafe (${closeLedgerJobId})`,
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const queue = {
      getJob: jest
        .fn()
        .mockResolvedValueOnce(staleActiveSnapshot)
        .mockResolvedValueOnce(freshFailedJob),
    };
    const service = new NightModeTransitionSchedulerService(
      {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: { findUnique: jest.fn().mockResolvedValue(null) },
      } as never,
      queue as never,
    );
    await seedRegisteredJob(service, {
      chatId,
      jobId,
      transition: 'open',
      sessionKey,
      scheduledFor,
      runtimeVersion: 4,
    });

    await expect(
      (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'open';
            scheduledFor: string;
            fingerprint: string;
          }): Promise<{ kind: string; manualReview?: Record<string, unknown> }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition: 'open',
        scheduledFor,
        fingerprint,
      }),
    ).resolves.toEqual({
      kind: 'blocked',
      manualReview: expect.objectContaining({
        category: 'unsafe_prior_provenance',
        ledgerJobId: closeLedgerJobId,
      }),
    });
    expect(queue.getJob).toHaveBeenCalledTimes(2);
    expect(staleActiveSnapshot.getState).toHaveBeenCalledTimes(1);
    expect(freshFailedJob.getState).toHaveBeenCalledTimes(1);
    expect(staleActiveSnapshot.retry).not.toHaveBeenCalled();
    expect(freshFailedJob.retry).not.toHaveBeenCalled();
  });

  it('keeps a pre-v4 failed envelope blocked when only the registry has been promoted to v4', async () => {
    const chatId = 'chat-pre-v4-missing-ledger';
    const sessionKey = CLOSE_SESSION_A;
    const scheduledFor = '2026-05-30T20:00:00.000Z';
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, sessionKey);
    const failedJob = {
      id: jobId,
      data: {
        chatId,
        transition: 'close' as const,
        scheduledFor,
        sessionKey,
        transitionRuntimeVersion: 3 as 3 | 4,
        scheduleFingerprint: fingerprint,
      },
      failedReason: 'MAX API background rate limit exceeded before dispatch',
      getState: jest.fn().mockResolvedValue('failed'),
      updateData: jest.fn(async (data: NightModeTransitionJob) => {
        failedJob.data = data as typeof failedJob.data;
      }),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: { findUnique: jest.fn().mockResolvedValue(null) },
      } as never,
      { getJob: jest.fn().mockResolvedValue(failedJob) } as never,
    );
    await seedRegisteredJob(service, {
      chatId,
      jobId,
      transition: 'close',
      sessionKey,
      scheduledFor,
      runtimeVersion: 4,
    });

    await expect(
      (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'close';
            scheduledFor: string;
            fingerprint: string;
          }): Promise<{ kind: string; manualReview?: { category: string } }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition: 'close',
        scheduledFor,
        fingerprint,
      }),
    ).resolves.toEqual({
      kind: 'blocked',
      manualReview: expect.objectContaining({ category: 'unsafe_prior_dispatch' }),
    });
    expect(failedJob.updateData).toHaveBeenCalledTimes(1);
    expect(failedJob.retry).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'ambiguous',
      ledger: {
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        dispatchToken: 'dispatch-ambiguous',
        dispatchStartedAt: new Date('2026-05-30T20:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: null,
      },
    },
    {
      name: 'dispatch-started',
      ledger: {
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
        dispatchToken: 'dispatch-started',
        dispatchStartedAt: new Date('2026-05-30T20:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: null,
      },
    },
    {
      name: 'succeeded',
      ledger: {
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        dispatchToken: 'dispatch-succeeded',
        dispatchStartedAt: new Date('2026-05-30T20:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: 'message-1',
      },
    },
  ])('keeps a failed v4 boundary blocked with $name ledger provenance', async ({ ledger }) => {
    const chatId = `chat-unsafe-ledger-${ledger.status.toLowerCase()}`;
    const sessionKey = CLOSE_SESSION_A;
    const scheduledFor = '2026-05-30T20:00:00.000Z';
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, sessionKey);
    const failedJob = {
      id: jobId,
      data: { transitionRuntimeVersion: 4 },
      failedReason: 'MAX API background rate limit exceeded before dispatch',
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: {
          findUnique: jest.fn().mockResolvedValue({
            actionType: 'SEND_MESSAGE',
            chatId,
            sourceTag: 'night_mode_transition',
            ...ledger,
          }),
        },
      } as never,
      { getJob: jest.fn().mockResolvedValue(failedJob) } as never,
    );
    await seedRegisteredJob(service, {
      chatId,
      jobId,
      transition: 'close',
      sessionKey,
      scheduledFor,
      runtimeVersion: 4,
    });

    await expect(
      (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'close';
            scheduledFor: string;
            fingerprint: string;
          }): Promise<{ kind: string; manualReview?: { category: string } }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition: 'close',
        scheduledFor,
        fingerprint,
      }),
    ).resolves.toEqual({
      kind: 'blocked',
      manualReview: expect.objectContaining({ category: 'unsafe_prior_dispatch' }),
    });
    expect(failedJob.retry).not.toHaveBeenCalled();
  });

  it('retries a failed v4 boundary after exact pre-dispatch lock contention', async () => {
    const chatId = 'chat-lock-contention';
    const sessionKey = CLOSE_SESSION_A;
    const scheduledFor = '2026-05-30T20:00:00.000Z';
    const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, sessionKey);
    const failedJob = {
      id: jobId,
      data: { transitionRuntimeVersion: 4 },
      failedReason: `Night mode transition lock is busy (${chatId})`,
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: { findUnique: jest.fn().mockResolvedValue(null) },
      } as never,
      { getJob: jest.fn().mockResolvedValue(failedJob) } as never,
    );

    await expect(
      (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'close';
            scheduledFor: string;
            fingerprint: string;
          }): Promise<{ kind: string }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition: 'close',
        scheduledFor,
        fingerprint: SCHEDULE_FINGERPRINT,
      }),
    ).resolves.toEqual({ kind: 'enqueue' });

    expect(failedJob.retry).toHaveBeenCalledTimes(1);
  });

  it('persists v4 intent before promoting a future pre-v4 Bull job in place', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T19:55:00.000Z'));
    try {
      const chatId = 'chat-durable-first-promotion';
      const settings = {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const scheduledFor = '2026-05-30T20:00:00.000Z';
      const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, CLOSE_SESSION_A);
      const order: string[] = [];
      const existingJob = {
        id: jobId,
        data: {
          chatId,
          transition: 'close',
          scheduledFor,
          sessionKey: CLOSE_SESSION_A,
          transitionRuntimeVersion: 3,
        } as NightModeTransitionJob,
        getState: jest.fn().mockResolvedValue('delayed'),
        updateData: jest.fn(async (data: NightModeTransitionJob) => {
          order.push('bull-promote');
          existingJob.data = data;
        }),
        remove: jest.fn(),
      };
      const prisma = {
        $executeRaw: jest.fn(async () => {
          order.push('registry-v4');
          return 1;
        }),
      };
      const queue = {
        getJob: jest.fn(async (requestedJobId: string) =>
          requestedJobId === jobId ? existingJob : null,
        ),
        add: jest.fn(
          async (_name: string, _data: NightModeTransitionJob, options: { jobId: string }) => {
            if (options.jobId === jobId) {
              order.push('queue-add');
            }
          },
        ),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await (
        service as unknown as {
          enqueueChatSettingsOccurrences(
            targetChatId: string,
            targetSettings: typeof settings,
          ): Promise<unknown>;
        }
      ).enqueueChatSettingsOccurrences(chatId, settings);

      expect(order.slice(0, 3)).toEqual(['registry-v4', 'bull-promote', 'queue-add']);
      expect(existingJob.remove).not.toHaveBeenCalled();
      expect(existingJob.data).toEqual(
        expect.objectContaining({
          transitionRuntimeVersion: 4,
          scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(settings),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    { name: 'missing ledger', ledger: null },
    {
      name: 'safe pre-dispatch ledger',
      ledger: {
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-evicted-close-safe',
        sourceTag: 'night_mode_transition',
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
        attemptCount: 0,
        completedAt: null,
        lastError: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
    },
  ])('reconstructs an evicted v4 close job with $name', async ({ ledger }) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:12:00.000Z'));
    try {
      const chatId = 'chat-evicted-close-safe';
      const sessionKey = CLOSE_SESSION_A;
      const scheduledFor = '2026-05-30T20:00:00.000Z';
      const settings = {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, sessionKey);
      const prisma = {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: { findUnique: jest.fn().mockResolvedValue(ledger) },
      };
      const queue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );
      await seedRegisteredJob(service, {
        chatId,
        jobId,
        transition: 'close',
        sessionKey,
        scheduledFor,
        runtimeVersion: 4,
      });

      await expect(
        (
          service as unknown as {
            enqueueChatSettingsOccurrences(
              targetChatId: string,
              targetSettings: typeof settings,
              options: { includeCurrentClose: boolean; includeFuture: boolean },
            ): Promise<{ manualReview: unknown }>;
          }
        ).enqueueChatSettingsOccurrences(chatId, settings, {
          includeCurrentClose: true,
          includeFuture: false,
        }),
      ).resolves.toEqual(expect.objectContaining({ manualReview: null }));

      expect(queue.getJob).toHaveBeenCalledWith(jobId);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId,
          transition: 'close',
          sessionKey,
          transitionRuntimeVersion: 4,
        }),
        expect.objectContaining({ jobId }),
      );
      expect(queue.add).not.toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({ recoveryOnly: expect.anything() }),
        expect.any(Object),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('turns an evicted v4 close with exact completed proof into recovery-only work', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:12:00.000Z'));
    try {
      const chatId = 'chat-evicted-close-completed';
      const recovery = buildCloseRecoveryA(chatId);
      const scheduledFor = '2026-05-30T20:00:00.000Z';
      const jobId = buildNightModeTransitionJobId(
        chatId,
        'close',
        scheduledFor,
        recovery.sessionKey,
      );
      const recoveryJobId = buildNightModeTransitionRecoveryJobId(chatId, recovery);
      const completedLedger = {
        id: 'ledger-evicted-close-completed',
        jobId: `night-mode:close:${chatId}:session:${recovery.sessionKey}`,
        updatedAt: new Date('2026-05-30T20:00:01.000Z'),
        actionType: 'SEND_MESSAGE',
        chatId,
        sourceTag: 'night_mode_transition',
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        completedAt: new Date('2026-05-30T20:00:01.000Z'),
        dispatchToken: 'dispatch-evicted-close-completed',
        dispatchStartedAt: new Date('2026-05-30T20:00:00.000Z'),
        dispatchBotId: recovery.botId,
        remoteMessageId: recovery.messageId,
      };
      const prisma = {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: { findMany: jest.fn().mockResolvedValue([completedLedger]) },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const queue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        { getString: jest.fn().mockResolvedValue(null) } as never,
      );
      await seedRegisteredJob(service, {
        chatId,
        jobId,
        transition: 'close',
        sessionKey: recovery.sessionKey,
        scheduledFor,
        runtimeVersion: 4,
      });

      await expect(
        (
          service as unknown as {
            ensureCloseEventRecoveryJob(targetChatId: string): Promise<{
              jobId: string | null;
              manualReview: unknown;
              blocksCurrentCatchUp: boolean;
            }>;
          }
        ).ensureCloseEventRecoveryJob(chatId),
      ).resolves.toEqual({
        jobId: recoveryJobId,
        manualReview: null,
        blocksCurrentCatchUp: true,
      });

      expect(queue.getJob).toHaveBeenCalledWith(recoveryJobId);
      expect(queue.getJob).not.toHaveBeenCalledWith(jobId);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        NIGHT_MODE_TRANSITION_JOB_NAME,
        expect.objectContaining({
          chatId,
          transition: 'close',
          sessionKey: recovery.sessionKey,
          transitionRuntimeVersion: 4,
          recoveryOnly: recovery,
        }),
        expect.objectContaining({ jobId: recoveryJobId }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    {
      name: 'ambiguous dispatch',
      ledger: {
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        dispatchToken: 'dispatch-ambiguous',
        dispatchStartedAt: new Date('2026-05-30T20:00:00.000Z'),
        dispatchBotId: 'bot-a',
      },
    },
    {
      name: 'terminal post-dispatch failure',
      ledger: {
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        dispatchToken: 'dispatch-terminal',
        dispatchStartedAt: new Date('2026-05-30T20:00:00.000Z'),
        dispatchBotId: 'bot-a',
      },
    },
  ])('manually blocks an evicted v4 close with $name provenance', async ({ ledger }) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:12:00.000Z'));
    try {
      const chatId = 'chat-evicted-close-unsafe';
      const sessionKey = CLOSE_SESSION_A;
      const scheduledFor = '2026-05-30T20:00:00.000Z';
      const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, sessionKey);
      const unsafeLedger = {
        actionType: 'SEND_MESSAGE',
        chatId,
        sourceTag: 'night_mode_transition',
        completedAt: new Date('2026-05-30T20:00:01.000Z'),
        remoteMessageId: null,
        ...ledger,
      };
      const prisma = {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(unsafeLedger),
        },
      };
      const queue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        { getString: jest.fn().mockResolvedValue(null) } as never,
      );
      await seedRegisteredJob(service, {
        chatId,
        jobId,
        transition: 'close',
        sessionKey,
        scheduledFor,
        runtimeVersion: 4,
      });

      await expect(
        (
          service as unknown as {
            ensureCloseEventRecoveryJob(targetChatId: string): Promise<{
              jobId: string | null;
              manualReview: { category: string; jobId: string; sessionKey: string } | null;
              blocksCurrentCatchUp: boolean;
            }>;
          }
        ).ensureCloseEventRecoveryJob(chatId),
      ).resolves.toEqual({
        jobId: null,
        manualReview: expect.objectContaining({
          category: 'unsafe_prior_provenance',
          jobId,
          sessionKey,
        }),
        blocksCurrentCatchUp: true,
      });

      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('promotes and retries a pre-v4 boundary that was future at process startup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T19:55:00.000Z'));
    try {
      const chatId = 'chat-promote-future-v3';
      const sessionKey = CLOSE_SESSION_A;
      const scheduledFor = '2026-05-30T20:00:00.000Z';
      const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, sessionKey);
      const failedJob = {
        id: jobId,
        data: {
          chatId,
          transition: 'close',
          scheduledFor,
          sessionKey,
          transitionRuntimeVersion: 3,
        } as NightModeTransitionJob,
        failedReason: 'MAX API background rate limit exceeded before dispatch',
        getState: jest.fn().mockResolvedValue('failed'),
        updateData: jest.fn(async (data: NightModeTransitionJob) => {
          failedJob.data = data;
        }),
        retry: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        {
          nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
          maxActionLedgerEntry: {
            findUnique: jest.fn().mockResolvedValue({
              actionType: 'SEND_MESSAGE',
              chatId,
              sourceTag: 'night_mode_transition',
              status: MaxActionLedgerStatus.FAILED_RETRYABLE,
              ambiguous: false,
              terminal: false,
              dispatchToken: null,
              dispatchStartedAt: null,
              dispatchBotId: null,
              remoteMessageId: null,
            }),
          },
        } as never,
        { getJob: jest.fn().mockResolvedValue(failedJob) } as never,
      );
      jest.setSystemTime(new Date('2026-05-30T20:12:00.000Z'));

      await expect(
        (
          service as unknown as {
            canEnqueueCurrentCatchUp(params: {
              chatId: string;
              jobId: string;
              sessionKey: string;
              transition: 'close';
              scheduledFor: string;
              fingerprint: string;
            }): Promise<{ kind: string }>;
          }
        ).canEnqueueCurrentCatchUp({
          chatId,
          jobId,
          sessionKey,
          transition: 'close',
          scheduledFor,
          fingerprint: `sha256:${'a'.repeat(64)}`,
        }),
      ).resolves.toEqual({ kind: 'enqueue' });

      expect(failedJob.updateData).toHaveBeenCalledWith(
        expect.objectContaining({
          transitionRuntimeVersion: 4,
          scheduleFingerprint: `sha256:${'a'.repeat(64)}`,
        }),
      );
      expect(failedJob.retry).toHaveBeenCalledTimes(1);
      expect(failedJob.remove).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('never resets an ordinary exhausted send failure without close recovery proof', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const chatId = 'chat-real-send-failure';
      const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
      const settings = {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const failedJob = {
        id: buildNightModeTransitionJobId(chatId, 'open', '2026-05-31T05:00:00.000Z', sessionKey),
        data: { transitionRuntimeVersion: 4 },
        attemptsMade: 4,
        failedReason: 'Ambiguous MAX SEND_MESSAGE transport outcome',
        getState: jest.fn().mockResolvedValue('failed'),
        remove: jest.fn(),
      };
      const prisma = {
        nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      const queue = {
        getJob: jest.fn().mockResolvedValue(failedJob),
        add: jest.fn(),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
        undefined,
        undefined,
        { getString: jest.fn().mockResolvedValue(null) } as never,
      );

      await expect(
        (
          service as unknown as {
            enqueueChatSettingsOccurrences(
              targetChatId: string,
              targetSettings: typeof settings,
              options: { includeCurrentOpen: boolean; includeFuture: boolean },
            ): Promise<{ manualReview: { category: string } | null }>;
          }
        ).enqueueChatSettingsOccurrences(chatId, settings, {
          includeCurrentOpen: true,
          includeFuture: false,
        }),
      ).resolves.toEqual({
        manualReview: expect.objectContaining({ category: 'unsafe_prior_dispatch' }),
      });
      expect(failedJob.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    {
      transition: 'close' as const,
      now: '2026-05-30T20:12:00.000Z',
      scheduledFor: '2026-05-30T20:00:00.000Z',
    },
    {
      transition: 'open' as const,
      now: '2026-05-31T06:12:00.000Z',
      scheduledFor: '2026-05-31T05:00:00.000Z',
    },
  ])(
    'reconstructs one deterministic $transition job after Bull and registry eviction',
    async ({ transition, now, scheduledFor }) => {
      jest.useFakeTimers().setSystemTime(new Date(now));
      try {
        const chatId = `chat-evicted-access-${transition}`;
        const sessionKey = CLOSE_SESSION_A;
        const jobId = buildNightModeTransitionJobId(chatId, transition, scheduledFor, sessionKey);
        const ledgerJobId = `night-mode:${transition}:${chatId}:session:${sessionKey}`;
        const ledger = {
          actionType: 'SEND_MESSAGE',
          chatId,
          sourceTag: 'night_mode_transition',
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          ambiguous: false,
          terminal: true,
          attemptCount: 1,
          completedAt: new Date(scheduledFor),
          lastError: 'chat denied',
          dispatchToken: null,
          dispatchStartedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
        };
        const tx = {
          chatBotMembership: {
            findFirst: jest.fn().mockResolvedValue({ id: 'membership-1' }),
          },
          maxActionLedgerEntry: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        const prisma = {
          nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
          maxActionLedgerEntry: {
            findUnique: jest.fn(async ({ where }: { where: { jobId: string } }) =>
              where.jobId === ledgerJobId ? ledger : null,
            ),
          },
          $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
            operation(tx),
          ),
        };
        const storedJobs = new Map<string, unknown>();
        let logicalJobCreations = 0;
        const queue = {
          getJob: jest.fn(async (requestedJobId: string) => storedJobs.get(requestedJobId) ?? null),
          add: jest.fn(
            async (_name: string, data: NightModeTransitionJob, options: { jobId: string }) => {
              const retained = storedJobs.get(options.jobId);
              if (retained) {
                return retained;
              }
              logicalJobCreations += 1;
              const job = {
                id: options.jobId,
                data,
                getState: jest.fn().mockResolvedValue('waiting'),
              };
              storedJobs.set(options.jobId, job);
              return job;
            },
          ),
        };
        const service = new NightModeTransitionSchedulerService(
          prisma as never,
          queue as unknown as Queue<NightModeTransitionJob>,
          undefined,
          { getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }]) } as never,
        );
        const settings = {
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
        };
        const enqueue = () =>
          (
            service as unknown as {
              enqueueChatSettingsOccurrences(
                targetChatId: string,
                targetSettings: typeof settings,
                options: {
                  includeCurrentClose?: boolean;
                  includeCurrentOpen?: boolean;
                  includeFuture: boolean;
                },
              ): Promise<{ manualReview: unknown }>;
            }
          ).enqueueChatSettingsOccurrences(chatId, settings, {
            ...(transition === 'close'
              ? { includeCurrentClose: true }
              : { includeCurrentOpen: true }),
            includeFuture: false,
          });

        await expect(enqueue()).resolves.toEqual({ manualReview: null });
        await expect(enqueue()).resolves.toEqual({ manualReview: null });

        expect(tx.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(1);
        expect(logicalJobCreations).toBe(1);
        expect(storedJobs.size).toBe(1);
        expect(storedJobs.has(jobId)).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([
    {
      name: 'missing ledger',
      transition: 'open' as const,
      ledger: null,
      expected: { kind: 'skip' },
    },
    {
      name: 'exact completed open send',
      transition: 'open' as const,
      ledger: {
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        attemptCount: 1,
        completedAt: new Date('2026-05-31T05:00:01.000Z'),
        lastError: null,
        dispatchToken: 'completed-token',
        dispatchStartedAt: new Date('2026-05-31T05:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: 'open-message-1',
      },
      expected: { kind: 'skip' },
    },
    {
      name: 'exact completed close send',
      transition: 'close' as const,
      ledger: {
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        attemptCount: 1,
        completedAt: new Date('2026-05-30T20:00:01.000Z'),
        lastError: null,
        dispatchToken: 'completed-close-token',
        dispatchStartedAt: new Date('2026-05-30T20:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: 'close-message-1',
      },
      expected: { kind: 'skip' },
    },
    {
      name: 'ambiguous ledger',
      transition: 'open' as const,
      ledger: {
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        attemptCount: 1,
        completedAt: new Date('2026-05-31T05:00:01.000Z'),
        lastError: 'timeout',
        dispatchToken: 'ambiguous-token',
        dispatchStartedAt: new Date('2026-05-31T05:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: null,
      },
      expected: { kind: 'blocked', category: 'unsafe_prior_provenance' },
    },
    {
      name: 'dispatch-started ledger',
      transition: 'open' as const,
      ledger: {
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
        attemptCount: 1,
        completedAt: null,
        lastError: null,
        dispatchToken: 'dispatch-token',
        dispatchStartedAt: new Date('2026-05-31T05:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: null,
      },
      expected: { kind: 'blocked', category: 'unsafe_prior_provenance' },
    },
  ])(
    'fails closed without Bull or registry for $name evidence',
    async ({ transition, ledger, expected }) => {
      const chatId = `chat-no-durable-job-proof-${transition}`;
      const sessionKey = CLOSE_SESSION_A;
      const scheduledFor =
        transition === 'open' ? '2026-05-31T05:00:00.000Z' : '2026-05-30T20:00:00.000Z';
      const jobId = buildNightModeTransitionJobId(chatId, transition, scheduledFor, sessionKey);
      const service = new NightModeTransitionSchedulerService(
        {
          nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
          maxActionLedgerEntry: {
            findUnique: jest.fn().mockResolvedValue(
              ledger
                ? {
                    actionType: 'SEND_MESSAGE',
                    chatId,
                    sourceTag: 'night_mode_transition',
                    ...ledger,
                  }
                : null,
            ),
          },
          $transaction: jest.fn(),
        } as never,
        { getJob: jest.fn().mockResolvedValue(null) } as never,
      );

      const resolution = await (
        service as unknown as {
          canEnqueueCurrentCatchUp(params: {
            chatId: string;
            jobId: string;
            sessionKey: string;
            transition: 'close' | 'open';
            scheduledFor: string;
            fingerprint: string;
          }): Promise<{ kind: string; manualReview?: { category: string } }>;
        }
      ).canEnqueueCurrentCatchUp({
        chatId,
        jobId,
        sessionKey,
        transition,
        scheduledFor,
        fingerprint: `sha256:${'a'.repeat(64)}`,
      });

      expect(resolution.kind).toBe(expected.kind);
      if ('category' in expected) {
        expect(resolution.manualReview?.category).toBe(expected.category);
      } else {
        expect(resolution).toEqual(expected);
      }
    },
  );

  it.each([
    {
      name: 'an exact completed send',
      ledger: {
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-missing-bull-open',
        sourceTag: 'night_mode_transition',
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        attemptCount: 1,
        completedAt: new Date('2026-05-31T05:00:01.000Z'),
        lastError: null,
        dispatchToken: 'completed-token',
        dispatchStartedAt: new Date('2026-05-31T05:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: 'open-message-1',
      },
      expectedKind: 'enqueue',
    },
    {
      name: 'an ordinary pre-dispatch ledger',
      ledger: {
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-missing-bull-open',
        sourceTag: 'night_mode_transition',
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
        attemptCount: 0,
        completedAt: null,
        lastError: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
      expectedKind: 'enqueue',
    },
    {
      name: 'ambiguous durable provenance',
      ledger: {
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-missing-bull-open',
        sourceTag: 'night_mode_transition',
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        attemptCount: 1,
        completedAt: new Date('2026-05-31T05:00:01.000Z'),
        lastError: 'timeout',
        dispatchToken: 'ambiguous-token',
        dispatchStartedAt: new Date('2026-05-31T05:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: null,
      },
      expectedKind: 'blocked',
    },
  ])('consults $name when the current Bull job was evicted', async ({ ledger, expectedKind }) => {
    const chatId = 'chat-missing-bull-open';
    const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
    const openLedgerJobId = `night-mode:open:${chatId}:session:${sessionKey}`;
    const prisma = {
      nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
      maxActionLedgerEntry: {
        findUnique: jest.fn(async ({ where }: { where: { jobId: string } }) =>
          where.jobId === openLedgerJobId ? ledger : null,
        ),
      },
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      { getJob: jest.fn().mockResolvedValue(null) } as never,
      undefined,
      undefined,
      { getString: jest.fn().mockResolvedValue(null) } as never,
    );
    await seedRegisteredJob(service, {
      chatId,
      jobId: 'evicted-open-job',
      transition: 'open',
      sessionKey,
      scheduledFor: '2026-05-31T05:00:00.000Z',
      runtimeVersion: 4,
    });

    const resolution = await (
      service as unknown as {
        canEnqueueCurrentCatchUp(params: {
          chatId: string;
          jobId: string;
          sessionKey: string;
          transition: 'open';
          fingerprint: string;
        }): Promise<{ kind: string; manualReview?: { category: string } }>;
      }
    ).canEnqueueCurrentCatchUp({
      chatId,
      jobId: 'evicted-open-job',
      sessionKey,
      transition: 'open',
      fingerprint: `sha256:${'a'.repeat(64)}`,
    });

    expect(resolution.kind).toBe(expectedKind);
    if (expectedKind === 'blocked') {
      expect(resolution.manualReview?.category).toBe('unsafe_prior_provenance');
    }
  });

  it('blocks an evicted definitive access rejection without fresh actionable access', async () => {
    const chatId = 'chat-evicted-no-access';
    const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
    const scheduledFor = '2026-05-31T05:00:00.000Z';
    const jobId = buildNightModeTransitionJobId(chatId, 'open', scheduledFor, sessionKey);
    const openLedgerJobId = `night-mode:open:${chatId}:session:${sessionKey}`;
    const prisma = {
      nightModeTransitionReconcileRequest: { findUnique: jest.fn().mockResolvedValue(null) },
      maxActionLedgerEntry: {
        findUnique: jest.fn(async ({ where }: { where: { jobId: string } }) =>
          where.jobId === openLedgerJobId
            ? {
                actionType: 'SEND_MESSAGE',
                chatId,
                sourceTag: 'night_mode_transition',
                status: MaxActionLedgerStatus.FAILED_TERMINAL,
                ambiguous: false,
                terminal: true,
                attemptCount: 1,
                completedAt: new Date(),
                lastError: 'access denied',
                lastStatusCode: 403,
                lastErrorCode: 'chat.denied',
                dispatchToken: null,
                dispatchStartedAt: null,
                dispatchBotId: null,
                remoteMessageId: null,
              }
            : null,
        ),
      },
      $transaction: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      { getJob: jest.fn().mockResolvedValue(null) } as never,
      undefined,
      undefined,
      { getString: jest.fn().mockResolvedValue(null) } as never,
    );

    const resolution = await (
      service as unknown as {
        canEnqueueCurrentCatchUp(params: {
          chatId: string;
          jobId: string;
          sessionKey: string;
          transition: 'open';
          scheduledFor: string;
          fingerprint: string;
        }): Promise<{ kind: string; manualReview?: { category: string } }>;
      }
    ).canEnqueueCurrentCatchUp({
      chatId,
      jobId,
      sessionKey,
      transition: 'open',
      scheduledFor,
      fingerprint: `sha256:${'a'.repeat(64)}`,
    });

    expect(resolution).toEqual({
      kind: 'blocked',
      manualReview: expect.objectContaining({ category: 'no_fresh_access' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preflights immutable close recovery independently of current Redis state', async () => {
    const chatId = 'chat-markerless-recovery';
    const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
    const settings = {
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    };
    const fingerprint = buildNightModeTransitionScheduleFingerprint(settings);
    const ledger = {
      actionType: 'SEND_MESSAGE',
      chatId,
      sourceTag: 'night_mode_transition',
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      completedAt: new Date('2026-05-30T20:00:01.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: 'close-message-1',
    };
    const prisma = {
      maxActionLedgerEntry: { findUnique: jest.fn().mockResolvedValue(ledger) },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const redisCounter = { getString: jest.fn().mockResolvedValue(null) };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );
    const job: NightModeTransitionJob = {
      chatId,
      transition: 'open',
      scheduledFor: '2026-05-31T05:00:00.000Z',
      sessionKey,
      retryPolicyName: 'night-mode-transition',
      transitionRuntimeVersion: 3,
      scheduleFingerprint: fingerprint,
      recoveryOnly: {
        kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
        version: 1,
        sessionKey,
        messageId: 'close-message-1',
        botId: 'bot-1',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      },
    };

    await expect(service.inspectRecoveryOnlyTransition(job)).resolves.toBe('needed');

    redisCounter.getString.mockResolvedValue(
      JSON.stringify({
        status: 'closed',
        sessionKey,
        closeNoticeMessageId: 'close-message-1',
        closeNoticeBotId: 'bot-1',
        closeNoticeEventRecovery: {
          version: 2,
          pending: true,
          timezone: 'UTC',
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
        },
      }),
    );
    await expect(service.inspectRecoveryOnlyTransition(job)).resolves.toBe('needed');

    prisma.moderationEvent.findFirst.mockResolvedValue({ id: 'event-1' });
    await expect(service.inspectRecoveryOnlyTransition(job)).resolves.toBe('already_complete');

    prisma.maxActionLedgerEntry.findUnique.mockResolvedValue(null);
    await expect(service.inspectRecoveryOnlyTransition(job)).resolves.toBe('unsafe');
  });

  it.each([
    {
      name: 'night mode was disabled and the event already exists',
      entityType: ChatEntityType.CHAT,
      nightModeEnabled: false,
      rescheduled: false,
      eventExists: true,
      scheduleEnabled: false,
    },
    {
      name: 'the entity was converted to a channel',
      entityType: ChatEntityType.CHANNEL,
      nightModeEnabled: true,
      rescheduled: false,
      eventExists: false,
      scheduleEnabled: false,
    },
    {
      name: 'time advanced and the chat was rescheduled to session B',
      entityType: ChatEntityType.CHAT,
      nightModeEnabled: true,
      rescheduled: true,
      eventExists: false,
      scheduleEnabled: true,
    },
  ])(
    'schedules pending session A recovery before current settings gates when $name',
    async ({ entityType, nightModeEnabled, rescheduled, eventExists, scheduleEnabled }) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-02T12:00:00.000Z'));
      try {
        const chatId = `chat-pending-a-${String(entityType).toLowerCase()}-${rescheduled}`;
        const recovery = buildCloseRecoveryA(chatId);
        const settings = {
          chatId,
          nightModeEnabled,
          nightModeStartTimeMinutes: rescheduled ? 21 * 60 : 23 * 60,
          nightModeEndTimeMinutes: rescheduled ? 7 * 60 : 8 * 60,
          nightModeTimezone: rescheduled ? 'UTC' : 'Europe/Moscow',
        };
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              entityType,
              settings,
              botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
            }),
          },
          maxActionLedgerEntry: {
            findUnique: jest.fn().mockResolvedValue({
              actionType: 'SEND_MESSAGE',
              chatId,
              sourceTag: 'night_mode_transition',
              status: MaxActionLedgerStatus.SUCCEEDED,
              ambiguous: false,
              terminal: true,
              completedAt: new Date('2026-05-30T20:00:01.000Z'),
              dispatchBotId: recovery.botId,
              remoteMessageId: recovery.messageId,
            }),
          },
          moderationEvent: {
            findFirst: jest.fn().mockResolvedValue(eventExists ? { id: 'event-a' } : null),
          },
        };
        const queue = {
          getJob: jest.fn().mockResolvedValue(null),
          add: jest.fn().mockResolvedValue(undefined),
        };
        const redisCounter = {
          getString: jest.fn().mockResolvedValue(
            JSON.stringify({
              status: 'closed',
              sessionKey: recovery.sessionKey,
              closeNoticeMessageId: recovery.messageId,
              closeNoticeBotId: recovery.botId,
              closeNoticeEventRecovery: {
                version: 2,
                pending: true,
                timezone: recovery.timezone,
                startMinutes: recovery.startMinutes,
                endMinutes: recovery.endMinutes,
              },
            }),
          ),
        };
        const service = new NightModeTransitionSchedulerService(
          prisma as never,
          queue as unknown as Queue<NightModeTransitionJob>,
          undefined,
          undefined,
          redisCounter as never,
        );

        await expect(service.reconcileChat(chatId)).resolves.toEqual({
          queueAvailable: true,
          scheduleEnabled,
          passes: 1,
        });

        const recoveryJobId = buildNightModeTransitionRecoveryJobId(chatId, recovery);
        expect(queue.add).toHaveBeenCalledWith(
          NIGHT_MODE_TRANSITION_JOB_NAME,
          expect.objectContaining({
            chatId,
            sessionKey: CLOSE_SESSION_A,
            recoveryOnly: recovery,
          }),
          expect.objectContaining({ jobId: recoveryJobId }),
        );
        expect(recoveryJobId).not.toBe(
          buildNightModeTransitionJobId(
            chatId,
            'close',
            '2026-05-30T20:00:00.000Z',
            CLOSE_SESSION_A,
          ),
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([
    {
      name: 'night mode was disabled',
      entityType: ChatEntityType.CHAT,
      nightModeEnabled: false,
      scheduleEnabled: false,
    },
    {
      name: 'the entity became a channel',
      entityType: ChatEntityType.CHANNEL,
      nightModeEnabled: true,
      scheduleEnabled: false,
    },
    {
      name: 'the current schedule moved to session B',
      entityType: ChatEntityType.CHAT,
      nightModeEnabled: true,
      scheduleEnabled: true,
    },
  ])(
    'discovers markerless due session A recovery after $name',
    async ({ entityType, nightModeEnabled, scheduleEnabled }) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-02T12:00:00.000Z'));
      try {
        const chatId = `chat-markerless-a-${String(entityType).toLowerCase()}-${nightModeEnabled}`;
        const recovery = buildCloseRecoveryA(chatId);
        const sessionB = 'v1:UTC:21:00:07:00:2026-06-01';
        const prisma = {
          chat: {
            findUnique: jest.fn().mockResolvedValue({
              entityType,
              settings: {
                chatId,
                nightModeEnabled,
                nightModeStartTimeMinutes: 21 * 60,
                nightModeEndTimeMinutes: 7 * 60,
                nightModeTimezone: 'UTC',
              },
              botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
            }),
          },
          maxActionLedgerEntry: {
            findUnique: jest.fn(async ({ where }: { where: { jobId: string } }) =>
              where.jobId === `night-mode:close:${chatId}:session:${CLOSE_SESSION_A}`
                ? {
                    actionType: 'SEND_MESSAGE',
                    chatId,
                    sourceTag: 'night_mode_transition',
                    status: MaxActionLedgerStatus.SUCCEEDED,
                    ambiguous: false,
                    terminal: true,
                    completedAt: new Date('2026-05-30T20:00:01.000Z'),
                    dispatchBotId: recovery.botId,
                    remoteMessageId: recovery.messageId,
                  }
                : null,
            ),
          },
          moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
        };
        const queue = {
          getJob: jest.fn().mockResolvedValue(null),
          add: jest.fn().mockResolvedValue(undefined),
        };
        const service = new NightModeTransitionSchedulerService(
          prisma as never,
          queue as unknown as Queue<NightModeTransitionJob>,
          undefined,
          undefined,
          {
            getString: jest
              .fn()
              .mockResolvedValue(JSON.stringify({ status: 'open', sessionKey: sessionB })),
          } as never,
        );
        await seedRegisteredJob(service, {
          chatId,
          jobId: buildNightModeTransitionJobId(
            chatId,
            'close',
            '2026-05-30T20:00:00.000Z',
            CLOSE_SESSION_A,
          ),
          sessionKey: CLOSE_SESSION_A,
          scheduledFor: '2026-05-30T20:00:00.000Z',
        });

        await expect(service.reconcileChat(chatId)).resolves.toEqual({
          queueAvailable: true,
          scheduleEnabled,
          passes: 1,
        });

        expect(queue.add).toHaveBeenCalledWith(
          NIGHT_MODE_TRANSITION_JOB_NAME,
          expect.objectContaining({
            sessionKey: CLOSE_SESSION_A,
            recoveryOnly: recovery,
          }),
          expect.objectContaining({
            jobId: buildNightModeTransitionRecoveryJobId(chatId, recovery),
          }),
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('finds a markerless recovery on the second bounded ledger page without registry state', async () => {
    const chatId = 'chat-ledger-page-2';
    const ledgers = Array.from({ length: 21 }, (_, index) => {
      const day = String(index + 1).padStart(2, '0');
      const sessionKey = `v1:Europe/Moscow:23:00:08:00:2026-05-${day}`;
      return {
        id: `ledger-${String(index + 1).padStart(2, '0')}`,
        jobId: `night-mode:close:${chatId}:session:${sessionKey}`,
        updatedAt: new Date(`2026-05-${day}T20:00:01.000Z`),
        actionType: 'SEND_MESSAGE',
        chatId,
        sourceTag: 'night_mode_transition',
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        completedAt: new Date(`2026-05-${day}T20:00:01.000Z`),
        dispatchToken: `token-${index + 1}`,
        dispatchStartedAt: new Date(`2026-05-${day}T20:00:00.000Z`),
        dispatchBotId: 'bot-a',
        remoteMessageId: `close-page-${index + 1}`,
      };
    });
    const prisma = {
      maxActionLedgerEntry: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(ledgers.slice(0, 20))
          .mockResolvedValueOnce(ledgers.slice(20)),
      },
      moderationEvent: {
        findFirst: jest.fn(async ({ where }: { where: { messageId: string } }) =>
          where.messageId === 'close-page-21' ? null : { id: `event-${where.messageId}` },
        ),
      },
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
      undefined,
      undefined,
      { getString: jest.fn().mockResolvedValue(null) } as never,
    );

    await expect(
      (
        service as unknown as {
          ensureCloseEventRecoveryJob(targetChatId: string): Promise<{ jobId: string | null }>;
        }
      ).ensureCloseEventRecoveryJob(chatId),
    ).resolves.toEqual(expect.objectContaining({ jobId: expect.any(String) }));

    expect(prisma.maxActionLedgerEntry.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.maxActionLedgerEntry.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
          completedAt: { not: null },
          dispatchBotId: { not: null },
          remoteMessageId: { not: null },
        }),
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      NIGHT_MODE_TRANSITION_JOB_NAME,
      expect.objectContaining({
        sessionKey: ledgers[20]!.jobId.split(':session:')[1],
        recoveryOnly: expect.objectContaining({ messageId: 'close-page-21' }),
      }),
      expect.any(Object),
    );
  });

  it('uses one indexed anti-join query for per-chat historical recovery', async () => {
    const prisma = {
      maxActionLedgerEntry: { findMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new NightModeTransitionSchedulerService(prisma as never);

    await expect(
      (
        service as unknown as {
          listMissingCloseEventLedgerPage(
            chatId: string,
            jobIdPrefix: string,
            cursor: null,
          ): Promise<unknown[]>;
        }
      ).listMissingCloseEventLedgerPage(
        'chat-indexed-recovery',
        'night-mode:close:chat-indexed-recovery:session:',
        null,
      ),
    ).resolves.toEqual([]);

    expect(prisma.maxActionLedgerEntry.findMany).not.toHaveBeenCalled();
    const sql = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('ledger."chat_id" =');
    expect(sql).toContain('BTRIM(ledger."remote_message_id") <> \'\'');
    expect(sql).toContain('BTRIM(ledger."dispatch_bot_id") <> \'\'');
    expect(sql).toContain('ledger."job_id" LIKE \'night-mode:close:%\'');
    expect(sql).toContain('AND NOT EXISTS');
    expect(sql).toContain('event."rule_code" = \'NIGHT_MODE_CLOSE_NOTICE\'');
    expect(sql).toContain('ORDER BY ledger."completed_at" DESC, ledger."id" DESC');
    expect(sql).toContain('LIMIT');
  });

  it('replaces an existing failed deterministic recovery job and refreshes its registry intent', async () => {
    const chatId = 'chat-failed-recovery-requeue';
    const recovery = buildCloseRecoveryA(chatId);
    const recoveryJobId = buildNightModeTransitionRecoveryJobId(chatId, recovery);
    const order: string[] = [];
    const failedJob = {
      id: recoveryJobId,
      data: { recoveryOnly: recovery },
      getState: jest.fn().mockResolvedValue('failed'),
      remove: jest.fn(async () => {
        order.push('queue-remove');
      }),
    };
    const prisma = {
      maxActionLedgerEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ledger-failed-recovery-requeue',
            jobId: `night-mode:close:${chatId}:session:${recovery.sessionKey}`,
            updatedAt: new Date('2026-05-30T20:00:01.000Z'),
            actionType: 'SEND_MESSAGE',
            chatId,
            sourceTag: 'night_mode_transition',
            status: MaxActionLedgerStatus.SUCCEEDED,
            ambiguous: false,
            terminal: true,
            completedAt: new Date('2026-05-30T20:00:01.000Z'),
            dispatchToken: 'dispatch-failed-recovery-requeue',
            dispatchStartedAt: new Date('2026-05-30T20:00:00.000Z'),
            dispatchBotId: recovery.botId,
            remoteMessageId: recovery.messageId,
          },
        ]),
      },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      $executeRaw: jest.fn(async (query: unknown) => {
        const statement = extractSqlText(query);
        order.push(statement.includes('DELETE FROM') ? 'registry-delete' : 'registry-upsert');
        return 1;
      }),
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue(failedJob),
      add: jest.fn(async () => {
        order.push('queue-add');
      }),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
      undefined,
      undefined,
      { getString: jest.fn().mockResolvedValue(null) } as never,
    );

    await expect(
      (
        service as unknown as {
          ensureCloseEventRecoveryJob(targetChatId: string): Promise<{ jobId: string | null }>;
        }
      ).ensureCloseEventRecoveryJob(chatId),
    ).resolves.toEqual(expect.objectContaining({ jobId: recoveryJobId }));

    expect(queue.getJob).toHaveBeenCalledWith(recoveryJobId);
    expect(failedJob.remove).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0])).toContain(
      'DELETE FROM "night_mode_transition_scheduled_jobs"',
    );
    expect(extractSqlValues(prisma.$executeRaw.mock.calls[0]?.[0])).toEqual([
      chatId,
      recoveryJobId,
    ]);
    expect(extractSqlText(prisma.$executeRaw.mock.calls[1]?.[0])).toContain(
      'INSERT INTO "night_mode_transition_scheduled_jobs"',
    );
    expect(queue.add).toHaveBeenCalledWith(
      NIGHT_MODE_TRANSITION_JOB_NAME,
      expect.objectContaining({ chatId, recoveryOnly: recovery }),
      expect.objectContaining({ jobId: recoveryJobId }),
    );
    expect(order).toEqual(['queue-remove', 'registry-delete', 'registry-upsert', 'queue-add']);
  });

  it('schedules ledger-backed event recovery for a disabled chat without ChatSettings', async () => {
    const chatId = 'chat-disabled-legacy-ledger';
    const recovery = buildCloseRecoveryA(chatId);
    const ledger = {
      id: 'legacy-disabled-ledger',
      jobId: `night-mode:close:${chatId}:session:${recovery.sessionKey}`,
      updatedAt: new Date('2026-05-30T20:00:01.000Z'),
      actionType: 'SEND_MESSAGE',
      chatId,
      sourceTag: 'night_mode_transition',
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      completedAt: new Date('2026-05-30T20:00:01.000Z'),
      dispatchToken: 'legacy-disabled-token',
      dispatchStartedAt: new Date('2026-05-30T20:00:00.000Z'),
      dispatchBotId: recovery.botId,
      remoteMessageId: recovery.messageId,
    };
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: null,
          botMemberships: [],
        }),
      },
      maxActionLedgerEntry: { findMany: jest.fn().mockResolvedValue([ledger]) },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
      undefined,
      undefined,
      { getString: jest.fn().mockResolvedValue(null) } as never,
    );

    await expect(service.repairAccessSchedule(chatId)).resolves.toEqual({
      queueAvailable: true,
      scheduleEnabled: false,
      passes: 1,
    });

    expect(queue.add).toHaveBeenCalledWith(
      NIGHT_MODE_TRANSITION_JOB_NAME,
      expect.objectContaining({
        chatId,
        sessionKey: recovery.sessionKey,
        recoveryOnly: recovery,
      }),
      expect.objectContaining({
        jobId: buildNightModeTransitionRecoveryJobId(chatId, recovery),
      }),
    );
    expect('chatSettings' in prisma).toBe(false);
  });

  it('continues past acknowledged unsafe session A to recover missing event B', async () => {
    const chatId = 'chat-acked-a-needed-b';
    const sessionA = 'v1:Europe/Moscow:23:00:08:00:2026-05-29';
    const sessionB = CLOSE_SESSION_A;
    const fingerprintA = buildNightModeTransitionScheduleFingerprint({
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    });
    const jobA = buildNightModeTransitionJobId(
      chatId,
      'close',
      '2026-05-29T20:00:00.000Z',
      sessionA,
    );
    const baseLedger = {
      actionType: 'SEND_MESSAGE',
      chatId,
      sourceTag: 'night_mode_transition',
      updatedAt: new Date('2026-05-29T20:00:01.000Z'),
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
      completedAt: null,
    };
    const prisma = {
      nightModeTransitionReconcileRequest: {
        findUnique: jest.fn().mockResolvedValue({
          manualBlockedAt: new Date('2026-05-29T20:05:00.000Z'),
          manualBlockedReason: 'accepted A',
          manualBlockedCategory: 'unsafe_prior_provenance',
          manualBlockedJobId: jobA,
          manualBlockedLedgerJobId: `night-mode:close:${chatId}:session:${sessionA}`,
          manualBlockedSessionKey: sessionA,
          manualBlockedFingerprint: fingerprintA,
          manualAcknowledgedAt: new Date('2026-05-29T20:10:00.000Z'),
        }),
      },
      maxActionLedgerEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...baseLedger,
            id: 'ledger-a',
            jobId: `night-mode:close:${chatId}:session:${sessionA}`,
            status: MaxActionLedgerStatus.AMBIGUOUS,
            ambiguous: true,
            terminal: true,
            completedAt: new Date('2026-05-29T20:00:01.000Z'),
          },
          {
            ...baseLedger,
            id: 'ledger-b',
            jobId: `night-mode:close:${chatId}:session:${sessionB}`,
            updatedAt: new Date('2026-05-30T20:00:01.000Z'),
            status: MaxActionLedgerStatus.SUCCEEDED,
            ambiguous: false,
            terminal: true,
            completedAt: new Date('2026-05-30T20:00:01.000Z'),
            dispatchBotId: 'bot-b',
            remoteMessageId: 'close-b',
          },
        ]),
      },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
      undefined,
      undefined,
      { getString: jest.fn().mockResolvedValue(null) } as never,
    );

    await (
      service as unknown as {
        ensureCloseEventRecoveryJob(targetChatId: string): Promise<unknown>;
      }
    ).ensureCloseEventRecoveryJob(chatId);

    expect(queue.add).toHaveBeenCalledWith(
      NIGHT_MODE_TRANSITION_JOB_NAME,
      expect.objectContaining({
        sessionKey: sessionB,
        recoveryOnly: expect.objectContaining({ messageId: 'close-b', botId: 'bot-b' }),
      }),
      expect.any(Object),
    );
  });

  it('ignores a terminal close ledger that proves dispatch never started', async () => {
    const chatId = 'chat-terminal-no-dispatch';
    const sessionKey = CLOSE_SESSION_A;
    const prisma = {
      maxActionLedgerEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'terminal-no-dispatch',
            jobId: `night-mode:close:${chatId}:session:${sessionKey}`,
            updatedAt: new Date('2026-05-30T20:00:01.000Z'),
            actionType: 'SEND_MESSAGE',
            chatId,
            sourceTag: 'night_mode_transition',
            status: MaxActionLedgerStatus.FAILED_TERMINAL,
            ambiguous: false,
            terminal: true,
            completedAt: new Date('2026-05-30T20:00:01.000Z'),
            dispatchToken: null,
            dispatchStartedAt: null,
            dispatchBotId: null,
            remoteMessageId: null,
          },
        ]),
      },
      moderationEvent: { findFirst: jest.fn() },
    };
    const queue = {
      getJob: jest.fn(),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
      undefined,
      undefined,
      { getString: jest.fn().mockResolvedValue(null) } as never,
    );

    await expect(
      (
        service as unknown as {
          ensureCloseEventRecoveryJob(targetChatId: string): Promise<unknown>;
        }
      ).ensureCloseEventRecoveryJob(chatId),
    ).resolves.toEqual({ jobId: null, manualReview: null, blocksCurrentCatchUp: false });

    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('clears pending jobs for a durable request without a configured schedule', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: {
            chatId: 'chat-disabled',
            nightModeEnabled: false,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
          },
          botMemberships: [
            {
              botId: 'bot-1',
              status: ChatBotMembershipStatus.ACTIVE,
              botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
            },
          ],
        }),
      },
    };
    const queue = {
      getJob: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );

    await expect(service.repairAccessSchedule('chat-disabled')).resolves.toEqual({
      queueAvailable: true,
      scheduleEnabled: false,
      passes: 1,
    });

    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.getJobs).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('clears the prior schedule when a disable commits during durable access repair', async () => {
    const chatId = 'chat-disabled-during-access-repair';
    const settings = {
      chatId,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 8 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    };
    const activeSnapshot = {
      entityType: ChatEntityType.CHAT,
      settings,
      botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
    };
    const disabledSnapshot = {
      ...activeSnapshot,
      settings: { ...settings, nightModeEnabled: false },
    };
    const staleJob = {
      id: buildNightModeTransitionJobId(
        chatId,
        'open',
        '2026-05-31T05:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      ),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      chat: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(activeSnapshot)
          .mockResolvedValue(disabledSnapshot),
      },
    };
    const queue = {
      getJob: jest.fn(async (jobId: string) => (jobId === staleJob.id ? staleJob : null)),
      getJobs: jest.fn().mockResolvedValueOnce([staleJob]).mockResolvedValue([]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );
    await seedRegisteredJob(service, { chatId, jobId: staleJob.id, transition: 'open' });

    await expect(service.repairAccessSchedule(chatId)).resolves.toEqual({
      queueAvailable: true,
      scheduleEnabled: false,
      passes: 2,
    });

    expect(staleJob.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(3);
  });

  it('clears orphan jobs when a membership cascade leaves a request for a missing chat', async () => {
    const staleJob = {
      id: buildNightModeTransitionJobId(
        'chat-deleted',
        'close',
        '2026-05-30T20:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      ),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const queue = {
      getJob: jest.fn(async (jobId: string) => (jobId === staleJob.id ? staleJob : null)),
      getJobs: jest.fn().mockResolvedValue([staleJob]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );
    await seedRegisteredJob(service, { chatId: 'chat-deleted', jobId: staleJob.id });

    await expect(service.repairAccessSchedule('chat-deleted')).resolves.toEqual({
      queueAvailable: true,
      scheduleEnabled: false,
      passes: 1,
    });

    expect(queue.getJob).toHaveBeenCalledWith(staleJob.id);
    expect(staleJob.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('fences a concurrent access loss and clears jobs before completing durable repair', async () => {
    const settings = {
      chatId: 'chat-access-race',
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
    };
    const activeSnapshot = {
      entityType: ChatEntityType.CHAT,
      settings,
      botMemberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        },
      ],
    };
    const removedSnapshot = {
      entityType: ChatEntityType.CHAT,
      settings,
      botMemberships: [
        {
          botId: 'bot-1',
          status: ChatBotMembershipStatus.REMOVED,
          botAccessState: ChatBotAccessState.LOST,
        },
      ],
    };
    const staleJob = {
      id: buildNightModeTransitionJobId(
        'chat-access-race',
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
          .mockResolvedValueOnce(activeSnapshot)
          .mockResolvedValue(removedSnapshot),
      },
    };
    const queue = {
      getJob: jest.fn(async (jobId: string) =>
        jobId === staleJob.id ? staleJob : { id: 'already-scheduled' },
      ),
      getJobs: jest.fn().mockResolvedValueOnce([staleJob]).mockResolvedValue([]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );
    await seedRegisteredJob(service, { chatId: 'chat-access-race', jobId: staleJob.id });

    await expect(service.repairAccessSchedule('chat-access-race')).resolves.toEqual({
      queueAvailable: true,
      scheduleEnabled: false,
      passes: 2,
    });

    expect(staleJob.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(3);
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
          botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
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
      getJob: jest.fn(async (candidateJobId: string) =>
        candidateJobId === jobId ? vanishedJob : null,
      ),
      getJobs: jest.fn().mockResolvedValue([vanishedJob]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );
    await seedRegisteredJob(service, { chatId: 'chat-1', jobId });

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
      getJob: jest.fn(async (jobId: string) => (jobId === staleJob.id ? staleJob : null)),
      getJobs: jest.fn().mockResolvedValue([staleJob]),
      add: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );
    await seedRegisteredJob(service, { chatId: 'chat-1', jobId: staleJob.id });

    await expect(service.reconcileChat('chat-1')).rejects.toBe(removeError);

    expect(staleJob.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
  });

  it('reconciles more than one hundred chats without any BullMQ list scan', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const chatIds = Array.from({ length: 101 }, (_, index) => `chat-registry-${index + 1}`);
      const prisma = {
        chat: {
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
            entityType: ChatEntityType.CHAT,
            settings: {
              chatId: where.id,
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
            },
            botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
          })),
        },
      };
      const jobs = new Map<string, { id: string; data: NightModeTransitionJob }>();
      const queue = {
        getJobs: jest.fn(),
        getJob: jest.fn(async (jobId: string) => jobs.get(jobId) ?? null),
        add: jest.fn(
          async (_name: string, data: NightModeTransitionJob, options: { jobId: string }) => {
            const job = { id: options.jobId, data };
            jobs.set(options.jobId, job);
            return job;
          },
        ),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await service.reconcileChats(chatIds);

      expect(queue.getJobs).not.toHaveBeenCalled();
      expect(queue.getJob).toHaveBeenCalledTimes(chatIds.length * 3);
      expect(queue.add).toHaveBeenCalledTimes(chatIds.length * 2);
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(chatIds.length * 2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('atomically persists registry intent without bumping its exact reconcile owner', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const order: string[] = [];
      const chatId = 'chat-crash-order';
      const settings = {
        chatId,
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
            botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
          }),
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn(async (_query: unknown) => {
          order.push('registry-intent');
          return 1;
        }),
      };
      const storedJobs = new Map<string, { id: string; getState: jest.Mock }>();
      const reconcileFence = { generation: 7n, leaseToken: 'lease-owner-7' };
      const queue = {
        getJob: jest.fn(async (jobId: string) => storedJobs.get(jobId) ?? null),
        add: jest
          .fn()
          .mockImplementationOnce(async () => {
            order.push('queue-add');
            throw new Error('redis unavailable');
          })
          .mockImplementation(
            async (_name: string, _data: NightModeTransitionJob, options: { jobId: string }) => {
              const job = { id: options.jobId, getState: jest.fn().mockResolvedValue('waiting') };
              storedJobs.set(options.jobId, job);
              return job;
            },
          ),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await expect(service.repairAccessSchedule(chatId, reconcileFence)).rejects.toThrow(
        'redis unavailable',
      );

      expect(order.slice(0, 2)).toEqual(['registry-intent', 'queue-add']);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const statement = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
      const values = extractSqlValues(prisma.$executeRaw.mock.calls[0]?.[0]);
      expect(values.slice(0, 2)).toEqual([reconcileFence.generation, reconcileFence.leaseToken]);
      expect(statement).toContain('WITH request_owner AS');
      expect(statement).toContain('INSERT INTO "night_mode_transition_scheduled_jobs"');
      expect(statement).toContain('"created_at"');
      expect(statement).toContain('"updated_at"');
      const requestInsertAt = statement.indexOf(
        'INSERT INTO "night_mode_transition_reconcile_requests"',
      );
      const registryInsert = statement.slice(0, requestInsertAt);
      const requestInsert = statement.slice(requestInsertAt);
      expect(registryInsert.match(/CURRENT_TIMESTAMP/g)).toHaveLength(3);
      expect(requestInsert).toContain('ON CONFLICT ("chat_id") DO UPDATE');
      expect(requestInsert).toContain('"generation" + 1');
      expect(requestInsert).toContain('"lease_token" = NULL');
      expect(requestInsert).toContain('"lease_expires_at" = NULL');
      expect(requestInsert).toContain('WHERE NOT EXISTS');
      expect(requestInsert).toContain('owner."generation" =');
      expect(requestInsert).toContain('owner."lease_token" =');
      expect(requestInsert).not.toContain('"lease_expires_at" >');
      expect(registryInsert).toContain('IS DISTINCT FROM');
      const conflictSet = requestInsert.slice(
        requestInsert.indexOf('SET'),
        requestInsert.indexOf('WHERE NOT EXISTS'),
      );
      expect(conflictSet).not.toContain('"manual_blocked_');

      await expect(service.repairAccessSchedule(chatId, reconcileFence)).resolves.toEqual({
        queueAvailable: true,
        scheduleEnabled: true,
        passes: 1,
      });
      expect(queue.add).toHaveBeenCalledTimes(3);
      expect(storedJobs.size).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains an active obsolete job and durably requests another reconcile pass', async () => {
    const activeJob = {
      id: 'night-mode-active-obsolete',
      getState: jest.fn().mockResolvedValue('active'),
      remove: jest.fn(),
    };
    const registryRow = {
      chat_id: 'chat-active-obsolete',
      job_id: activeJob.id,
      transition: 'close',
      session_key: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      scheduled_for: new Date('2026-05-30T20:00:00.000Z'),
      schedule_fingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValueOnce([registryRow]).mockResolvedValue([]),
      $executeRaw: jest.fn(),
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue(activeJob),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      queue as unknown as Queue<NightModeTransitionJob>,
    );

    await expect(service.clearChatJobs(registryRow.chat_id)).rejects.toThrow(
      'Night mode transition jobs are active during schedule replacement',
    );

    expect(activeJob.remove).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0])).toContain(
      'enqueue_night_mode_transition_reconcile_request',
    );
  });

  it('does not revoke a fenced reconcile lease for an active obsolete job', async () => {
    const chatId = 'chat-active-fenced-repair';
    const activeJob = {
      id: 'night-mode-active-fenced-repair',
      getState: jest.fn().mockResolvedValue('active'),
      remove: jest.fn(),
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          chat_id: chatId,
          job_id: activeJob.id,
          transition: 'close',
          session_key: CLOSE_SESSION_A,
          scheduled_for: new Date('2026-05-30T20:00:00.000Z'),
          schedule_fingerprint: `sha256:${'a'.repeat(64)}`,
        },
      ]),
      $executeRaw: jest.fn(),
    };
    const service = new NightModeTransitionSchedulerService(
      prisma as never,
      { getJob: jest.fn().mockResolvedValue(activeJob) } as never,
    );

    await expect(
      (
        service as unknown as {
          clearChatJobsForChatIds(
            chatIds: string[],
            options: {
              strict: boolean;
              reconcileFence: { generation: bigint; leaseToken: string };
            },
          ): Promise<void>;
        }
      ).clearChatJobsForChatIds([chatId], {
        strict: true,
        reconcileFence: { generation: 4n, leaseToken: 'lease-owner-4' },
      }),
    ).rejects.toThrow('Night mode transition jobs are active during schedule replacement');

    expect(activeJob.remove).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('does not fail a completed transition while enqueue-next still observes its active job', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    try {
      const chatId = 'chat-active-enqueue-next';
      const settings = {
        chatId,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      };
      const activeJob = {
        id: 'night-mode-active-current',
        getState: jest.fn().mockResolvedValue('active'),
        remove: jest.fn(),
      };
      const registryRow = {
        chat_id: chatId,
        job_id: activeJob.id,
        transition: 'open',
        session_key: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        scheduled_for: new Date('2026-05-31T05:00:00.000Z'),
        schedule_fingerprint: `sha256:${'a'.repeat(64)}`,
      };
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: ChatEntityType.CHAT,
            settings,
            botMemberships: [ACTIVE_TRANSITION_MEMBERSHIP],
          }),
        },
        $queryRaw: jest.fn().mockResolvedValueOnce([registryRow]).mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const queue = {
        getJob: jest.fn(async (jobId: string) => (jobId === activeJob.id ? activeJob : null)),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new NightModeTransitionSchedulerService(
        prisma as never,
        queue as unknown as Queue<NightModeTransitionJob>,
      );

      await expect(service.enqueueNextTransitionsForChat(chatId)).resolves.toBeUndefined();

      expect(activeJob.remove).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
