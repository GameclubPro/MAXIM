import {
  MAX_CHAT_RULES_TEXT_LENGTH,
  type BroadcastTextFormat,
  type ChatRules,
  type ChatSettings,
  type DomainAllowlistEntry,
  type ManagedEntityHeader,
} from '@maxim/contracts';
import { BadRequestException, Logger } from '@nestjs/common';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import {
  appendAdminContactMarkdownLink as appendAdminContactMarkdownLinkText,
  resolveAdminContactMentionTarget,
} from '../common/admin-contact-link.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  MAX_MESSAGE_TEXT_LENGTH,
  prepareMarkdownForMaxDelivery,
  renderSupportedMarkdownAsHtml,
} from '../common/max-markdown.util';
import { escapeHtmlPreservingWhitespace } from '../common/max-text-markup.util';
import { MaxClientService, type MaxSendMessageOptions } from '../max/max-client.service';
import { type ChatRules as PersistedChatRules } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ensureChatRules as ensureChatRulesValue,
  hydratePublishedRulesUrl as hydratePublishedRulesUrlValue,
  mapChatRules as mapChatRulesValue,
  normalizePublishedRulesUrl as normalizePublishedRulesUrlValue,
} from './admin-chat-rules';
import { type ResolvedBotAssignmentData } from './admin-chat-settings';
import { readTrimmedString } from './admin-legacy-utils';

import { buildRulesTextFromSettings as buildRulesTextFromSettingsValue } from './admin-chat-rules-text-format';
import type { AdminChatRulesTextRuntimeContext } from './admin-chat-rules-text-runtime-context';
import { ADMIN_ACTION_HEALTH_LANE } from './admin.service.support';
export type {
  AdminActionSource,
  ChannelPublicationEngagementContext,
} from './admin.service.support';

export class AdminChatRulesTextRuntime {
  constructor(private readonly context: AdminChatRulesTextRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get chatContextCache(): ChatContextCacheService {
    return this.context.chatContextCache;
  }

  private get maxClient(): MaxClientService {
    return this.context.maxClient;
  }

  private get logger(): Logger {
    return this.context.logger;
  }

  private get maxBotTokenValidationSecrets(): readonly string[] {
    return this.context.maxBotTokenValidationSecrets;
  }

  private getSettings(chatId: string, user: AuthUser): Promise<ChatSettings> {
    return this.context.getSettings(chatId, user);
  }

  private getDomainAllowlistDetails(
    chatId: string,
    user: AuthUser,
  ): Promise<DomainAllowlistEntry[]> {
    return this.context.getDomainAllowlistDetails(chatId, user);
  }

  private isRequiredSubscriptionCurrentlyActive(settings: ChatSettings): boolean {
    return this.context.isRequiredSubscriptionCurrentlyActive(settings);
  }

  private resolveRequiredSubscriptionChannelHeaders(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]> {
    return this.context.resolveRequiredSubscriptionChannelHeaders(channelIds);
  }

  private resolveUserDisplayNames(chatId: string, userIds: string[]): Promise<Map<string, string>> {
    return this.context.resolveUserDisplayNames(chatId, userIds);
  }

  private resolveChatSettingsReadBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    return this.context.resolveChatSettingsReadBotAssignmentData(chatId);
  }

  private readTrimmedString(value: unknown): string | null {
    return readTrimmedString(value);
  }

  normalizeImportedRulesText(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return null;
    }

    return normalized.length <= MAX_CHAT_RULES_TEXT_LENGTH ? normalized : null;
  }

  async upsertChatRules(chatId: string): Promise<PersistedChatRules> {
    return ensureChatRulesValue({
      prisma: this.prisma,
      chatId,
    });
  }

  mapChatRules(rules: PersistedChatRules): ChatRules {
    return mapChatRulesValue(rules);
  }

  async hydratePublishedRulesUrl(
    chatId: string,
    rules: PersistedChatRules,
  ): Promise<PersistedChatRules> {
    return hydratePublishedRulesUrlValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      rules,
      resolveBotId: async () => (await this.resolveChatSettingsReadBotAssignmentData(chatId)).botId,
    });
  }

  normalizePublishedRulesUrl(value: string | null | undefined): string | null {
    return normalizePublishedRulesUrlValue(value);
  }

  async buildFormattedRulesPublicationText(
    chatId: string,
    sourceText: string,
    options: {
      textFormat: BroadcastTextFormat;
      adminContactButtonEnabled: boolean;
      adminContactButtonUrl: string;
    },
  ): Promise<{
    text: string;
    textFormat: MaxSendMessageOptions['textFormat'];
  }> {
    const fallbackDisplayName = options.adminContactButtonEnabled
      ? await this.resolveAdminContactFallbackDisplayName(chatId, options.adminContactButtonUrl)
      : null;

    const adminContactOptions = {
      enabled: options.adminContactButtonEnabled,
      url: options.adminContactButtonUrl,
      botTokens: this.maxBotTokenValidationSecrets,
      fallbackDisplayName,
    };

    if (options.textFormat === 'plain') {
      if (!options.adminContactButtonEnabled) {
        if (sourceText.length > MAX_MESSAGE_TEXT_LENGTH) {
          throw new BadRequestException(
            `Текст правил слишком длинный. Максимум ${MAX_MESSAGE_TEXT_LENGTH} символов.`,
          );
        }
        return { text: sourceText, textFormat: undefined };
      }

      const contactMarkdown = appendAdminContactMarkdownLinkText('', adminContactOptions).trim();
      const contactHtml = renderSupportedMarkdownAsHtml(contactMarkdown, { blockMode: 'raw' });
      const plainHtml = escapeHtmlPreservingWhitespace(sourceText);
      const combinedHtml = `${plainHtml}\n\n${contactHtml}`;
      if (combinedHtml.length > MAX_MESSAGE_TEXT_LENGTH) {
        throw new BadRequestException(
          `Текст правил после форматирования слишком длинный. Максимум ${MAX_MESSAGE_TEXT_LENGTH} символов.`,
        );
      }
      return { text: combinedHtml, textFormat: 'html' };
    }

    const markdown = appendAdminContactMarkdownLinkText(sourceText, adminContactOptions);

    const prepared = prepareMarkdownForMaxDelivery(markdown);
    if (!prepared) {
      throw new BadRequestException(
        `Текст правил после форматирования слишком длинный. Максимум ${MAX_MESSAGE_TEXT_LENGTH} символов.`,
      );
    }

    return prepared;
  }

  private async resolveAdminContactFallbackDisplayName(
    chatId: string,
    url: string | null | undefined,
  ): Promise<string | null> {
    const target = resolveAdminContactMentionTarget(url, this.maxBotTokenValidationSecrets);
    if (!target?.userId || target.displayName) {
      return null;
    }

    const localDisplayNames = await this.resolveUserDisplayNames(chatId, [target.userId]);
    const localDisplayName = this.readTrimmedString(localDisplayNames.get(target.userId));
    if (localDisplayName) {
      return localDisplayName;
    }

    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);
    if (!loadProfiles) {
      return null;
    }

    try {
      const profiles = await loadProfiles(chatId, [target.userId], {
        trafficClass: 'interactive',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      });
      return this.readTrimmedString(profiles.get(target.userId)?.displayName) ?? null;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId: target.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve admin contact display name for rules publication',
      );
      return null;
    }
  }

  async buildAutofilledRulesTextFromCurrentSettings(
    chatId: string,
    user: AuthUser,
  ): Promise<string> {
    const settings = await this.getSettings(chatId, user);
    const [domains, requiredSubscriptionChannels] = await Promise.all([
      settings.linkPolicy === 'ALLOWLIST_ONLY'
        ? this.getDomainAllowlistDetails(chatId, user)
        : Promise.resolve([] as DomainAllowlistEntry[]),
      this.isRequiredSubscriptionCurrentlyActive(settings)
        ? this.resolveRequiredSubscriptionChannelHeaders(settings.requiredSubscriptionChannelIds)
        : Promise.resolve([] as ManagedEntityHeader[]),
    ]);

    return this.buildRulesTextFromSettings({
      settings,
      domains,
      requiredSubscriptionChannels,
    });
  }

  private buildRulesTextFromSettings(input: {
    settings: ChatSettings;
    domains: DomainAllowlistEntry[];
    requiredSubscriptionChannels: ManagedEntityHeader[];
  }): string {
    return buildRulesTextFromSettingsValue(input);
  }
}
