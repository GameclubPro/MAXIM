import { CommercialAdsSensitivity, type ChatSettings } from '../prisma/prisma-client';

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
  const strict = settings.commercialAdsSensitivity === CommercialAdsSensitivity.STRICT;
  const warnBase = Number.isFinite(settings.commercialAdsWarnThreshold)
    ? settings.commercialAdsWarnThreshold
    : 45;
  const deleteBase = Number.isFinite(settings.commercialAdsDeleteThreshold)
    ? settings.commercialAdsDeleteThreshold
    : 65;
  const warnThreshold = Math.max(10, Math.min(90, warnBase));
  const deleteThreshold = Math.max(warnThreshold + 5, Math.min(100, deleteBase));
  const thresholdStrictness = ((60 - warnThreshold) / 22 + (82 - deleteThreshold) / 27) / 2;
  const strictness = Math.max(0, Math.min(1, thresholdStrictness + (strict ? 0.04 : -0.02)));

  return {
    warnThreshold,
    deleteThreshold,
    sensitivity: strict ? 'STRICT' : 'BALANCED',
    strictness,
  };
}
