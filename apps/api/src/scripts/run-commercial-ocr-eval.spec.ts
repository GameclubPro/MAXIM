import type { CommercialOcrEvalReport } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-runner';
import { commercialOcrEvalExitCode, readCommercialOcrEvalOptions } from './run-commercial-ocr-eval';

describe('commercial OCR eval CLI', () => {
  it('accepts both enforcement aliases and bounded concurrency', () => {
    expect(
      readCommercialOcrEvalOptions(['--enforce-ru-gates', '--manifest', './private/manifest.json']),
    ).toEqual({
      manifestPath: expect.stringMatching(/private\/manifest\.json$/u),
      enforceGates: true,
      concurrency: 1,
    });
    expect(
      readCommercialOcrEvalOptions([
        '--manifest',
        './private/manifest.json',
        '--concurrency',
        '4',
        '--enforce-cyrillic-gates',
      ]),
    ).toEqual({
      manifestPath: expect.stringMatching(/private\/manifest\.json$/u),
      enforceGates: true,
      concurrency: 4,
    });
  });

  it('rejects duplicate, unknown, and out-of-range arguments', () => {
    expect(() => readCommercialOcrEvalOptions(['--manifest', 'a', '--manifest', 'b'])).toThrow(
      /Usage/u,
    );
    expect(() => readCommercialOcrEvalOptions(['--manifest', 'a', '--unknown'])).toThrow(/Usage/u);
    expect(() => readCommercialOcrEvalOptions(['--manifest', 'a', '--concurrency', '0'])).toThrow(
      /Usage/u,
    );
    expect(() => readCommercialOcrEvalOptions(['--manifest', 'a', '--concurrency', '5'])).toThrow(
      /Usage/u,
    );
    expect(() =>
      readCommercialOcrEvalOptions(['--manifest', 'a', '--concurrency', '1', '--concurrency', '2']),
    ).toThrow(/Usage/u);
  });

  it('uses only the Cyrillic gate result for enforcement exit status', () => {
    const report = { failed: 3 } as CommercialOcrEvalReport;

    expect(
      commercialOcrEvalExitCode({
        report,
        gates: { passed: true, failures: [] },
        enforceGates: true,
      }),
    ).toBe(0);
    expect(
      commercialOcrEvalExitCode({
        report,
        gates: { passed: false, failures: ['Cyrillic recall'] },
        enforceGates: true,
      }),
    ).toBe(2);
    expect(commercialOcrEvalExitCode({ report, gates: null, enforceGates: false })).toBe(2);
  });
});
