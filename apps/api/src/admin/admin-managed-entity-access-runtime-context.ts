import type { Logger } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedEntityAccessStateValue } from './admin.service.support';

export type MarkManagedEntityAccessEdgesDeniedForUserParams = {
  chatId: string;
  userId: string;
  state: Exclude<ManagedEntityAccessStateValue, 'GRANTED'>;
  deniedReason: string;
  source: string;
};

export type AdminManagedEntityAccessRuntimeContext = {
  readonly prisma: PrismaService;
  readonly chatContextCache: ChatContextCacheService;
  readonly logger: Logger;
  forgetManagedEntitiesLastSuccessChat(userId: string, chatId: string): void;
  invalidateManagedEntitiesAllowlistCache(userId: string): void;
  markManagedEntityAccessEdgesDeniedForUser(
    params: MarkManagedEntityAccessEdgesDeniedForUserParams,
  ): Promise<void>;
  normalizeManagedEntityAccessBotId(botId: string | null | undefined): string | null;
  readTrimmedString(value: unknown): string | null;
};

type AdminManagedEntityAccessRuntimeContextTarget = AdminManagedEntityAccessRuntimeContext;

export function createAdminManagedEntityAccessRuntimeContext(
  target: object,
): AdminManagedEntityAccessRuntimeContext {
  const typedTarget = target as AdminManagedEntityAccessRuntimeContextTarget;

  return {
    get prisma(): PrismaService {
      return typedTarget.prisma;
    },
    get chatContextCache(): ChatContextCacheService {
      return typedTarget.chatContextCache;
    },
    get logger(): Logger {
      return typedTarget.logger;
    },
    forgetManagedEntitiesLastSuccessChat(userId: string, chatId: string): void {
      typedTarget.forgetManagedEntitiesLastSuccessChat(userId, chatId);
    },
    invalidateManagedEntitiesAllowlistCache(userId: string): void {
      typedTarget.invalidateManagedEntitiesAllowlistCache(userId);
    },
    markManagedEntityAccessEdgesDeniedForUser(
      params: MarkManagedEntityAccessEdgesDeniedForUserParams,
    ): Promise<void> {
      return typedTarget.markManagedEntityAccessEdgesDeniedForUser(params);
    },
    normalizeManagedEntityAccessBotId(botId: string | null | undefined): string | null {
      return typedTarget.normalizeManagedEntityAccessBotId(botId);
    },
    readTrimmedString(value: unknown): string | null {
      return typedTarget.readTrimmedString(value);
    },
  };
}
