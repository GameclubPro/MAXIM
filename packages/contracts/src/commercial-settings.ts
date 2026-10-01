// FLAG: Stored valid profiles are authoritative. A small threshold gap must never be widened
// silently; fallback repair is reserved for invalid historical/runtime inputs.
export type CommercialSettingsProfile = {
  commercialAdsSensitivity: 'BALANCED' | 'STRICT';
  commercialAdsWarnThreshold: number;
  commercialAdsDeleteThreshold: number;
};

export function resolveCommercialSettingsThresholds(settings: CommercialSettingsProfile) {
  const strict = settings.commercialAdsSensitivity === 'STRICT';
  const warnBase = Number.isFinite(settings.commercialAdsWarnThreshold)
    ? settings.commercialAdsWarnThreshold
    : 45;
  const deleteBase = Number.isFinite(settings.commercialAdsDeleteThreshold)
    ? settings.commercialAdsDeleteThreshold
    : 65;
  const warnThreshold = Math.max(10, Math.min(90, warnBase));
  const boundedDelete = Math.max(20, Math.min(100, deleteBase));
  const validStoredProfile =
    Number.isInteger(settings.commercialAdsWarnThreshold) &&
    settings.commercialAdsWarnThreshold >= 10 &&
    settings.commercialAdsWarnThreshold <= 90 &&
    Number.isInteger(settings.commercialAdsDeleteThreshold) &&
    settings.commercialAdsDeleteThreshold >= 20 &&
    settings.commercialAdsDeleteThreshold <= 100 &&
    settings.commercialAdsDeleteThreshold > settings.commercialAdsWarnThreshold;
  const deleteThreshold = validStoredProfile
    ? boundedDelete
    : Math.max(warnThreshold + 5, boundedDelete);
  const thresholdStrictness = ((60 - warnThreshold) / 22 + (82 - deleteThreshold) / 27) / 2;
  return {
    warnThreshold,
    deleteThreshold,
    sensitivity: strict ? ('STRICT' as const) : ('BALANCED' as const),
    strictness: Math.max(0, Math.min(1, thresholdStrictness + (strict ? 0.04 : -0.02))),
  };
}

export type CommercialSanctionSettings = {
  warnEnabled: boolean;
  muteEnabled: boolean;
  banEnabled: boolean;
};

// FLAG: Preserve the existing configured ladder, including ban at the third strike when mute
// is disabled. Runtime and the user-facing preview must use this same resolver.
export function resolveCommercialSanctionAction(
  violationCount: number,
  settings: CommercialSanctionSettings,
): 'NONE' | 'WARN' | 'MUTE' | 'BAN' {
  const count = Number.isInteger(violationCount) ? Math.max(1, violationCount) : 1;
  if (count >= 4) {
    if (settings.banEnabled) return 'BAN';
    if (settings.muteEnabled) return 'MUTE';
    if (settings.warnEnabled) return 'WARN';
  } else if (count === 3) {
    if (settings.muteEnabled) return 'MUTE';
    if (settings.banEnabled) return 'BAN';
    if (settings.warnEnabled) return 'WARN';
  } else if (count === 2 && settings.warnEnabled) {
    return 'WARN';
  }
  return 'NONE';
}

export function resolveCommercialSliderProfile(value: number): CommercialSettingsProfile {
  const safe = Math.max(0, Math.min(100, Math.round(value)));
  if (safe <= 24) {
    const progress = safe / 24;
    return {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: Math.round(60 - 6 * progress),
      commercialAdsDeleteThreshold: Math.round(82 - 8 * progress),
    };
  }
  if (safe <= 69) {
    const progress = (safe - 25) / 44;
    return {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: Math.round(53 - 8 * progress),
      commercialAdsDeleteThreshold: Math.round(73 - 8 * progress),
    };
  }
  const progress = (safe - 70) / 30;
  return {
    commercialAdsSensitivity: 'STRICT',
    commercialAdsWarnThreshold: Math.round(44 - 6 * progress),
    commercialAdsDeleteThreshold: Math.round(63 - 8 * progress),
  };
}

export function inferCommercialSliderPosition(settings: CommercialSettingsProfile): number | null {
  for (let position = 0; position <= 100; position += 1) {
    const profile = resolveCommercialSliderProfile(position);
    if (
      profile.commercialAdsSensitivity === settings.commercialAdsSensitivity &&
      profile.commercialAdsWarnThreshold === settings.commercialAdsWarnThreshold &&
      profile.commercialAdsDeleteThreshold === settings.commercialAdsDeleteThreshold
    )
      return position;
  }
  return null;
}
