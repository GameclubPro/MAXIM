import {
  publishChannelEngagementRequestSchema,
  publishChannelEngagementResultSchema,
  type ChannelSettings,
  type PublishChannelEngagementResult,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import {
  MAX_API_SOURCE_TAGS,
  type MaxClientService,
  type MaxMessageButton,
  type MaxSendMessageOptions,
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

type ChannelEngagementTextPayload = Pick<MaxSendMessageOptions, 'textFormat'> & {
  text: string;
};

type ChannelEngagementMaxClient = Pick<
  MaxClientService,
  'editMessageInlineKeyboard' | 'sendMessageImmediateWithResolvedLink'
>;

const CHANNEL_ENGAGEMENT_MAX_API_OPTIONS = {
  trafficClass: 'interactive',
  actionHealthLane: 'interactive',
  sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
  timeoutMs: 10_000,
} as const;

export async function publishChannelEngagementMessage(params: {
  prisma: PrismaService;
  maxClient: ChannelEngagementMaxClient;
  chatId: string;
  actorUserId: string;
  body: unknown;
  resolveBotId: () => Promise<string | undefined> | string | undefined;
  resolveEditBotId?: () => Promise<string | undefined> | string | undefined;
  buildDialogArtifacts: (
    params: BuildChannelEngagementDialogArtifactsParams,
  ) => ChannelEngagementDialogArtifacts;
  prepareText?: (payload: ChannelEngagementTextPayload) => Promise<ChannelEngagementTextPayload>;
  generateThreadId?: () => string;
}): Promise<PublishChannelEngagementResult> {
  const parsed = publishChannelEngagementRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }
  const messagePayload = params.prepareText
    ? await params.prepareText({ text: parsed.data.text })
    : { text: parsed.data.text };

  const persistedSettings = await params.prisma.channelSettings.upsert({
    where: { chatId: params.chatId },
    create: {
      chatId: params.chatId,
      commentsEnabled: false,
    },
    update: {},
    select: {
      engagementPublishedMessageId: true,
      engagementPublishedBotId: true,
      engagementPublishedThreadId: true,
      engagementPublishedAt: true,
      postSuggestionsEntryMode: true,
    },
  });
  let sendBotIdResolved = false;
  let resolvedSendBotId: string | undefined;
  const resolveSendBotId = async () => {
    if (!sendBotIdResolved) {
      resolvedSendBotId = await params.resolveBotId();
      sendBotIdResolved = true;
    }
    return resolvedSendBotId;
  };
  let editBotIdResolved = false;
  let resolvedEditBotId: string | undefined;
  const resolveEditBotId = async () => {
    if (!editBotIdResolved) {
      resolvedEditBotId = params.resolveEditBotId
        ? await params.resolveEditBotId()
        : await resolveSendBotId();
      editBotIdResolved = true;
    }
    return resolvedEditBotId;
  };

  const existingPublishedMessageId = persistedSettings.engagementPublishedMessageId?.trim() ?? '';
  const existingPublishedBotId = persistedSettings.engagementPublishedBotId?.trim() || undefined;
  const existingThreadId = persistedSettings.engagementPublishedThreadId?.trim() ?? '';
  const threadId = existingThreadId || (params.generateThreadId ?? randomUUID)();
  const suggestionEntryMode = persistedSettings.postSuggestionsEntryMode ?? 'BOT';
  const buildArtifactsForBot = (botId: string | undefined) => {
    const artifacts = params.buildDialogArtifacts({
      chatId: params.chatId,
      threadId,
      formattedCommentsButtonText: formatCommentsButtonText(parsed.data.commentsButtonText, 0),
      suggestButtonText: parsed.data.suggestButtonText,
      botId,
      suggestionEntryMode,
    });
    const buttons: MaxMessageButton[][] = [];
    if (parsed.data.includeCommentsButton) {
      buttons.push([artifacts.commentsButton]);
    }
    if (parsed.data.includeSuggestButton) {
      buttons.push([artifacts.suggestButton]);
    }
    return { ...artifacts, buttons };
  };

  let authorBotId =
    existingPublishedBotId ??
    (existingPublishedMessageId ? await resolveEditBotId() : await resolveSendBotId());
  let { buttons, commentsUrl, suggestPayload, suggestUrl } = buildArtifactsForBot(authorBotId);
  const buildRequestOptions = (botId: string | undefined) => ({
    ...CHANNEL_ENGAGEMENT_MAX_API_OPTIONS,
    ...(botId ? { botId } : {}),
  });

  let messageId = existingPublishedMessageId;
  let updatedExisting = false;
  let recreatedFromMessageId: string | null = null;
  let publishedAt = persistedSettings.engagementPublishedAt ?? null;
  let publishedUrl: string | null = null;

  if (messageId) {
    try {
      const options = {
        buttons,
        ...(messagePayload.textFormat ? { textFormat: messagePayload.textFormat } : {}),
      } satisfies Pick<MaxSendMessageOptions, 'buttons' | 'textFormat'>;
      await params.maxClient.editMessageInlineKeyboard(
        params.chatId,
        messageId,
        messagePayload.text,
        options,
        buildRequestOptions(authorBotId),
      );
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
      authorBotId = await resolveSendBotId();
      ({ buttons, commentsUrl, suggestPayload, suggestUrl } = buildArtifactsForBot(authorBotId));
    }
  }

  if (!messageId) {
    try {
      const options = {
        buttons,
        ...(messagePayload.textFormat ? { textFormat: messagePayload.textFormat } : {}),
      } satisfies MaxSendMessageOptions;
      const published = await params.maxClient.sendMessageImmediateWithResolvedLink(
        params.chatId,
        messagePayload.text,
        options,
        buildRequestOptions(authorBotId),
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
      engagementPublishedBotId: authorBotId ?? null,
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
        ...(authorBotId ? { botId: authorBotId } : {}),
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
