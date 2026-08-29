import type { MaxUpdate } from '@maxim/contracts';
import { normalizePublisherAutoReplyPhrase } from '@maxim/contracts/publisher-auto-replies';
import { selectMaxMessageCandidate } from '../max/max-message-candidate.util';

export type PublisherAutoReplyMessageCandidate = {
  chatId: string;
  sourceMessageId: string;
  senderUserId: string;
  normalizedTrigger: string;
};

export function normalizePublisherAutoReplyTrigger(value: string): string {
  return normalizePublisherAutoReplyPhrase(value);
}

export function isExplicitlyBotAuthoredPublisherGroupMessage(
  update: MaxUpdate,
  publisherBotId: string,
): boolean {
  if (
    update.botId?.trim() !== publisherBotId.trim() ||
    update.type.trim().toLowerCase() !== 'message_created' ||
    !update.message
  ) {
    return false;
  }
  const raw = asRecord(update.raw);
  const rawMessage = raw ? selectMaxMessageCandidate(raw, update.type)?.node : null;
  return Boolean(
    rawMessage &&
    isGroupChatMessage(rawMessage, update.message.entityType) &&
    (isExplicitlyBotOrServiceAuthored(rawMessage, update.message.senderId) ||
      (raw !== null &&
        raw !== rawMessage &&
        isExplicitlyBotOrServiceAuthored(raw, update.message.senderId))),
  );
}

export function extractPublisherAutoReplyMessageCandidate(
  update: MaxUpdate,
  options: {
    publisherBotId: string;
    isKnownRuntimeBotUserId: (userId: string) => boolean;
  },
): PublisherAutoReplyMessageCandidate | null {
  if (
    update.botId?.trim() !== options.publisherBotId.trim() ||
    update.type.trim().toLowerCase() !== 'message_created'
  ) {
    return null;
  }

  const normalizedMessage = update.message;
  if (!normalizedMessage) {
    return null;
  }
  const chatId = normalizedMessage?.chatId?.trim() ?? '';
  const sourceMessageId = normalizedMessage?.messageId?.trim() ?? '';
  const senderUserId = normalizedMessage?.senderId?.trim() ?? '';
  if (!chatId || !sourceMessageId || !senderUserId) {
    return null;
  }
  if (options.isKnownRuntimeBotUserId(senderUserId)) {
    return null;
  }

  const raw = asRecord(update.raw);
  if (!raw) {
    return null;
  }
  const rawMessage = selectMaxMessageCandidate(raw, update.type)?.node;
  if (
    !rawMessage ||
    isExplicitlyBotOrServiceAuthored(rawMessage, senderUserId) ||
    (raw !== rawMessage && isExplicitlyBotOrServiceAuthored(raw, senderUserId)) ||
    !isGroupChatMessage(rawMessage, normalizedMessage.entityType)
  ) {
    return null;
  }
  if (isForwardedMessage(rawMessage) || isServiceMessage(rawMessage)) {
    return null;
  }

  const body = asRecord(rawMessage.body) ?? asRecord(rawMessage.content);
  if (!body || hasAttachments(rawMessage) || hasAttachments(body)) {
    return null;
  }
  const directText = readString(body.text ?? body.plain ?? body.caption);
  const normalizedDirectText = normalizeDirectText(directText);
  if (
    !normalizedDirectText ||
    normalizedDirectText !== normalizeDirectText(normalizedMessage.text)
  ) {
    return null;
  }
  const normalizedTrigger = normalizePublisherAutoReplyTrigger(normalizedDirectText);
  if (!normalizedTrigger) {
    return null;
  }

  return { chatId, sourceMessageId, senderUserId, normalizedTrigger };
}

function normalizeDirectText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function isExplicitlyBotOrServiceAuthored(
  message: Record<string, unknown>,
  resolvedSenderId: string,
): boolean {
  for (const sender of [
    asRecord(message.sender),
    asRecord(message.from),
    asRecord(message.user),
    asRecord(message.actor),
  ]) {
    if (!sender) {
      continue;
    }
    const authorId = readIdentity(sender.id ?? sender.user_id ?? sender.userId);
    if (authorId && authorId.trim() !== resolvedSenderId.trim()) {
      continue;
    }
    const type = readString(sender.type ?? sender.kind)?.toLowerCase();
    if (type === 'bot' || type === 'service' || hasExplicitBotOrServiceMarker(sender)) {
      return true;
    }
  }
  const directAuthorId = readIdentity(message.sender_id ?? message.senderId);
  return Boolean(
    directAuthorId &&
      directAuthorId.trim() === resolvedSenderId.trim() &&
      hasExplicitBotOrServiceMarker(message),
  );
}

function hasExplicitBotOrServiceMarker(author: Record<string, unknown>): boolean {
  return (
    author.is_bot === true ||
    author.isBot === true ||
    author.bot === true ||
    author.is_service === true ||
    author.isService === true
  );
}

function isGroupChatMessage(
  message: Record<string, unknown>,
  normalizedEntityType: 'chat' | 'channel' | undefined,
): boolean {
  if (normalizedEntityType === 'channel') {
    return false;
  }
  const recipient = asRecord(message.recipient);
  const rawType = readString(
    recipient?.chat_type ??
      recipient?.chatType ??
      message.chat_type ??
      message.chatType ??
      asRecord(message.chat)?.type,
  )?.toLowerCase();
  return rawType ? rawType === 'chat' : normalizedEntityType === 'chat';
}

function isForwardedMessage(message: Record<string, unknown>): boolean {
  const link = asRecord(message.link);
  if (readString(link?.type ?? link?.link_type ?? link?.linkType)?.toLowerCase() === 'forward') {
    return true;
  }
  const body = asRecord(message.body) ?? asRecord(message.content);
  return Boolean(
    asRecord(message.forwarded_message) ||
    asRecord(message.forwardedMessage) ||
    asRecord(body?.forwarded_message) ||
    asRecord(body?.forwardedMessage),
  );
}

function isServiceMessage(message: Record<string, unknown>): boolean {
  const body = asRecord(message.body) ?? asRecord(message.content);
  if (!body) {
    return true;
  }
  return [
    'new_members',
    'new_member',
    'removed_members',
    'removed_member',
    'left_members',
    'left_member',
    'members_added',
    'members_removed',
  ].some((key) => key in body || key in message);
}

function hasAttachments(row: Record<string, unknown>): boolean {
  return Array.isArray(row.attachments) && row.attachments.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value.length > 0 ? value : null;
}

function readIdentity(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}
