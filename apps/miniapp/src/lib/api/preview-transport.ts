import {
  applySectionToAllResponseSchema,
  broadcastHandoffStateSchema,
  channelDialogMessageSchema,
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  channelSettingsSchema,
  channelSettingsScreenResponseSchema,
  channelStatsResponseSchema,
  chatRulesSchema,
  chatSettingsSchema,
  chatSettingsScreenResponseSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  domainAllowlistEntrySchema,
  logsDashboardResponseSchema,
  managedBroadcastDetailsSchema,
  managedEntitiesListResponseSchema,
  managedGiveawayDetailsSchema,
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
  managedPollSchema,
  manualModerationActionResultSchema,
  moderationFeedPageSchema,
  membershipActivityPageSchema,
  publishChannelEngagementResultSchema,
  publishChatRulesResultSchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  systemDashboardResponseSchema,
  systemModeSnapshotSchema,
  toggleChannelDialogReactionRequestSchema,
  toggleChannelDialogReactionResponseSchema,
  type BroadcastHandoffResponse,
  type BroadcastHandoffState,
  type ChannelDialogMessage,
  type ChannelDialogResponse,
  type ChannelDialogType,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
  type ChannelStatsRange,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type ChatSummary,
  type DomainAllowlistEntry,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManagedBroadcastDetails,
  type ManagedEntitiesListResponse,
  type ManagedGiveawayDetails,
  type ManagedGiveawayParticipantState,
  type ManagedGiveawayPublic,
  type ManagedGiveawaySummary,
  type ManagedPoll,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
  type Me,
  type ModerationFeedFilter,
  type ModerationFeedPage,
  type MembershipActivityFilter,
  type MembershipActivityItem,
  type MembershipActivityPage,
  type MembershipActivityRange,
  type PublishChannelEngagementResult,
  type PublishChatRulesResult,
  type SystemDashboardResponse,
  type SystemModeSnapshot,
} from '@maxim/contracts';
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHANNEL_TITLE,
  PREVIEW_CHAT_ID,
  PREVIEW_CHAT_TITLE,
} from '../design-preview';
import type { ApiTransport } from './transport';

type PreviewState = {
  me: Me;
  systemModeSelection: 'auto' | 'normal' | 'degrade';
  chats: ChatSummary[];
  channels: ChatSummary[];
  chatDialogs: Record<ChannelDialogType, PreviewDialogBucket>;
  channelDialogs: Record<ChannelDialogType, PreviewDialogBucket>;
  chatHeaderParticipantsCount: number;
  chatSettings: ChatSettings;
  chatRules: ChatRules;
  chatDomains: DomainAllowlistEntry[];
  chatPoll: ManagedPoll;
  chatBroadcasts: ManagedBroadcastDetails[];
  channelBroadcasts: ManagedBroadcastDetails[];
  chatGiveaways: ManagedGiveawayDetails[];
  chatActivity: MembershipActivityItem[];
  chatViolations: LogsDashboardResponse['violations'];
  channelHeaderParticipantsCount: number;
  channelSettings: ChannelSettings;
  channelPoll: ManagedPoll;
  channelGiveaways: ManagedGiveawayDetails[];
  channelActivity: MembershipActivityItem[];
};

type PreviewDialogBucket = {
  introText: string;
  messages: ChannelDialogMessage[];
};

const PREVIEW_PUBLIC_GIVEAWAY_ID = 'preview-giveaway';
const PREVIEW_GIVEAWAY_RUNTIME_STATE_KEY = 'maxim.preview.giveaway.runtime';

type PreviewGiveawayVariant = 'blocked' | 'joined' | 'winner' | 'completed';
type PreviewGiveawayParticipantVariant = PreviewGiveawayVariant | 'blocked-entered';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildPreviewSystemMode(state: PreviewState): SystemModeSnapshot {
  const now = new Date().toISOString();
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

function buildPreviewSystemDashboard(state: PreviewState): SystemDashboardResponse {
  const mode = buildPreviewSystemMode(state);
  const generatedAt = new Date().toISOString();
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
    webhookDefault: {
      waiting: inDegrade ? 5 : 1,
      active: inDegrade ? 2 : 0,
      delayed: 0,
      failed: 0,
      completed: 1224,
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
    actionHealth: mode.action,
    oldestQueuedEventId: inDegrade ? 'preview-queued-1' : null,
    oldestQueuedCreatedAt: inDegrade ? generatedAt : null,
    oldestQueuedLagSec: inDegrade ? 11.4 : 0,
    oldestReceivedEventId: inDegrade ? 'preview-received-1' : null,
    oldestReceivedCreatedAt: inDegrade ? generatedAt : null,
    oldestReceivedLagSec: inDegrade ? 6.1 : 0,
    effectiveLagSec: inDegrade ? 11.4 : 0,
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
    },
  };
}

function buildAuthorBadge(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return 'MX';
  }

  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  }

  return normalized.slice(0, 2).toUpperCase();
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 60 * 60 * 1_000);
}

function addDays(value: Date, days: number): Date {
  return addHours(value, days * 24);
}

function resolveRangeWindow(range: MembershipActivityRange, now: Date) {
  const to = new Date(now);
  const from = new Date(now);

  if (range === '24h') {
    from.setHours(from.getHours() - 24);
  } else if (range === '7d') {
    from.setDate(from.getDate() - 7);
  } else {
    from.setDate(from.getDate() - 30);
  }

  return { from, to };
}

function isWithinRange(createdAt: string, range: MembershipActivityRange, now: Date): boolean {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const { from, to } = resolveRangeWindow(range, now);
  return timestamp >= from.getTime() && timestamp <= to.getTime();
}

function filterActivityItems(
  items: MembershipActivityItem[],
  range: MembershipActivityRange,
  filter: MembershipActivityFilter,
  now: Date,
): MembershipActivityItem[] {
  return items.filter((item) => {
    if (!isWithinRange(item.createdAt, range, now)) {
      return false;
    }

    if (filter !== 'all' && item.type !== filter) {
      return false;
    }

    return true;
  });
}

function matchesModerationFeedFilter(
  item: LogsDashboardResponse['violations'][number],
  filter: ModerationFeedFilter,
): boolean {
  if (filter === 'ALL') {
    return true;
  }

  if (filter === 'UNBAN') {
    return item.ruleCode === 'MANUAL_UNBAN';
  }

  return item.action === filter;
}

function buildModerationFeedPage(
  items: LogsDashboardResponse['violations'],
  {
    range,
    filter = 'ALL',
    limit = 50,
    cursor,
  }: {
    range: LogsDashboardRange;
    filter?: ModerationFeedFilter;
    limit?: number;
    cursor?: string | null;
  },
  now: Date,
): ModerationFeedPage {
  const filtered = items.filter(
    (item) =>
      isWithinRange(item.createdAt, range, now) && matchesModerationFeedFilter(item, filter),
  );
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const pageItems = filtered.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageItems.length;

  return moderationFeedPageSchema.parse({
    items: pageItems,
    hasMore: nextOffset < filtered.length,
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
  });
}

function buildActivityPage(
  items: MembershipActivityItem[],
  {
    range,
    filter = 'all',
    limit = 50,
    cursor,
  }: {
    range: MembershipActivityRange;
    filter?: MembershipActivityFilter;
    limit?: number;
    cursor?: string | null;
  },
  now: Date,
): MembershipActivityPage {
  const filtered = filterActivityItems(items, range, filter, now);
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const pageItems = filtered.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageItems.length;

  return membershipActivityPageSchema.parse({
    items: pageItems,
    hasMore: nextOffset < filtered.length,
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
  });
}

function buildBroadcastSummary(details: ManagedBroadcastDetails) {
  return {
    id: details.id,
    status: details.status,
    textPreview: details.text.trim().slice(0, 120) || 'Пустая рассылка',
    textLength: details.text.length,
    applyToAllChats: details.applyToAllChats,
    targetChats: details.targetChatIds.length || 1,
    hasImage: details.imageEnabled,
    buttonEnabled: details.buttonEnabled,
    scheduleMode: details.scheduleMode,
    scheduleTimezone: details.scheduleTimezone,
    scheduledSlots: details.scheduledSlots,
    nextSendAt: details.nextSendAt,
    cycleEnabled: details.cycleEnabled,
    cycleEveryHours: details.cycleEveryHours,
    cycleCount: details.cycleCount,
    sentCount: details.sentCount,
    currentOccurrence: details.currentOccurrence,
    deliveredChats: details.deliveredChats,
    failedChats: details.failedChats,
    pendingChats: details.pendingChats,
    canRetry: details.canRetry,
    remainingCount: details.remainingCount,
    createdAt: details.createdAt,
    updatedAt: details.updatedAt,
    lastError: details.lastError,
  };
}

function buildPreviewManagedEntitiesResponse(items: ChatSummary[]): ManagedEntitiesListResponse {
  return managedEntitiesListResponseSchema.parse({
    items,
    refresh: {
      complete: true,
      cursor: -1,
      backoffActive: false,
      nextPollAfterMs: 0,
    },
  });
}

function buildBroadcastHandoffState(details: ManagedBroadcastDetails): BroadcastHandoffState {
  return broadcastHandoffStateSchema.parse({
    applyToAllChats: details.applyToAllChats,
    buttonEnabled: details.buttonEnabled,
    buttonUrl: details.buttonUrl,
    buttonText: details.buttonText,
    scheduleMode: details.scheduleMode,
    scheduleTimezone: details.scheduleTimezone,
    scheduledSlots: details.scheduledSlots,
    sendAt: details.nextSendAt,
    cycleEnabled: details.cycleEnabled,
    cycleEveryHours: details.cycleEveryHours,
    cycleCount: details.cycleCount,
    hasContent: Boolean(details.text.trim() || details.imageEnabled),
  });
}

function buildGiveawaySummary(details: ManagedGiveawayDetails): ManagedGiveawaySummary {
  return {
    id: details.id,
    title: details.title,
    status: details.status,
    hasImage: details.hasImage,
    entriesCount: details.entriesCount,
    verifiedEntriesCount: details.verifiedEntriesCount,
    pendingEntriesCount: details.pendingEntriesCount,
    winnersCount: details.winnersCount,
    startsAt: details.startsAt,
    endsAt: details.endsAt,
    publishedAt: details.publishedAt,
    completedAt: details.completedAt,
    publicationUrl: details.publicationUrl,
    resultsUrl: details.resultsUrl,
    createdAt: details.createdAt,
    updatedAt: details.updatedAt,
  };
}

function readPreviewGiveawayVariant(): PreviewGiveawayVariant {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('giveaway_state');

  if (value === 'joined' || value === 'winner' || value === 'completed') {
    return value;
  }

  return 'blocked';
}

function readPreviewGiveawayEnterResult(): PreviewGiveawayParticipantVariant | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('giveaway_enter_result');
  if (
    value === 'blocked-entered' ||
    value === 'joined' ||
    value === 'winner' ||
    value === 'completed'
  ) {
    return value;
  }

  return null;
}

function buildPreviewGiveawayRuntimeStateKey(): string {
  const queryVariant = readPreviewGiveawayVariant();
  const enterResult = readPreviewGiveawayEnterResult() ?? 'default';
  return `${PREVIEW_GIVEAWAY_RUNTIME_STATE_KEY}:${queryVariant}:${enterResult}`;
}

function readPreviewGiveawayParticipantVariant(): PreviewGiveawayParticipantVariant {
  const queryVariant = readPreviewGiveawayVariant();
  if (typeof window === 'undefined' || queryVariant !== 'blocked') {
    return queryVariant;
  }

  const override = window.sessionStorage.getItem(buildPreviewGiveawayRuntimeStateKey());
  return override === 'blocked-entered' ? 'blocked-entered' : queryVariant;
}

function writePreviewGiveawayParticipantVariant(variant: PreviewGiveawayParticipantVariant): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.setItem(buildPreviewGiveawayRuntimeStateKey(), variant);
}

function buildPreviewPublicGiveaway(
  state: PreviewState,
  giveawayId: string,
  variant: PreviewGiveawayVariant,
): ManagedGiveawayPublic {
  const now = new Date();
  const sourceChannel = state.channels.find((item) => item.id === PREVIEW_CHANNEL_ID);
  const extraChannel = state.channels.find((item) => item.id === 'preview-channel-2');

  return managedGiveawayPublicSchema.parse({
    id: giveawayId,
    sourceChatId: PREVIEW_CHANNEL_ID,
    sourceTitle: sourceChannel?.title ?? PREVIEW_CHANNEL_TITLE,
    sourceLink: sourceChannel?.link ?? null,
    entityType: 'channel',
    title:
      variant === 'completed'
        ? 'Большой весенний розыгрыш'
        : 'Розыгрыш подарочного бокса для подписчиков',
    description:
      'Подпишитесь на канал, отметьте участие и дождитесь итогов. Победителей определим автоматически, а подтверждение приза пройдёт прямо внутри MAX.',
    status: variant === 'completed' ? 'COMPLETED' : 'ACTIVE',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    startsAt: addHours(now, -20).toISOString(),
    endsAt:
      variant === 'completed' ? addHours(now, -2).toISOString() : addHours(now, 28).toISOString(),
    claimHours: 48,
    requiredChannelIds: extraChannel ? [extraChannel.id] : [],
    requiredChannels: extraChannel
      ? [
          {
            id: extraChannel.id,
            title: extraChannel.title,
            link: extraChannel.link ?? null,
          },
        ]
      : [],
    entriesCount: variant === 'completed' ? 912 : 684,
    winnersCount: 2,
    publishedAt: addHours(now, -19.5).toISOString(),
    completedAt: variant === 'completed' ? addHours(now, -1.5).toISOString() : null,
    publicationUrl: 'https://max.ru/giveaway/public-preview',
    resultsUrl: variant === 'completed' ? 'https://max.ru/giveaway/public-preview/results' : null,
    prizes: [
      { id: 'public-prize-1', position: 1, title: 'Подарочный бокс MAX' },
      { id: 'public-prize-2', position: 2, title: 'Премиум-подписка на 3 месяца' },
    ],
    winners:
      variant === 'completed'
        ? [
            {
              prizePosition: 1,
              prizeTitle: 'Подарочный бокс MAX',
              displayName: 'Марина Орлова',
              status: 'CLAIMED',
            },
            {
              prizePosition: 2,
              prizeTitle: 'Премиум-подписка на 3 месяца',
              displayName: 'Дмитрий Ковалёв',
              status: 'DELIVERED',
            },
          ]
        : [],
  });
}

function buildPreviewGiveawayParticipantState(
  variant: PreviewGiveawayParticipantVariant,
): ManagedGiveawayParticipantState {
  const now = new Date();

  if (variant === 'winner') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-winner',
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      joinedAt: addHours(now, -12).toISOString(),
      isWinner: true,
      winnerId: 'preview-winner-1',
      winnerStatus: 'CLAIMED',
      claimDeadlineAt: null,
      prizePosition: 1,
      prizeTitle: 'Подарочный бокс MAX',
      canClaim: false,
      claimBotUrl: null,
    });
  }

  if (variant === 'joined') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-joined',
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      joinedAt: addHours(now, -4).toISOString(),
      isWinner: false,
      winnerId: null,
      winnerStatus: null,
      claimDeadlineAt: null,
      prizePosition: null,
      prizeTitle: null,
      canClaim: false,
      claimBotUrl: null,
    });
  }

  if (variant === 'completed') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-completed',
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      joinedAt: addHours(now, -18).toISOString(),
      isWinner: false,
      winnerId: null,
      winnerStatus: null,
      claimDeadlineAt: null,
      prizePosition: null,
      prizeTitle: null,
      canClaim: false,
      claimBotUrl: null,
    });
  }

  if (variant === 'blocked-entered') {
    return managedGiveawayParticipantStateSchema.parse({
      joined: true,
      entryId: 'preview-entry-blocked',
      eligibilityState: 'REJECTED',
      eligibilityReason: 'Подписка на обязательный канал не подтверждена.',
      missingChannelIds: ['preview-channel-2'],
      joinedAt: addHours(now, -0.2).toISOString(),
      isWinner: false,
      winnerId: null,
      winnerStatus: null,
      claimDeadlineAt: null,
      prizePosition: null,
      prizeTitle: null,
      canClaim: false,
      claimBotUrl: null,
    });
  }

  return managedGiveawayParticipantStateSchema.parse({
    joined: false,
    entryId: null,
    eligibilityState: null,
    eligibilityReason: null,
    missingChannelIds: [],
    joinedAt: null,
    isWinner: false,
    winnerId: null,
    winnerStatus: null,
    claimDeadlineAt: null,
    prizePosition: null,
    prizeTitle: null,
    canClaim: false,
    claimBotUrl: null,
  });
}

function resolveChatTitle(chatId: string, state: PreviewState): string {
  return state.chats.find((item) => item.id === chatId)?.title ?? PREVIEW_CHAT_TITLE;
}

function resolveChatAvatarUrl(chatId: string, state: PreviewState): string | null {
  return state.chats.find((item) => item.id === chatId)?.avatarUrl ?? null;
}

function resolveChannelTitle(channelId: string, state: PreviewState): string {
  return state.channels.find((item) => item.id === channelId)?.title ?? PREVIEW_CHANNEL_TITLE;
}

function resolveChannelAvatarUrl(channelId: string, state: PreviewState): string | null {
  return state.channels.find((item) => item.id === channelId)?.avatarUrl ?? null;
}

function buildPreviewDialogMessage(payload: {
  id: string;
  type: ChannelDialogType;
  text: string;
  authorUserId: string;
  authorDisplayName: string | null;
  isAdmin?: boolean;
  avatarUrl?: string | null;
  createdAt: string;
  replyToMessageId?: string | null;
  replyTo?: ChannelDialogMessage['replyTo'];
  reactionGroups?: ChannelDialogMessage['reactionGroups'];
  delivered?: boolean;
  deliveredToUserId?: string | null;
  reviewStatus?: ChannelDialogMessage['reviewStatus'];
  publishedUrl?: string | null;
  hasImage?: boolean;
  imageFileName?: string | null;
}): ChannelDialogMessage {
  return channelDialogMessageSchema.parse({
    id: payload.id,
    type: payload.type,
    text: payload.text,
    authorUserId: payload.authorUserId,
    authorDisplayName: payload.authorDisplayName,
    isAdmin: payload.isAdmin ?? payload.authorUserId.startsWith('preview-admin'),
    avatarUrl: payload.avatarUrl ?? null,
    createdAt: payload.createdAt,
    ...(payload.replyToMessageId !== undefined
      ? { replyToMessageId: payload.replyToMessageId }
      : {}),
    ...(payload.replyTo !== undefined ? { replyTo: payload.replyTo } : {}),
    ...(payload.reactionGroups !== undefined ? { reactionGroups: payload.reactionGroups } : {}),
    ...(payload.delivered !== undefined ? { delivered: payload.delivered } : {}),
    ...(payload.deliveredToUserId !== undefined
      ? { deliveredToUserId: payload.deliveredToUserId }
      : {}),
    ...(payload.reviewStatus !== undefined ? { reviewStatus: payload.reviewStatus } : {}),
    ...(payload.publishedUrl !== undefined ? { publishedUrl: payload.publishedUrl } : {}),
    ...(payload.hasImage !== undefined ? { hasImage: payload.hasImage } : {}),
    ...(payload.imageFileName !== undefined ? { imageFileName: payload.imageFileName } : {}),
  });
}

function findPreviewDialogMessage(
  bucket: PreviewDialogBucket,
  messageId: string | null | undefined,
): ChannelDialogMessage | null {
  const normalizedMessageId = messageId?.trim() ?? '';
  if (!normalizedMessageId) {
    return null;
  }

  return bucket.messages.find((message) => message.id === normalizedMessageId) ?? null;
}

function togglePreviewDialogReaction(
  bucket: PreviewDialogBucket,
  messageId: string,
  emoji: string,
): ChannelDialogMessage {
  const nextMessages = bucket.messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    const existingGroups = message.reactionGroups ?? [];
    const reactedEmoji = existingGroups.find((group) => group.reactedByMe)?.emoji ?? null;
    const nextGroups = existingGroups
      .map((group) => {
        if (group.reactedByMe) {
          const nextCount = group.count - 1;
          return nextCount > 0 ? { ...group, count: nextCount, reactedByMe: false } : null;
        }

        if (reactedEmoji === emoji || group.emoji !== emoji) {
          return group;
        }

        return {
          ...group,
          count: group.count + 1,
          reactedByMe: true,
        };
      })
      .filter((group): group is NonNullable<typeof group> => group !== null);

    if (reactedEmoji !== emoji && !nextGroups.some((group) => group.emoji === emoji)) {
      nextGroups.push({
        emoji,
        count: 1,
        reactedByMe: true,
      });
    }

    const normalizedGroups = nextGroups.sort(
      (left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji),
    );

    return channelDialogMessageSchema.parse({
      ...message,
      reactionGroups: normalizedGroups,
    });
  });

  bucket.messages = nextMessages;
  return bucket.messages.find((message) => message.id === messageId) ?? bucket.messages.at(-1)!;
}

function buildPreviewDialogResponse(
  chatId: string,
  dialogType: ChannelDialogType,
  bucket: PreviewDialogBucket,
): ChannelDialogResponse {
  const previewThreadVariant =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('thread')?.trim().toLowerCase()
      : null;
  const normalizedBucket =
    dialogType === 'comments' && previewThreadVariant === 'short'
      ? {
          ...bucket,
          messages: bucket.messages.slice(-2),
        }
      : bucket;

  return channelDialogResponseSchema.parse({
    chatId,
    type: dialogType,
    introText: normalizedBucket.introText,
    messages: normalizedBucket.messages,
  });
}

function buildPreviewAvatarDataUrl(label: string, startColor: string, endColor: string): string {
  const initials = buildAuthorBadge(label);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
      <defs>
        <linearGradient id="avatar-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${startColor}" />
          <stop offset="100%" stop-color="${endColor}" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="28" fill="url(#avatar-gradient)" />
      <text
        x="50%"
        y="52%"
        dominant-baseline="middle"
        text-anchor="middle"
        font-family="Manrope, Arial, sans-serif"
        font-size="34"
        font-weight="700"
        fill="#ffffff"
      >${initials}</text>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function buildPreviewProfileUrl(handle: string): string {
  return `https://max.ru/${encodeURIComponent(handle)}`;
}

function buildPreviewProfileHandoffUrl(seed: string): string {
  return `https://max.ru/id613002203036_bot?start=${encodeURIComponent(`preview-profile-${seed}`)}`;
}

function createActivityItems(
  prefix: string,
  names: string[],
  now: Date,
  offsetsHours: number[],
): MembershipActivityItem[] {
  const avatarPalette = [
    ['#4d94ff', '#2b64dd'],
    ['#3cc58b', '#0f9f70'],
    ['#f1a44b', '#ea7b4b'],
    ['#7f7dff', '#5350da'],
  ] as const;

  return offsetsHours
    .map((offsetHours, index) => {
      const displayName = names[index % names.length] ?? `Участник ${index + 1}`;
      const [startColor, endColor] = avatarPalette[index % avatarPalette.length] ?? [
        '#4d94ff',
        '#2b64dd',
      ];

      return {
        id: `${prefix}-${index + 1}`,
        type: (index % 3 === 1 ? 'left' : 'joined') as MembershipActivityItem['type'],
        userId: `${prefix}-user-${index + 1}`,
        userDisplayName: displayName,
        avatarUrl: buildPreviewAvatarDataUrl(displayName, startColor, endColor),
        profileUrl: buildPreviewProfileUrl(`${prefix}-profile-${index + 1}`),
        profileHandoffUrl: buildPreviewProfileHandoffUrl(`${prefix}-${index + 1}`),
        createdAt: addHours(now, -offsetHours).toISOString(),
      };
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function createChatViolations(now: Date): LogsDashboardResponse['violations'] {
  const base = [
    {
      id: 'violation-1',
      action: 'MUTE' as const,
      ruleCode: 'COMMERCIAL_AD',
      userId: 'preview-spammer-1',
      userDisplayName: 'Сергей Маркет',
      avatarUrl: buildPreviewAvatarDataUrl('Сергей Маркет', '#4d94ff', '#2b64dd'),
      profileUrl: buildPreviewProfileUrl('sergey-market'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('sergey-market'),
      createdAt: addHours(now, -1.5).toISOString(),
      maskedExcerpt: 'Переходите по ссылке и получайте скидку ***',
      metadata: { muteDurationHours: 24, muteExpiresAt: addHours(now, 22.5).toISOString() },
    },
    {
      id: 'violation-2',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'LINK_BLOCKED',
      userId: 'preview-spammer-2',
      userDisplayName: 'Мария Ссылкина',
      avatarUrl: buildPreviewAvatarDataUrl('Мария Ссылкина', '#3cc58b', '#0f9f70'),
      profileUrl: buildPreviewProfileUrl('maria-links'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('maria-links'),
      createdAt: addHours(now, -3.2).toISOString(),
      maskedExcerpt: 'Подписывайтесь на мой канал ***',
      metadata: null,
    },
    {
      id: 'violation-3',
      action: 'WARN' as const,
      ruleCode: 'PROFANITY',
      userId: 'preview-user-3',
      userDisplayName: 'Антон',
      avatarUrl: buildPreviewAvatarDataUrl('Антон', '#7f7dff', '#5350da'),
      profileUrl: buildPreviewProfileUrl('anton-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('anton-preview'),
      createdAt: addHours(now, -6.8).toISOString(),
      maskedExcerpt: 'Это было очень ***',
      metadata: null,
    },
    {
      id: 'violation-4',
      action: 'BAN' as const,
      ruleCode: 'GLOBAL_CROSS_CHAT_SPAM',
      userId: 'preview-user-4',
      userDisplayName: 'Инфо Буст',
      avatarUrl: buildPreviewAvatarDataUrl('Инфо Буст', '#f1a44b', '#ea7b4b'),
      profileUrl: buildPreviewProfileUrl('info-boost'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('info-boost'),
      createdAt: addHours(now, -14.1).toISOString(),
      maskedExcerpt: 'Повторный оффер с внешней ссылкой ***',
      metadata: null,
    },
    {
      id: 'violation-5',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'MESSAGE_TOO_LONG',
      userId: 'preview-user-5',
      userDisplayName: 'Юлия',
      avatarUrl: buildPreviewAvatarDataUrl('Юлия', '#ff82a8', '#eb577f'),
      profileUrl: buildPreviewProfileUrl('yulia-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('yulia-preview'),
      createdAt: addHours(now, -27).toISOString(),
      maskedExcerpt: 'Очень длинное сообщение ***',
      metadata: null,
    },
    {
      id: 'violation-6',
      action: 'MUTE' as const,
      ruleCode: 'DUPLICATE_BAN',
      userId: 'preview-user-6',
      userDisplayName: 'Олег Повтор',
      avatarUrl: buildPreviewAvatarDataUrl('Олег Повтор', '#7db8ff', '#4d89ff'),
      profileUrl: buildPreviewProfileUrl('oleg-repeat'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('oleg-repeat'),
      createdAt: addHours(now, -42).toISOString(),
      maskedExcerpt: 'Одинаковый текст ***',
      metadata: { muteDurationHours: 12, muteExpiresAt: addHours(now, -30).toISOString() },
    },
    {
      id: 'violation-7',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'NIGHT_MODE_DELETE',
      userId: 'preview-user-7',
      userDisplayName: 'Ночной гость',
      avatarUrl: buildPreviewAvatarDataUrl('Ночной гость', '#485a7b', '#22344f'),
      profileUrl: buildPreviewProfileUrl('night-guest'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('night-guest'),
      createdAt: addHours(now, -73).toISOString(),
      maskedExcerpt: 'Сообщение ночью ***',
      metadata: null,
    },
    {
      id: 'violation-8',
      action: 'WARN' as const,
      ruleCode: 'THEMATIC_FILTER',
      userId: 'preview-user-8',
      userDisplayName: 'Павел',
      avatarUrl: buildPreviewAvatarDataUrl('Павел', '#5ab7b5', '#1b7f8a'),
      profileUrl: buildPreviewProfileUrl('pavel-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('pavel-preview'),
      createdAt: addHours(now, -110).toISOString(),
      maskedExcerpt: 'Не по теме ***',
      metadata: null,
    },
    {
      id: 'violation-9',
      action: 'NONE' as const,
      ruleCode: 'MANUAL_UNBAN',
      userId: 'preview-user-9',
      userDisplayName: 'Ольга',
      avatarUrl: buildPreviewAvatarDataUrl('Ольга', '#f1a44b', '#ea7b4b'),
      profileUrl: buildPreviewProfileUrl('olga-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('olga-preview'),
      createdAt: addHours(now, -180).toISOString(),
      maskedExcerpt: null,
      metadata: null,
    },
    {
      id: 'violation-10',
      action: 'MUTE' as const,
      ruleCode: 'MANUAL_MUTE',
      userId: 'preview-user-10',
      userDisplayName: 'Андрей',
      avatarUrl: buildPreviewAvatarDataUrl('Андрей', '#4d94ff', '#2b64dd'),
      profileUrl: buildPreviewProfileUrl('andrey-preview'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('andrey-preview'),
      createdAt: addHours(now, -220).toISOString(),
      maskedExcerpt: null,
      metadata: null,
    },
  ];

  return base.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function createInitialState(): PreviewState {
  const now = new Date();
  const chatSettings = chatSettingsSchema.parse({
    greetingEnabled: false,
    greetingBotMessageEnabled: false,
    greetingDeleteBotMessageEnabled: false,
    greetingDeleteBotMessageDelayMinutes: 2,
    greetingBotMessageText: 'Добро пожаловать в чат. Ознакомьтесь с правилами и пишите по делу.',
    greetingRulesButtonEnabled: false,
    linkPolicy: 'ALLOWLIST_ONLY',
    antiSpamEnabled: true,
    deleteSpammersEnabled: true,
    russianProfanityFilterEnabled: true,
    commercialAdsFilterEnabled: true,
    commercialAdsSensitivity: 'BALANCED',
    profanityWarnEnabled: true,
    textFiltersWarnEnabled: true,
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    nightModeEnabled: true,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: 'Ночью чат закрыт. Напишите утром.',
    messageLimitsBlockedWords: ['казино', 'ставки', 'скидка'],
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: [PREVIEW_CHANNEL_ID, 'preview-channel-2'],
    requiredSubscriptionBotMessageEnabled: true,
    requiredSubscriptionBotMessageText:
      'Для сообщений в этом чате нужна подписка на {channels}. Подпишитесь и отправьте сообщение ещё раз. Статус: {message_status}.',
    requiredSubscriptionWarnEnabled: true,
    requiredSubscriptionBanEnabled: true,
    requiredSubscriptionMuteEnabled: true,
    duplicateMuteDurationHours: 24,
    linkMuteDurationHours: 24,
    messageLimitsMuteDurationHours: 12,
    profanityMuteDurationHours: 6,
    requiredSubscriptionMuteDurationHours: 24,
    textFiltersMuteDurationHours: 24,
    thematicFiltersMuteDurationHours: 12,
    commentsEnabled: true,
    commentsAdminsEnabled: true,
    commentsAllEnabled: false,
    commentsChatBroadcastsEnabled: true,
    muteDurationHours: 12,
    warnThreshold: 2,
  });
  const chatRules = chatRulesSchema.parse({
    text: '1. Без рекламы.\n2. Без токсичности.\n3. Без повторов.\n4. Уважайте соседей.',
    autoTextEnabled: true,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    publishedMessageId: 'rules-preview-1',
    publishedUrl: 'https://max.ru/community/rules-preview',
    publishedAt: addHours(now, -26).toISOString(),
  });
  const chatDomains = [
    domainAllowlistEntrySchema.parse({
      domain: 'https://maxim.play-team.ru',
      normalizedValue: 'https://maxim.play-team.ru',
      matchType: 'EXACT',
      removeAfterAt: null,
    }),
    domainAllowlistEntrySchema.parse({
      domain: 'docs.max.ru',
      normalizedValue: 'domain:docs.max.ru',
      matchType: 'DOMAIN',
      removeAfterAt: addDays(now, 2).toISOString(),
    }),
  ];
  const chatPoll = managedPollSchema.parse({
    question: 'Нужен ли тихий режим после 22:00?',
    options: ['Да', 'Нет', 'Тест на неделю'],
    status: 'ACTIVE',
    activeVersion: 2,
    publishedMessageId: 'poll-preview-1',
    publishedUrl: 'https://max.ru/poll/preview-1',
    publishedAt: addHours(now, -8).toISOString(),
    closedAt: null,
    totalVotes: 94,
    optionResults: [
      { option: 'Да', votes: 52, percent: 55 },
      { option: 'Нет', votes: 21, percent: 22 },
      { option: 'Тест на неделю', votes: 21, percent: 22 },
    ],
  });
  const chatBroadcasts = [
    managedBroadcastDetailsSchema.parse({
      id: 'broadcast-preview-1',
      status: 'ACTIVE',
      text: 'Напоминаем: в субботу уборка двора в 11:00. Приходите с перчатками.',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: [PREVIEW_CHAT_ID],
      buttonEnabled: true,
      buttonUrl: 'https://maxim.play-team.ru/help',
      buttonText: 'Подробности',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        addHours(now, 18).toISOString(),
        addDays(now, 1).toISOString(),
        addDays(now, 2).toISOString(),
      ],
      nextSendAt: addHours(now, 18).toISOString(),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 3,
      sentCount: 1,
      currentOccurrence: 2,
      deliveredChats: 1,
      failedChats: 0,
      pendingChats: 0,
      canRetry: false,
      remainingCount: 2,
      createdAt: addHours(now, -36).toISOString(),
      updatedAt: addHours(now, -3).toISOString(),
      lastError: null,
    }),
  ];
  const chatGiveaways = [
    managedGiveawayDetailsSchema.parse({
      id: 'giveaway-chat-1',
      title: 'Субботний розыгрыш двора',
      status: 'DRAFT',
      hasImage: false,
      entriesCount: 0,
      verifiedEntriesCount: 0,
      pendingEntriesCount: 0,
      winnersCount: 0,
      startsAt: null,
      endsAt: addHours(now, 30).toISOString(),
      publishedAt: null,
      completedAt: null,
      publicationUrl: null,
      resultsUrl: null,
      createdAt: addDays(now, -4).toISOString(),
      updatedAt: addHours(now, -1).toISOString(),
      sourceChatId: PREVIEW_CHAT_ID,
      entityType: 'chat',
      description:
        'Полностью пользовательский текст публикации из чат-бота. Без шаблонных дописок.',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      claimHours: 48,
      requiredChannelIds: [PREVIEW_CHANNEL_ID],
      publicationMessageId: null,
      resultsMessageId: null,
      prizes: [
        { id: 'prize-chat-1', position: 1, title: 'Набор перчаток' },
        { id: 'prize-chat-2', position: 2, title: 'Секатор' },
      ],
      winners: [],
    }),
  ];
  const channelSettings = channelSettingsSchema.parse({
    commentsEnabled: true,
    commentsModerationEnabled: true,
    commentsBlockLinksEnabled: true,
    commentsAntiSpamEnabled: true,
    commentsLimitTwoInRowEnabled: true,
    postSuggestionsEnabled: true,
    postSuggestionsText: 'Пришлите идею поста или важную новость для соседей.',
    postSuggestionsDailyLimit: 4,
    postSuggestionsButtonEnabled: true,
    postSuggestionsButtonText: 'Предложить пост',
    postSuggestionsButtonUrl: 'https://maxim.play-team.ru/suggest',
    engagementMessageText: 'Есть идея или обратная связь? Выберите действие ниже.',
    autoPostButtonsMode: 'BOTH',
  });
  const channelPoll = managedPollSchema.parse({
    question: 'Какой формат постов удобнее?',
    options: ['Короткие', 'Подробные', 'Микс'],
    status: 'DRAFT',
    activeVersion: 1,
    publishedMessageId: null,
    publishedUrl: null,
    publishedAt: null,
    closedAt: null,
    totalVotes: 0,
    optionResults: [],
  });
  const channelGiveaways = [
    managedGiveawayDetailsSchema.parse({
      id: 'giveaway-channel-1',
      title: 'Розыгрыш мерча',
      status: 'SCHEDULED',
      hasImage: false,
      entriesCount: 0,
      verifiedEntriesCount: 0,
      pendingEntriesCount: 0,
      winnersCount: 1,
      startsAt: addHours(now, 12).toISOString(),
      endsAt: addDays(now, 4).toISOString(),
      publishedAt: null,
      completedAt: null,
      publicationUrl: null,
      resultsUrl: null,
      createdAt: addDays(now, -2).toISOString(),
      updatedAt: addHours(now, -4).toISOString(),
      sourceChatId: PREVIEW_CHANNEL_ID,
      entityType: 'channel',
      description: 'Тестовый розыгрыш среди подписчиков канала.',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      claimHours: 24,
      requiredChannelIds: [PREVIEW_CHANNEL_ID],
      publicationMessageId: null,
      resultsMessageId: null,
      prizes: [{ id: 'prize-channel-1', position: 1, title: 'Фирменная кружка' }],
      winners: [],
    }),
  ];
  const channelBroadcasts = [
    managedBroadcastDetailsSchema.parse({
      id: 'broadcast-channel-1',
      status: 'ACTIVE',
      text: 'Сегодня публикуем подборку событий района. Проверьте расписание и переходите в канал.',
      textFormat: 'markdown',
      applyToAllChats: false,
      targetChatIds: [PREVIEW_CHANNEL_ID],
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/channels/yuzhnoe-news',
      buttonText: 'Открыть канал',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        addHours(now, 10).toISOString(),
        addHours(now, 14).toISOString(),
        addHours(now, 19).toISOString(),
        addDays(now, 1).toISOString(),
      ],
      nextSendAt: addHours(now, 10).toISOString(),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 4,
      sentCount: 0,
      currentOccurrence: 1,
      deliveredChats: 0,
      failedChats: 0,
      pendingChats: 1,
      canRetry: false,
      remainingCount: 4,
      createdAt: addHours(now, -20).toISOString(),
      updatedAt: addHours(now, -1).toISOString(),
      lastError: null,
    }),
  ];
  const chatDialogs: Record<ChannelDialogType, PreviewDialogBucket> = {
    comments: {
      introText:
        'Тихий тред к сообщению админа: короткие ответы, без флуда, ссылки режет модерация.',
      messages: [
        buildPreviewDialogMessage({
          id: 'chat-comments-1',
          type: 'comments',
          text: 'Сделал компактную парковку для самокатов у 3-го подъезда. Проверьте, не мешает ли проходу.',
          authorUserId: 'preview-admin-2',
          authorDisplayName: 'Александр',
          avatarUrl: buildPreviewAvatarDataUrl('Александр', '#4d94ff', '#2b64dd'),
          createdAt: addHours(now, -5.2).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-2',
          type: 'comments',
          text: 'Смотрится аккуратно. Если добавить отражатель со стороны дорожки, вечером будет безопаснее.',
          authorUserId: 'preview-user-8',
          authorDisplayName: 'Марина Орлова',
          avatarUrl: buildPreviewAvatarDataUrl('Марина Орлова', '#3cc58b', '#0f9f70'),
          createdAt: addHours(now, -4.8).toISOString(),
          reactionGroups: [
            { emoji: '👍', count: 3, reactedByMe: false },
            { emoji: '🔥', count: 1, reactedByMe: false },
          ],
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-3',
          type: 'comments',
          text: 'Поддерживаю. Утром с коляской стало свободнее, раньше самокаты лежали прямо у перил.',
          authorUserId: 'preview-user-4',
          authorDisplayName: 'Наталья',
          avatarUrl: buildPreviewAvatarDataUrl('Наталья', '#6aa8ff', '#3b7ef0'),
          createdAt: addHours(now, -4.5).toISOString(),
          reactionGroups: [{ emoji: '👀', count: 2, reactedByMe: true }],
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-4',
          type: 'comments',
          text: 'Добавлю светоотражающую ленту и перенесу стойку на полметра ближе к клумбе.',
          authorUserId: 'preview-admin-2',
          authorDisplayName: 'Александр',
          avatarUrl: buildPreviewAvatarDataUrl('Александр', '#4d94ff', '#2b64dd'),
          createdAt: addHours(now, -4.1).toISOString(),
          replyToMessageId: 'chat-comments-2',
          replyTo: {
            messageId: 'chat-comments-2',
            authorDisplayName: 'Марина Орлова',
            text: 'Смотрится аккуратно. Если добавить отражатель со стороны дорожки, вечером будет безопаснее.',
          },
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-5',
          type: 'comments',
          text: 'Отлично. Тогда оставим тестом на неделю и посмотрим, как поведёт себя поток вечером.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -3.9).toISOString(),
          reactionGroups: [{ emoji: '❤️', count: 4, reactedByMe: false }],
        }),
      ],
    },
    suggest: {
      introText:
        'Идеи для постов приходят тихо: участник отправляет карточку, редактор видит её в своей очереди.\n\nДобавьте короткий контекст, фото или видео, чтобы редактору было проще быстро принять решение.',
      messages: [
        buildPreviewDialogMessage({
          id: 'chat-suggest-1',
          type: 'suggest',
          text: 'Можно сделать короткий пост про новые контейнеры для батареек у офиса управляющей компании.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -7.2).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'pending',
        }),
        buildPreviewDialogMessage({
          id: 'chat-suggest-2',
          type: 'suggest',
          text: '',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -2.9).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'published',
          publishedUrl: 'https://max.ru/chats/preview-chat/message/220',
          hasImage: true,
          imageFileName: 'containers.webp',
        }),
      ],
    },
  };
  const channelDialogs: Record<ChannelDialogType, PreviewDialogBucket> = {
    comments: {
      introText:
        'Комментарии к посту канала идут отдельным потоком, чтобы лента канала оставалась чистой.',
      messages: [
        buildPreviewDialogMessage({
          id: 'channel-comments-1',
          type: 'comments',
          text: 'Спасибо за карту отключений. Наконец-то видно точный интервал по улице Сиреневой.',
          authorUserId: 'preview-user-11',
          authorDisplayName: 'Татьяна',
          avatarUrl: buildPreviewAvatarDataUrl('Татьяна', '#f1a44b', '#ea7b4b'),
          createdAt: addHours(now, -10.5).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'channel-comments-2',
          type: 'comments',
          text: 'Если добавите следующий апдейт про развоз воды, закрепите его в начале треда.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -9.8).toISOString(),
          reactionGroups: [{ emoji: '👍', count: 6, reactedByMe: true }],
        }),
      ],
    },
    suggest: {
      introText:
        'Предложение поста сразу уходит редактору канала.\n\nМожно приложить фото или видео и потом отследить статус прямо здесь.',
      messages: [
        buildPreviewDialogMessage({
          id: 'channel-suggest-1',
          type: 'suggest',
          text: 'Подборка ярмарок выходного дня отлично зайдёт на воскресенье утром.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -6.4).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'pending',
        }),
        buildPreviewDialogMessage({
          id: 'channel-suggest-2',
          type: 'suggest',
          text: 'Сделайте пост про вечерний маркет у набережной, люди всё ещё спрашивают время работы.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -3.1).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'published',
          publishedUrl: 'https://max.ru/chats/preview-channel/message/318',
        }),
        buildPreviewDialogMessage({
          id: 'channel-suggest-3',
          type: 'suggest',
          text: '',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -1.4).toISOString(),
          delivered: false,
          deliveredToUserId: null,
          reviewStatus: 'pending',
          hasImage: true,
          imageFileName: 'market-evening.webp',
        }),
        buildPreviewDialogMessage({
          id: 'channel-suggest-4',
          type: 'suggest',
          text: 'Можно собрать подборку новых кофеен у метро, но без цен это сейчас сыровато.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -0.8).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'cancelled',
        }),
      ],
    },
  };

  return {
    me: {
      userId: 'preview-admin',
      username: 'designer',
      displayName: 'Алексей',
      avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
      profileUrl: buildPreviewProfileUrl('designer'),
      canAccessSystem: true,
    },
    systemModeSelection: 'auto',
    chats: [
      {
        id: PREVIEW_CHAT_ID,
        title: PREVIEW_CHAT_TITLE,
        createdAt: addDays(now, -280).toISOString(),
        entityType: 'chat',
        link: null,
        avatarUrl: buildPreviewAvatarDataUrl(PREVIEW_CHAT_TITLE, '#20b7aa', '#117e87'),
        channelOverview: null,
      },
      {
        id: 'preview-chat-2',
        title: 'Клуб соседей',
        createdAt: addDays(now, -120).toISOString(),
        entityType: 'chat',
        link: null,
        avatarUrl: buildPreviewAvatarDataUrl('Клуб соседей', '#6a8cff', '#4b55dd'),
        channelOverview: null,
      },
    ],
    channels: [
      {
        id: PREVIEW_CHANNEL_ID,
        title: PREVIEW_CHANNEL_TITLE,
        createdAt: addDays(now, -250).toISOString(),
        entityType: 'channel',
        link: 'https://max.ru/channels/yuzhnoe-news',
        avatarUrl: buildPreviewAvatarDataUrl(PREVIEW_CHANNEL_TITLE, '#4f69ff', '#2d3fd5'),
        channelOverview: {
          enabledScenariosCount: 2,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
        },
      },
      {
        id: 'preview-channel-2',
        title: 'Афиша района',
        createdAt: addDays(now, -90).toISOString(),
        entityType: 'channel',
        link: 'https://max.ru/channels/afisha',
        avatarUrl: buildPreviewAvatarDataUrl('Афиша района', '#7d56f6', '#5c2fd6'),
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ],
    chatHeaderParticipantsCount: 1_584,
    chatDialogs,
    chatSettings,
    chatRules,
    chatDomains,
    chatPoll,
    chatBroadcasts,
    chatGiveaways,
    chatActivity: createActivityItems(
      'chat-activity',
      ['Ольга Бойко', 'Юлия', 'Андрей Фёдоров', 'Марина', 'Александр', 'Наталья'],
      now,
      [
        0.3, 1.2, 2.8, 4.1, 6.7, 8.9, 10.5, 12.4, 14.3, 18.8, 23.5, 26.2, 31.7, 36.1, 44.2, 55.6,
        63.4, 78.5, 92.1, 110.4, 136.2, 158.7, 175.9, 212.8, 250.3, 310.1, 420.6, 560.8,
      ],
    ),
    chatViolations: createChatViolations(now),
    channelHeaderParticipantsCount: 9_240,
    channelDialogs,
    channelSettings,
    channelPoll,
    channelBroadcasts,
    channelGiveaways,
    channelActivity: createActivityItems(
      'channel-activity',
      ['Владимир', 'Татьяна', 'Ирина', 'Дмитрий', 'Елена', 'Максим'],
      addHours(now, -1),
      [
        0.6, 1.4, 2.2, 3.8, 5.6, 7.3, 9.1, 11.8, 13.4, 17.7, 21.2, 26.5, 33.9, 40.2, 47.8, 58.1,
        70.3, 88.4, 112.6, 138.8, 166.2, 199.1, 240.5, 296.2, 352.7, 490.4,
      ],
    ),
  };
}

function buildChatSettingsScreen(state: PreviewState, chatId: string): ChatSettingsScreenResponse {
  return chatSettingsScreenResponseSchema.parse({
    settings: state.chatSettings,
    rules: state.chatRules,
    header: {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      entityType: 'chat',
      link: null,
      participantsCount: state.chatHeaderParticipantsCount,
      avatarUrl: resolveChatAvatarUrl(chatId, state),
    },
    requiredSubscriptionChannels: (state.chatSettings.requiredSubscriptionChannelIds ?? []).map(
      (channelId) => {
        const channel = state.channels.find((item) => item.id === channelId);
        return {
          id: channelId,
          title: channel?.title ?? resolveChannelTitle(channelId, state),
          entityType: 'channel',
          link: channel?.link ?? null,
          participantsCount: null,
          avatarUrl: channel?.avatarUrl ?? resolveChannelAvatarUrl(channelId, state),
        };
      },
    ),
    domains: state.chatDomains,
    managedBroadcasts: state.chatBroadcasts.map(buildBroadcastSummary),
  });
}

function buildChannelSettingsScreen(
  state: PreviewState,
  channelId: string,
): ChannelSettingsScreenResponse {
  return channelSettingsScreenResponseSchema.parse({
    settings: state.channelSettings,
    header: {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      entityType: 'channel',
      link: 'https://max.ru/channels/yuzhnoe-news',
      participantsCount: state.channelHeaderParticipantsCount,
      avatarUrl: resolveChannelAvatarUrl(channelId, state),
    },
    managedBroadcasts: state.channelBroadcasts.map(buildBroadcastSummary),
  });
}

function buildLogsDashboard(
  state: PreviewState,
  chatId: string,
  range: LogsDashboardRange,
): LogsDashboardResponse {
  const now = new Date();
  const violations = state.chatViolations.filter((item) =>
    isWithinRange(item.createdAt, range, now),
  );
  const membershipItems = filterActivityItems(state.chatActivity, range, 'all', now);
  const joinedUsers = membershipItems.filter((item) => item.type === 'joined').length;
  const leftUsers = membershipItems.filter((item) => item.type === 'left').length;
  const summary = violations.reduce(
    (accumulator, item) => {
      if (item.ruleCode === 'MANUAL_UNMUTE') {
        accumulator.unmute += 1;
      } else if (item.ruleCode === 'MANUAL_UNBAN') {
        accumulator.unban += 1;
      } else if (item.action === 'WARN') {
        accumulator.warn += 1;
      } else if (item.action === 'DELETE_MESSAGE') {
        accumulator.deleteMessage += 1;
      } else if (item.action === 'MUTE') {
        accumulator.mute += 1;
      } else if (item.action === 'KICK' || item.action === 'BAN') {
        accumulator.ban += 1;
      }

      accumulator.users.add(item.userId);
      return accumulator;
    },
    {
      warn: 0,
      deleteMessage: 0,
      mute: 0,
      ban: 0,
      unmute: 0,
      unban: 0,
      users: new Set<string>(),
    },
  );
  const { from, to } = resolveRangeWindow(range, now);

  return logsDashboardResponseSchema.parse({
    chat: {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      avatarUrl: resolveChatAvatarUrl(chatId, state),
    },
    period: {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    membership: {
      joinedUsers,
      leftUsers,
      netUsers: joinedUsers - leftUsers,
    },
    violationsSummary: {
      warn: summary.warn,
      deleteMessage: summary.deleteMessage,
      mute: summary.mute,
      ban: summary.ban,
      unmute: summary.unmute,
      unban: summary.unban,
      affectedUsers: summary.users.size,
      total: violations.length,
    },
    violations,
    activityFeed: buildActivityPage(state.chatActivity, { range, limit: 50 }, now),
  });
}

function buildChannelStats(state: PreviewState, channelId: string, range: ChannelStatsRange) {
  const now = new Date();
  const activityItems = filterActivityItems(state.channelActivity, range, 'all', now);
  const joined = activityItems.filter((item) => item.type === 'joined').length;
  const left = activityItems.filter((item) => item.type === 'left').length;
  const { from, to } = resolveRangeWindow(range, now);
  const points = range === '24h' ? 12 : range === '7d' ? 8 : 10;
  const stepMs = Math.max(1, (to.getTime() - from.getTime()) / Math.max(1, points - 1));

  function distributeTotal(total: number, weights: number[]): number[] {
    if (total <= 0) {
      return Array.from({ length: weights.length }, () => 0);
    }

    const safeWeights = weights.map((weight) => Math.max(0, weight));
    const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
    if (totalWeight <= 0) {
      const fallback = Array.from({ length: weights.length }, () => 0);
      for (let index = 0; index < total; index += 1) {
        fallback[index % fallback.length] += 1;
      }
      return fallback;
    }

    const raw = safeWeights.map((weight) => (weight / totalWeight) * total);
    const distributed = raw.map((value) => Math.floor(value));
    let remainder = total - distributed.reduce((sum, value) => sum + value, 0);
    const fractions = raw
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((leftItem, rightItem) => rightItem.fraction - leftItem.fraction);

    for (let index = 0; index < fractions.length && remainder > 0; index += 1) {
      distributed[fractions[index]!.index] += 1;
      remainder -= 1;
    }

    return distributed;
  }

  const joinedWeights = Array.from({ length: points }, (_, index) => {
    const progress = points > 1 ? index / (points - 1) : 0;
    return 1 + progress * (range === '24h' ? 0.45 : 0.9);
  });
  const leftWeights = Array.from({ length: points }, (_, index) => {
    if (index % 4 === 0) {
      return range === '24h' ? 0.2 : 0.25;
    }

    const progress = points > 1 ? index / (points - 1) : 0;
    return 0.75 + (1 - progress) * 0.45;
  });
  const joinedDistribution = distributeTotal(joined, joinedWeights);
  const leftDistribution = distributeTotal(left, leftWeights);
  const baseParticipants =
    state.channelHeaderParticipantsCount -
    joinedDistribution.reduce((sum, value) => sum + value, 0) +
    leftDistribution.reduce((sum, value) => sum + value, 0);

  let runningParticipants = baseParticipants;
  const membershipSeries = Array.from({ length: points }, (_, index) => {
    const at = new Date(from.getTime() + stepMs * index);
    const joinedValue = joinedDistribution[index] ?? 0;
    const leftValue = leftDistribution[index] ?? 0;
    return {
      at: at.toISOString(),
      joined: joinedValue,
      left: leftValue,
    };
  });
  const participantsSeries = membershipSeries.map((item) => {
    runningParticipants = Math.max(0, runningParticipants + item.joined - item.left);
    return {
      at: item.at,
      participantsCount: runningParticipants,
    };
  });
  const viewsSeries = Array.from({ length: points }, (_, index) => {
    const at = new Date(from.getTime() + stepMs * index);
    return {
      at: at.toISOString(),
      views: Math.round(3_200 + index * 540 + (range === '30d' ? 1_800 : 0)),
    };
  });
  const posts = range === '24h' ? 3 : range === '7d' ? 14 : 42;
  const views = viewsSeries.reduce((sum, item) => sum + item.views, 0);
  const reactions = Math.round(views * 0.06);

  return channelStatsResponseSchema.parse({
    channel: {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      participantsCount: state.channelHeaderParticipantsCount,
      status: 'Публичный канал',
      isPublic: true,
      link: 'https://max.ru/channels/yuzhnoe-news',
      lastEventAt: state.channelActivity[0]?.createdAt ?? null,
      avatarUrl: resolveChannelAvatarUrl(channelId, state),
    },
    period: {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: range === '24h' ? 'hour' : 'day',
    },
    official: {
      audience: {
        joined,
        left,
        net: joined - left,
      },
      content: {
        posts,
        views,
        reactions,
        topReactions: [
          { emoji: '🔥', count: 182 },
          { emoji: '👍', count: 133 },
          { emoji: '❤️', count: 97 },
        ],
        lastPublishedAt: addHours(now, -3).toISOString(),
      },
      series: {
        participants: participantsSeries,
        membership: membershipSeries,
        views: viewsSeries,
      },
    },
    secondary: {
      postsWithButtons: range === '24h' ? 1 : range === '7d' ? 5 : 12,
      comments: range === '24h' ? 46 : range === '7d' ? 281 : 970,
      suggestions: range === '24h' ? 5 : range === '7d' ? 17 : 63,
      commentAuthors: range === '24h' ? 31 : range === '7d' ? 118 : 366,
      suggestionAuthors: range === '24h' ? 4 : range === '7d' ? 13 : 44,
      suggestionsDelivered: range === '24h' ? 5 : range === '7d' ? 16 : 61,
      suggestionsFailed: range === '24h' ? 0 : range === '7d' ? 1 : 2,
      lastBotActivityAt: addHours(now, -1.8).toISOString(),
    },
    meta: {
      maxSnapshotAvailable: true,
      viewsAvailable: true,
      churnAvailable: true,
      officialCoverageFrom: addDays(now, -30).toISOString(),
      missingOfficialMetrics: [],
    },
    activityFeed: buildActivityPage(state.channelActivity, { range, limit: 50 }, now),
  });
}

function parseJsonBody(init?: RequestInit): unknown {
  if (!init?.body || typeof init.body !== 'string') {
    return null;
  }

  return JSON.parse(init.body);
}

function createBroadcastHandoffResponse(): BroadcastHandoffResponse {
  return {
    botUrl: 'https://max.ru/maxim-bot',
  };
}

function createPublishRulesResult(chatId: string): PublishChatRulesResult {
  return publishChatRulesResultSchema.parse({
    chatId,
    messageId: `rules-${Date.now()}`,
    url: 'https://max.ru/community/rules-preview',
    publishedAt: new Date().toISOString(),
  });
}

function createPublishEngagementResult(chatId: string): PublishChannelEngagementResult {
  return publishChannelEngagementResultSchema.parse({
    chatId,
    sent: true,
    messageId: `engagement-${Date.now()}`,
    updatedExisting: true,
    publishedAt: new Date().toISOString(),
  });
}

function findBroadcast(
  broadcasts: ManagedBroadcastDetails[],
  broadcastId: string,
): ManagedBroadcastDetails | null {
  return broadcasts.find((item) => item.id === broadcastId) ?? null;
}

function findGiveaway(
  giveaways: ManagedGiveawayDetails[],
  giveawayId: string,
): ManagedGiveawayDetails | null {
  return giveaways.find((item) => item.id === giveawayId) ?? null;
}

function upsertGiveaway(
  giveaways: ManagedGiveawayDetails[],
  giveaway: ManagedGiveawayDetails,
): ManagedGiveawayDetails[] {
  const index = giveaways.findIndex((item) => item.id === giveaway.id);
  if (index === -1) {
    return [giveaway, ...giveaways];
  }

  const next = giveaways.slice();
  next[index] = giveaway;
  return next;
}

function createDraftGiveaway(
  entityType: 'chat' | 'channel',
  entityId: string,
): ManagedGiveawayDetails {
  const now = new Date();

  return managedGiveawayDetailsSchema.parse({
    id: `giveaway-${entityType}-${Date.now()}`,
    title: entityType === 'chat' ? 'Новый розыгрыш в чате' : 'Новый розыгрыш в канале',
    status: 'DRAFT',
    hasImage: false,
    entriesCount: 0,
    verifiedEntriesCount: 0,
    pendingEntriesCount: 0,
    winnersCount: 1,
    startsAt: null,
    endsAt: addDays(now, 2).toISOString(),
    publishedAt: null,
    completedAt: null,
    publicationUrl: null,
    resultsUrl: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sourceChatId: entityId,
    entityType,
    description: '',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    claimHours: 24,
    requiredChannelIds: entityType === 'chat' ? [PREVIEW_CHANNEL_ID] : [entityId],
    publicationMessageId: null,
    resultsMessageId: null,
    prizes: [{ id: `prize-${Date.now()}`, position: 1, title: 'Приз 1' }],
    winners: [],
  });
}

function buildModerationMessage(payload: ManualModerationActionRequest): string {
  if (payload.action === 'MUTE') {
    return `Участник замьючен на ${payload.muteDurationHours ?? 24}ч в preview-режиме.`;
  }
  if (payload.action === 'UNMUTE') {
    return 'Мут снят в preview-режиме.';
  }
  if (payload.action === 'UNBAN') {
    return 'Участник разбанен в preview-режиме.';
  }
  return 'Участник забанен в preview-режиме.';
}

function createModerationResult(
  userId: string,
  payload: ManualModerationActionRequest,
): ManualModerationActionResult {
  const now = new Date();
  return manualModerationActionResultSchema.parse({
    ok: true,
    action: payload.action,
    userId,
    muteDurationHours: payload.action === 'MUTE' ? (payload.muteDurationHours ?? 24) : null,
    muteExpiresAt:
      payload.action === 'MUTE'
        ? addHours(now, payload.muteDurationHours ?? 24).toISOString()
        : null,
    message: buildModerationMessage(payload),
  });
}

function createManualViolation(
  userId: string,
  user: {
    displayName: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    profileHandoffUrl: string | null;
  },
  payload: ManualModerationActionRequest,
): LogsDashboardResponse['violations'][number] {
  const now = new Date();

  if (payload.action === 'UNMUTE') {
    return {
      id: `manual-unmute-${Date.now()}`,
      action: 'NONE',
      ruleCode: 'MANUAL_UNMUTE',
      userId,
      userDisplayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      profileHandoffUrl: user.profileHandoffUrl,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: null,
    };
  }

  if (payload.action === 'UNBAN') {
    return {
      id: `manual-unban-${Date.now()}`,
      action: 'NONE',
      ruleCode: 'MANUAL_UNBAN',
      userId,
      userDisplayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      profileHandoffUrl: user.profileHandoffUrl,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: null,
    };
  }

  if (payload.action === 'MUTE') {
    return {
      id: `manual-mute-${Date.now()}`,
      action: 'MUTE',
      ruleCode: 'MANUAL_MUTE',
      userId,
      userDisplayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      profileHandoffUrl: user.profileHandoffUrl,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: {
        muteDurationHours: payload.muteDurationHours ?? 24,
        muteExpiresAt: addHours(now, payload.muteDurationHours ?? 24).toISOString(),
      },
    };
  }

  return {
    id: `manual-ban-${Date.now()}`,
    action: 'BAN',
    ruleCode: 'MANUAL_BAN',
    userId,
    userDisplayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profileUrl: user.profileUrl,
    profileHandoffUrl: user.profileHandoffUrl,
    createdAt: now.toISOString(),
    maskedExcerpt: null,
    metadata: null,
  };
}

function resolvePreviewUser(
  state: PreviewState,
  userId: string,
): {
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  profileHandoffUrl: string | null;
} {
  const fromActivity = state.chatActivity.find((item) => item.userId === userId) ?? null;
  const fromViolation = state.chatViolations.find((item) => item.userId === userId) ?? null;
  const snapshot = fromActivity ?? fromViolation;

  return {
    displayName: snapshot?.userDisplayName?.trim() || 'Участник',
    avatarUrl: snapshot?.avatarUrl ?? null,
    profileUrl: snapshot?.profileUrl ?? null,
    profileHandoffUrl: snapshot?.profileHandoffUrl ?? null,
  };
}

async function handleChatRequest(
  state: PreviewState,
  chatId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): Promise<unknown> {
  if (tail[0] === 'header' && method === 'GET') {
    return {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      entityType: 'chat',
      link: null,
      participantsCount: state.chatHeaderParticipantsCount,
      avatarUrl: resolveChatAvatarUrl(chatId, state),
    };
  }

  if (tail[0] === 'settings-screen' && method === 'GET') {
    return cloneJson(buildChatSettingsScreen(state, chatId));
  }

  if (
    tail[0] === 'required-subscription' &&
    tail[1] === 'channels' &&
    tail[2] === 'resolve' &&
    method === 'POST'
  ) {
    const payload = resolveRequiredSubscriptionChannelRequestSchema.parse(parseJsonBody(init));
    const normalizedValue = payload.value.trim().toLowerCase();
    const normalizedLink = normalizedValue.startsWith('http')
      ? normalizedValue
      : normalizedValue.startsWith('max.ru/')
        ? `https://${normalizedValue}`
        : normalizedValue;
    const channel = state.channels.find(
      (item) =>
        item.id === payload.value.trim() ||
        item.link?.trim().toLowerCase() === normalizedLink ||
        item.link?.trim().toLowerCase() === payload.value.trim().toLowerCase(),
    );

    if (!channel) {
      throw new Error('Канал по этой ссылке не найден.');
    }

    return resolveRequiredSubscriptionChannelResponseSchema.parse({
      channel: {
        id: channel.id,
        title: channel.title,
        entityType: 'channel',
        link: channel.link ?? null,
        participantsCount: null,
        avatarUrl: channel.avatarUrl ?? resolveChannelAvatarUrl(channel.id, state),
      },
    });
  }

  if (tail[0] === 'dialog' && tail[1]) {
    const dialogType = channelDialogTypeSchema.parse(tail[1]);

    if (tail.length === 2 && method === 'GET') {
      return cloneJson(
        buildPreviewDialogResponse(chatId, dialogType, state.chatDialogs[dialogType]),
      );
    }

    if (tail[2] === 'messages' && method === 'POST') {
      const payload = createChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const replyTarget = findPreviewDialogMessage(
        state.chatDialogs[dialogType],
        payload.replyToMessageId,
      );
      const message = buildPreviewDialogMessage({
        id: `chat-${dialogType}-${Date.now()}`,
        type: dialogType,
        text: payload.text,
        authorUserId: state.me.userId,
        authorDisplayName: state.me.displayName ?? state.me.username ?? null,
        avatarUrl: state.me.avatarUrl ?? null,
        createdAt: new Date().toISOString(),
        replyToMessageId: replyTarget?.id ?? null,
        replyTo: replyTarget
          ? {
              messageId: replyTarget.id,
              authorDisplayName: replyTarget.authorDisplayName,
              text: replyTarget.text,
            }
          : null,
        reactionGroups: [],
        ...(dialogType === 'suggest'
          ? {
              delivered: true,
              deliveredToUserId: 'preview-admin-2',
              reviewStatus: 'pending',
              hasImage: Boolean(payload.imageBase64),
              imageFileName: payload.imageFileName || null,
            }
          : {}),
      });
      state.chatDialogs[dialogType].messages.push(message);
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message,
      });
    }

    if (tail[2] === 'messages' && tail[3] && tail[4] === 'reactions' && method === 'POST') {
      const payload = toggleChannelDialogReactionRequestSchema.parse(parseJsonBody(init));
      const message = togglePreviewDialogReaction(
        state.chatDialogs[dialogType],
        tail[3],
        payload.emoji,
      );
      return toggleChannelDialogReactionResponseSchema.parse({
        ok: true,
        message,
      });
    }
  }

  if (tail[0] === 'settings' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatSettings);
    }

    if (method === 'PUT') {
      state.chatSettings = chatSettingsSchema.parse(parseJsonBody(init));
      return cloneJson(state.chatSettings);
    }
  }

  if (tail[0] === 'settings' && tail[1] === 'apply-section-to-all' && method === 'POST') {
    const payload = parseJsonBody(init) as { section?: string } | null;
    return applySectionToAllResponseSchema.parse({
      section: payload?.section ?? 'links',
      sourceChatId: chatId,
      updatedChats: state.chats.length,
      appliedChatIds: state.chats.map((item) => item.id),
    });
  }

  if (tail[0] === 'rules' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatRules);
    }

    if (method === 'PUT') {
      state.chatRules = chatRulesSchema.parse({
        ...state.chatRules,
        ...(parseJsonBody(init) as Record<string, unknown> | null),
      });
      return cloneJson(state.chatRules);
    }
  }

  if (tail[0] === 'rules' && tail[1] === 'publish') {
    if (method === 'POST') {
      const published = createPublishRulesResult(chatId);
      state.chatRules = chatRulesSchema.parse({
        ...state.chatRules,
        publishedMessageId: published.messageId,
        publishedUrl: published.url,
        publishedAt: published.publishedAt,
      });
      return published;
    }

    if (method === 'DELETE') {
      state.chatRules = chatRulesSchema.parse({
        ...state.chatRules,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      });
      return cloneJson(state.chatRules);
    }
  }

  if (tail[0] === 'rules' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'profile' && tail[3] === 'handoff') {
    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'poll' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatPoll);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as { question?: string; options?: string[] } | null;
      state.chatPoll = managedPollSchema.parse({
        ...state.chatPoll,
        question: payload?.question ?? state.chatPoll.question,
        options: payload?.options ?? state.chatPoll.options,
        optionResults: [],
        totalVotes: 0,
      });
      return cloneJson(state.chatPoll);
    }
  }

  if (tail[0] === 'poll' && tail[1] === 'publish' && method === 'POST') {
    state.chatPoll = managedPollSchema.parse({
      ...state.chatPoll,
      status: 'ACTIVE',
      publishedMessageId: `poll-${Date.now()}`,
      publishedUrl: 'https://max.ru/poll/preview-active',
      publishedAt: new Date().toISOString(),
      totalVotes: state.chatPoll.totalVotes || 18,
      optionResults:
        state.chatPoll.optionResults.length > 0
          ? state.chatPoll.optionResults
          : state.chatPoll.options.map((option, index) => ({
              option,
              votes: index === 0 ? 9 : 4 + index,
              percent: index === 0 ? 50 : 25,
            })),
    });
    return cloneJson(state.chatPoll);
  }

  if (tail[0] === 'poll' && tail[1] === 'close' && method === 'POST') {
    state.chatPoll = managedPollSchema.parse({
      ...state.chatPoll,
      status: 'CLOSED',
      closedAt: new Date().toISOString(),
    });
    return cloneJson(state.chatPoll);
  }

  if (tail[0] === 'broadcast' && tail[1] === 'handoff') {
    if (method === 'GET') {
      return buildBroadcastHandoffState(state.chatBroadcasts[0] ?? state.channelBroadcasts[0]);
    }

    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcasts' && tail.length === 1 && method === 'GET') {
    return cloneJson(state.chatBroadcasts.map(buildBroadcastSummary));
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail.length === 2) {
    const details = findBroadcast(state.chatBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedBroadcastDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        updatedAt: new Date().toISOString(),
      });
      state.chatBroadcasts = state.chatBroadcasts.map((item) =>
        item.id === details.id ? updated : item,
      );
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      const canceled = managedBroadcastDetailsSchema.parse({
        ...details,
        status: 'CANCELED',
        cycleEnabled: false,
        canRetry: false,
        updatedAt: new Date().toISOString(),
      });
      state.chatBroadcasts = state.chatBroadcasts.map((item) =>
        item.id === details.id ? canceled : item,
      );
      return cloneJson(canceled);
    }
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail[2] === 'retry' && method === 'POST') {
    const details = findBroadcast(state.chatBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    const retried = managedBroadcastDetailsSchema.parse({
      ...details,
      status: 'ACTIVE',
      failedChats: 0,
      pendingChats: 0,
      canRetry: false,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    state.chatBroadcasts = state.chatBroadcasts.map((item) =>
      item.id === details.id ? retried : item,
    );
    return cloneJson(retried);
  }

  if (tail[0] === 'domain-allowlist' && tail[1] === 'details' && method === 'GET') {
    return cloneJson(state.chatDomains);
  }

  if (tail[0] === 'domain-allowlist' && tail.length === 1 && method === 'POST') {
    const payload = parseJsonBody(init) as {
      domain?: string;
      matchType?: 'EXACT' | 'DOMAIN';
    } | null;
    const domain = payload?.domain?.trim();
    const matchType = payload?.matchType === 'DOMAIN' ? 'DOMAIN' : 'EXACT';
    if (!domain) {
      throw new Error('Preview domain is required');
    }

    const normalizedValue = matchType === 'DOMAIN' ? `domain:${domain}` : domain;
    if (!state.chatDomains.some((item) => item.normalizedValue === normalizedValue)) {
      state.chatDomains = [
        domainAllowlistEntrySchema.parse({
          domain,
          normalizedValue,
          matchType,
          removeAfterAt: null,
        }),
        ...state.chatDomains,
      ];
    }
    return null;
  }

  if (tail[0] === 'domain-allowlist' && tail.length === 1 && method === 'DELETE') {
    const domain = url.searchParams.get('domain')?.trim();
    if (!domain) {
      throw new Error('Preview domain is required');
    }
    state.chatDomains = state.chatDomains.filter((item) => item.normalizedValue !== domain);
    return null;
  }

  if (tail[0] === 'domain-allowlist' && tail[1] && tail.length === 2 && method === 'DELETE') {
    const domain = decodeURIComponent(tail[1]);
    state.chatDomains = state.chatDomains.filter((item) => item.normalizedValue !== domain);
    return null;
  }

  if (
    tail[0] === 'domain-allowlist' &&
    tail[1] === 'removal-schedule' &&
    tail.length === 2 &&
    method === 'PUT'
  ) {
    const domain = url.searchParams.get('domain')?.trim();
    if (!domain) {
      throw new Error('Preview domain is required');
    }
    const payload = parseJsonBody(init) as { removeAfterAt?: string | null } | null;
    state.chatDomains = state.chatDomains.map((item) =>
      item.normalizedValue === domain
        ? domainAllowlistEntrySchema.parse({
            ...item,
            removeAfterAt: payload?.removeAfterAt ?? null,
          })
        : item,
    );
    return null;
  }

  if (
    tail[0] === 'domain-allowlist' &&
    tail[1] &&
    tail[2] === 'removal-schedule' &&
    method === 'PUT'
  ) {
    const domain = decodeURIComponent(tail[1]);
    const payload = parseJsonBody(init) as { removeAfterAt?: string | null } | null;
    state.chatDomains = state.chatDomains.map((item) =>
      item.normalizedValue === domain
        ? domainAllowlistEntrySchema.parse({
            ...item,
            removeAfterAt: payload?.removeAfterAt ?? null,
          })
        : item,
    );
    return null;
  }

  if (tail[0] === 'giveaways' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatGiveaways.map(buildGiveawaySummary));
    }

    if (method === 'POST') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const draft = createDraftGiveaway('chat', chatId);
      const created = managedGiveawayDetailsSchema.parse({
        ...draft,
        ...(payload ?? {}),
        sourceChatId: chatId,
        updatedAt: new Date().toISOString(),
      });
      state.chatGiveaways = upsertGiveaway(state.chatGiveaways, created);
      return cloneJson(created);
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail.length === 2) {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedGiveawayDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        sourceChatId: chatId,
        updatedAt: new Date().toISOString(),
      });
      state.chatGiveaways = upsertGiveaway(state.chatGiveaways, updated);
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      state.chatGiveaways = state.chatGiveaways.filter((item) => item.id !== details.id);
      return null;
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const published = managedGiveawayDetailsSchema.parse({
      ...details,
      status: details.startsAt ? 'SCHEDULED' : 'ACTIVE',
      publishedAt: new Date().toISOString(),
      publicationMessageId: `giveaway-${Date.now()}`,
      publicationUrl: 'https://max.ru/giveaway/published-preview',
      updatedAt: new Date().toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, published);
    return cloneJson(published);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'cancel' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const canceled = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'CANCELED',
      updatedAt: new Date().toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, canceled);
    return cloneJson(canceled);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'reroll' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'deliver' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaway' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  if (tail[0] === 'logs-dashboard' && method === 'GET') {
    const range = (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d';
    return cloneJson(buildLogsDashboard(state, chatId, range));
  }

  if (tail[0] === 'moderation-feed' && method === 'GET') {
    return cloneJson(
      buildModerationFeedPage(
        state.chatViolations,
        {
          range: (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as ModerationFeedFilter | null) ?? 'ALL',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        new Date(),
      ),
    );
  }

  if (tail[0] === 'activity-feed' && method === 'GET') {
    return cloneJson(
      buildActivityPage(
        state.chatActivity,
        {
          range: (url.searchParams.get('range') as MembershipActivityRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as MembershipActivityFilter | null) ?? 'all',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        new Date(),
      ),
    );
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'moderation-action' && method === 'POST') {
    const userId = decodeURIComponent(tail[1]);
    const payload = parseJsonBody(init) as ManualModerationActionRequest;
    const user = resolvePreviewUser(state, userId);
    state.chatViolations = [createManualViolation(userId, user, payload), ...state.chatViolations];
    return createModerationResult(userId, payload);
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

async function handleChannelRequest(
  state: PreviewState,
  channelId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): Promise<unknown> {
  if (tail[0] === 'header' && method === 'GET') {
    return {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      entityType: 'channel',
      link: 'https://max.ru/channels/yuzhnoe-news',
      participantsCount: state.channelHeaderParticipantsCount,
      avatarUrl: resolveChannelAvatarUrl(channelId, state),
    };
  }

  if (tail[0] === 'settings-screen' && method === 'GET') {
    return cloneJson(buildChannelSettingsScreen(state, channelId));
  }

  if (tail[0] === 'dialog' && tail[1]) {
    const dialogType = channelDialogTypeSchema.parse(tail[1]);

    if (tail.length === 2 && method === 'GET') {
      return cloneJson(
        buildPreviewDialogResponse(channelId, dialogType, state.channelDialogs[dialogType]),
      );
    }

    if (tail[2] === 'messages' && method === 'POST') {
      const payload = createChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const replyTarget = findPreviewDialogMessage(
        state.channelDialogs[dialogType],
        payload.replyToMessageId,
      );
      const message = buildPreviewDialogMessage({
        id: `channel-${dialogType}-${Date.now()}`,
        type: dialogType,
        text: payload.text,
        authorUserId: state.me.userId,
        authorDisplayName: state.me.displayName ?? state.me.username ?? null,
        avatarUrl: state.me.avatarUrl ?? null,
        createdAt: new Date().toISOString(),
        replyToMessageId: replyTarget?.id ?? null,
        replyTo: replyTarget
          ? {
              messageId: replyTarget.id,
              authorDisplayName: replyTarget.authorDisplayName,
              text: replyTarget.text,
            }
          : null,
        reactionGroups: [],
        ...(dialogType === 'suggest'
          ? {
              delivered: true,
              deliveredToUserId: 'preview-admin-2',
              reviewStatus: 'pending',
              hasImage: Boolean(payload.imageBase64),
              imageFileName: payload.imageFileName || null,
            }
          : {}),
      });
      state.channelDialogs[dialogType].messages.push(message);
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message,
      });
    }

    if (tail[2] === 'messages' && tail[3] && tail[4] === 'reactions' && method === 'POST') {
      const payload = toggleChannelDialogReactionRequestSchema.parse(parseJsonBody(init));
      const message = togglePreviewDialogReaction(
        state.channelDialogs[dialogType],
        tail[3],
        payload.emoji,
      );
      return toggleChannelDialogReactionResponseSchema.parse({
        ok: true,
        message,
      });
    }
  }

  if (tail[0] === 'settings' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelSettings);
    }

    if (method === 'PUT') {
      state.channelSettings = channelSettingsSchema.parse(parseJsonBody(init));
      return cloneJson(state.channelSettings);
    }
  }

  if (tail[0] === 'poll' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelPoll);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as { question?: string; options?: string[] } | null;
      state.channelPoll = managedPollSchema.parse({
        ...state.channelPoll,
        question: payload?.question ?? state.channelPoll.question,
        options: payload?.options ?? state.channelPoll.options,
        optionResults: [],
        totalVotes: 0,
      });
      return cloneJson(state.channelPoll);
    }
  }

  if (tail[0] === 'poll' && tail[1] === 'publish' && method === 'POST') {
    state.channelPoll = managedPollSchema.parse({
      ...state.channelPoll,
      status: 'ACTIVE',
      publishedMessageId: `channel-poll-${Date.now()}`,
      publishedUrl: 'https://max.ru/poll/channel-preview',
      publishedAt: new Date().toISOString(),
      totalVotes: 61,
      optionResults: state.channelPoll.options.map((option, index) => ({
        option,
        votes: index === 0 ? 30 : index === 1 ? 17 : 14,
        percent: index === 0 ? 49 : index === 1 ? 28 : 23,
      })),
    });
    return cloneJson(state.channelPoll);
  }

  if (tail[0] === 'poll' && tail[1] === 'close' && method === 'POST') {
    state.channelPoll = managedPollSchema.parse({
      ...state.channelPoll,
      status: 'CLOSED',
      closedAt: new Date().toISOString(),
    });
    return cloneJson(state.channelPoll);
  }

  if (tail[0] === 'broadcast' && tail[1] === 'handoff') {
    if (method === 'GET') {
      return buildBroadcastHandoffState(state.channelBroadcasts[0] ?? state.chatBroadcasts[0]);
    }

    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'profile' && tail[3] === 'handoff') {
    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcasts' && tail.length === 1 && method === 'GET') {
    return cloneJson(state.channelBroadcasts.map(buildBroadcastSummary));
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail.length === 2) {
    const details = findBroadcast(state.channelBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedBroadcastDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        updatedAt: new Date().toISOString(),
      });
      state.channelBroadcasts = state.channelBroadcasts.map((item) =>
        item.id === details.id ? updated : item,
      );
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      const canceled = managedBroadcastDetailsSchema.parse({
        ...details,
        status: 'CANCELED',
        cycleEnabled: false,
        canRetry: false,
        updatedAt: new Date().toISOString(),
      });
      state.channelBroadcasts = state.channelBroadcasts.map((item) =>
        item.id === details.id ? canceled : item,
      );
      return cloneJson(canceled);
    }
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail[2] === 'retry' && method === 'POST') {
    const details = findBroadcast(state.channelBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    const retried = managedBroadcastDetailsSchema.parse({
      ...details,
      status: 'ACTIVE',
      failedChats: 0,
      pendingChats: 0,
      canRetry: false,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    state.channelBroadcasts = state.channelBroadcasts.map((item) =>
      item.id === details.id ? retried : item,
    );
    return cloneJson(retried);
  }

  if (tail[0] === 'engagement-publish' && method === 'POST') {
    return createPublishEngagementResult(channelId);
  }

  if (tail[0] === 'giveaways' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelGiveaways.map(buildGiveawaySummary));
    }

    if (method === 'POST') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const draft = createDraftGiveaway('channel', channelId);
      const created = managedGiveawayDetailsSchema.parse({
        ...draft,
        ...(payload ?? {}),
        sourceChatId: channelId,
        entityType: 'channel',
        updatedAt: new Date().toISOString(),
      });
      state.channelGiveaways = upsertGiveaway(state.channelGiveaways, created);
      return cloneJson(created);
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail.length === 2) {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedGiveawayDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        sourceChatId: channelId,
        entityType: 'channel',
        updatedAt: new Date().toISOString(),
      });
      state.channelGiveaways = upsertGiveaway(state.channelGiveaways, updated);
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      state.channelGiveaways = state.channelGiveaways.filter((item) => item.id !== details.id);
      return null;
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const published = managedGiveawayDetailsSchema.parse({
      ...details,
      status: details.startsAt ? 'SCHEDULED' : 'ACTIVE',
      publishedAt: new Date().toISOString(),
      publicationMessageId: `giveaway-channel-${Date.now()}`,
      publicationUrl: 'https://max.ru/giveaway/channel-preview',
      updatedAt: new Date().toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, published);
    return cloneJson(published);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'cancel' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const canceled = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'CANCELED',
      updatedAt: new Date().toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, canceled);
    return cloneJson(canceled);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'reroll' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'deliver' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaway' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  if (tail[0] === 'stats' && method === 'GET') {
    const range = (url.searchParams.get('range') as ChannelStatsRange | null) ?? '7d';
    return cloneJson(buildChannelStats(state, channelId, range));
  }

  if (tail[0] === 'activity-feed' && method === 'GET') {
    return cloneJson(
      buildActivityPage(
        state.channelActivity,
        {
          range: (url.searchParams.get('range') as MembershipActivityRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as MembershipActivityFilter | null) ?? 'all',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        new Date(),
      ),
    );
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

export function createPreviewApiTransport(): ApiTransport {
  const state = createInitialState();

  return {
    async request(path: string, init: RequestInit = {}) {
      const url = new URL(path, 'https://preview.local');
      const method = (init.method ?? 'GET').toUpperCase();

      if (url.pathname === '/me' && method === 'GET') {
        return cloneJson(state.me);
      }

      if (url.pathname === '/system/dashboard' && method === 'GET') {
        return systemDashboardResponseSchema.parse(buildPreviewSystemDashboard(state));
      }

      if (url.pathname === '/system/mode' && method === 'POST') {
        const parsedBody = JSON.parse(String(init.body ?? '{}')) as { mode?: unknown };
        const mode = parsedBody.mode;
        if (mode !== 'auto' && mode !== 'normal' && mode !== 'degrade') {
          throw new Error('Preview transport received invalid system mode payload');
        }
        state.systemModeSelection = mode;
        return systemModeSnapshotSchema.parse(buildPreviewSystemMode(state));
      }

      if (url.pathname === '/chats' && method === 'GET') {
        if (url.searchParams.get('includeRefreshState') === '1') {
          return cloneJson(buildPreviewManagedEntitiesResponse(state.chats));
        }
        return cloneJson(state.chats);
      }

      if (url.pathname === '/channels' && method === 'GET') {
        if (url.searchParams.get('includeRefreshState') === '1') {
          return cloneJson(buildPreviewManagedEntitiesResponse(state.channels));
        }
        return cloneJson(state.channels);
      }

      const segments = url.pathname.split('/').filter(Boolean);
      if (segments[0] === 'giveaways' && segments[1]) {
        const giveawayId = decodeURIComponent(segments[1]);
        if (giveawayId !== PREVIEW_PUBLIC_GIVEAWAY_ID) {
          throw new Error(`Preview public giveaway not found: ${giveawayId}`);
        }

        const variant = readPreviewGiveawayVariant();
        if (segments.length === 2 && method === 'GET') {
          return cloneJson(buildPreviewPublicGiveaway(state, giveawayId, variant));
        }

        if (segments[2] === 'me' && method === 'GET') {
          return cloneJson(
            buildPreviewGiveawayParticipantState(readPreviewGiveawayParticipantVariant()),
          );
        }

        if (segments[2] === 'enter' && method === 'POST') {
          const nextVariant =
            readPreviewGiveawayEnterResult() ??
            (variant === 'blocked' ? 'blocked-entered' : variant);
          writePreviewGiveawayParticipantVariant(nextVariant);
          return cloneJson(buildPreviewGiveawayParticipantState(nextVariant));
        }

        if (segments[2] === 'claim' && method === 'POST') {
          return null;
        }
      }

      if (segments[0] === 'chats' && segments[1]) {
        return handleChatRequest(state, segments[1], segments.slice(2), url, method, init);
      }

      if (segments[0] === 'channels' && segments[1]) {
        return handleChannelRequest(state, segments[1], segments.slice(2), url, method, init);
      }

      throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
    },
    requestKeepalive(path: string, init: RequestInit = {}) {
      void this.request(path, init);
    },
  };
}
