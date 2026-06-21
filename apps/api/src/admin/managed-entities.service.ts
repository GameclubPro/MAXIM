import {
  managedEntityAccessRecheckResponseSchema,
  managedEntityFavoritesResponseSchema,
  managedEntityOnboardingDiagnosticsSchema,
  managedEntityTypeSchema,
  managedEntityBotExecutionPlanSchema,
  promoteManagedEntityStandbyRequestSchema,
  updateManagedEntityFavoritesRequestSchema,
  updateManagedEntityPartnerAssistRequestSchema,
  updateManagedEntityPrimaryBotRequestSchema,
  type ChatSummary,
  type Me,
  type ManagedEntityAccessDiagnostics,
  type ManagedEntityAccessLossDiagnosticItem,
  type ManagedEntityAccessLossReason,
  type ManagedEntityAccessRecheckResponse,
  type ManagedEntityBotExecutionPlan,
  type ManagedEntityFavoriteType,
  type ManagedEntityFavoritesResponse,
  type ManagedEntityHeader,
  type ManagedEntityOnboardingDiagnostics,
  type ManagedEntitiesListResponse,
  type ManagedEntitiesResponseDiff,
  type ManagedEntityType,
} from '@maxim/contracts';
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxBotExecutionPlannerService } from '../max/max-bot-execution-planner.service';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { MaxClientService } from '../max/max-client.service';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ManagedEntityAccessState,
  ManagedEntityHandshakeOutcomeStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeMembershipAccessSnapshot } from '../max/max-bot-access-policy.util';
import {
  canUserAccessSystem,
  readSystemAccessConfig,
  type SystemAccessConfig,
} from '../system/system-access.util';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';
import type { AdminManagedEntitiesRefreshJob } from './admin-managed-entities-refresh.queue';
import { getManagedEntityHeaderValue } from './admin-managed-entity-header';
import {
  listManagedEntitiesValue,
  listManagedEntitiesWithRefreshStateValue,
} from './admin-managed-entities-list';
import {
  normalizeAppBaseUrl,
  normalizeBotContactId,
  normalizeOwnBotUserId,
  readTrimmedString,
  fromPrismaEntityType,
  toPrismaEntityType,
} from './admin-legacy-utils';
import {
  buildProfileMentionHandoffUrl,
  buildUserProfileUrl,
  normalizeMaxProfileUrl,
} from './admin-profile-links';
import {
  ADMIN_ACTION_HEALTH_LANE,
  CONTRACT_FAVORITE_TYPE_BY_PRISMA,
  MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS,
  MANAGED_ENTITY_FAVORITE_TYPE_ORDER,
  PRISMA_FAVORITE_TYPE_BY_CONTRACT,
  type AdminReadBypassOptions,
  type ManagedEntitiesListOptions,
  type ManagedEntitiesRefreshJobOutcome,
} from './admin.service.support';
import { AdminService } from './admin.service';

const MANAGED_ENTITY_ACCESS_LOSS_REASONS = new Set<ManagedEntityAccessLossReason>([
  'chat_not_found',
  'bot_denied',
  'bot_removed',
  'chat_inaccessible',
]);

const HANDSHAKE_OUTCOME_BY_PRISMA_STATUS: Record<
  ManagedEntityHandshakeOutcomeStatus,
  'connected' | 'already_connected' | 'bootstrapped_without_user' | 'bot_denied' | 'user_denied' | 'rate_limited' | 'failed'
> = {
  CONNECTED: 'connected',
  ALREADY_CONNECTED: 'already_connected',
  BOOTSTRAPPED_WITHOUT_USER: 'bootstrapped_without_user',
  BOT_DENIED: 'bot_denied',
  USER_DENIED: 'user_denied',
  RATE_LIMITED: 'rate_limited',
  FAILED: 'failed',
};

type AccessLossSnapshot = {
  reason: ManagedEntityAccessLossReason;
  detectedAt: string | null;
  source: string;
  lastMaxErrorCode: string | null;
  lastMaxErrorMessage: string | null;
  lastMaxStatusCode: number | null;
};

@Injectable()
export class ManagedEntitiesService {
  private readonly logger = new Logger(ManagedEntitiesService.name);
  private readonly dialogLinkHelper: AdminDialogLinkHelper;
  private readonly systemAccessConfig: SystemAccessConfig;

  constructor(
    private readonly legacyAdminService: AdminService,
    private readonly prisma: PrismaService,
    private readonly chatContextCache: ChatContextCacheService,
    private readonly maxClient: MaxClientService,
    configService: ConfigService,
    @Optional() private readonly maxBotExecutionPlanner?: MaxBotExecutionPlannerService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly maxBotRegistry?: MaxBotRegistryService,
    @Optional() private readonly maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService,
  ) {
    const configuredBotTokens = collectBotTokenSecrets(
      configService.getOrThrow<string>('MAX_BOT_TOKEN'),
      configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    const maxBotToken =
      this.maxBotLinkService?.getBotTokenSync?.() ??
      configuredBotTokens[0] ??
      configService.getOrThrow<string>('MAX_BOT_TOKEN');
    const maxBotTokenValidationSecrets =
      this.maxBotLinkService?.getValidationTokens?.() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [maxBotToken]);
    this.dialogLinkHelper = new AdminDialogLinkHelper({
      appBaseUrl: normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL')),
      explicitBotContactId: normalizeBotContactId(configService.get<string>('MAX_BOT_CONTACT_ID')),
      ownBotUserId: normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID')),
      maxBotToken,
      maxBotTokenValidationSecrets,
      maxBotLinkService: this.maxBotLinkService,
      maxBotRegistry: this.maxBotRegistry,
    });
    this.systemAccessConfig = readSystemAccessConfig(configService);
  }

  async getMe(
    user: AuthUser,
    options: { chatId?: string; entityType?: ManagedEntityType; enrichFromMax?: boolean } = {},
  ): Promise<Me> {
    const canAccessSystem =
      this.systemAccessConfig.requireSystemAdmin &&
      canUserAccessSystem(user.userId, this.systemAccessConfig);
    const contextChatId = readTrimmedString(options.chatId) ?? readTrimmedString(user.chatId);
    const contextEntityType: ManagedEntityType =
      options.entityType ?? (user.chatType === 'channel' ? 'channel' : 'chat');
    const fallbackDisplayName = readTrimmedString(user.displayName) ?? null;
    const fallbackUsername = readTrimmedString(user.username) ?? null;
    const fallback: Me = {
      userId: user.userId,
      username: fallbackUsername,
      displayName: fallbackDisplayName,
      avatarUrl: readTrimmedString(user.avatarUrl) ?? null,
      profileUrl:
        normalizeMaxProfileUrl(readTrimmedString(user.profileUrl) ?? null) ??
        buildUserProfileUrl(fallbackUsername),
      profileHandoffUrl: contextChatId
        ? buildProfileMentionHandoffUrl(
            this.dialogLinkHelper,
            contextChatId,
            contextEntityType,
            user.userId,
            fallbackDisplayName ?? fallbackUsername,
          )
        : null,
      ...(canAccessSystem ? { canAccessSystem: true } : {}),
    };
    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);

    if (
      options.enrichFromMax !== true ||
      !contextChatId ||
      typeof loadProfiles !== 'function' ||
      (fallback.username && fallback.displayName && fallback.avatarUrl && fallback.profileUrl)
    ) {
      return fallback;
    }

    try {
      const profiles = await loadProfiles(contextChatId, [user.userId], {
        trafficClass: 'interactive',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      });
      const profile = profiles.get(user.userId);
      const username = readTrimmedString(profile?.username) ?? fallback.username;
      const displayName = fallback.displayName ?? readTrimmedString(profile?.displayName) ?? null;
      const avatarUrl = fallback.avatarUrl ?? readTrimmedString(profile?.avatarUrl) ?? null;
      const profileUrl =
        normalizeMaxProfileUrl(readTrimmedString(profile?.profileUrl) ?? null) ??
        fallback.profileUrl ??
        buildUserProfileUrl(username);

      return {
        userId: user.userId,
        username,
        displayName,
        avatarUrl,
        profileUrl,
        profileHandoffUrl: buildProfileMentionHandoffUrl(
          this.dialogLinkHelper,
          contextChatId,
          contextEntityType,
          user.userId,
          displayName ?? username,
        ),
        ...(canAccessSystem ? { canAccessSystem: true } : {}),
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: contextChatId,
          userId: user.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve current admin profile from MAX',
      );
      return fallback;
    }
  }

  listChats(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    return listManagedEntitiesValue({
      user,
      entityType: 'chat',
      options,
      listDetailed: (listUser, entityType, listOptions) =>
        this.legacyAdminService.listManagedEntitiesDetailedForManagedEntities(
          listUser,
          entityType,
          listOptions,
        ),
      attachFavoriteTypes: (userId, items) => this.attachManagedEntityFavoriteTypes(userId, items),
    });
  }

  listChatsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return listManagedEntitiesWithRefreshStateValue({
      user,
      entityType: 'chat',
      options,
      listDetailed: (listUser, entityType, listOptions) =>
        this.legacyAdminService.listManagedEntitiesDetailedForManagedEntities(
          listUser,
          entityType,
          listOptions,
        ),
      attachFavoriteTypes: (userId, items) => this.attachManagedEntityFavoriteTypes(userId, items),
      attachFavoriteTypesToDiff: (userId, diff) =>
        this.attachManagedEntityFavoriteTypesToDiff(userId, diff),
      createIdleRefreshState: () =>
        this.legacyAdminService.createIdleManagedEntitiesRefreshStateForManagedEntities(),
    });
  }

  listChannels(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    return listManagedEntitiesValue({
      user,
      entityType: 'channel',
      options,
      listDetailed: (listUser, entityType, listOptions) =>
        this.legacyAdminService.listManagedEntitiesDetailedForManagedEntities(
          listUser,
          entityType,
          listOptions,
        ),
      attachFavoriteTypes: (userId, items) => this.attachManagedEntityFavoriteTypes(userId, items),
    });
  }

  listChannelsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return listManagedEntitiesWithRefreshStateValue({
      user,
      entityType: 'channel',
      options,
      listDetailed: (listUser, entityType, listOptions) =>
        this.legacyAdminService.listManagedEntitiesDetailedForManagedEntities(
          listUser,
          entityType,
          listOptions,
        ),
      attachFavoriteTypes: (userId, items) => this.attachManagedEntityFavoriteTypes(userId, items),
      attachFavoriteTypesToDiff: (userId, diff) =>
        this.attachManagedEntityFavoriteTypesToDiff(userId, diff),
      createIdleRefreshState: () =>
        this.legacyAdminService.createIdleManagedEntitiesRefreshStateForManagedEntities(),
    });
  }

  async getOnboardingDiagnostics(
    entityTypeRaw: string,
    user: AuthUser,
  ): Promise<ManagedEntityOnboardingDiagnostics> {
    const entityType = managedEntityTypeSchema.parse(entityTypeRaw);
    const prismaEntityType = toPrismaEntityType(entityType);
    const now = new Date();
    const [visibleEdge, localActivities, accessEdges, lastHandshake] = await Promise.all([
      this.prisma.managedEntityAccessEdge.findFirst({
        where: {
          userId: user.userId,
          entityType: prismaEntityType,
          state: ManagedEntityAccessState.GRANTED,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { chatId: true },
        orderBy: [{ checkedAt: 'desc' }],
      }),
      this.prisma.managedEntityLocalActivity.findMany({
        where: {
          userId: user.userId,
          entityType: prismaEntityType,
        },
        select: {
          chatId: true,
          chatTitle: true,
          sourceEventType: true,
          lastEventAt: true,
        },
        orderBy: [{ lastEventAt: 'desc' }],
        take: 3,
      }),
      this.prisma.managedEntityAccessEdge.findMany({
        where: {
          userId: user.userId,
          entityType: prismaEntityType,
        },
        select: {
          chatId: true,
          state: true,
          checkedAt: true,
        },
        orderBy: [{ checkedAt: 'desc' }],
        take: 3,
      }),
      this.prisma.managedEntityHandshakeOutcome.findFirst({
        where: {
          userId: user.userId,
          entityType: prismaEntityType,
          expiresAt: { gt: now },
        },
        select: {
          chatId: true,
          title: true,
          status: true,
          reason: true,
          happenedAt: true,
        },
        orderBy: [{ happenedAt: 'desc' }],
      }),
    ]);

    return managedEntityOnboardingDiagnosticsSchema.parse({
      entityType,
      hasVisibleEntities: visibleEdge !== null,
      recentSignals: [
        ...localActivities.map((activity) => ({
          type: 'recent_activity',
          chatId: activity.chatId,
          title: activity.chatTitle,
          status: activity.sourceEventType,
          at: activity.lastEventAt.toISOString(),
        })),
        ...accessEdges.map((edge) => ({
          type: 'access_edge',
          chatId: edge.chatId,
          title: null,
          status: edge.state.toLowerCase(),
          at: edge.checkedAt.toISOString(),
        })),
      ]
        .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
        .slice(0, 5),
      lastHandshake: lastHandshake
        ? {
            chatId: lastHandshake.chatId,
            title: lastHandshake.title,
            status: HANDSHAKE_OUTCOME_BY_PRISMA_STATUS[lastHandshake.status],
            reason: lastHandshake.reason,
            happenedAt: lastHandshake.happenedAt.toISOString(),
          }
        : null,
    });
  }

  getChatHeader(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return this.getManagedEntityHeader(chatId, user, 'chat', options);
  }

  getChannelHeader(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return this.getManagedEntityHeader(chatId, user, 'channel', options);
  }

  private getManagedEntityHeader(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions,
  ): Promise<ManagedEntityHeader> {
    return this.getManagedEntityHeaderWithDiagnostics(chatId, user, entityType, options);
  }

  private async getManagedEntityHeaderWithDiagnostics(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions,
  ): Promise<ManagedEntityHeader> {
    const header = await getManagedEntityHeaderValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      entityType,
      options,
      assertReadAccess: (readOptions) =>
        this.legacyAdminService.assertManagedEntityReadAccess(
          chatId,
          user.userId,
          entityType,
          readOptions,
        ),
      resolveReadBotId: () => this.legacyAdminService.resolveManagedEntityHeaderReadBotId(chatId),
      attachBotAssignments: (header) =>
        this.legacyAdminService.attachManagedEntityHeaderBotAssignmentsForManagedEntities(header),
    });

    return {
      ...header,
      accessDiagnostics: await this.getManagedEntityAccessDiagnostics(chatId),
      viewerAccess: await this.getManagedEntityViewerAccess(chatId, user.userId, entityType),
    };
  }

  getChatBotExecutionPlan(
    chatId: string,
    user: AuthUser,
    options: { refresh?: boolean } = {},
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.getManagedEntityBotExecutionPlan(chatId, user, 'chat', options);
  }

  getChannelBotExecutionPlan(
    chatId: string,
    user: AuthUser,
    options: { refresh?: boolean } = {},
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.getManagedEntityBotExecutionPlan(chatId, user, 'channel', options);
  }

  updateChatPrimaryBot(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.updateManagedEntityPrimaryBot(chatId, user, 'chat', body);
  }

  updateChannelPrimaryBot(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.updateManagedEntityPrimaryBot(chatId, user, 'channel', body);
  }

  updateChatPartnerAssist(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.updateManagedEntityPartnerAssist(chatId, user, 'chat', body);
  }

  updateChannelPartnerAssist(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.updateManagedEntityPartnerAssist(chatId, user, 'channel', body);
  }

  promoteChatStandbyBot(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.promoteManagedEntityStandbyBot(chatId, user, 'chat', body);
  }

  promoteChannelStandbyBot(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    return this.promoteManagedEntityStandbyBot(chatId, user, 'channel', body);
  }

  async updateManagedEntityFavorites(
    entityTypeRaw: string,
    entityId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityFavoritesResponse> {
    const entityType = managedEntityTypeSchema.parse(entityTypeRaw);
    const parsed = updateManagedEntityFavoritesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    await this.assertManagedEntityAdminAccess(entityId, user, entityType);

    const favoriteTypes = parsed.data.favoriteTypes;
    const prismaEntityType = toPrismaEntityType(entityType);
    const prismaFavoriteTypes = favoriteTypes.map(
      (favoriteType) => PRISMA_FAVORITE_TYPE_BY_CONTRACT[favoriteType],
    );

    await this.prisma.$transaction([
      this.prisma.managedEntityFavorite.deleteMany({
        where: {
          userId: user.userId,
          chatId: entityId,
          entityType: prismaEntityType,
          favoriteType:
            prismaFavoriteTypes.length > 0
              ? {
                  notIn: prismaFavoriteTypes,
                }
              : undefined,
        },
      }),
      ...favoriteTypes.map((favoriteType, index) =>
        this.prisma.managedEntityFavorite.upsert({
          where: {
            userId_entityType_chatId_favoriteType: {
              userId: user.userId,
              entityType: prismaEntityType,
              chatId: entityId,
              favoriteType: PRISMA_FAVORITE_TYPE_BY_CONTRACT[favoriteType],
            },
          },
          create: {
            userId: user.userId,
            entityType: prismaEntityType,
            chatId: entityId,
            favoriteType: PRISMA_FAVORITE_TYPE_BY_CONTRACT[favoriteType],
            position: index,
          },
          update: {
            position: index,
          },
        }),
      ),
      this.prisma.auditLog.create({
        data: {
          chatId: entityId,
          actorUserId: user.userId,
          action: 'UPDATE_MANAGED_ENTITY_FAVORITES',
          payload: {
            entityType,
            favoriteTypes,
          },
        },
      }),
    ]);

    return managedEntityFavoritesResponseSchema.parse({
      entityType,
      entityId,
      favoriteTypes,
    });
  }

  async recheckManagedEntityAccess(
    entityTypeRaw: string,
    entityId: string,
    user: AuthUser,
  ): Promise<ManagedEntityAccessRecheckResponse> {
    const entityType = managedEntityTypeSchema.parse(entityTypeRaw);
    const chatId = readTrimmedString(entityId);
    if (!chatId) {
      throw new BadRequestException('Managed entity id is required.');
    }

    await this.assertManagedEntityDiagnosticsAccess(chatId, user, entityType);
    const scheduled =
      (await this.maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync({
        chatId,
        entityType,
        source: 'admin_access_validation',
        retryUntilMs: null,
      })) ?? false;
    await this.chatContextCache.invalidateManagedEntityHeader?.(chatId, entityType);

    return managedEntityAccessRecheckResponseSchema.parse({
      entityType,
      entityId: chatId,
      scheduled,
      diagnostics: await this.getManagedEntityAccessDiagnostics(chatId),
    });
  }

  private async attachManagedEntityFavoriteTypes(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (items.length === 0) {
      return [];
    }

    const rows = await this.prisma.managedEntityFavorite.findMany({
      where: {
        userId,
        chatId: {
          in: Array.from(new Set(items.map((item) => item.id))),
        },
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        chatId: true,
        entityType: true,
        favoriteType: true,
      },
    });
    const favoriteTypesByKey = new Map<string, ManagedEntityFavoriteType[]>();
    for (const row of rows) {
      const favoriteType = CONTRACT_FAVORITE_TYPE_BY_PRISMA[row.favoriteType];
      const key = `${fromPrismaEntityType(row.entityType)}:${row.chatId}`;
      const current = favoriteTypesByKey.get(key) ?? [];
      if (!current.includes(favoriteType)) {
        current.push(favoriteType);
      }
      favoriteTypesByKey.set(key, current);
    }

    return items.map((item) => {
      const favoriteTypes = favoriteTypesByKey.get(`${item.entityType}:${item.id}`) ?? [];
      const next: ChatSummary = { ...item };
      if (favoriteTypes.length > 0) {
        next.favoriteTypes = this.sortManagedEntityFavoriteTypes(favoriteTypes);
      } else {
        delete next.favoriteTypes;
      }
      return next;
    });
  }

  private async attachManagedEntityFavoriteTypesToDiff(
    userId: string,
    diff: ManagedEntitiesResponseDiff | null | undefined,
  ): Promise<ManagedEntitiesResponseDiff | null | undefined> {
    if (!diff || diff.mode !== 'patch') {
      return diff;
    }

    const [added, updated] = await Promise.all([
      this.attachManagedEntityFavoriteTypes(userId, diff.added),
      this.attachManagedEntityFavoriteTypes(userId, diff.updated),
    ]);

    return {
      ...diff,
      added,
      updated,
    };
  }

  private sortManagedEntityFavoriteTypes(
    favoriteTypes: readonly ManagedEntityFavoriteType[],
  ): ManagedEntityFavoriteType[] {
    const selected = new Set(favoriteTypes);
    return MANAGED_ENTITY_FAVORITE_TYPE_ORDER.filter((favoriteType) => selected.has(favoriteType));
  }

  processManagedEntitiesRefreshJob(
    job: AdminManagedEntitiesRefreshJob,
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    const user: AuthUser = {
      userId: job.userId,
      username: null,
      displayName: null,
      chatTitle: null,
    };

    return this.legacyAdminService.runManagedEntitiesBoundedRefreshForManagedEntities(
      user,
      job.entityType,
      {
        bypassRemoteCache: job.bypassRemoteCache,
        resetRefreshCursor: job.resetRefreshCursor,
      },
    );
  }

  async assertManagedEntityDiagnosticsAccess(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<void> {
    try {
      await this.assertManagedEntityAdminAccess(chatId, user, entityType);
      return;
    } catch (error: unknown) {
      const [hasPersistedAccess, diagnostics] = await Promise.all([
        this.hasPersistedManagedEntityAccess(chatId, user.userId, entityType),
        this.getManagedEntityAccessDiagnostics(chatId),
      ]);
      if (hasPersistedAccess && diagnostics.state === 'bot_access_lost') {
        return;
      }
      throw error;
    }
  }

  private async getManagedEntityBotExecutionPlan(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options: { refresh?: boolean } = {},
  ): Promise<ManagedEntityBotExecutionPlan> {
    await this.assertManagedEntityAdminAccess(chatId, user, entityType);

    return managedEntityBotExecutionPlanSchema.parse(
      await this.requireBotExecutionPlanner().getManagedEntityExecutionPlan({
        chatId,
        entityType,
        refreshCapabilities: options.refresh === true,
      }),
    );
  }

  private async updateManagedEntityPrimaryBot(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    await this.assertManagedEntityAdminAccess(chatId, user, entityType);

    const request = updateManagedEntityPrimaryBotRequestSchema.parse(body);
    const plan = await this.requireBotExecutionPlanner().setPrimaryBot({
      chatId,
      entityType,
      botId: request.botId,
    });
    await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    return managedEntityBotExecutionPlanSchema.parse(plan);
  }

  private async updateManagedEntityPartnerAssist(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    await this.assertManagedEntityAdminAccess(chatId, user, entityType);

    const request = updateManagedEntityPartnerAssistRequestSchema.parse(body);
    const plan = await this.requireBotExecutionPlanner().setPartnerAssist({
      chatId,
      entityType,
      botId: request.botId,
      enabled: request.enabled,
    });
    await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    return managedEntityBotExecutionPlanSchema.parse(plan);
  }

  private async promoteManagedEntityStandbyBot(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    body: unknown,
  ): Promise<ManagedEntityBotExecutionPlan> {
    await this.assertManagedEntityAdminAccess(chatId, user, entityType);

    const request = promoteManagedEntityStandbyRequestSchema.parse(body);
    const plan = await this.requireBotExecutionPlanner().promoteStandby({
      chatId,
      entityType,
      botId: request.botId ?? null,
    });
    await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    return managedEntityBotExecutionPlanSchema.parse(plan);
  }

  private assertManagedEntityAdminAccess(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<void> {
    return this.legacyAdminService.assertManagedEntityAdminAccess(
      chatId,
      user.userId,
      entityType,
    );
  }

  private async getManagedEntityAccessDiagnostics(
    chatId: string,
  ): Promise<ManagedEntityAccessDiagnostics> {
    const [membershipRows, accessEdgeRows, grantedAccessEdgeRows] = await Promise.all([
      this.prisma.chatBotMembership.findMany({
        where: {
          chatId,
          status: {
            in: [ChatBotMembershipStatus.ACTIVE, ChatBotMembershipStatus.REMOVED],
          },
        },
        select: {
          botId: true,
          status: true,
          permissionsSnapshot: true,
          botAccessState: true,
          botAccessCheckedAt: true,
          botAccessExpiresAt: true,
          botAccessSource: true,
          botAccessLastErrorCode: true,
          updatedAt: true,
        },
      }),
      this.prisma.managedEntityAccessEdge.findMany({
        where: {
          chatId,
          state: ManagedEntityAccessState.BOT_DENIED,
        },
        select: {
          botId: true,
          checkedAt: true,
          deniedReason: true,
          source: true,
          lastMaxErrorCode: true,
          lastMaxErrorMessage: true,
          lastMaxStatusCode: true,
        },
      }),
      this.prisma.managedEntityAccessEdge.findMany({
        where: {
          chatId,
          state: ManagedEntityAccessState.GRANTED,
          OR: [
            { expiresAt: { gt: new Date() } },
            {
              expiresAt: null,
              checkedAt: { gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS) },
            },
          ],
        },
        select: {
          botId: true,
        },
      }),
    ]);
    const activeAccessBotIds = this.resolveActiveManagedEntityBotIds(
      membershipRows,
      grantedAccessEdgeRows,
    );
    const freshness = this.resolveBotAccessFreshness(membershipRows);

    const diagnosticsByBotId = new Map<string, ManagedEntityAccessLossDiagnosticItem>();
    for (const row of membershipRows) {
      if (activeAccessBotIds.size > 0) {
        continue;
      }
      const botAccessLoss = this.readBotAccessLossDiagnostic(row);
      if (botAccessLoss) {
        this.upsertAccessLossDiagnostic(diagnosticsByBotId, botAccessLoss);
      }

      if (row.status !== ChatBotMembershipStatus.REMOVED) {
        continue;
      }
      const snapshot = this.readAccessLossSnapshot(row.permissionsSnapshot);
      if (!snapshot) {
        continue;
      }
      this.upsertAccessLossDiagnostic(diagnosticsByBotId, {
        botId: row.botId,
        botLabel: this.maxBotRegistry?.getBotById(row.botId)?.label ?? null,
        reason: snapshot.reason,
        detectedAt: snapshot.detectedAt ?? row.updatedAt.toISOString(),
        source: snapshot.source,
        lastMaxErrorCode: snapshot.lastMaxErrorCode,
        lastMaxErrorMessage: snapshot.lastMaxErrorMessage,
        lastMaxStatusCode: snapshot.lastMaxStatusCode,
      });
    }

    for (const row of accessEdgeRows) {
      if (activeAccessBotIds.size > 0) {
        continue;
      }
      const reason = this.readAccessLossReason(row.deniedReason);
      if (!reason || !this.hasTerminalAccessLossEvidence(row)) {
        continue;
      }
      this.upsertAccessLossDiagnostic(diagnosticsByBotId, {
        botId: row.botId,
        botLabel: this.maxBotRegistry?.getBotById(row.botId)?.label ?? null,
        reason,
        detectedAt: row.checkedAt.toISOString(),
        source: row.source || 'managed_entity_access_loss',
        lastMaxErrorCode: readTrimmedString(row.lastMaxErrorCode),
        lastMaxErrorMessage: readTrimmedString(row.lastMaxErrorMessage),
        lastMaxStatusCode:
          typeof row.lastMaxStatusCode === 'number' ? row.lastMaxStatusCode : null,
      });
    }

    const lostBots = [...diagnosticsByBotId.values()].sort((left, right) =>
      right.detectedAt.localeCompare(left.detectedAt),
    );

    return {
      state:
        lostBots.length > 0
          ? 'bot_access_lost'
          : freshness.activeBotCount > 0 && freshness.freshUntil && Date.parse(freshness.freshUntil) < Date.now()
            ? 'stale'
            : freshness.activeBotCount > 0 && !freshness.lastCheckedAt
              ? 'checking'
              : 'ok',
      lastDetectedAt: lostBots[0]?.detectedAt ?? null,
      lastCheckedAt: freshness.lastCheckedAt,
      freshUntil: freshness.freshUntil,
      source: freshness.source,
      activeBotCount: freshness.activeBotCount,
      lostBots,
    };
  }

  private async getManagedEntityViewerAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<ManagedEntityHeader['viewerAccess']> {
    const now = new Date();
    const freshWhere = {
      chatId,
      userId,
      entityType: toPrismaEntityType(entityType),
      OR: [
        { expiresAt: { gt: now } },
        {
          expiresAt: null,
          checkedAt: { gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS) },
        },
      ],
    };
    const grantedEdge = await this.prisma.managedEntityAccessEdge.findFirst({
      where: {
        ...freshWhere,
        state: ManagedEntityAccessState.GRANTED,
      },
      orderBy: { checkedAt: 'desc' },
      select: {
        checkedAt: true,
      },
    });
    if (grantedEdge) {
      return {
        state: 'granted',
        reason: null,
        checkedAt: grantedEdge.checkedAt.toISOString(),
        canEdit: true,
      };
    }

    const edge = await this.prisma.managedEntityAccessEdge.findFirst({
      where: freshWhere,
      orderBy: { checkedAt: 'desc' },
      select: {
        state: true,
        checkedAt: true,
        deniedReason: true,
      },
    });
    if (edge) {
      return {
        state: 'denied',
        reason:
          edge.state === ManagedEntityAccessState.BOT_DENIED
            ? 'bot_not_admin'
            : edge.deniedReason === 'bot_denied'
              ? 'bot_access_lost'
              : 'user_not_admin',
        checkedAt: edge.checkedAt.toISOString(),
        canEdit: false,
      };
    }

    const staleEdge = await this.prisma.managedEntityAccessEdge.findFirst({
      where: {
        chatId,
        userId,
        entityType: toPrismaEntityType(entityType),
        state: ManagedEntityAccessState.GRANTED,
      },
      orderBy: { checkedAt: 'desc' },
      select: {
        checkedAt: true,
      },
    });
    if (staleEdge) {
      return {
        state: 'stale',
        reason: 'unknown',
        checkedAt: staleEdge.checkedAt.toISOString(),
        canEdit: false,
      };
    }

    return {
      state: 'checking',
      reason: null,
      checkedAt: null,
      canEdit: false,
    };
  }

  private resolveBotAccessFreshness(
    membershipRows: Array<{
      botId: string;
      status: ChatBotMembershipStatus;
      permissionsSnapshot: unknown;
      botAccessState?: ChatBotAccessState | null;
      botAccessCheckedAt?: Date | null;
      botAccessExpiresAt?: Date | null;
      botAccessSource?: string | null;
    }>,
  ): {
    lastCheckedAt: string | null;
    freshUntil: string | null;
    source: ManagedEntityAccessDiagnostics['source'];
    activeBotCount: number;
  } {
    let lastCheckedAt: Date | null = null;
    let freshUntil: Date | null = null;
    let source: ManagedEntityAccessDiagnostics['source'] = 'unknown';
    let activeBotCount = 0;

    for (const row of membershipRows) {
      if (row.status !== ChatBotMembershipStatus.ACTIVE || !this.isRuntimeBotId(row.botId)) {
        continue;
      }
      activeBotCount += 1;
      const snapshot = normalizeMembershipAccessSnapshot(row.permissionsSnapshot);
      const checkedAt = row.botAccessCheckedAt ?? this.readSnapshotCheckedAt(row.permissionsSnapshot);
      const expiresAt = row.botAccessExpiresAt ?? null;
      const hasConfirmedAccess =
        row.botAccessState === ChatBotAccessState.CONFIRMED_ADMIN ||
        row.botAccessState === ChatBotAccessState.CONFIRMED_OWNER ||
        snapshot?.isAdmin === true ||
        snapshot?.isOwner === true;

      if (!hasConfirmedAccess || !checkedAt) {
        continue;
      }
      if (!lastCheckedAt || checkedAt > lastCheckedAt) {
        lastCheckedAt = checkedAt;
        source = 'membership_snapshot';
      }
      if (expiresAt && (!freshUntil || expiresAt > freshUntil)) {
        freshUntil = expiresAt;
      }
    }

    return {
      lastCheckedAt: lastCheckedAt?.toISOString() ?? null,
      freshUntil: freshUntil?.toISOString() ?? null,
      source,
      activeBotCount,
    };
  }

  private readSnapshotCheckedAt(value: unknown): Date | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const checkedAt = readTrimmedString((value as Record<string, unknown>).checkedAt);
    if (!checkedAt) {
      return null;
    }
    const checkedAtMs = Date.parse(checkedAt);
    return Number.isFinite(checkedAtMs) ? new Date(checkedAtMs) : null;
  }

  private resolveActiveManagedEntityBotIds(
    membershipRows: Array<{
      botId: string;
      status: ChatBotMembershipStatus;
      permissionsSnapshot: unknown;
      botAccessState?: ChatBotAccessState | null;
    }>,
    grantedAccessEdgeRows: Array<{ botId: string }>,
  ): Set<string> {
    const activeAccessBotIds = new Set<string>();
    for (const row of membershipRows) {
      if (row.status !== ChatBotMembershipStatus.ACTIVE) {
        continue;
      }
      if (!this.isRuntimeBotId(row.botId)) {
        continue;
      }
      if (
        row.botAccessState === ChatBotAccessState.CONFIRMED_ADMIN ||
        row.botAccessState === ChatBotAccessState.CONFIRMED_OWNER
      ) {
        activeAccessBotIds.add(row.botId);
        continue;
      }
      const snapshot = normalizeMembershipAccessSnapshot(row.permissionsSnapshot);
      if (!snapshot || (!snapshot.isAdmin && !snapshot.isOwner)) {
        continue;
      }
      activeAccessBotIds.add(row.botId);
    }

    for (const row of grantedAccessEdgeRows) {
      if (!this.isRuntimeBotId(row.botId)) {
        continue;
      }
      activeAccessBotIds.add(row.botId);
    }

    return activeAccessBotIds;
  }

  private readBotAccessLossDiagnostic(row: {
    botId: string;
    status: ChatBotMembershipStatus;
    botAccessState?: ChatBotAccessState | null;
    botAccessCheckedAt?: Date | null;
    botAccessSource?: string | null;
    botAccessLastErrorCode?: string | null;
    updatedAt?: Date | null;
  }): ManagedEntityAccessLossDiagnosticItem | null {
    if (row.status !== ChatBotMembershipStatus.ACTIVE) {
      return null;
    }
    if (
      row.botAccessState !== ChatBotAccessState.DENIED &&
      row.botAccessState !== ChatBotAccessState.LOST
    ) {
      return null;
    }

    const detectedAt = row.botAccessCheckedAt ?? row.updatedAt ?? null;
    if (!detectedAt) {
      return null;
    }

    return {
      botId: row.botId,
      botLabel: this.maxBotRegistry?.getBotById(row.botId)?.label ?? null,
      reason: row.botAccessState === ChatBotAccessState.LOST ? 'chat_inaccessible' : 'bot_denied',
      detectedAt: detectedAt.toISOString(),
      source: readTrimmedString(row.botAccessSource) ?? 'membership_snapshot',
      lastMaxErrorCode: readTrimmedString(row.botAccessLastErrorCode),
      lastMaxErrorMessage: null,
      lastMaxStatusCode: null,
    };
  }

  private upsertAccessLossDiagnostic(
    diagnosticsByBotId: Map<string, ManagedEntityAccessLossDiagnosticItem>,
    item: ManagedEntityAccessLossDiagnosticItem,
  ): void {
    const current = diagnosticsByBotId.get(item.botId);
    if (!current || item.detectedAt > current.detectedAt) {
      diagnosticsByBotId.set(item.botId, item);
    }
  }

  private readAccessLossSnapshot(value: unknown): AccessLossSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const reason = this.readAccessLossReason(row.accessLostReason);
    const source = readTrimmedString(row.accessLostSource);
    const detectedAt = readTrimmedString(row.accessLostAt);
    if (!reason || !source) {
      return null;
    }

    return {
      reason,
      detectedAt: detectedAt && !Number.isNaN(Date.parse(detectedAt)) ? detectedAt : null,
      source,
      lastMaxErrorCode: readTrimmedString(row.lastMaxErrorCode),
      lastMaxErrorMessage: readTrimmedString(row.lastMaxErrorMessage),
      lastMaxStatusCode:
        typeof row.lastMaxStatusCode === 'number' && Number.isFinite(row.lastMaxStatusCode)
          ? row.lastMaxStatusCode
          : null,
    };
  }

  private hasTerminalAccessLossEvidence(row: {
    source: string;
    lastMaxErrorCode: string | null;
    lastMaxErrorMessage: string | null;
    lastMaxStatusCode: number | null;
  }): boolean {
    return (
      row.source.startsWith('night_mode_transition:') ||
      row.source === 'managed_broadcast:delivery' ||
      row.source === 'vk_parsing:publish' ||
      readTrimmedString(row.lastMaxErrorCode) !== null ||
      readTrimmedString(row.lastMaxErrorMessage) !== null ||
      row.lastMaxStatusCode === 403 ||
      row.lastMaxStatusCode === 404
    );
  }

  private readAccessLossReason(value: unknown): ManagedEntityAccessLossReason | null {
    const normalized = readTrimmedString(value);
    return normalized &&
      MANAGED_ENTITY_ACCESS_LOSS_REASONS.has(normalized as ManagedEntityAccessLossReason)
      ? (normalized as ManagedEntityAccessLossReason)
      : null;
  }

  private isRuntimeBotId(botId: string | null | undefined): boolean {
    const normalizedBotId = this.maxBotRegistry?.getBotById(botId)?.id ?? readTrimmedString(botId);
    if (!normalizedBotId) {
      return false;
    }
    return this.maxBotRegistry ? this.maxBotRegistry.getBotById(normalizedBotId) !== null : true;
  }

  private async hasPersistedManagedEntityAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<boolean> {
    const now = new Date();
    const adminMember = await this.prisma.managedEntityAdminMember.findFirst({
      where: {
        chatId,
        userId,
        entityType: toPrismaEntityType(entityType),
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        chat: {
          catalogKind: 'MANAGED',
          entityType: toPrismaEntityType(entityType),
        },
      },
      select: {
        chatId: true,
      },
      take: 1,
    });
    if (adminMember) {
      return true;
    }

    const legacyRows = await this.prisma.chatAdminAllowlist.findMany({
      where: {
        chatId,
        userId,
        chat: {
          entityType: toPrismaEntityType(entityType),
          OR: [{ catalogKind: 'MANAGED' }, { catalogKind: 'UNKNOWN' }],
        },
      },
      select: {
        chatId: true,
      },
      take: 1,
    });
    return legacyRows.length > 0;
  }

  private requireBotExecutionPlanner(): MaxBotExecutionPlannerService {
    if (!this.maxBotExecutionPlanner) {
      throw new ServiceUnavailableException(
        'Bot execution planner is not available on this runtime.',
      );
    }

    return this.maxBotExecutionPlanner;
  }
}
