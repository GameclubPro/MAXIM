import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { publicModerator } from '../max/max-public-moderator';
import { isFixedModeratorSelectionEnabled } from '../max/fixed-moderator.config';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import {
  managedEntityPresentationRequestSchema,
  type ManagedEntityPresentation,
  type ManagedEntityPresentationRequest,
  type ManagedEntityPresentationResponse,
} from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxClientService, MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE,
  type AdminManagedEntitiesRefreshJob,
} from './admin-managed-entities-refresh.queue';
import { createManagedEntityHeader } from './admin-managed-entity-header';
import {
  isBotAdminLookupDeniedError,
  resolvePresentableManagedEntityTitle,
} from './admin-legacy-utils';

const FRESH_MS = 60 * 60_000;
const EMPTY_FRESH_MS = 6 * FRESH_MS;
const RETRY_MS = 120_000;

@Injectable()
export class ManagedEntityPresentationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MaxBotRegistryService,
    private readonly max: MaxClientService,
    private readonly cache: ChatContextCacheService,
    @InjectQueue(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE)
    private readonly queue: Queue<AdminManagedEntitiesRefreshJob>,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private jobId(entityType: string, id: string): string {
    return `presentation-v1-${entityType}-${createHash('sha256').update(id).digest('hex')}`;
  }

  private async readVisible(userId: string, request: ManagedEntityPresentationRequest) {
    const botIds = this.registry.getAllBots().map((bot) => bot.id);
    // FLAG: This endpoint is navigation/presentation only. Confirmed exact-bot grants have
    // no TTL; missing/denied grants are never repaired here and no MAX rights probe is made.
    return this.prisma.managedEntityAccessEdge.findMany({
      where: {
        userId,
        chatId: { in: [...new Set(request.entityIds)] },
        entityType: request.entityType === 'chat' ? 'CHAT' : 'CHANNEL',
        state: 'GRANTED',
        userRole: { in: ['ADMIN', 'OWNER'] },
        botId: { in: botIds },
      },
      select: {
        chatId: true,
        botId: true,
        chat: {
          select: {
            title: true,
            primaryBotId: true,
            botId: true,
            fixedModeratorBotId: true,
            routingVersion: true,
            updatedAt: true,
            botMemberships: {
              where: { status: 'ACTIVE', botId: { in: botIds } },
              select: { botId: true, botAccessState: true },
            },
          },
        },
      },
      take: 32 * Math.max(1, botIds.length),
    });
  }

  async read(user: AuthUser, input: unknown): Promise<ManagedEntityPresentationResponse> {
    return this.readForUser(user.userId, input);
  }

  async readForUser(userId: string, input: unknown): Promise<ManagedEntityPresentationResponse> {
    const request = managedEntityPresentationRequestSchema.parse(input);
    const visible = await this.readVisible(userId, request);
    const ids = [...new Set(visible.map((edge) => edge.chatId))];
    if (ids.length === 0) return { items: [], retryAfterMs: 2000 };
    const catalog = await this.prisma.managedBotChatCatalog.findMany({
      where: {
        chatId: { in: ids },
        botId: { in: this.registry.getAllBots().map((bot) => bot.id) },
        entityType: request.entityType === 'chat' ? 'CHAT' : 'CHANNEL',
        status: { in: ['ACTIVE', 'PRESENTATION'] },
      },
      select: {
        chatId: true,
        botId: true,
        title: true,
        avatarUrl: true,
        avatarState: true,
        metadataObservedAt: true,
      },
      orderBy: { metadataObservedAt: { sort: 'desc', nulls: 'last' } },
      take: 32 * Math.max(1, this.registry.getAllBots().length),
    });
    const items: ManagedEntityPresentation[] = [];
    // Queue admission is bounded by the 32 requested visible entities, not fleet size.
    for (const id of ids) {
      const edge = visible.find((row) => row.chatId === id)!;
      const memberships = new Set(edge.chat.botMemberships.map((member) => member.botId));
      const row = catalog.find(
        (candidate) => candidate.chatId === id && memberships.has(candidate.botId),
      );
      const observedAt = row?.metadataObservedAt ?? null;
      const avatarState = row?.avatarUrl
        ? 'present'
        : row?.avatarState === 'absent'
          ? 'absent'
          : 'unknown';
      const freshFor =
        avatarState === 'absent'
          ? EMPTY_FRESH_MS
          : avatarState === 'unknown'
            ? 5 * 60_000
            : FRESH_MS;
      const stale = observedAt === null || Date.now() - observedAt.getTime() >= freshFor;
      let pending = false;
      if (stale && memberships.size > 0) {
        pending = await this.enqueue(userId, request.entityType, id);
      }
      items.push({
        id,
        entityType: request.entityType,
        title:
          observedAt && observedAt >= edge.chat.updatedAt
            ? resolvePresentableManagedEntityTitle(id, row?.title, edge.chat.title)
            : resolvePresentableManagedEntityTitle(id, edge.chat.title, row?.title),
        avatarUrl: avatarState === 'absent' ? null : (row?.avatarUrl ?? null),
        avatarState,
        observedAt: observedAt?.toISOString() ?? null,
        pending,
        moderator: (() => {
          const bot = this.registry.getBotById(
            edge.chat.fixedModeratorBotId ?? edge.chat.primaryBotId ?? edge.chat.botId ?? '',
          );
          return bot?.id ? publicModerator(bot) : null;
        })(),
        moderatorRevision: edge.chat.routingVersion,
        canChooseModerator:
          [...memberships].some(
            (botId) =>
              botId !==
              (edge.chat.fixedModeratorBotId ?? edge.chat.primaryBotId ?? edge.chat.botId),
          ) && isFixedModeratorSelectionEnabled(this.config, id),
      });
    }
    return { items, retryAfterMs: 2000 };
  }

  private async enqueue(
    userId: string,
    entityType: 'chat' | 'channel',
    entityId: string,
  ): Promise<boolean> {
    const jobId = this.jobId(entityType, entityId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') {
        // Visible demand ages ahead of ordinary discovery, never ahead of an explicit refresh.
        if (
          state === 'prioritized' &&
          Date.now() - existing.timestamp >= 30_000 &&
          (existing.opts.priority ?? 10) > 4
        ) {
          await existing.changePriority({ priority: 4 });
        }
        return true;
      }
      if (Date.now() - existing.timestamp < RETRY_MS) return false;
      await existing.remove();
    }
    await this.queue.add(
      'refresh-presentation',
      {
        userId,
        entityType,
        bypassRemoteCache: false,
        resetRefreshCursor: false,
        createdAt: new Date().toISOString(),
        presentationEntityId: entityId,
      },
      {
        jobId,
        priority: 10,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000, jitter: 0.3 },
        removeOnComplete: { age: 120, count: 2000 },
        removeOnFail: { age: 3600, count: 1000 },
      },
    );
    return true;
  }

  async process(job: AdminManagedEntitiesRefreshJob): Promise<void> {
    if (!job.presentationEntityId || job.entityType === 'all') return;
    const request = managedEntityPresentationRequestSchema.parse({
      entityType: job.entityType,
      entityIds: [job.presentationEntityId],
    });
    const visible = await this.readVisible(job.userId, request);
    const first = visible[0];
    if (!first) return;
    const members = first.chat.botMemberships
      .filter(
        (member) =>
          this.registry.getBotById(member.botId)?.state === 'active' &&
          member.botAccessState !== 'DENIED' &&
          member.botAccessState !== 'LOST',
      )
      .sort(
        (a, b) =>
          Number(b.botId === first.chat.primaryBotId) - Number(a.botId === first.chat.primaryBotId),
      );
    // FLAG: A failed metadata read never activates service, changes membership or revokes rights.
    for (const member of members.slice(0, 6)) {
      const startedAt = new Date();
      let snapshot;
      try {
        snapshot = await this.max.getChatSnapshot(first.chatId, {
          botId: member.botId,
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          timeoutMs: 2500,
          bypassCache: true,
          ignoreFailureMetricStatuses: [403, 404],
        });
      } catch (error) {
        if (isBotAdminLookupDeniedError(error)) continue;
        throw error;
      }
      if (snapshot.chatId !== first.chatId || snapshot.entityType !== job.entityType) return;
      const title = resolvePresentableManagedEntityTitle(first.chatId, snapshot.title);
      const avatarState = snapshot.avatarState ?? (snapshot.avatarUrl ? 'present' : 'unknown');
      // FLAG: Update existing catalog metadata only. Never upsert a connection, advance its
      // lastSeenAt/status, or replace a more recent observation after an out-of-order response.
      const written = await this.prisma.managedBotChatCatalog.updateMany({
        where: {
          botId: member.botId,
          chatId: first.chatId,
          status: { in: ['ACTIVE', 'PRESENTATION'] },
          updatedAt: { lte: startedAt },
          OR: [{ metadataObservedAt: null }, { metadataObservedAt: { lte: startedAt } }],
        },
        data: {
          metadataObservedAt: startedAt,
          ...(title ? { title } : {}),
          ...(snapshot.link ? { link: snapshot.link } : {}),
          ...(avatarState === 'unknown'
            ? {}
            : {
                avatarState,
                avatarUrl: avatarState === 'absent' ? null : snapshot.avatarUrl,
              }),
        },
      });
      if (written.count === 0) {
        // FLAG: A missing catalog row may store presentation only. This inert status is
        // excluded from connection discovery and cannot establish or reactivate a binding.
        try {
          await this.prisma.managedBotChatCatalog.create({
            data: {
              botId: member.botId,
              chatId: first.chatId,
              entityType: job.entityType === 'chat' ? 'CHAT' : 'CHANNEL',
              status: 'PRESENTATION',
              source: 'presentation',
              title,
              link: snapshot.link,
              metadataObservedAt: startedAt,
              avatarState,
              avatarUrl: avatarState === 'present' ? snapshot.avatarUrl : null,
            },
          });
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'P2002'
          )
            return;
          throw error;
        }
      }
      if (title) {
        await this.prisma.chat.updateMany({
          where: { id: first.chatId, updatedAt: { lte: startedAt }, title: first.chat.title },
          data: { title },
        });
      }
      const saved = await this.prisma.managedBotChatCatalog.findUnique({
        where: { botId_chatId: { botId: member.botId, chatId: first.chatId } },
        select: {
          title: true,
          avatarUrl: true,
          avatarState: true,
          metadataObservedAt: true,
          link: true,
          status: true,
        },
      });
      if (!saved || !['ACTIVE', 'PRESENTATION'].includes(saved.status)) return;
      const currentChat = await this.prisma.chat.findUnique({
        where: { id: first.chatId },
        select: { title: true, updatedAt: true },
      });
      const savedTitle =
        currentChat &&
        (!saved.metadataObservedAt || currentChat.updatedAt > saved.metadataObservedAt)
          ? resolvePresentableManagedEntityTitle(first.chatId, currentChat.title, saved.title)
          : resolvePresentableManagedEntityTitle(first.chatId, saved.title, currentChat?.title);
      await this.cache.setManagedEntityHeader(
        createManagedEntityHeader({
          id: first.chatId,
          entityType: job.entityType,
          title: savedTitle ?? first.chat.title,
          avatarState:
            saved.avatarState === 'absent' ? 'absent' : saved.avatarUrl ? 'present' : 'unknown',
          metadataObservedAt: saved.metadataObservedAt?.toISOString(),
          link: saved.link,
          avatarUrl: saved.avatarUrl,
          participantsCount: snapshot.participantsCount,
        }),
      );
      return;
    }
  }
}
