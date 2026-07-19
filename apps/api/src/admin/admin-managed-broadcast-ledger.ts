import type { BroadcastLinkButton, ChannelSettings, ManagedEntityType } from '@maxim/contracts';
import type { MaxActionLedgerContext } from '../max/max-client.service';
import { normalizeManagedBroadcastButtons } from './admin-managed-broadcast-buttons';

export type ManagedBroadcastCommentDialogReference = {
  entityType: ManagedEntityType;
  threadId: string;
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
  suggestButtonText: string | null;
  customButtons: BroadcastLinkButton[];
  autoPostButtonsMode: ChannelSettings['autoPostButtonsMode'] | null;
  suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] | null;
  botId: string | null;
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
            autoPostButtonsMode: reference.autoPostButtonsMode,
            suggestionEntryMode: reference.suggestionEntryMode,
            botId: reference.botId,
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

  return {
    found: true,
    reference: {
      entityType,
      threadId,
      includeCommentsButton: reference.includeCommentsButton,
      includeSuggestButton: reference.includeSuggestButton,
      suggestButtonText: readTrimmedString(reference.suggestButtonText),
      customButtons: normalizeManagedBroadcastButtons(reference.customButtons),
      autoPostButtonsMode:
        typeof reference.autoPostButtonsMode === 'string'
          ? (reference.autoPostButtonsMode as ManagedBroadcastCommentDialogReference['autoPostButtonsMode'])
          : null,
      suggestionEntryMode:
        typeof reference.suggestionEntryMode === 'string'
          ? (reference.suggestionEntryMode as ManagedBroadcastCommentDialogReference['suggestionEntryMode'])
          : null,
      botId: readTrimmedString(reference.botId),
    },
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
