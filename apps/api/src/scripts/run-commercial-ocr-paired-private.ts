import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { evaluateCommercialOcrPairedPrivatePhotos } from '../moderation/commercial-ocr/eval/commercial-ocr-paired-private';
import { readCommercialOcrEvalOptions } from './run-commercial-ocr-eval';

export function readCommercialOcrPairedPrivateOptions(argv: readonly string[]) {
  const args = [...argv];
  const outputIndex = args.indexOf('--output');
  const output = args[outputIndex + 1];
  if (
    outputIndex < 0 ||
    !output ||
    !isAbsolute(output) ||
    output.startsWith('--') ||
    args.indexOf('--output', outputIndex + 1) !== -1 ||
    args.some((arg) =>
      [
        '--enforce-cyrillic-gates',
        '--enforce-ru-gates',
        '--approval-key-id-sha256',
        '--concurrency',
      ].includes(arg),
    )
  ) {
    throw new Error(
      'Use --manifest /private/manifest.json --output /private/paired-report.json with optional immutable-image, source and benchmark bindings',
    );
  }
  args.splice(outputIndex, 2);
  const options = readCommercialOcrEvalOptions(args);
  return { ...options, outputPath: resolve(output) };
}

export async function runCommercialOcrPairedPrivateCommand(
  argv: readonly string[],
  evaluate = evaluateCommercialOcrPairedPrivatePhotos,
) {
  const options = readCommercialOcrPairedPrivateOptions(argv);
  const report = await evaluate({
    manifestPath: options.manifestPath,
    ...(options.immutableImageSha256 ? { immutableImageSha256: options.immutableImageSha256 } : {}),
    ...(options.sourceSha ? { sourceSha: options.sourceSha } : {}),
    ...(options.benchmarkEnvironmentSha256
      ? { expectedBenchmarkEnvironmentSha256: options.benchmarkEnvironmentSha256 }
      : {}),
  });
  // FLAG: Report contains aggregates only. Never overwrite or echo corpus/error/path material.
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return report;
}

if (require.main === module) {
  runCommercialOcrPairedPrivateCommand(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(
        `Private photo paired evaluation: ${report.status}; independent improvement proven: false; promotion authorized: false\n`,
      );
      process.exitCode =
        report.evaluated && report.pairedReductionSupportedWithinProvidedCorpus ? 0 : 2;
    })
    .catch(() => {
      process.stderr.write(
        'Private photo paired evaluation unavailable; verify arguments, originals and two independent reviews.\n',
      );
      process.exitCode = 1;
    });
}
