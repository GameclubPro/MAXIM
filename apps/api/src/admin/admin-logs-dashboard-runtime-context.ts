import type { Logger } from '@nestjs/common';
import type {
  LogsDashboardResponse,
  ManagedEntityType,
  MembershipActivityPage,
  ModerationFeedPage,
} from '@maxim/contracts';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  AssertChatAdminOptions,
  ResolvedUserProfile,
  ResolveUserProfilesOptions,
  TimedPromiseCacheEntry,
} from './admin.service.support';

export type AdminLogsDashboardRuntimeContext = {
  readonly prisma: PrismaService;
  readonly logger: Logger;
  readonly chatContextCache: ChatContextCacheService;
  readonly logsDashboardResponseCache: Map<string, TimedPromiseCacheEntry<LogsDashboardResponse>>;
  readonly moderationFeedPageCache: Map<string, TimedPromiseCacheEntry<ModerationFeedPage>>;
  readonly membershipActivityFeedPageCache: Map<
    string,
    TimedPromiseCacheEntry<MembershipActivityPage>
  >;
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
  buildProfileMentionHandoffUrl(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    displayName: string | null,
  ): string | null;
  ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void>;
  readTrimmedString(value: unknown): string | null;
  resolveUserProfiles(
    chatId: string,
    entityType: ManagedEntityType,
    userIds: readonly string[],
    options?: ResolveUserProfilesOptions,
  ): Promise<Map<string, ResolvedUserProfile>>;
  toIsoString(value: unknown): string | null;
};

type AdminLogsDashboardRuntimeContextTarget = AdminLogsDashboardRuntimeContext;

export function createAdminLogsDashboardRuntimeContext(
  target: object,
): AdminLogsDashboardRuntimeContext {
  const typedTarget = target as AdminLogsDashboardRuntimeContextTarget;

  return {
    get prisma(): PrismaService {
      return typedTarget.prisma;
    },
    get logger(): Logger {
      return typedTarget.logger;
    },
    get chatContextCache(): ChatContextCacheService {
      return typedTarget.chatContextCache;
    },
    get logsDashboardResponseCache(): Map<string, TimedPromiseCacheEntry<LogsDashboardResponse>> {
      return typedTarget.logsDashboardResponseCache;
    },
    get moderationFeedPageCache(): Map<string, TimedPromiseCacheEntry<ModerationFeedPage>> {
      return typedTarget.moderationFeedPageCache;
    },
    get membershipActivityFeedPageCache(): Map<
      string,
      TimedPromiseCacheEntry<MembershipActivityPage>
    > {
      return typedTarget.membershipActivityFeedPageCache;
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
    buildProfileMentionHandoffUrl(
      chatId: string,
      entityType: ManagedEntityType,
      userId: string,
      displayName: string | null,
    ): string | null {
      return typedTarget.buildProfileMentionHandoffUrl(chatId, entityType, userId, displayName);
    },
    ensureEntityType(
      chatId: string,
      userId: string,
      expectedEntityType: ManagedEntityType,
    ): Promise<void> {
      return typedTarget.ensureEntityType(chatId, userId, expectedEntityType);
    },
    readTrimmedString(value: unknown): string | null {
      return typedTarget.readTrimmedString(value);
    },
    resolveUserProfiles(
      chatId: string,
      entityType: ManagedEntityType,
      userIds: readonly string[],
      options?: ResolveUserProfilesOptions,
    ): Promise<Map<string, ResolvedUserProfile>> {
      return typedTarget.resolveUserProfiles(chatId, entityType, userIds, options);
    },
    toIsoString(value: unknown): string | null {
      return typedTarget.toIsoString(value);
    },
  };
}
