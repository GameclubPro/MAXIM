export const systemDashboardQueryKey = ['system-dashboard'] as const;
export const systemBotsQueryKey = ['system-bots'] as const;
export const systemBotRoutePreviewQueryKey = (
  chatId: string,
  purpose: string,
  action: string | null,
  capability: string | null,
  fallbackToPrimary: boolean,
) => ['system-bot-route-preview', chatId, purpose, action, capability, fallbackToPrimary] as const;

export const logsDashboardQueryKey = (
  chatId: string,
  range: string,
  ...scope: readonly unknown[]
) => ['logs-dashboard', chatId, range, ...scope] as const;

export const channelStatsQueryKey = (chatId: string, range: string, mode = 'overview') =>
  ['channel-stats', chatId, range, mode] as const;

export const managedEntityOnboardingDiagnosticsQueryKey = (entityType: string) =>
  ['managed-entity-onboarding-diagnostics', entityType] as const;
