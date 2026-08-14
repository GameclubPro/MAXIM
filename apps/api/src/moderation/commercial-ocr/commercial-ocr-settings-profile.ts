import { createHash } from 'node:crypto';

import type { ChatSettings } from '../../prisma/prisma-client';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const COMMERCIAL_OCR_MAX_CERTIFIED_SETTINGS_PROFILES = 32;

export type CommercialOcrSettingsProfile = Pick<
  ChatSettings,
  | 'commercialAdsSensitivity'
  | 'commercialAdsWarnThreshold'
  | 'commercialAdsDeleteThreshold'
>;

export type CommercialOcrSettingsProfileDescriptor = Readonly<{
  commercialAdsSensitivity: 'BALANCED' | 'STRICT';
  commercialAdsWarnThreshold: number;
  commercialAdsDeleteThreshold: number;
}>;

export function describeCommercialOcrSettingsProfile(
  settings: CommercialOcrSettingsProfile,
): CommercialOcrSettingsProfileDescriptor {
  if (
    settings?.commercialAdsSensitivity !== 'BALANCED' &&
    settings?.commercialAdsSensitivity !== 'STRICT'
  ) {
    throw new Error('Commercial OCR settings sensitivity is invalid');
  }
  if (
    !isThreshold(settings.commercialAdsWarnThreshold, 10, 90) ||
    !isThreshold(settings.commercialAdsDeleteThreshold, 20, 100) ||
    settings.commercialAdsWarnThreshold >= settings.commercialAdsDeleteThreshold
  ) {
    throw new Error('Commercial OCR settings thresholds are invalid');
  }
  return Object.freeze({
    commercialAdsSensitivity: settings.commercialAdsSensitivity,
    commercialAdsWarnThreshold: settings.commercialAdsWarnThreshold,
    commercialAdsDeleteThreshold: settings.commercialAdsDeleteThreshold,
  });
}

export function fingerprintCommercialOcrSettingsProfile(
  settings: CommercialOcrSettingsProfile,
): string {
  return createHash('sha256')
    .update(JSON.stringify(describeCommercialOcrSettingsProfile(settings)))
    .digest('hex');
}

export function normalizeCommercialOcrSettingsFingerprints(
  values: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > COMMERCIAL_OCR_MAX_CERTIFIED_SETTINGS_PROFILES
  ) {
    throw new Error('Commercial OCR settings fingerprint set size is invalid');
  }
  const normalized = values.map((value) => {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
      throw new Error('Commercial OCR settings fingerprint is invalid');
    }
    return value;
  });
  const unique = [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
  if (unique.length !== normalized.length) {
    throw new Error('Commercial OCR settings fingerprints must be unique');
  }
  return Object.freeze(unique);
}

export function digestCommercialOcrSettingsFingerprintSet(values: readonly string[]): string {
  return createHash('sha256')
    .update(`${normalizeCommercialOcrSettingsFingerprints(values).join('\n')}\n`)
    .digest('hex');
}

function isThreshold(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
