import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCommercialOcrPairedPrivateOptions,
  runCommercialOcrPairedPrivateCommand,
} from './run-commercial-ocr-paired-private';

describe('private paired OCR CLI', () => {
  it('accepts a fixed readonly invocation and rejects certification/action options and duplicate output', () => {
    expect(
      readCommercialOcrPairedPrivateOptions([
        '--manifest',
        '/private/manifest.json',
        '--output',
        '/private/report.json',
        '--source-sha',
        'a'.repeat(40),
      ]),
    ).toMatchObject({
      manifestPath: '/private/manifest.json',
      outputPath: '/private/report.json',
      sourceSha: 'a'.repeat(40),
    });
    for (const extra of [
      ['--apply'],
      ['--approval-key-id-sha256', 'a'.repeat(64)],
      ['--enforce-cyrillic-gates'],
      ['--concurrency', '2'],
      ['--output', '/private/second.json'],
    ])
      expect(() =>
        readCommercialOcrPairedPrivateOptions([
          '--manifest',
          '/private/manifest.json',
          '--output',
          '/private/report.json',
          ...extra,
        ]),
      ).toThrow();
    expect(() =>
      readCommercialOcrPairedPrivateOptions([
        '--manifest',
        '/private/manifest.json',
        '--output',
        'relative.json',
      ]),
    ).toThrow();
  });

  it('writes a private non-overwriting unavailable report without inventing original-image evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-paired-cli-'));
    try {
      const output = join(directory, 'report.json');
      const args = ['--manifest', join(directory, 'private-missing.json'), '--output', output];
      const result = await runCommercialOcrPairedPrivateCommand(args);
      expect(result).toMatchObject({
        status: 'UNAVAILABLE',
        evaluated: false,
        independentImprovementProven: false,
        promotionAuthorized: false,
        certificationRequest: null,
      });
      const bytes = await readFile(output, 'utf8');
      expect(JSON.parse(bytes)).toEqual(result);
      expect(bytes).not.toContain('private-missing');
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      await expect(runCommercialOcrPairedPrivateCommand(args)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await readFile(output, 'utf8')).toBe(bytes);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
