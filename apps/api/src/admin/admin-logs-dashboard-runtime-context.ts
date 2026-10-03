import type { Logger } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  AssertChatAdminOptions,
  ResolvedUserProfile,
  ResolveUserProfilesOptions,
} from './admin.service.support';

export type AdminLogsDashboardRuntimeContext = {
  readonly prisma: PrismaService;
  readonly logger: Logger;
  readonly chatContextCache: ChatContextCacheService;
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
  resolveUserProfiles(
    chatId: string,
    entityType: ManagedEntityType,
    userIds: readonly string[],
    options?: ResolveUserProfilesOptions,
  ): Promise<Map<string, ResolvedUserProfile>>;
};

export function createAdminLogsDashboardRuntimeContext(
  target: AdminLogsDashboardRuntimeContext,
): AdminLogsDashboardRuntimeContext {
  return target;
}
