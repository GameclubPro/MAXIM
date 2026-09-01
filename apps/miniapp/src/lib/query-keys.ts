import {
  channelStatsQueryKey,
  logsDashboardQueryKey,
  managedEntityOnboardingDiagnosticsQueryKey,
  systemBotRoutePreviewQueryKey,
  systemBotsQueryKey,
  systemDashboardQueryKey,
} from './query-key-builders';

export {
  channelStatsQueryKey,
  logsDashboardQueryKey,
  managedEntityOnboardingDiagnosticsQueryKey,
  systemBotRoutePreviewQueryKey,
  systemBotsQueryKey,
  systemDashboardQueryKey,
} from './query-key-builders';

export const queryKeys = {
  systemDashboard: systemDashboardQueryKey,
  systemBots: systemBotsQueryKey,
  systemBotRoutePreview: systemBotRoutePreviewQueryKey,

  logsDashboard: logsDashboardQueryKey,
  globalSpammerReviewQueue: (chatId: string | null | undefined, ...scope: readonly unknown[]) =>
    ['global-spammer-review-queue', chatId, ...scope] as const,
  globalSpammerReviewMetrics: (chatId: string | null | undefined, ...scope: readonly unknown[]) =>
    ['global-spammer-review-metrics', chatId, ...scope] as const,
  globalSpammerUserDiagnostics: (
    chatId: string | null | undefined,
    userId: string | null | undefined,
    ...scope: readonly unknown[]
  ) => ['global-spammer-user-diagnostics', chatId, userId, ...scope] as const,
  channelStats: channelStatsQueryKey,

  entityDialog: (
    entityType: string,
    chatId: string,
    dialogType: string,
    token: string | null | undefined,
  ) => ['entity-dialog', entityType, chatId, dialogType, token] as const,
  publisherSuggestions: (entityId: string | null | undefined) =>
    ['publisher-suggestions', entityId] as const,

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
  chatBroadcastComposerClientReset: (chatId: string | null | undefined) =>
    ['broadcast-composer-client-reset', chatId] as const,
  currentUser: (chatId: string | null | undefined) => ['me', chatId ?? null] as const,
  managedEntityOnboardingDiagnostics: managedEntityOnboardingDiagnosticsQueryKey,
  settingsHeaderBotLoad: (botIdsSignature: string) =>
    ['settings-header-bot-load', botIdsSignature] as const,
  chatManagedBroadcastCalendar: (chatId: string | null | undefined, ...scope: readonly unknown[]) =>
    ['managed-broadcast-calendar', chatId, ...scope] as const,
  chatManagedAutopostRules: (chatId: string | null | undefined) =>
    ['managed-autopost-rules', chatId] as const,

  channelSettingsScreen: (chatId: string | null | undefined) =>
    ['channel-settings-screen', chatId] as const,
  channelBroadcastHandoff: (chatId: string | null | undefined) =>
    ['channel-broadcast-handoff', chatId] as const,
  channelBroadcastComposerClientReset: (chatId: string | null | undefined) =>
    ['channel-broadcast-composer-client-reset', chatId] as const,
  channelManagedBroadcastCalendar: (
    chatId: string | null | undefined,
    ...scope: readonly unknown[]
  ) => ['channel-managed-broadcast-calendar', chatId, ...scope] as const,
  channelManagedAutopostRules: (chatId: string | null | undefined) =>
    ['channel-managed-autopost-rules', chatId] as const,
  vkParsing: (
    entityType: string,
    chatId: string | null | undefined,
    ...scope: readonly unknown[]
  ) => ['vk-parsing', entityType, chatId, ...scope] as const,
  vkParsingCapability: (entityType: string, chatId: string | null | undefined) =>
    ['vk-parsing-capability', entityType, chatId] as const,
};
