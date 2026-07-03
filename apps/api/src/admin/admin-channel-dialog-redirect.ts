import {
  channelSuggestionRedirectResponseSchema,
  type ChannelSettings,
  type ChannelSuggestionRedirectResponse,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import type { AdminDialogLinkHelper } from './admin-dialog-link-helper';

type ChannelSuggestionRedirectDialogLinkHelper = Pick<
  AdminDialogLinkHelper,
  | 'resolveChannelDialogThreadId'
  | 'buildChannelSuggestionStartPayload'
  | 'buildChannelDialogStartParam'
  | 'buildBotStartUrl'
>;

export async function getChannelSuggestionRedirectValue(params: {
  chatId: string;
  token: string | null;
  dialogLinkHelper: ChannelSuggestionRedirectDialogLinkHelper;
  loadChannelSettings: (chatId: string) => Promise<Pick<ChannelSettings, 'postSuggestionsEnabled'>>;
  resolveBotId?: (chatId: string) => Promise<string | null | undefined>;
}): Promise<ChannelSuggestionRedirectResponse> {
  const threadId = params.dialogLinkHelper.resolveChannelDialogThreadId(
    params.chatId,
    'suggest',
    params.token,
  );
  const channelSettings = await params.loadChannelSettings(params.chatId);

  if (!channelSettings.postSuggestionsEnabled && !threadId) {
    throw new BadRequestException('Предложить пост для этого канала сейчас нельзя.');
  }

  const botId = params.resolveBotId
    ? ((await params.resolveBotId(params.chatId).catch(() => null)) ?? null)
    : null;
  const startPayload = threadId
    ? params.dialogLinkHelper.buildChannelSuggestionStartPayload(params.chatId, threadId, botId)
    : params.dialogLinkHelper.buildChannelDialogStartParam(params.chatId, 'suggest', '');
  const url = params.dialogLinkHelper.buildBotStartUrl(startPayload, botId);
  if (!url) {
    throw new BadRequestException('Не удалось открыть диалог с ботом.');
  }

  return channelSuggestionRedirectResponseSchema.parse({
    url,
    title: null,
  });
}
