import type { ChatSettings } from '@maxim/contracts';
import {
  DUPLICATE_ALLOWED_COUNT_MIN,
  DUPLICATE_FLOW_SETTING_KEYS,
  DUPLICATE_THRESHOLD_MAX,
} from './private-control.constants';

type DuplicateFlowWindowSettings = Pick<
  ChatSettings,
  | 'duplicateWarnEnabled'
  | 'duplicateMuteEnabled'
  | 'duplicateBanEnabled'
  | 'duplicateWarnWindowSec'
  | 'duplicateMuteWindowSec'
  | 'duplicateBanWindowSec'
>;

type DuplicateFlowThresholdSettings = Pick<
  ChatSettings,
  | 'duplicateWarnEnabled'
  | 'duplicateMuteEnabled'
  | 'duplicateBanEnabled'
  | 'duplicateWarnMaxCount'
  | 'duplicateMuteMaxCount'
  | 'duplicateBanMaxCount'
>;

type DuplicateFlowStepSettings = Pick<
  ChatSettings,
  | 'duplicateBotMessageEnabled'
  | 'duplicateWarnEnabled'
  | 'duplicateMuteEnabled'
  | 'duplicateBanEnabled'
>;

type DuplicateFlowAllowedCountSettings = DuplicateFlowStepSettings & DuplicateFlowThresholdSettings;

type DuplicateFlowBuildParams = DuplicateFlowStepSettings & {
  allowedCount: number;
  windowSec: number;
};

type DuplicateFlowComputedSettings = Pick<
  ChatSettings,
  | 'duplicateWarnWindowSec'
  | 'duplicateMuteWindowSec'
  | 'duplicateBanWindowSec'
  | 'duplicateWarnMaxCount'
  | 'duplicateMuteMaxCount'
  | 'duplicateBanMaxCount'
>;

export function isPrivateDuplicateFlowSettingKey(key: keyof ChatSettings): boolean {
  return (DUPLICATE_FLOW_SETTING_KEYS as readonly (keyof ChatSettings)[]).includes(key);
}

export function resolvePrivateDuplicateSharedWindowSec(
  settings: DuplicateFlowWindowSettings,
): number {
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

function resolvePrivateDuplicateFirstThreshold(settings: DuplicateFlowThresholdSettings): number {
  if (settings.duplicateWarnEnabled) {
    return settings.duplicateWarnMaxCount;
  }

  if (settings.duplicateMuteEnabled) {
    return settings.duplicateMuteMaxCount;
  }

  if (settings.duplicateBanEnabled) {
    return settings.duplicateBanMaxCount;
  }

  return settings.duplicateWarnMaxCount;
}

export function resolvePrivateDuplicateAllowedCountMax(
  settings: DuplicateFlowStepSettings,
): number {
  const duplicateThresholdOffset =
    (settings.duplicateBotMessageEnabled ? 2 : 1) +
    (settings.duplicateWarnEnabled ? 1 : 0) +
    (settings.duplicateMuteEnabled ? 1 : 0);

  return Math.max(DUPLICATE_ALLOWED_COUNT_MIN, DUPLICATE_THRESHOLD_MAX - duplicateThresholdOffset);
}

export function resolvePrivateDuplicateAllowedCount(
  settings: DuplicateFlowAllowedCountSettings,
): number {
  const rawAllowedCount =
    resolvePrivateDuplicateFirstThreshold(settings) - (settings.duplicateBotMessageEnabled ? 2 : 1);
  return Math.max(
    DUPLICATE_ALLOWED_COUNT_MIN,
    Math.min(resolvePrivateDuplicateAllowedCountMax(settings), rawAllowedCount),
  );
}

export function buildPrivateDuplicateFlowSettings(
  settings: DuplicateFlowBuildParams,
): DuplicateFlowComputedSettings {
  const allowedCount = Math.max(
    DUPLICATE_ALLOWED_COUNT_MIN,
    Math.min(resolvePrivateDuplicateAllowedCountMax(settings), Math.round(settings.allowedCount)),
  );
  const windowSec = Math.max(3_600, Math.min(604_800, Math.round(settings.windowSec)));
  const warnThreshold = allowedCount + (settings.duplicateBotMessageEnabled ? 2 : 1);
  const muteThreshold = warnThreshold + (settings.duplicateWarnEnabled ? 1 : 0);
  const banThreshold = muteThreshold + (settings.duplicateMuteEnabled ? 1 : 0);

  return {
    duplicateWarnWindowSec: windowSec,
    duplicateMuteWindowSec: windowSec,
    duplicateBanWindowSec: windowSec,
    duplicateWarnMaxCount: warnThreshold,
    duplicateMuteMaxCount: muteThreshold,
    duplicateBanMaxCount: banThreshold,
  };
}

export function normalizePrivateDuplicateFlowSettings(settings: ChatSettings): ChatSettings {
  return {
    ...settings,
    ...buildPrivateDuplicateFlowSettings({
      duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
      duplicateWarnEnabled: settings.duplicateWarnEnabled,
      duplicateMuteEnabled: settings.duplicateMuteEnabled,
      duplicateBanEnabled: settings.duplicateBanEnabled,
      allowedCount: resolvePrivateDuplicateAllowedCount(settings),
      windowSec: resolvePrivateDuplicateSharedWindowSec(settings),
    }),
  };
}
