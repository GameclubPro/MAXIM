import { createHash } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';

export const MESSAGE_RETENTION_RULE = 'MESSAGE_RETENTION_DELETE';
export const MESSAGE_RETENTION_QUEUE = 'message-retention';
export const MESSAGE_RETENTION_DAY_MS = 86_400_000;
export const MESSAGE_RETENTION_REPLAY_DAYS = 7;
export const MESSAGE_RETENTION_QUEUE_LIMIT = 100;
export const MESSAGE_RETENTION_QUANTUM = 5;
export const MESSAGE_RETENTION_SHARD_LIMIT = 62_500;
export const MESSAGE_RETENTION_CHAT_LIMIT = 50_000;
export const MESSAGE_RETENTION_RESUME_MS = 10 * 60_000;

export type RetentionCapture = {
  chatId: string;
  messageId: string;
  authorId: string;
  originBotId: string;
  sourceAt: Date;
};

export function retentionQuotaShard(chatId: string): number {
  return createHash('sha256').update(chatId).digest()[0]! % 32;
}

export function retentionModeAllows(
  mode: unknown,
  canaryIds: unknown,
  chatId: string,
  mutation = false,
): boolean {
  if (mode === 'on') return true;
  if (mode === 'shadow') return !mutation;
  return (
    mode === 'canary' &&
    typeof canaryIds === 'string' &&
    canaryIds.split(',').some((id) => id.trim() === chatId)
  );
}

export function readRetentionCapture(
  update: MaxUpdate,
  nowMs = Date.now(),
): RetentionCapture | null {
  const message = update.message;
  if (
    update.type !== 'message_created' ||
    !message ||
    !update.botId ||
    message.entityType === 'channel' ||
    message.postId ||
    !/^-[1-9]\d*$/.test(message.chatId)
  )
    return null;
  const rawMessage = record(update.raw?.message);
  const sender = record(rawMessage?.sender);
  const body = record(rawMessage?.body);
  const recipient = record(rawMessage?.recipient);
  // FLAG: Normalized createdAt is event time. Only authenticated message creation time
  // and explicit human authorship authorize this destructive age policy.
  if (
    !rawMessage ||
    sender?.is_bot !== false ||
    String(sender.user_id) !== message.senderId ||
    body?.mid !== message.messageId ||
    String(recipient?.chat_id) !== message.chatId ||
    recipient?.chat_type !== 'chat' ||
    typeof rawMessage.timestamp !== 'number'
  )
    return null;
  const sourceMs = rawMessage.timestamp;
  if (
    !Number.isSafeInteger(sourceMs) ||
    sourceMs > nowMs + 60_000 ||
    sourceMs < nowMs - MESSAGE_RETENTION_REPLAY_DAYS * MESSAGE_RETENTION_DAY_MS
  )
    return null;
  return {
    chatId: message.chatId,
    messageId: message.messageId,
    authorId: message.senderId,
    originBotId: update.botId,
    sourceAt: new Date(sourceMs),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
