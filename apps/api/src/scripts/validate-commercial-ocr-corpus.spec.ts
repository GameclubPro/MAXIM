import { readCommercialOcrCorpusValidationOptions } from './validate-commercial-ocr-corpus';

describe('commercial OCR corpus validation CLI', () => {
  it('requires exactly one explicit manifest path', () => {
    expect(
      readCommercialOcrCorpusValidationOptions(['--manifest', './private/manifest.json']),
    ).toEqual({ manifestPath: expect.stringMatching(/private\/manifest\.json$/u) });
    expect(() => readCommercialOcrCorpusValidationOptions([])).toThrow(/Usage/u);
    expect(() =>
      readCommercialOcrCorpusValidationOptions(['--manifest', '--enforce-ru-gates']),
    ).toThrow(/Usage/u);
    expect(() =>
      readCommercialOcrCorpusValidationOptions(['--manifest', 'a', '--manifest', 'b']),
    ).toThrow(/Usage/u);
  });
});
