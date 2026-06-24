import {
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
  type BroadcastLinkButton,
  type BroadcastTargetMode,
} from '@maxim/contracts';
import { DEFAULT_BROADCAST_DRAFT } from './private-control.constants';
import {
  normalizeIncomingMessageMarkup,
  type IncomingMessageMarkup,
} from './private-control-markup-importer';
import { toPrivateControlPositiveInt } from './private-control-session-normalizer';
import type {
  PrivateBroadcastDraft,
  PrivateSuggestionDraft,
  PrivateSuggestionImageDraft,
  PrivateSuggestionMediaDraft,
  PrivateSuggestionVideoDraft,
} from './private-control.types';

export function clonePrivateBroadcastDraft(draft: PrivateBroadcastDraft): PrivateBroadcastDraft {
  return {
    ...draft,
    buttons: draft.buttons.map((button) => ({ ...button })),
    targetChatIds: [...draft.targetChatIds],
    scheduledSlots: [...draft.scheduledSlots],
    mediaPayload: draft.mediaPayload ? { ...draft.mediaPayload } : null,
  };
}

export function normalizePrivateBroadcastTargetChatIds(
  targetChatIds: readonly string[],
  fallbackChatId?: string | null,
): string[] {
  const normalized = Array.from(
    new Set(
      targetChatIds.map((item) => item.trim()).filter((item): item is string => item.length > 0),
    ),
  );
  if (normalized.length > 0) {
    return normalized;
  }

  return fallbackChatId?.trim() ? [fallbackChatId.trim()] : [];
}

export function resolvePrivateBroadcastDraftTargetState(params: {
  targetMode?: BroadcastTargetMode;
  targetChatIds?: readonly string[];
  applyToAllChats?: boolean;
  fallbackChatId?: string | null;
}): {
  targetMode: BroadcastTargetMode;
  targetChatIds: string[];
  applyToAllChats: boolean;
} {
  const targetChatIds = normalizePrivateBroadcastTargetChatIds(
    params.targetChatIds ?? [],
    params.targetMode === 'current' ? params.fallbackChatId : undefined,
  );
  let targetMode: BroadcastTargetMode;

  if (params.targetMode === 'all' || params.applyToAllChats) {
    targetMode = 'all';
  } else if (params.targetMode === 'selected') {
    targetMode = 'selected';
  } else if (targetChatIds.length > 0) {
    const fallbackChatId = params.fallbackChatId?.trim() ?? '';
    targetMode =
      fallbackChatId && targetChatIds.length === 1 && targetChatIds[0] === fallbackChatId
        ? 'current'
        : 'selected';
  } else {
    targetMode = 'current';
  }

  return {
    targetMode,
    targetChatIds,
    applyToAllChats: targetMode === 'all',
  };
}

export function normalizePrivateBroadcastDraft(raw: unknown): PrivateBroadcastDraft {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_BROADCAST_DRAFT,
    };
  }

  const row = raw as Partial<PrivateBroadcastDraft>;
  const buttons = Array.isArray(row.buttons)
    ? row.buttons
        .filter((item): item is BroadcastLinkButton => {
          if (!item || typeof item !== 'object') {
            return false;
          }

          const candidate = item as { text?: unknown; url?: unknown };
          return (
            typeof candidate.url === 'string' &&
            candidate.url.trim().length > 0 &&
            typeof candidate.text === 'string'
          );
        })
        .map((item) => ({
          text: item.text.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
          url: item.url.trim(),
        }))
    : row.buttonEnabled === true &&
        typeof row.buttonUrl === 'string' &&
        row.buttonUrl.trim().length > 0
      ? [
          {
            text:
              typeof row.buttonText === 'string' && row.buttonText.trim().length > 0
                ? row.buttonText.trim()
                : DEFAULT_BROADCAST_BUTTON_TEXT,
            url: row.buttonUrl.trim(),
          },
        ]
      : [];
  const primaryButton = buttons[0];
  const targetState = resolvePrivateBroadcastDraftTargetState({
    targetMode: row.targetMode,
    targetChatIds: Array.isArray(row.targetChatIds)
      ? row.targetChatIds.filter((item): item is string => typeof item === 'string')
      : [],
    applyToAllChats: row.applyToAllChats === true,
  });
  const mediaPayload =
    row.mediaPayload && typeof row.mediaPayload === 'object' && !Array.isArray(row.mediaPayload)
      ? (row.mediaPayload as Record<string, unknown>)
      : null;
  const mediaType = row.mediaType === 'video' && mediaPayload ? 'video' : null;

  return {
    text: typeof row.text === 'string' ? row.text : '',
    textFormat: row.textFormat === 'markdown' ? 'markdown' : 'plain',
    targetMode: targetState.targetMode,
    targetChatIds: targetState.targetChatIds,
    applyToAllChats: targetState.applyToAllChats,
    buttons,
    buttonEnabled: buttons.length > 0,
    buttonUrl: primaryButton?.url ?? '',
    buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
    imageEnabled: mediaType ? false : row.imageEnabled === true,
    imageBase64: mediaType ? '' : typeof row.imageBase64 === 'string' ? row.imageBase64 : '',
    imageMimeType: mediaType ? '' : typeof row.imageMimeType === 'string' ? row.imageMimeType : '',
    imageFileName: mediaType ? '' : typeof row.imageFileName === 'string' ? row.imageFileName : '',
    mediaType,
    mediaPayload: mediaType ? mediaPayload : null,
    mediaMimeType: mediaType && typeof row.mediaMimeType === 'string' ? row.mediaMimeType : '',
    mediaFileName: mediaType && typeof row.mediaFileName === 'string' ? row.mediaFileName : '',
    scheduleMode: row.scheduleMode === 'calendar' ? 'calendar' : 'legacy',
    scheduleTimezone:
      typeof row.scheduleTimezone === 'string' && row.scheduleTimezone.trim().length > 0
        ? row.scheduleTimezone.trim()
        : DEFAULT_BROADCAST_DRAFT.scheduleTimezone,
    scheduledSlots: Array.isArray(row.scheduledSlots)
      ? Array.from(
          new Set(
            row.scheduledSlots
              .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
              .map((item) => item.trim()),
          ),
        ).sort((left, right) => left.localeCompare(right))
      : [],
    sendAt: typeof row.sendAt === 'string' ? row.sendAt : null,
    cycleEnabled: row.cycleEnabled === true,
    cycleEveryHours: toPrivateControlPositiveInt(
      (row as Partial<PrivateBroadcastDraft> & { cycleEveryDays?: unknown }).cycleEveryHours ??
        (typeof (row as { cycleEveryDays?: unknown }).cycleEveryDays === 'number'
          ? Number((row as { cycleEveryDays?: unknown }).cycleEveryDays) * 24
          : undefined),
      24,
    ),
    cycleCount: toPrivateControlPositiveInt(row.cycleCount, 1),
  };
}

export function normalizePrivateSuggestionDraft(raw: unknown): PrivateSuggestionDraft | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const row = raw as Partial<PrivateSuggestionDraft>;
  const rawRow = row as Record<string, unknown>;
  const chatId = typeof row.chatId === 'string' ? row.chatId.trim() : '';
  const token = typeof row.token === 'string' ? row.token.trim() : '';

  if (!chatId || !token) {
    return null;
  }

  const images = normalizeSuggestionImageDrafts(rawRow.images);
  const legacyMedia = normalizeSuggestionMediaDraft(rawRow.media);
  const video =
    normalizeSuggestionVideoDraft(rawRow.video) ??
    (legacyMedia?.kind === 'video' ? legacyMedia : null);
  const normalizedImages =
    images.length > 0 ? images : legacyMedia?.kind === 'image' ? [legacyMedia] : [];
  const textMarkup = normalizeSuggestionTextMarkup(rawRow.textMarkup);

  return {
    chatId,
    token,
    text: typeof row.text === 'string' ? row.text : '',
    textFormat: row.textFormat === 'markdown' ? 'markdown' : 'plain',
    textMarkup,
    images: normalizedImages,
    video,
    imageBase64: typeof row.imageBase64 === 'string' ? row.imageBase64 : '',
    imageMimeType: typeof row.imageMimeType === 'string' ? row.imageMimeType : '',
    imageFileName: typeof row.imageFileName === 'string' ? row.imageFileName : '',
    sourceMessageId:
      typeof row.sourceMessageId === 'string' && row.sourceMessageId.trim().length > 0
        ? row.sourceMessageId.trim()
        : null,
    previewMessageId:
      typeof row.previewMessageId === 'string' && row.previewMessageId.trim().length > 0
        ? row.previewMessageId.trim()
        : null,
  };
}

function normalizeSuggestionMediaDraft(raw: unknown): PrivateSuggestionMediaDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const row = raw as Record<string, unknown>;
  const kind = row.kind === 'video' ? 'video' : row.kind === 'image' ? 'image' : null;
  const mimeType = typeof row.mimeType === 'string' ? row.mimeType.trim() : '';
  const fileName = typeof row.fileName === 'string' ? row.fileName.trim() : '';
  const payload =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;

  if (!kind || !mimeType || !fileName || !payload || Object.keys(payload).length === 0) {
    return null;
  }

  return {
    kind,
    mimeType,
    fileName,
    payload,
  };
}

function normalizeSuggestionImageDrafts(raw: unknown): PrivateSuggestionImageDraft[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => normalizeSuggestionMediaDraft(item))
    .filter((item): item is PrivateSuggestionImageDraft => item?.kind === 'image')
    .slice(0, MAX_CHANNEL_DIALOG_SUGGEST_IMAGES);
}

function normalizeSuggestionVideoDraft(raw: unknown): PrivateSuggestionVideoDraft | null {
  const media = normalizeSuggestionMediaDraft(raw);
  return media?.kind === 'video' ? media : null;
}

function normalizeSuggestionTextMarkup(raw: unknown): IncomingMessageMarkup[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => normalizeIncomingMessageMarkup(item))
    .filter((item): item is IncomingMessageMarkup => item !== null);
}
