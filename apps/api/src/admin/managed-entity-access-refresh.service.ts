import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ChatSummary, ManagedEntitiesListResponse, ManagedEntityType } from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../prisma/prisma-client';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { PublisherBindingRefreshQueueService } from '../publisher/publisher-binding-refresh.queue';
import { hasFreshExecutionAccess } from '../max/max-execution-route-proof';
import { isMajorManagedEntityActivationRequired } from '../max/managed-entity-activation.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';

const BATCH_SIZE = 25;
const COOLDOWN_MS = 1500;
const SCOPE_LIMIT = 1000;
type Profile = 'moderation' | 'publisher';
type Scope = {
  until: number;
  task: Promise<void>;
  cursor: { chatId: string; botId: string } | null;
};

// FLAG: Match normalizePermissionName for legacy snapshots as well as current MAX payloads.
// Only the exact indexed membership is expanded; this is never a fleet JSON scan.
function normalizedPermissionsSql(snapshot: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`ARRAY(SELECT regexp_replace(lower(btrim(value)), '[-[:space:]]+', '_', 'g')
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${snapshot}->'permissions') = 'array'
      THEN ${snapshot}->'permissions' ELSE '[]'::jsonb END) AS permission(value))`;
}

@Injectable()
export class ManagedEntityAccessRefreshService implements OnModuleDestroy {
  private readonly logger = new Logger(ManagedEntityAccessRefreshService.name);
  private readonly scopes = new Map<string, Scope>();
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
    profile: Profile,
    entityType?: ManagedEntityType,
    checkedAfter = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000),
  ): void {
    if (this.stopping) return;
    const key = JSON.stringify([profile, userId, entityType, checkedAfter]);
    const now = Date.now();
    for (const [id, scope] of this.scopes)
      if (scope.until + 5 * 60_000 <= now) this.scopes.delete(id);
    const previous = this.scopes.get(key);
    if (previous && previous.until > now) return;
    if (!previous && this.scopes.size >= SCOPE_LIMIT) return;
    const scope: Scope = {
      until: Infinity,
      task: Promise.resolve(),
      cursor: previous?.cursor ?? null,
    };
    this.scopes.set(key, scope);
    scope.task = this.enqueuePage(userId, profile, entityType, new Date(checkedAfter), scope)
      .then(() => {
        scope.until = Date.now() + COOLDOWN_MS;
      })
      .catch((error: unknown) => {
        scope.until = Date.now() + 5000;
        this.logger.warn(
          { profile, err: error instanceof Error ? error.message : String(error) },
          'Personal administrator verification admission failed',
        );
      });
  }

  private botIds(profile: Profile): string[] {
    return profile === 'publisher'
      ? [this.registry.getPublisherBotDescriptor().id]
      : this.registry.getDiscoveryBots().map((bot) => bot.id);
  }

  private async enqueuePage(
    userId: string,
    profile: Profile,
    entityType: ManagedEntityType | undefined,
    checkedAfter: Date,
    scope: Scope,
  ): Promise<void> {
    // FLAG: Page the user's raw index before testing evidence. Denials/candidates cannot
    // force an unbounded scan; raw cursors advance even when a row requires no request.
    const rows = await this.prisma.managedEntityAccessEdge.findMany({
      where: {
        userId,
        ...(scope.cursor
          ? {
              OR: [
                { chatId: { gt: scope.cursor.chatId } },
                { chatId: scope.cursor.chatId, botId: { gt: scope.cursor.botId } },
              ],
            }
          : {}),
      },
      orderBy: [{ chatId: 'asc' }, { botId: 'asc' }],
      take: BATCH_SIZE,
      select: {
        chatId: true,
        botId: true,
        entityType: true,
        state: true,
        userRole: true,
        lastAdminConfirmedAt: true,
        checkedAt: true,
        sourceVersion: true,
      },
    });
    const bots = this.botIds(profile);
    for (const edge of rows) {
      if (
        !bots.includes(edge.botId) ||
        edge.checkedAt >= checkedAfter ||
        (entityType && edge.entityType !== (entityType === 'chat' ? 'CHAT' : 'CHANNEL')) ||
        (!edge.lastAdminConfirmedAt &&
          !(edge.state === 'GRANTED' && ['ADMIN', 'OWNER'].includes(edge.userRole)))
      )
        continue;
      if (profile === 'publisher') {
        await this.publisherRefresh.enqueue({
          chatId: edge.chatId,
          publisherBotId: edge.botId,
          candidateUserId: userId,
          candidateVersion: edge.sourceVersion,
          reason: 'stale_user_access',
          requestedAt: checkedAfter,
        });
      } else if (
        !(await this.rosterSync.scheduleActorProbe({
          chatId: edge.chatId,
          botId: edge.botId,
          userId,
          requiredCheckedAfter: checkedAfter,
        }))
      )
        throw new Error('Personal access queue unavailable');
    }
    const last = rows.at(-1);
    scope.cursor =
      rows.length === BATCH_SIZE && last ? { chatId: last.chatId, botId: last.botId } : null;
  }

  async pending(
    user: AuthUser,
    profile: Profile,
    entityType?: ManagedEntityType,
  ): Promise<boolean> {
    if (user.accessCheckedAfter === undefined) return false;
    const bots = this.botIds(profile);
    if (bots.length === 0) return false;
    const rows = await this.prisma.$queryRaw<{ chatId: string }[]>(Prisma.sql`
      SELECT edge.chat_id AS "chatId" FROM managed_entity_access_edges edge
      WHERE edge.user_id = ${user.userId} AND edge.bot_id IN (${Prisma.join(bots)})
        AND edge.checked_at < ${new Date(user.accessCheckedAfter)}
        AND (edge.last_admin_confirmed_at IS NOT NULL OR
          (edge.state = 'GRANTED' AND edge.user_role IN ('ADMIN', 'OWNER')))
        ${entityType ? Prisma.sql`AND edge.entity_type = ${entityType === 'chat' ? 'CHAT' : 'CHANNEL'}::"ChatEntityType"` : Prisma.empty}
        AND EXISTS (${
          profile === 'publisher'
            ? Prisma.sql`
          SELECT 1 FROM publisher_entity_bindings binding
          WHERE binding.chat_id = edge.chat_id AND binding.publisher_bot_id = edge.bot_id
            AND binding.status = 'ACTIVE' AND binding.bot_access_state IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
            AND binding.bot_access_checked_at IS NOT NULL
            AND binding.bot_access_source IS DISTINCT FROM 'publisher_explicit_activation_pending'
            AND binding.bot_access_checked_at <= CURRENT_TIMESTAMP
            AND (binding.permissions_snapshot->>'isOwner' = 'true'
              OR COALESCE(binding.permissions_snapshot->>'permissionsKnown', 'false') <> 'true'
              OR ${normalizedPermissionsSql(Prisma.sql`binding.permissions_snapshot`)} && ARRAY['write','can_write',
                'post_edit_delete_message','post_edit_delete_messages','can_post_edit_delete_message','can_post_edit_delete_messages'])
        `
            : Prisma.sql`
          SELECT 1 FROM chat_bot_memberships membership
          WHERE membership.chat_id = edge.chat_id AND membership.bot_id = edge.bot_id
            AND membership.status = 'ACTIVE' AND membership.bot_access_state IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
            AND membership.bot_access_checked_at IS NOT NULL
            AND membership.bot_access_source <> 'major_explicit_activation_pending'
            AND membership.bot_access_checked_at <= CURRENT_TIMESTAMP
            AND (NOT COALESCE(membership.permissions_snapshot ? 'activationCapabilityCeiling', false) OR (
              membership.permissions_snapshot->'activationCapabilityCeiling' ? 'delete_message'
              AND (edge.entity_type <> 'CHAT' OR membership.permissions_snapshot->'activationCapabilityCeiling' ? 'moderation')))
            AND (COALESCE(membership.permissions_snapshot->>'permissionsKnown', 'false') <> 'true' OR (
              (edge.entity_type = 'CHAT'
                AND ${normalizedPermissionsSql(Prisma.sql`membership.permissions_snapshot`)} && ARRAY['read_all_messages','can_read_all_messages']
                AND ${normalizedPermissionsSql(Prisma.sql`membership.permissions_snapshot`)} && ARRAY['write','can_write','post_edit_delete_message',
                  'post_edit_delete_messages','can_post_edit_delete_message','can_post_edit_delete_messages'])
              OR (edge.entity_type = 'CHANNEL'
                AND ${normalizedPermissionsSql(Prisma.sql`membership.permissions_snapshot`)} && ARRAY['delete','delete_message','delete_messages','can_delete_message','can_delete_messages'])))
        `
        }) LIMIT 1`);
    return rows.length > 0;
  }

  async listPersonal(
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedEntitiesListResponse> {
    this.schedule(user.userId, 'moderation', entityType, user.accessCheckedAfter);
    const now = new Date();
    const [edges, pending] = await Promise.all([
      this.prisma.managedEntityAccessEdge.findMany({
        where: {
          userId: user.userId,
          botId: { in: this.botIds('moderation') },
          entityType: entityType === 'chat' ? 'CHAT' : 'CHANNEL',
          state: 'GRANTED',
          userRole: { in: ['ADMIN', 'OWNER'] },
          checkedAt: { gte: new Date(user.accessCheckedAfter!) },
          OR: [{ expiresAt: { gt: now } }, { expiresAt: null }],
        },
        orderBy: [{ chatId: 'asc' }, { botId: 'asc' }],
        include: {
          chat: {
            select: {
              id: true,
              title: true,
              createdAt: true,
              primaryBotId: true,
              botMemberships: {
                where: {
                  status: 'ACTIVE',
                  botAccessState: { in: ['CONFIRMED_ADMIN', 'CONFIRMED_OWNER'] },
                },
              },
            },
          },
        },
      }),
      this.pending(user, 'moderation', entityType),
    ]);
    const catalogs = edges.length
      ? await this.prisma.managedBotChatCatalog.findMany({
          where: {
            chatId: { in: [...new Set(edges.map((edge) => edge.chatId))] },
            botId: { in: this.botIds('moderation') },
            status: 'ACTIVE',
          },
          select: { chatId: true, botId: true, title: true, link: true, avatarUrl: true },
        })
      : [];
    const metadata = new Map(catalogs.map((row) => [`${row.chatId}:${row.botId}`, row]));
    const items = new Map<string, ChatSummary>();
    for (const edge of edges) {
      if (
        !edge.chat.botMemberships.some(
          (m) =>
            m.botId === edge.botId &&
            hasFreshExecutionAccess(m) &&
            !isMajorManagedEntityActivationRequired(m, edge.entityType),
        )
      )
        continue;
      if (items.has(edge.chatId)) continue;
      const catalog = metadata.get(`${edge.chatId}:${edge.botId}`);
      const botCount = edge.chat.botMemberships.filter((m) =>
        this.botIds('moderation').includes(m.botId),
      ).length;
      items.set(edge.chatId, {
        id: edge.chatId,
        title: catalog?.title?.trim() || edge.chat.title,
        createdAt: edge.chat.createdAt.toISOString(),
        entityType,
        link: catalog?.link ?? null,
        avatarUrl: catalog?.avatarUrl ?? null,
        botCount,
        hasSharedAutomation: botCount > 1,
        channelOverview: null,
        primaryBotId: edge.chat.primaryBotId,
        assignedBots: [],
        sharedMode: 'owned',
      });
    }
    return {
      items: [...items.values()],
      refresh: {
        complete: !pending,
        cursor: pending ? 0 : null,
        backoffActive: false,
        userVisibleComplete: !pending,
        nextPollAfterMs: pending ? COOLDOWN_MS : 0,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: pending ? 'in_progress' : null,
        manualRefreshRetryAfterMs: null,
      },
    };
  }
}
