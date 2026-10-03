import type { Logger } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';

import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';

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
  normalizeRuntimeManagedEntityBotId(botId: string | null | undefined): string | null;
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
  target: AdminRequiredSubscriptionRuntimeContext,
): AdminRequiredSubscriptionRuntimeContext {
  return target;
}
