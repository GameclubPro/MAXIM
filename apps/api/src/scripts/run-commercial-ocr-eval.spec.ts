import type { CommercialOcrEvalReport } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-runner';
import {
  commercialOcrEvalExitCode,
  createCommercialOcrEvalCliOutput,
  readCommercialOcrEvalOptions,
} from './run-commercial-ocr-eval';

describe('commercial OCR eval CLI', () => {
  it('accepts both enforcement aliases and bounded concurrency', () => {
    expect(
      readCommercialOcrEvalOptions([
        '--enforce-ru-gates',
        '--manifest',
        './private/manifest.json',
        '--immutable-image-sha256',
        'AB'.repeat(32),
        '--source-sha',
        'CD'.repeat(20),
        '--benchmark-environment-sha256',
        'EF'.repeat(32),
        '--approval-key-id-sha256',
        '12'.repeat(32),
      ]),
    ).toEqual({
      manifestPath: expect.stringMatching(/private\/manifest\.json$/u),
      enforceGates: true,
      concurrency: 1,
      immutableImageSha256: 'ab'.repeat(32),
      sourceSha: 'cd'.repeat(20),
      benchmarkEnvironmentSha256: 'ef'.repeat(32),
      approvalKeyIdSha256: '12'.repeat(32),
    });
    expect(
      readCommercialOcrEvalOptions([
        '--manifest',
        './private/manifest.json',
        '--concurrency',
        '1',
        '--immutable-image-sha256',
        'AB'.repeat(32),
        '--source-sha',
        'CD'.repeat(20),
        '--benchmark-environment-sha256',
        'EF'.repeat(32),
        '--approval-key-id-sha256',
        '12'.repeat(32),
        '--enforce-cyrillic-gates',
      ]),
    ).toEqual({
      manifestPath: expect.stringMatching(/private\/manifest\.json$/u),
      enforceGates: true,
      concurrency: 1,
      immutableImageSha256: 'ab'.repeat(32),
      sourceSha: 'cd'.repeat(20),
      benchmarkEnvironmentSha256: 'ef'.repeat(32),
      approvalKeyIdSha256: '12'.repeat(32),
    });
  });

  it('requires immutable source and image bindings before enforcement evaluation starts', () => {
    expect(() =>
      readCommercialOcrEvalOptions([
        '--manifest',
        './private/manifest.json',
        '--enforce-cyrillic-gates',
      ]),
    ).toThrow(/benchmark-environment-sha256/u);
    expect(() =>
      readCommercialOcrEvalOptions([
        '--manifest',
        './private/manifest.json',
        '--enforce-cyrillic-gates',
        '--immutable-image-sha256',
        'AB'.repeat(32),
        '--source-sha',
        'CD'.repeat(20),
        '--benchmark-environment-sha256',
        'EF'.repeat(32),
      ]),
    ).toThrow(/approval-key-id-sha256/u);
    expect(() =>
      readCommercialOcrEvalOptions([
        '--manifest',
        './private/manifest.json',
        '--enforce-cyrillic-gates',
        '--source-sha',
        'CD'.repeat(20),
      ]),
    ).toThrow(/benchmark-environment-sha256/u);
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
    expect(() =>
      readCommercialOcrEvalOptions([
        '--manifest',
        'a',
        '--enforce-cyrillic-gates',
        '--concurrency',
        '4',
        '--immutable-image-sha256',
        'a'.repeat(64),
        '--source-sha',
        'b'.repeat(40),
        '--benchmark-environment-sha256',
        'c'.repeat(64),
        '--approval-key-id-sha256',
        'd'.repeat(64),
      ]),
    ).toThrow(/concurrency 1/u);
    expect(() =>
      readCommercialOcrEvalOptions([
        '--manifest',
        'a',
        '--immutable-image-sha256',
        'a'.repeat(64),
        '--immutable-image-sha256',
        'b'.repeat(64),
      ]),
    ).toThrow(/Usage/u);
    expect(() =>
      readCommercialOcrEvalOptions([
        '--manifest',
        'a',
        '--source-sha',
        'a'.repeat(40),
        '--source-sha',
        'b'.repeat(40),
      ]),
    ).toThrow(/Usage/u);
    expect(() =>
      readCommercialOcrEvalOptions(['--manifest', 'a', '--immutable-image-sha256', 'a'.repeat(63)]),
    ).toThrow(/Usage/u);
    expect(() =>
      readCommercialOcrEvalOptions(['--manifest', 'a', '--source-sha', 'a'.repeat(64)]),
    ).toThrow(/Usage/u);
    expect(() =>
      readCommercialOcrEvalOptions(['--manifest', 'a', '--source-sha', 'g'.repeat(40)]),
    ).toThrow(/Usage/u);
    expect(() =>
      readCommercialOcrEvalOptions([
        '--manifest',
        'a',
        '--benchmark-environment-sha256',
        'a'.repeat(63),
      ]),
    ).toThrow(/Usage/u);
    expect(() =>
      readCommercialOcrEvalOptions([
        '--manifest',
        'a',
        '--approval-private-key-file',
        './approval.pem',
      ]),
    ).toThrow(/Usage/u);
  });

  it('uses statistical gates as the enforcement exit authority', () => {
    const report = { failed: 3 } as CommercialOcrEvalReport;

    expect(
      commercialOcrEvalExitCode({
        report,
        gates: { passed: true },
        enforceGates: true,
      }),
    ).toBe(0);
    expect(
      commercialOcrEvalExitCode({
        report: { failed: 0 } as CommercialOcrEvalReport,
        gates: { passed: true },
        enforceGates: true,
      }),
    ).toBe(0);
    expect(
      commercialOcrEvalExitCode({
        report,
        gates: { passed: false },
        enforceGates: true,
      }),
    ).toBe(2);
    expect(commercialOcrEvalExitCode({ report, gates: null, enforceGates: false })).toBe(2);
  });

  it('marks diagnostic output as non-certifying', () => {
    const report = { failed: 0 } as CommercialOcrEvalReport;
    expect(createCommercialOcrEvalCliOutput({ report, gates: null })).toEqual({
      report,
      gates: null,
      certificationRequest: null,
    });
    expect(
      createCommercialOcrEvalCliOutput({
        report,
        gates: { passed: false } as never,
      }),
    ).toEqual({ report, gates: { passed: false }, certificationRequest: null });
  });
});
