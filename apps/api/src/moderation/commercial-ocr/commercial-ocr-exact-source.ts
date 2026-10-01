import {
  extractVisiblePhotoMessageContent,
  type ExtractedPhotoAttachment,
} from '../photo-duplicate/photo-attachment-extractor';
import {
  extractCommercialOcrMessageCreatedAt,
  selectCommercialOcrMessageNode,
} from './commercial-ocr-source-time';

export type CommercialOcrDeleteSource = {
  messageId: string;
  chatId: string;
  senderId: string;
  sourceCreatedAt: string;
  caption: string;
  orderedPhotoIds: string[];
};

export type CommercialOcrExactMessageSource = {
  source: CommercialOcrDeleteSource;
  images: ExtractedPhotoAttachment[];
  authorKind: 'user' | 'bot_or_service' | 'unknown';
};

/**
 * Extracts the exact delete-grade source used by both the OCR processor and the dispatch guard.
 * URL-only image identities deliberately fail open and cannot authorize deletion.
 */
export function extractCommercialOcrDeleteSource(
  rawMessage: unknown,
): CommercialOcrDeleteSource | null {
  return extractCommercialOcrExactMessageSource(rawMessage)?.source ?? null;
}

export function extractCommercialOcrExactMessageSource(
  rawMessage: unknown,
): CommercialOcrExactMessageSource | null {
  const message = selectCommercialOcrMessageNode(rawMessage);
  if (!message) {
    return null;
  }

  const messageId = extractMessageId(message);
  const chatId = extractChatId(message);
  const senderId = extractSenderId(message);
  const sourceCreatedAt = extractCommercialOcrMessageCreatedAt(message);
  if (!messageId || !chatId || !senderId || !sourceCreatedAt) {
    return null;
  }

  const content = extractVisiblePhotoMessageContent(message);
  if (content.kind !== 'complete') {
    return null;
  }
  const orderedPhotoIds = content.content.images.map((image) => image.photoId);
  if (orderedPhotoIds.some((photoId) => !photoId)) {
    return null;
  }

  return {
    source: {
      messageId,
      chatId,
      senderId,
      sourceCreatedAt,
      caption: content.content.caption,
      orderedPhotoIds: orderedPhotoIds as string[],
    },
    images: content.content.images.map((image) => ({ ...image })),
    authorKind: extractExactAuthorKind(message),
  };
}

function extractMessageId(message: Record<string, unknown>): string | null {
  const body = asRecord(message.body);
  const content = asRecord(message.content);
  return firstIdentifier(
    message.message_id,
    message.messageId,
    message.mid,
    message.id,
    body?.mid,
    body?.message_id,
    body?.messageId,
    content?.mid,
    content?.message_id,
    content?.messageId,
  );
}

function extractChatId(message: Record<string, unknown>): string | null {
  const chat = asRecord(message.chat);
  const recipient = asRecord(message.recipient);
  return firstIdentifier(
    message.chat_id,
    message.chatId,
    chat?.id,
    chat?.chat_id,
    chat?.chatId,
    recipient?.chat_id,
    recipient?.chatId,
    recipient?.id,
  );
}

function extractSenderId(message: Record<string, unknown>): string | null {
  const sender = asRecord(message.sender);
  const from = asRecord(message.from);
  const user = asRecord(message.user);
  return firstIdentifier(
    message.sender_id,
    message.senderId,
    sender?.user_id,
    sender?.userId,
    sender?.id,
    from?.user_id,
    from?.userId,
    from?.id,
    user?.user_id,
    user?.userId,
    user?.id,
  );
}

function extractExactAuthorKind(
  message: Record<string, unknown>,
): CommercialOcrExactMessageSource['authorKind'] {
  const candidates = [
    asRecord(message.sender),
    asRecord(message.from),
    asRecord(message.user),
    message,
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== null);

  let explicitlyHuman = false;
  for (const candidate of candidates) {
    const type = firstIdentifier(candidate.type, candidate.kind)?.toLowerCase();
    if (
      type === 'bot' ||
      type === 'service' ||
      candidate.is_bot === true ||
      candidate.isBot === true ||
      candidate.bot === true ||
      candidate.is_service === true ||
      candidate.isService === true
    ) {
      return 'bot_or_service';
    }
    if (
      type === 'user' ||
      type === 'human' ||
      candidate.is_bot === false ||
      candidate.isBot === false ||
      candidate.bot === false
    ) {
      explicitlyHuman = true;
    }
  }
  return explicitlyHuman ? 'user' : 'unknown';
}

function firstIdentifier(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      continue;
    }
    const normalized = String(value).trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
