import type { BroadcastImage, BroadcastLinkButton } from '@maxim/contracts';
import {
  DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS,
  MAX_PUBLISHER_AUTO_REPLY_BUTTONS,
  MAX_PUBLISHER_AUTO_REPLY_IMAGES,
  MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH,
  MAX_PUBLISHER_AUTO_REPLY_PHRASES,
  MAX_PUBLISHER_AUTO_REPLY_PHRASES_TOTAL_LENGTH,
  MAX_PUBLISHER_AUTO_REPLY_TEXT_LENGTH,
  normalizePublisherAutoReplyPhrase,
  normalizePublisherAutoReplyPhraseDisplay,
  publisherAutoReplyButtonSchema,
  type PublisherAutoReplyAuthoringState,
} from '@maxim/contracts/publisher-auto-replies';
import { ApiRequestError } from '../lib/api-request-error';

export const AUTO_REPLY_TEXT_MAX_LENGTH = MAX_PUBLISHER_AUTO_REPLY_TEXT_LENGTH;
export const AUTO_REPLY_PHRASE_MAX_LENGTH = MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH;
export const AUTO_REPLY_MAX_PHRASES = MAX_PUBLISHER_AUTO_REPLY_PHRASES;
export const AUTO_REPLY_PHRASES_TOTAL_MAX_LENGTH = MAX_PUBLISHER_AUTO_REPLY_PHRASES_TOTAL_LENGTH;
export const AUTO_REPLY_MAX_IMAGES = MAX_PUBLISHER_AUTO_REPLY_IMAGES;
export const AUTO_REPLY_MAX_BUTTONS = MAX_PUBLISHER_AUTO_REPLY_BUTTONS;
export const AUTO_REPLY_DEFAULT_COOLDOWN_SECONDS = DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS;
export const AUTO_REPLY_FUZZY_MIN_ALNUM_COUNT = 5;

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
  phrases: string[];
  matchInContext: boolean;
  fuzzyMatch: boolean;
  text: string;
  images: BroadcastImage[];
  retainedAssets: AutoReplyAssetMetadata[];
  buttons: BroadcastLinkButton[];
  cooldownSeconds: number;
  enabled: boolean;
};

export type AutoReplyDraftIssues = {
  phrases?: string;
  fuzzyMatch?: string;
  content?: string;
  buttons?: string;
};

export function createEmptyAutoReplyDraft(): AutoReplyDraft {
  return {
    phrases: [],
    matchInContext: false,
    fuzzyMatch: false,
    text: '',
    images: [],
    retainedAssets: [],
    buttons: [],
    cooldownSeconds: AUTO_REPLY_DEFAULT_COOLDOWN_SECONDS,
    enabled: true,
  };
}

export function normalizeAutoReplyPhrase(value: string): string {
  return normalizePublisherAutoReplyPhraseDisplay(value);
}

export function normalizeAutoReplyPhrases(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const phrases: string[] = [];

  for (const value of values) {
    const display = normalizeAutoReplyPhrase(value);
    const normalized = normalizePublisherAutoReplyPhrase(display);
    if (!display || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    phrases.push(display);
  }

  return phrases.slice(0, AUTO_REPLY_MAX_PHRASES);
}

export function splitAutoReplyPhrasePaste(value: string): string[] {
  return value.replace(/\r\n?/gu, '\n').split('\n').map(normalizeAutoReplyPhrase).filter(Boolean);
}

export function mergeAutoReplyPhrases(
  current: readonly string[],
  candidates: readonly string[],
): { phrases: string[]; issue?: string } {
  const phrases = normalizeAutoReplyPhrases(current);
  const seen = new Set(phrases.map(normalizePublisherAutoReplyPhrase));

  for (const candidate of candidates) {
    const display = normalizeAutoReplyPhrase(candidate);
    if (!display) {
      return { phrases, issue: 'Введите фразу.' };
    }
    const normalized = normalizePublisherAutoReplyPhrase(display);
    if (
      display.length > AUTO_REPLY_PHRASE_MAX_LENGTH ||
      Array.from(normalized).length > AUTO_REPLY_PHRASE_MAX_LENGTH
    ) {
      return {
        phrases,
        issue: `Каждая фраза — не больше ${AUTO_REPLY_PHRASE_MAX_LENGTH} символов.`,
      };
    }
    if (seen.has(normalized)) {
      return { phrases, issue: 'Такая фраза уже добавлена.' };
    }
    if (phrases.length >= AUTO_REPLY_MAX_PHRASES) {
      return { phrases, issue: `Можно добавить до ${AUTO_REPLY_MAX_PHRASES} фраз.` };
    }
    phrases.push(display);
    seen.add(normalized);
  }

  const totalLength = phrases.reduce(
    (total, phrase) => total + Array.from(normalizePublisherAutoReplyPhrase(phrase)).length,
    0,
  );
  return totalLength > AUTO_REPLY_PHRASES_TOTAL_MAX_LENGTH
    ? {
        phrases: normalizeAutoReplyPhrases(current),
        issue: `Суммарно во фразах — не больше ${AUTO_REPLY_PHRASES_TOTAL_MAX_LENGTH} символов.`,
      }
    : { phrases };
}

export function countAutoReplyPhraseAlnum(value: string): number {
  return Array.from(normalizePublisherAutoReplyPhrase(value).matchAll(/[\p{L}\p{M}\p{N}]/gu))
    .length;
}

export function validateAutoReplyTriggerDraft(draft: AutoReplyDraft): AutoReplyDraftIssues {
  const phrases = normalizeAutoReplyPhrases(draft.phrases);
  const issues: AutoReplyDraftIssues = {};

  if (phrases.length === 0) {
    issues.phrases = 'Добавьте хотя бы одну фразу.';
  } else if (draft.phrases.length > AUTO_REPLY_MAX_PHRASES) {
    issues.phrases = `Можно добавить до ${AUTO_REPLY_MAX_PHRASES} фраз.`;
  } else if (
    phrases.some(
      (phrase) =>
        phrase.length > AUTO_REPLY_PHRASE_MAX_LENGTH ||
        Array.from(normalizePublisherAutoReplyPhrase(phrase)).length > AUTO_REPLY_PHRASE_MAX_LENGTH,
    )
  ) {
    issues.phrases = `Каждая фраза — не больше ${AUTO_REPLY_PHRASE_MAX_LENGTH} символов.`;
  } else if (
    phrases.reduce(
      (total, phrase) => total + Array.from(normalizePublisherAutoReplyPhrase(phrase)).length,
      0,
    ) > AUTO_REPLY_PHRASES_TOTAL_MAX_LENGTH
  ) {
    issues.phrases = `Суммарно во фразах — не больше ${AUTO_REPLY_PHRASES_TOTAL_MAX_LENGTH} символов.`;
  } else if (phrases.length !== draft.phrases.length) {
    issues.phrases = 'Удалите пустые или повторяющиеся фразы.';
  }

  if (
    draft.fuzzyMatch &&
    phrases.some((phrase) => countAutoReplyPhraseAlnum(phrase) < AUTO_REPLY_FUZZY_MIN_ALNUM_COUNT)
  ) {
    issues.fuzzyMatch = `Для опечаток в каждой фразе нужно минимум ${AUTO_REPLY_FUZZY_MIN_ALNUM_COUNT} букв или цифр.`;
  }

  return issues;
}

export function validateAutoReplyDraft(draft: AutoReplyDraft): AutoReplyDraftIssues {
  const issues = validateAutoReplyTriggerDraft(draft);

  if (!draft.text.trim() && draft.images.length + draft.retainedAssets.length === 0) {
    issues.content = 'Добавьте текст или хотя бы одно фото.';
  } else if (draft.text.length > AUTO_REPLY_TEXT_MAX_LENGTH) {
    issues.content = `Текст длиннее ${AUTO_REPLY_TEXT_MAX_LENGTH} символов.`;
  } else if (draft.images.length + draft.retainedAssets.length > AUTO_REPLY_MAX_IMAGES) {
    issues.content = `Можно добавить до ${AUTO_REPLY_MAX_IMAGES} фото.`;
  }

  if (
    draft.buttons.length > AUTO_REPLY_MAX_BUTTONS ||
    draft.buttons.some(
      (button, index) =>
        !publisherAutoReplyButtonSchema.safeParse({ ...button, row: index }).success,
    )
  ) {
    issues.buttons = 'Проверьте названия и ссылки кнопок.';
  }

  return issues;
}

export function isAutoReplyDraftValid(draft: AutoReplyDraft): boolean {
  return Object.keys(validateAutoReplyDraft(draft)).length === 0;
}

export function normalizeAutoReplyDraft(draft: AutoReplyDraft): AutoReplyDraft {
  return {
    ...draft,
    phrases: normalizeAutoReplyPhrases(draft.phrases),
    text: draft.text.replace(/\r\n?/gu, '\n'),
    images: draft.images.slice(0, AUTO_REPLY_MAX_IMAGES),
    retainedAssets: draft.retainedAssets.slice(0, AUTO_REPLY_MAX_IMAGES),
    buttons: draft.buttons.slice(0, AUTO_REPLY_MAX_BUTTONS).map((button) => ({
      text: button.text.trim(),
      url: button.url.trim(),
    })),
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

export function isAutoReplyAuthoringConflictError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409;
}

const AUTO_REPLY_VERSION_CONFLICT_CODES = new Set([
  'VERSION_CONFLICT',
  'PUBLISHER_AUTO_REPLY_VERSION_CONFLICT',
]);
const AUTO_REPLY_PHRASE_CONFLICT_CODES = new Set([
  'PHRASE_CONFLICT',
  'PUBLISHER_AUTO_REPLY_PHRASE_CONFLICT',
]);
const AUTO_REPLY_CLIENT_UPGRADE_REQUIRED_CODES = new Set([
  'CLIENT_UPGRADE_REQUIRED',
  'PUBLISHER_AUTO_REPLY_CLIENT_UPGRADE_REQUIRED',
]);

export type AutoReplyConflictKind =
  | 'version_conflict'
  | 'phrase_conflict'
  | 'client_upgrade_required'
  | null;

export function getAutoReplyConflictKind(error: unknown): AutoReplyConflictKind {
  if (!(error instanceof ApiRequestError) || error.status !== 409 || !error.code) {
    return null;
  }
  if (AUTO_REPLY_VERSION_CONFLICT_CODES.has(error.code)) {
    return 'version_conflict';
  }
  if (AUTO_REPLY_PHRASE_CONFLICT_CODES.has(error.code)) {
    return 'phrase_conflict';
  }
  return AUTO_REPLY_CLIENT_UPGRADE_REQUIRED_CODES.has(error.code)
    ? 'client_upgrade_required'
    : null;
}

export function getAutoReplyMatchModeLabel({
  matchInContext,
  fuzzyMatch,
}: Pick<AutoReplyDraft, 'matchInContext' | 'fuzzyMatch'>): string {
  if (matchInContext && fuzzyMatch) {
    return 'Внутри сообщения · с опечатками';
  }
  if (matchInContext) {
    return 'Внутри сообщения';
  }
  if (fuzzyMatch) {
    return 'Сообщение целиком · с опечатками';
  }
  return 'Точное сообщение';
}

export function getAutoReplyPhraseCountLabel(count: number): string {
  const absolute = Math.abs(count);
  const mod100 = absolute % 100;
  const mod10 = absolute % 10;
  const noun =
    mod100 >= 11 && mod100 <= 14
      ? 'фраз'
      : mod10 === 1
        ? 'фраза'
        : mod10 >= 2 && mod10 <= 4
          ? 'фразы'
          : 'фраз';
  return `${count} ${noun}`;
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
