import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedEntityType } from '@maxim/contracts';

export type AdminDomainAllowlistRuntimeContext = {
  readonly prisma: PrismaService;
  readonly chatContextCache: ChatContextCacheService;
  assertChatAdmin(chatId: string, userId: string, entityType?: ManagedEntityType): Promise<void>;
};

export function createAdminDomainAllowlistRuntimeContext(
  target: AdminDomainAllowlistRuntimeContext,
): AdminDomainAllowlistRuntimeContext {
  return {
    get prisma(): PrismaService {
      return target.prisma;
    },
    get chatContextCache(): ChatContextCacheService {
      return target.chatContextCache;
    },
    assertChatAdmin(chatId: string, userId: string, entityType?: ManagedEntityType): Promise<void> {
      return target.assertChatAdmin(chatId, userId, entityType);
    },
  };
}
