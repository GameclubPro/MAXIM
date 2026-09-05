import {
  DUPLICATE_ALLOWED_COUNT_MIN as CONTRACT_DUPLICATE_ALLOWED_COUNT_MIN,
  buildDuplicateFlowThresholds,
  resolveDuplicateFlowAllowedCount,
  resolveDuplicateFlowAllowedCountMax,
  type ChatSettings,
  type DuplicateFlowStageSettings,
  type DuplicateFlowThresholdSettings,
} from '@maxim/contracts/settings';

export const DUPLICATE_ALLOWED_COUNT_MIN = CONTRACT_DUPLICATE_ALLOWED_COUNT_MIN;
const DUPLICATE_WINDOW_MIN_SEC = 3_600;
const DUPLICATE_WINDOW_MAX_SEC = 604_800;

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
  if (settings.duplicateWarnEnabled) {
    return settings.duplicateWarnWindowSec;
  }

  if (settings.duplicateMuteEnabled) {
    return settings.duplicateMuteWindowSec;
  }

  if (settings.duplicateBanEnabled) {
    return settings.duplicateBanWindowSec;
  }

  return settings.duplicateWarnWindowSec;
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
  if (count === 0) {
    return 'с первого дубля';
  }

  if (count === 1) {
    return 'после 1 дубля';
  }

  return `после ${count} дублей`;
}
