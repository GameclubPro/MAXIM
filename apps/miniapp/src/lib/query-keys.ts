export const queryKeys = {
  systemDashboard: ['system-dashboard'] as const,

  logsDashboard: (chatId: string, range: string, ...scope: readonly unknown[]) =>
    ['logs-dashboard', chatId, range, ...scope] as const,
  channelStats: (chatId: string, range: string) => ['channel-stats', chatId, range] as const,

  entityDialog: (
    entityType: string,
    chatId: string,
    dialogType: string,
    token: string | null | undefined,
  ) => ['entity-dialog', entityType, chatId, dialogType, token] as const,

  publicGiveaway: (giveawayId: string | null | undefined) =>
    ['public-giveaway', giveawayId] as const,
  giveawayParticipant: (giveawayId: string | null | undefined) =>
    ['public-giveaway-participant', giveawayId] as const,
  giveawayOwnedChannels: ['giveaway-owned-channels'] as const,

  managedGiveaways: (entityType: string, entityId: string) =>
    ['managed-giveaways', entityType, entityId] as const,
  managedGiveawayDetails: (
    entityType: string,
    entityId: string,
    giveawayId: string | null | undefined,
  ) => ['managed-giveaway-details', entityType, entityId, giveawayId] as const,
  managedGiveawayDetailsScope: (entityType: string, entityId: string) =>
    ['managed-giveaway-details', entityType, entityId] as const,

  chatSettingsScreen: (chatId: string | null | undefined) => ['settings-screen', chatId] as const,
  chatBroadcastHandoff: (chatId: string | null | undefined) =>
    ['broadcast-handoff-state', chatId] as const,
  currentUser: (chatId: string | null | undefined) => ['me', chatId ?? null] as const,
  settingsHeaderBotLoad: (botIdsSignature: string) =>
    ['settings-header-bot-load', botIdsSignature] as const,
  chatManagedBroadcastCalendar: (
    chatId: string | null | undefined,
    ...scope: readonly unknown[]
  ) => ['managed-broadcast-calendar', chatId, ...scope] as const,

  channelSettingsScreen: (chatId: string | null | undefined) =>
    ['channel-settings-screen', chatId] as const,
  channelBroadcastHandoff: (chatId: string | null | undefined) =>
    ['channel-broadcast-handoff', chatId] as const,
  channelManagedBroadcastCalendar: (
    chatId: string | null | undefined,
    ...scope: readonly unknown[]
  ) => ['channel-managed-broadcast-calendar', chatId, ...scope] as const,
};
