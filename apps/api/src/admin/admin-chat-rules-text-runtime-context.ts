import type { Logger } from '@nestjs/common';
import type { ChatSettings, DomainAllowlistEntry, ManagedEntityHeader } from '@maxim/contracts';

import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { ResolvedBotAssignmentData } from './admin-chat-settings';

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
  read(prop: PropertyKey): unknown;
  write(prop: PropertyKey, value: unknown): void;
};

type AdminChatRulesTextRuntimeContextTarget = {
  prisma: PrismaService;
  chatContextCache: ChatContextCacheService;
  maxClient: MaxClientService;
  logger: Logger;
  maxBotTokenValidationSecrets: readonly string[];
  getSettings(chatId: string, user: AuthUser): Promise<ChatSettings>;
  getDomainAllowlistDetails(chatId: string, user: AuthUser): Promise<DomainAllowlistEntry[]>;
  isRequiredSubscriptionCurrentlyActive(settings: ChatSettings): boolean;
  resolveRequiredSubscriptionChannelHeaders(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]>;
  resolveUserDisplayNames(chatId: string, userIds: string[]): Promise<Map<string, string>>;
  resolveChatSettingsReadBotAssignmentData(chatId: string): Promise<ResolvedBotAssignmentData>;
};

export function createAdminChatRulesTextRuntimeContext(
  target: object,
): AdminChatRulesTextRuntimeContext {
  const targetRecord = target as Record<PropertyKey, unknown>;
  const typedTarget = target as AdminChatRulesTextRuntimeContextTarget;

  return {
    get prisma(): PrismaService {
      return typedTarget.prisma;
    },
    get chatContextCache(): ChatContextCacheService {
      return typedTarget.chatContextCache;
    },
    get maxClient(): MaxClientService {
      return typedTarget.maxClient;
    },
    get logger(): Logger {
      return typedTarget.logger;
    },
    get maxBotTokenValidationSecrets(): readonly string[] {
      return typedTarget.maxBotTokenValidationSecrets;
    },
    getSettings(chatId: string, user: AuthUser): Promise<ChatSettings> {
      return typedTarget.getSettings(chatId, user);
    },
    getDomainAllowlistDetails(
      chatId: string,
      user: AuthUser,
    ): Promise<DomainAllowlistEntry[]> {
      return typedTarget.getDomainAllowlistDetails(chatId, user);
    },
    isRequiredSubscriptionCurrentlyActive(settings: ChatSettings): boolean {
      return typedTarget.isRequiredSubscriptionCurrentlyActive(settings);
    },
    resolveRequiredSubscriptionChannelHeaders(
      channelIds: readonly string[],
    ): Promise<ManagedEntityHeader[]> {
      return typedTarget.resolveRequiredSubscriptionChannelHeaders(channelIds);
    },
    resolveUserDisplayNames(chatId: string, userIds: string[]): Promise<Map<string, string>> {
      return typedTarget.resolveUserDisplayNames(chatId, userIds);
    },
    resolveChatSettingsReadBotAssignmentData(chatId: string): Promise<ResolvedBotAssignmentData> {
      return typedTarget.resolveChatSettingsReadBotAssignmentData(chatId);
    },
    read(prop: PropertyKey): unknown {
      return targetRecord[prop];
    },
    write(prop: PropertyKey, value: unknown): void {
      targetRecord[prop] = value;
    },
  };
}
