import type { ChatSettings } from '@prisma/client';
import { normalizeForDetection } from './rule-engine-normalization';

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
  const needsNormalized =
    settings.commercialAdsFilterEnabled ||
    settings.thematicCodewordEnabled ||
    settings.antiDuplicateEnabled;
  const normalizedText = needsNormalized ? normalizeForDetection(text) : '';

  return {
    text,
    normalizedText,
    rawLoweredText: settings.commercialAdsFilterEnabled ? text.toLowerCase() : '',
    measuredLength: typeof effectiveLength === 'number' ? effectiveLength : text.length,
    compactText: settings.antiDuplicateEnabled
      ? normalizedText.replace(/\s+/g, ' ').trim()
      : '',
  };
}
