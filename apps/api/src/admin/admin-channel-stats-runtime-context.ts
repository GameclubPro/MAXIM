import type {
  ChannelStatsBucket,
  ChannelStatsQuery,
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
  readonly channelStatsRefreshRuns: Map<string, Promise<void>>;
  resolveChannelStatsFrom(range: ChannelStatsQuery['range'], to: Date): Date;
  resolveChannelStatsBucket(range: ChannelStatsQuery['range']): ChannelStatsBucket;
  getMembershipActivityFeedPage(
    chatId: string,
    from: Date,
    to: Date,
    query: MembershipActivityQuery,
    entityType?: ManagedEntityType,
    profileOptions?: ResolveUserProfilesOptions,
  ): Promise<MembershipActivityPage>;
  buildEmptyMembershipActivityPage(): MembershipActivityPage;
  invalidateChannelStatsResponseCache(chatId: string): void;
  resolveAssistBotAssignment(
    chatId: string,
    capability: ManagedEntityBotCapability,
  ): Promise<string | undefined>;
  readTrimmedString(value: unknown): string | null;
  toIsoString(value: unknown): string | null;
  toSafeInteger(value: unknown): number;
};

type AdminChannelStatsRuntimeContextTarget = AdminChannelStatsRuntimeContext;

export function createAdminChannelStatsRuntimeContext(
  target: object,
): AdminChannelStatsRuntimeContext {
  const typedTarget = target as AdminChannelStatsRuntimeContextTarget;

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
    get channelStatsCollector(): ChannelStatsCollectorService | undefined {
      return typedTarget.channelStatsCollector;
    },
    get channelStatsRefreshRuns(): Map<string, Promise<void>> {
      return typedTarget.channelStatsRefreshRuns;
    },
    resolveChannelStatsFrom(range: ChannelStatsQuery['range'], to: Date): Date {
      return typedTarget.resolveChannelStatsFrom(range, to);
    },
    resolveChannelStatsBucket(range: ChannelStatsQuery['range']): ChannelStatsBucket {
      return typedTarget.resolveChannelStatsBucket(range);
    },
    getMembershipActivityFeedPage(
      chatId: string,
      from: Date,
      to: Date,
      query: MembershipActivityQuery,
      entityType?: ManagedEntityType,
      profileOptions?: ResolveUserProfilesOptions,
    ): Promise<MembershipActivityPage> {
      return typedTarget.getMembershipActivityFeedPage(
        chatId,
        from,
        to,
        query,
        entityType,
        profileOptions,
      );
    },
    buildEmptyMembershipActivityPage(): MembershipActivityPage {
      return typedTarget.buildEmptyMembershipActivityPage();
    },
    invalidateChannelStatsResponseCache(chatId: string): void {
      return typedTarget.invalidateChannelStatsResponseCache(chatId);
    },
    resolveAssistBotAssignment(
      chatId: string,
      capability: ManagedEntityBotCapability,
    ): Promise<string | undefined> {
      return typedTarget.resolveAssistBotAssignment(chatId, capability);
    },
    readTrimmedString(value: unknown): string | null {
      return typedTarget.readTrimmedString(value);
    },
    toIsoString(value: unknown): string | null {
      return typedTarget.toIsoString(value);
    },
    toSafeInteger(value: unknown): number {
      return typedTarget.toSafeInteger(value);
    },
  };
}
