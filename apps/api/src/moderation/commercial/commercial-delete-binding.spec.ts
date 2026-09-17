import {
  bindCommercialTextDeleteIntent,
  buildCommercialTextDeleteBinding,
  COMMERCIAL_TEXT_DELETE_MAX_AGE_MS,
  commercialTextDeleteReasonKey,
  fingerprintCommercialDeleteText,
  isCommercialTextDeleteBindingCurrent,
} from './commercial-delete-binding';

const settings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'Europe/Moscow',
  textFiltersWarnEnabled: true,
  textFiltersMuteEnabled: true,
  textFiltersBanEnabled: true,
  textFiltersMuteDurationHours: 1,
  textFiltersBotMessageEnabled: true,
};

describe('commercial text decision binding', () => {
  it('preserves assertion layout in the fingerprint without persisting plaintext', () => {
    const text = 'Такси\n+7 900 000 10 42';
    const binding = buildCommercialTextDeleteBinding({
      text,
      settings,
      eventTimestampMs: Date.now(),
      campaignContext: null,
    });
    expect(binding.sourceSha256).not.toBe(
      fingerprintCommercialDeleteText(text.replaceAll('\n', ' ')),
    );
    expect(JSON.stringify(binding)).not.toContain('Такси');
    expect(JSON.stringify(binding)).not.toContain('900 000');
  });

  it('keeps the same revision and absolute deadline across duplicate processing', () => {
    const eventTimestampMs = Date.now() - 30_000;
    const context = { text: 'Такси', settings, campaignContext: null };
    const source = {
      chatId: 'chat',
      messageId: 'message',
      reasonKey: 'old',
      ruleCode: 'COMMERCIAL_AD_DELETE',
      sourceMessageAt: new Date(eventTimestampMs),
      event: { score: 0.8, metadata: { actionBand: 'WARN' } },
    };
    const first = bindCommercialTextDeleteIntent(source, context);
    const repeated = bindCommercialTextDeleteIntent(
      { ...source, sourceMessageAt: new Date(eventTimestampMs).toISOString() },
      context,
    );
    expect(first.reasonKey).toBe(repeated.reasonKey);
    expect(first.event).toEqual(repeated.event);
    expect(first.retryUntilAt).toEqual(repeated.retryUntilAt);
    expect(first.retryUntilAt).toEqual(
      new Date(eventTimestampMs + COMMERCIAL_TEXT_DELETE_MAX_AGE_MS),
    );
    expect(source.reasonKey).toBe('old');
    expect(source.event.metadata).toEqual({ actionBand: 'WARN' });
    expect(first.event?.metadata).toMatchObject({ actionBand: 'WARN' });
  });

  it('does not rebind another policy family', () => {
    const source = {
      chatId: 'chat',
      messageId: 'message',
      reasonKey: 'other',
      ruleCode: 'PROFANITY_DELETE',
    };
    expect(
      bindCommercialTextDeleteIntent(source, { text: '', settings, campaignContext: null }),
    ).toBe(source);
  });

  it('separates edits while preserving a hard expiry boundary', () => {
    const eventTimestampMs = Date.now();
    const binding = buildCommercialTextDeleteBinding({
      text: 'Такси',
      settings,
      eventTimestampMs,
      campaignContext: null,
    });
    const edited = buildCommercialTextDeleteBinding({
      text: 'Такси',
      settings,
      eventTimestampMs: eventTimestampMs + 1,
      campaignContext: null,
    });
    expect(commercialTextDeleteReasonKey(binding)).not.toBe(commercialTextDeleteReasonKey(edited));
    expect(isCommercialTextDeleteBindingCurrent(binding, settings, binding.deadlineAtMs - 1)).toBe(
      true,
    );
    expect(isCommercialTextDeleteBindingCurrent(binding, settings, binding.deadlineAtMs)).toBe(
      false,
    );
  });
});
