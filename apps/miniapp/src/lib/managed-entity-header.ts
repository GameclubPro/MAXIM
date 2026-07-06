import type { ChatSummary, ManagedEntityHeader } from '@maxim/contracts/managed-entities';

export function normalizeManagedEntityLink(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function createManagedEntityHeader(
  input: Pick<ManagedEntityHeader, 'id' | 'title' | 'entityType'> &
    Partial<Omit<ManagedEntityHeader, 'id' | 'title' | 'entityType'>>,
): ManagedEntityHeader {
  const assignedBots = input.assignedBots ?? [];

  return {
    id: input.id,
    title: input.title,
    entityType: input.entityType,
    link: normalizeManagedEntityLink(input.link),
    participantsCount: input.participantsCount ?? null,
    avatarUrl: input.avatarUrl ?? null,
    primaryBotId: input.primaryBotId ?? null,
    assignedBots,
    sharedMode: input.sharedMode ?? 'owned',
    ...(input.botCount !== undefined ? { botCount: input.botCount } : {}),
    ...(input.hasSharedAutomation !== undefined
      ? { hasSharedAutomation: input.hasSharedAutomation }
      : {}),
    accessDiagnostics: input.accessDiagnostics ?? {
      state: 'ok',
      lastDetectedAt: null,
      lastCheckedAt: null,
      freshUntil: null,
      source: 'unknown',
      activeBotCount:
        input.botCount ??
        assignedBots.filter(
          (bot) => bot.membershipStatus === 'active' && bot.lifecycleState === 'active',
        ).length,
      lostBots: [],
    },
    viewerAccess: input.viewerAccess ?? {
      state: 'checking',
      reason: null,
      checkedAt: null,
      canEdit: false,
    },
  };
}

export function chatSummaryToManagedEntityHeader(entity: ChatSummary): ManagedEntityHeader {
  return createManagedEntityHeader({
    id: entity.id,
    title: entity.title,
    entityType: entity.entityType,
    link: entity.link,
    participantsCount: null,
    avatarUrl: entity.avatarUrl ?? null,
    primaryBotId: entity.primaryBotId ?? null,
    assignedBots: entity.assignedBots ?? [],
    sharedMode: entity.sharedMode ?? 'owned',
    botCount: entity.botCount,
    hasSharedAutomation: entity.hasSharedAutomation,
  });
}
