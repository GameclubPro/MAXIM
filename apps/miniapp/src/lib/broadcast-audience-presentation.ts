import type {
  BroadcastTargetMode,
  ChatSummary,
  ManagedBroadcastTargetPreview,
} from '@maxim/contracts';
import {
  formatRussianCountLabel,
  normalizeBroadcastAudienceTargetChatIds,
} from './broadcast-audience';

export type BroadcastAudiencePresentation = {
  label: string;
  compactLabel: string;
  previews: ManagedBroadcastTargetPreview[];
  overflowCount: number;
};

export function toManagedBroadcastTargetPreview(
  chat: Pick<ChatSummary, 'id' | 'title' | 'entityType' | 'link' | 'avatarUrl'>,
): ManagedBroadcastTargetPreview {
  return {
    id: chat.id,
    title: chat.title,
    entityType: chat.entityType,
    link: chat.link ?? null,
    avatarUrl: chat.avatarUrl ?? null,
  };
}

export function buildBroadcastAudiencePreviewBundle(params: {
  targetChatIds: readonly string[];
  choices?: readonly ChatSummary[];
  currentChat?: ManagedBroadcastTargetPreview | null;
  limit?: number;
}): { previews: ManagedBroadcastTargetPreview[]; overflowCount: number } {
  const limit = Math.max(1, params.limit ?? 3);
  const normalizedIds = normalizeBroadcastAudienceTargetChatIds(params.targetChatIds);
  const choicesById = new Map((params.choices ?? []).map((chat) => [chat.id, chat]));
  const previews = normalizedIds.slice(0, limit).map((chatId) => {
    if (params.currentChat?.id === chatId) {
      return params.currentChat;
    }

    const choice = choicesById.get(chatId);
    if (choice) {
      return toManagedBroadcastTargetPreview(choice);
    }

    return {
      id: chatId,
      title: `Чат ${chatId}`,
      entityType: 'chat' as const,
      link: null,
      avatarUrl: null,
    };
  });

  return {
    previews,
    overflowCount: Math.max(0, normalizedIds.length - previews.length),
  };
}

export function buildBroadcastAudiencePresentation(params: {
  targetMode: BroadcastTargetMode;
  targetChatIds: readonly string[];
  targetPreviews?: readonly ManagedBroadcastTargetPreview[];
  targetOverflowCount?: number;
  targetChats?: number;
  currentLabel?: string;
  currentTitle?: string | null;
  allLabel?: string;
}): BroadcastAudiencePresentation {
  const normalizedIds = normalizeBroadcastAudienceTargetChatIds(params.targetChatIds);
  const targetCount = params.targetChats ?? normalizedIds.length;
  const previews = [...(params.targetPreviews ?? [])].slice(0, 3);
  const overflowCount =
    params.targetOverflowCount ??
    Math.max(0, Math.max(targetCount, normalizedIds.length) - previews.length);
  const firstTitle =
    previews[0]?.title.trim() ||
    params.currentTitle?.trim() ||
    (params.targetMode === 'all'
      ? (params.allLabel ?? 'Все чаты')
      : (params.currentLabel ?? 'Текущий чат'));

  if (params.targetMode === 'all') {
    const countLabel =
      targetCount > 0
        ? formatRussianCountLabel(targetCount, 'чат', 'чата', 'чатов')
        : (params.allLabel ?? 'Все чаты');
    return {
      label: `Все · ${countLabel}`,
      compactLabel: targetCount > 0 ? `Все · ${targetCount}` : 'Все',
      previews,
      overflowCount,
    };
  }

  if (params.targetMode === 'selected') {
    const countLabel = formatRussianCountLabel(
      Math.max(targetCount, normalizedIds.length),
      'чат',
      'чата',
      'чатов',
    );
    return {
      label: overflowCount > 0 ? `${firstTitle} +${overflowCount}` : firstTitle || countLabel,
      compactLabel: overflowCount > 0 ? `${firstTitle} +${overflowCount}` : countLabel,
      previews,
      overflowCount,
    };
  }

  const currentTitle =
    params.currentTitle?.trim() || firstTitle || params.currentLabel || 'Текущий чат';
  return {
    label: currentTitle,
    compactLabel: currentTitle,
    previews,
    overflowCount: 0,
  };
}
