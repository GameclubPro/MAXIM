import type { ChannelSettings } from '@maxim/contracts';
import type { MaxActionLedgerContext } from '../max/max-client.service';
import type { ChannelPublicationEngagementContext } from './admin.service.support';

export type ManagedPollChannelEngagementReference = {
  threadId: string;
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
  suggestButtonText: string | null;
  suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'];
  botId: string | null;
};

export function buildManagedPollLedgerContext(
  context: ChannelPublicationEngagementContext | null,
  botId: string | null,
  renderFormatVersion: number,
): MaxActionLedgerContext {
  return {
    managedPoll: {
      renderFormatVersion,
      channelEngagement: toManagedPollChannelEngagementReference(context, botId),
    },
  };
}

export function readManagedPollLedgerChannelEngagement(value: unknown): {
  found: boolean;
  reference: ManagedPollChannelEngagementReference | null;
  renderFormatVersion: number | null;
} {
  const metadata = readObject(value);
  const ledgerContext = readObject(metadata?.ledgerContext);
  const managedPoll = readObject(ledgerContext?.managedPoll);
  const renderFormatVersion = readPositiveInteger(managedPoll?.renderFormatVersion);
  if (!managedPoll || !Object.prototype.hasOwnProperty.call(managedPoll, 'channelEngagement')) {
    return { found: false, reference: null, renderFormatVersion };
  }
  if (managedPoll.channelEngagement === null) {
    return { found: true, reference: null, renderFormatVersion };
  }
  const reference = readManagedPollChannelEngagementReference(managedPoll.channelEngagement);
  return reference
    ? { found: true, reference, renderFormatVersion }
    : { found: false, reference: null, renderFormatVersion };
}

export function readManagedPollChannelEngagementReference(
  value: unknown,
): ManagedPollChannelEngagementReference | null {
  const row = readObject(value);
  const threadId = readString(row?.threadId);
  if (
    !row ||
    !threadId ||
    typeof row.includeCommentsButton !== 'boolean' ||
    typeof row.includeSuggestButton !== 'boolean' ||
    (!row.includeCommentsButton && !row.includeSuggestButton)
  ) {
    return null;
  }

  const suggestionEntryMode = row.suggestionEntryMode === 'MINIAPP' ? 'MINIAPP' : 'BOT';

  return {
    threadId,
    includeCommentsButton: row.includeCommentsButton,
    includeSuggestButton: row.includeSuggestButton,
    suggestButtonText: readString(row.suggestButtonText),
    suggestionEntryMode,
    botId: readString(row.botId),
  };
}

export function toManagedPollChannelEngagementReference(
  context: ChannelPublicationEngagementContext | null,
  botId: string | null,
): ManagedPollChannelEngagementReference | null {
  const threadId = readString(context?.threadId);
  if (!context || !threadId || (!context.includeCommentsButton && !context.includeSuggestButton)) {
    return null;
  }

  return {
    threadId,
    includeCommentsButton: context.includeCommentsButton,
    includeSuggestButton: context.includeSuggestButton,
    suggestButtonText: readString(context.suggestButtonText),
    suggestionEntryMode: context.suggestionEntryMode,
    botId: readString(botId),
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
