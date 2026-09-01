import type { ChannelSuggestionEntryMode } from '@maxim/contracts';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import type { MaxMessageButton } from '../max/max-client.service';
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
