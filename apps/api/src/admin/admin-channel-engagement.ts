import {
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  type ChannelSettings,
  type PublishChannelEngagementResult,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import type {
  MaxClientService,
  MaxMessageButton,
  MaxSendMessageOptions,
} from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import { extractMaxApiErrorMessage } from './admin-chat-rules';
import { shouldRecreateEditableMessage } from './admin-editable-message';
import { CHANNEL_DIALOG_ACTION_PUBLISH } from './admin.service.support';

export type ChannelEngagementDialogArtifacts = {
  commentsButton: MaxMessageButton;
  suggestButton: MaxMessageButton;
  commentsUrl: string | null;
  suggestPayload: string;
  suggestUrl: string | null;
};

export type BuildChannelEngagementDialogArtifactsParams = {
  chatId: string;
  threadId: string;
  formattedCommentsButtonText: string;
  suggestButtonText: string;
  botId?: string | null;
  suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'];
};

type ChannelEngagementMaxClient = Pick<
  MaxClientService,
  'editMessageInlineKeyboard' | 'sendMessageImmediateWithResolvedLink'
>;

export async function publishChannelEngagementMessage(params: {
  prisma: PrismaService;
  maxClient: ChannelEngagementMaxClient;
  chatId: string;
  actorUserId: string;
  body: unknown;
  resolveBotId: () => Promise<string | undefined> | string | undefined;
  buildDialogArtifacts: (
    params: BuildChannelEngagementDialogArtifactsParams,
  ) => ChannelEngagementDialogArtifacts;
  generateThreadId?: () => string;
}): Promise<PublishChannelEngagementResult> {
  const parsed = publishChannelEngagementRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const persistedSettings = await params.prisma.channelSettings.upsert({
    where: { chatId: params.chatId },
    create: {
      chatId: params.chatId,
      commentsEnabled: false,
    },
    update: {},
    select: {
      engagementPublishedMessageId: true,
      engagementPublishedThreadId: true,
      engagementPublishedAt: true,
      postSuggestionsEntryMode: true,
    },
  });
  const resolvedBotId = await params.resolveBotId();

  const existingPublishedMessageId = persistedSettings.engagementPublishedMessageId?.trim() ?? '';
  const existingThreadId = persistedSettings.engagementPublishedThreadId?.trim() ?? '';
  const threadId = existingThreadId || (params.generateThreadId ?? randomUUID)();
  const suggestionEntryMode = persistedSettings.postSuggestionsEntryMode ?? 'BOT';
  const {
    commentsButton,
    suggestButton,
    commentsUrl,
    suggestPayload,
    suggestUrl,
  } = params.buildDialogArtifacts({
    chatId: params.chatId,
    threadId,
    formattedCommentsButtonText: formatCommentsButtonText(parsed.data.commentsButtonText, 0),
    suggestButtonText: parsed.data.suggestButtonText,
    botId: resolvedBotId,
    suggestionEntryMode,
  });

  const buttons: MaxMessageButton[][] = [];
  if (parsed.data.includeCommentsButton) {
    buttons.push([commentsButton]);
  }
  if (parsed.data.includeSuggestButton) {
    buttons.push([suggestButton]);
  }

  let messageId = existingPublishedMessageId;
  let updatedExisting = false;
  let recreatedFromMessageId: string | null = null;
  let publishedAt = persistedSettings.engagementPublishedAt ?? null;
  let publishedUrl: string | null = null;

  if (messageId) {
    try {
      const options = {
        buttons,
      } satisfies Pick<MaxSendMessageOptions, 'buttons'>;
      if (resolvedBotId) {
        await params.maxClient.editMessageInlineKeyboard(
          params.chatId,
          messageId,
          parsed.data.text,
          options,
          { botId: resolvedBotId },
        );
      } else {
        await params.maxClient.editMessageInlineKeyboard(
          params.chatId,
          messageId,
          parsed.data.text,
          options,
        );
      }
      updatedExisting = true;
    } catch (error: unknown) {
      if (!shouldRecreateEditableMessage(error)) {
        const maxApiMessage = extractMaxApiErrorMessage(error);
        throw new BadRequestException(
          maxApiMessage || 'Не удалось обновить опубликованный пост с кнопками.',
        );
      }

      recreatedFromMessageId = messageId;
      messageId = '';
    }
  }

  if (!messageId) {
    try {
      const options = {
        buttons,
      } satisfies MaxSendMessageOptions;
      const published = resolvedBotId
        ? await params.maxClient.sendMessageImmediateWithResolvedLink(
            params.chatId,
            parsed.data.text,
            options,
            { botId: resolvedBotId },
          )
        : await params.maxClient.sendMessageImmediateWithResolvedLink(
            params.chatId,
            parsed.data.text,
            options,
          );
      messageId = published.messageId;
      publishedUrl = published.url ?? null;
    } catch (error: unknown) {
      const maxApiMessage = extractMaxApiErrorMessage(error);
      throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать пост с кнопками.');
    }
    publishedAt = new Date();
    updatedExisting = false;
  } else if (!publishedAt) {
    publishedAt = new Date();
  }

  await params.prisma.channelSettings.update({
    where: { chatId: params.chatId },
    data: {
      engagementPublishedMessageId: messageId,
      engagementPublishedThreadId: threadId,
      engagementPublishedAt: publishedAt,
    },
  });

  await params.prisma.auditLog.create({
    data: {
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      action: CHANNEL_DIALOG_ACTION_PUBLISH,
      payload: {
        messageId,
        text: parsed.data.text,
        commentsButtonText: parsed.data.commentsButtonText,
        suggestButtonText: parsed.data.suggestButtonText,
        includeCommentsButton: parsed.data.includeCommentsButton,
        includeSuggestButton: parsed.data.includeSuggestButton,
        threadId,
        updatedExisting,
        recreatedFromMessageId,
        commentsUrl,
        suggestPayload,
        suggestUrl,
        suggestionEntryMode,
        ...(publishedUrl ? { publishedUrl } : {}),
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      },
    },
  });

  return publishChannelEngagementResultSchema.parse({
    chatId: params.chatId,
    sent: true,
    messageId,
    updatedExisting,
    publishedAt: publishedAt?.toISOString() ?? null,
  });
}
