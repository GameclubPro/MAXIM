import type {
  ManagedEntityBotCapability,
  ManagedEntityType,
  MembershipActivityPage,
  MembershipActivityQuery,
} from '@maxim/contracts';
import type { Logger } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ResolveUserProfilesOptions } from './admin.service.support';
import type { ChannelStatsCollectorService } from './channel-stats-collector.service';

export type AdminChannelStatsRuntimeContext = {
  readonly prisma: PrismaService;
  readonly maxClient: MaxClientService;
  readonly chatContextCache: ChatContextCacheService;
  readonly logger: Logger;
  readonly channelStatsCollector?: ChannelStatsCollectorService;
  getMembershipActivityFeedPage(
    chatId: string,
    from: Date,
    to: Date,
    query: MembershipActivityQuery,
    entityType?: ManagedEntityType,
    profileOptions?: ResolveUserProfilesOptions,
  ): Promise<MembershipActivityPage>;
  buildEmptyMembershipActivityPage(): MembershipActivityPage;
  resolveAssistBotAssignment(
    chatId: string,
    capability: ManagedEntityBotCapability,
  ): Promise<string | undefined>;

  assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: { forceRemote?: boolean; timeoutMs?: number },
  ): Promise<void>;
  ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void>;
};

export function createAdminChannelStatsRuntimeContext(
  target: AdminChannelStatsRuntimeContext,
): AdminChannelStatsRuntimeContext {
  return target;
}
