import {
  managedEntityFavoritesResponseSchema,
  managedEntityTypeSchema,
  managedEntityBotExecutionPlanSchema,
  promoteManagedEntityStandbyRequestSchema,
  updateManagedEntityFavoritesRequestSchema,
  updateManagedEntityPartnerAssistRequestSchema,
  updateManagedEntityPrimaryBotRequestSchema,
  type ChatSummary,
  type Me,
  type ManagedEntityBotExecutionPlan,
  type ManagedEntityFavoriteType,
  type ManagedEntityFavoritesResponse,
  type ManagedEntityHeader,
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
import { MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
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
  MANAGED_ENTITY_FAVORITE_TYPE_ORDER,
  PRISMA_FAVORITE_TYPE_BY_CONTRACT,
  type AdminReadBypassOptions,
  type ManagedEntitiesListOptions,
  type ManagedEntitiesRefreshJobOutcome,
} from './admin.service.support';
import { AdminService } from './admin.service';

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
    return getManagedEntityHeaderValue({
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

    return this.legacyAdminService.runManagedEntitiesRemoteFullRefreshForManagedEntities(
      user,
      job.entityType,
      {
        bypassRemoteCache: job.bypassRemoteCache,
        resetRefreshCursor: job.resetRefreshCursor,
      },
    );
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
    return this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
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
