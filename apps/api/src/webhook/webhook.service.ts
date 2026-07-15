import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSummary, MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';
import {
  ChatEntityType,
  ManagedEntityAccessState,
  Prisma,
  WebhookExecutionClaimStatus,
  WebhookStatus,
} from '../prisma/prisma-client';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import {
  buildChatUserDisplayNameInsertIfAbsent,
  buildChatUserDisplayNameUpsert,
  type ChatUserDisplayNameObservation,
} from '../common/chat-user-display-name-read-model.util';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxChatMemberAccess,
} from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import {
  ManagedEntityHandshakeService,
  MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
  MANAGED_ENTITY_HANDSHAKE_START_BUTTON_TEXT,
} from '../max/managed-entity-handshake.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildWebhookSemanticEventKey,
  readWebhookEventTimestamp,
} from './webhook-semantic-event-key';
import {
  normalizeWebhookCanonicalCanaryPercent,
  normalizeWebhookCanonicalExecutionMode,
  shouldEnforceCanonicalWebhookExecution,
  type WebhookCanonicalExecutionMode,
} from './webhook-canonical-execution-mode';

type WebhookIngestResult = {
  accepted: boolean;
  duplicate: boolean;
};

export type WebhookReceiptResult = WebhookIngestResult & {
  webhookEventId: string | null;
};

export type PreparedWebhookExecution = {
  canonical: boolean;
  prepared: boolean;
  normalizedPayload: unknown;
  executionBotId: string | null;
  enforced: boolean;
};

type WebhookExecutionClaimRow = {
  id: string;
  kind: string;
  semanticKey: string;
  webhookEventId: string;
  executionBotId: string | null;
  enforced: boolean;
  status: WebhookExecutionClaimStatus;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  preparedAt: Date | null;
};

type MembershipActivityProjection = {
  id: string;
  dedupeKey: string;
  botId?: string | null;
  chatId: string;
  eventType: string;
  userId?: string | null;
  senderName?: string | null;
  eventAt: Date;
  createdAt: Date;
};

type MembershipActivityEventModel = {
  createMany: (args: {
    data: MembershipActivityProjection[];
    skipDuplicates?: boolean;
  }) => Promise<unknown>;
};

type ManagedEntityLocalActivityProjection = {
  userId: string;
  chatId: string;
  entityType: ChatEntityType;
  chatTitle?: string | null;
  sourceEventType: string;
  botId?: string | null;
  lastEventAt: Date;
};

type ManagedEntityLocalActivityRawClient = {
  $executeRaw?: (query: Prisma.Sql) => Promise<unknown>;
};

type ExecutionOwnerFailoverRecheckParams = {
  update: MaxUpdate;
  chatId: string;
  incomingBotId: string | null;
  currentOwnerBotId: string | null;
};

type ChatBotBindingSyncResult = {
  executionOwnerBotId: string | null;
  pendingExecutionOwnerRecheck: ExecutionOwnerFailoverRecheckParams | null;
};

type BotSelfAccessCacheEntry = {
  canHandleUserFacing: boolean;
  expiresAtMs: number;
};

type PersistedBotSelfAccessSnapshot = {
  canHandleUserFacing: boolean;
  checkedAtMs: number | null;
};

const BOT_SELF_ACCESS_CACHE_TTL_MS = 5 * 60 * 1_000;
const BOT_SELF_ACCESS_NEGATIVE_CACHE_TTL_MS = 60 * 1_000;
const BOT_SELF_ACCESS_BACKOFF_MS = 30 * 1_000;
const BOT_SELF_ACCESS_TIMEOUT_MS = 900;
const BOT_SELF_ACCESS_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1_000;
const EXECUTION_OWNER_ASYNC_RECHECK_BACKOFF_MS = 30 * 1_000;
const BOT_ADDED_START_HINT_SEND_TIMEOUT_MS = 1_500;
const BOT_ADDED_START_HINT_FAILURE_METRIC_STATUSES = [403, 404] as const;
const BOT_SELF_ACCESS_FAILURE_METRIC_STATUSES = [403, 404] as const;
const MANAGED_ENTITIES_PENDING_BOOTSTRAP_TTL_SEC = 15 * 60;
const WEBHOOK_LEGACY_DEDUP_COMPAT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const WEBHOOK_PREPARATION_LEASE_MS = 30_000;
const MANAGED_ENTITY_ONBOARDING_EPOCH_MS = 15 * 60_000;
const EXECUTION_CLAIM_KIND = 'EXECUTION';
const ONBOARDING_HINT_CLAIM_KIND = 'ONBOARDING_HINT';
const MEMBERSHIP_ACTIVITY_TIMESTAMP_GRANULARITY_MS = 1_000;
const MANAGED_ENTITY_ACTIVITY_UPDATE_TYPES = new Set([
  'message_created',
  'message_edited',
  'message_callback',
  'chat_title_changed',
  'bot_started',
  'bot_added',
  'user_added',
  'user_removed',
]);
const MEMBERSHIP_ACTIVITY_UPDATE_TYPES = new Set(['user_added', 'user_removed']);
const INLINE_EXECUTION_OWNER_REFRESH_UPDATE_TYPES = new Set([
  'bot_added',
  'bot_started',
  'chat_title_changed',
  'user_added',
  'user_removed',
]);
const CHAT_ADMIN_ROSTER_MEMBERSHIP_CHURN_UPDATE_TYPES = new Set([
  'bot_started',
  'user_added',
  'user_removed',
]);
const STORED_CHAT_BINDING_REUSE_UPDATE_TYPES = new Set([
  'message_created',
  'message_edited',
  'message_removed',
  'message_callback',
  'user_added',
  'user_removed',
]);
const EXTENDED_TERMINAL_BOT_LIFECYCLE_UPDATE_TYPES = new Set(['bot_stopped', 'dialog_removed']);
const DURABLE_BOT_LIFECYCLE_UPDATE_TYPES = new Set([
  'bot_added',
  'bot_removed',
  ...EXTENDED_TERMINAL_BOT_LIFECYCLE_UPDATE_TYPES,
]);

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private static readonly BOT_ADDED_ADMIN_ROSTER_RETRY_WINDOW_MS = 120_000;
  private readonly rawPayloadSampleRate: number;
  private readonly canonicalExecutionMode: WebhookCanonicalExecutionMode;
  private readonly canonicalExecutionCanaryPercent: number;
  private readonly canonicalExecutionCanaryEntityIds: ReadonlySet<string>;
  private readonly extendedLifecycleMode: WebhookCanonicalExecutionMode;
  private readonly extendedLifecycleCanaryPercent: number;
  private readonly extendedLifecycleCanaryEntityIds: ReadonlySet<string>;
  private readonly botSelfAccessCache = new Map<string, BotSelfAccessCacheEntry>();
  private readonly botSelfAccessBackoffUntilMs = new Map<string, number>();
  private readonly executionOwnerRecheckBackoffUntilMs = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
    @Optional() private readonly maxClient?: MaxClientService,
    @Optional()
    private readonly maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService,
    @Optional() private readonly chatContextCache?: ChatContextCacheService,
    @Optional() private readonly managedEntityHandshakeService?: ManagedEntityHandshakeService,
  ) {
    this.rawPayloadSampleRate = configService.get<number>('RAW_PAYLOAD_SAMPLE_RATE', 0.01);
    this.canonicalExecutionMode = normalizeWebhookCanonicalExecutionMode(
      configService.get<string>('WEBHOOK_CANONICAL_EXECUTION_MODE', 'shadow'),
    );
    this.canonicalExecutionCanaryPercent = normalizeWebhookCanonicalCanaryPercent(
      configService.get<number>('WEBHOOK_CANONICAL_EXECUTION_CANARY_PERCENT', 1),
    );
    this.canonicalExecutionCanaryEntityIds = this.parseCanaryEntityIds(
      configService.get<string>('WEBHOOK_CANONICAL_EXECUTION_CANARY_ENTITY_IDS', ''),
    );
    this.extendedLifecycleMode = normalizeWebhookCanonicalExecutionMode(
      configService.get<string>('MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE', 'shadow'),
    );
    this.extendedLifecycleCanaryPercent = normalizeWebhookCanonicalCanaryPercent(
      configService.get<number>('MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_PERCENT', 1),
    );
    this.extendedLifecycleCanaryEntityIds = this.parseCanaryEntityIds(
      configService.get<string>('MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_ENTITY_IDS', ''),
    );
  }

  async ingest(update: MaxUpdate, sourceIp: string | null) {
    const receipt = await this.storeReceipt(update, sourceIp);
    if (receipt.duplicate) {
      await this.repairDuplicateReceiptReadModels(update);
      return { accepted: true, duplicate: true };
    }

    if (receipt.webhookEventId) {
      await this.preparePersistedWebhookEvent(receipt.webhookEventId, update);
    }
    return { accepted: true, duplicate: false };
  }

  async repairDuplicateReceiptReadModels(update: MaxUpdate): Promise<void> {
    await Promise.all([
      this.persistMembershipActivityProjection(update),
      this.persistUserDisplayNameSnapshots(update),
    ]);
  }

  async storeReceipt(update: MaxUpdate, sourceIp: string | null): Promise<WebhookReceiptResult> {
    const legacyDuplicateResult = await this.handleLegacyDedupKeyDuplicate(update, false);
    if (legacyDuplicateResult) {
      return { ...legacyDuplicateResult, webhookEventId: null };
    }

    const shouldKeepRawPayload = Math.random() <= this.rawPayloadSampleRate;
    const rawPayload = shouldKeepRawPayload ? (update.raw ?? {}) : {};

    try {
      const webhookEventId = await this.persistReceipt(update, sourceIp, rawPayload);
      return { accepted: true, duplicate: false, webhookEventId };
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        return { accepted: true, duplicate: true, webhookEventId: null };
      }

      if (this.shouldRetryWithSanitizedPayload(error)) {
        const sanitizedUpdate = this.sanitizeForJsonStorage(update) as MaxUpdate;
        const sanitizedRawPayload = this.sanitizeForJsonStorage(rawPayload);
        try {
          const webhookEventId = await this.persistReceipt(
            sanitizedUpdate,
            sourceIp,
            sanitizedRawPayload,
          );
          this.logger.warn(
            {
              dedupKey: this.buildWebhookDedupKey(update),
              reason: this.extractErrorMessage(error),
            },
            'Stored webhook receipt with sanitized payload fallback',
          );
          return { accepted: true, duplicate: false, webhookEventId };
        } catch (retryError: unknown) {
          if (this.isUniqueConstraintError(retryError)) {
            return { accepted: true, duplicate: true, webhookEventId: null };
          }
          throw retryError;
        }
      }

      this.logger.error({ err: error }, 'Failed to store durable webhook receipt');
      throw error;
    }
  }

  async preparePersistedWebhookEvent(
    webhookEventId: string,
    fallbackUpdate?: MaxUpdate,
  ): Promise<PreparedWebhookExecution> {
    const event = await this.loadWebhookReceipt(webhookEventId, fallbackUpdate);
    if (!event) {
      return {
        canonical: false,
        prepared: false,
        normalizedPayload: fallbackUpdate ?? null,
        executionBotId: null,
        enforced: false,
      };
    }

    const update = event.normalizedPayload as MaxUpdate;
    const semanticKey =
      buildWebhookSemanticEventKey(update) ?? `receipt:${event.dedupKey || webhookEventId}`;
    const enforceCanonicalExecution = shouldEnforceCanonicalWebhookExecution({
      mode: this.resolveEntityScopedCanaryMode(
        this.canonicalExecutionMode,
        this.canonicalExecutionCanaryEntityIds,
        update.message?.chatId,
      ),
      canaryPercent: this.canonicalExecutionCanaryPercent,
      semanticKey,
    });
    const claimModel = this.getWebhookExecutionClaimModel();
    if (!claimModel || this.canonicalExecutionMode === 'off') {
      const prepared = await this.prepareWebhookEventCore(webhookEventId, update);
      return {
        canonical: true,
        prepared: true,
        normalizedPayload: prepared.update,
        executionBotId: prepared.executionBotId,
        enforced: false,
      };
    }

    await claimModel.createMany({
      data: [
        {
          kind: EXECUTION_CLAIM_KIND,
          semanticKey,
          webhookEventId,
          enforced: enforceCanonicalExecution,
        },
      ],
      skipDuplicates: true,
    });
    let claim = await claimModel.findUnique({
      where: {
        kind_semanticKey: {
          kind: EXECUTION_CLAIM_KIND,
          semanticKey,
        },
      },
    });
    if (!claim) {
      throw new Error(`Webhook execution claim disappeared for ${semanticKey}`);
    }

    if (enforceCanonicalExecution && !claim.enforced) {
      await claimModel.updateMany({
        where: { id: claim.id },
        data: { enforced: true },
      });
      claim = { ...claim, enforced: true };
    }

    if (claim.webhookEventId !== webhookEventId) {
      await this.touchMirroredReceiptMembership(update);
      if (!claim.enforced) {
        const prepared = await this.prepareWebhookEventCore(webhookEventId, update);
        return {
          canonical: true,
          prepared: true,
          normalizedPayload: prepared.update,
          executionBotId: null,
          enforced: false,
        };
      }

      await this.persistUserDisplayNameSnapshots(update);
      await this.markMirroredReceiptDuplicate(webhookEventId);
      return {
        canonical: false,
        prepared: true,
        normalizedPayload: update,
        executionBotId: claim.executionBotId,
        enforced: true,
      };
    }

    if (claim.preparedAt) {
      return {
        canonical: true,
        prepared: true,
        normalizedPayload: update,
        executionBotId: claim.executionBotId,
        enforced: claim.enforced,
      };
    }

    const leaseToken = randomUUID();
    const now = new Date();
    const lease = await claimModel.updateMany({
      where: {
        id: claim.id,
        preparedAt: null,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + WEBHOOK_PREPARATION_LEASE_MS),
      },
    });
    if (lease.count === 0) {
      claim =
        (await claimModel.findUnique({
          where: {
            kind_semanticKey: {
              kind: EXECUTION_CLAIM_KIND,
              semanticKey,
            },
          },
        })) ?? claim;
      return {
        canonical: true,
        prepared: claim.preparedAt !== null,
        normalizedPayload: update,
        executionBotId: claim.executionBotId,
        enforced: claim.enforced,
      };
    }

    try {
      const prepared = await this.prepareWebhookEventCore(webhookEventId, update);
      const published = await claimModel.updateMany({
        where: {
          id: claim.id,
          leaseToken,
        },
        data: {
          executionBotId: prepared.executionBotId,
          enforced: claim.enforced || enforceCanonicalExecution,
          status: WebhookExecutionClaimStatus.READY,
          preparedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (published.count !== 1) {
        throw new Error(`Webhook preparation lease was lost before READY for ${webhookEventId}`);
      }
      return {
        canonical: true,
        prepared: true,
        normalizedPayload: prepared.update,
        executionBotId: prepared.executionBotId,
        enforced: claim.enforced || enforceCanonicalExecution,
      };
    } catch (error: unknown) {
      await claimModel.updateMany({
        where: {
          id: claim.id,
          leaseToken,
        },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      throw error;
    }
  }

  private async invalidateMembershipCacheFromWebhook(update: MaxUpdate): Promise<void> {
    const chatId = update.message?.chatId?.trim() ?? '';
    const memberUserIds =
      update.membership?.memberUserIds ??
      (this.isDirectMembershipChange(update) && update.message?.senderId
        ? [update.message.senderId]
        : []);

    if (!chatId || memberUserIds.length === 0) {
      return;
    }

    if (this.membershipLookupService) {
      try {
        await this.membershipLookupService.invalidateMemberships(chatId, memberUserIds);
      } catch (error: unknown) {
        this.logger.warn(
          {
            updateId: update.updateId,
            chatId,
            memberUserIds,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to invalidate MAX membership cache from webhook',
        );
      }
    }

    try {
      await this.invalidateManagedEntityAccessEdgesFromWebhook(update, chatId, memberUserIds);
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId,
          memberUserIds,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to invalidate managed entity access edges from webhook',
      );
    }
  }

  private isDirectMembershipChange(update: MaxUpdate): boolean {
    const normalizedType = update.type.trim().toLowerCase();
    return (
      normalizedType === 'user_added' ||
      normalizedType === 'bot_added' ||
      normalizedType === 'user_removed' ||
      normalizedType === 'bot_removed'
    );
  }

  private async invalidateManagedEntityAccessEdgesFromWebhook(
    update: MaxUpdate,
    chatId: string,
    memberUserIds: readonly string[],
  ): Promise<void> {
    if (update.type.trim().toLowerCase() !== 'user_removed') {
      return;
    }

    const normalizedUserIds = Array.from(
      new Set(
        memberUserIds
          .map((userId) => userId.trim())
          .filter((userId): userId is string => userId.length > 0),
      ),
    );
    if (normalizedUserIds.length === 0) {
      return;
    }

    const accessEdge = (
      this.prisma as PrismaService & {
        managedEntityAccessEdge?: {
          updateMany?: (args: unknown) => Promise<unknown>;
        };
      }
    ).managedEntityAccessEdge;
    if (typeof accessEdge?.updateMany !== 'function') {
      return;
    }

    await accessEdge.updateMany({
      where: {
        chatId,
        userId: {
          in: normalizedUserIds,
        },
      },
      data: {
        state: ManagedEntityAccessState.USER_DENIED,
        userRole: 'MEMBER',
        botRole: 'UNKNOWN',
        checkedAt: new Date(),
        expiresAt: null,
        deniedReason: 'webhook_user_removed',
        source: 'webhook_user_removed',
      },
    });
  }

  private async persistReceipt(
    update: MaxUpdate,
    sourceIp: string | null,
    rawPayload: Prisma.InputJsonValue,
  ): Promise<string> {
    const storageRawPayload = this.sanitizeForJsonStorage(rawPayload);
    const storageNormalizedPayload = this.sanitizeForJsonStorage(update);
    const webhookEventId = randomUUID();
    const data: Prisma.WebhookEventCreateManyInput = {
      id: webhookEventId,
      dedupKey: this.buildWebhookDedupKey(update),
      ...(update.botId ? { botId: update.botId } : {}),
      sourceIp: sourceIp ?? undefined,
      rawPayload: storageRawPayload,
      normalizedPayload: storageNormalizedPayload,
      status: WebhookStatus.RECEIVED,
    };
    const createMany = (
      this.prisma.webhookEvent as unknown as {
        createMany?: (args: {
          data: Prisma.WebhookEventCreateManyInput[];
          skipDuplicates: boolean;
        }) => Promise<{ count: number }>;
      }
    ).createMany;
    if (typeof createMany === 'function') {
      const result = await createMany.call(this.prisma.webhookEvent, {
        data: [data],
        skipDuplicates: true,
      });
      if (result.count === 0) {
        throw Object.assign(new Error('Duplicate webhook receipt'), { code: 'P2002' });
      }
      return webhookEventId;
    }

    const created = await this.prisma.webhookEvent.create({
      data,
      select: {
        id: true,
      },
    });
    return created.id;
  }

  private async loadWebhookReceipt(
    webhookEventId: string,
    fallbackUpdate?: MaxUpdate,
  ): Promise<{
    id: string;
    dedupKey: string;
    botId: string | null;
    status: WebhookStatus;
    normalizedPayload: unknown;
  } | null> {
    const findUnique = (
      this.prisma.webhookEvent as unknown as {
        findUnique?: (args: unknown) => Promise<{
          id: string;
          dedupKey?: string | null;
          botId?: string | null;
          status?: WebhookStatus;
          normalizedPayload?: unknown;
        } | null>;
      }
    ).findUnique;
    if (typeof findUnique === 'function') {
      const stored = await findUnique.call(this.prisma.webhookEvent, {
        where: { id: webhookEventId },
        select: {
          id: true,
          dedupKey: true,
          botId: true,
          status: true,
          normalizedPayload: true,
        },
      });
      if (stored?.normalizedPayload) {
        return {
          id: stored.id,
          dedupKey: stored.dedupKey ?? '',
          botId: stored.botId ?? null,
          status: stored.status ?? WebhookStatus.RECEIVED,
          normalizedPayload: stored.normalizedPayload,
        };
      }
    }

    if (!fallbackUpdate) {
      return null;
    }

    return {
      id: webhookEventId,
      dedupKey: this.buildWebhookDedupKey(fallbackUpdate),
      botId: fallbackUpdate.botId?.trim() || null,
      status: WebhookStatus.RECEIVED,
      normalizedPayload: fallbackUpdate,
    };
  }

  private getWebhookExecutionClaimModel(): {
    createMany: (args: {
      data: Array<{
        kind: string;
        semanticKey: string;
        webhookEventId: string;
        enforced?: boolean;
      }>;
      skipDuplicates: boolean;
    }) => Promise<{ count: number }>;
    findUnique: (args: unknown) => Promise<WebhookExecutionClaimRow | null>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  } | null {
    const model = (
      this.prisma as PrismaService & {
        webhookExecutionClaim?: {
          createMany?: (args: unknown) => Promise<{ count: number }>;
          findUnique?: (args: unknown) => Promise<WebhookExecutionClaimRow | null>;
          updateMany?: (args: unknown) => Promise<{ count: number }>;
        };
      }
    ).webhookExecutionClaim;
    if (
      typeof model?.createMany !== 'function' ||
      typeof model.findUnique !== 'function' ||
      typeof model.updateMany !== 'function'
    ) {
      return null;
    }

    return {
      createMany: model.createMany.bind(model) as never,
      findUnique: model.findUnique.bind(model),
      updateMany: model.updateMany.bind(model),
    };
  }

  private async prepareWebhookEventCore(
    webhookEventId: string,
    update: MaxUpdate,
  ): Promise<{ update: MaxUpdate; executionBotId: string | null }> {
    this.deferBackgroundTask(
      () => this.invalidateMembershipCacheFromWebhook(update),
      'membership cache invalidation',
      update,
    );
    const bindingSync = await this.syncChatBotBindingFromWebhook(update);
    this.attachExecutionOwnerBotId(update, bindingSync.executionOwnerBotId);
    await this.persistMembershipActivityProjection(update);
    this.deferBackgroundTask(
      () => this.persistAdminReadModels(update),
      'admin read model refresh',
      update,
    );
    await this.stageManagedEntityPendingBootstrap(update);
    this.schedulePendingExecutionOwnerFailoverRecheck(bindingSync.pendingExecutionOwnerRecheck);
    if (await this.claimManagedEntityOnboardingHint(webhookEventId, update)) {
      this.deferBotAddedStartHint(update);
    }
    this.deferManagedEntityHandshake(update);

    await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
      },
      data: {
        normalizedPayload: this.sanitizeForJsonStorage(update),
      },
    });

    return {
      update,
      executionBotId: bindingSync.executionOwnerBotId ?? update.executionOwnerBotId?.trim() ?? null,
    };
  }

  private async claimManagedEntityOnboardingHint(
    webhookEventId: string,
    update: MaxUpdate,
  ): Promise<boolean> {
    if (update.type.trim().toLowerCase() !== 'bot_added') {
      return false;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return false;
    }

    const claimModel = this.getWebhookExecutionClaimModel();
    if (!claimModel) {
      return true;
    }

    const occurredAtMs = (readWebhookEventTimestamp(update) ?? new Date()).getTime();
    const onboardingEpoch = Math.floor(occurredAtMs / MANAGED_ENTITY_ONBOARDING_EPOCH_MS);
    const result = await claimModel.createMany({
      data: [
        {
          kind: ONBOARDING_HINT_CLAIM_KIND,
          semanticKey: `${chatId}:${onboardingEpoch}`,
          webhookEventId,
        },
      ],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  private async markMirroredReceiptDuplicate(webhookEventId: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
      },
      data: {
        status: WebhookStatus.DUPLICATE,
        processedAt: new Date(),
        queueName: null,
        nextEnqueueAt: null,
        errorMessage: null,
      },
    });
  }

  private async touchMirroredReceiptMembership(update: MaxUpdate): Promise<void> {
    const chatId = update.message?.chatId?.trim() ?? '';
    const observedBotId = update.botId?.trim() ?? '';
    if (!chatId.startsWith('-') || !observedBotId) {
      return;
    }

    const primaryBotId = await this.maxBotLinkService.getStoredChatPrimaryBotId(chatId, {
      bypassCache: true,
    });
    await this.maxBotLinkService.observeStoredChatBotWebhook({
      chatId,
      primaryBotId,
      botId: observedBotId,
      observedAt: new Date(),
    });
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (error as { code?: string }).code === 'P2002';
  }

  private async stageManagedEntityPendingBootstrap(update: MaxUpdate): Promise<void> {
    if (!this.chatContextCache) {
      return;
    }

    const normalizedType = update.type.trim().toLowerCase();
    const isPendingBootstrapEvent =
      normalizedType === 'bot_added' || isManagedEntityHandshakeStartCommand(update);
    if (!isPendingBootstrapEvent) {
      return;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    const entityType = this.readWebhookChatEntityType(update);
    if (!chatId || !entityType) {
      return;
    }

    const title =
      update.message?.chatTitle?.trim() ||
      (entityType === ChatEntityType.CHANNEL ? `Channel ${chatId}` : `Chat ${chatId}`);
    const createdAtIso = update.message?.createdAt?.trim() || new Date().toISOString();
    const summary: ChatSummary = {
      id: chatId,
      title,
      createdAt: createdAtIso,
      entityType: entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
      link: null,
      primaryBotId: update.botId?.trim() || null,
      assignedBots: [],
      sharedMode: 'owned',
      channelOverview: null,
    };
    const bootstrapUserId = this.readManagedEntityPendingBootstrapUserId(update);

    try {
      await this.chatContextCache.upsertManagedEntitiesRecentBootstrap(
        summary,
        MANAGED_ENTITIES_PENDING_BOOTSTRAP_TTL_SEC,
        bootstrapUserId,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to stage managed entity pending bootstrap from bot_added webhook',
      );
    }
  }

  private deferManagedEntityHandshake(update: MaxUpdate): void {
    if (!this.managedEntityHandshakeService) {
      return;
    }

    this.deferBackgroundTask(
      async () => {
        await this.managedEntityHandshakeService?.handleWebhookUpdate(update);
      },
      'managed entity handshake',
      update,
    );
  }

  private deferBotAddedStartHint(update: MaxUpdate): void {
    if (!this.maxClient) {
      return;
    }

    if (update.type.trim().toLowerCase() !== 'bot_added') {
      return;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    const botId = update.botId?.trim() ?? '';
    const addedBotId = this.resolveBotAddedMemberBotId(update);
    const entityType = this.readWebhookChatEntityType(update);
    if (
      !chatId ||
      !botId ||
      !entityType ||
      this.isUnsupportedManagedRosterSyncChat(chatId, update.message?.entityType)
    ) {
      return;
    }
    if (addedBotId && addedBotId !== botId) {
      return;
    }

    this.deferBackgroundTask(
      async () => {
        await this.sendBotAddedStartHint(update, chatId, botId, entityType);
      },
      'bot added start hint',
      update,
    );
  }

  private async sendBotAddedStartHint(
    update: MaxUpdate,
    chatId: string,
    botId: string,
    entityType: ChatEntityType,
  ): Promise<void> {
    if (!this.maxClient) {
      return;
    }

    const entityLabel = entityType === ChatEntityType.CHANNEL ? 'Канал' : 'Чат';
    try {
      await this.maxClient.sendMessageImmediateWithId(
        chatId,
        `${entityLabel} почти подключен. Назначьте бота администратором, затем нажмите кнопку ниже. После проверки ${entityType === ChatEntityType.CHANNEL ? 'канал' : 'чат'} появится в мини-приложении.`,
        {
          buttons: [
            [
              {
                type: 'callback',
                text: MANAGED_ENTITY_HANDSHAKE_START_BUTTON_TEXT,
                payload: MANAGED_ENTITY_HANDSHAKE_START_CALLBACK_PAYLOAD,
                intent: 'positive',
              },
            ],
          ],
          debugContext: {
            screen: 'managed_entity_handshake',
            action: 'bot_added_hint',
          },
        },
        {
          botId,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_HANDSHAKE,
          timeoutMs: BOT_ADDED_START_HINT_SEND_TIMEOUT_MS,
          ignoreFailureMetricStatuses: BOT_ADDED_START_HINT_FAILURE_METRIC_STATUSES,
        },
      );
      this.logger.log(
        {
          updateId: update.updateId,
          chatId,
          botId,
          entityType,
        },
        'Managed entity handshake start hint sent',
      );
    } catch (error: unknown) {
      if (this.isExpectedBotAddedStartHintSendFailure(error)) {
        this.logger.debug(
          {
            updateId: update.updateId,
            chatId,
            botId,
            status: this.extractStatusCode(error),
            maxCode: this.extractMaxErrorCode(error),
            err: error instanceof Error ? error.message : String(error),
          },
          'Skipped managed entity start hint after bot_added webhook because chat is not yet reachable',
        );
        return;
      }

      this.logger.warn(
        {
          updateId: update.updateId,
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send managed entity start hint after bot_added webhook',
      );
    }
  }

  private resolveBotAddedMemberBotId(update: MaxUpdate): string | null {
    if (update.type.trim().toLowerCase() !== 'bot_added') {
      return null;
    }

    const memberBotId = update.membership?.memberUserIds?.find(
      (userId) => userId.trim().length > 0,
    );
    return memberBotId?.trim() || null;
  }

  private isExpectedBotAddedStartHintSendFailure(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (BOT_ADDED_START_HINT_FAILURE_METRIC_STATUSES.some((expected) => expected === status)) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    return code === 'chat.denied' || code === 'chat.not.found';
  }

  private readManagedEntityPendingBootstrapUserId(update: MaxUpdate): string | null {
    const senderId = update.message?.senderId?.trim() ?? '';
    if (!senderId) {
      return null;
    }

    const botId = update.botId?.trim() ?? '';
    return senderId !== botId ? senderId : null;
  }

  private deferBackgroundTask(
    task: () => Promise<void>,
    taskName: string,
    update: Pick<MaxUpdate, 'updateId' | 'type'>,
  ): void {
    setImmediate(() => {
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          this.logger.warn(
            {
              updateId: update.updateId,
              type: update.type,
              task: taskName,
              err: error instanceof Error ? error.message : String(error),
            },
            'Deferred webhook follow-up task failed',
          );
        });
    });
  }

  private async syncChatBotBindingFromWebhook(
    update: MaxUpdate,
  ): Promise<ChatBotBindingSyncResult> {
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return this.buildChatBotBindingSyncResult(null);
    }

    const entityType = this.readWebhookChatEntityType(update);
    const normalizedType = update.type.trim().toLowerCase();
    const trustedLifecycleEventAt = readWebhookEventTimestamp(update);
    let pendingExecutionOwnerRecheck: ExecutionOwnerFailoverRecheckParams | null = null;
    try {
      if (
        EXTENDED_TERMINAL_BOT_LIFECYCLE_UPDATE_TYPES.has(normalizedType) &&
        !this.shouldApplyExtendedLifecycleUpdate(update)
      ) {
        const storedOwnerBotId = await this.maxBotLinkService.getStoredChatPrimaryBotId(chatId, {
          bypassCache: true,
        });
        return this.buildChatBotBindingSyncResult(storedOwnerBotId);
      }

      if (this.isBotRemovalUpdate(update)) {
        if (!trustedLifecycleEventAt) {
          const storedOwnerBotId = await this.maxBotLinkService.getStoredChatPrimaryBotId(chatId, {
            bypassCache: true,
          });
          this.logger.warn(
            {
              updateId: update.updateId,
              type: normalizedType,
              chatId,
              botId: update.botId ?? null,
            },
            'Skipped terminal bot lifecycle transition without a trusted event timestamp',
          );
          this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
          return this.buildChatBotBindingSyncResult(storedOwnerBotId);
        }

        const removedBotId = this.resolveRemovedChatBotId(update);
        const nextOwnerBotId = await this.maxBotLinkService.markChatBotRemoved({
          chatId,
          title: update.message?.chatTitle ?? null,
          entityType,
          botId: removedBotId,
          lifecycleEventAt: trustedLifecycleEventAt,
          lifecycleEventType: normalizedType,
          lifecycleSource: 'webhook',
        });
        this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
        return this.buildChatBotBindingSyncResult(nextOwnerBotId);
      }

      if (STORED_CHAT_BINDING_REUSE_UPDATE_TYPES.has(normalizedType)) {
        const storedOwnerBotId = await this.maxBotLinkService.getStoredChatPrimaryBotId(chatId, {
          bypassCache: true,
        });
        if (storedOwnerBotId) {
          let executionOwnerBotId: string | null = storedOwnerBotId;
          const observedBotId = update.botId?.trim() || null;
          const shouldRefreshExecutionOwner = await this.shouldRefreshExecutionOwnerFromWebhook(
            update,
            storedOwnerBotId,
          );
          if (shouldRefreshExecutionOwner) {
            executionOwnerBotId = await this.maybeFailOverExecutionOwner({
              update,
              chatId,
              incomingBotId: update.botId ?? null,
              currentOwnerBotId: storedOwnerBotId,
              allowLiveCheck: false,
            });
            if (executionOwnerBotId === storedOwnerBotId) {
              pendingExecutionOwnerRecheck = {
                update,
                chatId,
                incomingBotId: update.botId ?? null,
                currentOwnerBotId: storedOwnerBotId,
              };
            }
          }
          if (
            !(
              observedBotId &&
              executionOwnerBotId !== storedOwnerBotId &&
              observedBotId === executionOwnerBotId
            )
          ) {
            await this.maxBotLinkService.observeStoredChatBotWebhook({
              chatId,
              primaryBotId: executionOwnerBotId ?? storedOwnerBotId,
              botId: observedBotId,
            });
          }
          this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
          return this.buildChatBotBindingSyncResult(
            executionOwnerBotId,
            pendingExecutionOwnerRecheck,
          );
        }
      }

      if (normalizedType !== 'bot_added' || !trustedLifecycleEventAt) {
        const verifiedBotId = await this.bindIncomingBotAfterLiveProbe(update, chatId, entityType);
        this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
        return this.buildChatBotBindingSyncResult(verifiedBotId);
      }

      const boundBotId = await this.maxBotLinkService.bindChatToBot({
        chatId,
        title: update.message?.chatTitle ?? null,
        entityType,
        botId: update.botId,
        ...(normalizedType === 'bot_added'
          ? {
              lifecycleEventAt: trustedLifecycleEventAt,
              lifecycleEventType: 'bot_added',
              lifecycleSource: 'webhook',
            }
          : {}),
      });
      let executionOwnerBotId = boundBotId;
      const shouldRefreshExecutionOwner = await this.shouldRefreshExecutionOwnerFromWebhook(
        update,
        boundBotId,
      );
      if (shouldRefreshExecutionOwner) {
        executionOwnerBotId = await this.maybeFailOverExecutionOwner({
          update,
          chatId,
          incomingBotId: update.botId ?? null,
          currentOwnerBotId: boundBotId,
          allowLiveCheck: false,
        });
        if (executionOwnerBotId === boundBotId) {
          pendingExecutionOwnerRecheck = {
            update,
            chatId,
            incomingBotId: update.botId ?? null,
            currentOwnerBotId: boundBotId,
          };
        }
      }
      this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
      return this.buildChatBotBindingSyncResult(executionOwnerBotId, pendingExecutionOwnerRecheck);
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          botId: update.botId ?? null,
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to bind chat to bot during webhook ingest',
      );
      if (DURABLE_BOT_LIFECYCLE_UPDATE_TYPES.has(normalizedType)) {
        throw error;
      }
      return this.buildChatBotBindingSyncResult(null);
    }
  }

  private buildChatBotBindingSyncResult(
    executionOwnerBotId: string | null,
    pendingExecutionOwnerRecheck: ExecutionOwnerFailoverRecheckParams | null = null,
  ): ChatBotBindingSyncResult {
    return {
      executionOwnerBotId,
      pendingExecutionOwnerRecheck,
    };
  }

  private async bindIncomingBotAfterLiveProbe(
    update: MaxUpdate,
    chatId: string,
    entityType: ChatEntityType | null,
  ): Promise<string | null> {
    const incomingBotId = update.botId?.trim() ?? '';
    if (!chatId.startsWith('-') || !incomingBotId || !this.maxClient) {
      return null;
    }

    const canHandleUserFacing = await this.getBotSelfModerationAccessState(chatId, incomingBotId, {
      bypassCache: true,
    });
    if (canHandleUserFacing !== true) {
      return null;
    }

    const probeCompletedAt = new Date();
    const boundBotId = await this.maxBotLinkService.bindChatToBot({
      chatId,
      title: update.message?.chatTitle ?? null,
      entityType,
      botId: incomingBotId,
      lifecycleEventAt: probeCompletedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
    if (!boundBotId) {
      return null;
    }

    // FLAG: Lifecycle reactivation requires access evidence collected after the
    // lifecycle watermark was stored. Do not collapse these two probes.
    const confirmedAfterLifecycle = await this.getBotSelfModerationAccessState(
      chatId,
      incomingBotId,
      { bypassCache: true },
    );
    if (confirmedAfterLifecycle !== true) {
      return null;
    }

    return this.maxBotLinkService.reconcileChatPrimaryByAccess({
      chatId,
      title: update.message?.chatTitle ?? null,
      entityType,
    });
  }

  private async maybeFailOverExecutionOwner(params: {
    update: MaxUpdate;
    chatId: string;
    incomingBotId: string | null;
    currentOwnerBotId: string | null;
    allowLiveCheck: boolean;
  }): Promise<string | null> {
    const incomingBotId = params.incomingBotId?.trim() ?? '';
    const currentOwnerBotId = params.currentOwnerBotId?.trim() ?? '';
    if (
      !params.chatId.startsWith('-') ||
      !incomingBotId ||
      !currentOwnerBotId ||
      incomingBotId === currentOwnerBotId
    ) {
      return params.currentOwnerBotId;
    }

    // Cached or persisted access evidence may schedule a probe, but it must never
    // be presented as a successful live probe for lifecycle reactivation.
    if (!params.allowLiveCheck) {
      return params.currentOwnerBotId;
    }

    const currentOwnerCanHandleUserFacing = await this.getBotSelfModerationAccessState(
      params.chatId,
      currentOwnerBotId,
      { bypassCache: true },
    );
    if (currentOwnerCanHandleUserFacing !== false) {
      return params.currentOwnerBotId;
    }

    const incomingBotCanHandleUserFacing = await this.getBotSelfModerationAccessState(
      params.chatId,
      incomingBotId,
      { bypassCache: true },
    );
    if (incomingBotCanHandleUserFacing !== true) {
      return params.currentOwnerBotId;
    }

    const reassignedBotId = await this.maxBotLinkService.bindChatToBot({
      chatId: params.chatId,
      title: params.update.message?.chatTitle ?? null,
      entityType: this.readWebhookChatEntityType(params.update),
      botId: incomingBotId,
      allowReassign: true,
      lifecycleEventAt: new Date(),
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });

    if (reassignedBotId === incomingBotId) {
      this.logger.warn(
        {
          chatId: params.chatId,
          updateId: params.update.updateId,
          previousPrimaryBotId: currentOwnerBotId,
          nextPrimaryBotId: incomingBotId,
        },
        'Promoted the incoming bot to primary after detecting stale owner permissions',
      );
    }

    return reassignedBotId ?? params.currentOwnerBotId;
  }

  private shouldPerformInlineExecutionOwnerLiveRefresh(update: MaxUpdate): boolean {
    return (
      INLINE_EXECUTION_OWNER_REFRESH_UPDATE_TYPES.has(update.type.trim().toLowerCase()) ||
      this.isPotentialGroupAdminModerationCommand(update)
    );
  }

  private isPotentialGroupAdminModerationCommand(update: MaxUpdate): boolean {
    if (update.type.trim().toLowerCase() !== 'message_created') {
      return false;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId.startsWith('-')) {
      return false;
    }

    const text = this.readTrimmedString(update.message?.text)?.toLowerCase() ?? '';
    if (!text) {
      return false;
    }

    return (
      /^(?:супер[\s-]+бан|super[\s-]+ban)[.!]?$/u.test(text) ||
      /^(?:бан|ban)(?:\s+\d{1,3}(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?)?[.!]?$/u.test(
        text,
      ) ||
      /^(?:мут|мьют|мью|mute)(?:\s+\d{1,3}(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?)?[.!]?$/u.test(
        text,
      ) ||
      (this.hasLinkedAdminCommandMessage(update) && this.isShortAdminCommandText(text))
    );
  }

  private hasLinkedAdminCommandMessage(update: MaxUpdate): boolean {
    const raw = this.asRecord(update.raw);
    const rawMessage = this.asRecord(raw?.message) ?? raw;
    if (!rawMessage) {
      return false;
    }

    const body = this.asRecord(rawMessage.body);
    const content = this.asRecord(rawMessage.content);
    const payload = this.asRecord(rawMessage.payload);
    return [
      rawMessage.link,
      rawMessage.forwarded_message,
      rawMessage.forwarded,
      body?.forwarded_message,
      body?.forwarded,
      body?.reply,
      body?.replied_message,
      content?.forwarded_message,
      content?.reply,
      payload?.forwarded_message,
      payload?.reply,
    ].some((candidate) => this.asRecord(candidate) !== null);
  }

  private isShortAdminCommandText(text: string): boolean {
    const normalized = text.trim();
    return (
      normalized.length > 0 &&
      normalized.length <= 64 &&
      /^[\p{L}\p{N}_ -]+[.!]?$/u.test(normalized)
    );
  }

  private async shouldRefreshExecutionOwnerFromWebhook(
    update: MaxUpdate,
    currentOwnerBotId: string | null,
  ): Promise<boolean> {
    if (this.shouldPerformInlineExecutionOwnerLiveRefresh(update)) {
      return true;
    }

    if (!this.shouldScheduleExecutionOwnerFailoverRecheck(update)) {
      return false;
    }

    const incomingBotId = update.botId?.trim() ?? '';
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!incomingBotId || !currentOwnerBotId || !chatId || incomingBotId === currentOwnerBotId) {
      return false;
    }

    return (
      (await this.getCachedOrPersistedBotSelfModerationAccessState(chatId, currentOwnerBotId)) ===
      false
    );
  }

  private async persistAdminReadModels(update: MaxUpdate): Promise<void> {
    const writes: Promise<unknown>[] = [];

    const managedProjection = this.buildManagedEntityLocalActivityProjection(update);
    const rawClient = this.prisma as ManagedEntityLocalActivityRawClient;
    const displayNameSnapshotUpsert = this.buildUserDisplayNameSnapshotUpsert(update);
    if (
      displayNameSnapshotUpsert &&
      this.hasChatUserDisplayNameReadModel() &&
      typeof rawClient.$executeRaw === 'function'
    ) {
      writes.push(rawClient.$executeRaw(displayNameSnapshotUpsert));
    }
    const managedModel = (
      this.prisma as PrismaService & {
        managedEntityLocalActivity?: {
          updateMany?: (args: {
            where: {
              userId: string;
              chatId: string;
              lastEventAt: {
                lt: Date;
              };
            };
            data: {
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
          }) => Promise<{ count: number }>;
          create?: (args: {
            data: {
              userId: string;
              chatId: string;
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
          }) => Promise<unknown>;
          upsert?: (args: {
            where: {
              userId_chatId: {
                userId: string;
                chatId: string;
              };
            };
            create: {
              userId: string;
              chatId: string;
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
            update: {
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
          }) => Promise<unknown>;
        };
      }
    ).managedEntityLocalActivity;
    if (managedProjection && typeof rawClient.$executeRaw === 'function') {
      writes.push(
        this.upsertManagedEntityLocalActivity(
          rawClient as Required<ManagedEntityLocalActivityRawClient>,
          managedProjection,
        ),
      );
    } else if (
      managedProjection &&
      typeof managedModel?.updateMany === 'function' &&
      typeof managedModel?.create === 'function'
    ) {
      const baseWrite = {
        entityType: managedProjection.entityType,
        sourceEventType: managedProjection.sourceEventType,
        botId: managedProjection.botId ?? null,
        lastEventAt: managedProjection.lastEventAt,
        ...(managedProjection.chatTitle ? { chatTitle: managedProjection.chatTitle } : {}),
      };
      writes.push(
        (async () => {
          const updateResult = await managedModel.updateMany({
            where: {
              userId: managedProjection.userId,
              chatId: managedProjection.chatId,
              lastEventAt: {
                lt: managedProjection.lastEventAt,
              },
            },
            data: baseWrite,
          });
          if (updateResult.count > 0) {
            return;
          }

          try {
            await managedModel.create({
              data: {
                userId: managedProjection.userId,
                chatId: managedProjection.chatId,
                ...baseWrite,
              },
            });
          } catch (error: unknown) {
            if (this.isPrismaKnownError(error, 'P2002')) {
              return;
            }

            throw error;
          }
        })(),
      );
    } else if (managedProjection && typeof managedModel?.upsert === 'function') {
      const baseWrite = {
        entityType: managedProjection.entityType,
        sourceEventType: managedProjection.sourceEventType,
        botId: managedProjection.botId ?? null,
        lastEventAt: managedProjection.lastEventAt,
        ...(managedProjection.chatTitle ? { chatTitle: managedProjection.chatTitle } : {}),
      };
      writes.push(
        managedModel.upsert({
          where: {
            userId_chatId: {
              userId: managedProjection.userId,
              chatId: managedProjection.chatId,
            },
          },
          create: {
            userId: managedProjection.userId,
            chatId: managedProjection.chatId,
            ...baseWrite,
          },
          update: baseWrite,
        }),
      );
    }

    if (writes.length === 0) {
      return;
    }

    const settled = await Promise.allSettled(writes);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        continue;
      }

      this.logger.warn(
        {
          updateId: update.updateId,
          type: update.type,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        'Failed to persist admin read model during webhook ingest',
      );
    }
  }

  private async persistUserDisplayNameSnapshots(update: MaxUpdate): Promise<void> {
    const snapshotUpsert = this.buildUserDisplayNameSnapshotUpsert(update);
    const rawClient = this.prisma as ManagedEntityLocalActivityRawClient;
    if (
      !snapshotUpsert ||
      !this.hasChatUserDisplayNameReadModel() ||
      typeof rawClient.$executeRaw !== 'function'
    ) {
      return;
    }

    await rawClient.$executeRaw(snapshotUpsert);
  }

  private hasChatUserDisplayNameReadModel(): boolean {
    return (
      (this.prisma as PrismaService & { chatUserDisplayName?: unknown }).chatUserDisplayName !==
      undefined
    );
  }

  private buildUserDisplayNameSnapshotUpsert(update: MaxUpdate): Prisma.Sql | null {
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId || isPrivateDirectChatId(chatId)) {
      return null;
    }

    const trustedObservedAt = readWebhookEventTimestamp(update);
    const observedAt = trustedObservedAt ?? new Date();
    const sourceEventId =
      this.readTrimmedString(update.updateId) ??
      this.readTrimmedString(update.message?.messageId) ??
      `${update.type.trim().toLowerCase() || 'webhook'}:${observedAt.toISOString()}`;
    const normalizedType = update.type.trim().toLowerCase() || 'webhook';
    const sourceKindSuffix = trustedObservedAt ? '' : ':ingress';
    const observations: ChatUserDisplayNameObservation[] = [];
    const senderId = update.message?.senderId?.trim() ?? '';
    const senderName = update.message?.senderName?.trim() ?? '';
    if (senderId && senderName) {
      observations.push({
        chatId,
        userId: senderId,
        displayName: senderName,
        observedAt,
        sourceEventId,
        sourceKind: `${normalizedType}:sender${sourceKindSuffix}`,
      });
    }

    const membershipAction = this.resolveMembershipActivityAction(update);
    if (membershipAction) {
      for (const [userId, displayName] of this.findMembershipMemberDisplayNames(
        update.raw,
        membershipAction,
      )) {
        observations.push({
          chatId,
          userId,
          displayName,
          observedAt,
          sourceEventId,
          sourceKind: `membership:${membershipAction}${sourceKindSuffix}`,
        });
      }
    }

    return trustedObservedAt
      ? buildChatUserDisplayNameUpsert(observations)
      : buildChatUserDisplayNameInsertIfAbsent(observations);
  }

  private getMembershipActivityEventModel(): MembershipActivityEventModel | null {
    const model = (
      this.prisma as PrismaService & {
        chatMembershipActivityEvent?: {
          createMany?: MembershipActivityEventModel['createMany'];
        };
      }
    ).chatMembershipActivityEvent;
    return typeof model?.createMany === 'function'
      ? { createMany: model.createMany.bind(model) }
      : null;
  }

  private async upsertManagedEntityLocalActivity(
    rawClient: Required<ManagedEntityLocalActivityRawClient>,
    projection: ManagedEntityLocalActivityProjection,
  ): Promise<void> {
    await rawClient.$executeRaw(Prisma.sql`
      INSERT INTO managed_entity_local_activities (
        user_id,
        chat_id,
        entity_type,
        chat_title,
        source_event_type,
        bot_id,
        last_event_at,
        created_at,
        updated_at
      )
      VALUES (
        ${projection.userId},
        ${projection.chatId},
        ${projection.entityType}::"ChatEntityType",
        ${projection.chatTitle ?? null},
        ${projection.sourceEventType},
        ${projection.botId ?? null},
        ${projection.lastEventAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (user_id, chat_id) DO UPDATE SET
        entity_type = EXCLUDED.entity_type,
        chat_title = COALESCE(EXCLUDED.chat_title, managed_entity_local_activities.chat_title),
        source_event_type = EXCLUDED.source_event_type,
        bot_id = EXCLUDED.bot_id,
        last_event_at = EXCLUDED.last_event_at,
        updated_at = CURRENT_TIMESTAMP
      WHERE managed_entity_local_activities.last_event_at < EXCLUDED.last_event_at
    `);
  }

  private async persistMembershipActivityProjection(update: MaxUpdate): Promise<void> {
    const projections = this.buildMembershipActivityProjections(update);
    if (projections.length === 0) {
      return;
    }

    const rawClient = this.prisma as ManagedEntityLocalActivityRawClient;
    if (typeof rawClient.$executeRaw === 'function') {
      await this.upsertMembershipActivityProjections(
        rawClient as Required<ManagedEntityLocalActivityRawClient>,
        projections,
      );
      return;
    }

    const membershipModel = this.getMembershipActivityEventModel();
    if (!membershipModel) {
      return;
    }
    await membershipModel.createMany({
      data: projections,
      skipDuplicates: true,
    });
  }

  private async upsertMembershipActivityProjections(
    rawClient: Required<ManagedEntityLocalActivityRawClient>,
    projections: readonly MembershipActivityProjection[],
  ): Promise<void> {
    await rawClient.$executeRaw(Prisma.sql`
      WITH incoming (
        "id",
        "dedupe_key",
        "bot_id",
        "chat_id",
        "event_type",
        "user_id",
        "sender_name",
        "event_at",
        "created_at"
      ) AS (
      VALUES ${Prisma.join(
        projections.map(
          (projection) => Prisma.sql`(
            ${projection.id},
            ${projection.dedupeKey},
            ${projection.botId ?? null},
            ${projection.chatId},
            ${projection.eventType},
            ${projection.userId ?? null},
            ${projection.senderName ?? null},
            ${projection.eventAt}::timestamp(3),
            ${projection.createdAt}::timestamp(3)
          )`,
        ),
      )}
      ),
      repaired AS (
        UPDATE "chat_membership_activity_events" AS existing
        SET "sender_name" = incoming."sender_name"
        FROM incoming
        WHERE existing."dedupe_key" = incoming."dedupe_key"
          AND COALESCE(BTRIM(existing."sender_name"), '') = ''
          AND COALESCE(BTRIM(incoming."sender_name"), '') <> ''
        RETURNING existing."dedupe_key"
      )
      INSERT INTO "chat_membership_activity_events" (
        "id",
        "dedupe_key",
        "bot_id",
        "chat_id",
        "event_type",
        "user_id",
        "sender_name",
        "event_at",
        "created_at"
      )
      SELECT
        "id",
        "dedupe_key",
        "bot_id",
        "chat_id",
        "event_type",
        "user_id",
        "sender_name",
        "event_at",
        "created_at"
      FROM incoming
      ON CONFLICT DO NOTHING
    `);
  }

  private buildMembershipActivityProjections(update: MaxUpdate): MembershipActivityProjection[] {
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return [];
    }

    const eventType = this.resolveMembershipActivityEventType(update);
    if (!eventType) {
      return [];
    }

    const memberUserIds = this.resolveMembershipActivityUserIds(update);
    if (memberUserIds.length === 0) {
      return [];
    }

    const eventAt = this.resolveUpdateEventAt(update);
    const membershipAction = eventType === 'user_removed' ? 'removed' : 'added';
    const memberDisplayNames = this.findMembershipMemberDisplayNames(update.raw, membershipAction);
    return memberUserIds.map((userId, index) => ({
      id: this.buildMembershipActivityProjectionId(
        update.updateId,
        eventType,
        userId,
        memberUserIds.length,
        index,
      ),
      dedupeKey: this.buildMembershipActivityDedupeKey(eventType, chatId, userId, eventAt),
      botId: update.botId?.trim() || null,
      chatId,
      eventType,
      userId,
      senderName: this.resolveMembershipActivitySenderName(update, userId, memberDisplayNames),
      eventAt,
      createdAt: eventAt,
    }));
  }

  private resolveMembershipActivityEventType(update: MaxUpdate): string | null {
    const normalizedType = update.type.trim().toLowerCase();
    const membershipAction = update.membership?.action;
    if (normalizedType === 'message_created' && membershipAction === 'added') {
      return 'user_added';
    }
    if (normalizedType === 'message_created' && membershipAction === 'removed') {
      return 'user_removed';
    }

    return MEMBERSHIP_ACTIVITY_UPDATE_TYPES.has(normalizedType) ? normalizedType : null;
  }

  private resolveMembershipActivityAction(update: MaxUpdate): 'added' | 'removed' | null {
    const eventType = this.resolveMembershipActivityEventType(update);
    if (eventType === 'user_added') {
      return 'added';
    }
    if (eventType === 'user_removed') {
      return 'removed';
    }

    return null;
  }

  private resolveMembershipActivityUserIds(update: MaxUpdate): string[] {
    const memberUserIds = update.membership?.memberUserIds ?? [];
    const normalizedMemberUserIds = Array.from(
      new Set(
        memberUserIds
          .map((userId) => userId.trim())
          .filter((userId): userId is string => userId.length > 0),
      ),
    );
    if (normalizedMemberUserIds.length > 0) {
      return normalizedMemberUserIds;
    }

    const senderId = update.message?.senderId?.trim() ?? '';
    return senderId ? [senderId] : [];
  }

  private buildMembershipActivityProjectionId(
    updateId: string,
    eventType: string,
    userId: string,
    totalUsers: number,
    index: number,
  ): string {
    if (totalUsers === 1) {
      return updateId;
    }

    return `${updateId}:${eventType}:${userId || index}`;
  }

  private resolveMembershipActivitySenderName(
    update: MaxUpdate,
    userId: string,
    memberDisplayNames: ReadonlyMap<string, string>,
  ): string | null {
    const rawName = memberDisplayNames.get(userId);
    if (rawName) {
      return rawName;
    }

    const senderId = update.message?.senderId?.trim() ?? '';
    if (senderId && senderId === userId) {
      return update.message?.senderName?.trim() || null;
    }

    return null;
  }

  private findMembershipMemberDisplayNames(
    node: unknown,
    action: 'added' | 'removed',
  ): Map<string, string> {
    const displayNames = new Map<string, string>();
    this.collectMembershipMemberDisplayNames(node, action, displayNames);
    return displayNames;
  }

  private collectMembershipMemberDisplayNames(
    node: unknown,
    action: 'added' | 'removed',
    displayNames: Map<string, string>,
    depth = 0,
    insideMembershipCollection = false,
  ): void {
    if (depth > 6 || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectMembershipMemberDisplayNames(
          item,
          action,
          displayNames,
          depth + 1,
          insideMembershipCollection,
        );
      }
      return;
    }

    const row = this.asRecord(node);
    if (!row) {
      return;
    }

    if (insideMembershipCollection) {
      const userId = this.readMembershipMemberUserId(row);
      const displayName = this.readMembershipMemberDisplayName(row);
      if (userId && displayName && !displayNames.has(userId)) {
        displayNames.set(userId, displayName);
      }
      if (userId) {
        return;
      }
    }

    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.trim().toLowerCase();
      this.collectMembershipMemberDisplayNames(
        value,
        action,
        displayNames,
        depth + 1,
        insideMembershipCollection || this.isMembershipCollectionKey(normalizedKey, action),
      );
    }
  }

  private readMembershipMemberUserId(row: Record<string, unknown>): string | null {
    const directUser = this.asRecord(row.user) ?? this.asRecord(row.member);
    return (
      this.readTrimmedString(row.user_id) ??
      this.readTrimmedString(row.userId) ??
      this.readTrimmedString(row.id) ??
      this.readTrimmedString(directUser?.user_id) ??
      this.readTrimmedString(directUser?.userId) ??
      this.readTrimmedString(directUser?.id)
    );
  }

  private readMembershipMemberDisplayName(row: Record<string, unknown>): string | null {
    const directUser = this.asRecord(row.user) ?? this.asRecord(row.member) ?? row;
    const directName =
      this.readTrimmedString(directUser.display_name) ??
      this.readTrimmedString(directUser.displayName) ??
      this.readTrimmedString(directUser.name) ??
      this.readTrimmedString(directUser.full_name) ??
      this.readTrimmedString(directUser.fullName) ??
      this.readTrimmedString(directUser.nickname);
    if (directName) {
      return directName;
    }

    const firstName =
      this.readTrimmedString(directUser.first_name) ??
      this.readTrimmedString(directUser.firstName) ??
      this.readTrimmedString(directUser.given_name) ??
      this.readTrimmedString(directUser.givenName);
    const lastName =
      this.readTrimmedString(directUser.last_name) ??
      this.readTrimmedString(directUser.lastName) ??
      this.readTrimmedString(directUser.family_name) ??
      this.readTrimmedString(directUser.familyName);
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    return fullName || null;
  }

  private isMembershipCollectionKey(key: string, action: 'added' | 'removed'): boolean {
    if (action === 'added') {
      return (
        key === 'new_members' ||
        key === 'new_member' ||
        key === 'members_added' ||
        key === 'member_added' ||
        key === 'added_members' ||
        key === 'added_member' ||
        key === 'joined_members' ||
        key === 'joined_member' ||
        key === 'invited_members' ||
        key === 'invited_member' ||
        key === 'new_users' ||
        key === 'new_user'
      );
    }

    return (
      key === 'removed_members' ||
      key === 'removed_member' ||
      key === 'members_removed' ||
      key === 'member_removed' ||
      key === 'left_members' ||
      key === 'left_member' ||
      key === 'leaving_members' ||
      key === 'leaving_member' ||
      key === 'departed_members' ||
      key === 'departed_member' ||
      key === 'kicked_members' ||
      key === 'kicked_member'
    );
  }

  private buildManagedEntityLocalActivityProjection(update: MaxUpdate): {
    userId: string;
    chatId: string;
    entityType: ChatEntityType;
    chatTitle?: string | null;
    sourceEventType: string;
    botId?: string | null;
    lastEventAt: Date;
  } | null {
    const normalizedType = update.type.trim().toLowerCase();
    if (!MANAGED_ENTITY_ACTIVITY_UPDATE_TYPES.has(normalizedType)) {
      return null;
    }

    const userId = update.message?.senderId?.trim() ?? '';
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!userId || !chatId) {
      return null;
    }

    return {
      userId,
      chatId,
      entityType: this.readWebhookChatEntityType(update) ?? ChatEntityType.CHAT,
      chatTitle: update.message?.chatTitle?.trim() || null,
      sourceEventType: normalizedType,
      botId: update.botId?.trim() || null,
      lastEventAt: this.resolveUpdateEventAt(update),
    };
  }

  private resolveUpdateEventAt(update: MaxUpdate): Date {
    const createdAtIso = update.message?.createdAt?.trim() ?? '';
    const parsedTimestamp = createdAtIso ? Date.parse(createdAtIso) : Number.NaN;
    if (Number.isFinite(parsedTimestamp)) {
      return new Date(parsedTimestamp);
    }

    return new Date();
  }

  private buildMembershipActivityDedupeKey(
    eventType: string,
    chatId: string,
    userId: string | null,
    eventAt: Date,
  ): string {
    const dedupeEventAt = this.normalizeMembershipActivityDedupeEventAt(eventAt);
    return `membership:${eventType}:${chatId}:${userId ?? ''}:${dedupeEventAt.toISOString()}`;
  }

  private normalizeMembershipActivityDedupeEventAt(eventAt: Date): Date {
    const timestampMs = eventAt.getTime();
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return eventAt;
    }

    return new Date(
      Math.floor(timestampMs / MEMBERSHIP_ACTIVITY_TIMESTAMP_GRANULARITY_MS) *
        MEMBERSHIP_ACTIVITY_TIMESTAMP_GRANULARITY_MS,
    );
  }

  private async getBotSelfModerationAccessState(
    chatId: string,
    botId: string,
    options: { bypassCache?: boolean } = {},
  ): Promise<boolean | null> {
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    if (options.bypassCache !== true) {
      const cached = this.readCachedBotSelfAccess(cacheKey);
      if (cached !== null) {
        return cached;
      }
    }

    const backoffUntilMs = this.botSelfAccessBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > Date.now()) {
      return null;
    }

    if (!this.maxClient) {
      return null;
    }

    try {
      const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        timeoutMs: BOT_SELF_ACCESS_TIMEOUT_MS,
        ignoreFailureMetricStatuses: BOT_SELF_ACCESS_FAILURE_METRIC_STATUSES,
      });
      return await this.cacheBotSelfAccess(chatId, botId, access);
    } catch (error: unknown) {
      if (this.isTerminalBotSelfAccessError(error)) {
        await this.cacheBotSelfAccess(chatId, botId, null);
        return false;
      }

      this.botSelfAccessBackoffUntilMs.set(cacheKey, Date.now() + BOT_SELF_ACCESS_BACKOFF_MS);
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh bot self access snapshot during webhook owner failover check',
      );
      return null;
    }
  }

  private async getCachedOrPersistedBotSelfModerationAccessState(
    chatId: string,
    botId: string,
  ): Promise<boolean | null> {
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    const cached = this.readCachedBotSelfAccess(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const persisted = await this.readPersistedBotSelfAccess(chatId, botId);
    if (!persisted) {
      return null;
    }

    this.cacheBotSelfAccessState(cacheKey, persisted.canHandleUserFacing, persisted.checkedAtMs);
    return persisted.canHandleUserFacing;
  }

  private async cacheBotSelfAccess(
    chatId: string,
    botId: string,
    access: MaxChatMemberAccess | null,
  ): Promise<boolean> {
    const canHandleUserFacing = this.canBotHandleUserFacingUpdates(access);
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    this.cacheBotSelfAccessState(cacheKey, canHandleUserFacing);
    this.botSelfAccessBackoffUntilMs.delete(cacheKey);
    await this.persistBotSelfAccessSnapshot(chatId, botId, access);
    return canHandleUserFacing;
  }

  private async persistBotSelfAccessSnapshot(
    chatId: string,
    botId: string,
    access: MaxChatMemberAccess | null,
  ): Promise<void> {
    try {
      const snapshot = buildBotAccessSnapshotPersistence(access, {
        source: 'webhook_owner_failover',
      });
      const updated = await this.prisma.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
        },
        data: {
          ...snapshot,
        },
      });
      if (updated.count > 0) {
        await this.maxBotLinkService.reconcileChatPrimaryByAccess?.({ chatId });
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist bot self access snapshot during webhook owner failover check',
      );
    }
  }

  private buildBotSelfAccessCacheKey(chatId: string, botId: string): string {
    return `${chatId}:${botId}`;
  }

  private cacheBotSelfAccessState(
    cacheKey: string,
    canHandleUserFacing: boolean,
    checkedAtMs: number | null = null,
  ): void {
    const now = Date.now();
    const ttlMs = canHandleUserFacing
      ? BOT_SELF_ACCESS_CACHE_TTL_MS
      : BOT_SELF_ACCESS_NEGATIVE_CACHE_TTL_MS;
    const snapshotExpiryMs =
      typeof checkedAtMs === 'number' && Number.isFinite(checkedAtMs)
        ? checkedAtMs + BOT_SELF_ACCESS_SNAPSHOT_MAX_AGE_MS - now
        : null;
    const cappedTtlMs =
      snapshotExpiryMs === null ? ttlMs : Math.max(1, Math.min(ttlMs, snapshotExpiryMs));
    this.botSelfAccessCache.set(cacheKey, {
      canHandleUserFacing,
      expiresAtMs: now + cappedTtlMs,
    });
  }

  private readCachedBotSelfAccess(cacheKey: string): boolean | null {
    const cached = this.botSelfAccessCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAtMs <= Date.now()) {
      this.botSelfAccessCache.delete(cacheKey);
      return null;
    }
    return cached.canHandleUserFacing;
  }

  private async readPersistedBotSelfAccess(
    chatId: string,
    botId: string,
  ): Promise<PersistedBotSelfAccessSnapshot | null> {
    const membershipModel = (
      this.prisma as PrismaService & {
        chatBotMembership?: {
          findUnique?: (args: {
            where: {
              chatId_botId: {
                chatId: string;
                botId: string;
              };
            };
            select: {
              permissionsSnapshot: true;
            };
          }) => Promise<{ permissionsSnapshot: unknown } | null>;
        };
      }
    ).chatBotMembership;
    if (typeof membershipModel?.findUnique !== 'function') {
      return null;
    }

    try {
      const membership = await membershipModel.findUnique({
        where: {
          chatId_botId: {
            chatId,
            botId,
          },
        },
        select: {
          permissionsSnapshot: true,
        },
      });
      return this.normalizePersistedBotSelfAccessSnapshot(membership?.permissionsSnapshot ?? null);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read persisted bot self access snapshot during webhook owner check',
      );
      return null;
    }
  }

  private normalizePersistedBotSelfAccessSnapshot(
    value: unknown,
  ): PersistedBotSelfAccessSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const checkedAtRaw = typeof row.checkedAt === 'string' ? row.checkedAt.trim() : '';
    const checkedAtMs = checkedAtRaw ? Date.parse(checkedAtRaw) : Number.NaN;
    if (!Number.isFinite(checkedAtMs)) {
      return null;
    }
    if (checkedAtMs + BOT_SELF_ACCESS_SNAPSHOT_MAX_AGE_MS <= Date.now()) {
      return null;
    }

    const permissions = Array.isArray(row.permissions)
      ? row.permissions.filter((permission): permission is string => typeof permission === 'string')
      : [];
    return {
      canHandleUserFacing: this.canBotHandleUserFacingFlags({
        isAdmin: row.isAdmin === true,
        isOwner: row.isOwner === true,
        permissions,
      }),
      checkedAtMs: Math.trunc(checkedAtMs),
    };
  }

  private canBotHandleUserFacingUpdates(access: MaxChatMemberAccess | null): boolean {
    return this.canBotHandleUserFacingFlags({
      isAdmin: access?.isAdmin === true,
      isOwner: access?.isOwner === true,
      permissions: access?.permissions ?? [],
    });
  }

  private canBotHandleUserFacingFlags(params: {
    isAdmin: boolean;
    isOwner: boolean;
    permissions: readonly string[];
  }): boolean {
    if (params.isOwner) {
      return true;
    }

    if (!params.isAdmin) {
      return false;
    }

    const permissions = Array.from(
      new Set(
        (params.permissions ?? [])
          .map((permission) =>
            permission
              .trim()
              .toLowerCase()
              .replace(/[-\s]+/gu, '_'),
          )
          .filter((permission) => permission.length > 0),
      ),
    );
    if (permissions.length === 0) {
      // Older MAX payloads may not expose granular permissions for admins.
      return params.isAdmin;
    }

    return permissions.some((permission) => this.isUserFacingModerationPermission(permission));
  }

  private isUserFacingModerationPermission(permission: string): boolean {
    return (
      permission === 'delete' ||
      permission === 'delete_message' ||
      permission === 'delete_messages' ||
      permission === 'can_delete_message' ||
      permission === 'can_delete_messages' ||
      permission === 'post_edit_delete_message' ||
      permission === 'post_edit_delete_messages' ||
      permission === 'can_post_edit_delete_message' ||
      permission === 'can_post_edit_delete_messages' ||
      permission === 'add_remove_members' ||
      permission === 'can_add_remove_members' ||
      permission === 'write' ||
      permission === 'send_messages' ||
      permission === 'can_send_messages' ||
      permission === 'read_all_messages' ||
      permission === 'can_read_all_messages'
    );
  }

  private isBotRemovalUpdate(update: MaxUpdate): boolean {
    const normalizedType = update.type.trim().toLowerCase();
    return (
      normalizedType === 'bot_removed' ||
      (EXTENDED_TERMINAL_BOT_LIFECYCLE_UPDATE_TYPES.has(normalizedType) &&
        this.shouldApplyExtendedLifecycleUpdate(update))
    );
  }

  private shouldApplyExtendedLifecycleUpdate(update: MaxUpdate): boolean {
    const semanticKey =
      buildWebhookSemanticEventKey(update) ??
      `extended-lifecycle:${update.type}:${update.message?.chatId ?? ''}:${update.botId ?? ''}:${update.updateId ?? ''}`;
    return shouldEnforceCanonicalWebhookExecution({
      mode: this.resolveEntityScopedCanaryMode(
        this.extendedLifecycleMode,
        this.extendedLifecycleCanaryEntityIds,
        update.message?.chatId,
      ),
      canaryPercent: this.extendedLifecycleCanaryPercent,
      semanticKey,
    });
  }

  private parseCanaryEntityIds(value: unknown): ReadonlySet<string> {
    const raw = typeof value === 'string' ? value : '';
    return new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  private resolveEntityScopedCanaryMode(
    mode: WebhookCanonicalExecutionMode,
    canaryEntityIds: ReadonlySet<string>,
    entityId: string | null | undefined,
  ): WebhookCanonicalExecutionMode {
    if (mode !== 'canary') {
      return mode;
    }
    const normalizedEntityId = entityId?.trim() ?? '';
    return normalizedEntityId &&
      (canaryEntityIds.has('*') || canaryEntityIds.has(normalizedEntityId))
      ? 'canary'
      : 'shadow';
  }

  private resolveRemovedChatBotId(update: MaxUpdate): string | null {
    if (update.type.trim().toLowerCase() !== 'bot_removed') {
      return update.botId?.trim() || null;
    }
    const raw = this.asRecord(update.raw);
    const rawRecords = [
      this.asRecord(raw?.user),
      this.asRecord(raw?.member),
      this.asRecord(raw?.removed_user),
      this.asRecord(raw?.removedUser),
      this.asRecord(raw?.bot),
      raw,
    ].filter((record): record is Record<string, unknown> => record !== null);
    const candidateKeys = [
      'username',
      'id',
      'user_id',
      'userId',
      'bot_id',
      'botId',
      'contact_id',
      'contactId',
    ];
    const candidates = rawRecords.flatMap((record) => candidateKeys.map((key) => record[key]));

    for (const candidate of candidates) {
      const botId = this.resolveKnownBotIdFromWebhookValue(candidate);
      if (botId) {
        return botId;
      }
    }

    const senderId = this.readTrimmedString(update.message?.senderId);
    if (senderId) {
      return this.resolveKnownBotIdFromWebhookValue(senderId);
    }

    return null;
  }

  private resolveKnownBotIdFromWebhookValue(value: unknown): string | null {
    const rawValue = this.readTrimmedString(value);
    if (!rawValue) {
      return null;
    }

    return this.maxBotLinkService.resolveBotIdFromUserId?.(rawValue) ?? null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private scheduleExecutionOwnerFailoverRecheck(params: {
    update: MaxUpdate;
    chatId: string;
    incomingBotId: string | null;
    currentOwnerBotId: string | null;
  }): void {
    if (!this.maxClient) {
      return;
    }

    if (!this.shouldScheduleExecutionOwnerFailoverRecheck(params.update)) {
      return;
    }

    const chatId = params.chatId.trim();
    const incomingBotId = params.incomingBotId?.trim() ?? '';
    const currentOwnerBotId = params.currentOwnerBotId?.trim() ?? '';
    if (
      !chatId.startsWith('-') ||
      !incomingBotId ||
      !currentOwnerBotId ||
      incomingBotId === currentOwnerBotId
    ) {
      return;
    }

    const backoffKey = `${chatId}:${currentOwnerBotId}:${incomingBotId}`;
    const backoffUntilMs = this.executionOwnerRecheckBackoffUntilMs.get(backoffKey) ?? 0;
    if (backoffUntilMs > Date.now()) {
      return;
    }

    this.executionOwnerRecheckBackoffUntilMs.set(
      backoffKey,
      Date.now() + EXECUTION_OWNER_ASYNC_RECHECK_BACKOFF_MS,
    );
    setTimeout(() => {
      void this.maybeFailOverExecutionOwner({
        update: params.update,
        chatId,
        incomingBotId,
        currentOwnerBotId,
        allowLiveCheck: true,
      }).catch((error: unknown) => {
        this.logger.debug(
          {
            chatId,
            currentOwnerBotId,
            incomingBotId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Async execution-owner recheck after webhook ingest failed',
        );
      });
    }, 0);
  }

  private schedulePendingExecutionOwnerFailoverRecheck(
    params: ExecutionOwnerFailoverRecheckParams | null,
  ): void {
    if (!params) {
      return;
    }

    this.scheduleExecutionOwnerFailoverRecheck(params);
  }

  private shouldScheduleExecutionOwnerFailoverRecheck(update: MaxUpdate): boolean {
    const normalizedType = update.type.trim().toLowerCase();
    return (
      normalizedType === 'message_created' ||
      normalizedType === 'message_edited' ||
      normalizedType === 'message_callback' ||
      INLINE_EXECUTION_OWNER_REFRESH_UPDATE_TYPES.has(normalizedType) ||
      this.isPotentialGroupAdminModerationCommand(update)
    );
  }

  private scheduleChatAdminRosterSyncFromWebhook(update: MaxUpdate, chatId: string): void {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    const normalizedType = update.type.trim().toLowerCase();
    if (
      normalizedType !== 'bot_added' &&
      normalizedType !== 'bot_removed' &&
      normalizedType !== 'chat_title_changed' &&
      !CHAT_ADMIN_ROSTER_MEMBERSHIP_CHURN_UPDATE_TYPES.has(normalizedType)
    ) {
      return;
    }

    const source =
      normalizedType === 'bot_added'
        ? 'webhook_bot_added'
        : normalizedType === 'bot_removed'
          ? 'webhook_bot_removed'
          : normalizedType === 'chat_title_changed'
            ? 'webhook_chat_title_changed'
            : CHAT_ADMIN_ROSTER_MEMBERSHIP_CHURN_UPDATE_TYPES.has(normalizedType)
              ? 'webhook_membership_churn'
              : null;
    const entityType = update.message?.entityType ?? null;
    if (this.isUnsupportedManagedRosterSyncChat(chatId, entityType)) {
      return;
    }

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId,
        botIds: update.botId ? [update.botId] : [],
        title: update.message?.chatTitle ?? null,
        entityType,
        source,
        retryUntilMs:
          normalizedType === 'bot_added'
            ? Date.now() + WebhookService.BOT_ADDED_ADMIN_ROSTER_RETRY_WINDOW_MS
            : null,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId,
            updateId: update.updateId,
            type: normalizedType,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to enqueue chat admin roster sync from webhook',
        );
      });
  }

  private isUnsupportedManagedRosterSyncChat(
    chatId: string,
    entityType: 'chat' | 'channel' | null | undefined,
  ): boolean {
    return entityType !== 'channel' && isPrivateDirectChatId(chatId);
  }

  private attachExecutionOwnerBotId(update: MaxUpdate, botId: string | null): void {
    if (!botId) {
      return;
    }

    update.executionOwnerBotId = botId;
  }

  private readWebhookChatEntityType(update: MaxUpdate): ChatEntityType | null {
    const entityType = update.message?.entityType;
    if (entityType === 'channel') {
      return ChatEntityType.CHANNEL;
    }
    if (entityType === 'chat') {
      return ChatEntityType.CHAT;
    }
    return null;
  }

  private async handleLegacyDedupKeyDuplicate(
    update: MaxUpdate,
    repairProjection = true,
  ): Promise<WebhookIngestResult | null> {
    const updateId = String(update.updateId ?? '').trim();
    const botId = typeof update.botId === 'string' ? update.botId.trim() : '';
    if (!updateId || !botId) {
      return null;
    }

    const findUnique = (
      this.prisma.webhookEvent as unknown as {
        findUnique?: (args: unknown) => Promise<{
          id: string;
          createdAt: Date;
          botId?: string | null;
        } | null>;
      }
    ).findUnique;
    if (typeof findUnique !== 'function') {
      return null;
    }

    const legacyEvent = await findUnique.call(this.prisma.webhookEvent, {
      where: {
        dedupKey: updateId,
      },
      select: {
        id: true,
        createdAt: true,
        botId: true,
      },
    });
    if (
      !legacyEvent ||
      legacyEvent.createdAt.getTime() < Date.now() - WEBHOOK_LEGACY_DEDUP_COMPAT_WINDOW_MS ||
      legacyEvent.botId !== botId
    ) {
      return null;
    }

    this.logger.debug(
      {
        updateId,
        botId,
        dedupKey: this.buildWebhookDedupKey(update),
        legacyDedupKey: updateId,
      },
      'Accepted webhook event as duplicate via legacy unscoped dedup key',
    );
    return repairProjection
      ? this.acceptDuplicateWebhookEvent(update)
      : { accepted: true, duplicate: true };
  }

  private async acceptDuplicateWebhookEvent(update: MaxUpdate): Promise<WebhookIngestResult> {
    try {
      await this.repairDuplicateReceiptReadModels(update);
    } catch (repairError: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          type: update.type,
          err: repairError instanceof Error ? repairError.message : String(repairError),
        },
        'Failed to repair membership activity projection for duplicate webhook event',
      );
      throw repairError;
    }

    return { accepted: true, duplicate: true };
  }

  private buildWebhookDedupKey(update: Pick<MaxUpdate, 'updateId' | 'botId'>): string {
    const updateId = String(update.updateId ?? '').trim();
    const botId = typeof update.botId === 'string' ? update.botId.trim() : '';
    return botId ? `${botId}:${updateId}` : updateId;
  }

  private shouldRetryWithSanitizedPayload(error: unknown): boolean {
    const code = (error as { code?: string }).code;
    if (code === 'P2002') {
      return false;
    }

    const message = this.extractErrorMessage(error);
    return (
      code === 'InvalidArg' ||
      code === 'P2007' ||
      message.includes('hex escape') ||
      message.includes('invalid input syntax for type json') ||
      message.includes('invalid input value') ||
      message.includes('unicode') ||
      message.includes('surrogate') ||
      message.includes('invalid byte sequence') ||
      message.includes('null byte')
    );
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim().toLowerCase();
    }

    const directMessage = (error as { message?: unknown }).message;
    if (typeof directMessage === 'string' && directMessage.trim().length > 0) {
      return directMessage.trim().toLowerCase();
    }

    return String(error).trim().toLowerCase();
  }

  private isPrismaKnownError(error: unknown, code: string): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === code;
    }

    return (error as { code?: string } | null)?.code === code;
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private extractMaxErrorCode(error: unknown): string | null {
    const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof maybeCode === 'string' && maybeCode.trim().length > 0
      ? maybeCode.trim().toLowerCase()
      : null;
  }

  private isTerminalBotSelfAccessError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractErrorMessage(error);
    return message.includes('bot is not a chat member') || message.includes('not accessible');
  }

  private sanitizeForJsonStorage(
    value: unknown,
    seen = new WeakSet<object>(),
  ): Prisma.InputJsonValue {
    const sanitized = this.sanitizeJsonFragment(value, seen);
    return sanitized ?? ({} as Prisma.InputJsonObject);
  }

  private sanitizeJsonFragment(
    value: unknown,
    seen = new WeakSet<object>(),
  ): Prisma.InputJsonValue | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      return this.normalizeStorageString(value);
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Buffer.isBuffer(value)) {
      return value.toString('base64');
    }

    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeJsonFragment(item, seen));
    }

    if (typeof value === 'object') {
      if (seen.has(value)) {
        return null;
      }
      seen.add(value);

      const sanitized: Record<string, Prisma.InputJsonValue | null> = {};
      for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (
          nestedValue === undefined ||
          typeof nestedValue === 'function' ||
          typeof nestedValue === 'symbol'
        ) {
          continue;
        }
        sanitized[key] = this.sanitizeJsonFragment(nestedValue, seen);
      }

      seen.delete(value);
      return sanitized as Prisma.InputJsonObject;
    }

    return this.normalizeStorageString(String(value));
  }

  private normalizeStorageString(value: string): string {
    let normalized = '';

    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);

      if (codeUnit === 0) {
        continue;
      }

      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
          normalized += value[index] + value[index + 1];
          index += 1;
        } else {
          normalized += '\ufffd';
        }
        continue;
      }

      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        normalized += '\ufffd';
        continue;
      }

      normalized += value[index];
    }

    return normalized;
  }
}
