import type { MaxUpdate } from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import { resolveMaxUserDisplayName } from '../common/max-user-display-name.util';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  PUBLISHER_SUGGESTION_ADMIN_CALLBACK_PREFIX,
  PublisherSuggestionAdminQueueService,
  type PublisherSuggestionAdminReviewAction,
  type PublisherSuggestionAdminReviewActor,
} from './publisher-suggestion-admin.queue';

const PUBLISHER_SUGGESTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;
const MAX_CALLBACK_VALUE_LENGTH = 512;

type PublisherSuggestionReviewCallback = {
  action: PublisherSuggestionAdminReviewAction;
  suggestionId: string;
};

@Injectable()
export class PublisherSuggestionAdminCallbackObserverService {
  private readonly publisherBotId: string;

  constructor(
    botRegistry: MaxBotRegistryService,
    private readonly queue: PublisherSuggestionAdminQueueService,
  ) {
    this.publisherBotId = botRegistry.getPublisherBotDescriptor().id;
  }

  async observeWebhook(
    update: MaxUpdate,
    webhookEventId: string | null,
    options: { duplicate?: boolean } = {},
  ): Promise<boolean> {
    void options;
    if (
      update.botId?.trim() !== this.publisherBotId ||
      update.type.trim().toLowerCase() !== 'message_callback'
    ) {
      return false;
    }

    const callback = extractCallbackNode(update);
    const payload = readBoundedString(callback?.payload ?? callback?.data);
    if (!payload?.startsWith(PUBLISHER_SUGGESTION_ADMIN_CALLBACK_PREFIX)) {
      return false;
    }

    const parsed = parsePublisherSuggestionAdminReviewCallbackPayload(payload);
    const callbackId = readBoundedString(
      callback?.callback_id ?? callback?.callbackId ?? callback?.id,
    );
    const actor = extractReviewActor(callback);
    const privateChatId = extractPrivateChatId(update);
    const messageId = extractCallbackMessageId(update);
    const updateId = readBoundedString(update.updateId);
    if (!parsed || !callbackId || !actor || !privateChatId || !messageId || !updateId) {
      return true;
    }

    await this.queue.enqueueReview({
      suggestionId: parsed.suggestionId,
      requiredBotId: this.publisherBotId,
      action: parsed.action,
      actor,
      callbackId,
      privateChatId,
      messageId,
      webhookEventId,
      updateId,
      dedupeKey: callbackId,
      requestedAt: extractCallbackTimestamp(callback) ?? new Date(),
    });
    return true;
  }
}

export function parsePublisherSuggestionAdminReviewCallbackPayload(
  value: string,
): PublisherSuggestionReviewCallback | null {
  const normalized = value.trim();
  if (!normalized.startsWith(PUBLISHER_SUGGESTION_ADMIN_CALLBACK_PREFIX)) return null;
  const remainder = normalized.slice(PUBLISHER_SUGGESTION_ADMIN_CALLBACK_PREFIX.length);
  const separatorIndex = remainder.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex !== remainder.lastIndexOf(':')) return null;
  const action = remainder.slice(0, separatorIndex);
  const suggestionId = remainder.slice(separatorIndex + 1);
  if (
    (action !== 'publish' && action !== 'cancel') ||
    !PUBLISHER_SUGGESTION_ID_PATTERN.test(suggestionId)
  ) {
    return null;
  }
  return { action, suggestionId };
}

function extractCallbackNode(update: MaxUpdate): Record<string, unknown> | null {
  const raw = asRecord(update.raw);
  const data = asRecord(raw?.data);
  const event = asRecord(raw?.event);
  const candidates = [
    asRecord(raw?.callback),
    asRecord(raw?.message_callback),
    asRecord(data?.callback),
    asRecord(data?.message_callback),
    asRecord(event?.callback),
    asRecord(event?.message_callback),
  ];
  for (const candidate of candidates) {
    const nested = asRecord(candidate?.callback);
    if (nested) return nested;
    if (
      candidate &&
      (candidate.payload !== undefined ||
        candidate.data !== undefined ||
        candidate.callback_id !== undefined ||
        candidate.callbackId !== undefined)
    ) {
      return candidate;
    }
  }
  return null;
}

function extractReviewActor(
  callback: Record<string, unknown> | null,
): PublisherSuggestionAdminReviewActor | null {
  const user = asRecord(callback?.user);
  const userId = normalizePositiveId(user?.user_id ?? user?.userId ?? user?.id);
  if (!user || !userId) return null;
  return {
    userId,
    username: readBoundedString(user.username ?? user.user_name),
    displayName: resolveMaxUserDisplayName(user),
    avatarUrl: readBoundedString(
      user.avatar_url ?? user.avatarUrl ?? user.photo_url ?? user.photoUrl,
    ),
    profileUrl: readBoundedString(user.profile_url ?? user.profileUrl ?? user.link),
  };
}

function extractPrivateChatId(update: MaxUpdate): string | null {
  const normalizedChatId = normalizePositiveId(update.message?.chatId);
  if (normalizedChatId) return normalizedChatId;

  const raw = asRecord(update.raw);
  const message = asRecord(raw?.message);
  const recipient = asRecord(message?.recipient);
  const chatType = readBoundedString(recipient?.chat_type ?? recipient?.chatType)?.toLowerCase();
  if (chatType && chatType !== 'dialog') return null;
  return normalizePositiveId(
    message?.chat_id ?? message?.chatId ?? recipient?.chat_id ?? recipient?.chatId,
  );
}

function extractCallbackMessageId(update: MaxUpdate): string | null {
  const normalizedMessageId = readBoundedString(update.message?.messageId);
  if (normalizedMessageId) return normalizedMessageId;
  const message = asRecord(asRecord(update.raw)?.message);
  return readBoundedString(message?.mid ?? message?.message_id ?? message?.messageId);
}

function extractCallbackTimestamp(callback: Record<string, unknown> | null): Date | null {
  const value = callback?.timestamp;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizePositiveId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return /^[1-9][0-9]{0,30}$/u.test(normalized) ? normalized : null;
}

function readBoundedString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized && normalized.length <= MAX_CALLBACK_VALUE_LENGTH ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
