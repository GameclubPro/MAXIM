import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { createHash } from 'node:crypto';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import {
  extractManagedEntityForwardedRecoveryCandidate,
  type ManagedEntityForwardedRecoveryCandidate,
} from '../common/managed-entity-forwarded-recovery.util';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';

export const PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON = 'publisher_actor_verification_pending';
export const PUBLISHER_ACCESS_CANDIDATE_SOURCE = 'publisher_actor_candidate';
export const PUBLISHER_FORWARDED_BINDING_SOURCE_PREFIX = 'publisher_forwarded_candidate:';

export function buildPublisherForwardedBindingSource(candidateVersion: string): string {
  const digest = createHash('sha256').update(candidateVersion.trim()).digest('hex').slice(0, 24);
  return `${PUBLISHER_FORWARDED_BINDING_SOURCE_PREFIX}${digest}`;
}

const PUBLISHER_ACCESS_CANDIDATE_TTL_MS = 24 * 60 * 60_000;
const PUBLISHER_FORWARDED_ACTOR_BURST_MS = 5_000;
const PUBLISHER_FORWARDED_ACTOR_RATE_LIMIT_MS = 3 * 60_000;
const PUBLISHER_FORWARDED_RATE_LIMIT_MAX_KEYS = 2_048;
const PUBLISHER_HISTORICAL_ACTOR_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const PUBLISHER_HISTORICAL_ACTOR_SCAN_LIMIT = 500;
const PUBLISHER_HISTORICAL_ACTOR_BATCH_SIZE = 25;
const PUBLISHER_ORDINARY_ACTIVITY_TYPES = new Set([
  'message_callback',
  'message_created',
  'message_edited',
  'message_removed',
]);

type HistoricalPublisherActorScanRow = {
  webhookEventId: string | null;
  chatId: string | null;
  userId: string | null;
  bindingPublisherBotId: string | null;
  bindingStatus: ChatBotMembershipStatus | null;
  catalogEntityType: ChatEntityType | null;
  catalogStatus: string | null;
  publikEnabled: boolean | null;
  edgeExists: boolean;
  evidenceAt: Date | null;
  scannedCount: number;
  scanCursorAt: Date | null;
  scanCursorWebhookEventId: string | null;
};

type PublisherObservationKind = 'bot_added' | 'bot_removed' | 'observed';

type PublisherBindingOrderingState = {
  lifecycleEventAt: Date | null;
  lifecycleEventType: string | null;
};

export type PublisherWebhookObservationResult =
  | 'not_publisher'
  | 'missing_chat'
  | 'unmanaged_chat'
  | 'untrusted_terminal_event'
  | 'stale'
  | 'applied';

function publisherObservationRank(type: string | null | undefined): number {
  switch (type?.trim().toLowerCase()) {
    case 'bot_removed':
      return 3;
    case 'bot_added':
      return 2;
    default:
      return 1;
  }
}

export function shouldApplyPublisherObservation(
  current: PublisherBindingOrderingState | null,
  next: { eventAt: Date | null; eventType: string },
): boolean {
  if (!current?.lifecycleEventAt || !next.eventAt) {
    return current?.lifecycleEventAt === null || current === null;
  }
  const timeDifference = next.eventAt.getTime() - current.lifecycleEventAt.getTime();
  if (timeDifference !== 0) {
    return timeDifference > 0;
  }
  return (
    publisherObservationRank(next.eventType) >= publisherObservationRank(current.lifecycleEventType)
  );
}

@Injectable()
export class PublisherEntityBindingLifecycleService {
  private readonly logger = new Logger(PublisherEntityBindingLifecycleService.name);
  private readonly publisherBotId: string;
  private readonly forwardedActorBurstUntilMs = new Map<string, number>();
  private historicalRecoveryCursor: { evidenceAt: Date; webhookEventId: string } | null = null;
  private historicalRecoveryCompletedUntilMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshQueue: PublisherBindingRefreshQueueService,
    configService: ConfigService,
    private readonly botRegistry: MaxBotRegistryService,
  ) {
    const descriptor = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    });
    this.publisherBotId = descriptor.id;
  }

  isPublisherUpdate(update: Pick<MaxUpdate, 'botId'>): boolean {
    return update.botId?.trim() === this.publisherBotId;
  }

  async observeWebhook(update: MaxUpdate): Promise<PublisherWebhookObservationResult> {
    if (!this.isPublisherUpdate(update)) {
      return 'not_publisher';
    }
    const forwardedCandidate = extractManagedEntityForwardedRecoveryCandidate(update);
    if (forwardedCandidate) {
      return this.observeForwardedRecovery(update, forwardedCandidate);
    }
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return 'missing_chat';
    }
    const explicitEntityType = update.message?.entityType;
    if (explicitEntityType !== 'channel' && isPrivateDirectChatId(chatId)) {
      return 'unmanaged_chat';
    }

    const normalizedType = update.type.trim().toLowerCase();
    const kind: PublisherObservationKind =
      normalizedType === 'bot_added'
        ? 'bot_added'
        : normalizedType === 'bot_removed'
          ? 'bot_removed'
          : 'observed';
    const accessHandshake = kind === 'bot_added' || this.isPublisherHandshakeCommand(update);
    const candidateUserId = accessHandshake
      ? this.normalizeCandidateUserId(update.message?.senderId)
      : null;
    const eventAt = readWebhookEventTimestamp(update);
    if ((kind === 'bot_added' || kind === 'bot_removed') && !eventAt) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId,
          type: normalizedType,
        },
        'Skipped publisher terminal lifecycle event without a trusted timestamp',
      );
      return 'untrusted_terminal_event';
    }

    const receivedAt = new Date();
    if (
      kind === 'observed' &&
      !accessHandshake &&
      PUBLISHER_ORDINARY_ACTIVITY_TYPES.has(normalizedType)
    ) {
      const fastPathResult = await this.observeFreshBindingActivity({
        chatId,
        explicitEntityType,
        title: update.message?.chatTitle?.trim() ?? '',
        eventType: normalizedType,
        eventAt,
        receivedAt,
      });
      if (fastPathResult) {
        return fastPathResult;
      }
    }
    const entityType =
      explicitEntityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const title =
      update.message?.chatTitle?.trim() ||
      (entityType === ChatEntityType.CHANNEL ? `Channel ${chatId}` : `Chat ${chatId}`);
    const result = await this.prisma.$transaction(async (tx) => {
      const existingChat = await tx.chat.findUnique({
        where: { id: chatId },
        select: { id: true },
      });
      if (!existingChat && !accessHandshake) {
        return 'unmanaged_chat' as const;
      }
      await tx.chat.upsert({
        where: { id: chatId },
        create: { id: chatId, title, entityType },
        update: {},
      });
      const chats = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${chatId}
        FOR UPDATE OF chat
      `);
      if (chats.length === 0) return 'unmanaged_chat' as const;

      const existingPublisherCatalog = await tx.managedBotChatCatalog.findUnique({
        where: { botId_chatId: { botId: this.publisherBotId, chatId } },
        select: { entityType: true, title: true },
      });
      const publisherEntityType = explicitEntityType
        ? entityType
        : (existingPublisherCatalog?.entityType ?? entityType);
      const publisherTitle =
        update.message?.chatTitle?.trim() || existingPublisherCatalog?.title?.trim() || title;

      const persistCatalog = async (status: 'ACTIVE' | 'MISSING') => {
        await tx.managedBotChatCatalog.upsert({
          where: { botId_chatId: { botId: this.publisherBotId, chatId } },
          create: {
            botId: this.publisherBotId,
            chatId,
            entityType: publisherEntityType,
            title: publisherTitle,
            status,
            source: `publisher_webhook_${normalizedType}`,
            lastSeenAt: eventAt ?? receivedAt,
          },
          update: {
            ...(update.message?.chatTitle?.trim() ? { title: publisherTitle } : {}),
            ...(explicitEntityType ? { entityType } : {}),
            status,
            source: `publisher_webhook_${normalizedType}`,
            lastSeenAt: eventAt ?? receivedAt,
          },
        });
      };
      const persistActorCandidate = async () => {
        if (!candidateUserId) {
          return;
        }
        await this.upsertPendingActorCandidate(tx, {
          chatId,
          userId: candidateUserId,
          entityType: publisherEntityType,
          checkedAt: receivedAt,
          source: `${PUBLISHER_ACCESS_CANDIDATE_SOURCE}_${
            kind === 'bot_added' ? 'bot_added' : 'direct_start'
          }`,
          sourceVersion: update.updateId,
        });
      };
      const invalidatePublisherUserAccess = async (reason: string) => {
        await tx.managedEntityAccessEdge.updateMany({
          where: { chatId, botId: this.publisherBotId },
          data: {
            state: ManagedEntityAccessState.BOT_DENIED,
            userRole: ManagedEntityAccessRole.UNKNOWN,
            botRole: ManagedEntityAccessRole.UNKNOWN,
            expiresAt: null,
            deniedReason: reason,
            source: `publisher_webhook_${normalizedType}`,
            sourceVersion: null,
          },
        });
      };

      const current = await tx.publisherEntityBinding.findUnique({
        where: { chatId },
        select: {
          lifecycleEventAt: true,
          lifecycleEventType: true,
          status: true,
        },
      });
      if (
        eventAt &&
        !shouldApplyPublisherObservation(current, {
          eventAt,
          eventType: normalizedType,
        })
      ) {
        await tx.publisherEntityBinding.updateMany({
          where: {
            chatId,
            publisherBotId: this.publisherBotId,
            OR: [{ lastWebhookAt: null }, { lastWebhookAt: { lt: receivedAt } }],
          },
          data: { lastWebhookAt: receivedAt },
        });
        return 'stale' as const;
      }

      const preservesRemovedLifecycleFence =
        kind === 'observed' &&
        current?.status === ChatBotMembershipStatus.REMOVED &&
        !accessHandshake;
      const lifecycle =
        eventAt && !preservesRemovedLifecycleFence
          ? {
              lifecycleEventAt: eventAt,
              lifecycleEventType: normalizedType,
              lifecycleSource: 'webhook',
            }
          : {};
      const observation = {
        lastSeenAt: eventAt ?? receivedAt,
        lastWebhookAt: receivedAt,
        ...lifecycle,
      };

      if (!current) {
        await tx.publisherEntityBinding.create({
          data: {
            chatId,
            publisherBotId: this.publisherBotId,
            status:
              kind === 'bot_removed'
                ? ChatBotMembershipStatus.REMOVED
                : ChatBotMembershipStatus.ACTIVE,
            botAccessState:
              kind === 'bot_removed' ? ChatBotAccessState.LOST : ChatBotAccessState.UNKNOWN,
            botAccessCheckedAt: kind === 'bot_removed' ? eventAt : null,
            botAccessSource: `webhook_${normalizedType}`,
            botAccessLastErrorCode: kind === 'bot_removed' ? 'BOT_REMOVED' : null,
            ...observation,
          },
        });
        await persistCatalog(kind === 'bot_removed' ? 'MISSING' : 'ACTIVE');
        if (kind === 'bot_added' || kind === 'bot_removed') {
          await invalidatePublisherUserAccess(kind);
        }
        if (kind !== 'bot_removed') {
          await persistActorCandidate();
        }
        return 'applied' as const;
      }

      if (kind === 'bot_removed') {
        await tx.publisherEntityBinding.update({
          where: { chatId },
          data: {
            status: ChatBotMembershipStatus.REMOVED,
            capabilities: [],
            permissionsSnapshot: Prisma.JsonNull,
            botAccessState: ChatBotAccessState.LOST,
            botAccessCheckedAt: eventAt,
            botAccessExpiresAt: null,
            botAccessSource: 'webhook_bot_removed',
            botAccessLastErrorCode: 'BOT_REMOVED',
            permissionsHash: null,
            sendRouteQuarantinedUntil: null,
            ...observation,
          },
        });
        await persistCatalog('MISSING');
        await invalidatePublisherUserAccess('bot_removed');
        return 'applied' as const;
      }

      if (kind === 'bot_added') {
        await tx.publisherEntityBinding.update({
          where: { chatId },
          data: {
            publisherBotId: this.publisherBotId,
            status: ChatBotMembershipStatus.ACTIVE,
            capabilities: [],
            permissionsSnapshot: Prisma.JsonNull,
            botAccessState: ChatBotAccessState.UNKNOWN,
            botAccessCheckedAt: null,
            botAccessExpiresAt: null,
            botAccessSource: 'webhook_bot_added',
            botAccessLastErrorCode: null,
            permissionsHash: null,
            sendRouteFailureCount: 0,
            sendRouteQuarantinedUntil: null,
            sendRouteLastFailureAt: null,
            sendRouteLastFailureCode: null,
            ...observation,
          },
        });
        await persistCatalog('ACTIVE');
        await invalidatePublisherUserAccess('bot_added');
        await persistActorCandidate();
        return 'applied' as const;
      }

      await tx.publisherEntityBinding.update({
        where: { chatId },
        data: {
          ...observation,
          ...(current.status === ChatBotMembershipStatus.REMOVED && !accessHandshake
            ? {}
            : { status: ChatBotMembershipStatus.ACTIVE }),
        },
      });
      await persistCatalog(
        current.status === ChatBotMembershipStatus.REMOVED && !accessHandshake
          ? 'MISSING'
          : 'ACTIVE',
      );
      if (current.status !== ChatBotMembershipStatus.REMOVED || accessHandshake) {
        await persistActorCandidate();
      }
      return 'applied' as const;
    });

    if (result === 'applied' && kind !== 'bot_removed') {
      await this.refreshQueue.enqueue({
        chatId,
        publisherBotId: this.publisherBotId,
        reason: kind === 'bot_added' ? 'bot_added' : 'webhook_observed',
        ...(candidateUserId ? { candidateUserId, candidateVersion: update.updateId } : {}),
        requestedAt: receivedAt,
        eventAt,
      });
    }
    return result;
  }

  private async observeFreshBindingActivity(params: {
    chatId: string;
    explicitEntityType: 'chat' | 'channel' | undefined;
    title: string;
    eventType: string;
    eventAt: Date | null;
    receivedAt: Date;
  }): Promise<PublisherWebhookObservationResult | null> {
    const [binding, catalog] = await Promise.all([
      this.prisma.publisherEntityBinding.findUnique({
        where: { chatId: params.chatId },
        select: {
          publisherBotId: true,
          status: true,
          botAccessState: true,
          botAccessCheckedAt: true,
          botAccessExpiresAt: true,
          sendRouteQuarantinedUntil: true,
          lifecycleEventAt: true,
          lifecycleEventType: true,
        },
      }),
      this.prisma.managedBotChatCatalog.findUnique({
        where: { botId_chatId: { botId: this.publisherBotId, chatId: params.chatId } },
        select: { entityType: true, title: true, status: true },
      }),
    ]);
    const expectedEntityType =
      params.explicitEntityType === 'channel'
        ? ChatEntityType.CHANNEL
        : params.explicitEntityType === 'chat'
          ? ChatEntityType.CHAT
          : null;
    if (
      binding?.publisherBotId !== this.publisherBotId ||
      binding.status !== ChatBotMembershipStatus.ACTIVE ||
      (binding.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
        binding.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER) ||
      !binding.botAccessExpiresAt ||
      binding.botAccessExpiresAt <= params.receivedAt ||
      (binding.sendRouteQuarantinedUntil !== null &&
        binding.sendRouteQuarantinedUntil > params.receivedAt) ||
      catalog?.status !== 'ACTIVE' ||
      (expectedEntityType !== null && catalog.entityType !== expectedEntityType) ||
      (params.title.length > 0 && (catalog.title?.trim() ?? '') !== params.title)
    ) {
      return null;
    }

    const exactBindingWhere = {
      chatId: params.chatId,
      publisherBotId: this.publisherBotId,
      status: binding.status,
      botAccessState: binding.botAccessState,
      botAccessCheckedAt: binding.botAccessCheckedAt,
      botAccessExpiresAt: binding.botAccessExpiresAt,
      sendRouteQuarantinedUntil: binding.sendRouteQuarantinedUntil,
      lifecycleEventAt: binding.lifecycleEventAt,
      lifecycleEventType: binding.lifecycleEventType,
    } satisfies Prisma.PublisherEntityBindingWhereInput;
    if (!params.eventAt) {
      const updated = await this.prisma.publisherEntityBinding.updateMany({
        where: exactBindingWhere,
        data: { lastWebhookAt: params.receivedAt },
      });
      return updated.count === 1 ? 'applied' : null;
    }

    const advancesLifecycle = shouldApplyPublisherObservation(binding, {
      eventAt: params.eventAt,
      eventType: params.eventType,
    });
    if (!advancesLifecycle) {
      await this.prisma.publisherEntityBinding.updateMany({
        where: exactBindingWhere,
        data: { lastWebhookAt: params.receivedAt },
      });
      return 'stale';
    }

    const updated = await this.prisma.publisherEntityBinding.updateMany({
      where: exactBindingWhere,
      data: {
        lastSeenAt: params.eventAt,
        lastWebhookAt: params.receivedAt,
        lifecycleEventAt: params.eventAt,
        lifecycleEventType: params.eventType,
        lifecycleSource: 'webhook',
      },
    });
    return updated.count === 1 ? 'applied' : null;
  }

  async recoverHistoricalActorCandidates(
    now = new Date(),
    limit = PUBLISHER_HISTORICAL_ACTOR_BATCH_SIZE,
  ): Promise<number> {
    if (this.historicalRecoveryCompletedUntilMs > now.getTime()) {
      return 0;
    }
    const boundedLimit = Math.max(1, Math.min(PUBLISHER_HISTORICAL_ACTOR_BATCH_SIZE, limit));
    const lookbackFrom = new Date(now.getTime() - PUBLISHER_HISTORICAL_ACTOR_LOOKBACK_MS);
    const cursor = this.historicalRecoveryCursor;
    // FLAG: Materialize the bounded source page before inspecting JSON evidence. Stored evidence
    // only nominates an actor; the Publisher worker still performs exact live bot and user access
    // checks before granting anything.
    const rows = await this.prisma.$queryRaw<HistoricalPublisherActorScanRow[]>(Prisma.sql`
      WITH source_page AS MATERIALIZED (
        SELECT
          event."id" AS webhook_event_id,
          event."created_at" AS evidence_at,
          event."normalized_payload"
        FROM "webhook_events" AS event
        WHERE event."bot_id" = ${this.publisherBotId}
          AND event."status" = 'PROCESSED'::"WebhookStatus"
          AND event."created_at" >= ${lookbackFrom}
          ${
            cursor
              ? Prisma.sql`
                  AND (event."created_at", event."id")
                    < (${cursor.evidenceAt}, ${cursor.webhookEventId})
                `
              : Prisma.empty
          }
        ORDER BY event."created_at" DESC, event."id" DESC
        LIMIT ${PUBLISHER_HISTORICAL_ACTOR_SCAN_LIMIT}
      ), actor_evidence AS (
        SELECT
          recent.webhook_event_id,
          recent.evidence_at,
          NULLIF(BTRIM(recent.normalized_payload->'message'->>'chatId'), '') AS chat_id,
          NULLIF(BTRIM(recent.normalized_payload->'message'->>'senderId'), '') AS user_id
        FROM source_page AS recent
        WHERE (
            (
              recent.normalized_payload->>'type' = 'bot_added'
              AND recent.normalized_payload->>'eventTimestampSource' = 'payload'
            )
            OR (
              recent.normalized_payload->>'type' = 'message_created'
              AND LOWER(BTRIM(COALESCE(recent.normalized_payload->'message'->>'text', '')))
                IN ('старт', '/start')
            )
          )
      ), page_meta AS (
        SELECT
          (SELECT COUNT(*)::INTEGER FROM source_page) AS scanned_count,
          boundary.evidence_at AS scan_cursor_at,
          boundary.webhook_event_id AS scan_cursor_webhook_event_id
        FROM (VALUES (1)) AS singleton(value)
        LEFT JOIN LATERAL (
          SELECT recent.evidence_at, recent.webhook_event_id
          FROM source_page AS recent
          ORDER BY recent.evidence_at ASC, recent.webhook_event_id ASC
          LIMIT 1
        ) AS boundary ON TRUE
      )
      SELECT
        actor.webhook_event_id AS "webhookEventId",
        actor.chat_id AS "chatId",
        actor.user_id AS "userId",
        binding."publisher_bot_id" AS "bindingPublisherBotId",
        binding."status" AS "bindingStatus",
        catalog."entity_type" AS "catalogEntityType",
        catalog."status" AS "catalogStatus",
        policy."publik_enabled" AS "publikEnabled",
        (edge."chat_id" IS NOT NULL) AS "edgeExists",
        actor.evidence_at AS "evidenceAt",
        page.scanned_count AS "scannedCount",
        page.scan_cursor_at AS "scanCursorAt",
        page.scan_cursor_webhook_event_id AS "scanCursorWebhookEventId"
      FROM page_meta AS page
      LEFT JOIN actor_evidence AS actor ON TRUE
      LEFT JOIN "publisher_entity_bindings" AS binding
        ON binding."chat_id" = actor.chat_id
      LEFT JOIN "managed_bot_chat_catalog" AS catalog
        ON catalog."chat_id" = actor.chat_id
        AND catalog."bot_id" = ${this.publisherBotId}
      LEFT JOIN "managed_entity_publication_policies" AS policy
        ON policy."chat_id" = actor.chat_id
      LEFT JOIN "managed_entity_access_edges" AS edge
        ON edge."chat_id" = actor.chat_id
        AND edge."user_id" = actor.user_id
        AND edge."bot_id" = ${this.publisherBotId}
      ORDER BY actor.evidence_at DESC NULLS LAST, actor.webhook_event_id DESC NULLS LAST
    `);

    const pageMeta = rows[0];
    const scannedCount = pageMeta?.scannedCount ?? 0;
    const pageCursor =
      pageMeta?.scanCursorAt && pageMeta.scanCursorWebhookEventId
        ? {
            evidenceAt: pageMeta.scanCursorAt,
            webhookEventId: pageMeta.scanCursorWebhookEventId,
          }
        : null;
    let queuedCount = 0;
    const seenActors = new Set<string>();
    for (const row of rows) {
      const evidenceAt = row.evidenceAt;
      const webhookEventId = row.webhookEventId;
      if (!evidenceAt || !webhookEventId) {
        continue;
      }
      const nextCursor = {
        evidenceAt,
        webhookEventId,
      };
      const chatId = row.chatId?.trim() ?? '';
      const userId = row.userId?.trim() ?? '';
      const actorKey = JSON.stringify([chatId, userId]);
      if (
        !/^-?[1-9][0-9]*$/u.test(chatId) ||
        !chatId.startsWith('-') ||
        !/^[1-9][0-9]*$/u.test(userId) ||
        this.botRegistry.isKnownBotUserId(userId) ||
        seenActors.has(actorKey) ||
        row.bindingPublisherBotId !== this.publisherBotId ||
        row.bindingStatus !== ChatBotMembershipStatus.ACTIVE ||
        !row.catalogEntityType ||
        row.catalogStatus !== 'ACTIVE' ||
        row.publikEnabled === false ||
        row.edgeExists
      ) {
        this.historicalRecoveryCursor = nextCursor;
        continue;
      }
      seenActors.add(actorKey);
      const candidateVersion = `historical:${webhookEventId}`;
      const staged = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chat."id"
          FROM "chats" AS chat
          WHERE chat."id" = ${chatId}
          FOR UPDATE OF chat
        `);
        if (locked.length !== 1) {
          return false;
        }
        const [chat, binding, catalog, edge] = await Promise.all([
          tx.chat.findUnique({
            where: { id: chatId },
            select: { publicationPolicy: { select: { publikEnabled: true } } },
          }),
          tx.publisherEntityBinding.findUnique({ where: { chatId } }),
          tx.managedBotChatCatalog.findUnique({
            where: { botId_chatId: { botId: this.publisherBotId, chatId } },
            select: { entityType: true, status: true },
          }),
          tx.managedEntityAccessEdge.findUnique({
            where: {
              chatId_userId_botId: {
                chatId,
                userId,
                botId: this.publisherBotId,
              },
            },
            select: { chatId: true },
          }),
        ]);
        if (
          !chat ||
          chat.publicationPolicy?.publikEnabled === false ||
          !binding ||
          binding.publisherBotId !== this.publisherBotId ||
          binding.status !== ChatBotMembershipStatus.ACTIVE ||
          !catalog ||
          catalog.status !== 'ACTIVE' ||
          edge
        ) {
          return false;
        }
        await this.upsertPendingActorCandidate(tx, {
          chatId,
          userId,
          entityType: catalog.entityType,
          checkedAt: evidenceAt,
          source: `${PUBLISHER_ACCESS_CANDIDATE_SOURCE}_historical`,
          sourceVersion: candidateVersion,
        });
        return true;
      });
      if (!staged) {
        this.historicalRecoveryCursor = nextCursor;
        continue;
      }
      await this.refreshQueue.enqueue({
        chatId,
        publisherBotId: this.publisherBotId,
        candidateUserId: userId,
        candidateVersion,
        reason: 'historical_actor_recovery',
        requestedAt: now,
        eventAt: evidenceAt,
      });
      queuedCount += 1;
      this.historicalRecoveryCursor = nextCursor;
      if (queuedCount >= boundedLimit) {
        return queuedCount;
      }
    }
    if (pageCursor) {
      this.historicalRecoveryCursor = pageCursor;
    }
    if (scannedCount < PUBLISHER_HISTORICAL_ACTOR_SCAN_LIMIT) {
      this.historicalRecoveryCursor = null;
      this.historicalRecoveryCompletedUntilMs = now.getTime() + 60 * 60_000;
    }
    return queuedCount;
  }

  private async observeForwardedRecovery(
    update: MaxUpdate,
    candidate: ManagedEntityForwardedRecoveryCandidate,
  ): Promise<PublisherWebhookObservationResult> {
    if (this.botRegistry.isKnownBotUserId(candidate.forwarderUserId)) {
      return 'unmanaged_chat';
    }
    if (!this.reserveForwardedActorBurst(candidate.forwarderUserId)) {
      return 'stale';
    }
    const receivedAt = new Date();
    const evidenceAt = readWebhookEventTimestamp(update) ?? receivedAt;
    const candidateVersion = `forwarded:${update.updateId}`;
    const staged = await this.prisma.$transaction(async (tx) => {
      const existingPublisherCatalog = await tx.managedBotChatCatalog.findUnique({
        where: {
          botId_chatId: { botId: this.publisherBotId, chatId: candidate.sourceChatId },
        },
        select: { entityType: true, title: true },
      });
      const entityType = existingPublisherCatalog?.entityType ?? ChatEntityType.CHAT;
      const title =
        existingPublisherCatalog?.title?.trim() ||
        (entityType === ChatEntityType.CHANNEL
          ? `Channel ${candidate.sourceChatId}`
          : `Chat ${candidate.sourceChatId}`);
      await tx.chat.upsert({
        where: { id: candidate.sourceChatId },
        create: { id: candidate.sourceChatId, title, entityType },
        update: {},
      });
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${candidate.sourceChatId}
        FOR UPDATE OF chat
      `);
      if (locked.length !== 1) {
        return 'stale' as const;
      }

      const [binding, existingEdge] = await Promise.all([
        tx.publisherEntityBinding.findUnique({ where: { chatId: candidate.sourceChatId } }),
        tx.managedEntityAccessEdge.findUnique({
          where: {
            chatId_userId_botId: {
              chatId: candidate.sourceChatId,
              userId: candidate.forwarderUserId,
              botId: this.publisherBotId,
            },
          },
          select: { checkedAt: true, source: true, sourceVersion: true },
        }),
      ]);
      if (binding?.lifecycleEventAt && binding.lifecycleEventAt > evidenceAt) {
        return 'stale' as const;
      }
      if (
        existingEdge &&
        existingEdge.sourceVersion !== candidateVersion &&
        existingEdge.checkedAt >
          new Date(receivedAt.getTime() - PUBLISHER_FORWARDED_ACTOR_RATE_LIMIT_MS)
      ) {
        return 'rate_limited' as const;
      }

      // FLAG: A forward proves only which entity to probe. It must never create
      // or reactivate Publisher routing state before the exact token confirms
      // both the bot and forwarding administrator in that entity.
      await this.upsertPendingActorCandidate(tx, {
        chatId: candidate.sourceChatId,
        userId: candidate.forwarderUserId,
        entityType,
        checkedAt: receivedAt,
        source: `${PUBLISHER_ACCESS_CANDIDATE_SOURCE}_forwarded`,
        sourceVersion: candidateVersion,
      });
      return 'applied' as const;
    });

    if (staged !== 'applied') {
      return 'stale';
    }
    await this.refreshQueue.enqueue({
      chatId: candidate.sourceChatId,
      publisherBotId: this.publisherBotId,
      candidateUserId: candidate.forwarderUserId,
      candidateVersion,
      replyChatId: candidate.privateChatId,
      requiresReadAccess: true,
      reason: 'forwarded_private',
      requestedAt: receivedAt,
      eventAt: evidenceAt,
    });
    return 'applied';
  }

  private async upsertPendingActorCandidate(
    tx: Prisma.TransactionClient,
    params: {
      chatId: string;
      userId: string;
      entityType: ChatEntityType;
      checkedAt: Date;
      source: string;
      sourceVersion: string;
    },
  ): Promise<void> {
    const key = {
      chatId: params.chatId,
      userId: params.userId,
      botId: this.publisherBotId,
    };
    const existing = await tx.managedEntityAccessEdge.findUnique({
      where: { chatId_userId_botId: key },
      select: { state: true },
    });
    const expiresAt = new Date(params.checkedAt.getTime() + PUBLISHER_ACCESS_CANDIDATE_TTL_MS);
    await tx.managedEntityAccessEdge.upsert({
      where: { chatId_userId_botId: key },
      create: {
        ...key,
        entityType: params.entityType,
        state: ManagedEntityAccessState.BOT_DENIED,
        userRole: ManagedEntityAccessRole.UNKNOWN,
        botRole: ManagedEntityAccessRole.UNKNOWN,
        checkedAt: params.checkedAt,
        expiresAt,
        deniedReason: PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
        source: params.source,
        sourceVersion: params.sourceVersion,
      },
      update:
        existing?.state === ManagedEntityAccessState.GRANTED
          ? {
              source: params.source,
              sourceVersion: params.sourceVersion,
            }
          : {
              entityType: params.entityType,
              state: ManagedEntityAccessState.BOT_DENIED,
              userRole: ManagedEntityAccessRole.UNKNOWN,
              botRole: ManagedEntityAccessRole.UNKNOWN,
              checkedAt: params.checkedAt,
              expiresAt,
              deniedReason: PUBLISHER_ACCESS_CANDIDATE_PENDING_REASON,
              lastMaxErrorCode: null,
              lastMaxErrorMessage: null,
              lastMaxStatusCode: null,
              source: params.source,
              sourceVersion: params.sourceVersion,
            },
    });
  }

  private isPublisherHandshakeCommand(update: MaxUpdate): boolean {
    if (isManagedEntityHandshakeStartCommand(update)) {
      return true;
    }
    const chatId = update.message?.chatId?.trim() ?? '';
    return (
      update.type.trim().toLowerCase() === 'message_created' &&
      Boolean(chatId) &&
      !isPrivateDirectChatId(chatId) &&
      update.message?.text?.trim().toLowerCase() === '/start'
    );
  }

  private normalizeCandidateUserId(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized && !this.botRegistry.isKnownBotUserId(normalized) ? normalized : null;
  }

  private reserveForwardedActorBurst(userId: string): boolean {
    const now = Date.now();
    for (const [key, blockedUntil] of this.forwardedActorBurstUntilMs) {
      if (blockedUntil <= now) {
        this.forwardedActorBurstUntilMs.delete(key);
      }
    }
    const blockedUntil = this.forwardedActorBurstUntilMs.get(userId) ?? 0;
    if (blockedUntil > now) {
      return false;
    }
    while (this.forwardedActorBurstUntilMs.size >= PUBLISHER_FORWARDED_RATE_LIMIT_MAX_KEYS) {
      const oldestKey = this.forwardedActorBurstUntilMs.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.forwardedActorBurstUntilMs.delete(oldestKey);
    }
    this.forwardedActorBurstUntilMs.set(userId, now + PUBLISHER_FORWARDED_ACTOR_BURST_MS);
    return true;
  }
}
