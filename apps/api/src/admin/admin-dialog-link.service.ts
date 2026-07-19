import type { ChannelDialogType } from '@maxim/contracts';
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
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';

@Injectable()
export class AdminDialogLinkService {
  private readonly helper: AdminDialogLinkHelper;

  constructor(
    configService: ConfigService,
    @Optional() maxBotLinkService?: MaxBotLinkService,
    @Optional() maxBotRegistry?: MaxBotRegistryService,
  ) {
    const configuredBotTokens = collectBotTokenSecrets(
      configService.getOrThrow<string>('MAX_BOT_TOKEN'),
      configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    const maxBotToken =
      maxBotLinkService?.getBotTokenSync?.() ??
      configuredBotTokens[0] ??
      configService.getOrThrow<string>('MAX_BOT_TOKEN');
    const maxBotTokenValidationSecrets =
      maxBotLinkService?.getValidationTokens?.() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [maxBotToken]);

    this.helper = new AdminDialogLinkHelper({
      appBaseUrl: normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL')),
      explicitBotContactId: normalizeBotContactId(configService.get<string>('MAX_BOT_CONTACT_ID')),
      ownBotUserId: normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID')),
      maxBotToken,
      maxBotTokenValidationSecrets,
      maxBotLinkService,
      maxBotRegistry,
    });
  }

  buildChannelSuggestionStartPayload(
    chatId: string,
    threadId: string,
    botId?: string | null,
  ): string {
    return this.helper.buildChannelSuggestionStartPayload(chatId, threadId, botId);
  }

  parseChannelSuggestionStartPayload(
    startPayload: string | null,
  ): { chatId: string; token: string } | null {
    return this.helper.parseChannelSuggestionStartPayload(startPayload);
  }

  buildChannelDialogStartParam(chatId: string, type: ChannelDialogType, threadId: string): string {
    return this.helper.buildChannelDialogStartParam(chatId, type, threadId);
  }

  buildBotStartUrl(startPayload: string, botId?: string | null): string | null {
    return this.helper.buildBotStartUrl(startPayload, botId);
  }
}
