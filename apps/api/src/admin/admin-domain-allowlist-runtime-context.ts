import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedEntityType } from '@maxim/contracts';

export type AdminDomainAllowlistRuntimeContext = {
  readonly prisma: PrismaService;
  readonly chatContextCache: ChatContextCacheService;
  assertChatAdmin(chatId: string, userId: string, entityType?: ManagedEntityType): Promise<void>;
};

type AdminDomainAllowlistRuntimeContextTarget = {
  prisma: PrismaService;
  chatContextCache: ChatContextCacheService;
  assertChatAdmin(chatId: string, userId: string, entityType?: ManagedEntityType): Promise<void>;
};

export function createAdminDomainAllowlistRuntimeContext(
  target: object,
): AdminDomainAllowlistRuntimeContext {
  const typedTarget = target as AdminDomainAllowlistRuntimeContextTarget;

  return {
    get prisma(): PrismaService {
      return typedTarget.prisma;
    },
    get chatContextCache(): ChatContextCacheService {
      return typedTarget.chatContextCache;
    },
    assertChatAdmin(
      chatId: string,
      userId: string,
      entityType?: ManagedEntityType,
    ): Promise<void> {
      return typedTarget.assertChatAdmin(chatId, userId, entityType);
    },
  };
}
