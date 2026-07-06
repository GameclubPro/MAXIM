import {
  ChatBotAccessState,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
} from '../prisma/prisma-client';
import { SystemBotsService } from './system-bots.service';

const generatedAt = '2026-07-06T10:00:00.000Z';

function webhookMetrics(count = 0) {
  return {
    count,
    oldestEventId: null,
    oldestCreatedAt: null,
    oldestLagSec: 0,
  };
}

function actionHealth() {
  return {
    windowSec: 60,
    total: 0,
    success: 0,
    failure: 0,
    critical: 0,
    errorRate: 0,
    criticalRate: 0,
  };
}

function botQueue(overrides: Record<string, unknown> = {}) {
  return {
    webhookEvents: {
      received: webhookMetrics(3),
      queued: webhookMetrics(1),
      failed: webhookMetrics(0),
    },
    userFacingWebhookEvents: {
      received: webhookMetrics(2),
      queued: webhookMetrics(1),
      failed: webhookMetrics(0),
    },
    queuedByQueue: {
      'webhook-critical': 1,
    },
    actionHealth: actionHealth(),
    oldestQueuedEventId: null,
    oldestQueuedCreatedAt: null,
    oldestQueuedLagSec: 0,
    oldestReceivedEventId: null,
    oldestReceivedCreatedAt: null,
    oldestReceivedLagSec: 0,
    effectiveLagSec: 0,
    userFacingOldestQueuedEventId: null,
    userFacingOldestQueuedCreatedAt: null,
    userFacingOldestQueuedLagSec: 0,
    userFacingOldestReceivedEventId: null,
    userFacingOldestReceivedCreatedAt: null,
    userFacingOldestReceivedLagSec: 0,
    userFacingEffectiveLagSec: 0,
    ...overrides,
  };
}

function maxApiLoad(overrides: Record<string, unknown> = {}) {
  return {
    windowSec: 60,
    totalRequests: 0,
    avgRps: 0,
    peakRps: 0,
    activeSeconds: 0,
    trafficClasses: {
      critical: { totalRequests: 0, avgRps: 0, peakRps: 0, activeSeconds: 0 },
      interactive: { totalRequests: 0, avgRps: 0, peakRps: 0, activeSeconds: 0 },
      background: { totalRequests: 0, avgRps: 0, peakRps: 0, activeSeconds: 0 },
    },
    limits: {
      globalRps: 30,
      criticalRps: 14,
      interactiveRps: 10,
      backgroundRps: 6,
    },
    peakLoad: 0,
    avgLoad: 0,
    smoothedLoad: 0,
    ...overrides,
  };
}

function createBot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    characterName: id,
    contactId: `${id}-contact`,
    state: 'active',
    visibleInAdmin: true,
    isDefault: false,
    ...overrides,
  };
}

describe('SystemBotsService', () => {
  it('builds a read-only fleet snapshot for all configured bots', async () => {
    const bots = [
      createBot('bot-1', { isDefault: true }),
      createBot('bot-2'),
      createBot('bot-3', { state: 'draining' }),
      createBot('bot-4', { state: 'dormant' }),
      createBot('bot-5', { state: 'disabled', visibleInAdmin: false }),
      createBot('bot-6'),
    ];
    const groupBy = jest.fn().mockResolvedValue([
      {
        primaryBotId: 'bot-1',
        entityType: ChatEntityType.CHAT,
        _count: { _all: 2 },
      },
      {
        primaryBotId: 'bot-1',
        entityType: ChatEntityType.CHANNEL,
        _count: { _all: 1 },
      },
      {
        primaryBotId: 'bot-2',
        entityType: ChatEntityType.CHANNEL,
        _count: { _all: 1 },
      },
    ]);
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        {
          botId: 'bot-2',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          entityType: ChatEntityType.CHAT,
          isAssist: false,
          count: 1n,
        },
        {
          botId: 'bot-3',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.STALE,
          entityType: ChatEntityType.CHANNEL,
          isAssist: true,
          count: 2n,
        },
        {
          botId: 'bot-4',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.DENIED,
          entityType: ChatEntityType.CHAT,
          isAssist: false,
          count: 1,
        },
        {
          botId: 'bot-5',
          role: ChatBotMembershipRole.STANDBY,
          status: ChatBotMembershipStatus.REMOVED,
          botAccessState: ChatBotAccessState.LOST,
          entityType: ChatEntityType.CHANNEL,
          isAssist: false,
          count: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          botId: 'bot-3',
          chatId: 'channel-1',
          title: 'Channel 1',
          entityType: ChatEntityType.CHANNEL,
          kind: 'stale-access',
          botRole: ChatBotMembershipRole.STANDBY,
          membershipStatus: ChatBotMembershipStatus.ACTIVE,
          botAccessState: ChatBotAccessState.STALE,
          primaryBotId: 'bot-1',
          checkedAt: new Date(generatedAt),
          lastSeenAt: null,
          lastWebhookAt: null,
          updatedAt: new Date(generatedAt),
        },
      ]);
    const prisma = {
      chat: {
        groupBy,
      },
      $queryRaw: queryRaw,
    };
    const queueMetricsService = {
      getSnapshot: jest.fn().mockResolvedValue({
        bots: {
          'bot-1': botQueue({ effectiveLagSec: 1.2 }),
          'bot-3': botQueue({ effectiveLagSec: 5 }),
        },
      }),
    };
    const webhookSubscriptionStatusService = {
      getSnapshot: jest.fn().mockResolvedValue({
        bots: {
          'bot-3': {
            botId: 'bot-3',
            status: 'warning',
            configured: true,
            url: null,
            checkedAt: generatedAt,
            reconciledAt: generatedAt,
            requiredUpdateTypes: [],
            actualUpdateTypes: [],
            missingUpdateTypes: [],
            extraUpdateTypes: [],
            otherSubscriptionsCount: 0,
            lastError: null,
            note: null,
            operationalDiagnostics: {
              lifecycleState: 'draining',
              activeMemberships: 2,
              hasCurrentSubscription: true,
              lastIncomingWebhookAt: generatedAt,
              lastMembershipWebhookAt: generatedAt,
              issueCodes: ['no-incoming-webhooks'],
            },
          },
        },
      }),
    };
    const maxApiMetricsService = {
      getBotRateLimitSnapshot: jest.fn().mockResolvedValue({
        'bot-1': maxApiLoad({
          totalRequests: 7,
          avgRps: 0.117,
          peakRps: 2,
          smoothedLoad: 0.2,
          peakLoad: 0.3,
          avgLoad: 0.1,
          trafficClasses: {
            critical: { totalRequests: 2, avgRps: 0.033, peakRps: 1, activeSeconds: 1 },
            interactive: { totalRequests: 1, avgRps: 0.017, peakRps: 1, activeSeconds: 1 },
            background: { totalRequests: 4, avgRps: 0.067, peakRps: 2, activeSeconds: 2 },
          },
        }),
      }),
    };
    const service = new SystemBotsService(
      prisma as never,
      { getAllBots: jest.fn(() => bots) } as never,
      queueMetricsService as never,
      webhookSubscriptionStatusService as never,
      maxApiMetricsService as never,
    );

    const snapshot = await service.getSnapshot();

    expect(snapshot.bots).toHaveLength(6);
    expect(snapshot.summary).toMatchObject({
      total: 6,
      adminVisible: 5,
      active: 3,
      draining: 1,
      dormant: 1,
      disabled: 1,
      webhookWarningBotCount: 1,
      problemBotCount: 1,
      lostAccess: 0,
      staleAccess: 2,
      deniedAccess: 1,
    });
    expect(snapshot.summary.primaryEntities).toEqual({
      total: 4,
      chats: 2,
      channels: 2,
    });
    expect(snapshot.summary.standbyEntities).toEqual({
      total: 4,
      chats: 2,
      channels: 2,
    });
    expect(snapshot.summary.assistEntities).toEqual({
      total: 2,
      chats: 0,
      channels: 2,
    });
    expect(snapshot.bots.find((bot) => bot.botId === 'bot-1')).toMatchObject({
      isDefault: true,
      entities: {
        primary: {
          total: 3,
          chats: 2,
          channels: 1,
        },
      },
      maxApiLoad: {
        totalRequests: 7,
        background: {
          totalRequests: 4,
        },
      },
    });
    expect(snapshot.bots.find((bot) => bot.botId === 'bot-3')).toMatchObject({
      lifecycleState: 'draining',
      webhook: {
        status: 'warning',
      },
      queue: {
        effectiveLagSec: 5,
      },
      entities: {
        standby: {
          total: 2,
          channels: 2,
        },
        assist: {
          total: 2,
          channels: 2,
        },
      },
      access: {
        stale: 2,
      },
      problemSamples: [
        {
          chatId: 'channel-1',
          entityType: 'channel',
          kind: 'stale-access',
          botAccessState: 'stale',
        },
      ],
    });
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          primaryBotId: { in: bots.map((bot) => bot.id) },
          OR: [
            { catalogKind: ChatCatalogKind.MANAGED },
            {
              catalogKind: ChatCatalogKind.UNKNOWN,
              entityType: ChatEntityType.CHANNEL,
            },
          ],
        },
      }),
    );
    expect(queueMetricsService.getSnapshot).toHaveBeenCalledWith({ maxAgeMs: 2_000 });
    expect(maxApiMetricsService.getBotRateLimitSnapshot).toHaveBeenCalledWith(
      bots.map((bot) => bot.id),
      { windowSec: 60 },
    );
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
