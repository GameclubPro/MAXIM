import { describe, expect, it } from 'vitest';
import {
  inferCommercialSliderPosition,
  resolveCommercialSanctionAction,
  resolveCommercialSettingsThresholds,
  resolveCommercialSliderProfile,
} from '../src/commercial-settings.js';

describe('commercial settings profiles', () => {
  it('preserves every valid stored threshold gap, including a one-point gap', () => {
    expect(
      resolveCommercialSettingsThresholds({
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 46,
      }),
    ).toMatchObject({ warnThreshold: 45, deleteThreshold: 46 });
    expect(
      resolveCommercialSettingsThresholds({
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 90,
        commercialAdsDeleteThreshold: 91,
      }),
    ).toMatchObject({ warnThreshold: 90, deleteThreshold: 91 });
  });
  it('repairs invalid ranges without changing the historical fallback', () => {
    expect(
      resolveCommercialSettingsThresholds({
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 95,
        commercialAdsDeleteThreshold: 92,
      }),
    ).toMatchObject({ warnThreshold: 90, deleteThreshold: 95 });
    expect(
      resolveCommercialSettingsThresholds({
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: Number.NaN,
        commercialAdsDeleteThreshold: Number.NaN,
      }),
    ).toMatchObject({ warnThreshold: 45, deleteThreshold: 65 });
  });
  it('recognizes exact slider profiles and keeps custom delete thresholds custom', () => {
    for (let position = 0; position <= 100; position += 1) {
      const profile = resolveCommercialSliderProfile(position);
      const inferred = inferCommercialSliderPosition(profile);
      expect(inferred).not.toBeNull();
      expect(resolveCommercialSliderProfile(inferred!)).toEqual(profile);
    }
    expect(
      inferCommercialSliderPosition({
        ...resolveCommercialSliderProfile(50),
        commercialAdsDeleteThreshold: 46,
      }),
    ).toBeNull();
  });
});

describe('commercial sanctions', () => {
  it.each([
    [false, false, false, ['NONE', 'NONE', 'NONE', 'NONE']],
    [true, false, false, ['NONE', 'WARN', 'WARN', 'WARN']],
    [false, true, false, ['NONE', 'NONE', 'MUTE', 'MUTE']],
    [false, false, true, ['NONE', 'NONE', 'BAN', 'BAN']],
    [true, true, false, ['NONE', 'WARN', 'MUTE', 'MUTE']],
    [true, false, true, ['NONE', 'WARN', 'BAN', 'BAN']],
    [false, true, true, ['NONE', 'NONE', 'MUTE', 'BAN']],
    [true, true, true, ['NONE', 'WARN', 'MUTE', 'BAN']],
  ])(
    'uses the actual ladder for warn=%s mute=%s ban=%s',
    (warnEnabled, muteEnabled, banEnabled, expected) => {
      expect(
        [1, 2, 3, 4].map((count) =>
          resolveCommercialSanctionAction(count, {
            warnEnabled: warnEnabled as boolean,
            muteEnabled: muteEnabled as boolean,
            banEnabled: banEnabled as boolean,
          }),
        ),
      ).toEqual(expected);
    },
  );
});
