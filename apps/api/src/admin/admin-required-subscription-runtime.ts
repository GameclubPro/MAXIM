import { BadRequestException, ServiceUnavailableException, type Logger } from '@nestjs/common';
import type { ChatSettings, ManagedEntityHeader, ManagedEntityType } from '@maxim/contracts';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  MAX_API_SOURCE_TAGS,
  type MaxBotChat,
  type MaxClientService,
} from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  fromPrismaEntityType,
  isBotAdminLookupDeniedError,
  mapWithConcurrencyLimit,
} from './admin-legacy-utils';
import type {
  AdminRequiredSubscriptionRuntimeContext,
  CreateRequiredSubscriptionManagedEntityHeaderParams,
  ResolveRequiredSubscriptionCandidateBotIdsOptions,
} from './admin-required-subscription-runtime-context';
import { resolveRequiredSubscriptionChannelByKnownLink } from './admin-required-subscription-catalog';
import {
  ADMIN_ACTION_HEALTH_LANE,
  REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
  type ManagedBotChatCatalogSnapshotRow,
  type ManagedEntitiesDiscoverySnapshot,
  mapManagedEntityTypeToChatEntityType,
} from './admin.service.support';
import { sanitizePublicManagedEntityHeader } from './admin-managed-entity-header';

export class AdminRequiredSubscriptionRuntime {
  constructor(private readonly context: AdminRequiredSubscriptionRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get maxClient(): MaxClientService {
    return this.context.maxClient;
  }

  private get chatContextCache(): ChatContextCacheService {
    return this.context.chatContextCache;
  }

  private get logger(): Logger {
    return this.context.logger;
  }

  private get maxBotLinkService(): MaxBotLinkService | undefined {
    return this.context.maxBotLinkService;
  }

  private get maxBotRegistry(): MaxBotRegistryService | undefined {
    return this.context.maxBotRegistry;
  }

  private createManagedEntityHeader(
    params: CreateRequiredSubscriptionManagedEntityHeaderParams,
  ): ManagedEntityHeader {
    return this.context.createManagedEntityHeader(params);
  }

  private mergeManagedBotChatCatalogRows(
    rows: readonly ManagedBotChatCatalogSnapshotRow[],
  ): ManagedEntitiesDiscoverySnapshot {
    return this.context.mergeManagedBotChatCatalogRows(rows);
  }

  private resolveBotAssignment(chatId: string): Promise<string | undefined> {
    return this.context.resolveBotAssignment(chatId);
  }

  private resolveCandidateBotIdsForChat(
    chatId: string,
    options?: ResolveRequiredSubscriptionCandidateBotIdsOptions,
  ): Promise<string[]> {
    return this.context.resolveCandidateBotIdsForChat(chatId, options);
  }

  private refreshManagedEntityBotAccessSnapshots(
    chatId: string,
    entityType: ManagedEntityType,
    reason: string,
  ): Promise<void> {
    return this.context.refreshManagedEntityBotAccessSnapshots(chatId, entityType, reason);
  }

  async resolveRequiredSubscriptionChannelHeaders(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]> {
    const normalizedChannelIds = Array.from(
      new Set(
        channelIds
          .map((value) => value.trim())
          .filter((value): value is string => value.length > 0),
      ),
    );
    const channels = await mapWithConcurrencyLimit(
      normalizedChannelIds,
      REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
      async (channelId) => {
        try {
          return await this.resolveRequiredSubscriptionChannelById(channelId);
        } catch (error: unknown) {
          this.logger.warn(
            {
              channelId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to resolve required subscription entity for settings screen',
          );
          return null;
        }
      },
    );

    return channels.filter((channel): channel is ManagedEntityHeader => channel !== null);
  }

  async resolveRequiredSubscriptionChannelReference(value: string): Promise<ManagedEntityHeader> {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      throw new BadRequestException(
        'Укажите публичную ссылку, ссылку на чат/пост MAX или ID чата/канала.',
      );
    }

    const extractedChatId = this.extractRequiredSubscriptionChannelIdFromValue(normalizedValue);
    if (extractedChatId) {
      return this.resolveRequiredSubscriptionChannelById(extractedChatId);
    }

    const normalizedLink = this.normalizeRequiredSubscriptionChannelLink(normalizedValue);
    if (normalizedLink) {
      const channel = await this.resolveRequiredSubscriptionChannelByLink(normalizedLink);
      return this.resolveRequiredSubscriptionChannelById(channel.chatId, {
        preferredBotId: channel.botId ?? null,
        observedBotIds: channel.botIds ?? [],
      });
    }

    return this.resolveRequiredSubscriptionChannelById(normalizedValue);
  }

  buildRequiredSubscriptionChannelUrlCandidates(value: string | null | undefined): string[] {
    if (typeof value !== 'string') {
      return [];
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    const candidates = [trimmed];
    if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
      if (trimmed.startsWith('/')) {
        candidates.unshift(`https://max.ru${trimmed}`);
      } else if (trimmed.startsWith('max.ru/') || trimmed.startsWith('www.max.ru/')) {
        candidates.unshift(`https://${trimmed}`);
      } else if (trimmed.includes('/') && !/\s/u.test(trimmed)) {
        candidates.unshift(`https://max.ru/${trimmed.replace(/^\/+/u, '')}`);
      }
    }

    return Array.from(new Set(candidates));
  }

  extractRequiredSubscriptionChannelIdFromValue(value: string | null | undefined): string | null {
    for (const candidate of this.buildRequiredSubscriptionChannelUrlCandidates(value)) {
      try {
        const parsed = new URL(candidate);
        const hostname = parsed.hostname.trim().toLowerCase();
        if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
          continue;
        }

        const pathSegments = parsed.pathname
          .split('/')
          .map((segment) => segment.trim())
          .filter(Boolean);
        const rootSegment = pathSegments[0]?.toLowerCase();
        if (rootSegment !== 'chats' && rootSegment !== 'c' && rootSegment !== 'chat') {
          continue;
        }

        const chatId = decodeURIComponent(pathSegments[1] ?? '').trim();
        if (chatId) {
          return chatId;
        }
      } catch {
        // Ignore invalid candidate and try the next one.
      }
    }

    return null;
  }

  async resolveRequiredSubscriptionChannelByLink(link: string): Promise<MaxBotChat> {
    const normalizedLink = this.normalizeRequiredSubscriptionChannelLink(link);
    if (!normalizedLink) {
      throw new BadRequestException('Укажите корректную ссылку чата или канала MAX.');
    }

    let locallyKnownChannel: MaxBotChat | null = null;
    try {
      locallyKnownChannel = await resolveRequiredSubscriptionChannelByKnownLink({
        normalizedLink,
        catalog: this.prisma.managedBotChatCatalog,
        normalizeLink: (value) => this.normalizeRequiredSubscriptionChannelLink(value),
        mergeCatalogRows: (rows) => this.mergeManagedBotChatCatalogRows(rows),
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          link: normalizedLink,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve required subscription entity by local catalog link',
      );
      throw new ServiceUnavailableException(
        'Не удалось проверить сохраненную ссылку чата или канала. Повторите попытку.',
      );
    }

    if (locallyKnownChannel) {
      return locallyKnownChannel;
    }

    const channelLink = this.extractRequiredSubscriptionPublicChannelLink(normalizedLink);
    if (channelLink && typeof this.maxClient.getChannelSnapshotByLink === 'function') {
      try {
        const snapshot = await this.maxClient.getChannelSnapshotByLink(channelLink, {
          trafficClass: 'interactive',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
        });
        return {
          chatId: snapshot.chatId,
          title: snapshot.title,
          entityType: snapshot.entityType,
          link: snapshot.link ?? normalizedLink,
          avatarUrl: snapshot.avatarUrl,
          lastEventTime: snapshot.lastEventAt ? Date.parse(snapshot.lastEventAt) : null,
        };
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          throw new BadRequestException(
            'Чат или канал по этой ссылке не найден. Проверьте ссылку и убедитесь, что бот состоит там администратором.',
          );
        }
        this.logger.warn(
          {
            link: normalizedLink,
            channelLink,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve required subscription channel by targeted public link lookup',
        );
        throw new ServiceUnavailableException(
          'Не удалось проверить публичную ссылку канала MAX. Повторите попытку.',
        );
      }
    }

    throw new BadRequestException(
      'Чат или канал по этой ссылке не найден. Проверьте ссылку и убедитесь, что бот состоит там администратором.',
    );
  }

  extractRequiredSubscriptionPublicChannelLink(normalizedLink: string): string | null {
    try {
      const parsed = new URL(normalizedLink);
      const hostname = parsed.hostname.trim().toLowerCase();
      if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
        return null;
      }

      const pathSegments = parsed.pathname
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (pathSegments.length !== 1) {
        return null;
      }

      const slug = pathSegments[0];
      const reservedSegments = new Set(['chat', 'chats', 'c', 'join']);
      if (reservedSegments.has(slug.toLowerCase())) {
        return null;
      }

      return slug;
    } catch {
      return null;
    }
  }

  async resolveRequiredSubscriptionChannelById(
    chatId: string,
    options: {
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
    } = {},
  ): Promise<ManagedEntityHeader> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      throw new BadRequestException('Укажите корректный ID чата или канала.');
    }

    const resolvedBotId =
      this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ??
      (await this.resolveBotAssignment(normalizedChatId)) ??
      null;
    const verifiedBotId =
      (await this.assertBotCanInspectRequiredSubscriptionChannel(normalizedChatId, {
        preferredBotId: resolvedBotId,
        observedBotIds: options.observedBotIds ?? [],
      })) ?? resolvedBotId;
    let snapshot;
    try {
      snapshot = verifiedBotId
        ? await this.maxClient.getChatSnapshot(normalizedChatId, {
            botId: verifiedBotId,
            actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
            sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
          })
        : await this.maxClient.getChatSnapshot(normalizedChatId, {
            actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
            sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
          });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: normalizedChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load required subscription entity snapshot',
      );
      throw new BadRequestException(
        'Чат или канал не найден в MAX или бот не имеет к нему доступа.',
      );
    }

    const link = snapshot.link?.trim() || null;
    const entityType = snapshot.entityType;
    const prismaEntityType = mapManagedEntityTypeToChatEntityType(entityType);

    const header = this.createManagedEntityHeader({
      id: normalizedChatId,
      title: snapshot.title?.trim() || normalizedChatId,
      entityType,
      link,
      participantsCount: snapshot.participantsCount,
      avatarUrl: snapshot.avatarUrl,
      primaryBotId: verifiedBotId,
    });

    try {
      await this.prisma.chat.upsert({
        where: { id: normalizedChatId },
        create: {
          id: normalizedChatId,
          title: header.title,
          entityType: prismaEntityType,
          ...(verifiedBotId ? { botId: verifiedBotId, primaryBotId: verifiedBotId } : {}),
        },
        update: {
          title: header.title,
          entityType: prismaEntityType,
          ...(verifiedBotId ? { botId: verifiedBotId, primaryBotId: verifiedBotId } : {}),
        },
      });
      await this.maxBotLinkService?.bindDiscoveredChatBots?.({
        chatId: normalizedChatId,
        primaryBotId: verifiedBotId,
        botIds:
          verifiedBotId || (options.observedBotIds?.length ?? 0) > 0
            ? [verifiedBotId, ...(options.observedBotIds ?? [])].filter(
                (botId): botId is string => typeof botId === 'string' && botId.trim().length > 0,
              )
            : [],
        title: header.title,
        entityType: prismaEntityType,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: normalizedChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist resolved required subscription entity title',
      );
    }

    await this.chatContextCache.setManagedEntityHeader?.(header);
    return sanitizePublicManagedEntityHeader(header);
  }

  async assertBotCanInspectRequiredSubscriptionChannel(
    chatId: string,
    options: {
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
    } = {},
  ): Promise<string | null> {
    const candidateBotIds = Array.from(
      new Set(
        [
          this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ?? null,
          ...((options.observedBotIds ?? []).map(
            (botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null,
          ) as Array<string | null>),
          ...(await this.resolveCandidateBotIdsForChat(chatId, {
            includeDiscoveryFallback: true,
          })),
        ].filter((botId): botId is string => Boolean(botId)),
      ),
    );

    let serviceFailure: unknown = null;
    for (const botId of candidateBotIds) {
      try {
        const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
          trafficClass: 'interactive',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
          botId,
        });
        if (access.isAdmin || access.isOwner) {
          return botId;
        }
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          continue;
        }
        serviceFailure = serviceFailure ?? error;
      }
    }

    if (candidateBotIds.length === 0) {
      try {
        const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
          trafficClass: 'interactive',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
        });
        if (access.isAdmin || access.isOwner) {
          return this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ?? null;
        }
      } catch (error: unknown) {
        if (!isBotAdminLookupDeniedError(error)) {
          serviceFailure = serviceFailure ?? error;
        }
      }
    }

    if (!serviceFailure) {
      throw new BadRequestException(
        'Бот должен быть администратором этого чата или канала, чтобы проверять подписку.',
      );
    }

    this.logger.warn(
      {
        chatId,
        err: serviceFailure instanceof Error ? serviceFailure.message : String(serviceFailure),
      },
      'Failed to verify bot admin access for required subscription entity',
    );
    throw new ServiceUnavailableException(
      'Не удалось проверить права бота в чате или канале MAX. Повторите попытку.',
    );
  }

  normalizeRequiredSubscriptionChannelLink(value: string | null | undefined): string | null {
    for (const candidate of this.buildRequiredSubscriptionChannelUrlCandidates(value)) {
      try {
        const parsed = new URL(candidate);
        const hostname = parsed.hostname.trim().toLowerCase();
        if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
          continue;
        }

        let pathname = parsed.pathname.replace(/\/+$/u, '');
        if (!pathname) {
          continue;
        }

        const pathSegments = pathname
          .split('/')
          .map((segment) => segment.trim())
          .filter(Boolean);
        const rootSegment = pathSegments[0]?.toLowerCase();
        if ((rootSegment === 'channel' || rootSegment === 'channels') && pathSegments[1]) {
          pathname = `/${pathSegments[1]}`;
        } else if (
          pathSegments.length === 1 &&
          rootSegment !== 'chat' &&
          rootSegment !== 'chats' &&
          rootSegment !== 'c' &&
          rootSegment !== 'join'
        ) {
          pathname = `/${pathSegments[0]}`;
        }

        parsed.search = '';
        parsed.hash = '';

        return `https://max.ru${pathname}`;
      } catch {
        // Ignore invalid candidate and try the next one.
      }
    }

    return null;
  }

  async assertRequiredSubscriptionSettings(settings: ChatSettings): Promise<ChatSettings> {
    if (!settings.requiredSubscriptionEnabled) {
      return settings;
    }

    const selectedChannelIds = settings.requiredSubscriptionChannelIds;
    if (selectedChannelIds.length === 0) {
      return {
        ...settings,
        requiredSubscriptionEnabled: false,
        requiredSubscriptionChannelIds: [],
      };
    }

    const validChannelIds = (
      await mapWithConcurrencyLimit(
        selectedChannelIds,
        REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
        async (channelId) => {
          try {
            await this.resolveRequiredSubscriptionChannelById(channelId);
            return channelId;
          } catch (error: unknown) {
            this.logger.warn(
              {
                channelId,
                err: error instanceof Error ? error.message : String(error),
              },
              'Dropped required subscription entity because the bot cannot verify membership',
            );
            return null;
          }
        },
      )
    ).filter((channelId): channelId is string => channelId !== null);

    return {
      ...settings,
      requiredSubscriptionEnabled: validChannelIds.length > 0,
      requiredSubscriptionChannelIds: validChannelIds,
    };
  }

  async resolveRequiredSubscriptionEntityType(chatId: string): Promise<ManagedEntityType> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return 'channel';
    }

    const cachedChannelHeader = await this.chatContextCache.getManagedEntityHeader?.(
      normalizedChatId,
      'channel',
    );
    if (cachedChannelHeader) {
      return 'channel';
    }

    const cachedChatHeader = await this.chatContextCache.getManagedEntityHeader?.(
      normalizedChatId,
      'chat',
    );
    if (cachedChatHeader) {
      return 'chat';
    }

    try {
      const resolved = await this.resolveRequiredSubscriptionChannelById(normalizedChatId);
      return resolved.entityType;
    } catch {
      const persisted = await this.prisma.chat.findUnique({
        where: { id: normalizedChatId },
        select: {
          entityType: true,
        },
      });
      if (persisted?.entityType) {
        return fromPrismaEntityType(persisted.entityType);
      }
    }

    return 'channel';
  }

  async refreshRequiredSubscriptionAccessSnapshots(
    entityIds: readonly string[],
    reason: string,
  ): Promise<void> {
    const normalizedEntityIds = Array.from(
      new Set(
        entityIds.map((entityId) => entityId.trim()).filter((entityId) => entityId.length > 0),
      ),
    );
    await mapWithConcurrencyLimit(
      normalizedEntityIds,
      REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
      async (entityId) => {
        await this.refreshManagedEntityBotAccessSnapshots(
          entityId,
          await this.resolveRequiredSubscriptionEntityType(entityId),
          reason,
        );
      },
    );
  }
}
