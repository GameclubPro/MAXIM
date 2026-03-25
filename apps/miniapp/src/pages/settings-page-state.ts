import type { ChatSettings } from '@maxim/contracts';

export const NIGHT_SECTION_SETTING_KEYS = [
  'nightModeEnabled',
  'nightModeStartTimeMinutes',
  'nightModeEndTimeMinutes',
  'nightModeTimezone',
  'nightModeBotMessageEnabled',
  'nightModeBotMessageText',
  'nightModeCommentsEnabled',
  'nightModeOpenMessageEnabled',
  'nightModeOpenMessageText',
  'nightModeBotButtonEnabled',
  'nightModeBotButtonUrl',
  'nightModeBotButtonText',
  'nightModeRulesButtonEnabled',
  'nightModeForceCloseEnabled',
  'nightModeForceCloseForever',
  'nightModeForceCloseHours',
  'nightModeForceCloseDays',
  'nightModeForceCloseUntil',
] as const satisfies ReadonlyArray<keyof ChatSettings>;

export function applyNightModeEnabledChange(
  settings: ChatSettings,
  enabled: boolean,
): ChatSettings {
  if (enabled) {
    return {
      ...settings,
      nightModeEnabled: true,
      nightModeBotMessageEnabled: true,
    };
  }

  return {
    ...settings,
    nightModeEnabled: false,
    nightModeBotMessageEnabled: false,
    nightModeCommentsEnabled: false,
    nightModeBotButtonEnabled: false,
    nightModeRulesButtonEnabled: false,
  };
}

export function applyNightModeBotMessageEnabledChange(
  settings: ChatSettings,
  enabled: boolean,
): ChatSettings {
  if (enabled) {
    return {
      ...settings,
      nightModeBotMessageEnabled: true,
    };
  }

  return {
    ...settings,
    nightModeBotMessageEnabled: false,
    nightModeCommentsEnabled: false,
    nightModeBotButtonEnabled: false,
    nightModeRulesButtonEnabled: false,
  };
}

export function mergeNightSectionSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
): ChatSettings {
  const nextSettings = { ...targetSettings } as ChatSettings;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of NIGHT_SECTION_SETTING_KEYS) {
    nextRecord[key] = sourceRecord[key];
  }

  return nextSettings;
}
