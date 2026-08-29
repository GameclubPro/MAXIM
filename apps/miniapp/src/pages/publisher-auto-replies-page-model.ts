import type { BroadcastImage } from '@maxim/contracts';
import {
  DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS,
  MAX_PUBLISHER_AUTO_REPLY_IMAGES,
  MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH,
  MAX_PUBLISHER_AUTO_REPLY_TEXT_LENGTH,
  normalizePublisherAutoReplyPhraseDisplay,
  type PublisherAutoReplyAuthoringState,
} from '@maxim/contracts/publisher-auto-replies';
import { ApiRequestError } from '../lib/api-request-error';

export const AUTO_REPLY_TEXT_MAX_LENGTH = MAX_PUBLISHER_AUTO_REPLY_TEXT_LENGTH;
export const AUTO_REPLY_PHRASE_MAX_LENGTH = MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH;
export const AUTO_REPLY_MAX_IMAGES = MAX_PUBLISHER_AUTO_REPLY_IMAGES;
export const AUTO_REPLY_DEFAULT_COOLDOWN_SECONDS = DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS;

export const AUTO_REPLY_COOLDOWN_OPTIONS = [
  { value: 0, label: 'Без паузы' },
  { value: 10, label: '10 секунд' },
  { value: 30, label: '30 секунд' },
  { value: 60, label: '1 минута' },
  { value: 300, label: '5 минут' },
  { value: 900, label: '15 минут' },
] as const;

export type AutoReplyAssetMetadata = {
  id: string;
  fileName: string;
  mimeType: string;
};

export type AutoReplyDraft = {
  phrase: string;
  text: string;
  images: BroadcastImage[];
  retainedAssets: AutoReplyAssetMetadata[];
  cooldownSeconds: number;
  enabled: boolean;
};

export type AutoReplyDraftIssues = {
  phrase?: string;
  content?: string;
};

export function createEmptyAutoReplyDraft(): AutoReplyDraft {
  return {
    phrase: '',
    text: '',
    images: [],
    retainedAssets: [],
    cooldownSeconds: AUTO_REPLY_DEFAULT_COOLDOWN_SECONDS,
    enabled: true,
  };
}

export function normalizeAutoReplyPhrase(value: string): string {
  return normalizePublisherAutoReplyPhraseDisplay(value);
}

export function validateAutoReplyDraft(draft: AutoReplyDraft): AutoReplyDraftIssues {
  const phrase = normalizeAutoReplyPhrase(draft.phrase);
  const issues: AutoReplyDraftIssues = {};

  if (!phrase) {
    issues.phrase = 'Введите кодовую фразу.';
  } else if (phrase.length > AUTO_REPLY_PHRASE_MAX_LENGTH) {
    issues.phrase = `Не больше ${AUTO_REPLY_PHRASE_MAX_LENGTH} символов.`;
  }

  if (!draft.text.trim() && draft.images.length + draft.retainedAssets.length === 0) {
    issues.content = 'Добавьте текст или хотя бы одно фото.';
  } else if (draft.text.length > AUTO_REPLY_TEXT_MAX_LENGTH) {
    issues.content = `Текст длиннее ${AUTO_REPLY_TEXT_MAX_LENGTH} символов.`;
  } else if (draft.images.length + draft.retainedAssets.length > AUTO_REPLY_MAX_IMAGES) {
    issues.content = `Можно добавить до ${AUTO_REPLY_MAX_IMAGES} фото.`;
  }

  return issues;
}

export function isAutoReplyDraftValid(draft: AutoReplyDraft): boolean {
  return Object.keys(validateAutoReplyDraft(draft)).length === 0;
}

export function normalizeAutoReplyDraft(draft: AutoReplyDraft): AutoReplyDraft {
  return {
    ...draft,
    phrase: normalizeAutoReplyPhrase(draft.phrase),
    text: draft.text.replace(/\r\n?/gu, '\n'),
    images: draft.images.slice(0, AUTO_REPLY_MAX_IMAGES),
    retainedAssets: draft.retainedAssets.slice(0, AUTO_REPLY_MAX_IMAGES),
    cooldownSeconds: AUTO_REPLY_COOLDOWN_OPTIONS.some(
      (option) => option.value === draft.cooldownSeconds,
    )
      ? draft.cooldownSeconds
      : AUTO_REPLY_DEFAULT_COOLDOWN_SECONDS,
  };
}

export function areAutoReplyDraftsEqual(left: AutoReplyDraft, right: AutoReplyDraft): boolean {
  return (
    JSON.stringify(normalizeAutoReplyDraft(left)) === JSON.stringify(normalizeAutoReplyDraft(right))
  );
}

export function buildPublisherChatModulesRoute(chatId: string): string {
  return `/publisher/chat/${encodeURIComponent(chatId)}`;
}

export function isAutoReplyConflictError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409;
}

export function getAutoReplyCooldownLabel(seconds: number): string {
  return (
    AUTO_REPLY_COOLDOWN_OPTIONS.find((option) => option.value === seconds)?.label ??
    `${seconds} сек.`
  );
}

export function isActiveAutoReplyAuthoringState(
  state: PublisherAutoReplyAuthoringState | null | undefined,
): boolean {
  return Boolean(state && !['completed', 'canceled', 'failed', 'expired'].includes(state));
}

export function getAutoReplyAuthoringStateLabel(state: PublisherAutoReplyAuthoringState): string {
  if (state === 'awaiting_start') {
    return 'Можно начать в диалоге';
  }
  if (state === 'awaiting_phrase') {
    return 'Публик ждёт кодовую фразу';
  }
  if (state === 'awaiting_content') {
    return 'Публик ждёт текст или фото';
  }
  if (state === 'processing') {
    return 'Публик обрабатывает сообщение';
  }
  if (state === 'review') {
    return 'Осталось подтвердить автоответ';
  }
  if (state === 'saving') {
    return 'Автоответ сохраняется';
  }
  if (state === 'completed') {
    return 'Автоответ создан';
  }
  if (state === 'failed') {
    return 'Создание не завершено';
  }
  if (state === 'expired') {
    return 'Сессия истекла';
  }
  return 'Создание отменено';
}
