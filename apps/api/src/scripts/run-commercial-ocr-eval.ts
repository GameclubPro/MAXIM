import { resolve } from 'node:path';
import { evaluateCommercialOcrEvalGates } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-gates';
import { runCommercialOcrEval } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-runner';
import type { CommercialOcrEvalReport } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-runner';

export type CommercialOcrEvalCliOptions = {
  manifestPath: string;
  enforceGates: boolean;
  concurrency: number;
};

const USAGE =
  'Usage: --manifest <path> [--enforce-cyrillic-gates|--enforce-ru-gates] [--concurrency <1..4>]';

export function readCommercialOcrEvalOptions(argv: readonly string[]): CommercialOcrEvalCliOptions {
  let manifestPath: string | null = null;
  let enforceGates = false;
  let concurrency = 1;
  let concurrencyProvided = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest') {
      const value = argv[index + 1];
      if (manifestPath || !value || value.startsWith('--')) {
        throw new Error(USAGE);
      }
      manifestPath = resolve(value);
      index += 1;
      continue;
    }
    if (
      (argument === '--enforce-cyrillic-gates' || argument === '--enforce-ru-gates') &&
      !enforceGates
    ) {
      enforceGates = true;
      continue;
    }
    if (argument === '--concurrency') {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (
        concurrencyProvided ||
        !value ||
        value.startsWith('--') ||
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > 4
      ) {
        throw new Error(USAGE);
      }
      concurrency = parsed;
      concurrencyProvided = true;
      index += 1;
      continue;
    }
    throw new Error(USAGE);
  }
  if (!manifestPath) {
    throw new Error(USAGE);
  }
  return { manifestPath, enforceGates, concurrency };
}

export function commercialOcrEvalExitCode(params: {
  report: CommercialOcrEvalReport;
  gates: ReturnType<typeof evaluateCommercialOcrEvalGates> | null;
  enforceGates: boolean;
}): 0 | 2 {
  if (params.enforceGates) {
    return params.gates?.passed === true ? 0 : 2;
  }
  return params.report.failed > 0 ? 2 : 0;
}

async function main(): Promise<void> {
  const options = readCommercialOcrEvalOptions(process.argv.slice(2));
  const report = await runCommercialOcrEval({
    manifestPath: options.manifestPath,
    concurrency: options.concurrency,
  });
  const gates = options.enforceGates ? evaluateCommercialOcrEvalGates(report) : null;
  process.stdout.write(`${JSON.stringify({ report, gates })}\n`);
  process.exitCode = commercialOcrEvalExitCode({
    report,
    gates,
    enforceGates: options.enforceGates,
  });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
