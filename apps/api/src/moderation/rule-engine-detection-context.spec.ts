import { LinkPolicy, type ChatSettings } from '@prisma/client';
import { createRuleDetectionContext } from './rule-engine-detection-context';

function buildSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    antiDuplicateEnabled: false,
    commercialAdsFilterEnabled: false,
    thematicCodewordEnabled: false,
    linkPolicy: LinkPolicy.ALLOWLIST_ONLY,
    ...overrides,
  } as ChatSettings;
}

describe('createRuleDetectionContext', () => {
  it('keeps expensive normalized fields empty when no enabled rule needs them', () => {
    const context = createRuleDetectionContext({
      text: 'Тест !!!',
      settings: buildSettings(),
    });

    expect(context.normalizedText).toBe('');
    expect(context.rawLoweredText).toBe('');
    expect(context.compactText).toBe('');
    expect(context.measuredLength).toBe('Тест !!!'.length);
  });

  it('normalizes shared rule input once and honors effective message length', () => {
    const context = createRuleDetectionContext({
      text: 'ПРРривет   MAX',
      settings: buildSettings({
        antiDuplicateEnabled: true,
        commercialAdsFilterEnabled: true,
      }),
      effectiveLength: 42,
    });

    expect(context.normalizedText).toBe('прривет мах');
    expect(context.rawLoweredText).toBe('пррривет   max');
    expect(context.compactText).toBe('прривет мах');
    expect(context.measuredLength).toBe(42);
  });
});
