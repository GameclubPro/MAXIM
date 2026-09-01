import type { BroadcastLinkButton, ChannelSettings, ManagedEntityType } from '@maxim/contracts';
import type { MaxActionLedgerContext, MaxMessageButton } from '../max/max-client.service';
import { normalizeManagedBroadcastButtons } from './admin-managed-broadcast-buttons';

export type ManagedBroadcastCommentDialogReference = {
  entityType: ManagedEntityType;
  threadId: string;
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
  suggestButtonText: string | null;
  customButtons: BroadcastLinkButton[];
  suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] | null;
  botId: string | null;
  dialogBotId?: string | null;
  buttonRows?: MaxMessageButton[][];
  commentsButton?: { rowIndex: number; columnIndex: number; baseText: string | null } | null;
};

export function buildManagedBroadcastLedgerContext(
  reference: ManagedBroadcastCommentDialogReference | null,
): MaxActionLedgerContext {
  return {
    managedBroadcast: {
      commentDialogReference: reference
        ? {
            entityType: reference.entityType,
            threadId: reference.threadId,
            includeCommentsButton: reference.includeCommentsButton,
            includeSuggestButton: reference.includeSuggestButton,
            suggestButtonText: reference.suggestButtonText,
            customButtons: reference.customButtons,
            suggestionEntryMode: reference.suggestionEntryMode,
            botId: reference.botId,
            dialogBotId: reference.dialogBotId ?? reference.botId,
            ...(reference.buttonRows ? { buttonRows: reference.buttonRows } : {}),
            ...(reference.commentsButton !== undefined
              ? { commentsButton: reference.commentsButton }
              : {}),
          }
        : null,
    },
  };
}

export function readManagedBroadcastLedgerCommentDialogContext(value: unknown): {
  found: boolean;
  reference: ManagedBroadcastCommentDialogReference | null;
} {
  const metadata = readObjectPayloadOrNull(value);
  const ledgerContext = readObjectPayloadOrNull(metadata?.ledgerContext);
  const managedBroadcast = readObjectPayloadOrNull(ledgerContext?.managedBroadcast);
  if (
    !managedBroadcast ||
    !Object.prototype.hasOwnProperty.call(managedBroadcast, 'commentDialogReference')
  ) {
    return { found: false, reference: null };
  }
  if (managedBroadcast.commentDialogReference === null) {
    return { found: true, reference: null };
  }

  const reference = readObjectPayloadOrNull(managedBroadcast.commentDialogReference);
  const entityType = reference?.entityType;
  const threadId = readTrimmedString(reference?.threadId);
  if (
    !reference ||
    (entityType !== 'chat' && entityType !== 'channel') ||
    !threadId ||
    typeof reference.includeCommentsButton !== 'boolean' ||
    typeof reference.includeSuggestButton !== 'boolean'
  ) {
    return { found: false, reference: null };
  }
  const buttonRows = readManagedBroadcastButtonRows(reference.buttonRows);
  const commentsButton = readManagedBroadcastCommentsButtonPosition(
    reference.commentsButton,
    buttonRows,
  );
  if (
    (reference.buttonRows !== undefined && !buttonRows) ||
    (reference.commentsButton !== undefined && reference.commentsButton !== null && !commentsButton)
  ) {
    return { found: false, reference: null };
  }

  return {
    found: true,
    reference: {
      entityType,
      threadId,
      includeCommentsButton: reference.includeCommentsButton,
      includeSuggestButton: reference.includeSuggestButton,
      suggestButtonText: readTrimmedString(reference.suggestButtonText),
      customButtons: normalizeManagedBroadcastButtons(reference.customButtons),
      suggestionEntryMode:
        typeof reference.suggestionEntryMode === 'string'
          ? (reference.suggestionEntryMode as ManagedBroadcastCommentDialogReference['suggestionEntryMode'])
          : null,
      botId: readTrimmedString(reference.botId),
      dialogBotId: readTrimmedString(reference.dialogBotId) ?? readTrimmedString(reference.botId),
      ...(buttonRows ? { buttonRows } : {}),
      ...(reference.commentsButton !== undefined ? { commentsButton } : {}),
    },
  };
}

export function readManagedBroadcastButtonRows(value: unknown): MaxMessageButton[][] | null {
  if (!Array.isArray(value) || value.length > 30) {
    return null;
  }
  const rows: MaxMessageButton[][] = [];
  let totalButtons = 0;
  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0 || row.length > 7) {
      return null;
    }
    const buttons: MaxMessageButton[] = [];
    for (const button of row) {
      if (!button || typeof button !== 'object' || Array.isArray(button)) {
        return null;
      }
      totalButtons += 1;
      if (totalButtons > 210) {
        return null;
      }
      buttons.push({ ...(button as MaxMessageButton) });
    }
    rows.push(buttons);
  }
  return rows;
}

export function readManagedBroadcastCommentsButtonPosition(
  value: unknown,
  rows: MaxMessageButton[][] | null,
): ManagedBroadcastCommentDialogReference['commentsButton'] {
  if (value === null || value === undefined) {
    return null;
  }
  const position = readObjectPayloadOrNull(value);
  const rowIndex = position?.rowIndex;
  const columnIndex = position?.columnIndex;
  const baseText = position?.baseText;
  if (
    !rows ||
    typeof rowIndex !== 'number' ||
    !Number.isInteger(rowIndex) ||
    rowIndex < 0 ||
    typeof columnIndex !== 'number' ||
    !Number.isInteger(columnIndex) ||
    columnIndex < 0 ||
    !rows[rowIndex]?.[columnIndex] ||
    (baseText !== null && baseText !== undefined && typeof baseText !== 'string')
  ) {
    return null;
  }
  return {
    rowIndex,
    columnIndex,
    baseText: typeof baseText === 'string' && baseText.trim() ? baseText.trim() : null,
  };
}

function readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
