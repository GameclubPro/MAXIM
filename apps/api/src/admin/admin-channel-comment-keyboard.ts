import type { ChannelSuggestionEntryMode, ManagedEntityType } from '@maxim/contracts';
import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import type { MaxClientService, MaxMessageButton } from '../max/max-client.service';
import { CHANNEL_DIALOG_ACTION_COMMENT } from './admin.service.support';
import {
  readManagedBroadcastButtonRows,
  readManagedBroadcastCommentsButtonPosition,
} from './admin-managed-broadcast-ledger';
import { createCommentsButtonPosition } from './publisher-comment-keyboard-routing';

type CommentsButtonPosition = {
  rowIndex: number;
  columnIndex: number;
  baseText: string | null;
};

export async function refreshCommentsButtonCount(
  context: {
    prisma: PrismaService;
    maxClient: MaxClientService;
    logger: Logger;
    resolveBotId: () => Promise<string | null | undefined>;
  },
  params: {
    chatId: string;
    messageId: string;
    threadId: string;
    entityType: ManagedEntityType;
    buttons: MaxMessageButton[][];
    commentsButton: CommentsButtonPosition | null;
  },
): Promise<void> {
  const { chatId, messageId, threadId, entityType, buttons, commentsButton } = params;
  try {
    if (!commentsButton) return;
    const button = buttons[commentsButton.rowIndex]?.[commentsButton.columnIndex];
    if (!button) return;
    const options = {
      buttons,
      refreshButtonText: {
        button,
        readText: async () =>
          formatCommentsButtonText(
            commentsButton.baseText,
            await context.prisma.auditLog.count({
              where: {
                chatId,
                action: CHANNEL_DIALOG_ACTION_COMMENT,
                payload: { path: ['threadId'], equals: threadId },
              },
            }),
          ),
      },
      ...(entityType === 'chat' ? { appendNewInlineKeyboardRows: true } : {}),
      mergeExistingInlineKeyboard: true,
    };
    const botId = await context.resolveBotId();
    if (botId) {
      await context.maxClient.editMessageInlineKeyboard(chatId, messageId, null, options, {
        botId,
      });
    } else {
      await context.maxClient.editMessageInlineKeyboard(chatId, messageId, null, options);
    }
  } catch (error) {
    context.logger.warn(
      {
        chatId,
        entityType,
        messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to refresh comments button counter',
    );
  }
}

export function buildChannelCommentCountKeyboard(params: {
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
  commentsButtonText: string | null;
  suggestButtonText: string;
  suggestionEntryMode: ChannelSuggestionEntryMode;
  count: number;
  ctaButton: MaxMessageButton | null | undefined;
  customButtonRows: MaxMessageButton[][];
  buildDialogButton: (
    type: 'comments' | 'suggest',
    text: string,
    suggestionEntryMode?: ChannelSuggestionEntryMode,
  ) => MaxMessageButton | null;
}): { buttons: MaxMessageButton[][]; commentsButton: CommentsButtonPosition | null } | null {
  const commentsButton = params.includeCommentsButton
    ? params.buildDialogButton(
        'comments',
        formatCommentsButtonText(params.commentsButtonText, params.count),
      )
    : null;
  if (params.includeCommentsButton && !commentsButton) {
    return null;
  }

  const suggestButton = params.includeSuggestButton
    ? params.buildDialogButton('suggest', params.suggestButtonText, params.suggestionEntryMode)
    : null;
  if (params.includeSuggestButton && !suggestButton) {
    return null;
  }

  return {
    buttons: buildChannelPostActionRows({
      commentsButton,
      suggestButton,
      ctaButton: params.ctaButton,
      customButtonRows: params.customButtonRows,
    }),
    commentsButton: params.includeCommentsButton
      ? createCommentsButtonPosition([], params.commentsButtonText)
      : null,
  };
}

export function prepareStoredChannelCommentsKeyboard(
  payload: Record<string, unknown>,
  count: number,
): { buttons: MaxMessageButton[][]; commentsButton: CommentsButtonPosition } | null {
  const storedRows = readManagedBroadcastButtonRows(payload.buttonRows);
  const commentsButton = readManagedBroadcastCommentsButtonPosition(
    payload.commentsButton,
    storedRows,
  );
  if (!storedRows || !commentsButton) {
    return null;
  }
  const buttons = storedRows.map((row) => row.map((button) => ({ ...button })));
  const button = buttons[commentsButton.rowIndex]?.[commentsButton.columnIndex];
  if (!button) {
    return null;
  }
  button.text = formatCommentsButtonText(commentsButton.baseText, count);
  return { buttons, commentsButton };
}
