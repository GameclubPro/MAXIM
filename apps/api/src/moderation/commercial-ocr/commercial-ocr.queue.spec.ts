import {
  buildCommercialOcrJobId,
  COMMERCIAL_OCR_JOB_OPTIONS,
  normalizeCommercialOcrActionEligibility,
  normalizeImageTextScanRequested,
  resolveCommercialOcrJobPurposes,
  validateCommercialOcrImageCount,
} from './commercial-ocr.queue';

describe('commercial OCR queue contract', () => {
  const identity = {
    chatId: 'chat-secret',
    messageId: 'message-secret',
    sourceCreatedAt: '2026-08-12T08:00:00.000Z',
    ocrVersion: 'tesseract-rus-eng-v1',
  };

  it('builds a deterministic opaque job id without action eligibility', () => {
    const first = buildCommercialOcrJobId(identity);
    const replay = buildCommercialOcrJobId(identity);

    expect(first).toBe(replay);
    expect(first).toMatch(/^commercial-image-ocr__[a-f0-9]{64}$/u);
    expect(first).not.toContain(identity.chatId);
    expect(first).not.toContain(identity.messageId);
  });

  it('changes identity when the OCR behavior version changes', () => {
    expect(buildCommercialOcrJobId(identity)).not.toBe(
      buildCommercialOcrJobId({ ...identity, ocrVersion: 'tesseract-rus-eng-v2' }),
    );
  });

  it('uses distinct v2 identities for distinct analysis purposes', () => {
    expect(
      buildCommercialOcrJobId({
        ...identity,
        commercialScanRequested: true,
        imageTextScanRequested: false,
      }),
    ).not.toBe(
      buildCommercialOcrJobId({
        ...identity,
        commercialScanRequested: false,
        imageTextScanRequested: true,
      }),
    );
  });

  it.each([undefined, null, 1, 'true', false])(
    'normalizes malformed action eligibility %p to false',
    (value) => {
      expect(normalizeCommercialOcrActionEligibility(value)).toBe(false);
    },
  );

  it('accepts only explicit true action eligibility', () => {
    expect(normalizeCommercialOcrActionEligibility(true)).toBe(true);
    expect(normalizeImageTextScanRequested(true)).toBe(true);
    expect(normalizeImageTextScanRequested('true')).toBe(false);
  });

  it('treats legacy jobs as commercial-only and reads explicit v2 purposes', () => {
    expect(
      resolveCommercialOcrJobPurposes({
        schemaVersion: 1,
      }),
    ).toEqual({ commercial: true, imageTextStopList: false });
    expect(
      resolveCommercialOcrJobPurposes({
        schemaVersion: 2,
        commercialScanRequested: false,
        imageTextScanRequested: true,
      }),
    ).toEqual({ commercial: false, imageTextStopList: true });
  });

  it.each([0, 11, 1.5, Number.NaN])('rejects invalid image count %p', (imageCount) => {
    expect(() => validateCommercialOcrImageCount(imageCount)).toThrow('imageCount is invalid');
  });

  it('removes successful jobs immediately and bounds failed retention', () => {
    expect(COMMERCIAL_OCR_JOB_OPTIONS).toMatchObject({
      attempts: 3,
      removeOnComplete: true,
      removeOnFail: 1_000,
    });
  });
});
