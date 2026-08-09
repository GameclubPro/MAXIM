import type { Logger } from '@nestjs/common';

import { extractHttpStatusCode } from '../common/http-error.util';
import {
  MAX_API_SOURCE_TAGS,
  type MaxClientService,
  type MaxMessageButton,
  wasMaxMessageSendAttempted,
} from '../max/max-client.service';
import { classifyMaxTerminalChatActionError } from '../max/managed-entity-access-loss.service';
import type { MaxBotRoute } from '../max/max-bot-link.service';
import {
  isAmbiguousMaxSendError,
  MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
} from '../max/max-send-ambiguity.util';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION,
  CHANNEL_ENGAGEMENT_REPLY_TEXT,
} from './moderation.service.support';
import {
  CHANNEL_AUTO_POST_ATTACH_STATUS,
  type ReplacementAttachMarkerStore,
} from './replacement-attach-marker.store';

type ChannelAutoPostReplyMarkerStore = Pick<
  ReplacementAttachMarkerStore,
  | 'completeChannelAutoPost'
  | 'recordChannelReplyMessage'
  | 'recordChannelReplySendStarted'
  | 'releaseChannelAutoPost'
>;

type ChannelAutoPostReplyFallbackInput = {
  maxClient: Pick<MaxClientService, 'sendMessageImmediateWithResolvedLink'>;
  markerStore: ChannelAutoPostReplyMarkerStore;
  prisma: Pick<PrismaService, 'auditLog'>;
  logger: Pick<Logger, 'error' | 'warn'>;
  resolveSendRoute: () => Promise<MaxBotRoute | null>;
  buildButtons: (botId: string | null) => MaxMessageButton[][];
  chatId: string;
  messageId: string;
  senderId: string | null;
  source: 'webhook' | 'poll';
  lockToken: string;
  editBotId: string | null;
  editError: unknown;
};

export type ChannelAutoPostReplyFallbackResult =
  | {
      status: 'delivered';
      botId: string | null;
      replyMessageId: string;
      publishedUrl: string | null;
    }
  | { status: 'skipped' };

export type ChannelAutoPostTerminalSkipInput = {
  chatId: string;
  messageId: string;
  senderId: string | null;
  botId: string | null;
  linkType: string | null;
  source: 'webhook' | 'poll';
  deliveryMode: 'edit_message' | 'reply_message' | 'replace_with_bot_message';
  status: number | null;
  error: unknown;
};

export async function deliverChannelAutoPostReplyFallback(
  input: ChannelAutoPostReplyFallbackInput,
): Promise<ChannelAutoPostReplyFallbackResult> {
  const editFailure = classifyMaxTerminalChatActionError(input.editError);
  if (editFailure?.kind === 'message_not_found') {
    await recordChannelAutoPostTerminalSkip(input.prisma, input.logger, {
      chatId: input.chatId,
      messageId: input.messageId,
      senderId: input.senderId,
      botId: input.editBotId,
      linkType: null,
      source: input.source,
      deliveryMode: 'edit_message',
      status: editFailure.statusCode,
      error: input.editError,
    });
    await input.markerStore.completeChannelAutoPost({
      chatId: input.chatId,
      messageId: input.messageId,
      lockToken: input.lockToken,
      status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
      source: input.source,
      botId: input.editBotId,
      linkType: null,
      deliveryMode: 'edit_message',
      lastError: extractErrorSummary(input.editError),
      lastStatusCode: editFailure.statusCode,
    });
    return { status: 'skipped' };
  }

  input.logger.warn(
    {
      chatId: input.chatId,
      messageId: input.messageId,
      status: extractHttpStatusCode(input.editError),
      error: extractErrorSummary(input.editError),
    },
    'Failed to edit channel post buttons; falling back to a linked bot reply',
  );

  let replyBotId = input.editBotId;
  try {
    const sendRoute = await input.resolveSendRoute();
    if (sendRoute) {
      const resolvedReplyBotId = normalizeBotId(sendRoute.botId);
      const routeQuarantinesResolvedBot =
        sendRoute.purpose === 'send_message' &&
        resolvedReplyBotId !== null &&
        (sendRoute.quarantinedCandidateBotIds ?? []).includes(resolvedReplyBotId);
      if (!resolvedReplyBotId || routeQuarantinesResolvedBot) {
        const routeError = new Error(
          'No eligible MAX send route is available for the channel reply fallback.',
        );
        await recordChannelAutoPostTerminalSkip(input.prisma, input.logger, {
          chatId: input.chatId,
          messageId: input.messageId,
          senderId: input.senderId,
          botId: null,
          linkType: null,
          source: input.source,
          deliveryMode: 'reply_message',
          status: null,
          error: routeError,
        });
        await input.markerStore.completeChannelAutoPost({
          chatId: input.chatId,
          messageId: input.messageId,
          lockToken: input.lockToken,
          status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
          source: input.source,
          botId: null,
          linkType: null,
          deliveryMode: 'reply_message',
          lastError: routeError.message,
          lastStatusCode: null,
        });
        return { status: 'skipped' };
      }
      replyBotId = resolvedReplyBotId;
    }
  } catch (routeError: unknown) {
    await input.markerStore.releaseChannelAutoPost({
      chatId: input.chatId,
      messageId: input.messageId,
      lockToken: input.lockToken,
      source: input.source,
      botId: input.editBotId,
      linkType: null,
      lastError: extractErrorSummary(routeError),
      lastStatusCode: extractHttpStatusCode(routeError),
    });
    throw routeError;
  }

  const requestOptions = {
    trafficClass: 'background',
    actionHealthLane: 'background',
    sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
    ...(replyBotId ? { botId: replyBotId } : {}),
  } as const;
  let sendStarted = false;
  let sent: Awaited<ReturnType<MaxClientService['sendMessageImmediateWithResolvedLink']>>;

  try {
    sent = await input.maxClient.sendMessageImmediateWithResolvedLink(
      input.chatId,
      CHANNEL_ENGAGEMENT_REPLY_TEXT,
      {
        buttons: input.buildButtons(replyBotId),
        messageLink: { type: 'reply', mid: input.messageId },
        // FLAG: Persist the fence before MAX receives this non-idempotent send.
        beforeSend: async () => {
          await input.markerStore.recordChannelReplySendStarted({
            chatId: input.chatId,
            messageId: input.messageId,
            lockToken: input.lockToken,
          });
          sendStarted = true;
        },
        debugContext: {
          screen: 'channel-auto-post',
          action:
            input.source === 'poll'
              ? 'scan-attach-buttons-reply-fallback'
              : 'attach-buttons-reply-fallback',
        },
      },
      requestOptions,
    );
  } catch (fallbackError: unknown) {
    const status = extractHttpStatusCode(fallbackError);
    const ambiguous =
      (sendStarted || wasMaxMessageSendAttempted(fallbackError)) &&
      isAmbiguousMaxSendError(fallbackError);
    if (ambiguous || (status && status < 500 && status !== 429)) {
      await recordChannelAutoPostTerminalSkip(input.prisma, input.logger, {
        chatId: input.chatId,
        messageId: input.messageId,
        senderId: input.senderId,
        botId: replyBotId,
        linkType: null,
        source: input.source,
        deliveryMode: 'reply_message',
        status,
        error: fallbackError,
      });
      await input.markerStore.completeChannelAutoPost({
        chatId: input.chatId,
        messageId: input.messageId,
        lockToken: input.lockToken,
        status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
        source: input.source,
        botId: replyBotId,
        linkType: null,
        deliveryMode: 'reply_message',
        lastError: ambiguous
          ? `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Ambiguous fallback reply send: ${extractErrorSummary(fallbackError)}`
          : extractErrorSummary(fallbackError),
        lastStatusCode: status,
      });
      return { status: 'skipped' };
    }

    await input.markerStore.releaseChannelAutoPost({
      chatId: input.chatId,
      messageId: input.messageId,
      lockToken: input.lockToken,
      source: input.source,
      botId: replyBotId,
      linkType: null,
      lastError: extractErrorSummary(fallbackError),
      lastStatusCode: status,
    });
    throw fallbackError;
  }

  const publishedUrl = sent.url ?? buildMaxMessageFallbackUrl(input.chatId, sent.messageId);
  try {
    await input.markerStore.recordChannelReplyMessage({
      chatId: input.chatId,
      messageId: input.messageId,
      lockToken: input.lockToken,
      replyMessageId: sent.messageId,
      publishedUrl,
    });
  } catch (markerError: unknown) {
    input.logger.error(
      {
        chatId: input.chatId,
        messageId: input.messageId,
        replyMessageId: sent.messageId,
        error: extractErrorSummary(markerError),
      },
      'Quarantined delivered fallback channel reply after marker persistence failure',
    );
  }

  return {
    status: 'delivered',
    botId: replyBotId,
    replyMessageId: sent.messageId,
    publishedUrl,
  };
}

export function buildMaxMessageFallbackUrl(
  chatId: string,
  messageId: string | null,
): string | null {
  const normalizedChatId = chatId.trim();
  const normalizedMessageId = messageId?.trim() ?? '';
  if (!normalizedChatId || !normalizedMessageId) {
    return null;
  }
  return `https://max.ru/chats/${encodeURIComponent(normalizedChatId)}/message/${encodeURIComponent(
    normalizedMessageId,
  )}`;
}

export async function recordChannelAutoPostTerminalSkip(
  prisma: Pick<PrismaService, 'auditLog'>,
  logger: Pick<Logger, 'warn'>,
  input: ChannelAutoPostTerminalSkipInput,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        chatId: input.chatId,
        actorUserId: input.senderId ?? 'system',
        action: CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION,
        payload: {
          messageId: input.messageId,
          reason: 'terminal_delivery_failure',
          linkType: input.linkType,
          source: input.source,
          deliveryMode: input.deliveryMode,
          ...(input.botId ? { botId: input.botId } : {}),
          status: input.status,
          error: readErrorMessage(input.error),
        },
      },
    });
  } catch (skipError: unknown) {
    logger.warn(
      {
        chatId: input.chatId,
        messageId: input.messageId,
        error: skipError instanceof Error ? skipError.message : 'Unknown error',
      },
      'Failed to persist channel auto-post terminal skip marker',
    );
  }
}

function normalizeBotId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function extractErrorSummary(error: unknown): string {
  return readErrorMessage(error).slice(0, 500);
}

function readErrorMessage(error: unknown): string {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  if (typeof value?.message === 'string' && value.message.trim().length > 0) {
    return value.message.trim();
  }
  return String(error ?? 'Unknown error');
}
