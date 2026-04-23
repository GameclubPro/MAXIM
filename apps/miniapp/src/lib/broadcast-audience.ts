import type { BroadcastTargetMode } from '@maxim/contracts';
import { buildHomeView } from './last-chat';

export type BroadcastScopedTargetMode = Exclude<BroadcastTargetMode, 'all'>;

function formatRussianCountLabel(
  count: number,
  one: string,
  few: string,
  many: string,
): string {
  const normalized = Math.abs(count) % 100;
  const remainder = normalized % 10;
  if (normalized > 10 && normalized < 20) {
    return `${count} ${many}`;
  }
  if (remainder === 1) {
    return `${count} ${one}`;
  }
  if (remainder > 1 && remainder < 5) {
    return `${count} ${few}`;
  }
  return `${count} ${many}`;
}

export function normalizeBroadcastAudienceTargetChatIds(targetChatIds: readonly string[]): string[] {
  return Array.from(
    new Set(
      targetChatIds
        .map((item) => item.trim())
        .filter((item): item is string => item.length > 0),
    ),
  );
}

export function resolveBroadcastAudienceLastScopedMode(params: {
  targetMode: BroadcastTargetMode;
  targetChatIds: readonly string[];
  currentChatId?: string | null;
}): BroadcastScopedTargetMode {
  if (params.targetMode === 'selected') {
    return 'selected';
  }

  if (params.targetMode === 'current') {
    return 'current';
  }

  const normalizedTargetChatIds = normalizeBroadcastAudienceTargetChatIds(params.targetChatIds);
  const currentChatId = params.currentChatId?.trim() ?? '';
  if (normalizedTargetChatIds.length === 0) {
    return 'current';
  }

  if (
    currentChatId &&
    normalizedTargetChatIds.length === 1 &&
    normalizedTargetChatIds[0] === currentChatId
  ) {
    return 'current';
  }

  return 'selected';
}

export function restoreBroadcastAudienceModeFromAll(params: {
  lastScopedMode: BroadcastScopedTargetMode;
  targetChatIds: readonly string[];
}): BroadcastScopedTargetMode {
  if (
    params.lastScopedMode === 'selected' &&
    normalizeBroadcastAudienceTargetChatIds(params.targetChatIds).length > 0
  ) {
    return 'selected';
  }

  return 'current';
}

export function resolveBroadcastAudiencePayload(params: {
  targetMode: BroadcastTargetMode;
  targetChatIds: readonly string[];
  currentChatId?: string | null;
}): {
  targetMode: BroadcastTargetMode;
  targetChatIds: string[];
  applyToAllChats: boolean;
} {
  const currentChatId = params.currentChatId?.trim() ?? '';
  const normalizedTargetChatIds = normalizeBroadcastAudienceTargetChatIds(params.targetChatIds);

  if (params.targetMode === 'current') {
    return {
      targetMode: 'current',
      targetChatIds: currentChatId ? [currentChatId] : [],
      applyToAllChats: false,
    };
  }

  if (params.targetMode === 'selected') {
    return {
      targetMode: 'selected',
      targetChatIds: normalizedTargetChatIds,
      applyToAllChats: false,
    };
  }

  return {
    targetMode: 'all',
    targetChatIds: normalizedTargetChatIds,
    applyToAllChats: true,
  };
}

export function resolveBroadcastAudienceTargetLabel(params: {
  targetMode: BroadcastTargetMode;
  targetChatIds: readonly string[];
  currentLabel?: string;
}): string {
  if (params.targetMode === 'all') {
    return 'Все чаты';
  }

  if (params.targetMode === 'selected') {
    return formatRussianCountLabel(
      normalizeBroadcastAudienceTargetChatIds(params.targetChatIds).length,
      'чат',
      'чата',
      'чатов',
    );
  }

  return params.currentLabel ?? 'Текущий чат';
}

export function filterBroadcastAudienceChoices<
  T extends { id: string; title: string; link?: string | null },
>(items: readonly T[], query: string): T[] {
  return buildHomeView({
    entities: items,
    query,
  })[0];
}
