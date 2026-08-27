import type { ChannelDialogType, ChannelSettings } from '@maxim/contracts';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxMessageButton } from '../max/max-client.service';
import { AdminDialogLinkHelper } from '../admin/admin-dialog-link-helper';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { PublisherDialogSigningKeyService } from './publisher-dialog-signing-key.service';

@Injectable()
export class PublisherDialogLinkService {
  private readonly helper: AdminDialogLinkHelper | null;
  private readonly publisherBotId: string;

  constructor(
    configService: ConfigService,
    publisherSigningKeys: PublisherDialogSigningKeyService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
    const secrets = publisherSigningKeys.getSigningKeys();
    this.helper = secrets[0]
      ? new AdminDialogLinkHelper({
          appBaseUrl: null,
          explicitBotContactId: null,
          ownBotUserId: this.publisherBotId,
          maxBotToken: secrets[0],
          maxBotTokenValidationSecrets: secrets,
        })
      : null;
  }

  buildChatDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
  ): MaxMessageButton {
    return this.requireHelper().buildChatDialogButton(
      chatId,
      type,
      threadId,
      text,
      this.publisherBotId,
    );
  }

  getBotId(): string {
    return this.publisherBotId;
  }

  buildChannelDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] = 'MINIAPP',
  ): MaxMessageButton {
    return this.requireHelper().buildChannelDialogButton(
      chatId,
      type,
      threadId,
      text,
      this.publisherBotId,
      suggestionEntryMode,
    );
  }

  resolveChatDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.requireHelper().resolveChatDialogThreadId(chatId, type, token);
  }

  resolveChannelDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.requireHelper().resolveChannelDialogThreadId(chatId, type, token);
  }

  private requireHelper(): AdminDialogLinkHelper {
    if (!this.helper) {
      throw new ServiceUnavailableException('Ключ ссылок Публика временно недоступен.');
    }
    return this.helper;
  }
}
