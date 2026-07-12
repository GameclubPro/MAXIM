import type {
  BroadcastImage,
  BroadcastLinkButton,
  ChatSummary,
  ManagedEntityType,
} from '@maxim/contracts';
import type {
  CreatePublicationRequest,
  PublicationAsset,
  PublicationContentInput,
  PublicationDetails,
  PublicationLifecycle,
  PublicationScheduleInput,
  TestPublicationRequest,
  UpdatePublicationRequest,
} from '@maxim/contracts/publication';
import { trimBroadcastLinkButtons } from '../../lib/broadcast-link-buttons';
import {
  formatLocalDateTimeInputValue,
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
} from '../../lib/broadcast-schedule';

export type PublicationView = 'plan' | 'schedules' | 'history';
export type PublicationEditorKind = 'create' | 'edit' | 'duplicate';
export type PublicationTimingMode = 'now' | 'once' | 'schedule';
export type PublicationScheduleKind = 'slots' | 'recurrence';
export type PublicationRecurrenceFrequency = 'daily' | 'weekly';
export type PublicationEntityFilter = 'all' | ManagedEntityType;
export type PublicationStatusFilter = 'all' | 'active' | 'paused' | 'completed' | 'failed';

export type PublicationSaveFeedback = {
  tone: 'success' | 'info' | 'danger';
  title: string;
  description?: string;
  notification: 'success' | 'warning' | 'error';
};

export type PublicationTarget = {
  id: string;
  entityType: ManagedEntityType;
  title: string;
  avatarUrl: string | null;
};

export function getPublicationTargetTitle(
  target: Pick<PublicationTarget, 'entityType' | 'title'>,
): string {
  const title = target.title.trim();
  if (title) {
    return title;
  }
  return target.entityType === 'channel' ? 'Канал' : 'Чат';
}

export type PublicationDraft = {
  title: string;
  text: string;
  images: BroadcastImage[];
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  targets: PublicationTarget[];
  timingMode: PublicationTimingMode;
  scheduleKind: PublicationScheduleKind;
  scheduledSlots: string[];
  onceDate: string;
  onceTime: string;
  scheduleTimezone: string;
  recurrence: PublicationRecurrenceDraft;
  mediaType: 'image' | 'video' | null;
  mediaPayload: Record<string, unknown> | null;
  mediaBase64: string;
  mediaMimeType: string;
  mediaFileName: string;
  retainedAssets: PublicationAsset[];
};

export type PublicationRecurrenceDraft = {
  frequency: PublicationRecurrenceFrequency;
  interval: number;
  weekdays: number[];
  times: string[];
  startsAt: string | null;
  endsAt: string | null;
  maxOccurrences: number | null;
};

export const PUBLICATION_TEXT_MAX_LENGTH = 2_000;
export const PUBLICATION_MIN_SCHEDULE_DELAY_MS = 2 * 60_000;
const PUBLICATION_SCHEDULE_CONFLICT_CODE = 'PUBLICATION_SCHEDULE_CONFLICT';

const PUBLICATION_VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  qt: 'video/quicktime',
  webm: 'video/webm',
};

export function isIsolatedPublicationEditor(kind: PublicationEditorKind | null): boolean {
  return kind === 'edit' || kind === 'duplicate';
}

export function shouldPersistPublicationDraft(kind: PublicationEditorKind | null): boolean {
  return !isIsolatedPublicationEditor(kind);
}

export function canResumePublication(lifecycle: PublicationLifecycle): boolean {
  return lifecycle === 'PAUSED';
}

export function buildPublicationSaveFeedback(
  publication: Pick<PublicationDetails, 'delivery'>,
  options: {
    editorKind: PublicationEditorKind | null;
    timingMode: PublicationTimingMode;
  },
): PublicationSaveFeedback {
  if (options.editorKind === 'edit') {
    return {
      tone: 'success',
      title: 'Публикация обновлена',
      notification: 'success',
    };
  }
  if (options.timingMode === 'once') {
    return {
      tone: 'success',
      title: 'Публикация запланирована',
      notification: 'success',
    };
  }
  if (options.timingMode === 'schedule') {
    return {
      tone: 'success',
      title: 'Расписание сохранено',
      notification: 'success',
    };
  }

  const delivery = publication.delivery;
  if (delivery.ambiguous > 0) {
    return {
      tone: 'info',
      title: 'Отправка требует проверки',
      description: 'MAX мог принять сообщение без подтверждения. Проверьте детали публикации.',
      notification: 'warning',
    };
  }
  const undelivered = delivery.failed + delivery.canceled;
  if (undelivered > 0 && delivery.pending === 0) {
    return {
      tone: 'danger',
      title: 'Не все сообщения отправлены',
      description: `Доставлено: ${delivery.sent}/${delivery.total}, не доставлено: ${undelivered}.`,
      notification: 'error',
    };
  }
  if (delivery.total > 0 && delivery.sent === delivery.total) {
    return {
      tone: 'success',
      title: 'Публикация отправлена',
      description: `Доставлено: ${delivery.sent}/${delivery.total}.`,
      notification: 'success',
    };
  }
  if (undelivered > 0) {
    return {
      tone: 'info',
      title: 'Отправка продолжается',
      description: `Доставлено: ${delivery.sent}/${delivery.total}, не доставлено: ${undelivered}.`,
      notification: 'warning',
    };
  }
  return {
    tone: 'info',
    title: 'Начинаем отправку',
    description: 'Результат появится в списке постов после ответа MAX.',
    notification: 'success',
  };
}

export function isPublicationScheduleConflictMessage(message: string): boolean {
  const normalized = message.trim().toLocaleLowerCase('ru-RU');
  return (
    (normalized.includes('врем') &&
      (normalized.includes('занят') || normalized.includes('уже заплан'))) ||
    (normalized.includes('расписан') && normalized.includes('пересеч'))
  );
}

export function isPublicationScheduleConflictError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code === PUBLICATION_SCHEDULE_CONFLICT_CODE;
    }
  }

  return error instanceof Error && isPublicationScheduleConflictMessage(error.message);
}

export function shouldReviewPublicationScheduleConflict(
  error: unknown,
  draft: Pick<PublicationDraft, 'timingMode' | 'scheduleKind'>,
  replaceConflicts: boolean,
): boolean {
  return (
    !replaceConflicts && draft.timingMode !== 'now' && isPublicationScheduleConflictError(error)
  );
}

export function inferPublicationVideoMimeType(fileName: string, mimeType: string): string | null {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (normalizedMimeType.startsWith('video/')) {
    return normalizedMimeType;
  }
  if (normalizedMimeType) {
    return null;
  }

  const extension =
    fileName
      .trim()
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/u)?.[1] ?? '';
  return PUBLICATION_VIDEO_MIME_BY_EXTENSION[extension] ?? null;
}

export function toPublicationTarget(source: ChatSummary): PublicationTarget {
  return {
    id: source.id,
    entityType: source.entityType,
    title: getPublicationTargetTitle(source),
    avatarUrl: source.avatarUrl ?? null,
  };
}

export function getPublicationTargetKey(
  target: Pick<PublicationTarget, 'id' | 'entityType'>,
): string {
  return `${target.entityType}:${target.id}`;
}

export function createEmptyPublicationDraft(targets: PublicationTarget[] = []): PublicationDraft {
  return {
    title: '',
    text: '',
    images: [],
    buttons: [],
    buttonEnabled: false,
    targets,
    timingMode: 'now',
    scheduleKind: 'slots',
    scheduledSlots: [],
    onceDate: '',
    onceTime: '',
    scheduleTimezone: resolveBroadcastScheduleTimezone(),
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      weekdays: [],
      times: [],
      startsAt: null,
      endsAt: null,
      maxOccurrences: null,
    },
    mediaType: null,
    mediaPayload: null,
    mediaBase64: '',
    mediaMimeType: '',
    mediaFileName: '',
    retainedAssets: [],
  };
}

export function createPublicationDuplicateDraft(draft: PublicationDraft): PublicationDraft {
  const empty = createEmptyPublicationDraft();
  return {
    ...draft,
    timingMode: 'schedule',
    scheduleKind: 'slots',
    scheduledSlots: [],
    onceDate: '',
    onceTime: '',
    recurrence: empty.recurrence,
  };
}

export function isPublicationDraftEmpty(draft: PublicationDraft): boolean {
  return !(
    draft.title.trim() ||
    draft.text.trim() ||
    draft.images.length > 0 ||
    draft.buttons.some((button) => button.text.trim() || button.url.trim()) ||
    draft.mediaType === 'video'
  );
}

export function buildPublicationContent(draft: PublicationDraft): PublicationContentInput {
  const buttons = (draft.buttonEnabled ? trimBroadcastLinkButtons(draft.buttons) : []).map(
    (button, index) => ({ ...button, row: index }),
  );
  const retainedMedia = draft.retainedAssets.map((asset) =>
    asset.type === 'video'
      ? { type: 'video-ref' as const, assetId: asset.id }
      : { type: 'image-ref' as const, assetId: asset.id },
  );
  const newMedia =
    draft.mediaType === 'video' && (draft.mediaBase64 || draft.mediaPayload)
      ? [
          {
            type: 'video' as const,
            payload: draft.mediaPayload,
            base64: draft.mediaBase64,
            mimeType: draft.mediaMimeType,
            fileName: draft.mediaFileName,
          },
        ]
      : draft.images.map((image) => ({
          type: 'image' as const,
          base64: image.base64,
          mimeType: image.mimeType,
          fileName: image.fileName,
        }));

  return {
    text: draft.text.trim(),
    textFormat: 'markdown',
    buttons,
    media: newMedia.length > 0 ? newMedia : retainedMedia,
  };
}

export function buildPublicationSchedule(
  draft: PublicationDraft,
  replaceConflicts = false,
): PublicationScheduleInput {
  if (draft.timingMode === 'now') {
    return { mode: 'now', timezone: draft.scheduleTimezone };
  }
  if (draft.timingMode === 'once') {
    return {
      mode: 'once',
      timezone: draft.scheduleTimezone,
      at: draft.scheduledSlots[0] ?? '',
      replaceConflicts,
    };
  }
  if (draft.scheduleKind === 'recurrence') {
    return {
      mode: 'recurrence',
      timezone: draft.scheduleTimezone,
      frequency: draft.recurrence.frequency,
      interval: draft.recurrence.interval,
      weekdays: draft.recurrence.frequency === 'weekly' ? draft.recurrence.weekdays : [],
      times: draft.recurrence.times,
      startsAt: draft.recurrence.startsAt,
      endsAt: draft.recurrence.endsAt,
      maxOccurrences: draft.recurrence.maxOccurrences,
      replaceConflicts,
    };
  }
  return {
    mode: 'slots',
    timezone: draft.scheduleTimezone,
    slots: sortAndUniqueBroadcastSlots(draft.scheduledSlots),
    replaceConflicts,
  };
}

export function buildCreatePublicationRequest(
  draft: PublicationDraft,
  requestId: string,
  options: { intent?: 'draft' | 'publish'; replaceConflicts?: boolean } = {},
): CreatePublicationRequest {
  return {
    requestId,
    title: draft.title,
    content: buildPublicationContent(draft),
    audience: {
      selection: 'SELECTED',
      mode: 'SNAPSHOT',
      targets: draft.targets.map((target) => ({
        chatId: target.id,
        entityType: target.entityType,
      })),
    },
    schedule:
      options.intent === 'draft'
        ? null
        : buildPublicationSchedule(draft, options.replaceConflicts ?? false),
    intent: options.intent ?? 'publish',
  };
}

export function buildUpdatePublicationRequest(
  draft: PublicationDraft,
  expectedRevision: number,
  requestId: string,
  replaceConflicts = false,
): UpdatePublicationRequest {
  return {
    expectedRevision,
    requestId,
    title: draft.title,
    content: buildPublicationContent(draft),
    audience: {
      selection: 'SELECTED',
      mode: 'SNAPSHOT',
      targets: draft.targets.map((target) => ({
        chatId: target.id,
        entityType: target.entityType,
      })),
    },
    schedule: buildPublicationSchedule(draft, replaceConflicts),
    intent: 'publish',
  };
}

export function buildTestPublicationRequest(
  draft: PublicationDraft,
  requestId: string,
): TestPublicationRequest {
  const sourceTarget = draft.targets[0];
  return {
    requestId,
    content: buildPublicationContent(draft),
    sourceTarget: {
      chatId: sourceTarget?.id ?? '',
      entityType: sourceTarget?.entityType ?? 'chat',
    },
  };
}

export function createPublicationDraftFromDetails(
  details: PublicationDetails,
  nowMs = Date.now(),
): PublicationDraft {
  const fallback = createEmptyPublicationDraft();
  const schedule = details.schedule;
  const timingMode: PublicationTimingMode =
    !schedule || schedule.mode === 'now' ? 'now' : schedule.mode === 'once' ? 'once' : 'schedule';
  const scheduledSlots =
    schedule?.mode === 'once'
      ? [schedule.at]
      : schedule?.mode === 'slots'
        ? filterFuturePublicationSlots(schedule.slots, nowMs)
        : fallback.scheduledSlots;
  const recurrence =
    schedule?.mode === 'recurrence'
      ? {
          frequency: schedule.frequency,
          interval: schedule.interval,
          weekdays: schedule.weekdays,
          times: schedule.times,
          startsAt: schedule.startsAt,
          endsAt: schedule.endsAt,
          maxOccurrences: schedule.maxOccurrences,
        }
      : fallback.recurrence;
  const onceValue = schedule?.mode === 'once' ? formatLocalDateTimeInputValue(schedule.at) : '';
  const [onceDate = '', onceTime = ''] = onceValue.split('T');

  return {
    ...fallback,
    title: details.title,
    text: details.content.text,
    buttons: details.content.buttons.map(({ text, url }) => ({ text, url })),
    buttonEnabled: details.content.buttons.length > 0,
    targets: details.targets.map((target) => ({
      id: target.chatId,
      entityType: target.entityType,
      title: getPublicationTargetTitle(target),
      avatarUrl: target.avatarUrl,
    })),
    timingMode,
    scheduleKind: schedule?.mode === 'recurrence' ? 'recurrence' : 'slots',
    scheduledSlots: scheduledSlots.length > 0 ? scheduledSlots : fallback.scheduledSlots,
    onceDate,
    onceTime,
    scheduleTimezone: schedule?.timezone ?? fallback.scheduleTimezone,
    recurrence,
    mediaType: null,
    mediaPayload: null,
    mediaBase64: '',
    mediaMimeType: '',
    mediaFileName: '',
    retainedAssets: details.content.media,
  };
}

export function filterFuturePublicationSlots(
  slots: readonly string[],
  nowMs = Date.now(),
): string[] {
  const minTime = nowMs + PUBLICATION_MIN_SCHEDULE_DELAY_MS;
  return sortAndUniqueBroadcastSlots([...slots]).filter((slot) => {
    const parsed = Date.parse(slot);
    return Number.isFinite(parsed) && parsed >= minTime;
  });
}

export function hasFuturePublicationSlot(slots: readonly string[], nowMs = Date.now()): boolean {
  const minTime = nowMs + PUBLICATION_MIN_SCHEDULE_DELAY_MS;
  return slots.some((slot) => {
    const parsed = new Date(slot).getTime();
    return Number.isFinite(parsed) && parsed >= minTime;
  });
}

export function matchesPublicationSearch(
  values: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase('ru-RU');
  if (!normalized) {
    return true;
  }

  return values.some((value) => value?.toLocaleLowerCase('ru-RU').includes(normalized));
}
