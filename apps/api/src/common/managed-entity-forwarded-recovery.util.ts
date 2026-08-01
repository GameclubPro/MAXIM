import { parseChatIdAsBigInt } from './chat-id.util';

export type ManagedEntityForwardedRecoveryCandidate = {
  privateChatId: string;
  sourceChatId: string;
  forwarderUserId: string;
  incomingMessageId: string;
  sourceMessageId: string;
};

export function extractManagedEntityForwardedRecoveryCandidate(
  payload: unknown,
): ManagedEntityForwardedRecoveryCandidate | null {
  const update = asRecord(payload);
  if (!update || readLowerString(update.type ?? update.update_type) !== 'message_created') {
    return null;
  }

  // Normalized webhook data is authoritative only when it retains the original MAX payload.
  const raw = asRecord(update.raw);
  const normalizedMessage = asRecord(update.message);
  if (!raw || !normalizedMessage) {
    return null;
  }

  const rawType = readLowerString(raw.update_type ?? raw.type);
  if (rawType && rawType !== 'message_created') {
    return null;
  }

  const message = extractRawMessage(raw);
  if (!message) {
    return null;
  }

  const sender = asRecord(message.sender);
  const recipient = asRecord(message.recipient);
  const rawChatType = readLowerString(
    recipient?.chat_type ?? recipient?.chatType ?? message.chat_type ?? message.chatType,
  );
  if (rawChatType && rawChatType !== 'dialog') {
    return null;
  }

  const privateChatId = readIntegerString(
    recipient?.chat_id ?? recipient?.chatId ?? message.chat_id ?? message.chatId,
  );
  const forwarderUserId = readIntegerString(
    sender?.user_id ?? sender?.userId ?? sender?.id ?? message.sender_id ?? message.senderId,
  );
  if (!isPositiveId(privateChatId) || !isPositiveId(forwarderUserId)) {
    return null;
  }

  if (
    readIntegerString(normalizedMessage.chatId ?? normalizedMessage.chat_id) !== privateChatId ||
    readIntegerString(normalizedMessage.senderId ?? normalizedMessage.sender_id) !== forwarderUserId
  ) {
    return null;
  }

  if (hasDirectMessageContent(message)) {
    return null;
  }

  const forwardedSource = extractForwardedSource(message);
  if (!forwardedSource || !isNegativeId(forwardedSource.sourceChatId)) {
    return null;
  }

  const rawIncomingMessageId = readString(
    message.message_id ??
      message.messageId ??
      message.mid ??
      message.id ??
      asRecord(message.body)?.mid,
  );
  const incomingMessageId = readString(normalizedMessage.messageId ?? normalizedMessage.message_id);
  if (!incomingMessageId || (rawIncomingMessageId && rawIncomingMessageId !== incomingMessageId)) {
    return null;
  }

  return {
    privateChatId,
    sourceChatId: forwardedSource.sourceChatId,
    forwarderUserId,
    incomingMessageId,
    sourceMessageId: forwardedSource.sourceMessageId,
  };
}

export function isManagedEntityForwardedRecoveryMessage(payload: unknown): boolean {
  return extractManagedEntityForwardedRecoveryCandidate(payload) !== null;
}

function extractRawMessage(raw: Record<string, unknown>): Record<string, unknown> | null {
  const direct = asRecord(raw.message);
  if (direct) {
    return direct;
  }

  for (const key of ['message_created', 'data', 'event']) {
    const envelope = asRecord(raw[key]);
    const nested = asRecord(envelope?.message);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function hasDirectMessageContent(message: Record<string, unknown>): boolean {
  const body = asRecord(message.body);
  const content = asRecord(message.content);
  const payload = asRecord(message.payload);
  if (
    readString(
      message.text ??
        message.caption ??
        body?.text ??
        body?.plain ??
        body?.caption ??
        content?.text ??
        content?.caption ??
        payload?.text ??
        payload?.caption,
    ) ||
    hasAttachments(message.attachments) ||
    hasAttachments(body?.attachments) ||
    hasAttachments(content?.attachments) ||
    hasAttachments(payload?.attachments)
  ) {
    return true;
  }

  return false;
}

function hasAttachments(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function extractForwardedSource(
  message: Record<string, unknown>,
): Pick<ManagedEntityForwardedRecoveryCandidate, 'sourceChatId' | 'sourceMessageId'> | null {
  const officialLink = asRecord(message.link);
  if (officialLink) {
    if (
      readLowerString(officialLink.type ?? officialLink.link_type ?? officialLink.linkType) !==
      'forward'
    ) {
      return null;
    }

    const linkedMessage = asRecord(officialLink.message);
    const sourceChatId = readIntegerString(officialLink.chat_id ?? officialLink.chatId);
    const sourceMessageId = readString(linkedMessage?.mid);
    return sourceChatId && sourceMessageId ? { sourceChatId, sourceMessageId } : null;
  }

  const body = asRecord(message.body);
  for (const candidate of [
    asRecord(message.forwarded_message),
    asRecord(message.forwardedMessage),
    asRecord(body?.forwarded_message),
    asRecord(body?.forwardedMessage),
  ]) {
    if (!candidate) {
      continue;
    }

    const candidateType = readLowerString(
      candidate.type ?? candidate.link_type ?? candidate.linkType,
    );
    if (candidateType && candidateType !== 'forward') {
      continue;
    }

    const recipient = asRecord(candidate.recipient);
    const linkedMessage = asRecord(candidate.message);
    const linkedBody = asRecord(candidate.body);
    const sourceChatId = readIntegerString(
      candidate.chat_id ?? candidate.chatId ?? recipient?.chat_id ?? recipient?.chatId,
    );
    const sourceMessageId = readString(
      linkedMessage?.mid ??
        linkedBody?.mid ??
        candidate.mid ??
        candidate.message_id ??
        candidate.messageId,
    );
    if (sourceChatId && sourceMessageId) {
      return { sourceChatId, sourceMessageId };
    }
  }

  return null;
}

function isPositiveId(value: string | null): value is string {
  const numeric = value ? parseChatIdAsBigInt(value) : null;
  return numeric !== null && numeric > 0n;
}

function isNegativeId(value: string | null): value is string {
  const numeric = value ? parseChatIdAsBigInt(value) : null;
  return numeric !== null && numeric < 0n;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function readIntegerString(value: unknown): string | null {
  const normalized = readString(value);
  return normalized && /^-?\d+$/u.test(normalized) ? normalized : null;
}

function readLowerString(value: unknown): string | null {
  return readString(value)?.toLowerCase() ?? null;
}
