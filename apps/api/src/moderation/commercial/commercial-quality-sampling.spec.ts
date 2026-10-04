import { buildCommercialQualitySample } from './commercial-quality-sampling';

const input = {
  secret: 'test-only-quality-key-1234567890',
  chatId: '-100',
  userId: '123',
  messageId: 'msg-1',
  text: 'Привет',
  messageCreatedAt: '2026-10-05T00:00:00.000Z',
  source: 'TEXT' as const,
  hasDetection: true,
};

describe('commercial quality sampling', () => {
  it('does not invent source provenance or pseudonyms without a real key and source clock', () => {
    expect(buildCommercialQualitySample({ ...input, secret: undefined })).toBeNull();
    expect(buildCommercialQualitySample({ ...input, messageCreatedAt: null })).toBeNull();
  });
  it('keeps logical sampling and author groups stable across edits, sources and mirrors', () => {
    const first = buildCommercialQualitySample(input)!;
    const edited = buildCommercialQualitySample({ ...input, text: 'Изменено', source: 'OCR' })!;
    expect(edited.logicalMessageKey).toBe(first.logicalMessageKey);
    expect(edited.authorGroupId).toBe(first.authorGroupId);
    expect(edited.sourceSnapshotSha256).not.toBe(first.sourceSnapshotSha256);
    const noHit = { ...input, hasDetection: false };
    expect(Boolean(buildCommercialQualitySample(noHit))).toBe(
      Boolean(buildCommercialQualitySample({ ...noHit, source: 'OCR', text: 'Другое' })),
    );
  });
  it('connects shared original contacts without exposing them or merging masked templates', () => {
    const first = buildCommercialQualitySample({ ...input, text: 'Звоните +7 900 000 10 42' })!;
    const second = buildCommercialQualitySample({
      ...input,
      userId: '456',
      text: 'Телефон 8 900 000 10 42',
    })!;
    const different = buildCommercialQualitySample({
      ...input,
      userId: '456',
      text: 'Телефон 8 900 000 10 43',
    })!;
    expect(second.campaignGroupId).toBe(first.campaignGroupId);
    expect(different.campaignGroupId).not.toBe(first.campaignGroupId);
    expect(JSON.stringify(first)).not.toContain('9000001042');
    const masked = buildCommercialQualitySample({ ...input, text: 'Такси [phone]' })!;
    const maskedOther = buildCommercialQualitySample({
      ...input,
      userId: '456',
      text: 'Такси [phone]',
    })!;
    expect(masked.campaignGroupId).not.toBe(maskedOther.campaignGroupId);
  });
  it('samples about ten percent of unrelated no-hit messages deterministically', () => {
    let selected = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const sample = buildCommercialQualitySample({
        ...input,
        hasDetection: false,
        messageId: `m-${index}`,
      });
      if (sample) {
        selected += 1;
        expect(sample.samplingStratum).toBe('NO_HIT');
        expect(sample.samplingProbability).toBeCloseTo(0.1, 8);
      }
    }
    expect(selected).toBeGreaterThan(850);
    expect(selected).toBeLessThan(1150);
  });
  it('retains every technical incomplete and review candidate independently of the random cohort', () => {
    expect(
      buildCommercialQualitySample({ ...input, hasDetection: false, technicalIncomplete: true })
        ?.samplingStratum,
    ).toBe('TECHNICAL');
    expect(
      buildCommercialQualitySample({ ...input, hasDetection: false, reviewRecommended: true })
        ?.samplingStratum,
    ).toBe('REVIEW');
  });
  it('retains campaign contacts beyond the hot-path two-contact cap and flags incomplete grouping', () => {
    const first = buildCommercialQualitySample({
      ...input,
      text: 'https://one.example/a https://two.example/b https://shared.example/c',
    })!;
    const second = buildCommercialQualitySample({
      ...input,
      userId: 'other',
      text: 'Заказ https://shared.example/c',
    })!;
    expect(first.campaignGroupIds).toContain(second.campaignGroupId);
    expect(first.campaignGroupingComplete).toBe(true);
    expect(
      buildCommercialQualitySample({ ...input, text: 'a'.repeat(32_001) })
        ?.campaignGroupingComplete,
    ).toBe(false);
    expect(
      buildCommercialQualitySample({
        ...input,
        text: Array.from({ length: 33 }, (_, index) => `https://site${index}.example/order`).join(
          ' ',
        ),
      })?.campaignGroupingComplete,
    ).toBe(false);
  });
  it('exposes stable evaluation membership for all captures and detects key rotation', () => {
    const first = buildCommercialQualitySample(input)!;
    const edited = buildCommercialQualitySample({ ...input, text: 'Другой текст' })!;
    const rotated = buildCommercialQualitySample({
      ...input,
      secret: 'rotated-test-key-1234567890',
    })!;
    expect(edited.randomEvaluationIncluded).toBe(first.randomEvaluationIncluded);
    expect(edited.evaluationSamplingProbability).toBe(first.evaluationSamplingProbability);
    expect(edited.pseudonymizationKeyId).toBe(first.pseudonymizationKeyId);
    expect(rotated.pseudonymizationKeyId).not.toBe(first.pseudonymizationKeyId);
  });
});
