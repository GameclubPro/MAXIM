import { parseChatIdAsBigInt } from '../common/chat-id.util';
import type { MaxActionJob } from '../max/max-client.service';
import { isMaxSendAutoDeleteMarker } from '../max/max-send-auto-delete-marker';
import { readMessageDuplicateNoticeProof } from '../moderation/message-duplicate/message-duplicate-notice-proof';
import {
  readLegacyActionSourceScopes,
  type LegacyActionSourceScope,
} from '../webhook/webhook-legacy-hold.service';
import { sourceAbandonmentDigest } from './source-abandonment-live-protocol';

export type SourceAbandonmentCleanupParent = {
  ledger: Record<string, unknown> | null;
  majorBotIds: readonly string[];
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim();
const validDate = (value: unknown): value is string =>
  identity(value) && Number.isFinite(Date.parse(value));

export function sourceAbandonmentCleanupParentKey(data: Record<string, unknown>): string | null {
  const marker = record(data.sendAutoDelete);
  return marker?.sourceMessageId === null && identity(marker.sourceSendJobId)
    ? marker.sourceSendJobId
    : null;
}

// FLAG: Explicit null is supported only with the retained, exact completed SEND.
// A compatibility marker or another target chat alone cannot prove lineage. Lost
// reply-link values and unknown producer contexts remain outside this proof.
export function readSourceAbandonmentCleanupScopes(
  data: Record<string, unknown>,
  parent: SourceAbandonmentCleanupParent | undefined,
  selectedSources: readonly { chatId: string }[],
): LegacyActionSourceScope[] | null {
  const marker = record(data.sendAutoDelete);
  const ledger = parent?.ledger;
  const metadata = record(ledger?.metadata);
  const context = record(data.ledgerContext);
  const parentContext = record(metadata?.ledgerContext);
  const groupChatId = typeof data.chatId === 'string' ? parseChatIdAsBigInt(data.chatId) : null;
  if (
    !marker ||
    !isMaxSendAutoDeleteMarker(marker) ||
    marker.sourceMessageId !== null ||
    !['sourceChatId', 'sourceMessageId', 'sourceUserId', 'sourceCreatedAt'].every((key) =>
      Object.hasOwn(marker, key),
    ) ||
    !identity(marker.sourceSendJobId) ||
    !identity(marker.sourceChatId) ||
    !validDate(marker.sourceCreatedAt) ||
    !validDate(marker.sourceSendCompletedAt) ||
    !(marker.sourceUserId === null || identity(marker.sourceUserId)) ||
    !identity(marker.originBotId) ||
    !parent?.majorBotIds.includes(marker.originBotId) ||
    groupChatId === null ||
    groupChatId >= 0n ||
    data.actionType !== 'DELETE_MESSAGE' ||
    !identity(data.messageId) ||
    data.botId !== marker.originBotId ||
    data.sourceTag !== 'moderation_notice' ||
    data.chatId !== marker.sourceChatId ||
    marker.sourceSendJobId === data.idempotencyKey ||
    !ledger ||
    ledger.jobId !== marker.sourceSendJobId ||
    ledger.actionType !== 'SEND_MESSAGE' ||
    ledger.chatId !== marker.sourceChatId ||
    ledger.messageId !== null ||
    ledger.userId !== marker.sourceUserId ||
    ledger.sourceTag !== 'moderation_notice' ||
    ledger.status !== 'SUCCEEDED' ||
    ledger.terminal !== true ||
    ledger.ambiguous !== false ||
    ledger.remoteMessageId !== data.messageId ||
    ledger.dispatchBotId !== marker.originBotId ||
    !(ledger.completedAt instanceof Date) ||
    !Number.isFinite(ledger.completedAt.getTime()) ||
    ledger.completedAt.getTime() !== Date.parse(marker.sourceSendCompletedAt) ||
    !metadata ||
    metadata.createdAt !== marker.sourceCreatedAt ||
    metadata.sendAutoDelete !== null ||
    !Number.isSafeInteger(metadata.autoDeleteDelayMs) ||
    metadata.autoDeleteDelayMs !== marker.requestedDelayMs ||
    !context ||
    !parentContext ||
    sourceAbandonmentDigest(context) !== sourceAbandonmentDigest(parentContext)
  )
    return null;

  // FLAG: The ledger stores only the first twenty option names, not link values.
  // Neither an omitted key in a truncated list nor a child-supplied link proves
  // which original message the parent replied to.
  const options = record(data.options);
  const optionKeys = metadata.optionKeys;
  if (
    (data.options !== undefined && (!options || Object.keys(options).length !== 0)) ||
    typeof metadata.hasOptions !== 'boolean' ||
    !Array.isArray(optionKeys) ||
    optionKeys.length >= 20 ||
    optionKeys.some((key) => !identity(key) || key === 'messageLink') ||
    new Set(optionKeys).size !== optionKeys.length ||
    (!metadata.hasOptions && optionKeys.length !== 0)
  )
    return null;

  // FLAG: Only these two context shapes from the same-chat moderation notice
  // producers are supported here. Other known feature contexts keep refusing.
  const envelope = record(context.moderationNoticeEnvelope);
  if (
    !envelope ||
    Object.keys(envelope).length !== 1 ||
    envelope.version !== 1 ||
    Object.keys(context).some(
      (key) => key !== 'moderationNoticeEnvelope' && key !== 'duplicateNotice',
    )
  )
    return null;
  const duplicate = Object.hasOwn(context, 'duplicateNotice')
    ? readMessageDuplicateNoticeProof(context.duplicateNotice)
    : null;
  if (
    (Object.hasOwn(context, 'duplicateNotice') && !duplicate) ||
    (duplicate && duplicate.chatId !== ledger.chatId) ||
    (!duplicate && selectedSources.some((source) => source.chatId === ledger.chatId))
  )
    return null;

  try {
    const parentAction = {
      actionType: 'SEND_MESSAGE',
      chatId: ledger.chatId,
      messageId: ledger.messageId,
      userId: ledger.userId,
      ledgerContext: parentContext,
    } as unknown as MaxActionJob;
    const scopes = [
      ...readLegacyActionSourceScopes(parentAction),
      ...readLegacyActionSourceScopes(data as unknown as MaxActionJob),
    ];
    return scopes.every((scope) => scope.chatId === ledger.chatId) ? scopes : null;
  } catch {
    return null;
  }
}
