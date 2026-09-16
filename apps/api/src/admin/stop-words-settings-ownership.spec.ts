import {
  assertLegacyStopWordsWrite,
  omitLegacyStopWordsSettings,
  omitStopWordsPolicy,
} from './stop-words-settings-ownership';
import { chatSettingsSchema, stopWordsPolicySchema } from '@maxim/contracts/settings';

describe('stop-word settings ownership', () => {
  it.each([null, stopWordsPolicySchema.parse({})])(
    'rejects legacy writes before and after activation',
    (stopWordsPolicy) => {
      expect(() =>
        assertLegacyStopWordsWrite({ stopWordsPolicy }, { messageLimitsBlockedWords: ['casino'] }),
      ).toThrow();
      expect(() =>
        assertLegacyStopWordsWrite(
          { stopWordsPolicy },
          { messageLimitsImageTextScanEnabled: true },
        ),
      ).toThrow();
    },
  );
  it('accepts unchanged compatibility fields without writing them back', () => {
    const settings = chatSettingsSchema.parse({ messageLimitsBlockedWords: ['casino'] });
    expect(() => assertLegacyStopWordsWrite(settings, settings)).not.toThrow();
    const payload = omitLegacyStopWordsSettings(omitStopWordsPolicy(settings));
    expect(payload).not.toHaveProperty('messageLimitsBlockedWords');
    expect(payload).not.toHaveProperty('messageLimitsBlockedDomains');
    expect(payload).not.toHaveProperty('messageLimitsImageTextScanEnabled');
    expect(payload).not.toHaveProperty('stopWordsPolicy');
    expect(payload).toHaveProperty('messageLimitsWarnEnabled');
  });
});
