import {
  DUPLICATE_ALLOWED_COUNT_MIN as CONTRACT_DUPLICATE_ALLOWED_COUNT_MIN,
  buildDuplicateFlowThresholds,
  resolveDuplicateFlowAllowedCount,
  resolveDuplicateFlowAllowedCountMax,
  resolveDuplicateIntervalWindowSec,
  DUPLICATE_WINDOW_MIN_SEC,
  DUPLICATE_WINDOW_MAX_SEC,
  type ChatSettings,
  type DuplicateFlowStageSettings,
  type DuplicateFlowThresholdSettings,
} from '@maxim/contracts/settings';

export const DUPLICATE_ALLOWED_COUNT_MIN = CONTRACT_DUPLICATE_ALLOWED_COUNT_MIN;

type DuplicateFlowWindowSettings = Pick<
  ChatSettings,
  | 'duplicateWarnEnabled'
  | 'duplicateMuteEnabled'
  | 'duplicateBanEnabled'
  | 'duplicateWarnWindowSec'
  | 'duplicateMuteWindowSec'
  | 'duplicateBanWindowSec'
>;

export function resolveDuplicateSharedWindowSec(settings: DuplicateFlowWindowSettings): number {
  return resolveDuplicateIntervalWindowSec(settings);
}

export function resolveDuplicateAllowedCountMax(settings: DuplicateFlowStageSettings): number {
  return resolveDuplicateFlowAllowedCountMax(settings);
}

export function resolveDuplicateAllowedCount(
  settings: DuplicateFlowStageSettings & DuplicateFlowThresholdSettings,
): number {
  return resolveDuplicateFlowAllowedCount(settings);
}

export function buildDuplicateFlowSettings(
  settings: DuplicateFlowStageSettings & {
    allowedCount: number;
    windowSec: number;
  },
): Pick<
  ChatSettings,
  | 'duplicateWarnWindowSec'
  | 'duplicateMuteWindowSec'
  | 'duplicateBanWindowSec'
  | 'duplicateWarnMaxCount'
  | 'duplicateMuteMaxCount'
  | 'duplicateBanMaxCount'
> {
  const windowSec = Math.max(
    DUPLICATE_WINDOW_MIN_SEC,
    Math.min(DUPLICATE_WINDOW_MAX_SEC, Math.round(settings.windowSec)),
  );

  return {
    duplicateWarnWindowSec: windowSec,
    duplicateMuteWindowSec: windowSec,
    duplicateBanWindowSec: windowSec,
    ...buildDuplicateFlowThresholds(settings),
  };
}

export function normalizeDuplicateFlowSettings(settings: ChatSettings): ChatSettings {
  return {
    ...settings,
    ...buildDuplicateFlowSettings({
      duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
      duplicateWarnEnabled: settings.duplicateWarnEnabled,
      duplicateMuteEnabled: settings.duplicateMuteEnabled,
      duplicateBanEnabled: settings.duplicateBanEnabled,
      allowedCount: resolveDuplicateAllowedCount(settings),
      windowSec: resolveDuplicateSharedWindowSec(settings),
    }),
  };
}

export function formatDuplicateAllowanceLabel(count: number): string {
  return `удаление с сообщения №${count + 2}`;
}

export function formatDuplicateClockTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function formatDuplicateWindowLabel(settings: ChatSettings, windowHours: number): string {
  return settings.duplicateWindowMode === 'DAILY'
    ? `${formatDuplicateClockTime(settings.duplicateStartTimeMinutes)}–${formatDuplicateClockTime(settings.duplicateEndTimeMinutes)}${settings.duplicateStartTimeMinutes > settings.duplicateEndTimeMinutes ? ' следующего дня' : ''}`
    : `${windowHours} ч`;
}
