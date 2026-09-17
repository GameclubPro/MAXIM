import type { ChatSettings } from '../../prisma/prisma-client';
import {
  COMMERCIAL_INTENT_CASES,
  COMMERCIAL_INTENT_COUNTEREXAMPLES,
} from '../commercial-intent.fixture';
import { CommercialAdDetector } from './commercial-ad.detector';

describe('commercial service intent regression', () => {
  it.each([...COMMERCIAL_INTENT_CASES, ...COMMERCIAL_INTENT_COUNTEREXAMPLES])(
    'keeps assertion ownership with and without redacted phones: $text',
    ({ text, expectedDelete }) => {
      for (const profile of [
        {
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 45,
          commercialAdsDeleteThreshold: 65,
        },
        {
          commercialAdsSensitivity: 'STRICT',
          commercialAdsWarnThreshold: 38,
          commercialAdsDeleteThreshold: 55,
        },
      ]) {
        const detector = new CommercialAdDetector();
        for (const candidate of [
          text,
          text.replaceAll('+7 900 000 10 42', '[phone]'),
          `Добрый день, ${text}`,
        ]) {
          const result = detector.detect({
            normalizedText: '',
            rawLoweredText: candidate.toLowerCase(),
            settings: profile as ChatSettings,
          });
          expect({ text: candidate, profile, delete: result?.actionable === true }).toEqual({
            text: candidate,
            profile,
            delete: expectedDelete,
          });
        }
      }
    },
  );
});
