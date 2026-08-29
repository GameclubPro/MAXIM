import {
  managedEntitiesListResponseSchema,
  managedEntityBotExecutionPlanSchema,
  managedEntityFavoriteLabelsResponseSchema,
  managedEntityFavoritesResponseSchema,
  meSchema,
  systemDashboardResponseSchema,
  systemModeSnapshotSchema,
  updateManagedEntityFavoritesRequestSchema,
  updateManagedEntityFavoriteLabelsRequestSchema,
  type ApplySettingsTarget,
  type BotSpeechPersona,
  type BotSpeechPreviewProfile,
  type ChatSummary,
  type ManagedEntitiesListResponse,
  type ManagedEntityAccessDiagnostics,
  type ManagedEntityAssignedBot,
  type ManagedEntityBotCapability,
  type ManagedEntityBotExecutionPlan,
  type ManagedEntityType,
  type SystemDashboardResponse,
  type SystemModeSnapshot,
} from '@maxim/contracts';
import {
  systemBotRoutePreviewResponseSchema,
  systemBotsSnapshotSchema,
  type SystemBotsSnapshot,
} from '@maxim/contracts/system';
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHANNEL_TITLE,
  PREVIEW_CHAT_ID,
  PREVIEW_CHAT_TITLE,
} from '../design-preview';
import { ApiRequestError } from '../api-request-error';
import type { PreviewState } from './preview-transport-state';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  type PreviewClock,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import { buildPreviewAvatarDataUrl, parseJsonBody } from './preview-transport-shared';

export const PREVIEW_PRIMARY_BOT_ID = '777000_bot';
export const PREVIEW_PRIMARY_BOT_LABEL = 'Майор Максимов';
export const PREVIEW_STANDBY_BOT_ID = '777001_bot';
export const PREVIEW_STANDBY_BOT_LABEL = 'Майор Максимова';
export const PREVIEW_REX_BOT_ID = '777002_bot';
export const PREVIEW_REX_BOT_LABEL = 'Рэкс';
export const PREVIEW_EDITOR_BOT_ID = '777003_bot';
export const PREVIEW_EDITOR_BOT_LABEL = 'Редактор Майя';
export const PREVIEW_SCOUT_BOT_ID = '777004_bot';
export const PREVIEW_SCOUT_BOT_LABEL = 'Скаут Илья';
export const PREVIEW_BACKUP_BOT_ID = '777005_bot';
export const PREVIEW_BACKUP_BOT_LABEL = 'Резервный Максим';
export const PREVIEW_ACCESS_LOST_AT = '2026-07-14T06:15:00.000Z';
export const PREVIEW_ACCESS_CHECKED_AT = '2026-07-14T06:20:00.000Z';

export function readPreviewRouteSearch(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  const directSearch = window.location.search;
  const directParams = new URLSearchParams(directSearch);
  if (directParams.has('access') || directParams.has('settingsError')) {
    return directSearch;
  }

  const hashQueryIndex = window.location.hash.indexOf('?');
  return hashQueryIndex >= 0 ? window.location.hash.slice(hashQueryIndex) : directSearch;
}

export function buildPreviewAccessDiagnostics(
  search: string,
): ManagedEntityAccessDiagnostics | null {
  const variant = new URLSearchParams(search).get('access');
  if (variant !== 'lost' && variant !== 'degraded') {
    return null;
  }

  return {
    state: 'bot_access_lost',
    lastDetectedAt: PREVIEW_ACCESS_LOST_AT,
    lastCheckedAt: PREVIEW_ACCESS_CHECKED_AT,
    freshUntil: null,
    source: 'access_edge',
    activeBotCount: variant === 'degraded' ? 1 : 0,
    lostBots: [
      {
        botId: PREVIEW_STANDBY_BOT_ID,
        botLabel: PREVIEW_STANDBY_BOT_LABEL,
        reason: variant === 'degraded' ? 'bot_denied' : 'bot_removed',
        detectedAt: PREVIEW_ACCESS_LOST_AT,
      },
    ],
  };
}

export type PreviewBotFixture = {
  botId: string;
  label: string;
  speechPersona: BotSpeechPersona;
  characterName: string;
  avatarColors: readonly [string, string];
  assistCapabilities: ManagedEntityBotCapability[];
  standbyPermissions: string[];
};

export const PREVIEW_BOT_FIXTURES = [
  {
    botId: PREVIEW_PRIMARY_BOT_ID,
    label: PREVIEW_PRIMARY_BOT_LABEL,
    speechPersona: 'male',
    characterName: 'Майор Максимов',
    avatarColors: ['#22b6b7', '#1484a0'],
    assistCapabilities: [],
    standbyPermissions: ['read', 'write'],
  },
  {
    botId: PREVIEW_STANDBY_BOT_ID,
    label: PREVIEW_STANDBY_BOT_LABEL,
    speechPersona: 'female',
    characterName: 'Майор Максимова',
    avatarColors: ['#ff89b8', '#de5a82'],
    assistCapabilities: ['access_prewarm', 'membership_prewarm'],
    standbyPermissions: ['read', 'write', 'manage'],
  },
  {
    botId: PREVIEW_REX_BOT_ID,
    label: PREVIEW_REX_BOT_LABEL,
    speechPersona: 'neutral',
    characterName: 'Рэкс',
    avatarColors: ['#39c58f', '#178a68'],
    assistCapabilities: ['access_prewarm'],
    standbyPermissions: ['read', 'write'],
  },
  {
    botId: PREVIEW_EDITOR_BOT_ID,
    label: PREVIEW_EDITOR_BOT_LABEL,
    speechPersona: 'female',
    characterName: 'Редактор Майя',
    avatarColors: ['#f6b453', '#d36a35'],
    assistCapabilities: ['suggestion_delivery', 'channel_stats'],
    standbyPermissions: ['read', 'write', 'manage'],
  },
  {
    botId: PREVIEW_SCOUT_BOT_ID,
    label: PREVIEW_SCOUT_BOT_LABEL,
    speechPersona: 'neutral',
    characterName: 'Скаут Илья',
    avatarColors: ['#7c9dff', '#3f5bd7'],
    assistCapabilities: ['background_scans', 'membership_prewarm'],
    standbyPermissions: ['read'],
  },
  {
    botId: PREVIEW_BACKUP_BOT_ID,
    label: PREVIEW_BACKUP_BOT_LABEL,
    speechPersona: 'male',
    characterName: 'Резервный Максим',
    avatarColors: ['#b17cff', '#7042c8'],
    assistCapabilities: ['background_scans', 'access_prewarm'],
    standbyPermissions: ['read', 'write'],
  },
] satisfies PreviewBotFixture[];

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildPreviewAssignedBots(
  options: {
    primaryBotId?: string | null;
    assistEnabled?: boolean;
  } = {},
  clock: PreviewClock,
): ChatSummary['assignedBots'] {
  const primaryBotId = options.primaryBotId ?? PREVIEW_PRIMARY_BOT_ID;
  const assistEnabled = options.assistEnabled === true;

  return PREVIEW_BOT_FIXTURES.map((fixture): ManagedEntityAssignedBot => {
    const isPrimary = primaryBotId === fixture.botId;
    const [avatarStart, avatarEnd] = fixture.avatarColors;

    return {
      botId: fixture.botId,
      label: fixture.label,
      role: isPrimary ? 'primary' : 'standby',
      membershipStatus: 'active',
      lifecycleState: 'active',
      speechPersona: fixture.speechPersona,
      characterName: fixture.characterName,
      avatarUrl: buildPreviewAvatarDataUrl(fixture.characterName, avatarStart, avatarEnd),
      capabilities: assistEnabled && !isPrimary ? fixture.assistCapabilities : [],
      permissionsSummary: {
        checkedAt: readPreviewClock(clock).toISOString(),
        isAdmin: true,
        isOwner: isPrimary,
        permissions: isPrimary ? ['all'] : fixture.standbyPermissions,
      },
    };
  });
}

export function buildPreviewBotSpeechProfile(
  primaryBotId: string | null,
  assignedBots: ChatSummary['assignedBots'],
): BotSpeechPreviewProfile {
  const bot =
    assignedBots.find(
      (candidate) =>
        candidate.botId === primaryBotId &&
        candidate.membershipStatus === 'active' &&
        candidate.lifecycleState === 'active',
    ) ?? assignedBots.find((candidate) => candidate.role === 'primary');
  return {
    persona: bot?.speechPersona ?? 'neutral',
    characterName: bot?.characterName?.trim() || bot?.label.trim() || 'Чат-бот',
  };
}

export function createPreviewChatSummary(
  params: Omit<ChatSummary, 'primaryBotId' | 'assignedBots' | 'sharedMode'>,
  clock: PreviewClock,
): ChatSummary {
  const assignedBots = buildPreviewAssignedBots({}, clock);

  return {
    ...params,
    primaryBotId: PREVIEW_PRIMARY_BOT_ID,
    assignedBots,
    sharedMode: 'shared-standby',
    botCount: params.botCount ?? assignedBots.length,
    hasSharedAutomation: params.hasSharedAutomation ?? assignedBots.length > 1,
  };
}

export function buildPreviewSystemMode(state: PreviewState): SystemModeSnapshot {
  const now = readPreviewClock(state.clock).toISOString();
  const manualMode = state.systemModeSelection === 'auto' ? null : state.systemModeSelection;
  const mode = manualMode ?? 'normal';
  const action =
    mode === 'degrade'
      ? {
          windowSec: 60,
          total: 182,
          success: 162,
          failure: 20,
          critical: 9,
          errorRate: 0.109,
          criticalRate: 0.049,
        }
      : {
          windowSec: 60,
          total: 94,
          success: 93,
          failure: 1,
          critical: 0,
          errorRate: 0.011,
          criticalRate: 0,
        };

  return {
    mode,
    source: manualMode ? 'manual' : 'auto',
    reason: manualMode ? 'manual override' : 'system healthy',
    updatedAt: now,
    manualMode,
    queueLagSec: manualMode === 'degrade' ? 11.4 : 0,
    action,
  };
}

export function buildPreviewSharedMode(assistEnabled: boolean): 'shared-assist' | 'shared-standby' {
  return assistEnabled ? 'shared-assist' : 'shared-standby';
}

export function buildPreviewPartnerBotIds(assignedBots: ChatSummary['assignedBots']): string[] {
  const activePartners = assignedBots.filter(
    (bot) =>
      bot.role !== 'primary' &&
      bot.membershipStatus === 'active' &&
      bot.lifecycleState === 'active',
  );
  const assistPartners = activePartners.filter((bot) => bot.capabilities.length > 0);
  return (assistPartners.length > 0 ? assistPartners : activePartners).map((bot) => bot.botId);
}

export function buildPreviewBotExecutionPlan(
  state: PreviewState,
  entityType: 'chat' | 'channel',
  chatId: string,
): ManagedEntityBotExecutionPlan {
  const primaryBotId = entityType === 'chat' ? state.chatPrimaryBotId : state.channelPrimaryBotId;
  const assistEnabled =
    entityType === 'chat' ? state.chatPartnerAssistEnabled : state.channelPartnerAssistEnabled;
  const assignedBots = buildPreviewAssignedBots({ primaryBotId, assistEnabled }, state.clock);
  const partnerBotIds = buildPreviewPartnerBotIds(assignedBots);
  const partnerBotId = partnerBotIds[0] ?? null;

  return managedEntityBotExecutionPlanSchema.parse({
    chatId,
    entityType,
    primaryBotId,
    speakerBotId: primaryBotId,
    workerBotId: primaryBotId,
    linkBotId: primaryBotId,
    partnerBotId,
    partnerBotIds,
    sharedMode: buildPreviewSharedMode(assistEnabled),
    userFacingPolicy: 'owner-only',
    reasons: [
      'Preview transport uses owner-only routing for user-facing actions.',
      assistEnabled
        ? 'Partner bot is enabled only for safe assist lanes.'
        : 'Partner bot stays in standby until assist is enabled.',
    ],
    warnings: assistEnabled
      ? []
      : ['Assist lanes are disabled in preview. Owner bot handles all user-facing work.'],
    assignedBots,
  });
}

export function buildPreviewSystemDashboard(state: PreviewState): SystemDashboardResponse {
  const mode = buildPreviewSystemMode(state);
  const generatedAt = readPreviewClock(state.clock).toISOString();
  const inDegrade = mode.mode === 'degrade';
  const queues = {
    moderation: {
      waiting: inDegrade ? 7 : 1,
      active: inDegrade ? 3 : 0,
      delayed: 0,
      failed: 0,
      completed: 2480,
    },
    webhookCritical: {
      waiting: 0,
      active: 1,
      delayed: 0,
      failed: 0,
      completed: 960,
    },
    webhookJoin: {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    },
    webhookJoinShards: {},
    webhookDefault: {
      waiting: inDegrade ? 5 : 1,
      active: inDegrade ? 2 : 0,
      delayed: 0,
      failed: 0,
      completed: 1224,
    },
    webhookDefaultShards: {
      'moderation-default-0': {
        waiting: inDegrade ? 5 : 1,
        active: inDegrade ? 2 : 0,
        delayed: 0,
        failed: 0,
        completed: 1224,
      },
    },
    webhookDefaultWorkerGroups: {
      'api-moderation-realtime-b': {
        queues: ['moderation-default-0'],
        counters: {
          waiting: inDegrade ? 5 : 1,
          active: inDegrade ? 2 : 0,
          delayed: 0,
          failed: 0,
          completed: 1224,
        },
      },
    },
    webhookBackground: {
      waiting: inDegrade ? 2 : 0,
      active: inDegrade ? 1 : 0,
      delayed: 0,
      failed: 0,
      completed: 296,
    },
    webhookLegacy: {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    },
    actions: {
      waiting: inDegrade ? 2 : 0,
      active: inDegrade ? 1 : 0,
      delayed: 0,
      failed: 0,
      completed: 480,
    },
    actionQueues: {
      'moderation-actions': {
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      },
      'max-actions-critical': {
        waiting: inDegrade ? 2 : 0,
        active: inDegrade ? 1 : 0,
        delayed: 0,
        failed: 0,
        completed: 300,
      },
      'max-actions-interactive': {
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 180,
      },
      'max-actions-background': {
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      },
    },
    globalSpammerDenorm: {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    },
    auxiliaryQueues: {
      'admin-managed-entities-refresh': {
        waiting: 0,
        active: inDegrade ? 1 : 0,
        delayed: inDegrade ? 24 : 8,
        failed: 0,
        completed: 640,
      },
      'vk-parsing-publisher': {
        waiting: inDegrade ? 2 : 0,
        active: 0,
        delayed: inDegrade ? 12 : 4,
        failed: inDegrade ? 1 : 0,
        completed: 320,
      },
      'max-chat-admin-roster-sync': {
        waiting: 0,
        active: 0,
        delayed: 3,
        failed: 0,
        completed: 180,
      },
    },
    webhookEvents: {
      received: {
        count: inDegrade ? 3 : 0,
        oldestEventId: inDegrade ? 'preview-received-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 6.1 : 0,
      },
      queued: {
        count: inDegrade ? 4 : 0,
        oldestEventId: inDegrade ? 'preview-queued-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 11.4 : 0,
      },
      failed: {
        count: inDegrade ? 12 : 0,
        oldestEventId: inDegrade ? 'preview-failed-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 41 : 0,
      },
    },
    userFacingWebhookEvents: {
      received: {
        count: inDegrade ? 2 : 0,
        oldestEventId: inDegrade ? 'preview-user-facing-received-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 3.2 : 0,
      },
      queued: {
        count: inDegrade ? 2 : 0,
        oldestEventId: inDegrade ? 'preview-user-facing-queued-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 5.4 : 0,
      },
      failed: {
        count: inDegrade ? 1 : 0,
        oldestEventId: inDegrade ? 'preview-user-facing-failed-1' : null,
        oldestCreatedAt: inDegrade ? generatedAt : null,
        oldestLagSec: inDegrade ? 12 : 0,
      },
    },
    actionHealth: mode.action,
    actionLedgerWatchdog: null,
    webhookDynamicLeases: null,
    bots: {
      [PREVIEW_PRIMARY_BOT_ID]: {
        webhookEvents: {
          received: {
            count: inDegrade ? 3 : 0,
            oldestEventId: inDegrade ? 'preview-received-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 6.1 : 0,
          },
          queued: {
            count: inDegrade ? 4 : 0,
            oldestEventId: inDegrade ? 'preview-queued-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 11.4 : 0,
          },
          failed: {
            count: inDegrade ? 12 : 0,
            oldestEventId: inDegrade ? 'preview-failed-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 41 : 0,
          },
        },
        userFacingWebhookEvents: {
          received: {
            count: inDegrade ? 2 : 0,
            oldestEventId: inDegrade ? 'preview-user-facing-received-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 3.2 : 0,
          },
          queued: {
            count: inDegrade ? 2 : 0,
            oldestEventId: inDegrade ? 'preview-user-facing-queued-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 5.4 : 0,
          },
          failed: {
            count: inDegrade ? 1 : 0,
            oldestEventId: inDegrade ? 'preview-user-facing-failed-1' : null,
            oldestCreatedAt: inDegrade ? generatedAt : null,
            oldestLagSec: inDegrade ? 12 : 0,
          },
        },
        queuedByQueue: {
          'webhook-critical': 0,
          'webhook-default': inDegrade ? 4 : 0,
          'webhook-background': inDegrade ? 2 : 0,
        },
        actionHealth: mode.action,
        oldestQueuedEventId: inDegrade ? 'preview-queued-1' : null,
        oldestQueuedCreatedAt: inDegrade ? generatedAt : null,
        oldestQueuedLagSec: inDegrade ? 11.4 : 0,
        oldestReceivedEventId: inDegrade ? 'preview-received-1' : null,
        oldestReceivedCreatedAt: inDegrade ? generatedAt : null,
        oldestReceivedLagSec: inDegrade ? 6.1 : 0,
        effectiveLagSec: inDegrade ? 11.4 : 0,
        userFacingOldestQueuedEventId: inDegrade ? 'preview-user-facing-queued-1' : null,
        userFacingOldestQueuedCreatedAt: inDegrade ? generatedAt : null,
        userFacingOldestQueuedLagSec: inDegrade ? 5.4 : 0,
        userFacingOldestReceivedEventId: inDegrade ? 'preview-user-facing-received-1' : null,
        userFacingOldestReceivedCreatedAt: inDegrade ? generatedAt : null,
        userFacingOldestReceivedLagSec: inDegrade ? 3.2 : 0,
        userFacingEffectiveLagSec: inDegrade ? 5.4 : 0,
      },
    },
    oldestQueuedEventId: inDegrade ? 'preview-queued-1' : null,
    oldestQueuedCreatedAt: inDegrade ? generatedAt : null,
    oldestQueuedLagSec: inDegrade ? 11.4 : 0,
    oldestReceivedEventId: inDegrade ? 'preview-received-1' : null,
    oldestReceivedCreatedAt: inDegrade ? generatedAt : null,
    oldestReceivedLagSec: inDegrade ? 6.1 : 0,
    effectiveLagSec: inDegrade ? 11.4 : 0,
    userFacingOldestQueuedEventId: inDegrade ? 'preview-user-facing-queued-1' : null,
    userFacingOldestQueuedCreatedAt: inDegrade ? generatedAt : null,
    userFacingOldestQueuedLagSec: inDegrade ? 5.4 : 0,
    userFacingOldestReceivedEventId: inDegrade ? 'preview-user-facing-received-1' : null,
    userFacingOldestReceivedCreatedAt: inDegrade ? generatedAt : null,
    userFacingOldestReceivedLagSec: inDegrade ? 3.2 : 0,
    userFacingEffectiveLagSec: inDegrade ? 5.4 : 0,
    generatedAt,
  };
  const alerts = inDegrade
    ? [
        {
          code: 'queue-lag',
          level: 'critical' as const,
          title: 'Очередь отстаёт',
          detail: 'Preview показывает backlog и ручной degrade режим.',
          recommendedAction: 'Проверьте split-runtime и снизьте background traffic.',
        },
      ]
    : [
        {
          code: 'healthy',
          level: 'info' as const,
          title: 'Все контуры зелёные',
          detail: 'Webhook-path чистый, lag не копится.',
          recommendedAction: 'Наблюдайте и держите auto-mode активным.',
        },
      ];

  return {
    summary: {
      status: inDegrade ? 'critical' : 'healthy',
      title: inDegrade ? 'Нужна реакция оператора' : 'Бот работает ровно',
      detail: inDegrade
        ? 'Preview-инцидент: часть событий специально задержана для проверки интерфейса.'
        : 'Preview-режим показывает штатное состояние без накопления очередей.',
      generatedAt,
      stabilizing: false,
    },
    alerts,
    queues,
    mode,
    webhookSubscription: {
      status: inDegrade ? 'warning' : 'healthy',
      configured: true,
      url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
      checkedAt: generatedAt,
      reconciledAt: inDegrade ? null : generatedAt,
      requiredUpdateTypes: [
        'message_created',
        'message_callback',
        'user_added',
        'user_removed',
        'bot_added',
        'bot_removed',
        'bot_started',
      ],
      actualUpdateTypes: inDegrade
        ? [
            'message_created',
            'message_callback',
            'user_added',
            'user_removed',
            'bot_added',
            'bot_started',
          ]
        : [
            'message_created',
            'message_callback',
            'user_added',
            'user_removed',
            'bot_added',
            'bot_removed',
            'bot_started',
          ],
      missingUpdateTypes: inDegrade ? ['bot_removed'] : [],
      extraUpdateTypes: [],
      otherSubscriptionsCount: 0,
      lastError: inDegrade ? 'Preview reconcile error' : null,
      note: inDegrade
        ? 'Preview показывает drift webhook coverage.'
        : 'Preview показывает актуальную webhook coverage.',
      botCount: 1,
      bots: {
        [PREVIEW_PRIMARY_BOT_ID]: {
          botId: PREVIEW_PRIMARY_BOT_ID,
          status: inDegrade ? 'warning' : 'healthy',
          configured: true,
          url: 'https://maxim.play-team.ru/api/webhook/max/777000_bot/***',
          checkedAt: generatedAt,
          reconciledAt: inDegrade ? null : generatedAt,
          requiredUpdateTypes: [
            'message_created',
            'message_callback',
            'user_added',
            'user_removed',
            'bot_added',
            'bot_removed',
            'bot_started',
          ],
          actualUpdateTypes: inDegrade
            ? [
                'message_created',
                'message_callback',
                'user_added',
                'user_removed',
                'bot_added',
                'bot_started',
              ]
            : [
                'message_created',
                'message_callback',
                'user_added',
                'user_removed',
                'bot_added',
                'bot_removed',
                'bot_started',
              ],
          missingUpdateTypes: inDegrade ? ['bot_removed'] : [],
          extraUpdateTypes: [],
          otherSubscriptionsCount: 0,
          lastError: inDegrade ? 'Preview reconcile error' : null,
          note: inDegrade
            ? 'Preview показывает drift webhook coverage.'
            : 'Preview показывает актуальную webhook coverage.',
        },
      },
    },
    ownership: {
      generatedAt,
      bots: {
        configured: 3,
        adminVisible: 3,
        active: 3,
        dormant: 0,
        draining: 0,
        disabled: 0,
      },
      entities: {
        total: {
          total: 48,
          withPrimary: 37,
          withoutPrimary: 11,
          coverageRatio: 37 / 48,
        },
        chats: {
          total: 42,
          withPrimary: 33,
          withoutPrimary: 9,
          coverageRatio: 33 / 42,
        },
        channels: {
          total: 6,
          withPrimary: 4,
          withoutPrimary: 2,
          coverageRatio: 4 / 6,
        },
      },
      anomalies: {
        noPrimary: 9,
        recoverableLegacyOnly: 2,
        recoverableFromMemberships: 1,
        noEligibleBot: 2,
        unbound: 6,
        primaryBotUnknown: 0,
        legacyBotUnknown: 1,
        activeMembershipBotUnknown: 0,
        primaryWithoutActiveMembership: 0,
        primaryWithoutAdminAccess: 0,
        sharedChats: 0,
      },
      repair: {
        enabled: true,
        activeOnThisRole: true,
        intervalMs: 300_000,
        rebalanceMode: 'shadow',
        rebalanceCanaryPercent: 1,
        rebalanceMaxMovesPerRun: 25,
        recommendedMoves: 4,
        lastAppliedMoves: 0,
        lastRunAt: generatedAt,
        lastSuccessAt: generatedAt,
        lastError: null,
        lastAppliedChanges: 3,
        totalAppliedChanges: 12,
      },
    },
    runtimeProfile: {
      appRole: 'all',
      serviceName: 'api-all',
      serviceTitle: 'All-in-one API runtime',
      queueProfile: 'all-in-one',
      queuePriority: 'all',
      topologySource: 'fallback',
      httpEnabled: true,
      ingressEnabled: true,
      adminEnabled: true,
      enqueueEnabled: true,
      moderationEnabled: true,
      actionEnabled: true,
      publisherEnabled: false,
      enabledQueues: ['critical', 'default', 'join', 'background'],
      dynamicLeasesMode: inDegrade ? 'canary' : 'on',
      dynamicLeasesWorkerGroup: 'api-moderation-realtime-c',
      canaryShardIds: ['moderation-default-2', 'moderation-default-11'],
      targetWebhookP95Ms: 1_000,
      generatedAt,
    },
    canaryState: {
      enabled: true,
      mode: inDegrade ? 'canary' : 'on',
      status: inDegrade ? 'degraded' : 'active',
      recommendation: inDegrade ? 'rollback' : 'observe',
      workerGroup: 'api-moderation-realtime-c',
      canaryShardIds: ['moderation-default-2', 'moderation-default-11'],
      liveWorkerGroups: ['api-moderation', 'api-moderation-realtime-c'],
      handoffPendingQueues: inDegrade ? ['moderation-default-11'] : [],
      unhealthyQueues: inDegrade ? ['moderation-default-11'] : [],
      reason: inDegrade
        ? 'Preview canary is degraded, so rollback is recommended.'
        : 'Preview canary is stable and SLO is inside the target.',
    },
    rollbackReadiness: {
      status: inDegrade ? 'rollback-recommended' : 'ready',
      canRollbackRuntime: true,
      liveOk: true,
      readyOk: !inDegrade,
      webhookSloOk: !inDegrade,
      queueLagOk: !inDegrade,
      failedWebhookOk: !inDegrade,
      reasons: inDegrade ? ['Webhook SLO is outside the target window.'] : [],
      command:
        './infra/scripts/vps-connect.sh rollback-runtime <git-ref> api-enqueue api-moderation api-action api-ingress api-admin',
    },
    queueGroupHealth: {
      status: inDegrade ? 'critical' : 'healthy',
      generatedAt,
      groups: [
        {
          name: 'api-moderation',
          queues: ['moderation-default-0', 'moderation-default-4'],
          waiting: inDegrade ? 2 : 0,
          active: inDegrade ? 1 : 0,
          delayed: 0,
          failed: 0,
          completed: 820,
          pressure: inDegrade ? 3 : 0,
          status: inDegrade ? 'warning' : 'healthy',
        },
        {
          name: 'api-moderation-realtime-c',
          queues: ['moderation-default-2', 'moderation-default-11'],
          waiting: inDegrade ? 52 : 0,
          active: inDegrade ? 2 : 0,
          delayed: 0,
          failed: inDegrade ? 1 : 0,
          completed: 760,
          pressure: inDegrade ? 54 : 0,
          status: inDegrade ? 'critical' : 'healthy',
        },
      ],
    },
    webhookSlo: {
      status: inDegrade ? 'critical' : 'healthy',
      windowSec: 900,
      targetProcessingMs: 1_000,
      totalEvents: inDegrade ? 1240 : 860,
      processedEvents: inDegrade ? 1170 : 859,
      failedEvents: inDegrade ? 12 : 0,
      sampledProcessedEvents: inDegrade ? 500 : 500,
      p95ProcessingMs: inDegrade ? 1840 : 420,
      p99ProcessingMs: inDegrade ? 2600 : 610,
      underTargetRatio: inDegrade ? 0.82 : 0.992,
      oldestUnprocessedLagSec: inDegrade ? 11.4 : 0,
      oldestUnprocessedEventId: inDegrade ? 'preview-queued-1' : null,
      lastProcessedAt: generatedAt,
      generatedAt,
    },
    slo: {
      status: inDegrade ? 'critical' : 'healthy',
      windowSec: 900,
      targetProcessingMs: 1_000,
      totalEvents: inDegrade ? 1240 : 860,
      processedEvents: inDegrade ? 1170 : 859,
      failedEvents: inDegrade ? 12 : 0,
      sampledProcessedEvents: inDegrade ? 500 : 500,
      p95ProcessingMs: inDegrade ? 1840 : 420,
      p99ProcessingMs: inDegrade ? 2600 : 610,
      underTargetRatio: inDegrade ? 0.82 : 0.992,
      oldestUnprocessedLagSec: inDegrade ? 11.4 : 0,
      oldestUnprocessedEventId: inDegrade ? 'preview-queued-1' : null,
      lastProcessedAt: generatedAt,
      generatedAt,
    },
  };
}

export function buildPreviewSystemBots(state: PreviewState): SystemBotsSnapshot {
  const dashboard = buildPreviewSystemDashboard(state);
  const generatedAt = dashboard.summary.generatedAt;
  const inDegrade = dashboard.mode.mode === 'degrade';
  const primaryQueue = dashboard.queues.bots[PREVIEW_PRIMARY_BOT_ID] ?? null;
  const primaryWebhook = dashboard.webhookSubscription.bots[PREVIEW_PRIMARY_BOT_ID] ?? null;
  const standbyBotId = '777001_bot';
  const dormantBotId = '777002_bot';
  const assistTotal =
    (state.chatPartnerAssistEnabled ? 3 : 0) + (state.channelPartnerAssistEnabled ? 1 : 0);
  const problemSamples = inDegrade
    ? [
        {
          chatId: PREVIEW_CHANNEL_ID,
          title: PREVIEW_CHANNEL_TITLE,
          entityType: 'channel' as const,
          kind: 'stale-access' as const,
          botRole: 'standby' as const,
          membershipStatus: 'active' as const,
          botAccessState: 'stale' as const,
          primaryBotId: PREVIEW_PRIMARY_BOT_ID,
          checkedAt: generatedAt,
          lastSeenAt: generatedAt,
          lastWebhookAt: generatedAt,
          updatedAt: generatedAt,
        },
      ]
    : [];

  return systemBotsSnapshotSchema.parse({
    generatedAt,
    summary: {
      total: 3,
      adminVisible: 3,
      active: 2,
      draining: 0,
      dormant: 1,
      disabled: 0,
      webhookWarningBotCount: inDegrade ? 1 : 0,
      problemBotCount: inDegrade ? 1 : 0,
      primaryEntities: {
        total: 37,
        chats: 33,
        channels: 4,
      },
      standbyEntities: {
        total: 12,
        chats: 10,
        channels: 2,
      },
      assistEntities: {
        total: assistTotal,
        chats: state.chatPartnerAssistEnabled ? 3 : 0,
        channels: state.channelPartnerAssistEnabled ? 1 : 0,
      },
      lostAccess: 0,
      staleAccess: inDegrade ? 1 : 0,
      deniedAccess: 0,
    },
    bots: [
      {
        botId: PREVIEW_PRIMARY_BOT_ID,
        label: 'Майор Максимов',
        characterName: 'Майор Максимов',
        lifecycleState: 'active',
        adminVisible: true,
        isDefault: true,
        contactId: '777000',
        webhook: primaryWebhook,
        operationalDiagnostics: primaryWebhook?.operationalDiagnostics ?? null,
        queue: primaryQueue,
        maxApiLoad: {
          windowSec: 60,
          totalRequests: inDegrade ? 18 : 4,
          avgRps: inDegrade ? 0.3 : 0.067,
          peakRps: inDegrade ? 4 : 1,
          avgLoad: inDegrade ? 0.18 : 0.04,
          peakLoad: inDegrade ? 0.42 : 0.08,
          smoothedLoad: inDegrade ? 0.24 : 0.05,
          background: {
            totalRequests: inDegrade ? 6 : 1,
            avgRps: inDegrade ? 0.1 : 0.017,
            peakRps: inDegrade ? 2 : 1,
          },
        },
        entities: {
          primary: {
            total: 37,
            chats: 33,
            channels: 4,
          },
          standby: {
            total: 0,
            chats: 0,
            channels: 0,
          },
          assist: {
            total: 0,
            chats: 0,
            channels: 0,
          },
        },
        access: {
          lost: 0,
          stale: 0,
          denied: 0,
          unknown: 0,
          removedAfterLoss: 0,
        },
        problemSamples: [],
      },
      {
        botId: standbyBotId,
        label: 'Максимов-2',
        characterName: 'Максимов-2',
        lifecycleState: 'active',
        adminVisible: true,
        isDefault: false,
        contactId: '777001',
        webhook: null,
        operationalDiagnostics: null,
        queue: null,
        maxApiLoad: {
          windowSec: 60,
          totalRequests: inDegrade ? 9 : 2,
          avgRps: inDegrade ? 0.15 : 0.033,
          peakRps: inDegrade ? 2 : 1,
          avgLoad: inDegrade ? 0.11 : 0.02,
          peakLoad: inDegrade ? 0.24 : 0.04,
          smoothedLoad: inDegrade ? 0.14 : 0.03,
          background: {
            totalRequests: inDegrade ? 7 : 2,
            avgRps: inDegrade ? 0.117 : 0.033,
            peakRps: inDegrade ? 2 : 1,
          },
        },
        entities: {
          primary: {
            total: 0,
            chats: 0,
            channels: 0,
          },
          standby: {
            total: 12,
            chats: 10,
            channels: 2,
          },
          assist: {
            total: assistTotal,
            chats: state.chatPartnerAssistEnabled ? 3 : 0,
            channels: state.channelPartnerAssistEnabled ? 1 : 0,
          },
        },
        access: {
          lost: 0,
          stale: inDegrade ? 1 : 0,
          denied: 0,
          unknown: 1,
          removedAfterLoss: 0,
        },
        problemSamples,
      },
      {
        botId: dormantBotId,
        label: 'Максимов-3',
        characterName: 'Максимов-3',
        lifecycleState: 'dormant',
        adminVisible: true,
        isDefault: false,
        contactId: '777002',
        webhook: null,
        operationalDiagnostics: null,
        queue: null,
        maxApiLoad: {
          windowSec: 60,
          totalRequests: 0,
          avgRps: 0,
          peakRps: 0,
          avgLoad: 0,
          peakLoad: 0,
          smoothedLoad: 0,
          background: {
            totalRequests: 0,
            avgRps: 0,
            peakRps: 0,
          },
        },
        entities: {
          primary: {
            total: 0,
            chats: 0,
            channels: 0,
          },
          standby: {
            total: 0,
            chats: 0,
            channels: 0,
          },
          assist: {
            total: 0,
            chats: 0,
            channels: 0,
          },
        },
        access: {
          lost: 0,
          stale: 0,
          denied: 0,
          unknown: 0,
          removedAfterLoss: 0,
        },
        problemSamples: [],
      },
    ],
  });
}

export function buildPreviewSystemBotRoutePreview(state: PreviewState, url: URL) {
  const dashboard = buildPreviewSystemDashboard(state);
  const generatedAt = dashboard.summary.generatedAt;
  const chatId = url.searchParams.get('chatId')?.trim() || PREVIEW_CHAT_ID;
  const purpose = url.searchParams.get('purpose')?.trim() || 'all';
  const action = url.searchParams.get('action')?.trim() || null;
  const capability = url.searchParams.get('capability')?.trim() || null;
  const fallbackToPrimary = url.searchParams.get('fallbackToPrimary') !== 'false';
  const botId = url.searchParams.get('botId')?.trim() || null;
  const chatExists = chatId === PREVIEW_CHAT_ID || chatId === PREVIEW_CHANNEL_ID;
  const chatTitle =
    chatId === PREVIEW_CHANNEL_ID
      ? PREVIEW_CHANNEL_TITLE
      : chatId === PREVIEW_CHAT_ID
        ? PREVIEW_CHAT_TITLE
        : null;
  const entityType = chatId === PREVIEW_CHANNEL_ID ? 'channel' : chatExists ? 'chat' : null;
  const botById = new Map(PREVIEW_BOT_FIXTURES.map((fixture) => [fixture.botId, fixture]));
  const selectedBot =
    botById.get(botId ?? PREVIEW_STANDBY_BOT_ID) ?? botById.get(PREVIEW_STANDBY_BOT_ID)!;
  const routeBot = (fixture: PreviewBotFixture) => ({
    botId: fixture.botId,
    label: fixture.label,
    lifecycleState: fixture.botId === PREVIEW_REX_BOT_ID ? 'dormant' : 'active',
    adminVisible: true,
    isDefault: fixture.botId === PREVIEW_PRIMARY_BOT_ID,
  });
  const routeCandidates = [selectedBot, botById.get(PREVIEW_PRIMARY_BOT_ID)!].filter(
    (fixture, index, fixtures) =>
      fixtures.findIndex((candidate) => candidate.botId === fixture.botId) === index,
  );
  const allRoutes = [
    {
      purpose: 'send_message',
      action: null,
      capability: null,
      chatId,
      primaryBotId: PREVIEW_PRIMARY_BOT_ID,
      botId: selectedBot.botId,
      candidateBotIds: routeCandidates.map((fixture) => fixture.botId),
      reason:
        selectedBot.botId === PREVIEW_PRIMARY_BOT_ID ? 'primary_confirmed' : 'alternate_confirmed',
      selectedBot: routeBot(selectedBot),
      candidateBots: routeCandidates.map(routeBot),
    },
    {
      purpose: 'moderation_action',
      action: 'delete_message',
      capability: null,
      chatId,
      primaryBotId: PREVIEW_PRIMARY_BOT_ID,
      botId: PREVIEW_EDITOR_BOT_ID,
      candidateBotIds: [PREVIEW_EDITOR_BOT_ID, PREVIEW_STANDBY_BOT_ID],
      reason: 'alternate_confirmed',
      selectedBot: routeBot(botById.get(PREVIEW_EDITOR_BOT_ID)!),
      candidateBots: [PREVIEW_EDITOR_BOT_ID, PREVIEW_STANDBY_BOT_ID].map((id) =>
        routeBot(botById.get(id)!),
      ),
    },
    {
      purpose: 'capability',
      action: null,
      capability: 'membership_prewarm',
      chatId,
      primaryBotId: PREVIEW_PRIMARY_BOT_ID,
      botId: PREVIEW_STANDBY_BOT_ID,
      candidateBotIds: [PREVIEW_STANDBY_BOT_ID, PREVIEW_SCOUT_BOT_ID],
      reason: 'alternate_confirmed',
      selectedBot: routeBot(botById.get(PREVIEW_STANDBY_BOT_ID)!),
      candidateBots: [PREVIEW_STANDBY_BOT_ID, PREVIEW_SCOUT_BOT_ID].map((id) =>
        routeBot(botById.get(id)!),
      ),
    },
  ];
  const routes = allRoutes.filter((route) => {
    if (purpose !== 'all' && route.purpose !== purpose) {
      return false;
    }
    if (action && route.action !== action) {
      return false;
    }
    if (capability && route.capability !== capability) {
      return false;
    }
    return true;
  });
  const memberships = PREVIEW_BOT_FIXTURES.map((fixture) => {
    const isPrimary = fixture.botId === PREVIEW_PRIMARY_BOT_ID;
    const isDormant = fixture.botId === PREVIEW_REX_BOT_ID;
    return {
      botId: fixture.botId,
      label: fixture.label,
      configured: true,
      lifecycleState: isDormant ? 'dormant' : 'active',
      operational: !isDormant,
      discoverable: !isDormant,
      executable: !isDormant,
      role: isPrimary ? 'primary' : 'standby',
      status: 'active',
      botAccessState: isPrimary ? 'confirmed_owner' : isDormant ? 'stale' : 'confirmed_admin',
      capabilities: fixture.assistCapabilities,
      permissionsSummary: {
        checkedAt: generatedAt,
        isAdmin: true,
        isOwner: isPrimary,
        permissions: isPrimary ? ['all'] : fixture.standbyPermissions,
      },
      botAccessCheckedAt: generatedAt,
      botAccessExpiresAt: null,
      botAccessSource: 'preview',
      botAccessLastErrorCode: isDormant ? 'preview.stale' : null,
      lastSeenAt: generatedAt,
      lastWebhookAt: isDormant ? null : generatedAt,
      issues: isDormant ? ['stale-access', 'not-executable'] : [],
    };
  });

  return systemBotRoutePreviewResponseSchema.parse({
    generatedAt,
    query: {
      chatId,
      purpose,
      action,
      capability,
      fallbackToPrimary,
      botId,
    },
    chat: {
      exists: chatExists,
      chatId,
      title: chatTitle,
      entityType,
      catalogKind: chatExists ? 'MANAGED' : null,
      storedPrimaryBotId: chatExists ? PREVIEW_PRIMARY_BOT_ID : null,
      legacyBotId: null,
    },
    routes,
    memberships,
    warnings: chatExists ? [] : ['chat-not-found-in-preview-catalog'],
  });
}

export function buildPreviewManagedEntitiesResponse(
  items: ChatSummary[],
  clock: PreviewClock,
): ManagedEntitiesListResponse {
  const nowIso = readPreviewClock(clock).toISOString();
  return managedEntitiesListResponseSchema.parse({
    items,
    refresh: {
      complete: true,
      cursor: -1,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 0,
      processedCandidates: items.length,
      totalCandidates: items.length,
      progressPercent: 100,
      lastSyncedAt: nowIso,
    },
    snapshot: {
      version: 'preview-snapshot-v1',
      builtAt: nowIso,
      lastSyncedAt: nowIso,
      source: 'published_snapshot',
      stale: false,
    },
  });
}

export function resolvePreviewApplyTargetChats(
  state: PreviewState,
  sourceChatId: string,
  target: ApplySettingsTarget,
): ChatSummary[] {
  if (target.mode === 'current') {
    return state.chats.filter((item) => item.id === sourceChatId);
  }

  if (target.mode === 'selectedChats') {
    const selectedIds = new Set(target.chatIds);
    return state.chats.filter((item) => selectedIds.has(item.id));
  }

  if (target.mode === 'allFavorites') {
    return state.chats.filter((item) => (item.favoriteTypes ?? []).length > 0);
  }

  if (target.mode === 'favoriteTypes') {
    const favoriteTypes = new Set(target.favoriteTypes);
    return state.chats.filter((item) =>
      (item.favoriteTypes ?? []).some((favoriteType) => favoriteTypes.has(favoriteType)),
    );
  }

  return state.chats;
}

export function updatePreviewManagedEntityFavorites(
  state: PreviewState,
  entityType: ManagedEntityType,
  entityId: string,
  favoriteTypes: ApplySettingsTarget['favoriteTypes'],
): void {
  const items = entityType === 'channel' ? state.channels : state.chats;
  const index = items.findIndex((item) => item.id === entityId);
  if (index < 0) {
    throw new Error(`Preview managed entity not found: ${entityType}/${entityId}`);
  }

  const next = { ...items[index] };
  if (favoriteTypes.length > 0) {
    next.favoriteTypes = favoriteTypes;
  } else {
    delete next.favoriteTypes;
  }
  items[index] = next;
}

export const handleSystemPreviewRequest: PreviewRequestHandler = ({
  state,
  url,
  segments,
  method,
  init,
}) => {
  if (url.pathname === '/me' && method === 'GET') {
    return meSchema.parse(cloneJson(state.me));
  }
  if (url.pathname === '/system/dashboard' && method === 'GET') {
    return systemDashboardResponseSchema.parse(buildPreviewSystemDashboard(state));
  }
  if (url.pathname === '/system/bots' && method === 'GET') {
    return systemBotsSnapshotSchema.parse(buildPreviewSystemBots(state));
  }
  if (url.pathname === '/system/bots/routes/preview' && method === 'GET') {
    return buildPreviewSystemBotRoutePreview(state, url);
  }
  if (url.pathname === '/system/mode' && method === 'POST') {
    const mode = (parseJsonBody(init) as { mode?: unknown } | null)?.mode;
    if (mode !== 'auto' && mode !== 'normal' && mode !== 'degrade') {
      throw new Error('Preview transport received invalid system mode payload');
    }
    state.systemModeSelection = mode;
    return systemModeSnapshotSchema.parse(buildPreviewSystemMode(state));
  }
  if (url.pathname === '/chats' && method === 'GET') {
    return url.searchParams.get('includeRefreshState') === '1'
      ? cloneJson(buildPreviewManagedEntitiesResponse(state.chats, state.clock))
      : cloneJson(state.chats);
  }
  if (url.pathname === '/channels' && method === 'GET') {
    return url.searchParams.get('includeRefreshState') === '1'
      ? cloneJson(buildPreviewManagedEntitiesResponse(state.channels, state.clock))
      : cloneJson(state.channels);
  }
  if (url.pathname === '/managed-entities/favorite-labels' && method === 'GET') {
    return managedEntityFavoriteLabelsResponseSchema.parse({
      initialized: state.favoriteLabelsInitialized,
      labels: cloneJson(state.favoriteLabels),
      revision: state.favoriteLabelsRevision,
    });
  }
  if (url.pathname === '/managed-entities/favorite-labels' && method === 'PUT') {
    const payload = updateManagedEntityFavoriteLabelsRequestSchema.parse(parseJsonBody(init));
    if (payload.mode === 'replace') {
      if (payload.expectedRevision !== state.favoriteLabelsRevision) {
        const message =
          'Названия категорий уже изменились. Обновите данные и повторите сохранение.';
        throw new ApiRequestError(
          409,
          JSON.stringify({
            code: 'MANAGED_ENTITY_FAVORITE_LABELS_REVISION_CONFLICT',
            message,
          }),
          message,
        );
      }
      state.favoriteLabels = payload.labels;
      state.favoriteLabelsInitialized = true;
      state.favoriteLabelsRevision = (state.favoriteLabelsRevision ?? 0) + 1;
    } else if (!state.favoriteLabelsInitialized) {
      state.favoriteLabels = payload.labels;
      state.favoriteLabelsInitialized = true;
      state.favoriteLabelsRevision = 1;
    }
    return managedEntityFavoriteLabelsResponseSchema.parse({
      initialized: true,
      labels: cloneJson(state.favoriteLabels),
      revision: state.favoriteLabelsRevision,
    });
  }
  if (
    segments[0] === 'managed-entities' &&
    segments[1] &&
    segments[2] &&
    segments[3] === 'favorites' &&
    method === 'PUT'
  ) {
    const entityType = segments[1] === 'channel' ? 'channel' : 'chat';
    const entityId = decodeURIComponent(segments[2]);
    const payload = updateManagedEntityFavoritesRequestSchema.parse(parseJsonBody(init));
    updatePreviewManagedEntityFavorites(state, entityType, entityId, payload.favoriteTypes);
    return managedEntityFavoritesResponseSchema.parse({
      entityType,
      entityId,
      favoriteTypes: payload.favoriteTypes,
    });
  }
  return PREVIEW_NOT_HANDLED;
};
