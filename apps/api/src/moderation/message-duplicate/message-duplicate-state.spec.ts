import {
  exactImageSettingsDigest,
  messageDuplicateSettingsDigest,
} from './message-duplicate-state';
import {
  duplicateSettings,
  preUnicodeNearSettingsDigests,
  preSafeTextSettingsDigests,
  preBoundedPhoneSettingsDigests,
  prePhoneBoundarySettingsDigests,
  preSourceBoundPhoneSettingsDigests,
  preV3HistorySettingsDigests,
  preSemanticUnitSettingsDigests,
  prePrefixUnitSettingsDigests,
} from './message-duplicate-test-fixtures';

describe('safe text evidence compatibility', () => {
  it.each([
    ['STANDARD', {}],
    ['STRICT', { duplicateDetectionPreset: 'STRICT' }],
    ['CUSTOM_NEAR', { duplicateDetectionPreset: 'CUSTOM', duplicateNearMatchEnabled: true }],
    ['CUSTOM_PHONE', { duplicateDetectionPreset: 'CUSTOM', duplicateIgnorePhonesEnabled: true }],
  ] as const)('revokes pre-unit and pre-prefix-unit %s text evidence', (key, overrides) => {
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preSemanticUnitSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      prePrefixUnitSettingsDigests[key],
    );
  });
  it('keeps exact IMAGE authority unchanged by quantity-unit semantics', () => {
    expect(exactImageSettingsDigest(duplicateSettings())).toBe(
      preSemanticUnitSettingsDigests.IMAGE,
    );
    expect(exactImageSettingsDigest(duplicateSettings())).toBe(prePrefixUnitSettingsDigests.IMAGE);
  });
  it.each([
    ['STRICT', { duplicateDetectionPreset: 'STRICT' }],
    ['CUSTOM_NEAR', { duplicateDetectionPreset: 'CUSTOM', duplicateNearMatchEnabled: true }],
    ['CUSTOM_PHONE', { duplicateDetectionPreset: 'CUSTOM', duplicateIgnorePhonesEnabled: true }],
  ] as const)('invalidates previous %s evidence, including phone-only CUSTOM', (key, overrides) => {
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preSafeTextSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preBoundedPhoneSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      prePhoneBoundarySettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preSourceBoundPhoneSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preV3HistorySettingsDigests[key],
    );
  });
  it.each(['STRICT', 'CUSTOM'] as const)('invalidates pre-Unicode %s evidence', (preset) => {
    const settings = duplicateSettings({
      duplicateDetectionPreset: preset,
      duplicateNearMatchEnabled: true,
    });
    expect(messageDuplicateSettingsDigest(settings)).not.toBe(
      preUnicodeNearSettingsDigests[preset],
    );
    if (preset === 'STRICT') {
      expect(
        messageDuplicateSettingsDigest({ ...settings, duplicateNearMatchEnabled: false }),
      ).toBe(messageDuplicateSettingsDigest(settings));
    }
  });

  it.each(['STANDARD', 'CUSTOM'] as const)(
    'revokes old exact %s grants while keeping preset-independent semantics',
    (preset) => {
      expect(
        messageDuplicateSettingsDigest(duplicateSettings({ duplicateDetectionPreset: preset })),
      ).toBe(messageDuplicateSettingsDigest(duplicateSettings()));
      expect(messageDuplicateSettingsDigest(duplicateSettings())).not.toBe(
        preV3HistorySettingsDigests.STANDARD,
      );
    },
  );

  it('revokes old CUSTOM link-only evidence after the storage incarnation changes', () => {
    expect(
      messageDuplicateSettingsDigest(
        duplicateSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
        }),
      ),
    ).not.toBe('1cef59a480ea7d36decb8631c350c3ed9b176309604377c98f481dac824c2a93');
  });

  it.each(['STANDARD', 'STRICT', 'CUSTOM'] as const)(
    'revokes old IMAGE grants while keeping independence of %s text settings',
    (preset) => {
      expect(
        exactImageSettingsDigest(
          duplicateSettings({
            duplicateDetectionPreset: preset,
            duplicateNearMatchEnabled: true,
            duplicateIgnorePhonesEnabled: true,
          }),
        ),
      ).toBe(exactImageSettingsDigest(duplicateSettings()));
      expect(exactImageSettingsDigest(duplicateSettings())).not.toBe(
        preV3HistorySettingsDigests.IMAGE,
      );
    },
  );
});
