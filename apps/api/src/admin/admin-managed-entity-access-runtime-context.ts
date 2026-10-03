import type { Logger } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  ManagedEntityAccessStateValue,
  ManagedEntityAccessEdgeClient,
} from './admin.service.support';

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
  readonly managedEntitiesRuntimeBotIds: ReadonlySet<string>;
  forgetManagedEntitiesLastSuccessChat(userId: string, chatId: string): void;
  invalidateManagedEntitiesAllowlistCache(userId: string): void;
  readonly accessEdges: Pick<ManagedEntityAccessEdgeClient, 'updateMany'> | null;
  normalizeManagedEntityAccessBotId(botId: string | null | undefined): string | null;
};

export function createAdminManagedEntityAccessRuntimeContext(
  target: AdminManagedEntityAccessRuntimeContext,
): AdminManagedEntityAccessRuntimeContext {
  return target;
}
