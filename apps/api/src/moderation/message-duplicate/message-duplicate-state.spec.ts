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
} from './message-duplicate-test-fixtures';

describe('safe text evidence compatibility', () => {
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

  it.each(['STANDARD', 'CUSTOM'] as const)('preserves existing exact %s evidence', (preset) => {
    expect(
      messageDuplicateSettingsDigest(duplicateSettings({ duplicateDetectionPreset: preset })),
    ).toBe('abacbcc44c2a0dd8f0177b92124fe503b37960065ca14a7bfba61c5663006780');
  });

  it('preserves CUSTOM link-only evidence without near or phone value matching', () => {
    expect(
      messageDuplicateSettingsDigest(
        duplicateSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
        }),
      ),
    ).toBe('1cef59a480ea7d36decb8631c350c3ed9b176309604377c98f481dac824c2a93');
  });

  it.each(['STANDARD', 'STRICT', 'CUSTOM'] as const)(
    'preserves IMAGE evidence with %s text settings',
    (preset) => {
      expect(
        exactImageSettingsDigest(
          duplicateSettings({
            duplicateDetectionPreset: preset,
            duplicateNearMatchEnabled: true,
            duplicateIgnorePhonesEnabled: true,
          }),
        ),
      ).toBe('8b9112c31be1ae76f2304014f60b97d49c0d20063b37db7ac43fd3e7a72eaaa4');
    },
  );
});
