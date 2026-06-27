import type { Logger } from '@nestjs/common';
import type {
  ChatSummary,
  ManagedEntitiesRefreshState,
  ManagedEntitiesResponseDiff,
  ManagedEntityType,
} from '@maxim/contracts';

import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  AssertChatAdminOptions,
  ManagedEntitiesListOptions,
  ManagedEntitiesListResult,
  ManagedEntitiesRefreshJobOutcome,
  ManagedEntitiesRefreshPresentation,
  ManagedEntityTypeFilter,
} from './admin.service.support';

export type ManagedEntitiesRefreshRunOptions = {
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
};

export type AdminManagedEntitiesRuntimeContext = {
  readonly prisma: PrismaService;
  readonly chatContextCache: ChatContextCacheService;
  readonly maxClient: MaxClientService;
  readonly logger: Logger;
  readonly maxBotRegistry?: MaxBotRegistryService;
  assertChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: AssertChatAdminOptions,
  ): Promise<void>;
  assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: {
      forceRemote?: boolean;
      timeoutMs?: number;
    },
  ): Promise<void>;
  attachManagedEntityFavoriteTypes(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]>;
  attachManagedEntityFavoriteTypesToDiff(
    userId: string,
    diff: ManagedEntitiesResponseDiff | null | undefined,
  ): Promise<ManagedEntitiesResponseDiff | null | undefined>;
  collectManagedEntitiesForMassAction(
    user: AuthUser,
    entityType: ManagedEntityType,
    options?: {
      discoveryMode?: 'full' | 'cached-first';
    },
  ): Promise<ChatSummary[]>;
  createManagedEntitiesRefreshState(
    cursor: number | null,
    backoffActive: boolean,
    nextPollAfterMsOverride?: number,
    presentation?: ManagedEntitiesRefreshPresentation,
  ): ManagedEntitiesRefreshState;
  ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void>;
  isManagedEntityRuntimeBotId(botId: string | null | undefined): boolean;
  listManagedEntitiesDetailed(
    user: AuthUser,
    entityType?: ManagedEntityTypeFilter,
    options?: ManagedEntitiesListOptions,
  ): Promise<ManagedEntitiesListResult>;
  readTrimmedString(value: unknown): string | null;
  resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined>;
  runManagedEntitiesBoundedRefreshJob(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options?: ManagedEntitiesRefreshRunOptions,
  ): Promise<ManagedEntitiesRefreshJobOutcome>;
  runManagedEntitiesRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options?: ManagedEntitiesRefreshRunOptions,
  ): Promise<ManagedEntitiesRefreshJobOutcome>;
};

type AdminManagedEntitiesRuntimeContextTarget = AdminManagedEntitiesRuntimeContext;

export function createAdminManagedEntitiesRuntimeContext(
  target: object,
): AdminManagedEntitiesRuntimeContext {
  const typedTarget = target as AdminManagedEntitiesRuntimeContextTarget;

  return {
    get prisma(): PrismaService {
      return typedTarget.prisma;
    },
    get chatContextCache(): ChatContextCacheService {
      return typedTarget.chatContextCache;
    },
    get maxClient(): MaxClientService {
      return typedTarget.maxClient;
    },
    get logger(): Logger {
      return typedTarget.logger;
    },
    get maxBotRegistry(): MaxBotRegistryService | undefined {
      return typedTarget.maxBotRegistry;
    },
    assertChatAdmin(
      chatId: string,
      userId: string,
      entityType?: ManagedEntityType | null,
      options?: AssertChatAdminOptions,
    ): Promise<void> {
      return typedTarget.assertChatAdmin(chatId, userId, entityType, options);
    },
    assertReadOnlyChatAdmin(
      chatId: string,
      userId: string,
      entityType?: ManagedEntityType | null,
      options?: {
        forceRemote?: boolean;
        timeoutMs?: number;
      },
    ): Promise<void> {
      return typedTarget.assertReadOnlyChatAdmin(chatId, userId, entityType, options);
    },
    attachManagedEntityFavoriteTypes(
      userId: string,
      items: readonly ChatSummary[],
    ): Promise<ChatSummary[]> {
      return typedTarget.attachManagedEntityFavoriteTypes(userId, items);
    },
    attachManagedEntityFavoriteTypesToDiff(
      userId: string,
      diff: ManagedEntitiesResponseDiff | null | undefined,
    ): Promise<ManagedEntitiesResponseDiff | null | undefined> {
      return typedTarget.attachManagedEntityFavoriteTypesToDiff(userId, diff);
    },
    collectManagedEntitiesForMassAction(
      user: AuthUser,
      entityType: ManagedEntityType,
      options?: {
        discoveryMode?: 'full' | 'cached-first';
      },
    ): Promise<ChatSummary[]> {
      return typedTarget.collectManagedEntitiesForMassAction(user, entityType, options);
    },
    createManagedEntitiesRefreshState(
      cursor: number | null,
      backoffActive: boolean,
      nextPollAfterMsOverride?: number,
      presentation?: ManagedEntitiesRefreshPresentation,
    ): ManagedEntitiesRefreshState {
      return typedTarget.createManagedEntitiesRefreshState(
        cursor,
        backoffActive,
        nextPollAfterMsOverride,
        presentation,
      );
    },
    ensureEntityType(
      chatId: string,
      userId: string,
      expectedEntityType: ManagedEntityType,
    ): Promise<void> {
      return typedTarget.ensureEntityType(chatId, userId, expectedEntityType);
    },
    isManagedEntityRuntimeBotId(botId: string | null | undefined): boolean {
      return typedTarget.isManagedEntityRuntimeBotId(botId);
    },
    listManagedEntitiesDetailed(
      user: AuthUser,
      entityType?: ManagedEntityTypeFilter,
      options?: ManagedEntitiesListOptions,
    ): Promise<ManagedEntitiesListResult> {
      return typedTarget.listManagedEntitiesDetailed(user, entityType, options);
    },
    readTrimmedString(value: unknown): string | null {
      return typedTarget.readTrimmedString(value);
    },
    resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined> {
      return typedTarget.resolveBackgroundReadBotAssignment(chatId);
    },
    runManagedEntitiesBoundedRefreshJob(
      user: AuthUser,
      entityType: ManagedEntityTypeFilter,
      options?: ManagedEntitiesRefreshRunOptions,
    ): Promise<ManagedEntitiesRefreshJobOutcome> {
      return typedTarget.runManagedEntitiesBoundedRefreshJob(user, entityType, options);
    },
    runManagedEntitiesRemoteFullRefresh(
      user: AuthUser,
      entityType: ManagedEntityTypeFilter,
      options?: ManagedEntitiesRefreshRunOptions,
    ): Promise<ManagedEntitiesRefreshJobOutcome> {
      return typedTarget.runManagedEntitiesRemoteFullRefresh(user, entityType, options);
    },
  };
}
