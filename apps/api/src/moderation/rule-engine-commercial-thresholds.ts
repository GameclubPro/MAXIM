import { resolveCommercialSettingsThresholds } from '@maxim/contracts';
import { type ChatSettings } from '../prisma/prisma-client';

type CommercialThresholdSettings = Pick<
  ChatSettings,
  'commercialAdsSensitivity' | 'commercialAdsWarnThreshold' | 'commercialAdsDeleteThreshold'
>;

export type CommercialThresholdProfile = {
  warnThreshold: number;
  deleteThreshold: number;
  sensitivity: 'BALANCED' | 'STRICT';
  strictness: number;
};

export function resolveCommercialThresholds(
  settings: CommercialThresholdSettings,
): CommercialThresholdProfile {
  return resolveCommercialSettingsThresholds(settings);
}
