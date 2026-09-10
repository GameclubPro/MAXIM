import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { ChatEntityType, ManagedEntityAccessState, type Prisma } from '../prisma/prisma-client';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { PublisherBindingRefreshQueueService } from '../publisher/publisher-binding-refresh.queue';
import { publisherRefreshEvidenceWhere } from '../publisher/publisher-entity-connection.util';

const REFRESH_AHEAD_MS = 12 * 60 * 60_000;
const REFRESH_COOLDOWN_MS = 30_000;
const REFRESH_SCOPE_LIMIT = 1_000;
const REFRESH_BATCH_SIZE = 25;

@Injectable()
export class ManagedEntityAccessRefreshService implements OnModuleDestroy {
  private readonly logger = new Logger(ManagedEntityAccessRefreshService.name);
  private readonly scopes = new Map<string, { until: number; task: Promise<void> }>();
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MaxBotRegistryService,
    private readonly rosterSync: MaxChatAdminRosterSyncService,
    private readonly publisherRefresh: PublisherBindingRefreshQueueService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.scopes.values()].map((scope) => scope.task));
  }

  schedule(
    userId: string,
    profile: 'moderation' | 'publisher',
    entityType?: ManagedEntityType,
  ): void {
    if (this.stopping) return;
    const key = JSON.stringify([profile, userId, entityType ?? null]);
    const now = Date.now();
    for (const [scopeKey, scope] of this.scopes) {
      if (scope.until <= now) this.scopes.delete(scopeKey);
    }
    if (this.scopes.has(key) || this.scopes.size >= REFRESH_SCOPE_LIMIT) return;

    const scope = { until: Number.POSITIVE_INFINITY, task: Promise.resolve() };
    this.scopes.set(key, scope);
    scope.task = this.enqueueDue(userId, profile, entityType)
      .then(() => {
        scope.until = Date.now() + REFRESH_COOLDOWN_MS;
      })
      .catch((error: unknown) => {
        scope.until = Date.now() + 5_000;
        this.logger.warn(
          { profile, entityType, err: error instanceof Error ? error.message : String(error) },
          'Failed to schedule user-scoped managed access renewal',
        );
      });
  }

  private async enqueueDue(
    userId: string,
    profile: 'moderation' | 'publisher',
    entityType?: ManagedEntityType,
  ): Promise<void> {
    const publisherBotId = this.registry.getPublisherBotDescriptor().id;
    const botIds =
      profile === 'publisher'
        ? [publisherBotId]
        : this.registry.getDiscoveryBots().map((bot) => bot.id);
    if (botIds.length === 0) return;
    const now = new Date();
    // FLAG: Expiry triggers verification, never a synthetic grant. MAX calls remain in the
    // owning worker; the home request reads only this user's bounded, exact-bot evidence.
    const where: Prisma.ManagedEntityAccessEdgeWhereInput = {
      userId,
      botId: { in: botIds },
      ...(entityType
        ? { entityType: entityType === 'chat' ? ChatEntityType.CHAT : ChatEntityType.CHANNEL }
        : {}),
      OR: [
        {
          state: 'GRANTED',
          userRole: { in: ['ADMIN', 'OWNER'] },
          ...(profile === 'moderation'
            ? {
                chat: {
                  botMemberships: { some: { botId: { in: botIds }, status: 'ACTIVE' as const } },
                },
              }
            : {}),
          OR: [
            { expiresAt: null },
            { expiresAt: { lte: new Date(now.getTime() + REFRESH_AHEAD_MS) } },
          ],
        },
        ...(profile === 'publisher'
          ? [
              {
                state: {
                  in: [ManagedEntityAccessState.USER_DENIED, ManagedEntityAccessState.BOT_DENIED],
                },
                source: { in: ['admin_roster_sync_clear', 'prune_persisted_chat_access'] },
              },
            ]
          : [
              {
                state: ManagedEntityAccessState.BOT_DENIED,
                source: { in: ['managed_poll:lookup', 'managed_giveaway:results:verification'] },
                lastMaxStatusCode: { in: [403, 404] },
                lastMaxErrorCode: null,
              },
            ]),
      ],
      ...(profile === 'publisher'
        ? { chat: { publisherBinding: { is: publisherRefreshEvidenceWhere(publisherBotId) } } }
        : {}),
    };
    const edges = await this.prisma.managedEntityAccessEdge.findMany({
      where,
      select: { chatId: true, botId: true, entityType: true, sourceVersion: true },
      orderBy: [{ checkedAt: 'asc' }, { chatId: 'asc' }, { botId: 'asc' }],
      take: REFRESH_BATCH_SIZE,
    });
    const scheduled = new Set<string>();
    for (const edge of edges) {
      if (!botIds.includes(edge.botId) || scheduled.has(edge.chatId)) continue;
      if (profile === 'publisher') {
        await this.publisherRefresh.enqueue({
          chatId: edge.chatId,
          publisherBotId,
          candidateUserId: userId,
          candidateVersion: edge.sourceVersion,
          reason: 'stale_user_access',
          requestedAt: now,
        });
      } else {
        const accepted = await this.rosterSync.scheduleChatAdminRosterSync({
          chatId: edge.chatId,
          botIds: edges
            .filter((row) => row.chatId === edge.chatId && botIds.includes(row.botId))
            .map((row) => row.botId),
          entityType: edge.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
          source: 'admin_access_validation',
        });
        if (!accepted) throw new Error('Managed access renewal queue unavailable');
      }
      scheduled.add(edge.chatId);
    }
  }
}
