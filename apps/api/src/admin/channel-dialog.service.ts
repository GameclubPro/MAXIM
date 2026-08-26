import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  normalizeAppBaseUrl,
  normalizeBotContactId,
  normalizeOwnBotUserId,
} from './admin-legacy-utils';
import { toggleDialogReactionValue } from './admin-channel-dialog-reaction';
import { getChannelSuggestionRedirectValue } from './admin-channel-dialog-redirect';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';
import {
  CHANNEL_DIALOG_LEGACY_PORT,
  type ChannelDialogLegacyPort,
} from './channel-dialog-legacy.port';

@Injectable()
export class ChannelDialogService {
  private readonly dialogLinkHelper: AdminDialogLinkHelper;

  constructor(
    @Inject(CHANNEL_DIALOG_LEGACY_PORT)
    private readonly legacyAdminService: ChannelDialogLegacyPort,
    configService: ConfigService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly maxBotRegistry?: MaxBotRegistryService,
  ) {
    const configuredBotTokens = collectBotTokenSecrets(
      configService.getOrThrow<string>('MAX_BOT_TOKEN'),
      configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    const maxBotToken =
      this.maxBotLinkService?.getBotTokenSync?.() ??
      configuredBotTokens[0] ??
      configService.getOrThrow<string>('MAX_BOT_TOKEN');
    const maxBotTokenValidationSecrets =
      this.maxBotLinkService?.getValidationTokens?.() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [maxBotToken]);
    this.dialogLinkHelper = new AdminDialogLinkHelper({
      appBaseUrl: normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL')),
      explicitBotContactId: normalizeBotContactId(configService.get<string>('MAX_BOT_CONTACT_ID')),
      ownBotUserId: normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID')),
      maxBotToken,
      maxBotTokenValidationSecrets,
      maxBotLinkService: this.maxBotLinkService,
      maxBotRegistry: this.maxBotRegistry,
    });
  }

  getChannelSuggestionRedirect(chatId: string, token: string | null) {
    return getChannelSuggestionRedirectValue({
      chatId,
      token,
      dialogLinkHelper: this.dialogLinkHelper,
      loadChannelSettings: (channelId) =>
        this.legacyAdminService.getPublicChannelSettingsForDialog(channelId),
      resolveBotId: (channelId) =>
        this.maxBotLinkService?.getStoredChatPrimaryBotId(channelId) ?? Promise.resolve(null),
    });
  }

  getChannelDialog(
    ...args: Parameters<ChannelDialogLegacyPort['getChannelDialog']>
  ): ReturnType<ChannelDialogLegacyPort['getChannelDialog']> {
    return this.legacyAdminService.getChannelDialog(...args);
  }

  createChannelDialogMessage(
    ...args: Parameters<ChannelDialogLegacyPort['createChannelDialogMessage']>
  ): ReturnType<ChannelDialogLegacyPort['createChannelDialogMessage']> {
    return this.legacyAdminService.createChannelDialogMessage(...args);
  }

  updateChannelDialogNotifications(
    ...args: Parameters<ChannelDialogLegacyPort['updateChannelDialogNotifications']>
  ): ReturnType<ChannelDialogLegacyPort['updateChannelDialogNotifications']> {
    return this.legacyAdminService.updateChannelDialogNotifications(...args);
  }

  updateChannelDialogMessage(
    ...args: Parameters<ChannelDialogLegacyPort['updateChannelDialogMessage']>
  ): ReturnType<ChannelDialogLegacyPort['updateChannelDialogMessage']> {
    return this.legacyAdminService.updateChannelDialogMessage(...args);
  }

  deleteChannelDialogMessage(
    ...args: Parameters<ChannelDialogLegacyPort['deleteChannelDialogMessage']>
  ): ReturnType<ChannelDialogLegacyPort['deleteChannelDialogMessage']> {
    return this.legacyAdminService.deleteChannelDialogMessage(...args);
  }

  toggleChannelDialogReaction(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ): ReturnType<ChannelDialogLegacyPort['toggleEntityDialogReactionForDialog']> {
    return toggleDialogReactionValue({
      chatId,
      user,
      entityType: 'channel',
      dialogTypeRaw,
      messageId,
      body,
      loadCommentSettings: (channelId) =>
        this.legacyAdminService.getPublicChannelSettingsForDialog(channelId),
      toggleReaction: (options) =>
        this.legacyAdminService.toggleEntityDialogReactionForDialog(options),
    });
  }

  getChatDialog(
    ...args: Parameters<ChannelDialogLegacyPort['getChatDialog']>
  ): ReturnType<ChannelDialogLegacyPort['getChatDialog']> {
    return this.legacyAdminService.getChatDialog(...args);
  }

  createChatDialogMessage(
    ...args: Parameters<ChannelDialogLegacyPort['createChatDialogMessage']>
  ): ReturnType<ChannelDialogLegacyPort['createChatDialogMessage']> {
    return this.legacyAdminService.createChatDialogMessage(...args);
  }

  updateChatDialogNotifications(
    ...args: Parameters<ChannelDialogLegacyPort['updateChatDialogNotifications']>
  ): ReturnType<ChannelDialogLegacyPort['updateChatDialogNotifications']> {
    return this.legacyAdminService.updateChatDialogNotifications(...args);
  }

  updateChatDialogMessage(
    ...args: Parameters<ChannelDialogLegacyPort['updateChatDialogMessage']>
  ): ReturnType<ChannelDialogLegacyPort['updateChatDialogMessage']> {
    return this.legacyAdminService.updateChatDialogMessage(...args);
  }

  deleteChatDialogMessage(
    ...args: Parameters<ChannelDialogLegacyPort['deleteChatDialogMessage']>
  ): ReturnType<ChannelDialogLegacyPort['deleteChatDialogMessage']> {
    return this.legacyAdminService.deleteChatDialogMessage(...args);
  }

  toggleChatDialogReaction(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ): ReturnType<ChannelDialogLegacyPort['toggleEntityDialogReactionForDialog']> {
    return toggleDialogReactionValue({
      chatId,
      user,
      entityType: 'chat',
      dialogTypeRaw,
      messageId,
      body,
      loadCommentSettings: (chatId) =>
        this.legacyAdminService.getPublicChatCommentSettingsForDialog(chatId),
      toggleReaction: (options) =>
        this.legacyAdminService.toggleEntityDialogReactionForDialog(options),
    });
  }

  processChannelSuggestionDeliveryJob(
    ...args: Parameters<ChannelDialogLegacyPort['processChannelSuggestionDeliveryJob']>
  ): ReturnType<ChannelDialogLegacyPort['processChannelSuggestionDeliveryJob']> {
    return this.legacyAdminService.processChannelSuggestionDeliveryJob(...args);
  }

  processPublisherSuggestionPublicationJob(
    suggestionId: string,
    claimToken: string,
  ): Promise<void> {
    return this.legacyAdminService.channelSuggestionPublicationRuntime.processPublisherSuggestionPublicationJob(
      suggestionId,
      claimToken,
    );
  }

  recoverStaleChannelSuggestionDeliveries(
    ...args: Parameters<ChannelDialogLegacyPort['recoverStaleChannelSuggestionDeliveries']>
  ): ReturnType<ChannelDialogLegacyPort['recoverStaleChannelSuggestionDeliveries']> {
    return this.legacyAdminService.recoverStaleChannelSuggestionDeliveries(...args);
  }

  recordChannelSuggestionDeliveryJobFailure(
    ...args: Parameters<ChannelDialogLegacyPort['recordChannelSuggestionDeliveryJobFailure']>
  ): ReturnType<ChannelDialogLegacyPort['recordChannelSuggestionDeliveryJobFailure']> {
    return this.legacyAdminService.recordChannelSuggestionDeliveryJobFailure(...args);
  }
}
