import {
  exactImageSettingsDigest,
  messageDuplicateSettingsDigest,
} from './message-duplicate-state';
import {
  duplicateSettings,
  preUnicodeNearSettingsDigests,
} from './message-duplicate-test-fixtures';

describe('Unicode near evidence compatibility', () => {
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

  it.each(['STANDARD', 'STRICT', 'CUSTOM'] as const)(
    'preserves IMAGE evidence with %s text settings',
    (preset) => {
      expect(
        exactImageSettingsDigest(
          duplicateSettings({
            duplicateDetectionPreset: preset,
            duplicateNearMatchEnabled: true,
          }),
        ),
      ).toBe('8b9112c31be1ae76f2304014f60b97d49c0d20063b37db7ac43fd3e7a72eaaa4');
    },
  );
});
