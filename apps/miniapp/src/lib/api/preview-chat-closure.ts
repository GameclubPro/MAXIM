import type { ChatClosureStatus, ChatSettings } from '@maxim/contracts/settings';

export function createPreviewOpenChatClosure(
  settings: ChatSettings,
  observedAt: Date,
): ChatClosureStatus {
  return {
    observedAt: observedAt.toISOString(),
    scheduleEnabled: settings.nightModeEnabled,
    restriction: 'open',
    timezone: settings.nightModeTimezone,
    opensAt: null,
    deleteRoute: 'available',
    notice: settings.nightModeBotMessageEnabled ? 'not_expected' : 'disabled',
    recovery: 'idle',
    nextTransitionAt: null,
    notices: {
      expectationBasis: 'current_schedule',
      boundary:
        settings.nightModeStartTimeMinutes === settings.nightModeEndTimeMinutes
          ? 'continuous'
          : 'unavailable',
      evidenceScope: 'exact_send_ledger',
      sendRouteNow: 'unknown',
      close: { enabledNow: settings.nightModeBotMessageEnabled, latest: null },
      open: { enabledNow: settings.nightModeOpenMessageEnabled, latest: null },
      recovery: { scope: 'latest_occurrences', observation: 'unavailable', obligations: [] },
    },
  };
}
