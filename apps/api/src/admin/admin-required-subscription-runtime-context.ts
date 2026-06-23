import type { Logger } from '@nestjs/common';
import type { ManagedEntityHeader, ManagedEntityType } from '@maxim/contracts';

import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { MaxBotChat } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';
import type {
  ManagedBotChatCatalogSnapshotRow,
  ManagedEntitiesDiscoverySnapshot,
} from './admin.service.support';

export type CreateRequiredSubscriptionManagedEntityHeaderParams = {
  id: string;
  title: string;
  entityType: ManagedEntityType;
  link?: string | null;
  participantsCount?: number | null;
  avatarUrl?: string | null;
  primaryBotId?: string | null;
  assignedBots?: ManagedEntityHeader['assignedBots'];
  sharedMode?: ManagedEntityHeader['sharedMode'];
};

export type ResolveRequiredSubscriptionCandidateBotIdsOptions = {
  includeDiscoveryFallback?: boolean;
};

export type AdminRequiredSubscriptionRuntimeContext = {
  readonly prisma: PrismaService;
  readonly maxClient: MaxClientService;
  readonly chatContextCache: ChatContextCacheService;
  readonly logger: Logger;
  readonly maxBotLinkService?: MaxBotLinkService;
  readonly maxBotRegistry?: MaxBotRegistryService;
  createManagedEntityHeader(
    params: CreateRequiredSubscriptionManagedEntityHeaderParams,
  ): ManagedEntityHeader;
  mergeManagedBotChatCatalogRows(
    rows: readonly ManagedBotChatCatalogSnapshotRow[],
  ): ManagedEntitiesDiscoverySnapshot;
  resolveBotAssignment(chatId: string): Promise<string | undefined>;
  resolveCandidateBotIdsForChat(
    chatId: string,
    options?: ResolveRequiredSubscriptionCandidateBotIdsOptions,
  ): Promise<string[]>;
  refreshManagedEntityBotAccessSnapshots(
    chatId: string,
    entityType: ManagedEntityType,
    reason: string,
  ): Promise<void>;
};

type AdminRequiredSubscriptionRuntimeContextTarget = {
  prisma: PrismaService;
  maxClient: MaxClientService;
  chatContextCache: ChatContextCacheService;
  logger: Logger;
  maxBotLinkService?: MaxBotLinkService;
  maxBotRegistry?: MaxBotRegistryService;
  createManagedEntityHeader(
    params: CreateRequiredSubscriptionManagedEntityHeaderParams,
  ): ManagedEntityHeader;
  mergeManagedBotChatCatalogRows(
    rows: readonly ManagedBotChatCatalogSnapshotRow[],
  ): MaxBotChat[];
  resolveBotAssignment(chatId: string): Promise<string | undefined>;
  resolveCandidateBotIdsForChat(
    chatId: string,
    options?: ResolveRequiredSubscriptionCandidateBotIdsOptions,
  ): Promise<string[]>;
  refreshManagedEntityBotAccessSnapshots(
    chatId: string,
    entityType: ManagedEntityType,
    reason: string,
  ): Promise<void>;
};

export function createAdminRequiredSubscriptionRuntimeContext(
  target: object,
): AdminRequiredSubscriptionRuntimeContext {
  const typedTarget = target as AdminRequiredSubscriptionRuntimeContextTarget;

  return {
    get prisma(): PrismaService {
      return typedTarget.prisma;
    },
    get maxClient(): MaxClientService {
      return typedTarget.maxClient;
    },
    get chatContextCache(): ChatContextCacheService {
      return typedTarget.chatContextCache;
    },
    get logger(): Logger {
      return typedTarget.logger;
    },
    get maxBotLinkService(): MaxBotLinkService | undefined {
      return typedTarget.maxBotLinkService;
    },
    get maxBotRegistry(): MaxBotRegistryService | undefined {
      return typedTarget.maxBotRegistry;
    },
    createManagedEntityHeader(
      params: CreateRequiredSubscriptionManagedEntityHeaderParams,
    ): ManagedEntityHeader {
      return typedTarget.createManagedEntityHeader(params);
    },
    mergeManagedBotChatCatalogRows(
      rows: readonly ManagedBotChatCatalogSnapshotRow[],
    ): ManagedEntitiesDiscoverySnapshot {
      return typedTarget.mergeManagedBotChatCatalogRows(rows);
    },
    resolveBotAssignment(chatId: string): Promise<string | undefined> {
      return typedTarget.resolveBotAssignment(chatId);
    },
    resolveCandidateBotIdsForChat(
      chatId: string,
      options?: ResolveRequiredSubscriptionCandidateBotIdsOptions,
    ): Promise<string[]> {
      return typedTarget.resolveCandidateBotIdsForChat(chatId, options);
    },
    refreshManagedEntityBotAccessSnapshots(
      chatId: string,
      entityType: ManagedEntityType,
      reason: string,
    ): Promise<void> {
      return typedTarget.refreshManagedEntityBotAccessSnapshots(chatId, entityType, reason);
    },
  };
}
