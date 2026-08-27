import {
  MAX_PUBLISHER_BULK_REFRESH_TARGETS,
  PUBLISHER_ENTITIES_CURSOR_INVALID_CODE,
  decodePublisherEntitiesCursor,
  encodePublisherEntitiesCursor,
  publisherEntitiesCursorQuerySchema,
  publisherEntitiesCursorResponseSchema,
  publisherEntitiesResponseSchema,
  publisherEntitySchema,
  resolvePublisherEntitiesRequestSchema,
  resolvePublisherEntitiesResponseSchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherEntitiesCursorQuery,
  type PublisherEntitiesResponse,
  type PublisherEntity,
  type ResolvePublisherEntitiesResponse,
} from '@maxim/contracts/publisher';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import {
  hasPublisherRefreshEvidence,
  isPublisherBindingConnected,
  publisherConnectedBindingWhere,
  publisherRefreshEvidenceWhere,
} from '../publisher/publisher-entity-connection.util';
import { buildChannelOverview } from './admin-legacy-utils';
import { ManagedEntitiesService } from './managed-entities.service';
import {
  PublisherEntitiesCursorStore,
  type PublisherEntitiesCursorScope,
  type PublisherEntitiesCursorSnapshot,
} from './publisher-entities-cursor.store';

const PUBLISHER_CATALOG_LOOKUP_BATCH_SIZE = 200;
const PUBLISHER_BULK_REFRESH_QUERY_TAKE = 200;
const MINIAPP_ROUTE_START_PARAM_PREFIX = 'mr-';
const MAX_PRESENTATION_URL_LENGTH = 2_048;

type PublisherCatalogPresentation = {
  avatarUrl: string | null;
  entityUrl: string | null;
};

@Injectable()
export class PublisherPolicyService {
  private readonly cursorStore = new PublisherEntitiesCursorStore();

  constructor(
    private readonly prisma: PrismaService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly readinessService: PublisherReadinessService,
    private readonly managedEntitiesService: ManagedEntitiesService,
    private readonly maxBotLinkService: MaxBotLinkService,
  ) {}

  async listEntities(user: AuthUser, query?: unknown): Promise<PublisherEntitiesResponse> {
    const pagination = this.readPaginationMode(query);
    if (pagination === undefined) {
      return publisherEntitiesResponseSchema.parse({
        items: await this.loadScopedEntities(user),
        setupHandoffUrl: this.buildSetupHandoffUrl(),
      });
    }

    const parsed = publisherEntitiesCursorQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    return this.listEntitiesPage(user, parsed.data);
  }

  private async loadScopedEntities(
    user: AuthUser,
    entityIds?: readonly string[],
  ): Promise<PublisherEntity[]> {
    const publisherBotId = this.botRegistry.getPublisherBotDescriptor().id;
    const actionableBotIds = new Set(this.botRegistry.getActionableBots().map((bot) => bot.id));
    const now = new Date();
    const legacyGraceStart = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const [runtimeAvailable, edges] = await Promise.all([
      this.readinessService.isRuntimeAvailable(),
      this.prisma.managedEntityAccessEdge.findMany({
        where: {
          ...(entityIds ? { chatId: { in: [...entityIds] } } : {}),
          userId: user.userId,
          state: ManagedEntityAccessState.GRANTED,
          userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
          OR: [
            { expiresAt: { gt: now } },
            { expiresAt: null, checkedAt: { gt: legacyGraceStart } },
          ],
          botId: { not: publisherBotId },
          chat: {
            publisherBinding: {
              is: publisherConnectedBindingWhere(publisherBotId),
            },
          },
        },
        orderBy: [{ checkedAt: 'desc' }, { chatId: 'asc' }],
        include: {
          chat: {
            select: {
              id: true,
              title: true,
              entityType: true,
              channelSettings: {
                select: {
                  commentsEnabled: true,
                  postSuggestionsEnabled: true,
                  commentsModerationEnabled: true,
                },
              },
              publicationPolicy: true,
              publisherBinding: true,
              botMemberships: {
                where: { status: ChatBotMembershipStatus.ACTIVE },
                select: { botId: true },
              },
            },
          },
        },
      }),
    ]);

    const eligibleEdges: typeof edges = [];
    const seenEntityIds = new Set<string>();
    for (const edge of edges) {
      if (
        seenEntityIds.has(edge.chatId) ||
        edge.entityType !== edge.chat.entityType ||
        !isPublisherBindingConnected(edge.chat.publisherBinding, publisherBotId) ||
        !actionableBotIds.has(edge.botId) ||
        !edge.chat.botMemberships.some((membership) => membership.botId === edge.botId)
      ) {
        continue;
      }
      seenEntityIds.add(edge.chatId);
      eligibleEdges.push(edge);
    }

    const catalogPresentations = await this.loadCatalogPresentations(eligibleEdges, publisherBotId);
    return eligibleEdges
      .map((edge) =>
        this.presentEntity(
          edge.chat,
          { now, runtimeAvailable },
          catalogPresentations.get(this.catalogKey(publisherBotId, edge.chatId)),
        ),
      )
      .sort((left, right) => this.compareEntities(left, right));
  }

  async getEntity(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
  ): Promise<PublisherEntity> {
    return this.loadScopedEntity(entityType, entityId, user, true);
  }

  async getEntityForPolicy(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
  ): Promise<PublisherEntity> {
    return this.loadScopedEntity(entityType, entityId, user, false);
  }

  async listRefreshableEntityIds(
    user: AuthUser,
    limit = MAX_PUBLISHER_BULK_REFRESH_TARGETS,
    excludedEntityIds: readonly string[] = [],
  ): Promise<string[]> {
    const publisherBotId = this.botRegistry.getPublisherBotDescriptor().id;
    const actionableBotIds = [
      ...new Set(
        this.botRegistry
          .getActionableBots()
          .map((bot) => bot.id)
          .filter((botId) => botId !== publisherBotId),
      ),
    ];
    if (actionableBotIds.length === 0) {
      return [];
    }
    const requestedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.trunc(limit))
      : MAX_PUBLISHER_BULK_REFRESH_TARGETS;
    const boundedLimit = Math.min(MAX_PUBLISHER_BULK_REFRESH_TARGETS, requestedLimit);
    const now = new Date();
    const legacyGraceStart = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const accessWhere = {
      userId: user.userId,
      state: ManagedEntityAccessState.GRANTED,
      userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
      OR: [{ expiresAt: { gt: now } }, { expiresAt: null, checkedAt: { gt: legacyGraceStart } }],
    } satisfies Prisma.ManagedEntityAccessEdgeWhereInput;
    const routeFilters = actionableBotIds.flatMap((botId) =>
      [ChatEntityType.CHAT, ChatEntityType.CHANNEL].map(
        (entityType) =>
          ({
            entityType,
            botMemberships: {
              some: { botId, status: ChatBotMembershipStatus.ACTIVE },
            },
            accessEdges: {
              some: { ...accessWhere, botId, entityType },
            },
          }) satisfies Prisma.ChatWhereInput,
      ),
    );
    const normalizedExclusions = [
      ...new Set(excludedEntityIds.map((entityId) => entityId.trim()).filter(Boolean)),
    ].slice(0, 1_000);
    const commonWhere = {
      ...publisherRefreshEvidenceWhere(publisherBotId),
      chat: {
        AND: [
          { OR: routeFilters },
          {
            OR: [
              { publicationPolicy: { is: null } },
              { publicationPolicy: { is: { publikEnabled: true } } },
            ],
          },
        ],
      },
    } satisfies Prisma.PublisherEntityBindingWhereInput;
    const selection = {
      chatId: true,
      publisherBotId: true,
      status: true,
      botAccessState: true,
      lastSeenAt: true,
      lastWebhookAt: true,
      chat: {
        select: {
          entityType: true,
          botMemberships: {
            where: {
              status: ChatBotMembershipStatus.ACTIVE,
              botId: { in: actionableBotIds },
            },
            select: { botId: true },
          },
          accessEdges: {
            where: { ...accessWhere, botId: { in: actionableBotIds } },
            select: { botId: true, entityType: true },
          },
        },
      },
    } satisfies Prisma.PublisherEntityBindingSelect;
    const orderBy = [
      { botAccessCheckedAt: { sort: 'asc' as const, nulls: 'first' as const } },
      { updatedAt: 'asc' as const },
      { chatId: 'asc' as const },
    ];

    const problemRows = await this.prisma.publisherEntityBinding.findMany({
      where: {
        ...commonWhere,
        ...(normalizedExclusions.length > 0 ? { chatId: { notIn: normalizedExclusions } } : {}),
        AND: [
          {
            OR: [
              {
                botAccessState: {
                  in: [
                    ChatBotAccessState.UNKNOWN,
                    ChatBotAccessState.CONFIRMED_MEMBER,
                    ChatBotAccessState.DENIED,
                    ChatBotAccessState.LOST,
                    ChatBotAccessState.STALE,
                  ],
                },
              },
              { sendRouteQuarantinedUntil: { gt: now } },
              { botAccessExpiresAt: null },
              { botAccessExpiresAt: { lte: now } },
            ],
          },
        ],
      },
      select: selection,
      orderBy,
      take: PUBLISHER_BULK_REFRESH_QUERY_TAKE,
    });
    const selectedProblemIds = this.filterRefreshCandidateRows(
      problemRows,
      publisherBotId,
      boundedLimit,
    );
    const remaining = boundedLimit - selectedProblemIds.length;
    if (remaining === 0) {
      return selectedProblemIds;
    }

    const readyExclusions = [...new Set([...normalizedExclusions, ...selectedProblemIds])];
    const readyRows = await this.prisma.publisherEntityBinding.findMany({
      where: {
        ...commonWhere,
        ...(readyExclusions.length > 0 ? { chatId: { notIn: readyExclusions } } : {}),
        botAccessState: {
          in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
        },
        botAccessExpiresAt: { gt: now },
        AND: [
          {
            OR: [{ sendRouteQuarantinedUntil: null }, { sendRouteQuarantinedUntil: { lte: now } }],
          },
        ],
      },
      select: selection,
      orderBy,
      take: PUBLISHER_BULK_REFRESH_QUERY_TAKE,
    });
    return [
      ...selectedProblemIds,
      ...this.filterRefreshCandidateRows(readyRows, publisherBotId, remaining),
    ];
  }

  private filterRefreshCandidateRows(
    rows: readonly {
      chatId: string;
      publisherBotId: string;
      status: ChatBotMembershipStatus;
      botAccessState: ChatBotAccessState;
      lastSeenAt: Date | null;
      lastWebhookAt: Date | null;
      chat: {
        entityType: ChatEntityType;
        botMemberships: readonly { botId: string }[];
        accessEdges: readonly { botId: string; entityType: ChatEntityType }[];
      };
    }[],
    publisherBotId: string,
    limit: number,
  ): string[] {
    const selected: string[] = [];
    for (const row of rows) {
      if (!hasPublisherRefreshEvidence(row, publisherBotId)) {
        continue;
      }
      const activeBotIds = new Set(row.chat.botMemberships.map((membership) => membership.botId));
      if (
        !row.chat.accessEdges.some(
          (edge) => edge.entityType === row.chat.entityType && activeBotIds.has(edge.botId),
        )
      ) {
        continue;
      }
      selected.push(row.chatId);
      if (selected.length >= limit) {
        break;
      }
    }
    return selected;
  }

  private async loadScopedEntity(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
    requirePublisherConnection: boolean,
  ): Promise<PublisherEntity> {
    const publisherBotId = this.botRegistry.getPublisherBotDescriptor().id;
    const actionableBotIds = new Set(this.botRegistry.getActionableBots().map((bot) => bot.id));
    const now = new Date();
    const legacyGraceStart = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const edges = await this.prisma.managedEntityAccessEdge.findMany({
      where: {
        chatId: entityId,
        userId: user.userId,
        entityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
        state: ManagedEntityAccessState.GRANTED,
        userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        OR: [{ expiresAt: { gt: now } }, { expiresAt: null, checkedAt: { gt: legacyGraceStart } }],
        botId: { not: publisherBotId },
        ...(requirePublisherConnection
          ? {
              chat: {
                publisherBinding: {
                  is: publisherConnectedBindingWhere(publisherBotId),
                },
              },
            }
          : {}),
      },
      orderBy: [{ checkedAt: 'desc' }, { chatId: 'asc' }],
      include: {
        chat: {
          select: {
            id: true,
            title: true,
            entityType: true,
            channelSettings: {
              select: {
                commentsEnabled: true,
                postSuggestionsEnabled: true,
                commentsModerationEnabled: true,
              },
            },
            publicationPolicy: true,
            publisherBinding: true,
            botMemberships: {
              where: { status: ChatBotMembershipStatus.ACTIVE },
              select: { botId: true },
            },
          },
        },
      },
    });
    const edge = edges.find(
      (candidate) =>
        candidate.chat.entityType ===
          (entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT) &&
        (!requirePublisherConnection ||
          isPublisherBindingConnected(candidate.chat.publisherBinding, publisherBotId)) &&
        actionableBotIds.has(candidate.botId) &&
        candidate.chat.botMemberships.some((membership) => membership.botId === candidate.botId),
    );
    if (!edge) {
      throw new BadRequestException('Managed entity is unavailable');
    }
    const catalogPresentation = await this.loadTargetedCatalogPresentation(edge, publisherBotId);
    return this.presentEntity(
      edge.chat,
      {
        now,
        runtimeAvailable: await this.readinessService.isRuntimeAvailable(),
      },
      catalogPresentation,
    );
  }

  async resolveEntities(user: AuthUser, body: unknown): Promise<ResolvePublisherEntitiesResponse> {
    const parsed = resolvePublisherEntitiesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const requested = new Map(
      parsed.data.targets.map((target) => [`${target.entityType}:${target.id}`, target]),
    );
    const entities = await this.loadScopedEntities(user, [
      ...new Set([...requested.values()].map((target) => target.id)),
    ]);
    const entitiesByKey = new Map(
      entities.map((entity) => [`${entity.entityType}:${entity.id}`, entity]),
    );
    return resolvePublisherEntitiesResponseSchema.parse({
      items: [...requested.keys()].flatMap((key) => {
        const entity = entitiesByKey.get(key);
        return entity ? [entity] : [];
      }),
    });
  }

  async updatePolicy(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityPublicationPolicy> {
    const parsed = updateManagedEntityPublicationPolicyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const request = parsed.data;
    if (entityType === 'chat' && request.suggestionsViaPublik === true) {
      throw new BadRequestException('Suggestions via Publik are available only for channels');
    }
    await this.managedEntitiesService.assertManagedEntityAdminAccess(entityId, user, entityType);
    const expectedEntityType =
      entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const existingChat = await this.prisma.chat.findUnique({
      where: { id: entityId },
      select: { entityType: true, publicationPolicy: true },
    });
    if (!existingChat || existingChat.entityType !== expectedEntityType) {
      throw new BadRequestException('Managed entity type does not match');
    }

    try {
      const policy = await this.prisma.$transaction(async (tx) => {
        let updated;
        if (!existingChat.publicationPolicy) {
          if (request.expectedRevision !== 0) {
            throw this.policyConflict();
          }
          updated = await tx.managedEntityPublicationPolicy.create({
            data: {
              chatId: entityId,
              publikEnabled: request.publikEnabled ?? true,
              suggestionsViaPublik:
                entityType === 'channel' ? (request.suggestionsViaPublik ?? false) : false,
              updatedByUserId: user.userId,
            },
          });
        } else {
          const changed = await tx.managedEntityPublicationPolicy.updateMany({
            where: { chatId: entityId, revision: request.expectedRevision },
            data: {
              ...(request.publikEnabled !== undefined
                ? { publikEnabled: request.publikEnabled }
                : {}),
              ...(entityType === 'channel' && request.suggestionsViaPublik !== undefined
                ? { suggestionsViaPublik: request.suggestionsViaPublik }
                : {}),
              revision: { increment: 1 },
              updatedByUserId: user.userId,
            },
          });
          if (changed.count !== 1) {
            throw this.policyConflict();
          }
          updated = await tx.managedEntityPublicationPolicy.findUniqueOrThrow({
            where: { chatId: entityId },
          });
        }
        await tx.auditLog.create({
          data: {
            chatId: entityId,
            actorUserId: user.userId,
            action: 'UPDATE_PUBLICATION_POLICY',
            payload: {
              changed: {
                ...(request.publikEnabled !== undefined
                  ? { publikEnabled: request.publikEnabled }
                  : {}),
                ...(entityType === 'channel' && request.suggestionsViaPublik !== undefined
                  ? { suggestionsViaPublik: request.suggestionsViaPublik }
                  : {}),
              },
              revision: updated.revision,
            } satisfies Prisma.InputJsonValue,
          },
        });
        return updated;
      });
      return this.readinessService.resolvePolicy(policy);
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw this.policyConflict();
      }
      throw error;
    }
  }

  private presentEntity(
    source: {
      id: string;
      title: string;
      entityType: ChatEntityType;
      channelSettings: {
        commentsEnabled: boolean;
        postSuggestionsEnabled: boolean;
        commentsModerationEnabled: boolean;
      } | null;
      publicationPolicy: Parameters<PublisherReadinessService['resolvePolicy']>[0];
      publisherBinding: Parameters<
        PublisherReadinessService['resolveReadiness']
      >[0]['publisherBinding'];
    },
    snapshot: { now: Date; runtimeAvailable: boolean },
    catalogPresentation?: PublisherCatalogPresentation,
  ): PublisherEntity {
    const entityType = source.entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
    return publisherEntitySchema.parse({
      id: source.id,
      title: source.title,
      entityType,
      avatarUrl: catalogPresentation?.avatarUrl ?? null,
      entityUrl: catalogPresentation?.entityUrl ?? null,
      settingsHandoffUrl: this.buildSettingsHandoffUrl(entityType, source.id),
      channelOverview:
        source.entityType === ChatEntityType.CHANNEL && source.channelSettings
          ? buildChannelOverview(source.channelSettings)
          : null,
      policy: this.readinessService.resolvePolicy(source.publicationPolicy),
      readiness: this.readinessService.resolveReadiness(source, snapshot),
    });
  }

  private async loadCatalogPresentations(
    edges: readonly {
      chatId: string;
      chat: { entityType: ChatEntityType };
    }[],
    publisherBotId: string,
  ): Promise<Map<string, PublisherCatalogPresentation>> {
    const presentations = new Map<string, PublisherCatalogPresentation>();
    for (let offset = 0; offset < edges.length; offset += PUBLISHER_CATALOG_LOOKUP_BATCH_SIZE) {
      const batch = edges.slice(offset, offset + PUBLISHER_CATALOG_LOOKUP_BATCH_SIZE);
      const rows = await this.prisma.managedBotChatCatalog.findMany({
        where: {
          status: 'ACTIVE',
          OR: batch.map((edge) => ({
            botId: publisherBotId,
            chatId: edge.chatId,
            entityType: edge.chat.entityType,
          })),
        },
        select: {
          botId: true,
          chatId: true,
          link: true,
          avatarUrl: true,
        },
      });
      for (const row of rows) {
        presentations.set(this.catalogKey(row.botId, row.chatId), {
          avatarUrl: this.normalizeHttpPresentationUrl(row.avatarUrl),
          entityUrl: this.normalizeMaxEntityUrl(row.link),
        });
      }
    }
    return presentations;
  }

  private async loadTargetedCatalogPresentation(
    edge: {
      chatId: string;
      chat: { entityType: ChatEntityType };
    },
    publisherBotId: string,
  ): Promise<PublisherCatalogPresentation | undefined> {
    const row = await this.prisma.managedBotChatCatalog.findFirst({
      where: {
        botId: publisherBotId,
        chatId: edge.chatId,
        entityType: edge.chat.entityType,
        status: 'ACTIVE',
      },
      select: {
        link: true,
        avatarUrl: true,
      },
    });
    return row
      ? {
          avatarUrl: this.normalizeHttpPresentationUrl(row.avatarUrl),
          entityUrl: this.normalizeMaxEntityUrl(row.link),
        }
      : undefined;
  }

  private buildSettingsHandoffUrl(entityType: ManagedEntityType, entityId: string): string | null {
    const route = `/${entityType}/${encodeURIComponent(entityId)}/settings`;
    return this.buildRouteHandoffUrl(route);
  }

  private buildSetupHandoffUrl(): string | null {
    return this.buildRouteHandoffUrl('/');
  }

  private buildRouteHandoffUrl(route: string): string | null {
    const payload = Buffer.from(JSON.stringify({ v: 1, k: 'route', r: route }), 'utf8').toString(
      'base64url',
    );
    return this.maxBotLinkService.buildEntryMiniappStartUrlSync(
      `${MINIAPP_ROUTE_START_PARAM_PREFIX}${payload}`,
    );
  }

  private normalizeMaxEntityUrl(value: string | null): string | null {
    const parsed = this.parsePresentationUrl(value);
    if (
      !parsed ||
      parsed.protocol !== 'https:' ||
      (parsed.hostname !== 'max.ru' && parsed.hostname !== 'www.max.ru') ||
      parsed.port.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.pathname === '/'
    ) {
      return null;
    }
    parsed.hostname = 'max.ru';
    return parsed.toString();
  }

  private normalizeHttpPresentationUrl(value: string | null): string | null {
    const parsed = this.parsePresentationUrl(value);
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      return null;
    }
    return parsed.toString();
  }

  private parsePresentationUrl(value: string | null): URL | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (
      normalized.length === 0 ||
      normalized.length > MAX_PRESENTATION_URL_LENGTH ||
      [...normalized].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          /\s/u.test(character) || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        );
      })
    ) {
      return null;
    }
    try {
      const parsed = new URL(normalized);
      return parsed.username.length === 0 && parsed.password.length === 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  private catalogKey(botId: string, chatId: string): string {
    return JSON.stringify([botId, chatId]);
  }

  private async listEntitiesPage(
    user: AuthUser,
    query: PublisherEntitiesCursorQuery,
  ): Promise<PublisherEntitiesResponse> {
    const cursor = query.cursor ? decodePublisherEntitiesCursor(query.cursor) : null;
    if (
      query.cursor &&
      (!cursor ||
        cursor.query !== query.query ||
        cursor.entityType !== (query.entityType ?? null) ||
        cursor.readiness !== (query.readiness ?? null))
    ) {
      throw this.invalidEntitiesCursor();
    }

    const scope = this.cursorScope(user, query);
    if (cursor) {
      const snapshot = this.cursorStore.read(cursor.snapshotId, scope);
      if (!snapshot || cursor.offset >= snapshot.items.length) {
        throw this.invalidEntitiesCursor();
      }
      return this.buildSnapshotPage(
        user,
        cursor.snapshotId,
        snapshot,
        cursor.offset,
        query.limit,
        scope,
      );
    }

    const reusable = this.cursorStore.findReusable(scope);
    if (reusable) {
      return this.buildSnapshotPage(
        user,
        reusable.snapshotId,
        reusable.snapshot,
        0,
        query.limit,
        scope,
      );
    }

    const entities = await this.loadScopedEntities(user);
    const summary = this.summarizeEntities(entities);
    const normalizedQuery = query.query.toLocaleLowerCase('ru-RU');
    const filtered = entities.filter((entity) => {
      if (query.entityType && entity.entityType !== query.entityType) {
        return false;
      }
      if (
        query.readiness &&
        (query.readiness === 'ready' ? !entity.readiness.canPublish : entity.readiness.canPublish)
      ) {
        return false;
      }
      return (
        normalizedQuery.length === 0 ||
        `${entity.title} ${entity.id}`.toLocaleLowerCase('ru-RU').includes(normalizedQuery)
      );
    });

    if (filtered.length <= query.limit) {
      return publisherEntitiesCursorResponseSchema.parse({
        items: filtered,
        setupHandoffUrl: this.buildSetupHandoffUrl(),
        nextCursor: null,
        filteredTotal: filtered.length,
        summary,
      });
    }

    const snapshotHandle = this.cursorStore.createOrReuse({
      ...scope,
      filteredTotal: filtered.length,
      summary,
      items: filtered.map((entity) => ({ id: entity.id, entityType: entity.entityType })),
    });
    if (!snapshotHandle) {
      throw new ServiceUnavailableException('Список получателей слишком велик для пагинации.');
    }
    return this.buildSnapshotPage(
      user,
      snapshotHandle.snapshotId,
      snapshotHandle.snapshot,
      0,
      query.limit,
      scope,
      entities,
    );
  }

  private async buildSnapshotPage(
    user: AuthUser,
    snapshotId: string,
    snapshot: PublisherEntitiesCursorSnapshot,
    offset: number,
    limit: number,
    scope: PublisherEntitiesCursorScope,
    availableEntities?: readonly PublisherEntity[],
  ): Promise<PublisherEntitiesResponse> {
    const endIndex = Math.min(offset + limit, snapshot.items.length);
    const candidates = snapshot.items.slice(offset, endIndex);
    const entities =
      availableEntities ??
      (await this.loadScopedEntities(user, [
        ...new Set(candidates.map((candidate) => candidate.id)),
      ]));
    const entitiesByKey = new Map(
      entities.map((entity) => [this.entityKey(entity.entityType, entity.id), entity]),
    );
    const items = candidates.flatMap((candidate) => {
      const entity = entitiesByKey.get(this.entityKey(candidate.entityType, candidate.id));
      return entity ? [entity] : [];
    });
    const nextCursor =
      endIndex < snapshot.items.length
        ? encodePublisherEntitiesCursor({
            v: 1,
            snapshotId,
            offset: endIndex,
            query: scope.query,
            entityType: scope.entityType,
            readiness: scope.readiness,
          })
        : null;
    const response = publisherEntitiesCursorResponseSchema.parse({
      items,
      setupHandoffUrl: this.buildSetupHandoffUrl(),
      nextCursor,
      filteredTotal: snapshot.filteredTotal,
      summary: snapshot.summary,
    });
    if (!nextCursor) {
      this.cursorStore.complete(snapshotId, scope);
    }
    return response;
  }

  private cursorScope(
    user: AuthUser,
    query: PublisherEntitiesCursorQuery,
  ): PublisherEntitiesCursorScope {
    return {
      userId: user.userId,
      query: query.query,
      entityType: query.entityType ?? null,
      readiness: query.readiness ?? null,
    };
  }

  private entityKey(entityType: ManagedEntityType, entityId: string): string {
    return JSON.stringify([entityType, entityId]);
  }

  private summarizeEntities(entities: readonly PublisherEntity[]): {
    total: number;
    chat: number;
    channel: number;
    ready: number;
    attention: number;
  } {
    let chat = 0;
    let channel = 0;
    let ready = 0;
    for (const entity of entities) {
      if (entity.entityType === 'channel') {
        channel += 1;
      } else {
        chat += 1;
      }
      if (entity.readiness.canPublish) {
        ready += 1;
      }
    }
    return {
      total: entities.length,
      chat,
      channel,
      ready,
      attention: entities.length - ready,
    };
  }

  private compareEntities(left: PublisherEntity, right: PublisherEntity): number {
    return (
      left.entityType.localeCompare(right.entityType) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
    );
  }

  private readPaginationMode(query: unknown): unknown {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      return undefined;
    }
    return (query as Record<string, unknown>).pagination;
  }

  private invalidEntitiesCursor(): BadRequestException {
    return new BadRequestException({
      message: 'Курсор списка получателей недействителен.',
      code: PUBLISHER_ENTITIES_CURSOR_INVALID_CODE,
    });
  }

  private policyConflict(): ConflictException {
    return new ConflictException({
      message: 'Publication policy changed. Refresh and retry.',
      code: 'PUBLISHER_POLICY_REVISION_CONFLICT',
    });
  }
}
