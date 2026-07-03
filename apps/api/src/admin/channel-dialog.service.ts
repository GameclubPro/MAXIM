import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { collectBotTokenSecrets } from '../common/bot-token.util';
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
import { AdminService } from './admin.service';

@Injectable()
export class ChannelDialogService {
  private readonly dialogLinkHelper: AdminDialogLinkHelper;

  constructor(
    private readonly legacyAdminService: AdminService,
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
    ...args: Parameters<AdminService['getChannelDialog']>
  ): ReturnType<AdminService['getChannelDialog']> {
    return this.legacyAdminService.getChannelDialog(...args);
  }

  createChannelDialogMessage(
    ...args: Parameters<AdminService['createChannelDialogMessage']>
  ): ReturnType<AdminService['createChannelDialogMessage']> {
    return this.legacyAdminService.createChannelDialogMessage(...args);
  }

  updateChannelDialogNotifications(
    ...args: Parameters<AdminService['updateChannelDialogNotifications']>
  ): ReturnType<AdminService['updateChannelDialogNotifications']> {
    return this.legacyAdminService.updateChannelDialogNotifications(...args);
  }

  updateChannelDialogMessage(
    ...args: Parameters<AdminService['updateChannelDialogMessage']>
  ): ReturnType<AdminService['updateChannelDialogMessage']> {
    return this.legacyAdminService.updateChannelDialogMessage(...args);
  }

  deleteChannelDialogMessage(
    ...args: Parameters<AdminService['deleteChannelDialogMessage']>
  ): ReturnType<AdminService['deleteChannelDialogMessage']> {
    return this.legacyAdminService.deleteChannelDialogMessage(...args);
  }

  toggleChannelDialogReaction(
    chatId: string,
    user: Parameters<AdminService['toggleChannelDialogReaction']>[1],
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ): ReturnType<AdminService['toggleChannelDialogReaction']> {
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
    ...args: Parameters<AdminService['getChatDialog']>
  ): ReturnType<AdminService['getChatDialog']> {
    return this.legacyAdminService.getChatDialog(...args);
  }

  createChatDialogMessage(
    ...args: Parameters<AdminService['createChatDialogMessage']>
  ): ReturnType<AdminService['createChatDialogMessage']> {
    return this.legacyAdminService.createChatDialogMessage(...args);
  }

  updateChatDialogNotifications(
    ...args: Parameters<AdminService['updateChatDialogNotifications']>
  ): ReturnType<AdminService['updateChatDialogNotifications']> {
    return this.legacyAdminService.updateChatDialogNotifications(...args);
  }

  updateChatDialogMessage(
    ...args: Parameters<AdminService['updateChatDialogMessage']>
  ): ReturnType<AdminService['updateChatDialogMessage']> {
    return this.legacyAdminService.updateChatDialogMessage(...args);
  }

  deleteChatDialogMessage(
    ...args: Parameters<AdminService['deleteChatDialogMessage']>
  ): ReturnType<AdminService['deleteChatDialogMessage']> {
    return this.legacyAdminService.deleteChatDialogMessage(...args);
  }

  toggleChatDialogReaction(
    chatId: string,
    user: Parameters<AdminService['toggleChatDialogReaction']>[1],
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ): ReturnType<AdminService['toggleChatDialogReaction']> {
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
    ...args: Parameters<AdminService['processChannelSuggestionDeliveryJob']>
  ): ReturnType<AdminService['processChannelSuggestionDeliveryJob']> {
    return this.legacyAdminService.processChannelSuggestionDeliveryJob(...args);
  }
}
