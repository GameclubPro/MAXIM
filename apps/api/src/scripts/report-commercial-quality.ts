import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  commercialReviewExportResponseSchema,
  commercialReviewSamplingFrameResponseSchema,
} from '@maxim/contracts/safety-desk';
import { analyzeCommercialQualityEvidence } from './commercial-quality-report';

const pageSchema = z
  .object({ cursor: z.string().nullable(), response: commercialReviewExportResponseSchema })
  .strict();
const bundleSchema = z
  .object({
    schemaVersion: z.literal('commercial-quality-paired/v1'),
    detectorSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    frozenAt: z.string().datetime(),
    evaluatedAt: z.string().datetime(),
    development: z.array(pageSchema).min(1).max(200),
    holdout: z.array(pageSchema).min(1).max(200),
    holdoutFrame: z
      .array(
        z
          .object({
            cursor: z.string().nullable(),
            response: commercialReviewSamplingFrameResponseSchema,
          })
          .strict(),
      )
      .min(1)
      .max(200)
      .optional(),
  })
  .strict();

export async function reportCommercialQuality(argv: string[]) {
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--output')
    throw new Error('Usage: --input /private/evidence.json --output /private/report.json');
  const inputPath = resolve(argv[1]!);
  const outputPath = resolve(argv[3]!);
  const info = await stat(inputPath);
  if (!info.isFile() || info.size > 64 * 1024 * 1024)
    throw new Error('Evidence must be a file of at most 64 MiB');
  const parsed = bundleSchema.safeParse(JSON.parse(await readFile(inputPath, 'utf8')));
  // FLAG: Validation errors must not echo private evidence, paths, reviewer IDs or excerpts.
  if (!parsed.success) throw new Error('Evidence schema is invalid');
  const report = analyzeCommercialQualityEvidence(parsed.data);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(
    `Text improvement proven: ${report.textIndependentImprovementProven}; OCR evaluated: false; promotion authorized: false\n`,
  );
  return report;
}

if (require.main === module) {
  reportCommercialQuality(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      'Commercial quality report failed; verify arguments and private evidence schema.\n',
    );
    process.exitCode = 1;
  });
}
