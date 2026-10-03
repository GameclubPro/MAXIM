import type { Logger } from '@nestjs/common';
import type { ChatSettings, DomainAllowlistEntry, ManagedEntityHeader } from '@maxim/contracts';

import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import {
  isRequiredSubscriptionCurrentlyActive as isRequiredSubscriptionActive,
  type ResolvedBotAssignmentData,
} from './admin-chat-settings';

export type AdminChatRulesTextRuntimeContext = {
  readonly prisma: PrismaService;
  readonly chatContextCache: ChatContextCacheService;
  readonly maxClient: MaxClientService;
  readonly logger: Logger;
  readonly maxBotTokenValidationSecrets: readonly string[];
  getSettings(chatId: string, user: AuthUser): Promise<ChatSettings>;
  getDomainAllowlistDetails(chatId: string, user: AuthUser): Promise<DomainAllowlistEntry[]>;
  isRequiredSubscriptionCurrentlyActive(settings: ChatSettings): boolean;
  resolveRequiredSubscriptionChannelHeaders(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]>;
  resolveUserDisplayNames(chatId: string, userIds: string[]): Promise<Map<string, string>>;
  resolveChatSettingsReadBotAssignmentData(chatId: string): Promise<ResolvedBotAssignmentData>;
};

type AdminChatRulesTextRuntimeDependencies = Omit<
  AdminChatRulesTextRuntimeContext,
  'isRequiredSubscriptionCurrentlyActive'
>;

export function createAdminChatRulesTextRuntimeContext(
  target: AdminChatRulesTextRuntimeDependencies,
): AdminChatRulesTextRuntimeContext {
  return {
    get prisma(): PrismaService {
      return target.prisma;
    },
    get chatContextCache(): ChatContextCacheService {
      return target.chatContextCache;
    },
    get maxClient(): MaxClientService {
      return target.maxClient;
    },
    get logger(): Logger {
      return target.logger;
    },
    get maxBotTokenValidationSecrets(): readonly string[] {
      return target.maxBotTokenValidationSecrets;
    },
    getSettings(chatId: string, user: AuthUser): Promise<ChatSettings> {
      return target.getSettings(chatId, user);
    },
    getDomainAllowlistDetails(chatId: string, user: AuthUser): Promise<DomainAllowlistEntry[]> {
      return target.getDomainAllowlistDetails(chatId, user);
    },
    isRequiredSubscriptionCurrentlyActive(settings: ChatSettings): boolean {
      return isRequiredSubscriptionActive(settings);
    },
    resolveRequiredSubscriptionChannelHeaders(
      channelIds: readonly string[],
    ): Promise<ManagedEntityHeader[]> {
      return target.resolveRequiredSubscriptionChannelHeaders(channelIds);
    },
    resolveUserDisplayNames(chatId: string, userIds: string[]): Promise<Map<string, string>> {
      return target.resolveUserDisplayNames(chatId, userIds);
    },
    resolveChatSettingsReadBotAssignmentData(chatId: string): Promise<ResolvedBotAssignmentData> {
      return target.resolveChatSettingsReadBotAssignmentData(chatId);
    },
  };
}
