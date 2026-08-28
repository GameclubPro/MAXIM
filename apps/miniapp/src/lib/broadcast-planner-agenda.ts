import type {
  ManagedBroadcastCalendarSlot,
  ManagedBroadcastSummary,
  ManagedBroadcastTargetPreview,
} from '@maxim/contracts';
import { formatBroadcastButtonsStatus } from './broadcast-link-buttons';
import { getBroadcastScheduleDayKey, sortAndUniqueBroadcastSlots } from './broadcast-schedule';
import { formatSupportedMarkdownPreview } from './max-markdown';
import { normalizeLegacyMultilineMarkdown } from './max-markdown-multiline';
import { buildSlotsByDay, formatCountLabel } from './broadcast-planner-time';

export type BroadcastScheduleAgendaTone = 'active' | 'warning' | 'danger' | 'muted';

export type BroadcastScheduleAgendaEntry = {
  id: string;
  sourceChatId: string | null;
  dayKey: string;
  title: string;
  previewSource: string;
  statusLabel: string | null;
  tone: BroadcastScheduleAgendaTone;
  timeSlots: string[];
  facts: string[];
  canEdit: boolean;
};

function resolveAgendaTone(status: ManagedBroadcastSummary['status']): BroadcastScheduleAgendaTone {
  if (status === 'FAILED') {
    return 'danger';
  }
  if (status === 'PARTIAL') {
    return 'warning';
  }
  if (status === 'COMPLETED' || status === 'CANCELED') {
    return 'muted';
  }
  return 'active';
}

function resolveAgendaStatusLabel(status: ManagedBroadcastSummary['status']): string | null {
  if (status === 'FAILED') {
    return 'Пауза';
  }
  if (status === 'PARTIAL') {
    return 'Ошибки';
  }
  return null;
}

function formatAgendaAudienceLabel(params: {
  targetMode: ManagedBroadcastSummary['targetMode'];
  targetChats: number;
  targetPreviews?: readonly ManagedBroadcastTargetPreview[];
  targetOverflowCount?: number;
  currentTargetLabel: string;
}): string {
  const firstPreviewTitle = params.targetPreviews?.[0]?.title.trim();
  const overflowCount =
    params.targetOverflowCount ??
    Math.max(0, params.targetChats - (params.targetPreviews?.length ?? 0));
  if (params.targetMode === 'all') {
    return params.targetChats > 0 ? `Все · ${params.targetChats}` : 'Все чаты';
  }

  if (params.targetMode === 'selected') {
    if (firstPreviewTitle) {
      return overflowCount > 0 ? `${firstPreviewTitle} +${overflowCount}` : firstPreviewTitle;
    }
    return formatCountLabel(params.targetChats, 'чат', 'чата', 'чатов');
  }

  return firstPreviewTitle || params.currentTargetLabel;
}

function buildAgendaFacts(
  broadcast: ManagedBroadcastSummary,
  currentTargetLabel: string,
): string[] {
  const audienceLabel = formatAgendaAudienceLabel({
    targetMode: broadcast.targetMode,
    targetChats: broadcast.targetChats,
    targetPreviews: broadcast.targetPreviews,
    targetOverflowCount: broadcast.targetOverflowCount,
    currentTargetLabel,
  });
  return [
    audienceLabel,
    broadcast.hasImage
      ? broadcast.imageCount > 1
        ? `${broadcast.imageCount} фото`
        : 'Фото'
      : null,
    broadcast.buttonEnabled ? formatBroadcastButtonsStatus(broadcast.buttons) : null,
  ].filter((item): item is string => Boolean(item));
}

export function buildAgendaEntries(
  managedBroadcasts: ManagedBroadcastSummary[],
  currentTargetLabel: string,
  excludeBroadcastId: string | null | undefined,
  excludeAutopostRuleId: string | null | undefined = null,
): BroadcastScheduleAgendaEntry[] {
  const entries: BroadcastScheduleAgendaEntry[] = [];

  for (const broadcast of managedBroadcasts) {
    if (excludeBroadcastId && broadcast.id === excludeBroadcastId) {
      continue;
    }
    if (excludeAutopostRuleId && broadcast.autopostRuleId === excludeAutopostRuleId) {
      continue;
    }

    for (const [dayKey, timeSlots] of buildSlotsByDay(broadcast.scheduledSlots)) {
      entries.push({
        id: broadcast.id,
        sourceChatId: null,
        dayKey,
        title:
          formatSupportedMarkdownPreview(
            normalizeLegacyMultilineMarkdown(broadcast.textPreview),
            120,
          ) ||
          (broadcast.hasImage ? 'Фото без текста' : broadcast.textPreview),
        previewSource: broadcast.textPreview,
        statusLabel: resolveAgendaStatusLabel(broadcast.status),
        tone: resolveAgendaTone(broadcast.status),
        timeSlots,
        facts: buildAgendaFacts(broadcast, currentTargetLabel),
        canEdit: broadcast.scheduleMode === 'calendar',
      });
    }
  }

  return entries.sort((left, right) => {
    const dayDiff = left.dayKey.localeCompare(right.dayKey);
    if (dayDiff !== 0) {
      return dayDiff;
    }

    const leftTime = new Date(left.timeSlots[0] ?? '').getTime();
    const rightTime = new Date(right.timeSlots[0] ?? '').getTime();
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.title.localeCompare(right.title, 'ru');
  });
}

export function buildAgendaEntriesFromCalendarSlots(
  calendarSlots: ManagedBroadcastCalendarSlot[],
  sourceChatId: string | null | undefined,
  currentTargetLabel: string,
  excludeBroadcastId: string | null | undefined,
  excludeAutopostRuleId: string | null | undefined = null,
): BroadcastScheduleAgendaEntry[] {
  const grouped = new Map<string, ManagedBroadcastCalendarSlot[]>();
  for (const slot of calendarSlots) {
    if (excludeBroadcastId && slot.broadcastId === excludeBroadcastId) {
      continue;
    }
    if (excludeAutopostRuleId && slot.autopostRuleId === excludeAutopostRuleId) {
      continue;
    }
    const key = `${slot.broadcastId}:${getBroadcastScheduleDayKey(slot.scheduledAt)}`;
    const current = grouped.get(key) ?? [];
    current.push(slot);
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((slots) => {
      const firstSlot = slots[0];
      const timeSlots = sortAndUniqueBroadcastSlots(slots.map((slot) => slot.scheduledAt));
      const dayKey = getBroadcastScheduleDayKey(timeSlots[0] ?? firstSlot?.scheduledAt ?? '');
      const targetMode = firstSlot?.targetMode ?? 'current';
      const targetChats = firstSlot?.targetChats ?? 1;
      const targetPreviews = firstSlot?.hasTargetOverlap
        ? firstSlot.overlapPreviews
        : (firstSlot?.targetPreviews ?? []);
      const targetOverflowCount = firstSlot?.hasTargetOverlap
        ? firstSlot.overlapOverflowCount
        : firstSlot?.targetOverflowCount;

      return {
        id: firstSlot?.broadcastId ?? dayKey,
        sourceChatId: firstSlot?.sourceChatId ?? null,
        dayKey,
        title:
          formatSupportedMarkdownPreview(
            normalizeLegacyMultilineMarkdown(firstSlot?.textPreview ?? ''),
            120,
          ) ||
          firstSlot?.textPreview ||
          'Автопостинг',
        previewSource: firstSlot?.textPreview ?? '',
        statusLabel: firstSlot ? resolveAgendaStatusLabel(firstSlot.status) : null,
        tone: firstSlot ? resolveAgendaTone(firstSlot.status) : 'active',
        timeSlots,
        facts: [
          formatAgendaAudienceLabel({
            targetMode,
            targetChats,
            targetPreviews,
            targetOverflowCount,
            currentTargetLabel,
          }),
        ],
        canEdit: Boolean(sourceChatId && firstSlot?.sourceChatId === sourceChatId),
      };
    })
    .sort((left, right) => {
      const dayDiff = left.dayKey.localeCompare(right.dayKey);
      if (dayDiff !== 0) {
        return dayDiff;
      }
      return (left.timeSlots[0] ?? '').localeCompare(right.timeSlots[0] ?? '');
    });
}
