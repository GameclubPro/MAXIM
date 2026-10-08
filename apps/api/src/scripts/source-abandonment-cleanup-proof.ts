import { parseChatIdAsBigInt } from '../common/chat-id.util';
import { normalizeMaxActionIdempotencyKeyPart } from '../max/max-action-idempotency';
import { MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS } from '../max/managed-handshake-confirmation';
import type { MaxActionJob } from '../max/max-client.service';
import { isMaxSendAutoDeleteMarker } from '../max/max-send-auto-delete-marker';
import { readMessageDuplicateNoticeProof } from '../moderation/message-duplicate/message-duplicate-notice-proof';
import { readRequiredSubscriptionNoticeAuthority } from '../moderation/required-subscription-notice-authority';
import {
  readLegacyActionSourceScopes,
  type LegacyActionSourceScope,
} from '../webhook/webhook-legacy-hold.service';
import { sourceAbandonmentDigest } from './source-abandonment-live-protocol';

export type SourceAbandonmentCleanupParent = {
  ledger: Record<string, unknown> | null;
  majorBotIds: readonly string[];
  publisherBotId?: string;
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
  if (data.sourceTag === 'managed_handshake')
    return readManagedHandshakeCleanupScopes(data, parent, selectedSources);
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

  // FLAG: Only the explicitly parsed same-chat notice proofs below are supported.
  // Unknown contexts and mixed feature proofs cannot borrow the retained SEND receipt.
  const envelope = record(context.moderationNoticeEnvelope);
  if (
    !envelope ||
    Object.keys(envelope).length !== 1 ||
    envelope.version !== 1 ||
    Object.keys(context).some(
      (key) =>
        key !== 'moderationNoticeEnvelope' &&
        key !== 'duplicateNotice' &&
        key !== 'requiredSubscriptionNotice',
    )
  )
    return null;
  if (Object.hasOwn(context, 'requiredSubscriptionNotice')) {
    const required = readRequiredSubscriptionNoticeAuthority(context.requiredSubscriptionNotice);
    // FLAG: This proves only an unrelated completed notice cleanup. Even a typed
    // source in a selected chat cannot use this exception to acquire source authority.
    if (
      !required ||
      Object.hasOwn(context, 'duplicateNotice') ||
      ![required.chatId, required.messageId, required.userId].every(identity) ||
      required.chatId !== ledger.chatId ||
      selectedSources.some(
        (source) =>
          source.chatId === ledger.chatId || parseChatIdAsBigInt(source.chatId) === groupChatId,
      )
    )
      return null;
  }
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

// FLAG: This exception proves only an unrelated completed Start-confirmation SEND.
// It does not attribute an original command, admit another bot, or release a hold.
function readManagedHandshakeCleanupScopes(
  data: Record<string, unknown>,
  parent: SourceAbandonmentCleanupParent | undefined,
  selectedSources: readonly { chatId: string }[],
): LegacyActionSourceScope[] | null {
  const marker = record(data.sendAutoDelete);
  const ledger = parent?.ledger;
  const metadata = record(ledger?.metadata);
  const chatId = typeof data.chatId === 'string' ? parseChatIdAsBigInt(data.chatId) : null;
  if (
    !marker ||
    !isMaxSendAutoDeleteMarker(marker) ||
    !['sourceChatId', 'sourceMessageId', 'sourceUserId', 'sourceCreatedAt'].every((key) =>
      Object.hasOwn(marker, key),
    ) ||
    marker.sourceMessageId !== null ||
    marker.sourceUserId !== null ||
    !identity(marker.sourceSendJobId) ||
    !identity(marker.sourceChatId) ||
    !validDate(marker.sourceCreatedAt) ||
    !validDate(marker.sourceSendCompletedAt) ||
    !identity(marker.originBotId) ||
    !parent ||
    chatId === null ||
    chatId >= 0n ||
    data.chatId !== marker.sourceChatId ||
    selectedSources.some(
      (source) => source.chatId === data.chatId || parseChatIdAsBigInt(source.chatId) === chatId,
    ) ||
    data.actionType !== 'DELETE_MESSAGE' ||
    !identity(data.messageId) ||
    (data.userId !== undefined && data.userId !== null) ||
    data.botId !== marker.originBotId ||
    data.sourceTag !== 'managed_handshake' ||
    marker.sourceSendJobId === data.idempotencyKey ||
    data.ledgerContext !== undefined ||
    !ledger ||
    ledger.jobId !== marker.sourceSendJobId ||
    ledger.actionType !== 'SEND_MESSAGE' ||
    ledger.chatId !== marker.sourceChatId ||
    ledger.messageId !== null ||
    ledger.userId !== null ||
    ledger.sourceTag !== 'managed_handshake' ||
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
    metadata.autoDeleteDelayMs !== MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS ||
    metadata.autoDeleteDelayMs !== marker.requestedDelayMs ||
    metadata.ledgerContext !== null ||
    !Object.hasOwn(metadata, 'ledgerContext') ||
    metadata.hasText !== true ||
    !Number.isSafeInteger(metadata.textLength) ||
    (metadata.textLength as number) <= 0
  )
    return null;

  if (
    parent.publisherBotId !== undefined &&
    (!identity(parent.publisherBotId) || parent.majorBotIds.includes(parent.publisherBotId))
  )
    return null;
  const isMajor = parent.majorBotIds.includes(marker.originBotId);
  const isPublisher =
    identity(parent.publisherBotId) &&
    !parent.majorBotIds.includes(parent.publisherBotId) &&
    marker.originBotId === parent.publisherBotId;
  if (!isMajor && !isPublisher) return null;
  const options = record(data.options);
  const keys = metadata.optionKeys;
  // FLAG: The original option values were not retained. Only the two exact Start
  // producers' buttons-only/absent options exclude an undisclosed reply source.
  if (
    (data.options !== undefined && (!options || Object.keys(options).length !== 0)) ||
    !Array.isArray(keys) ||
    !(
      (metadata.hasOptions === false && keys.length === 0) ||
      (metadata.hasOptions === true && keys.length === 1 && keys[0] === 'buttons')
    ) ||
    !hasManagedHandshakeParentKey(
      ledger.jobId as string,
      marker.sourceChatId,
      marker.originBotId,
      isPublisher,
    )
  )
    return null;

  try {
    const scopes = [
      ...readLegacyActionSourceScopes({
        actionType: 'SEND_MESSAGE',
        chatId: ledger.chatId,
        messageId: ledger.messageId,
        userId: ledger.userId,
      } as unknown as MaxActionJob),
      ...readLegacyActionSourceScopes(data as unknown as MaxActionJob),
    ];
    return scopes.every((scope) => scope.chatId === ledger.chatId) ? scopes : null;
  } catch {
    return null;
  }
}

function hasManagedHandshakeParentKey(
  key: string,
  chatId: string,
  botId: string,
  publisher: boolean,
): boolean {
  if (!/__[a-zA-Z0-9_-]{24}$/u.test(key)) return false;
  const readable = key.slice(0, -26);
  const producer = publisher ? `publisher-handshake-start:${chatId}` : 'managed-handshake-start';
  const normalizedProducer = normalizeMaxActionIdempotencyKeyPart(producer);
  // FLAG: A truncated producer/chat prefix cannot prove its exact scope. No fallback
  // to tag-only matching or an arbitrary bot is accepted.
  if (normalizedProducer.length >= 48) return false;
  const parts = ['explicit', ...(publisher ? [botId] : []), 'SEND_MESSAGE'].map(
    normalizeMaxActionIdempotencyKeyPart,
  );
  const prefix = `max-action__${parts.join('__')}__${normalizedProducer}_`;
  const suffix = readable.slice(prefix.length);
  return (
    readable.startsWith(prefix) &&
    suffix.length > 0 &&
    normalizedProducer.length + 1 + suffix.length <= 48 &&
    !suffix.includes('__') &&
    /^[a-z0-9_-]+$/u.test(suffix)
  );
}
