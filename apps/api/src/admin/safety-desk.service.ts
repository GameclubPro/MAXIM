import {
  safetyDeskApproveAllRequestSchema,
  safetyDeskAllowAmbiguousSendRetryRequestSchema,
  safetyDeskDecisionRequestSchema,
  safetyDeskDecisionResponseSchema,
  safetyDeskDeleteRuntimeResponseSchema,
  safetyDeskRetryDeleteIntentRequestSchema,
  safetyDeskQueueResponseSchema,
  type SafetyDeskAuditEntry,
  type SafetyDeskDecisionResponse,
  type SafetyDeskDeleteCapabilityReason,
  type SafetyDeskDeleteCapabilityState,
  type SafetyDeskDeleteIntentItem,
  type SafetyDeskDeleteIntentStatus,
  type SafetyDeskDeleteIntentStatusCounts,
  type SafetyDeskDeleteMembershipCapability,
  type SafetyDeskDeleteRuntimeResponse,
  type SafetyDeskGiveawayWinnerNotificationDeadEndStatus,
  type SafetyDeskQueueItem,
  type SafetyDeskQueueResponse,
  type SafetyDeskRiskLevel,
} from '@maxim/contracts';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import {
  isFreshMembershipAccessSnapshot,
  normalizeMembershipAccessSnapshot,
} from '../max/max-bot-access-policy.util';
import { resolveDeleteMessageAccessFailure } from '../max/max-delete-message-access.util';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { canExecuteActionsForBotState } from '../max/max-bot-state.util';
import {
  MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
  MAX_SEND_FENCE_STALE_MS,
} from '../max/max-send-ambiguity.util';
import {
  normalizeModerationDeleteIntentMode,
  parseModerationDeleteIntentCanaryChatIds,
  resolveModerationDeleteIntentRollout,
} from '../moderation/moderation-delete-intent-rollout.util';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  prepareVkParsingPublishPayload,
  resolveVkParsingPostSkipReason,
  type PreparedVkPublishPayload,
} from './vk-parsing-content';
import { VkPublishService } from './vk-publish.service';

type ReviewPostRow = Prisma.VkParsingPostGetPayload<{
  include: {
    chat: { select: { title: true; entityType: true; vkParsingSettings: true } };
    source: true;
  };
}>;
type SafetyAuditRow = Prisma.AuditLogGetPayload<Record<string, never>>;

type DeleteIntentDiagnosticRow = {
  id: string;
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  entityType: ChatEntityType | null;
  originBotId: string | null;
  routingPolicy: string;
  messageAuthorKind: string | null;
  status: SafetyDeskDeleteIntentStatus;
  executeAt: Date;
  nextAttemptAt: Date;
  retryUntilAt: Date;
  attemptCount: number;
  lastBotId: string | null;
  succeededBotId: string | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  lastError: string | null;
  firstAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  completedAt: Date | null;
  leaseExpiresAt: Date | null;
  deleteDispatchStartedAt: Date | null;
  deleteDispatchStartedBotId: string | null;
  remoteDeleteSucceededAt: Date | null;
  remoteDeleteSucceededBotId: string | null;
  createdAt: Date;
  updatedAt: Date;
  chat: {
    title: string;
    entityType: ChatEntityType;
    routingState: 'READY' | 'NO_ELIGIBLE_BOT';
    botMemberships: Array<{
      botId: string;
      role: 'PRIMARY' | 'STANDBY';
      permissionsSnapshot: unknown;
      botAccessState:
        | 'UNKNOWN'
        | 'CONFIRMED_OWNER'
        | 'CONFIRMED_ADMIN'
        | 'CONFIRMED_MEMBER'
        | 'DENIED'
        | 'LOST'
        | 'STALE';
      botAccessCheckedAt: Date | null;
      botAccessExpiresAt: Date | null;
    }>;
  };
  reasons: Array<{
    reasonKey: string;
    ruleCode: string;
    userId: string | null;
    score: number;
    createdAt: Date;
  }>;
};

const SAFETY_DESK_ACTOR_USER_ID = 'safety-desk-owner';
const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_PUBLISH_MODE_REVIEW = 'REVIEW';
const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const SAFETY_DESK_AUDIT_PREFIX = 'SAFETY_DESK_';
const SAFETY_DESK_TRUSTED_DOMAIN_ROOTS = ['max.ru', 'vk.ru', 'vk.com'];
const DELETE_INTENT_ATTENTION_LIMIT = 100;
const DELETE_INTENT_COMPLETED_LIMIT = 25;
const AMBIGUOUS_SEND_LIMIT = 100;
const GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_LIMIT = 50;
const SAFETY_DESK_LAST_ERROR_LIMIT = 1_000;
const DELETE_INTENT_REASON_LIMIT = 10;
const DELETE_INTENT_MEMBERSHIP_LIMIT = 20;
const DELETE_INTENT_STATUSES = [
  'OBSERVED',
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const DELETE_INTENT_OPEN_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const DELETE_INTENT_DUE_STATUSES = [
  'PENDING',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const DELETE_INTENT_RECENT_STATUSES = [
  'OBSERVED',
  ...DELETE_INTENT_OPEN_STATUSES,
  'EXPIRED',
  'FAILED_TERMINAL',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const DELETE_INTENT_COMPLETED_STATUSES = [
  'SUCCEEDED',
  'ALREADY_ABSENT',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_STATUSES = [
  'AMBIGUOUS',
  'FAILED_TERMINAL',
] as const satisfies readonly SafetyDeskGiveawayWinnerNotificationDeadEndStatus[];
const DELETE_INTENT_DIAGNOSTIC_SELECT = {
  id: true,
  chatId: true,
  messageId: true,
  subjectUserId: true,
  entityType: true,
  originBotId: true,
  routingPolicy: true,
  messageAuthorKind: true,
  status: true,
  executeAt: true,
  nextAttemptAt: true,
  retryUntilAt: true,
  attemptCount: true,
  lastBotId: true,
  succeededBotId: true,
  lastStatusCode: true,
  lastErrorCode: true,
  lastError: true,
  firstAttemptAt: true,
  lastAttemptAt: true,
  completedAt: true,
  leaseExpiresAt: true,
  deleteDispatchStartedAt: true,
  deleteDispatchStartedBotId: true,
  remoteDeleteSucceededAt: true,
  remoteDeleteSucceededBotId: true,
  createdAt: true,
  updatedAt: true,
  chat: {
    select: {
      title: true,
      entityType: true,
      routingState: true,
      botMemberships: {
        where: { status: 'ACTIVE' },
        orderBy: [{ role: 'asc' }, { updatedAt: 'desc' }],
        take: DELETE_INTENT_MEMBERSHIP_LIMIT,
        select: {
          botId: true,
          role: true,
          permissionsSnapshot: true,
          botAccessState: true,
          botAccessCheckedAt: true,
          botAccessExpiresAt: true,
        },
      },
    },
  },
  reasons: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: DELETE_INTENT_REASON_LIMIT,
    select: {
      reasonKey: true,
      ruleCode: true,
      userId: true,
      score: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ModerationDeleteIntentSelect;
const GIVEAWAY_WINNER_NOTIFICATION_DIAGNOSTIC_SELECT = {
  id: true,
  winnerId: true,
  status: true,
  nextAttemptAt: true,
  attemptCount: true,
  lockedAt: true,
  dispatchedAt: true,
  botId: true,
  lastError: true,
  ambiguousAt: true,
  createdAt: true,
  updatedAt: true,
  winner: {
    select: {
      entry: { select: { userId: true } },
      giveaway: {
        select: {
          id: true,
          title: true,
          sourceChatId: true,
        },
      },
    },
  },
} satisfies Prisma.ManagedGiveawayWinnerNotificationSelect;
type GiveawayWinnerNotificationDiagnosticRow = Prisma.ManagedGiveawayWinnerNotificationGetPayload<{
  select: typeof GIVEAWAY_WINNER_NOTIFICATION_DIAGNOSTIC_SELECT;
}>;
const SAFETY_DESK_BLOCKED_APPROVE_MESSAGE =
  'Этот материал нельзя опубликовать автоматически: есть неподдерживаемые вложения или после фильтрации не осталось текста, фото или ссылок.';

@Injectable()
export class SafetyDeskService {
  private readonly deleteIntentMode: ReturnType<typeof normalizeModerationDeleteIntentMode>;
  private readonly deleteIntentCanaryChatIds: ReadonlySet<string>;
  private readonly deleteCrossBotCanaryChatIds: ReadonlySet<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vkPublishService: VkPublishService,
    configService: ConfigService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly moderationDeleteIntents: ModerationDeleteIntentService,
  ) {
    this.deleteIntentMode = normalizeModerationDeleteIntentMode(
      configService.get('MODERATION_DELETE_INTENT_MODE'),
    );
    this.deleteIntentCanaryChatIds = parseModerationDeleteIntentCanaryChatIds(
      configService.get('MODERATION_DELETE_INTENT_CANARY_CHAT_IDS'),
    );
    this.deleteCrossBotCanaryChatIds = parseModerationDeleteIntentCanaryChatIds(
      configService.get('MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS'),
    );
  }

  async getQueue(): Promise<SafetyDeskQueueResponse> {
    const [posts, audit, approved, rejected] = await Promise.all([
      this.loadReviewPosts(),
      this.loadAuditEntries(),
      this.prisma.auditLog.count({ where: { action: 'SAFETY_DESK_APPROVE' } }),
      this.prisma.auditLog.count({ where: { action: 'SAFETY_DESK_REJECT' } }),
    ]);
    const items = posts.map((post) => this.mapReviewPost(post));
    const blocked = items.filter((item) => item.status === 'BLOCKED').length;

    return safetyDeskQueueResponseSchema.parse({
      generatedAt: new Date().toISOString(),
      items,
      summary: {
        review: items.filter((item) => item.status === 'REVIEW').length,
        approved,
        rejected,
        blocked,
        servicePosts: 0,
      },
      audit,
    });
  }

  async getDeleteRuntime(): Promise<SafetyDeskDeleteRuntimeResponse> {
    const now = new Date();
    const staleSendFenceBefore = new Date(now.getTime() - MAX_SEND_FENCE_STALE_MS);
    const openStatuses = [...DELETE_INTENT_OPEN_STATUSES];
    const dueStatuses = [...DELETE_INTENT_DUE_STATUSES];
    const recentStatuses = [...DELETE_INTENT_RECENT_STATUSES];
    const completedStatuses = [...DELETE_INTENT_COMPLETED_STATUSES];
    const [
      statusGroups,
      due,
      staleLeases,
      oldestOpen,
      recentRows,
      recentCompletedRows,
      channelAmbiguousReplacementSends,
      chatAmbiguousReplacementSends,
      rulesAmbiguousSends,
      recentChannelAmbiguousSends,
      recentChatAmbiguousSends,
      recentRulesAmbiguousSends,
      giveawayWinnerNotificationDeadEndGroups,
      giveawayWinnerNotificationDeadEndRows,
    ] = await Promise.all([
      this.prisma.moderationDeleteIntent.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.moderationDeleteIntent.aggregate({
        where: {
          status: { in: dueStatuses },
          executeAt: { lte: now },
          nextAttemptAt: { lte: now },
          OR: [
            { retryUntilAt: { gt: now } },
            {
              remoteDeleteSucceededAt: { not: null },
              remoteDeleteSucceededBotId: { not: null },
            },
            {
              deleteDispatchStartedAt: { not: null },
              deleteDispatchStartedBotId: { not: null },
            },
          ],
        },
        _count: { _all: true },
        _min: { nextAttemptAt: true },
      }),
      this.prisma.moderationDeleteIntent.aggregate({
        where: {
          status: 'IN_PROGRESS',
          leaseExpiresAt: { lte: now },
        },
        _count: { _all: true },
        _min: { leaseExpiresAt: true },
      }),
      this.prisma.moderationDeleteIntent.aggregate({
        where: { status: { in: openStatuses } },
        _min: { createdAt: true },
      }),
      this.prisma.moderationDeleteIntent.findMany({
        where: { status: { in: recentStatuses } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: DELETE_INTENT_ATTENTION_LIMIT,
        select: DELETE_INTENT_DIAGNOSTIC_SELECT,
      }),
      this.prisma.moderationDeleteIntent.findMany({
        where: { status: { in: completedStatuses } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: DELETE_INTENT_COMPLETED_LIMIT,
        select: DELETE_INTENT_DIAGNOSTIC_SELECT,
      }),
      this.prisma.channelAutoPostAttachMarker.aggregate({
        where: {
          status: 'SKIPPED',
          replacementMessageId: null,
          replacementSendStartedAt: { not: null },
          lastError: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
        },
        _count: { _all: true },
        _min: { replacementSendStartedAt: true },
      }),
      this.prisma.chatAutoCommentAttachMarker.aggregate({
        where: {
          status: 'SKIPPED',
          replacementMessageId: null,
          replacementSendStartedAt: { not: null },
          lastError: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
        },
        _count: { _all: true },
        _min: { replacementSendStartedAt: true },
      }),
      this.prisma.chatRules.aggregate({
        where: { publishSendStartedAt: { lte: staleSendFenceBefore } },
        _count: { _all: true },
        _min: { publishSendStartedAt: true },
      }),
      this.prisma.channelAutoPostAttachMarker.findMany({
        where: {
          status: 'SKIPPED',
          replacementMessageId: null,
          replacementSendStartedAt: { not: null },
          lastError: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: AMBIGUOUS_SEND_LIMIT,
        select: {
          id: true,
          chatId: true,
          messageId: true,
          botId: true,
          replacementSendStartedAt: true,
          lastError: true,
          updatedAt: true,
          chat: { select: { title: true } },
        },
      }),
      this.prisma.chatAutoCommentAttachMarker.findMany({
        where: {
          status: 'SKIPPED',
          replacementMessageId: null,
          replacementSendStartedAt: { not: null },
          lastError: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: AMBIGUOUS_SEND_LIMIT,
        select: {
          id: true,
          chatId: true,
          messageId: true,
          botId: true,
          replacementSendStartedAt: true,
          lastError: true,
          updatedAt: true,
          chat: { select: { title: true } },
        },
      }),
      this.prisma.chatRules.findMany({
        where: { publishSendStartedAt: { lte: staleSendFenceBefore } },
        orderBy: [{ publishSendStartedAt: 'desc' }, { id: 'desc' }],
        take: AMBIGUOUS_SEND_LIMIT,
        select: {
          id: true,
          chatId: true,
          publishOperationId: true,
          publishOperationBotId: true,
          publishSendStartedAt: true,
          updatedAt: true,
          chat: { select: { title: true } },
        },
      }),
      this.prisma.managedGiveawayWinnerNotification.groupBy({
        by: ['status'],
        where: {
          status: { in: [...GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_STATUSES] },
        },
        _count: { _all: true },
        _min: { updatedAt: true },
      }),
      this.prisma.managedGiveawayWinnerNotification.findMany({
        where: {
          status: { in: [...GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_STATUSES] },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_LIMIT,
        select: GIVEAWAY_WINNER_NOTIFICATION_DIAGNOSTIC_SELECT,
      }),
    ]);

    const statusCounts = this.buildDeleteIntentStatusCounts(statusGroups);
    const oldestOpenAt = oldestOpen._min.createdAt;
    const diagnosticRows = [
      ...(recentRows as DeleteIntentDiagnosticRow[]),
      ...(recentCompletedRows as DeleteIntentDiagnosticRow[]),
    ].sort(
      (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id),
    );
    const items = diagnosticRows.map((row) => this.mapDeleteIntent(row, now));
    const oldestAmbiguousSendAt = [
      channelAmbiguousReplacementSends._min.replacementSendStartedAt,
      chatAmbiguousReplacementSends._min.replacementSendStartedAt,
      rulesAmbiguousSends._min.publishSendStartedAt,
    ]
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    const ambiguousSends = [
      ...recentChannelAmbiguousSends.map((row) => ({
        id: `channel_auto_post:${row.id}`,
        source: 'channel_auto_post' as const,
        chatId: row.chatId,
        chatTitle: row.chat.title,
        messageId: row.messageId,
        botId: row.botId,
        startedAt: (row.replacementSendStartedAt ?? row.updatedAt).toISOString(),
        detectedAt: row.updatedAt.toISOString(),
        lastError: row.lastError ?? `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Unknown send result`,
      })),
      ...recentChatAmbiguousSends.map((row) => ({
        id: `chat_auto_comment:${row.id}`,
        source: 'chat_auto_comment' as const,
        chatId: row.chatId,
        chatTitle: row.chat.title,
        messageId: row.messageId,
        botId: row.botId,
        startedAt: (row.replacementSendStartedAt ?? row.updatedAt).toISOString(),
        detectedAt: row.updatedAt.toISOString(),
        lastError: row.lastError ?? `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Unknown send result`,
      })),
      ...recentRulesAmbiguousSends.map((row) => ({
        id: `chat_rules:${row.id}`,
        source: 'chat_rules' as const,
        chatId: row.chatId,
        chatTitle: row.chat.title,
        messageId: row.publishOperationId,
        botId: row.publishOperationBotId,
        startedAt: (row.publishSendStartedAt ?? row.updatedAt).toISOString(),
        detectedAt: row.updatedAt.toISOString(),
        lastError: `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Chat rules publication has no persisted remote message id.`,
      })),
    ]
      .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt))
      .slice(0, AMBIGUOUS_SEND_LIMIT);
    const giveawayWinnerNotificationDeadEndCounts: Record<
      SafetyDeskGiveawayWinnerNotificationDeadEndStatus,
      number
    > = {
      AMBIGUOUS: 0,
      FAILED_TERMINAL: 0,
    };
    let oldestGiveawayWinnerNotificationDeadEndAt: Date | null = null;
    for (const group of giveawayWinnerNotificationDeadEndGroups) {
      if (group.status in giveawayWinnerNotificationDeadEndCounts) {
        giveawayWinnerNotificationDeadEndCounts[
          group.status as SafetyDeskGiveawayWinnerNotificationDeadEndStatus
        ] = Math.max(0, group._count._all);
      }
      const updatedAt = group._min.updatedAt;
      if (
        updatedAt &&
        (!oldestGiveawayWinnerNotificationDeadEndAt ||
          updatedAt < oldestGiveawayWinnerNotificationDeadEndAt)
      ) {
        oldestGiveawayWinnerNotificationDeadEndAt = updatedAt;
      }
    }
    const giveawayWinnerNotificationDeadEnds = (
      giveawayWinnerNotificationDeadEndRows as GiveawayWinnerNotificationDiagnosticRow[]
    ).map((row) => ({
      notificationId: row.id,
      giveawayId: row.winner.giveaway.id,
      giveawayTitle: row.winner.giveaway.title,
      sourceChatId: row.winner.giveaway.sourceChatId,
      winnerId: row.winnerId,
      userId: row.winner.entry.userId,
      botId: row.botId,
      status: row.status,
      attemptCount: row.attemptCount,
      lastError: this.sanitizeSafetyDeskLastError(row.lastError),
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      lockedAt: row.lockedAt?.toISOString() ?? null,
      dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
      ambiguousAt: row.ambiguousAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    return safetyDeskDeleteRuntimeResponseSchema.parse({
      generatedAt: now.toISOString(),
      rolloutMode: this.deleteIntentMode,
      summary: {
        total: DELETE_INTENT_STATUSES.reduce((sum, status) => sum + statusCounts[status], 0),
        open: DELETE_INTENT_OPEN_STATUSES.reduce((sum, status) => sum + statusCounts[status], 0),
        failed: statusCounts.EXPIRED + statusCounts.FAILED_TERMINAL,
        statusCounts,
        due: {
          count: due._count._all,
          oldestAt: due._min.nextAttemptAt?.toISOString() ?? null,
        },
        staleLeases: {
          count: staleLeases._count._all,
          oldestAt: staleLeases._min.leaseExpiresAt?.toISOString() ?? null,
        },
        ambiguousSends: {
          count:
            channelAmbiguousReplacementSends._count._all +
            chatAmbiguousReplacementSends._count._all +
            rulesAmbiguousSends._count._all,
          oldestAt: oldestAmbiguousSendAt?.toISOString() ?? null,
        },
        giveawayWinnerNotificationDeadEnds: {
          count:
            giveawayWinnerNotificationDeadEndCounts.AMBIGUOUS +
            giveawayWinnerNotificationDeadEndCounts.FAILED_TERMINAL,
          ambiguous: giveawayWinnerNotificationDeadEndCounts.AMBIGUOUS,
          failedTerminal: giveawayWinnerNotificationDeadEndCounts.FAILED_TERMINAL,
          oldestAt: oldestGiveawayWinnerNotificationDeadEndAt?.toISOString() ?? null,
        },
        oldestOpen: {
          createdAt: oldestOpenAt?.toISOString() ?? null,
          ageMs: oldestOpenAt ? Math.max(0, now.getTime() - oldestOpenAt.getTime()) : null,
        },
      },
      items,
      ambiguousSends,
      giveawayWinnerNotificationDeadEnds,
    });
  }

  async clearAmbiguousSendFence(
    itemId: string,
    actorUserId: string | null,
    input: unknown,
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    const parsed = safetyDeskAllowAmbiguousSendRetryRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('Укажите операцию отправки, проверенную в MAX.');
    }
    const [source, sourceId] = itemId.split(':', 2);
    if (source !== 'chat_rules' || !sourceId?.trim()) {
      throw new BadRequestException(
        'Автоматический повтор доступен только для неопределённой публикации правил.',
      );
    }

    const expectedStartedAt = new Date(parsed.data.expectedStartedAt);
    const staleBefore = new Date(Date.now() - MAX_SEND_FENCE_STALE_MS);
    if (expectedStartedAt > staleBefore) {
      throw new BadRequestException('Операция ещё не считается зависшей.');
    }
    await this.prisma.$transaction(async (tx) => {
      const rules = await tx.chatRules.findUnique({
        where: { id: sourceId },
        select: {
          id: true,
          chatId: true,
          publishOperationId: true,
          publishOperationBotId: true,
          publishSendStartedAt: true,
        },
      });
      if (
        !rules?.publishSendStartedAt ||
        rules.publishOperationId !== parsed.data.expectedOperationId ||
        rules.publishSendStartedAt.getTime() !== expectedStartedAt.getTime()
      ) {
        throw new ConflictException('Состояние публикации изменилось. Обновите Safety Desk.');
      }
      const cleared = await tx.chatRules.updateMany({
        where: {
          id: rules.id,
          publishOperationId: parsed.data.expectedOperationId,
          publishSendStartedAt: expectedStartedAt,
        },
        data: {
          publishOperationId: null,
          publishOperationBotId: null,
          publishSendStartedAt: null,
        },
      });
      if (cleared.count !== 1) {
        throw new ConflictException('Состояние публикации изменилось. Обновите Safety Desk.');
      }
      await tx.auditLog.create({
        data: {
          chatId: rules.chatId,
          actorUserId: actorUserId?.trim() || SAFETY_DESK_ACTOR_USER_ID,
          action: 'SAFETY_DESK_CLEAR_AMBIGUOUS_SEND_FENCE',
          payload: {
            source: 'chat_rules',
            sourceId: rules.id,
            operationId: rules.publishOperationId,
            botId: rules.publishOperationBotId,
            sendStartedAt: rules.publishSendStartedAt.toISOString(),
          },
        },
      });
    });

    return this.getDeleteRuntime();
  }

  async retryDeleteIntent(
    intentId: string,
    actorUserId: string | null,
    input: unknown,
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    const parsed = safetyDeskRetryDeleteIntentRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('Укажите актуальный terminal-статус удаления.');
    }

    const intent = await this.prisma.moderationDeleteIntent.findUnique({
      where: { id: intentId },
      select: { id: true, chatId: true, status: true, updatedAt: true, attemptCount: true },
    });
    if (!intent) {
      throw new NotFoundException('Удаление не найдено.');
    }
    const rollout = resolveModerationDeleteIntentRollout({
      mode: this.deleteIntentMode,
      canaryChatIds: this.deleteIntentCanaryChatIds,
      chatId: intent.chatId,
    });
    if (rollout !== 'execute') {
      throw new BadRequestException('Повтор запрещён вне активного rollout для этого чата.');
    }
    if (
      intent.status !== parsed.data.expectedStatus ||
      intent.updatedAt.toISOString() !== parsed.data.expectedUpdatedAt ||
      intent.attemptCount !== parsed.data.expectedAttemptCount
    ) {
      throw new ConflictException('Состояние удаления изменилось. Обновите Safety Desk.');
    }

    const retried = await this.moderationDeleteIntents.retryTerminalIntent(
      intent.id,
      parsed.data.expectedStatus,
      {
        updatedAt: new Date(parsed.data.expectedUpdatedAt),
        attemptCount: parsed.data.expectedAttemptCount,
      },
      { actorUserId: this.resolveActor(actorUserId) },
    );
    if (!retried.reopened) {
      throw new ConflictException('Состояние удаления изменилось. Обновите Safety Desk.');
    }
    return this.getDeleteRuntime();
  }

  async approveItem(
    itemId: string,
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskDecisionResponse> {
    const parsed = safetyDeskDecisionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const post = await this.findReviewPostOrThrow(itemId, { includeCancelled: false });
    const item = this.mapReviewPost(post);
    if (!this.isApprovableItem(item)) {
      throw new BadRequestException(this.buildNotApprovableMessage(item));
    }

    await this.approveReviewPost(post, actorUserId, parsed.data.reason ?? null);

    return safetyDeskDecisionResponseSchema.parse({
      item: null,
      queue: await this.getQueue(),
      message: 'Материал одобрен и опубликован в MAX.',
    });
  }

  async approveAllReviewItems(
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskDecisionResponse> {
    const parsed = safetyDeskApproveAllRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const itemIds = [...new Set(parsed.data.itemIds)];
    const candidates = (await this.loadReviewPosts({ itemIds })).filter((post) =>
      this.isApprovableItem(this.mapReviewPost(post)),
    );
    let approved = 0;
    let failed = 0;

    for (const post of candidates) {
      try {
        await this.approveReviewPost(post, actorUserId, parsed.data.reason ?? null);
        approved += 1;
      } catch {
        failed += 1;
      }
    }

    return safetyDeskDecisionResponseSchema.parse({
      item: null,
      queue: await this.getQueue(),
      message: this.buildApproveAllMessage(approved, failed, candidates.length, itemIds.length),
    });
  }

  async rejectItem(
    itemId: string,
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskDecisionResponse> {
    const parsed = safetyDeskDecisionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const post = await this.findReviewPostOrThrow(itemId, { includeCancelled: false });
    const now = new Date();
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        ...this.buildReviewPostWhere(post.id, { includeCancelled: false }),
        publishLockedAt: null,
      },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishCancelledAt: now,
        publishCancelledByUserId: this.resolveActor(actorUserId),
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Материал проверки уже обработан или недоступен.');
    }
    await this.writeAuditLog(post.chatId, actorUserId, 'SAFETY_DESK_REJECT', {
      postId: post.id,
      sourceId: post.sourceId,
      itemTitle: this.buildTitle(post),
      reason: parsed.data.reason ?? null,
    });

    return safetyDeskDecisionResponseSchema.parse({
      item: null,
      queue: await this.getQueue(),
      message: 'Материал отклонен. В MAX ничего не отправлено.',
    });
  }

  async recheckItem(
    itemId: string,
    actorUserId: string | null,
  ): Promise<SafetyDeskDecisionResponse> {
    const post = await this.findReviewPostOrThrow(itemId, { includeCancelled: true });
    if (this.hasAmbiguousMaxSendError(post.lastError)) {
      throw new BadRequestException(
        'MAX мог уже принять эту публикацию. Сначала сверьте сообщение в MAX вручную; повторная отправка через Safety Desk заблокирована.',
      );
    }
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        ...this.buildReviewPostWhere(post.id, { includeCancelled: true }),
        publishCancelledAt: post.publishCancelledAt,
        publishLockedAt: null,
      },
      data: {
        status: post.status === VK_POST_STATUS_FAILED ? VK_POST_STATUS_NEW : post.status,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        lastError: null,
        autoPublishError: null,
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Материал проверки уже обработан или недоступен.');
    }
    const refreshed = await this.findReviewPostOrThrow(itemId, { includeCancelled: true });
    const item = this.mapReviewPost(refreshed);
    await this.writeAuditLog(refreshed.chatId, actorUserId, 'SAFETY_DESK_RECHECK', {
      postId: refreshed.id,
      sourceId: refreshed.sourceId,
      itemTitle: item.title,
    });

    return safetyDeskDecisionResponseSchema.parse({
      item,
      queue: await this.getQueue(),
      message: 'Материал возвращен на проверку.',
    });
  }

  private async loadReviewPosts(options: { itemIds?: string[] } = {}): Promise<ReviewPostRow[]> {
    const posts = await this.prisma.vkParsingPost.findMany({
      where: {
        ...(options.itemIds ? { id: { in: options.itemIds } } : {}),
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        publishCancelledAt: null,
        skippedAt: null,
        unavailableAt: null,
        hasUnsupportedAttachments: false,
        OR: [
          { text: { not: '' } },
          { photoUrls: { not: [] } },
          { videoUrls: { not: [] } },
          { linkUrls: { not: [] } },
        ],
        source: {
          status: VK_SOURCE_STATUS_ACTIVE,
          publishMode: VK_SOURCE_PUBLISH_MODE_REVIEW,
        },
      },
      include: {
        chat: { select: { title: true, entityType: true, vkParsingSettings: true } },
        source: true,
      },
      orderBy: [{ vkPublishedAt: 'desc' }, { createdAt: 'desc' }],
      take: options.itemIds ? Math.max(1, options.itemIds.length) : 100,
    });

    return posts.filter((post) => this.hasPublishableContent(post));
  }

  private async findReviewPostOrThrow(
    itemId: string,
    options: { includeCancelled: boolean },
  ): Promise<ReviewPostRow> {
    const post = await this.prisma.vkParsingPost.findFirst({
      where: this.buildReviewPostWhere(itemId, options),
      include: {
        chat: { select: { title: true, entityType: true, vkParsingSettings: true } },
        source: true,
      },
    });

    if (!post) {
      throw new NotFoundException('Материал проверки не найден.');
    }

    return post;
  }

  private buildReviewPostWhere(
    itemId: string,
    options: { includeCancelled: boolean },
  ): Prisma.VkParsingPostWhereInput {
    return {
      id: itemId,
      status: {
        notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE, VK_POST_STATUS_SKIPPED],
      },
      skippedAt: null,
      unavailableAt: null,
      ...(options.includeCancelled ? {} : { publishCancelledAt: null }),
      source: {
        status: VK_SOURCE_STATUS_ACTIVE,
        publishMode: VK_SOURCE_PUBLISH_MODE_REVIEW,
      },
    };
  }

  private async loadAuditEntries(): Promise<SafetyDeskAuditEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: { startsWith: SAFETY_DESK_AUDIT_PREFIX } },
      orderBy: [{ createdAt: 'desc' }],
      take: 30,
    });

    return rows.map((row) => this.mapAuditEntry(row));
  }

  private mapReviewPost(post: ReviewPostRow): SafetyDeskQueueItem {
    const photoUrls = this.readStringArray(post.photoUrls);
    const videoUrls = this.readStringArray(post.videoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const prepared = this.preparePublishPayload(post, photoUrls, videoUrls, linkUrls);
    const domains = this.extractDomains([post.url, ...linkUrls]);
    const risk = this.resolveRisk(post, prepared, domains, photoUrls, videoUrls);
    const reasons = this.buildReasons(post, prepared, domains, photoUrls, videoUrls);
    const checks = this.buildChecks(post, prepared, domains, photoUrls, videoUrls);
    const status =
      risk === 'BLOCKED' || checks.some((check) => check.state === 'BLOCKED')
        ? 'BLOCKED'
        : 'REVIEW';

    return {
      id: post.id,
      source: 'VK_REVIEW',
      sourceId: post.sourceId,
      chatId: post.chatId,
      entityTitle: this.buildEntityTitle(post),
      sourceTitle: post.source.title,
      author: post.source.title || 'Внешний источник',
      status,
      risk,
      title: this.buildTitle(post),
      text: post.text,
      domains,
      photoUrls,
      videoUrls,
      linkUrls,
      originalUrl: post.url || null,
      scheduledAt: post.publishScheduledAt ? post.publishScheduledAt.toISOString() : null,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      reasons,
      checks,
    };
  }

  private buildReasons(
    post: ReviewPostRow,
    prepared: PreparedVkPublishPayload | null,
    domains: string[],
    photoUrls: string[],
    videoUrls: string[],
  ): string[] {
    const reasons = ['Источник настроен на ручную проверку перед публикацией'];

    if (post.status === VK_POST_STATUS_FAILED || post.lastError) {
      reasons.push(
        `Предыдущая попытка остановлена: ${post.lastError ?? 'требуется повторная проверка'}`,
      );
    }
    if (domains.length > 0) {
      reasons.push('Найдены внешние ссылки');
    }
    if (photoUrls.length > 0 || videoUrls.length > 0) {
      reasons.push(`Медиа вложения: ${photoUrls.length + videoUrls.length}`);
    }
    if (post.hasUnsupportedAttachments) {
      reasons.push('Есть вложения, которые нельзя безопасно перенести автоматически');
    }
    if (!prepared) {
      reasons.push('После правил публикации не осталось текста, фото, видео или ссылок');
    }
    if (post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0) {
      reasons.push('Найдены коммерческие маркеры, нужна ручная оценка');
    }
    if (post.publishScheduledAt) {
      reasons.push('Материал был поставлен в отложенную публикацию');
    }

    return reasons;
  }

  private buildChecks(
    post: ReviewPostRow,
    prepared: PreparedVkPublishPayload | null,
    domains: string[],
    photoUrls: string[],
    videoUrls: string[],
  ): SafetyDeskQueueItem['checks'] {
    return [
      {
        label: 'Принудительное добавление пользователей не используется',
        state: 'PASSED',
      },
      {
        label:
          post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0
            ? 'Коммерческие маркеры требуют ручной оценки'
            : 'Запрещенные категории не обнаружены автоматически',
        state:
          post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0
            ? 'WARNING'
            : 'PASSED',
      },
      {
        label: domains.length > 0 ? 'Ссылки извлечены для проверки' : 'Внешних ссылок нет',
        state: domains.length > 0 ? 'WARNING' : 'PASSED',
      },
      {
        label: prepared
          ? 'Есть поддерживаемый текст, фото, видео или ссылка'
          : 'После правил публикации не осталось текста, фото, видео или ссылок',
        state: prepared ? 'PASSED' : 'BLOCKED',
      },
      {
        label:
          photoUrls.length > 0 && videoUrls.length > 0
            ? 'В одном VK-посте нельзя безопасно смешать фото и видео'
            : 'Формат медиа пригоден для публикации',
        state: photoUrls.length > 0 && videoUrls.length > 0 ? 'BLOCKED' : 'PASSED',
      },
      {
        label: post.hasUnsupportedAttachments
          ? 'Есть неподдерживаемые вложения'
          : 'Вложения пригодны для безопасной публикации',
        state: post.hasUnsupportedAttachments ? 'BLOCKED' : 'PASSED',
      },
      {
        label: 'До решения владельца в MAX ничего не отправляется',
        state: 'PASSED',
      },
    ];
  }

  private isApprovableItem(item: SafetyDeskQueueItem): boolean {
    return item.status === 'REVIEW' && item.checks.every((check) => check.state !== 'BLOCKED');
  }

  private buildNotApprovableMessage(item: SafetyDeskQueueItem): string {
    const blockedReasons = item.checks
      .filter((check) => check.state === 'BLOCKED')
      .map((check) => check.label);

    if (blockedReasons.length === 0) {
      const reason = item.reasons[0]?.trim();
      return reason
        ? `Этот материал нельзя опубликовать автоматически: ${reason}.`
        : SAFETY_DESK_BLOCKED_APPROVE_MESSAGE;
    }

    return `Этот материал нельзя опубликовать автоматически: ${blockedReasons.join('; ')}.`;
  }

  private hasAmbiguousMaxSendError(lastError: string | null): boolean {
    return lastError?.trim().startsWith(MAX_SEND_AMBIGUOUS_ERROR_PREFIX) === true;
  }

  private resolveRisk(
    post: ReviewPostRow,
    prepared: PreparedVkPublishPayload | null,
    domains: string[],
    photoUrls: string[],
    videoUrls: string[],
  ): SafetyDeskRiskLevel {
    if (!prepared || post.status === VK_POST_STATUS_FAILED || post.lastError) {
      return 'BLOCKED';
    }
    if (post.hasUnsupportedAttachments) {
      return 'HIGH';
    }
    if (post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0) {
      return 'HIGH';
    }
    if (domains.length > 0 || photoUrls.length > 0 || videoUrls.length > 0) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  private mapAuditEntry(row: SafetyAuditRow): SafetyDeskAuditEntry {
    const payload = this.asRecord(row.payload) ?? {};
    return {
      id: row.id,
      itemId: this.readString(payload.postId) || null,
      action: row.action,
      title: this.readString(payload.itemTitle) || this.auditActionLabel(row.action),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private buildTitle(post: ReviewPostRow): string {
    const firstLine = post.text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) {
      return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
    }
    if (post.source.title) {
      return `Публикация из ${post.source.title}`;
    }
    return `Материал ${post.vkOwnerId}_${post.vkPostId}`;
  }

  private buildEntityTitle(post: ReviewPostRow): string {
    const prefix = post.chat.entityType === ChatEntityType.CHANNEL ? 'Канал' : 'Чат';
    return `${prefix}: ${post.chat.title || post.chatId}`;
  }

  private extractDomains(urls: string[]): string[] {
    const domains = new Set<string>();
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        if (hostname && !this.isTrustedDomain(hostname)) {
          domains.add(hostname);
        }
      } catch {
        continue;
      }
    }
    return [...domains].sort();
  }

  private isTrustedDomain(hostname: string): boolean {
    const normalized = hostname.replace(/\.$/u, '');
    return SAFETY_DESK_TRUSTED_DOMAIN_ROOTS.some(
      (root) => normalized === root || normalized.endsWith(`.${root}`),
    );
  }

  private async approveReviewPost(
    post: ReviewPostRow,
    actorUserId: string | null,
    reason: string | null,
  ): Promise<void> {
    const photoUrls = this.readStringArray(post.photoUrls);
    const videoUrls = this.readStringArray(post.videoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const result = await this.vkPublishService.publishPost(
      post.chatId,
      post.id,
      SAFETY_DESK_ACTOR_USER_ID,
      {
        text: post.text,
        photoUrls,
        videoUrls,
        linkUrls,
      },
    );
    await this.writeAuditLog(post.chatId, actorUserId, 'SAFETY_DESK_APPROVE', {
      postId: post.id,
      sourceId: post.sourceId,
      itemTitle: this.buildTitle(post),
      reason,
      messageId: result.messageId,
      url: result.url,
    });
  }

  private hasPublishableContent(post: ReviewPostRow): boolean {
    return Boolean(
      this.preparePublishPayload(
        post,
        this.readStringArray(post.photoUrls),
        this.readStringArray(post.videoUrls),
        this.readStringArray(post.linkUrls),
      ),
    );
  }

  private preparePublishPayload(
    post: ReviewPostRow,
    photoUrls: string[],
    videoUrls: string[],
    linkUrls: string[],
  ): PreparedVkPublishPayload | null {
    const settings = this.resolveVkParsingSettings(post);
    const preservedLinkUrls = this.resolveStripPreservedLinkUrls(post);
    const skipReason = resolveVkParsingPostSkipReason(
      {
        text: post.text,
        photoUrls,
        videoUrls,
        linkUrls,
        attachments: this.readRecords(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: post.isAdvertising,
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    if (skipReason) {
      return null;
    }

    const prepared = prepareVkParsingPublishPayload(
      {
        text: post.text,
        photoUrls,
        videoUrls,
        linkUrls,
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    if (
      prepared.text.trim().length === 0 &&
      prepared.photoUrls.length === 0 &&
      prepared.videoUrls.length === 0 &&
      prepared.linkUrls.length === 0
    ) {
      return null;
    }

    return prepared;
  }

  private resolveVkParsingSettings(post: ReviewPostRow) {
    return {
      stripLinksEnabled: post.chat.vkParsingSettings?.stripLinksEnabled ?? false,
      skipAdsEnabled: post.chat.vkParsingSettings?.skipAdsEnabled ?? false,
    };
  }

  private buildDeleteIntentStatusCounts(
    groups: ReadonlyArray<{ status: string; _count: { _all: number } }>,
  ): SafetyDeskDeleteIntentStatusCounts {
    const counts: SafetyDeskDeleteIntentStatusCounts = {
      OBSERVED: 0,
      PENDING: 0,
      IN_PROGRESS: 0,
      RETRYABLE: 0,
      WAITING_CAPABILITY: 0,
      AMBIGUOUS: 0,
      SUCCEEDED: 0,
      ALREADY_ABSENT: 0,
      EXPIRED: 0,
      FAILED_TERMINAL: 0,
    };
    const knownStatuses = new Set<string>(DELETE_INTENT_STATUSES);
    for (const group of groups) {
      if (knownStatuses.has(group.status)) {
        counts[group.status as SafetyDeskDeleteIntentStatus] = Math.max(0, group._count._all);
      }
    }
    return counts;
  }

  private sanitizeSafetyDeskLastError(value: string | null): string | null {
    const normalized = value?.trim().replace(/\s+/gu, ' ') ?? '';
    if (!normalized) {
      return null;
    }

    const redacted = normalized
      .replace(/\bhttps?:\/\/[^\s?]+\?[^\s]+/giu, (url) => `${url.split('?')[0]}?[redacted]`)
      .replace(/\b(authorization\s*[:=]\s*(?:bearer|initdata)\s+)[^\s,;]+/giu, '$1[redacted]')
      .replace(/\b(bearer|initdata)\s+[^\s,;]+/giu, '$1 [redacted]')
      .replace(
        /(\b(?:authorization|x-admin-access-code|access[_-]?token|refresh[_-]?token|init[_-]?data|secret|token)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
        '$1[redacted]',
      );

    return redacted.slice(0, SAFETY_DESK_LAST_ERROR_LIMIT);
  }

  private mapDeleteIntent(row: DeleteIntentDiagnosticRow, now: Date): SafetyDeskDeleteIntentItem {
    const entityType = row.entityType ?? row.chat.entityType;
    const routingPolicy = this.normalizeDeleteRoutingPolicy(row.routingPolicy);
    const crossBotEnabled =
      entityType === ChatEntityType.CHAT &&
      row.messageAuthorKind === 'user' &&
      (this.deleteCrossBotCanaryChatIds.has('*') ||
        this.deleteCrossBotCanaryChatIds.has(row.chatId));
    const effectiveRoutingPolicy = crossBotEnabled
      ? routingPolicy === 'delete_capable'
        ? 'delete_capable'
        : 'origin_first'
      : 'origin_only';
    const memberships = row.chat.botMemberships.map((membership) =>
      this.mapDeleteMembershipCapability(membership, entityType, now),
    );
    const confirmedBotIds = memberships
      .filter((membership) => membership.state === 'confirmed_capable')
      .map((membership) => membership.botId);
    const executableConfirmedBotIds =
      effectiveRoutingPolicy === 'origin_only'
        ? confirmedBotIds.filter((botId) => botId === row.originBotId)
        : confirmedBotIds;

    return {
      id: row.id,
      chatId: row.chatId,
      chatTitle: row.chat.title,
      messageId: row.messageId,
      subjectUserId: row.subjectUserId,
      entityType,
      originBotId: row.originBotId,
      routingPolicy,
      effectiveRoutingPolicy,
      crossBotEnabled,
      routingState: row.chat.routingState,
      rollout: resolveModerationDeleteIntentRollout({
        mode: this.deleteIntentMode,
        canaryChatIds: this.deleteIntentCanaryChatIds,
        chatId: row.chatId,
      }),
      status: row.status,
      ageMs: Math.max(0, now.getTime() - row.createdAt.getTime()),
      attemptCount: row.attemptCount,
      executeAt: row.executeAt.toISOString(),
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      retryUntilAt: row.retryUntilAt.toISOString(),
      firstAttemptAt: row.firstAttemptAt?.toISOString() ?? null,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
      deleteDispatchStartedAt: row.deleteDispatchStartedAt?.toISOString() ?? null,
      deleteDispatchStartedBotId: row.deleteDispatchStartedBotId,
      remoteDeleteSucceededAt: row.remoteDeleteSucceededAt?.toISOString() ?? null,
      remoteDeleteSucceededBotId: row.remoteDeleteSucceededBotId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastBotId: row.lastBotId,
      succeededBotId: row.succeededBotId,
      lastStatusCode: row.lastStatusCode,
      lastErrorCode: row.lastErrorCode,
      lastError: row.lastError,
      capability: {
        confirmed: executableConfirmedBotIds.length > 0,
        activeMembershipCount: memberships.length,
        confirmedBotIds: executableConfirmedBotIds,
        memberships,
      },
      reasons: row.reasons.map((reason) => ({
        reasonKey: reason.reasonKey,
        ruleCode: reason.ruleCode,
        userId: reason.userId,
        score: reason.score,
        createdAt: reason.createdAt.toISOString(),
      })),
    };
  }

  private mapDeleteMembershipCapability(
    membership: DeleteIntentDiagnosticRow['chat']['botMemberships'][number],
    entityType: ChatEntityType | null,
    now: Date,
  ): SafetyDeskDeleteMembershipCapability {
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    const configuredBot = this.maxBotRegistry.getBotById(membership.botId);
    const botRuntimeState: SafetyDeskDeleteMembershipCapability['botRuntimeState'] =
      configuredBot?.state ?? 'unconfigured';
    const snapshotCheckedAt = this.toValidIsoString(snapshot?.checkedAt ?? null);
    const snapshotCheckedAtMs = snapshotCheckedAt ? Date.parse(snapshotCheckedAt) : Number.NaN;
    const membershipCheckedAtMs = membership.botAccessCheckedAt?.getTime() ?? Number.NaN;
    const checkedAtMs = Number.isFinite(membershipCheckedAtMs)
      ? membershipCheckedAtMs
      : snapshotCheckedAtMs;
    const expiresAtMs = membership.botAccessExpiresAt?.getTime() ?? Number.NaN;
    const base = {
      botId: membership.botId,
      role: membership.role,
      accessState: membership.botAccessState,
      botRuntimeState,
      checkedAt: Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : null,
      expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
      snapshotCheckedAt,
      isAdmin: snapshot?.isAdmin ?? false,
      isOwner: snapshot?.isOwner ?? false,
      permissions: snapshot?.permissions ?? [],
    };
    const result = (
      state: SafetyDeskDeleteCapabilityState,
      reason: SafetyDeskDeleteCapabilityReason,
    ): SafetyDeskDeleteMembershipCapability => ({ ...base, state, reason });

    if (membership.botAccessState === 'DENIED' || membership.botAccessState === 'LOST') {
      return result('explicitly_incapable', 'access_denied');
    }
    if (!snapshot) {
      return result('stale_or_unknown', 'snapshot_missing');
    }

    const nowMs = now.getTime();
    const fresh =
      Number.isFinite(checkedAtMs) &&
      checkedAtMs <= nowMs &&
      (Number.isFinite(expiresAtMs)
        ? expiresAtMs > nowMs
        : isFreshMembershipAccessSnapshot(snapshot, { nowMs }));
    if (!fresh || membership.botAccessState === 'STALE') {
      return result('stale_or_unknown', 'snapshot_stale');
    }

    const permissionFailure = resolveDeleteMessageAccessFailure(snapshot, entityType);
    if (permissionFailure) {
      return result('explicitly_incapable', permissionFailure);
    }
    if (
      membership.botAccessState !== 'CONFIRMED_ADMIN' &&
      membership.botAccessState !== 'CONFIRMED_OWNER'
    ) {
      return result('stale_or_unknown', 'access_state_unconfirmed');
    }
    if (!configuredBot || !canExecuteActionsForBotState(configuredBot.state)) {
      return result('stale_or_unknown', 'bot_not_actionable');
    }

    return result('confirmed_capable', 'confirmed');
  }

  private normalizeDeleteRoutingPolicy(
    value: string,
  ): 'delete_capable' | 'origin_first' | 'origin_only' {
    if (value === 'delete_capable' || value === 'origin_first') {
      return value;
    }
    return 'origin_only';
  }

  private toValidIsoString(value: string | null): string | null {
    if (!value) {
      return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  private buildApproveAllMessage(
    approved: number,
    failed: number,
    eligible: number,
    requested: number,
  ): string {
    const unavailable = Math.max(0, requested - eligible);
    const unavailableSuffix =
      unavailable > 0 ? ` Уже недоступно или заблокировано: ${unavailable}.` : '';
    if (eligible === 0) {
      return unavailable > 0
        ? `Выбранные материалы уже недоступны для массового одобрения.${unavailableSuffix}`
        : 'Нет материалов, доступных для массового одобрения.';
    }
    if (failed > 0) {
      return `Одобрено ${approved} из ${eligible}. Не удалось опубликовать: ${failed}.${unavailableSuffix}`;
    }
    if (approved === 0) {
      return 'Нет материалов, доступных для массового одобрения.';
    }
    return `Одобрено и опубликовано материалов: ${approved}.${unavailableSuffix}`;
  }

  private readStringArray(value: Prisma.JsonValue | unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
  }

  private readRecords(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  private resolveStripPreservedLinkUrls(post: ReviewPostRow): string[] {
    const postUrl = this.readString(post.url);
    if (!postUrl) {
      return [];
    }
    const linkUrls = this.readStringArray(post.linkUrls);
    if (!linkUrls.includes(postUrl)) {
      return [];
    }
    if (
      this.readStringArray(post.photoUrls).length > 0 ||
      this.readStringArray(post.videoUrls).length > 0
    ) {
      return [];
    }
    const hasUnsupportedVideo = this.readRecords(post.unsupportedAttachments).some((item) => {
      const type = this.readString(item.type).toLowerCase();
      return type === 'video' || type === 'clip';
    });

    return hasUnsupportedVideo ? [postUrl] : [];
  }

  private async writeAuditLog(
    chatId: string,
    actorUserId: string | null,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: this.resolveActor(actorUserId),
        action,
        payload: this.toJsonInput(payload),
      },
    });
  }

  private resolveActor(actorUserId: string | null): string {
    const normalized = actorUserId?.trim();
    return normalized || SAFETY_DESK_ACTOR_USER_ID;
  }

  private auditActionLabel(action: string): string {
    if (action === 'SAFETY_DESK_APPROVE') {
      return 'Материал одобрен';
    }
    if (action === 'SAFETY_DESK_REJECT') {
      return 'Материал отклонен';
    }
    if (action === 'SAFETY_DESK_RECHECK') {
      return 'Повторная проверка';
    }
    return 'Решение Safety Desk';
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
