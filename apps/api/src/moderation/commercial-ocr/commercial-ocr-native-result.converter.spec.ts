import {
  commercialOcrCacheValueToDecisionPass,
  convertCommercialOcrNativePayload,
  type CommercialOcrNativePayload,
} from './commercial-ocr-native-result.converter';

const COMMERCIAL_TEXT = 'Ремонт окон. Цена 1200 рублей. Звоните по телефону +7 999 123 45 67.';

describe('commercial OCR native result converter', () => {
  it('converts and freezes a valid recognized payload', () => {
    const converted = convertCommercialOcrNativePayload(recognizedPayload());

    expect(converted.kind).toBe('ready');
    if (converted.kind !== 'ready') throw new Error('expected a ready conversion');
    expect(converted.value).toMatchObject({
      schemaVersion: 2,
      status: 'recognized',
      text: COMMERCIAL_TEXT,
      confidencePermille: 946,
    });
    expect(converted.value.words).toHaveLength(wordsFor(COMMERCIAL_TEXT).length);
    expect(Object.isFrozen(converted.value)).toBe(true);
    expect(Object.isFrozen(converted.value.words)).toBe(true);
    expect(converted.pass).toEqual(commercialOcrCacheValueToDecisionPass(converted.value));
  });

  it('converts a valid no-text payload', () => {
    expect(
      convertCommercialOcrNativePayload({
        status: 'no_text',
        text: '',
        aggregateConfidence: null,
        words: [],
        truncated: false,
      }),
    ).toEqual({
      kind: 'ready',
      value: {
        schemaVersion: 2,
        status: 'no_text',
        text: '',
        confidencePermille: 0,
        words: [],
      },
      pass: {
        status: 'no_text',
        text: '',
        confidencePermille: 0,
        criticalEvidence: [],
      },
    });
  });

  it('rejects more than 1024 words', () => {
    const text = Array.from({ length: 1_025 }, () => 'x').join(' ');
    expect(convertCommercialOcrNativePayload(recognizedPayload(text))).toEqual({
      kind: 'rejected',
      reason: 'invalid',
    });
  });

  it('rejects a word longer than 256 UTF-16 code units', () => {
    expect(convertCommercialOcrNativePayload(recognizedPayload('x'.repeat(257)))).toEqual({
      kind: 'rejected',
      reason: 'invalid',
    });
  });

  it('rejects recognized text longer than 8000 UTF-16 code units', () => {
    const text = Array.from({ length: 32 }, () => 'x'.repeat(250)).join(' ');
    expect(text.length).toBeGreaterThan(8_000);
    expect(convertCommercialOcrNativePayload(recognizedPayload(text))).toEqual({
      kind: 'rejected',
      reason: 'invalid',
    });
  });

  it.each([
    {
      name: 'overlapping offsets',
      text: 'abcdef',
      words: [nativeWord('abcd', 0, 4), nativeWord('cdef', 2, 6)],
    },
    {
      name: 'out-of-range offsets',
      text: 'abc',
      words: [nativeWord('abc', 0, 4)],
    },
    {
      name: 'nonmatching offsets',
      text: 'abc',
      words: [nativeWord('z', 0, 1)],
    },
  ])('rejects $name', ({ text, words }) => {
    expect(
      convertCommercialOcrNativePayload({
        text,
        aggregateConfidence: 90,
        words,
        truncated: false,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid' });
  });

  it('rejects recognized output without aggregate confidence', () => {
    expect(
      convertCommercialOcrNativePayload({
        ...recognizedPayload(),
        aggregateConfidence: undefined,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid' });
  });

  it('distinguishes a truncated payload from other invalid output', () => {
    expect(
      convertCommercialOcrNativePayload({
        ...recognizedPayload(),
        truncated: true,
      }),
    ).toEqual({ kind: 'rejected', reason: 'truncated' });
  });

  it('produces identical permille and critical evidence for runtime and eval payload shapes', () => {
    const evalPayload = recognizedPayload();
    const runtimePayload = {
      ok: true as const,
      status: 'recognized' as const,
      passLabel: 'primary',
      psm: 11 as const,
      lines: [],
      durationMs: 12,
      ...evalPayload,
    };

    const fromRuntime = convertCommercialOcrNativePayload(runtimePayload);
    const fromEval = convertCommercialOcrNativePayload(evalPayload);

    expect(fromRuntime).toEqual(fromEval);
    expect(fromRuntime.kind).toBe('ready');
    if (fromRuntime.kind !== 'ready' || fromEval.kind !== 'ready') {
      throw new Error('expected matching ready conversions');
    }
    expect(fromRuntime.pass.confidencePermille).toBe(946);
    expect(fromRuntime.pass.criticalEvidence).toEqual(fromEval.pass.criticalEvidence);
    expect(fromRuntime.pass.criticalEvidence).not.toEqual([]);
  });
});

function recognizedPayload(text = COMMERCIAL_TEXT): CommercialOcrNativePayload {
  return {
    text,
    aggregateConfidence: 94.57,
    words: wordsFor(text),
    truncated: false,
  };
}

function wordsFor(text: string) {
  return Array.from(text.matchAll(/\S+/gu), (match) =>
    nativeWord(match[0], match.index, match.index + match[0].length),
  );
}

function nativeWord(text: string, start: number, end: number) {
  return { text, start, end, confidence: 91.23 };
}
