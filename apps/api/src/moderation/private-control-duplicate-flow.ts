import {
  buildDuplicateFlowThresholds,
  resolveDuplicateFlowAllowedCount,
  resolveDuplicateFlowAllowedCountMax,
  type ChatSettings,
} from '@maxim/contracts';
import { DUPLICATE_FLOW_SETTING_KEYS } from './private-control.constants';

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

export function resolvePrivateDuplicateAllowedCountMax(
  settings: DuplicateFlowStepSettings,
): number {
  return resolveDuplicateFlowAllowedCountMax(settings);
}

export function resolvePrivateDuplicateAllowedCount(
  settings: DuplicateFlowAllowedCountSettings,
): number {
  return resolveDuplicateFlowAllowedCount(settings);
}

export function buildPrivateDuplicateFlowSettings(
  settings: DuplicateFlowBuildParams,
): DuplicateFlowComputedSettings {
  const windowSec = Math.max(3_600, Math.min(604_800, Math.round(settings.windowSec)));

  return {
    duplicateWarnWindowSec: windowSec,
    duplicateMuteWindowSec: windowSec,
    duplicateBanWindowSec: windowSec,
    ...buildDuplicateFlowThresholds(settings),
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
