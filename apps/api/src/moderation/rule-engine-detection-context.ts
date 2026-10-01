import type { ChatSettings } from '../prisma/prisma-client';
import { normalizeForDetection } from './rule-engine-normalization';
import { normalizeCommercialRawText } from './commercial/commercial-normalization';

export type RuleDetectionContext = {
  text: string;
  normalizedText: string;
  rawLoweredText: string;
  measuredLength: number;
  compactText: string;
};

export function createRuleDetectionContext(params: {
  text: string;
  settings: ChatSettings;
  effectiveLength?: number;
}): RuleDetectionContext {
  const { text, settings, effectiveLength } = params;
  const needsNormalized = settings.commercialAdsFilterEnabled || settings.antiDuplicateEnabled;
  const normalizedText = needsNormalized ? normalizeForDetection(text) : '';

  return {
    text,
    normalizedText,
    // FLAG: Visual uppercase B means Cyrillic в; preserve its case until commercial mapping.
    rawLoweredText: settings.commercialAdsFilterEnabled ? normalizeCommercialRawText(text) : '',
    measuredLength: typeof effectiveLength === 'number' ? effectiveLength : text.length,
    compactText: settings.antiDuplicateEnabled ? normalizedText.replace(/\s+/g, ' ').trim() : '',
  };
}
