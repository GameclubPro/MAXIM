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
  };
}
