import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

describe('commercial OCR source identity', () => {
  it('binds the sign-only CLI and every local pure signing dependency', () => {
    const repositoryRoot = resolve(__dirname, '../../../..');
    const generatorUrl = pathToFileURL(
      resolve(repositoryRoot, 'scripts/generate-commercial-ocr-detector-source.mjs'),
    ).href;
    const sourceFiles = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { resolveCommercialOcrAuditToolSourceFiles } from ${JSON.stringify(
            generatorUrl,
          )}; process.stdout.write(JSON.stringify(resolveCommercialOcrAuditToolSourceFiles(${JSON.stringify(
            repositoryRoot,
          )})));`,
        ],
        { encoding: 'utf8' },
      ),
    ) as unknown;

    expect(sourceFiles).toEqual(
      expect.arrayContaining([
        'apps/api/src/scripts/sign-commercial-ocr-certification.ts',
        'apps/api/src/moderation/commercial-ocr/eval/commercial-ocr-eval-certification-pure.ts',
        'apps/api/src/moderation/commercial-ocr/eval/commercial-ocr-eval-canonical.ts',
        'apps/api/src/moderation/commercial-ocr/commercial-ocr-settings-profile.ts',
        'scripts/generate-commercial-ocr-detector-source.mjs',
      ]),
    );
  });
});
