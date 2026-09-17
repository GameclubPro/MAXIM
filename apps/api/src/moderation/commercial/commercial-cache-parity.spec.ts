import type { ChatSettings } from '../../prisma/prisma-client';
import { COMMERCIAL_POSITIVE_CASES } from '../commercial-positive.fixture';
import { COMMERCIAL_NEGATIVE_CASES } from '../commercial-negative.fixture';
import { CommercialAdDetector } from './commercial-ad.detector';
import { normalizeCommercialText } from './commercial-normalization';

describe('commercial detector cache parity', () => {
  it.each(['BALANCED', 'STRICT'] as const)(
    'preserves complete decisions across cold and reordered warm calls: %s',
    (sensitivity) => {
      const settings = {
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: sensitivity,
        commercialAdsWarnThreshold: sensitivity === 'BALANCED' ? 45 : 38,
        commercialAdsDeleteThreshold: sensitivity === 'BALANCED' ? 65 : 55,
      } as ChatSettings;
      const inputs = [...COMMERCIAL_POSITIVE_CASES, ...COMMERCIAL_NEGATIVE_CASES].flatMap((item) =>
        [
          ...new Set([
            item.text,
            item.text.replace(/\s+/gu, ' '),
            item.text.replace(/\s+/gu, '\n'),
          ]),
        ].map((text) => ({
          normalizedText: normalizeCommercialText(text),
          rawLoweredText: text.toLowerCase(),
          settings,
          commercialCampaignContext: item.campaignContext,
        })),
      );
      const cold = inputs.map((input) => new CommercialAdDetector().detect(input));
      for (const indexes of [
        inputs.map((_, index) => index),
        inputs.map((_, index) => index).reverse(),
      ]) {
        const detector = new CommercialAdDetector();
        for (const index of indexes) {
          expect({ index, detection: detector.detect(inputs[index]!) }).toEqual({
            index,
            detection: cold[index],
          });
        }
      }
    },
  );
});
