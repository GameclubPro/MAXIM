import type { ManagedAutopostPayload, ManagedAutopostRuleSummary } from '@maxim/contracts';
import type { SendBroadcastPayload } from './api/shared-types';
import { formatRussianCountLabel } from './broadcast-audience';
import { formatBroadcastButtonsStatus } from './broadcast-link-buttons';

export function formatCompactCountLabel(count: number, label: string): string {
  return `${Math.max(0, Math.trunc(count))} ${label}`;
}

export function sortManagedAutopostRules(
  rules: readonly ManagedAutopostRuleSummary[],
): ManagedAutopostRuleSummary[] {
  const priority = (rule: ManagedAutopostRuleSummary): number => {
    if (rule.status === 'ERROR') {
      return 0;
    }
    if (rule.status === 'ACTIVE') {
      return 1;
    }
    if (rule.status === 'PAUSED') {
      return 2;
    }
    return 3;
  };
  const parseTimestamp = (value: string | null): number => {
    if (!value) {
      return Number.MAX_SAFE_INTEGER;
    }
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };

  return [...rules].sort((left, right) => {
    const priorityDiff = priority(left) - priority(right);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    const nextDiff = parseTimestamp(left.nextSendAt) - parseTimestamp(right.nextSendAt);
    if (nextDiff !== 0) {
      return nextDiff;
    }
    return parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt);
  });
}

export function buildManagedAutopostRuleFacts(
  rule: ManagedAutopostRuleSummary,
  currentLabel: string,
): string[] {
  const scopeLabel =
    rule.targetMode === 'all'
      ? 'Все чаты'
      : rule.targetChats > 1
        ? formatRussianCountLabel(rule.targetChats, 'чат', 'чата', 'чатов')
        : currentLabel;

  return [
    scopeLabel,
    formatRussianCountLabel(rule.scheduledSlots.length, 'публикация', 'публикации', 'публикаций'),
    rule.buttons.length > 0 ? formatBroadcastButtonsStatus(rule.buttons) : null,
    rule.hasVideo
      ? 'Видео'
      : rule.hasImage
        ? rule.imageCount > 1
          ? `${rule.imageCount} фото`
          : 'Фото'
        : null,
  ].filter((item): item is string => Boolean(item));
}

export function normalizeManagedAutopostPayload(
  payload: SendBroadcastPayload,
): ManagedAutopostPayload {
  return {
    ...payload,
    images: payload.images ?? [],
    mediaType: payload.mediaType ?? null,
    mediaPayload: payload.mediaPayload ?? null,
    mediaMimeType: payload.mediaMimeType ?? '',
    mediaFileName: payload.mediaFileName ?? '',
    scheduleMode: 'calendar',
    sendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
  };
}
